// Cross-device sync with Supabase, using plain fetch against its REST APIs
// (no SDK, so there's less third-party code to trust).
//
// Model: IndexedDB stays the source of truth on each device. Local writes are
// queued in the `pending` store. A sync pulls everything the server has seen
// since our cursor (server clock, `synced_at`), merges it last-write-wins by
// `updated_ms` (client clock), then uploads whatever is still pending.
// Deletes are soft on the server (`deleted = true`) so other devices hear about them.
import * as db from './db.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { loadPdf, makeThumb } from './pdf.js';

export const enabled = Boolean(SUPABASE_URL && SUPABASE_KEY);

// ---------- status for the UI ----------
const statusListeners = new Set();
let status = { state: enabled ? 'signed-out' : 'off' };
export const getStatus = () => status;
export function onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }
function setStatus(s) { status = { ...s, at: Date.now() }; for (const fn of statusListeners) fn(status); }

// ---------- auth (email one-time code) ----------
// A 6-digit code works inside the home-screen app; a magic link would open
// Safari instead, which has separate storage from the installed app.
async function authFetch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.error_description || data.message || `Sign-in failed (${res.status})`);
  return data;
}

function saveSession(data) {
  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    user: { id: data.user.id, email: data.user.email },
  };
  return db.setMeta('session', session).then(() => session);
}

export async function sendCode(email) {
  // create_user: false — only the account you made in the dashboard can sign in.
  await authFetch('otp', { email, create_user: false });
}

export async function verifyCode(email, token) {
  await saveSession(await authFetch('verify', { type: 'email', email, token }));
  await db.setMeta('cursors', {}); // first sync on this device pulls everything
  syncNow();
}

export async function signOut() {
  const s = await db.getMeta('session');
  if (s) {
    fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${s.access_token}` } }).catch(() => {});
  }
  await db.setMeta('session', null);
  setStatus({ state: 'signed-out' });
}

export async function currentUser() {
  return (await db.getMeta('session'))?.user || null;
}

async function token() {
  let s = await db.getMeta('session');
  if (!s) return null;
  if (s.expires_at - Date.now() < 60_000) {
    try {
      s = await saveSession(await authFetch('token?grant_type=refresh_token', { refresh_token: s.refresh_token }));
    } catch (e) {
      if (navigator.onLine) { await db.setMeta('session', null); setStatus({ state: 'signed-out', message: 'Please sign in again.' }); }
      throw e;
    }
  }
  return s;
}

// ---------- REST helpers ----------
async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const s = await token();
  if (!s) throw new Error('signed out');
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${s.access_token}`,
      ...(body && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status} ${await res.text().catch(() => '')}`);
  if (raw) return res;
  return res.status === 204 || method !== 'GET' ? null : res.json();
}

const pdfPath = (uid, id) => `${uid}/${id}.pdf`;

// ---------- field mapping (local ⇄ server) ----------
const iso = (ms) => new Date(ms || Date.now()).toISOString();
const ms = (s) => (s ? Date.parse(s) : 0);

const TABLES = {
  scores: {
    key: (r) => r.id,
    filter: (id) => `id=eq.${id}`,
    toRemote: (l) => ({ id: l.id, title: l.title, tags: l.tags, page_count: l.pageCount, last_page: l.lastPage, added_at: iso(l.addedAt), updated_ms: l.updatedAt, deleted: false }),
    toLocal: (r, old = {}) => ({ ...old, id: r.id, title: r.title, tags: r.tags, pageCount: r.page_count, lastPage: r.last_page, addedAt: ms(r.added_at), openedAt: old.openedAt || 0, updatedAt: r.updated_ms }),
  },
  setlists: {
    key: (r) => r.id,
    filter: (id) => `id=eq.${id}`,
    toRemote: (l) => ({ id: l.id, name: l.name, score_ids: l.scoreIds, created_at: iso(l.createdAt), updated_ms: l.updatedAt, deleted: false }),
    toLocal: (r) => ({ id: r.id, name: r.name, scoreIds: r.score_ids, createdAt: ms(r.created_at), updatedAt: r.updated_ms }),
  },
  spots: {
    key: (r) => r.id,
    filter: (id) => `id=eq.${id}`,
    toRemote: (l) => ({ id: l.id, score_id: l.scoreId, page: l.page, label: l.label, goal: l.goal || null, tempo: l.tempo || null, created_at: iso(l.createdAt), updated_ms: l.updatedAt, deleted: false }),
    toLocal: (r) => ({ id: r.id, scoreId: r.score_id, page: r.page, label: r.label, goal: r.goal || '', tempo: r.tempo, createdAt: ms(r.created_at), updatedAt: r.updated_ms }),
  },
  ink: {
    key: (r) => `${r.score_id}:${r.page}`,
    filter: (key) => { const [sid, p] = key.split(':'); return `score_id=eq.${sid}&page=eq.${p}`; },
    conflict: 'score_id,page',
    toRemote: (l) => ({ score_id: l.scoreId, page: l.page, strokes: l.strokes, updated_ms: l.updatedAt, deleted: false }),
    toLocal: (r) => ({ key: `${r.score_id}:${r.page}`, scoreId: r.score_id, page: r.page, strokes: r.strokes, updatedAt: r.updated_ms }),
  },
};
const ORDER = ['scores', 'setlists', 'spots', 'ink']; // parents before children

// ---------- pull ----------
async function pull(uid) {
  const cursors = (await db.getMeta('cursors')) || {};
  const pendingByKey = new Map((await db.getAll('pending')).map((p) => [p.key, p]));
  const needFiles = [];
  let applied = 0;

  for (const table of ORDER) {
    const t = TABLES[table];
    for (;;) {
      const since = cursors[table] ? `&synced_at=gt.${encodeURIComponent(cursors[table])}` : '';
      const rows = await api(`/rest/v1/${table}?select=*&order=synced_at.asc&limit=500${since}`);
      for (const r of rows) {
        const key = t.key(r);
        const local = await db.get(table, key);
        const localMs = local?.updatedAt || 0;
        if (local && localMs > r.updated_ms) continue; // ours is newer; it will be pushed
        const pk = `${table}|${key}`;
        const pend = pendingByKey.get(pk);
        if (pend?.op === 'del' && pend.at > r.updated_ms) continue; // we deleted it after this edit
        if (pend) { await db.del('pending', pk); pendingByKey.delete(pk); }
        applied++;
        if (r.deleted) {
          if (!local) continue;
          if (table === 'scores') await db.deleteScore(key, { remote: true });
          else await db.del(table, key, { remote: true });
        } else {
          await db.put(table, t.toLocal(r, local), { remote: true });
          if (table === 'scores' && !(await db.get('files', key))) needFiles.push(key);
        }
      }
      if (rows.length) cursors[table] = rows[rows.length - 1].synced_at;
      await db.setMeta('cursors', cursors);
      if (rows.length < 500) break;
    }
  }

  // Download PDFs for scores added on another device.
  for (const id of needFiles) {
    const res = await api(`/storage/v1/object/authenticated/scores/${pdfPath(uid, id)}`, { raw: true });
    const blob = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
    await db.put('files', { id, blob });
    await db.setMeta(`up:${id}`, true);
    const score = await db.get('scores', id);
    if (score) {
      const pdf = await loadPdf(blob);
      score.thumb = await makeThumb(pdf);
      pdf.loadingTask.destroy();
      await db.put('scores', score, { remote: true });
    }
  }
  return applied;
}

// ---------- push ----------
async function push(uid) {
  const pending = await db.getAll('pending');
  pending.sort((a, b) => ORDER.indexOf(a.store) - ORDER.indexOf(b.store));
  for (const p of pending) {
    const t = TABLES[p.store];
    if (!t) { await db.del('pending', p.key); continue; }
    const local = p.op === 'put' ? await db.get(p.store, p.id) : null;
    if (local) {
      if (p.store === 'scores' && !(await db.getMeta(`up:${p.id}`))) {
        const file = await db.get('files', p.id);
        if (file) {
          await api(`/storage/v1/object/scores/${pdfPath(uid, p.id)}`, {
            method: 'POST', body: file.blob, headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
          });
          await db.setMeta(`up:${p.id}`, true);
        }
      }
      const q = t.conflict ? `?on_conflict=${t.conflict}` : '';
      await api(`/rest/v1/${p.store}${q}`, {
        method: 'POST', body: [t.toRemote(local)], headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      });
    } else {
      // Deleted locally (or row gone): mark deleted on the server.
      await api(`/rest/v1/${p.store}?${t.filter(p.id)}`, {
        method: 'PATCH', body: { deleted: true, updated_ms: Date.now() }, headers: { Prefer: 'return=minimal' },
      });
      if (p.store === 'scores') {
        await api(`/storage/v1/object/scores/${pdfPath(uid, p.id)}`, { method: 'DELETE' }).catch(() => {});
        await db.setMeta(`up:${p.id}`, null);
      }
    }
    // Only clear the entry if nothing changed it while we were uploading.
    const now = await db.get('pending', p.key);
    if (now && now.op === p.op && (!local || (await db.get(p.store, p.id))?.updatedAt === local.updatedAt)) {
      await db.del('pending', p.key);
    }
  }
}

// ---------- scheduling ----------
let running = null;
let again = false;
const changeListeners = new Set();
export const onRemoteChange = (fn) => changeListeners.add(fn);
export const offRemoteChange = (fn) => changeListeners.delete(fn);

export function syncNow() {
  if (!enabled) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      const s = await db.getMeta('session');
      if (!s) { setStatus({ state: 'signed-out' }); return; }
      if (!navigator.onLine) { setStatus({ state: 'offline' }); return; }
      setStatus({ state: 'syncing' });
      const applied = await pull(s.user.id);
      await push(s.user.id);
      setStatus({ state: 'ok' });
      if (applied) for (const fn of changeListeners) fn();
    } catch (e) {
      console.error(e);
      if (status.state !== 'signed-out') setStatus({ state: 'error', message: e.message });
    } finally {
      running = null;
      if (again) { again = false; syncNow(); }
    }
  })();
  return running;
}

let debounce;
export function start() {
  if (!enabled) return;
  db.onLocalChange(() => { clearTimeout(debounce); debounce = setTimeout(syncNow, 2000); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  window.addEventListener('online', syncNow);
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60_000);
  syncNow();
}
