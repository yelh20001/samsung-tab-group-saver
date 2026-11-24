const list = document.querySelector('#groups');
const status = document.querySelector('#status');
const empty = document.querySelector('#empty');

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || !response.ok) throw new Error(response?.error || '扩展后台无响应');
  return response.result;
}

async function render() {
  const state = await request({ type: 'list' });
  const activeSnapshots = new Set(Object.values(state.live));
  const groups = Object.values(state.snapshots)
    .filter(group => !activeSnapshots.has(group.id))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  list.replaceChildren();
  empty.hidden = groups.length > 0;
  status.textContent = `已保存 ${groups.length} 个分组`;
  status.classList.remove('error');
  for (const group of groups) {
    const item = document.createElement('li');
    const open = document.createElement('button');
    open.className = 'open';
    open.title = '在新窗口恢复分组';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = group.title;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${group.tabs.length} 个网页 · ${new Date(group.updatedAt).toLocaleString()}`;
    open.append(name, meta);
    async function openInNewWindow() {
      try {
        const url = chrome.runtime.getURL(`restore.html?id=${encodeURIComponent(group.id)}&window=1`);
        await chrome.windows.create({ url, focused: true });
        window.close();
      } catch (error) { showError(error); }
    }
    open.addEventListener('click', openInNewWindow);
    open.addEventListener('auxclick', event => {
      if (event.button !== 1) return;
      event.preventDefault();
      return openInNewWindow();
    });
    const remove = document.createElement('button');
    remove.className = 'delete';
    remove.textContent = '×';
    remove.title = '删除保存的分组';
    remove.setAttribute('aria-label', `删除 ${group.title}`);
    remove.addEventListener('click', async () => {
      if (!confirm(`删除保存的“${group.title}”和对应书签？`)) return;
      try { await request({ type: 'delete', id: group.id }); await render(); }
      catch (error) { showError(error); }
    });
    item.append(open, remove);
    list.append(item);
  }
}

function showError(error) {
  status.textContent = error.message;
  status.classList.add('error');
}

document.querySelector('#refresh').addEventListener('click', async () => {
  try { await request({ type: 'refresh' }); await render(); }
  catch (error) { showError(error); }
});
render().catch(showError);