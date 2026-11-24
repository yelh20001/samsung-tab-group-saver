const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const storage = {};
const bookmarks = new Map();
let nextBookmarkId = 1;
const createdTabs = [];
const updatedTabs = [];
let windows = [{ id: 1, type: 'normal' }];
let groups = [
  { id: 1, title: 'Work', color: 'blue' },
  { id: 2, title: 'Study', color: 'green' }
];
let tabs = [
  { id: 10, groupId: 1, index: 0, url: 'https://one.example', title: 'One' },
  { id: 11, groupId: 1, index: 1, url: 'https://two.example', title: 'Two' },
  { id: 20, groupId: 2, index: 0, url: 'https://three.example', title: 'Three' }
];
const event = () => ({ addListener() {} });
let bookmarkRemoved;
let startupListener;
let removeOnUpdate;
const chrome = {
  storage: { local: {
    async get() { return structuredClone(storage); },
    async set(value) { Object.assign(storage, structuredClone(value)); }
  } },
  runtime: { getURL: path => `chrome-extension://test/${path}`, onInstalled: event(), onStartup: { addListener(listener) { startupListener = listener; } }, onMessage: event() },
  bookmarks: {
    async getTree() { return [{ children: [{ id: '1', folderType: 'bookmarks-bar', children: [...bookmarks.values()] }] }]; },
    async search(query) { return [...bookmarks.values()].filter(node => !query.url || node.url === query.url); },
    async create(value) { const result = { ...value, id: String(nextBookmarkId++) }; bookmarks.set(result.id, result); return result; },
    async update(id, value) {
      if (id === removeOnUpdate) {
        removeOnUpdate = null;
        await chrome.bookmarks.remove(id);
      }
      Object.assign(bookmarks.get(id), value);
    },
    async remove(id) {
      const node = bookmarks.get(id);
      bookmarks.delete(id);
      if (node) bookmarkRemoved(id, { node });
    },
    onRemoved: { addListener(listener) { bookmarkRemoved = listener; } }
  },
  tabGroups: {
    async query() { return structuredClone(groups); },
    async update(id, value) { groups.push({ id, ...value }); },
    onCreated: event(), onUpdated: event(), onMoved: event(), onRemoved: event()
  },
  windows: {
    async getAll() { return structuredClone(windows); },
    onCreated: event()
  },
  tabs: {
    async query(query) { return structuredClone(tabs.filter(tab => tab.groupId === query.groupId)); },
    async create(value) { const tab = { ...value, id: 100 + createdTabs.length }; createdTabs.push(tab); return tab; },
    async group() { return 1000; }, async update(id, value) { updatedTabs.push({ id, ...value }); },
    onCreated: event(), onUpdated: event(), onMoved: event(), onAttached: event(), onDetached: event(), onRemoved: event()
  }
};
const context = vm.createContext({ chrome, console, URL, URLSearchParams, crypto: { randomUUID }, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(`${__dirname}/background.js`, 'utf8'), context);

(async () => {
  await context.refreshGroups();
  assert.equal(Object.keys(storage.groupSnapshots).length, 2);
  assert.equal(bookmarks.size, 0);
  const snapshot = Object.values(storage.groupSnapshots).find(item => item.title === 'Work');
  groups = [];
  tabs = [];
  await context.refreshGroups();
  assert.equal(storage.groupSnapshots[snapshot.id].tabs.length, 2);
  assert.equal(Object.keys(storage.groupSnapshots).length, 2);
  assert.equal(bookmarks.size, 2);
  const bookmark = bookmarks.get(storage.groupSnapshots[snapshot.id].bookmarkId);
  assert.equal(bookmark.title, 'Work');
  bookmark.title = '🔵 Work';
  await context.refreshGroups();
  assert.equal(bookmark.title, 'Work');
  await context.enqueue(() => context.restoreGroup(snapshot.id, 77));
  await context.enqueue(() => {});
  assert.deepEqual(createdTabs.map(tab => tab.url), ['https://one.example', 'https://two.example']);
  assert.deepEqual(updatedTabs, [{ id: 100, active: true }]);
  assert.equal(groups[0].title, 'Work');
  assert.equal(groups[0].color, 'blue');
  assert.equal(storage.liveGroups['1000'], snapshot.id);
  assert.equal(storage.groupSnapshots[snapshot.id].bookmarkId, null);
  assert.equal(bookmarks.size, 1);
  await context.refreshGroups();
  assert.equal(bookmarks.size, 1);
  groups = [];
  await context.refreshGroups();
  assert.equal(bookmarks.size, 2);
  await context.enqueue(() => context.deleteSnapshot(snapshot.id));
  assert.equal(bookmarks.size, 1);
  const remaining = Object.values(storage.groupSnapshots)[0];
  const remainingBookmark = bookmarks.get(remaining.bookmarkId);
  const raceBookmark = await chrome.bookmarks.create({
    title: 'Race', url: chrome.runtime.getURL('restore.html?id=race')
  });
  storage.groupSnapshots.race = { id: 'race', title: 'Race', color: 'blue', tabs: [{ url: 'https://race.example' }], bookmarkId: raceBookmark.id };
  removeOnUpdate = raceBookmark.id;
  await context.enqueue(() => context.refreshGroups());
  await context.enqueue(() => {});
  assert.equal(storage.groupSnapshots.race, undefined);
  assert.equal(bookmarks.size, 1);
  bookmarks.set('copy', { ...remainingBookmark, id: 'copy' });
  await chrome.bookmarks.remove('copy');
  await context.enqueue(() => {});
  assert.ok(storage.groupSnapshots[remaining.id]);
  await chrome.bookmarks.remove(remaining.bookmarkId);
  await context.enqueue(() => {});
  assert.equal(storage.groupSnapshots[remaining.id], undefined);
  await context.refreshGroups();
  assert.equal(bookmarks.size, 0);
  // A browser restart can restore the same group with a different group ID.
  groups = [{ id: 5, title: 'Restarted', color: 'blue' }];
  tabs = [{ id: 50, groupId: 5, index: 0, url: 'https://restart.example' }];
  await context.refreshGroups();
  const originalId = storage.liveGroups['5'];
  groups = [];
  tabs = [];
  await context.refreshGroups();
  assert.ok(storage.groupSnapshots[originalId].bookmarkId);
  groups = [{ id: 6, title: 'Restarted', color: 'blue' }];
  tabs = [{ id: 60, groupId: 6, index: 0, url: 'https://restart.example' }];
  startupListener();
  await context.enqueue(() => {});
  assert.equal(storage.liveGroups['6'], originalId);
  assert.equal(storage.groupSnapshots[originalId].bookmarkId, null);
  assert.equal(bookmarks.size, 0);
  // Closing all normal windows should not bookmark live groups during shutdown.
  windows = [];
  groups = [];
  tabs = [];
  await context.refreshGroups();
  assert.equal(storage.liveGroups['6'], originalId);
  assert.equal(storage.groupSnapshots[originalId].bookmarkId, null);
  assert.equal(bookmarks.size, 0);
  // Reopening without onStartup (e.g. background mode) with a new group ID still matches.
  windows = [{ id: 2, type: 'normal' }];
  groups = [{ id: 7, title: 'Restarted', color: 'blue' }];
  tabs = [{ id: 70, groupId: 7, index: 0, url: 'https://restart.example/' }];
  await context.refreshGroups();
  assert.equal(storage.liveGroups['7'], originalId);
  assert.equal(Object.keys(storage.groupSnapshots).length, 1);
  assert.equal(bookmarks.size, 0);
  // Partial session restore (1 of 3 tabs initially) reconciles once remaining tabs arrive.
  groups = [{ id: 8, title: '', color: 'red' }];
  tabs = [
    { id: 80, groupId: 8, index: 0, url: 'https://part-a.example' },
    { id: 81, groupId: 8, index: 1, url: 'https://part-b.example' },
    { id: 82, groupId: 8, index: 2, url: 'https://part-c.example' }
  ];
  await context.refreshGroups();
  const unnamedId = storage.liveGroups['8'];
  groups = [{ id: 9, title: '', color: 'red' }];
  tabs = [{ id: 90, groupId: 9, index: 0, url: 'https://part-a.example' }];
  startupListener();
  await context.enqueue(() => {});
  assert.ok(storage.groupSnapshots[unnamedId].bookmarkId);
  tabs.push(
    { id: 91, groupId: 9, index: 1, url: 'https://part-b.example' },
    { id: 92, groupId: 9, index: 2, url: 'https://part-c.example' }
  );
  await context.refreshGroups();
  assert.equal(storage.liveGroups['9'], unnamedId);
  assert.equal(storage.groupSnapshots[unnamedId].bookmarkId, null);
  assert.equal(Object.keys(storage.groupSnapshots).length, 2);
  // Crash/power-off restore: URLs drift (e.g. bilibili/youtube tracking & timestamp params) and an extra tab exists.
  groups = [{ id: 10, title: 'Video', color: 'purple' }];
  tabs = [
    { id: 100, groupId: 10, index: 0, url: 'https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333&vd_source=abc&t=42' },
    { id: 101, groupId: 10, index: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120s&si=xyz' }
  ];
  await context.refreshGroups();
  const videoId = storage.liveGroups['10'];
  // Browser opens after unclean shutdown: initially 0 groups -> bookmark created.
  groups = [];
  tabs = [];
  startupListener();
  await context.enqueue(() => {});
  assert.ok(storage.groupSnapshots[videoId].bookmarkId);
  // User clicks Restore: group returns with new ID, stripped query params, and one extra tab.
  groups = [{ id: 11, title: 'Video', color: 'purple' }];
  tabs = [
    { id: 110, groupId: 11, index: 0, url: 'https://www.bilibili.com/video/BV1xx411c7mD/' },
    { id: 111, groupId: 11, index: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { id: 112, groupId: 11, index: 2, url: 'https://example.com/extra' }
  ];
  await context.refreshGroups();
  assert.equal(storage.liveGroups['11'], videoId);
  assert.equal(storage.groupSnapshots[videoId].bookmarkId, null);
  // Out-of-sync orphan bookmark on bookmarks bar is automatically cleaned up.
  await chrome.bookmarks.create({ title: 'Orphan', url: chrome.runtime.getURL('restore.html?id=missing-id') });
  await chrome.bookmarks.create({ title: 'Dup', url: chrome.runtime.getURL(`restore.html?id=${encodeURIComponent(videoId)}`) });
  await context.refreshGroups();
  const videoBookmarks = [...bookmarks.values()].filter(b => b.url.includes(videoId) || b.url.includes('missing-id'));
  assert.equal(videoBookmarks.length, 0);
  console.log('Multiple groups, bookmarks, close and restore: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });