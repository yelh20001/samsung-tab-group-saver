const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'samsung-group-test-'));
const browser = spawn('C:\\Program Files\\Samsung\\Internet\\Application\\samsunginternet.exe', [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', `--load-extension=${__dirname}`, 'about:blank'
], { stdio: 'ignore' });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function main() {
  let version;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    }
    catch (error) { await delay(200); }
  }
  if (!version) throw new Error('隔离浏览器调试接口未启动');
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  };
  function send(method, params = {}, sessionId) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  let worker;
  for (let attempt = 0; attempt < 50; attempt++) {
    const targets = await send('Target.getTargets');
    worker = targets.targetInfos.find(target => target.type === 'service_worker' && target.url.endsWith('/background.js'));
    if (worker) break;
    await delay(200);
  }
  if (!worker) throw new Error('三星浏览器未加载扩展后台，可能不支持命令行加载未打包扩展');
  const { sessionId } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  const result = await evaluate(`(async () => {
    let stage = 'create host';
    try {
    const host = await chrome.windows.create({url: 'https://example.com/?original=1'});
    stage = 'create tabs';
    const first = await chrome.tabs.create({windowId: host.id, url: 'https://example.com/', active: false});
    const second = await chrome.tabs.create({windowId: host.id, url: 'https://example.org/', active: false});
    const groupId = await chrome.tabs.group({tabIds: [first.id, second.id], createProperties: {windowId: host.id}});
    await chrome.tabGroups.update(groupId, {title: 'Integration test', color: 'blue'});
    stage = 'create other window';
    const otherWindow = await chrome.windows.create({url: 'https://example.net/', focused: false});
    const otherGroup = await chrome.tabs.group({tabIds: [otherWindow.tabs[0].id], createProperties: {windowId: otherWindow.id}});
    await chrome.tabGroups.update(otherGroup, {title: 'Window test', color: 'green'});
    await new Promise(resolve => setTimeout(resolve, 1800));
    const before = await getState();
    const id = before.live[String(groupId)];
    const otherId = before.live[String(otherGroup)];
    const activeBookmark = before.snapshots[id]?.bookmarkId;
    stage = 'close other window';
    await chrome.windows.remove(otherWindow.id);
    stage = 'close group';
    await chrome.tabs.remove([first.id, second.id]);
    await new Promise(resolve => setTimeout(resolve, 1800));
    const after = await getState();
    const bookmark = after.snapshots[id]?.bookmarkId;
    stage = 'open bookmark';
    const [savedBookmark] = await chrome.bookmarks.get(bookmark);
    await chrome.tabs.update(host.tabs[0].id, {url: savedBookmark.url});
    await new Promise(resolve => setTimeout(resolve, 1800));
    const restored = await chrome.tabGroups.query({title: 'Integration test'});
    const restoredTabs = restored.length ? await chrome.tabs.query({groupId: restored[0].id}) : [];
    const restoredState = await getState();
    const remainingBookmarks = await chrome.bookmarks.search({url: savedBookmark.url});
    const originalTab = await chrome.tabs.get(host.tabs[0].id);
    stage = 'open bookmark in background';
    const [otherBookmark] = await chrome.bookmarks.get(after.snapshots[otherId].bookmarkId);
    await chrome.tabs.create({windowId: host.id, url: otherBookmark.url, active: false});
    await new Promise(resolve => setTimeout(resolve, 1800));
    const newGroups = await chrome.tabGroups.query({title: 'Window test'});
    const newTabs = newGroups.length ? await chrome.tabs.query({groupId: newGroups[0].id}) : [];
    const remainingRestoreTabs = await chrome.tabs.query({url: otherBookmark.url});
    return {saved: after.snapshots[id]?.tabs.length, windowSaved: after.snapshots[otherId]?.tabs.length, activeBookmark: !!activeBookmark, bookmark: !!bookmark, bookmarkTitle: savedBookmark.title, remainingBookmarks: remainingBookmarks.length, restoredBookmark: restoredState.snapshots[id]?.bookmarkId, restored: restoredTabs.length, color: restored[0]?.color, foregroundWindow: restored[0]?.windowId, hostWindow: host.id, originalUrl: originalTab.url, backgroundWindow: newGroups[0]?.windowId, backgroundTabs: newTabs.length, remainingRestoreTabs: remainingRestoreTabs.length};
    } catch (error) { throw new Error(stage + ': ' + error.message); }
  })()`);
  assert.equal(result.saved, 2);
  assert.equal(result.windowSaved, 1);
  assert.equal(result.activeBookmark, false);
  assert.equal(result.bookmark, true);
  assert.equal(result.bookmarkTitle, 'Integration test');
  assert.equal(result.remainingBookmarks, 0);
  assert.equal(result.restoredBookmark, null);
  assert.equal(result.restored, 2);
  assert.equal(result.color, 'blue');
  assert.notEqual(result.foregroundWindow, result.hostWindow);
  assert.equal(result.originalUrl, 'https://example.com/?original=1');
  assert.equal(result.backgroundTabs, 1);
  assert.notEqual(result.backgroundWindow, result.hostWindow);
  assert.equal(result.remainingRestoreTabs, 0);
  const errorWindowId = await evaluate(`(async () => (await chrome.windows.create({url: chrome.runtime.getURL('restore.html')})).id)()`);
  let restorePage;
  for (let attempt = 0; attempt < 50; attempt++) {
    const targets = await send('Target.getTargets');
    restorePage = targets.targetInfos.find(target => target.type === 'page' && target.url.endsWith('/restore.html'));
    if (restorePage) break;
    await delay(200);
  }
  if (!restorePage) throw new Error('未找到恢复页面');
  const pageSession = await send('Target.attachToTarget', { targetId: restorePage.targetId, flatten: true });
  const pageResult = await send('Runtime.evaluate', {
    expression: `(async () => {
      if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once: true}));
      return {background: getComputedStyle(document.documentElement).backgroundColor, color: getComputedStyle(document.documentElement).color, status: document.querySelector('#status').textContent};
    })()`,
    awaitPromise: true,
    returnByValue: true
  }, pageSession.sessionId);
  assert.equal(pageResult.result.value.background, 'rgb(32, 33, 36)');
  assert.equal(pageResult.result.value.color, 'rgb(232, 234, 237)');
  assert.match(pageResult.result.value.status, /^恢复失败：/);
  await evaluate(`chrome.windows.remove(${errorWindowId})`);
  const popupSetup = await evaluate(`(async () => {
    const [group] = await chrome.tabGroups.query({title: 'Window test'});
    const groupTabs = await chrome.tabs.query({groupId: group.id});
    await chrome.tabs.remove(groupTabs.map(tab => tab.id));
    await new Promise(resolve => setTimeout(resolve, 1800));
    const hostTabs = await chrome.tabs.query({windowId: ${result.hostWindow}});
    const originalTab = hostTabs[0];
    await chrome.tabs.create({windowId: ${result.hostWindow}, url: chrome.runtime.getURL('popup.html')});
    return {originalTabId: originalTab.id, originalUrl: originalTab.url};
  })()`);
  let popupPage;
  for (let attempt = 0; attempt < 50; attempt++) {
    const targets = await send('Target.getTargets');
    popupPage = targets.targetInfos.find(target => target.type === 'page' && target.url.endsWith('/popup.html'));
    if (popupPage) break;
    await delay(200);
  }
  if (!popupPage) throw new Error('未找到扩展弹窗页面');
  const popupSession = await send('Target.attachToTarget', { targetId: popupPage.targetId, flatten: true });
  const clickResult = await send('Runtime.evaluate', {
    expression: `(async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const button = [...document.querySelectorAll('.open')].find(item => item.querySelector('.name').textContent === 'Window test');
        if (button) {
          button.dispatchEvent(new MouseEvent('auxclick', {button: 1, bubbles: true, cancelable: true}));
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    })()`,
    awaitPromise: true, returnByValue: true
  }, popupSession.sessionId);
  assert.equal(clickResult.result.value, true);
  await delay(1800);
  const popupResult = await evaluate(`(async () => {
    const [group] = await chrome.tabGroups.query({title: 'Window test'});
    const originalTab = await chrome.tabs.get(${popupSetup.originalTabId});
    const restoreTabs = (await chrome.tabs.query({})).filter(tab => tab.url?.startsWith(chrome.runtime.getURL('restore.html')));
    return {groupWindow: group?.windowId, originalWindow: originalTab.windowId, originalUrl: originalTab.url, restoreTabs: restoreTabs.length};
  })()`);
  assert.notEqual(popupResult.groupWindow, undefined);
  assert.notEqual(popupResult.groupWindow, result.hostWindow);
  assert.equal(popupResult.originalWindow, result.hostWindow);
  assert.equal(popupResult.originalUrl, popupSetup.originalUrl);
  assert.equal(popupResult.restoreTabs, 0);
  await evaluate(`(async () => {
    const [group] = await chrome.tabGroups.query({title: 'Integration test'});
    const groupTabs = await chrome.tabs.query({groupId: group.id});
    await chrome.tabs.remove(groupTabs.map(tab => tab.id));
    await new Promise(resolve => setTimeout(resolve, 1800));
    await chrome.windows.update(${result.hostWindow}, {focused: true});
    await chrome.tabs.update(${popupSetup.originalTabId}, {active: true});
    await chrome.tabs.create({windowId: ${result.hostWindow}, url: chrome.runtime.getURL('popup.html?test=left'), active: false});
  })()`);
  let leftPopupPage;
  for (let attempt = 0; attempt < 50; attempt++) {
    const targets = await send('Target.getTargets');
    leftPopupPage = targets.targetInfos.find(target => target.type === 'page' && target.url.endsWith('/popup.html?test=left'));
    if (leftPopupPage) break;
    await delay(200);
  }
  if (!leftPopupPage) throw new Error('未找到左键测试弹窗页面');
  const leftPopupSession = await send('Target.attachToTarget', { targetId: leftPopupPage.targetId, flatten: true });
  const leftClickResult = await send('Runtime.evaluate', {
    expression: `(async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const button = [...document.querySelectorAll('.open')].find(item => item.querySelector('.name').textContent === 'Integration test');
        if (button) { button.click(); return true; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    })()`,
    awaitPromise: true, returnByValue: true
  }, leftPopupSession.sessionId);
  assert.equal(leftClickResult.result.value, true);
  await delay(1800);
  const leftResult = await evaluate(`(async () => {
    const [group] = await chrome.tabGroups.query({title: 'Integration test'});
    const [activeTab] = await chrome.tabs.query({windowId: ${result.hostWindow}, active: true});
    const restoreTabs = (await chrome.tabs.query({})).filter(tab => tab.url?.startsWith(chrome.runtime.getURL('restore.html')));
    return {groupWindow: group?.windowId, activeTabId: activeTab?.id, activeUrl: activeTab?.url, restoreTabs: restoreTabs.length};
  })()`);
  assert.notEqual(leftResult.groupWindow, undefined);
  assert.notEqual(leftResult.groupWindow, result.hostWindow);
  assert.equal(leftResult.activeTabId, popupSetup.originalTabId);
  assert.equal(leftResult.activeUrl, popupSetup.originalUrl);
  assert.equal(leftResult.restoreTabs, 0);
  const deletionResult = await evaluate(`(async () => {
    const [group] = await chrome.tabGroups.query({title: 'Window test'});
    const state = await getState();
    const id = state.live[String(group.id)];
    const groupTabs = await chrome.tabs.query({groupId: group.id});
    await chrome.tabs.remove(groupTabs.map(tab => tab.id));
    await new Promise(resolve => setTimeout(resolve, 1800));
    const closedState = await getState();
    const bookmarkId = closedState.snapshots[id].bookmarkId;
    await chrome.bookmarks.remove(bookmarkId);
    await new Promise(resolve => setTimeout(resolve, 300));
    await enqueue(refreshGroups);
    const after = await getState();
    return {snapshotExists: !!after.snapshots[id], matchingBookmarks: (await chrome.bookmarks.search({url: chrome.runtime.getURL('restore.html?id=' + encodeURIComponent(id))})).length};
  })()`);
  assert.equal(deletionResult.snapshotExists, false);
  assert.equal(deletionResult.matchingBookmarks, 0);
  console.log('Samsung integration: closing groups and windows preserves snapshots; restore and bookmarks work');
  socket.close();
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  browser.kill();
  console.log(`Temporary test profile: ${profile}`);
});