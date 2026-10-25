// Local storage layer (IndexedDB). This is the source of truth on each device;
// sync.js copies changes to and from the server when you're signed in.
// Stores:
//   scores   {id, title, tags[], pageCount, addedAt, openedAt, lastPage, thumb(Blob)}
//   files    {id, blob}            PDF bytes, kept apart so listing the library stays cheap
//   ink      {key: `${scoreId}:${page}`, scoreId, page, strokes[]}
//   setlists {id, name, scoreIds[], createdAt}
//   spots    {id, scoreId, page, label, goal, tempo, createdAt}
//   pending  {key: `${store}|${id}`, store, id, op: 'put'|'del'}   changes not yet uploaded
//   meta     {k, v}                small settings, e.g. sync cursors
// Synced rows also carry updatedAt (ms) for last-write-wins merging.

const DB_NAME = 'score-stand';
const DB_VERSION = 2;
export const SYNCED = ['scores', 'setlists', 'spots', 'ink'];
const keyOf = (name, value) => (name === 'ink' ? value.key : value.id);
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 2) {
        db.createObjectStore('pending', { keyPath: 'key' });
        db.createObjectStore('meta', { keyPath: 'k' });
      }
      if (e.oldVersion >= 1) return;
      db.createObjectStore('scores', { keyPath: 'id' });
      db.createObjectStore('files', { keyPath: 'id' });
      const ink = db.createObjectStore('ink', { keyPath: 'key' });
      ink.createIndex('scoreId', 'scoreId');
      db.createObjectStore('setlists', { keyPath: 'id' });
      const spots = db.createObjectStore('spots', { keyPath: 'id' });
      spots.createIndex('scoreId', 'scoreId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const uid = () => crypto.randomUUID();

export async function getAll(name) { return wrap((await store(name)).getAll()); }
export async function get(name, key) { return wrap((await store(name)).get(key)); }

// Listeners are told when a synced store changes locally (sync.js schedules an upload).
const listeners = new Set();
export const onLocalChange = (fn) => listeners.add(fn);

async function enqueue(name, id, op) {
  await wrap((await store('pending', 'readwrite')).put({ key: `${name}|${id}`, store: name, id, op, at: Date.now() }));
  for (const fn of listeners) fn();
}

// put/del on synced stores record the change for upload unless it came from the server.
export async function put(name, value, { remote = false } = {}) {
  const synced = SYNCED.includes(name);
  if (synced && !remote) value.updatedAt = Date.now();
  await wrap((await store(name, 'readwrite')).put(value));
  if (synced && !remote) await enqueue(name, keyOf(name, value), 'put');
}

export async function del(name, key, { remote = false } = {}) {
  await wrap((await store(name, 'readwrite')).delete(key));
  if (SYNCED.includes(name) && !remote) await enqueue(name, key, 'del');
}

export async function getMeta(k) { return (await get('meta', k))?.v; }
export async function setMeta(k, v) { return wrap((await store('meta', 'readwrite')).put({ k, v })); }

export async function byIndex(name, index, value) {
  return wrap((await store(name)).index(index).getAll(value));
}

export async function addScore({ title, blob, pageCount, thumb }) {
  const id = uid();
  const now = Date.now();
  await put('files', { id, blob });
  await put('scores', { id, title, tags: [], pageCount, addedAt: now, openedAt: 0, lastPage: 1, thumb });
  return id;
}

// With remote: true (a delete that came from another device) nothing is queued for upload;
// that device already told the server.
export async function deleteScore(id, { remote = false } = {}) {
  const opts = { remote };
  await del('scores', id, opts);
  await del('files', id);
  for (const row of await byIndex('ink', 'scoreId', id)) await del('ink', row.key, opts);
  for (const row of await byIndex('spots', 'scoreId', id)) await del('spots', row.id, opts);
  for (const list of await getAll('setlists')) {
    if (list.scoreIds.includes(id)) {
      list.scoreIds = list.scoreIds.filter((s) => s !== id);
      await put('setlists', list, opts);
    }
  }
}

export async function getInk(scoreId, page) {
  const row = await get('ink', `${scoreId}:${page}`);
  return row ? row.strokes : [];
}

export async function saveInk(scoreId, page, strokes) {
  const key = `${scoreId}:${page}`;
  if (strokes.length) await put('ink', { key, scoreId, page, strokes });
  else await del('ink', key);
}

// Ask the browser not to evict our data (Safari can clear unused site data otherwise).
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return true;
  } catch {
    return false;
  }
}
