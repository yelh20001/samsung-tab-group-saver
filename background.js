const STATE_KEY = 'groupSnapshots';
const LIVE_KEY = 'liveGroups';
const UNTITLED = '未命名分组';
const IGNORED_PARAMS = new Set([
  't', 'time', 'start', 'index', 'pp', 'si', 'feature',
  'spm_id_from', 'vd_source', 'from', 'from_spmid', 'share_source',
  'share_medium', 'share_plat', 'share_session_id', 'share_tag',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'ref', 'ref_src', 'ref_url'
]);
let work = Promise.resolve();
let refreshTimer;
const replacedBookmarks = new Map();
const removingBookmarks = new Set();

function restoreUrl(id) {
  return chrome.runtime.getURL(`restore.html?id=${encodeURIComponent(id)}`);
}

async function removeBookmarkById(bookmarkId) {
  if (!bookmarkId) return;
  removingBookmarks.add(bookmarkId);
  try {
    await chrome.bookmarks.remove(bookmarkId);
  } catch (error) {
    removingBookmarks.delete(bookmarkId);
    console.warn('Bookmark already removed:', error);
  }
}

function enqueue(operation) {
  const result = work.then(operation);
  work = result.catch(error => console.error('Group saver:', error));
  return result;
}

async function getState() {
  const data = await chrome.storage.local.get([STATE_KEY, LIVE_KEY]);
  return { snapshots: data[STATE_KEY] || {}, live: data[LIVE_KEY] || {} };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state.snapshots, [LIVE_KEY]: state.live });
}

async function ensureBookmark(snapshot) {
  const title = snapshot.title;
  const url = restoreUrl(snapshot.id);
  if (snapshot.bookmarkId) {
    try {
      await chrome.bookmarks.update(snapshot.bookmarkId, { title });
      return;
    } catch (error) {
      replacedBookmarks.set(snapshot.bookmarkId, snapshot.id);
      snapshot.bookmarkId = null;
    }
  }
  if (chrome.bookmarks.search) {
    const existing = await chrome.bookmarks.search({ url });
    if (existing.length) {
      snapshot.bookmarkId = existing[0].id;
      try {
        await chrome.bookmarks.update(snapshot.bookmarkId, { title });
      } catch (error) {
        snapshot.bookmarkId = null;
      }
      for (const extra of existing.slice(1)) {
        await removeBookmarkById(extra.id);
      }
      if (snapshot.bookmarkId) return;
    }
  }
  const [root] = await chrome.bookmarks.getTree();
  const bar = root.children.find(node => node.folderType === 'bookmarks-bar') ||
    root.children.find(node => node.id === '1');
  if (!bar) throw new Error('Cannot find the bookmarks bar');
  const bookmark = await chrome.bookmarks.create({
    parentId: bar.id,
    title,
    url
  });
  snapshot.bookmarkId = bookmark.id;
}

async function removeBookmark(snapshot) {
  const bookmarkId = snapshot.bookmarkId;
  snapshot.bookmarkId = null;
  if (bookmarkId) await removeBookmarkById(bookmarkId);
  if (chrome.bookmarks.search) {
    const matches = await chrome.bookmarks.search({ url: restoreUrl(snapshot.id) });
    for (const node of matches) {
      if (node.id !== bookmarkId) await removeBookmarkById(node.id);
    }
  }
}

async function cleanupOrphanBookmarks(state, activeSnapshots) {
  const prefix = `${chrome.runtime.getURL('restore.html')}?`;
  const [root] = await chrome.bookmarks.getTree();
  const bar = root.children.find(node => node.folderType === 'bookmarks-bar') ||
    root.children.find(node => node.id === '1');
  if (!bar || !Array.isArray(bar.children)) return;
  for (const node of bar.children) {
    if (!node.url || !node.url.startsWith(prefix)) continue;
    const id = new URL(node.url).searchParams.get('id');
    if (!id) continue;
    const snapshot = state.snapshots[id];
    if (!snapshot || activeSnapshots.has(id) || (snapshot.bookmarkId && snapshot.bookmarkId !== node.id)) {
      await removeBookmarkById(node.id);
    }
  }
}

function normalizeUrl(url) {
  try {
    return new URL(url).href;
  } catch (error) {
    return url;
  }
}

function looseUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    const params = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!IGNORED_PARAMS.has(key.toLowerCase())) params.push([key, value]);
    }
    params.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
    const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
    return `${host}${path}${query}`;
  } catch (error) {
    return url;
  }
}

function sameTabs(left, right) {
  return left.length === right.length &&
    left.every((tab, index) => normalizeUrl(tab.url) === normalizeUrl(right[index].url));
}

function tabOverlapScore(left, right) {
  if (!left.length || !right.length) return 0;
  const remaining = new Map();
  for (const tab of right) {
    const key = looseUrl(tab.url);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  let matched = 0;
  for (const tab of left) {
    const key = looseUrl(tab.url);
    const count = remaining.get(key) || 0;
    if (count > 0) {
      matched++;
      remaining.set(key, count - 1);
    }
  }
  return matched / Math.max(left.length, right.length);
}

function findMatchingSnapshot(state, activeIds, title, color, pages) {
  const inactive = Object.values(state.snapshots).filter(snapshot =>
    !activeIds.has(snapshot.id) &&
    snapshot.title === title &&
    snapshot.color === color
  );
  const exact = inactive.filter(snapshot => sameTabs(snapshot.tabs, pages));
  if (exact.length) {
    exact.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
    return exact[0].id;
  }
  const loose = inactive
    .map(snapshot => ({ snapshot, score: tabOverlapScore(snapshot.tabs, pages) }))
    .filter(item => item.score >= 0.5);
  if (!loose.length) return null;
  loose.sort((left, right) => right.score - left.score || (right.snapshot.updatedAt || 0) - (left.snapshot.updatedAt || 0));
  return loose[0].snapshot.id;
}

async function refreshGroups() {
  if (chrome.windows && chrome.windows.getAll) {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (!windows.length) return;
  }
  const groups = await chrome.tabGroups.query({});
  const state = await getState();
  const currentIds = new Set(groups.map(group => String(group.id)));
  for (const key of Object.keys(state.live)) {
    if (!currentIds.has(key)) delete state.live[key];
  }
  const activeIds = new Set(Object.values(state.live));
  for (const group of groups) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    const pages = tabs.filter(tab => !tab.incognito && (tab.url || tab.pendingUrl))
      .sort((left, right) => left.index - right.index)
      .map(tab => ({ url: tab.pendingUrl || tab.url, title: tab.title || '' }));
    if (!pages.length) continue;
    const key = String(group.id);
    const title = group.title || UNTITLED;
    let id = state.live[key];
    const matchedId = findMatchingSnapshot(state, activeIds, title, group.color, pages);
    if (matchedId) {
      if (id && id !== matchedId) {
        const temporary = state.snapshots[id];
        if (temporary) {
          await removeBookmark(temporary);
          delete state.snapshots[id];
        }
        activeIds.delete(id);
      }
      id = matchedId;
    } else if (!id) {
      id = crypto.randomUUID();
    }
    const previous = state.snapshots[id] || {};
    const snapshot = {
      id, title, color: group.color, tabs: pages,
      updatedAt: Date.now(), bookmarkId: previous.bookmarkId || null
    };
    state.live[key] = id;
    activeIds.add(id);
    state.snapshots[id] = snapshot;
  }
  const activeSnapshots = new Set(Object.values(state.live));
  for (const snapshot of Object.values(state.snapshots)) {
    if (activeSnapshots.has(snapshot.id)) await removeBookmark(snapshot);
    else await ensureBookmark(snapshot);
  }
  await cleanupOrphanBookmarks(state, activeSnapshots);
  await saveState(state);
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => enqueue(refreshGroups), 800);
}

async function restoreGroup(id, windowId) {
  const state = await getState();
  const snapshot = state.snapshots[id];
  if (!snapshot || !snapshot.tabs.length) throw new Error('找不到保存的分组');
  const tabIds = [];
  for (const page of snapshot.tabs) {
    const tab = await chrome.tabs.create({ windowId, url: page.url, active: false });
    tabIds.push(tab.id);
  }
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  state.live[String(groupId)] = id;
  await saveState(state);
  await chrome.tabGroups.update(groupId, {
    title: snapshot.title === UNTITLED ? '' : snapshot.title,
    color: snapshot.color
  });
  await chrome.tabs.update(tabIds[0], { active: true });
  await removeBookmark(snapshot);
  await saveState(state);
}

async function deleteSnapshot(id) {
  const state = await getState();
  const snapshot = state.snapshots[id];
  if (!snapshot) return;
  await removeBookmark(snapshot);
  delete state.snapshots[id];
  for (const [groupId, snapshotId] of Object.entries(state.live)) {
    if (snapshotId === id) delete state.live[groupId];
  }
  await saveState(state);
}

chrome.runtime.onInstalled.addListener(() => enqueue(refreshGroups));
chrome.runtime.onStartup.addListener(() => enqueue(async () => {
  await chrome.storage.local.set({ [LIVE_KEY]: {} });
  await refreshGroups();
}));
chrome.tabGroups.onCreated.addListener(scheduleRefresh);
chrome.tabGroups.onUpdated.addListener(scheduleRefresh);
chrome.tabGroups.onMoved.addListener(scheduleRefresh);
chrome.tabGroups.onRemoved.addListener(scheduleRefresh);
chrome.tabs.onCreated.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener(scheduleRefresh);
chrome.tabs.onMoved.addListener(scheduleRefresh);
chrome.tabs.onAttached.addListener(scheduleRefresh);
chrome.tabs.onDetached.addListener(scheduleRefresh);
chrome.tabs.onRemoved.addListener(scheduleRefresh);
if (chrome.windows && chrome.windows.onCreated) {
  chrome.windows.onCreated.addListener(scheduleRefresh);
}
chrome.bookmarks.onRemoved.addListener((bookmarkId, info) => {
  if (removingBookmarks.delete(bookmarkId)) return;
  const url = info.node.url;
  if (!url || !url.startsWith(`${chrome.runtime.getURL('restore.html')}?`)) return;
  const id = new URL(url).searchParams.get('id');
  if (!id) return;
  enqueue(async () => {
    const state = await getState();
    const snapshot = state.snapshots[id];
    const replacedId = replacedBookmarks.get(bookmarkId);
    replacedBookmarks.delete(bookmarkId);
    if (!snapshot || (snapshot.bookmarkId !== bookmarkId && replacedId !== id)) return;
    if (Object.values(state.live).includes(id)) return;
    await deleteSnapshot(id);
  });
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let operation;
  if (message.type === 'list') operation = () => getState();
  if (message.type === 'refresh') operation = () => refreshGroups();
  if (message.type === 'restore') operation = () => restoreGroup(message.id, message.windowId);
  if (message.type === 'delete') operation = () => deleteSnapshot(message.id);
  if (!operation) return false;
  enqueue(operation).then(
    result => sendResponse({ ok: true, result }),
    error => sendResponse({ ok: false, error: error.message })
  );
  return true;
});