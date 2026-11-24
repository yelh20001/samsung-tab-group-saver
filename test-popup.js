const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function setup({ windowError } = {}) {
  const calls = [];
  function element() {
    return {
      children: [], listeners: {}, classList: { add() {}, remove() {} },
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
      addEventListener(type, handler) { this.listeners[type] = handler; },
      setAttribute() {}
    };
  }
  const list = element();
  const status = element();
  const empty = element();
  const refresh = element();
  const elements = { '#groups': list, '#status': status, '#empty': empty, '#refresh': refresh };
  const snapshot = { id: 'group & one', title: 'Group', tabs: [{ url: 'https://example.com' }], updatedAt: 1 };
  const chrome = {
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      async sendMessage(message) {
        calls.push(['message', { ...message }]);
        if (message.type === 'list') return { ok: true, result: { snapshots: { group: snapshot }, live: {} } };
        return { ok: true };
      }
    },
    windows: {
      async getCurrent() { return { id: 20 }; },
      async create(options) {
        calls.push(['createWindow', { ...options }]);
        if (windowError) throw new Error(windowError);
        return { id: 30 };
      }
    }
  };
  const context = vm.createContext({
    chrome, window: { close() { calls.push(['close']); } },
    document: { querySelector: selector => elements[selector], createElement: element }
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/popup.js`, 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  calls.length = 0;
  return { calls, open: list.children[0].children[0], status };
}

(async () => {
  const left = await setup();
  await left.open.listeners.click();
  assert.deepEqual(left.calls, [
    ['createWindow', { url: 'chrome-extension://test/restore.html?id=group%20%26%20one&window=1', focused: true }],
    ['close']
  ]);
  const middle = await setup();
  let prevented = false;
  await middle.open.listeners.auxclick({ button: 1, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(middle.calls, [
    ['createWindow', { url: 'chrome-extension://test/restore.html?id=group%20%26%20one&window=1', focused: true }],
    ['close']
  ]);
  const right = await setup();
  await right.open.listeners.auxclick({ button: 2, preventDefault() { throw new Error('unexpected preventDefault'); } });
  assert.deepEqual(right.calls, []);
  const failure = await setup({ windowError: '无法创建窗口' });
  await failure.open.listeners.auxclick({ button: 1, preventDefault() {} });
  assert.equal(failure.status.textContent, '无法创建窗口');
  assert.equal(failure.calls.length, 1);
  console.log('Popup left and middle click: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
