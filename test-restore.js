const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function runRestore({ active, response = { ok: true }, windowError, historyLength = 2, url = 'chrome-extension://test/restore.html?id=group' }) {
  const calls = [];
  const status = { textContent: '' };
  const chrome = {
    tabs: {
      async getCurrent() { return { id: 10, windowId: 20, active }; },
      async remove(id) { calls.push(['remove', id]); }
    },
    windows: {
      async create(options) {
        calls.push(['createWindow', { ...options }]);
        if (windowError) throw new Error(windowError);
        return { id: 30 };
      }
    },
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      async sendMessage(message) { calls.push(['restore', { ...message }]); return response; }
    }
  };
  const context = vm.createContext({
    chrome, URL, location: { href: url }, document: { querySelector: () => status },
    history: { length: historyLength, back() { calls.push(['back']); } }
  });
  const completed = new Promise(resolve => setImmediate(resolve));
  vm.runInContext(fs.readFileSync(`${__dirname}/restore.js`, 'utf8'), context);
  await completed;
  return { calls, status: status.textContent };
}

(async () => {
  const foreground = await runRestore({ active: true });
  assert.deepEqual(foreground.calls, [
    ['createWindow', { url: 'chrome-extension://test/restore.html?id=group&window=1', focused: true }],
    ['back']
  ]);
  const noHistory = await runRestore({ active: true, historyLength: 1 });
  assert.equal(noHistory.calls.length, 1);
  assert.match(noHistory.status, /无法返回原页面/);
  const newWindow = await runRestore({ active: true, url: 'chrome-extension://test/restore.html?id=group&window=1' });
  assert.deepEqual(newWindow.calls, [
    ['restore', { type: 'restore', id: 'group', windowId: 20 }],
    ['remove', 10]
  ]);
  const background = await runRestore({ active: false });
  assert.deepEqual(background.calls, [
    ['createWindow', { tabId: 10, focused: true }],
    ['restore', { type: 'restore', id: 'group', windowId: 30 }],
    ['remove', 10]
  ]);
  const windowFailure = await runRestore({ active: false, windowError: '无法创建窗口' });
  assert.equal(windowFailure.status, '恢复失败：无法创建窗口');
  assert.equal(windowFailure.calls.length, 1);
  const foregroundFailure = await runRestore({ active: true, windowError: '无法创建窗口' });
  assert.equal(foregroundFailure.status, '恢复失败：无法创建窗口');
  assert.equal(foregroundFailure.calls.length, 1);
  const restoreFailure = await runRestore({ active: false, response: { ok: false, error: '找不到保存的分组' } });
  assert.equal(restoreFailure.status, '恢复失败：找不到保存的分组');
  assert.equal(restoreFailure.calls.length, 2);
  const invalid = await runRestore({ active: false, url: 'chrome-extension://test/restore.html' });
  assert.equal(invalid.status, '恢复失败：书签中没有分组编号');
  assert.equal(invalid.calls.length, 0);
  console.log('Foreground and background bookmark restoration: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
