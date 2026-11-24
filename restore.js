async function restore() {
  const params = new URL(location.href).searchParams;
  const id = params.get('id');
  if (!id) throw new Error('书签中没有分组编号');
  const tab = await chrome.tabs.getCurrent();
  if (tab.active && params.get('window') !== '1') {
    const url = chrome.runtime.getURL(`restore.html?id=${encodeURIComponent(id)}&window=1`);
    await chrome.windows.create({ url, focused: true });
    document.querySelector('#status').textContent = '正在新窗口恢复分组；若无法返回原页面，可手动关闭此页。';
    if (history.length > 1) history.back();
    return;
  }
  let windowId = tab.windowId;
  if (!tab.active) {
    const window = await chrome.windows.create({ tabId: tab.id, focused: true });
    windowId = window.id;
  }
  const response = await chrome.runtime.sendMessage({ type: 'restore', id, windowId });
  if (!response || !response.ok) throw new Error(response?.error || '扩展后台无响应');
  await chrome.tabs.remove(tab.id);
}
restore().catch(error => { document.querySelector('#status').textContent = `恢复失败：${error.message}`; });