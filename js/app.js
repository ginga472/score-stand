// Hash router: #/ (library), #/score/<id>[/<page>], #/setlist/<id>
import * as db from './db.js';
import { renderLibrary } from './library.js';
import { openReader } from './reader.js';
import * as sync from './sync.js';

const root = document.getElementById('app');
let cleanup = null;

const go = (hash) => { location.hash = hash; };

async function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  if (root._cleanup) { root._cleanup(); root._cleanup = null; }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const onExit = () => go('#/');
  try {
    if (parts[0] === 'score' && parts[1]) {
      const page = parts[2] ? Number(parts[2]) : undefined;
      cleanup = await openReader(root, { scoreIds: [parts[1]], startPage: page, onExit });
    } else if (parts[0] === 'setlist' && parts[1]) {
      const list = await db.get('setlists', parts[1]);
      if (!list) return go('#/');
      cleanup = await openReader(root, { scoreIds: list.scoreIds, startPage: 1, title: list.name, onExit });
    } else {
      await renderLibrary(root, go);
    }
  } catch (err) {
    console.error(err);
    root.textContent = 'Something went wrong opening that. Go back and try again.';
  }
}

window.addEventListener('hashchange', route);
route();
sync.start();

// The iPad app serves these files itself, so it doesn't need the offline cache.
if ('serviceWorker' in navigator && !window.__pianoApp) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
