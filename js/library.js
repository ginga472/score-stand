// Library: scores, setlists and practice spots.
import * as db from './db.js';
import { loadPdf, makeThumb } from './pdf.js';
import { el, clear, fill, promptForm, confirmBox, toast } from './ui.js';
import * as sync from './sync.js';
import * as native from './native.js';

const MAX_PDF_BYTES = 80 * 1024 * 1024;
let tab = 'scores';
let query = '';
const thumbUrls = new Map();

function thumbUrl(score) {
  if (!score.thumb) return null;
  if (!thumbUrls.has(score.id)) thumbUrls.set(score.id, URL.createObjectURL(score.thumb));
  return thumbUrls.get(score.id);
}

export async function renderLibrary(root, go) {
  const fileInput = el('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, hidden: true, onchange: (e) => importFiles([...e.target.files]) });

  async function importFiles(files) {
    let added = 0;
    for (const f of files) {
      const isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
      if (!isPdf) { toast(`${f.name} isn't a PDF.`); continue; }
      if (f.size > MAX_PDF_BYTES) { toast(`${f.name} is over 80 MB.`); continue; }
      try {
        const pdf = await loadPdf(f);
        const thumb = await makeThumb(pdf);
        await db.addScore({ title: f.name.replace(/\.pdf$/i, ''), blob: f, pageCount: pdf.numPages, thumb });
        pdf.loadingTask.destroy();
        added++;
      } catch (err) {
        console.error(err);
        toast(`Couldn't open ${f.name}.`);
      }
    }
    fileInput.value = '';
    if (added) {
      db.requestPersistence();
      toast(`Added ${added} score${added > 1 ? 's' : ''}.`);
    }
    draw();
  }

  const tabs = [['scores', 'Scores'], ['setlists', 'Setlists'], ['spots', 'Spots']];
  if (native.inApp) tabs.push(['sessions', 'Sessions']);
  const body = el('section', { class: 'lib-body' });
  const tabBar = el('nav', { class: 'tabs' }, tabs.map(([id, label]) =>
    el('button', { class: 'tab', dataset: { tab: id }, onclick: () => { tab = id; draw(); } }, label)));

  const syncBtn = el('button', { class: 'ghost sync-btn', hidden: !sync.enabled, onclick: () => accountDialog() });
  const LABELS = { 'signed-out': 'Sign in to sync', syncing: 'Syncing…', ok: 'Synced ✓', offline: 'Offline', error: 'Sync problem' };
  const showStatus = (st) => {
    syncBtn.textContent = LABELS[st.state] || '';
    syncBtn.classList.toggle('warn', st.state === 'error');
    syncBtn.title = st.message || '';
  };
  showStatus(sync.getStatus());
  const offStatus = sync.onStatus(showStatus);

  // Inside the iPad app: record a practice session, and jump to Chord Sprint.
  const recBtn = el('button', { class: 'ghost rec-btn', hidden: !native.inApp,
    onclick: () => (native.recording().recording ? native.stopRecording() : native.startRecording()) });
  const showRec = (st) => {
    recBtn.textContent = st.recording ? '■ Stop recording' : '● Record session';
    recBtn.classList.toggle('on', st.recording);
  };
  showRec(native.recording());
  const offRec = native.onRecording((st) => { showRec(st); if (tab === 'sessions') draw(); });

  const view = el('div', { class: 'library' },
    el('header', { class: 'lib-head' },
      el('h1', { text: native.inApp ? 'Music' : 'Score Stand' }),
      el('div', { class: 'row' },
        recBtn,
        native.inApp && el('button', { class: 'ghost', onclick: native.openChordSprint }, 'Chord Sprint ›'),
        syncBtn,
        el('button', { class: 'primary', onclick: () => fileInput.click() }, '+ Import PDF')),
      fileInput),
    tabBar,
    body);
  fill(root, view);

  // Drag and drop on the Mac.
  view.addEventListener('dragover', (e) => { e.preventDefault(); view.classList.add('dropping'); });
  view.addEventListener('dragleave', () => view.classList.remove('dropping'));
  view.addEventListener('drop', (e) => {
    e.preventDefault();
    view.classList.remove('dropping');
    importFiles([...e.dataTransfer.files]);
  });

  // Draws are async; a slow one finishing late must not overwrite a newer tab.
  let drawSeq = 0;
  const stale = (seq) => seq !== drawSeq;
  async function draw() {
    const seq = ++drawSeq;
    for (const b of tabBar.children) b.classList.toggle('on', b.dataset.tab === tab);
    if (tab === 'scores') await drawScores(seq);
    else if (tab === 'setlists') await drawSetlists(seq);
    else if (tab === 'spots') await drawSpots(seq);
    else drawSessions();
  }

  async function drawScores(seq = ++drawSeq) {
    const scores = await db.getAll('scores');
    const q = query.toLowerCase();
    const shown = scores
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.tags.some((t) => t.toLowerCase().includes(q)))
      .sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));

    const search = el('input', { type: 'search', class: 'search', placeholder: 'Search titles and tags', value: query,
      oninput: (e) => { query = e.target.value; drawScoresDebounced(); } });

    if (stale(seq)) return;
    fill(body,
      search,
      scores.length ? null : el('div', { class: 'empty' },
        el('p', { text: 'No scores yet.' }),
        el('p', { class: 'muted', text: 'Tap "Import PDF", or on the Mac drag PDFs onto this window. On iPad you can also pick files straight from iCloud Drive.' })),
      el('div', { class: 'grid' }, shown.map((s) =>
        el('article', { class: 'card' },
          el('button', { class: 'thumb', onclick: () => go(`#/score/${s.id}`), title: `Open ${s.title}` },
            thumbUrl(s) ? el('img', { src: thumbUrl(s), alt: '' }) : el('span', { text: '♪' })),
          el('div', { class: 'card-meta' },
            el('strong', { text: s.title }),
            el('span', { class: 'muted', text: `${s.pageCount} page${s.pageCount > 1 ? 's' : ''}${s.lastPage > 1 ? ` · on p.${s.lastPage}` : ''}` }),
            s.tags.length ? el('div', { class: 'tags' }, s.tags.map((t) => el('span', { class: 'tag', text: t }))) : null),
          el('div', { class: 'card-actions' },
            el('button', { class: 'ghost small', onclick: () => editScore(s) }, 'Edit'),
            el('button', { class: 'ghost small', onclick: () => addToSetlist(s) }, '+ Setlist'))))));
    if (query) {
      search.focus({ preventScroll: true });
      search.setSelectionRange(query.length, query.length);
    }
  }

  let t;
  function drawScoresDebounced() { clearTimeout(t); t = setTimeout(drawScores, 120); }

  async function editScore(s) {
    const v = await promptForm('Edit score', [
      { name: 'title', label: 'Title', value: s.title },
      { name: 'tags', label: 'Tags (comma separated)', value: s.tags.join(', '), placeholder: 'e.g. Einaudi, learning, warm-up' },
      { name: 'del', label: 'Type "delete" to remove this score and its markup', value: '' },
    ]);
    if (!v) return;
    if (v.del.toLowerCase() === 'delete') {
      await db.deleteScore(s.id);
      toast('Score deleted.');
    } else {
      s.title = v.title || s.title;
      s.tags = v.tags.split(',').map((x) => x.trim()).filter(Boolean);
      await db.put('scores', s);
    }
    draw();
  }

  async function addToSetlist(s) {
    const lists = await db.getAll('setlists');
    const v = await promptForm(`Add "${s.title}" to a setlist`, [
      { name: 'name', label: lists.length ? `Setlist name (existing: ${lists.map((l) => l.name).join(', ')})` : 'New setlist name', value: lists[0]?.name || '' },
    ], { submit: 'Add' });
    if (!v?.name) return;
    let list = lists.find((l) => l.name.toLowerCase() === v.name.toLowerCase());
    if (!list) list = { id: db.uid(), name: v.name, scoreIds: [], createdAt: Date.now() };
    if (!list.scoreIds.includes(s.id)) list.scoreIds.push(s.id);
    await db.put('setlists', list);
    toast(`Added to ${list.name}.`);
  }

  async function drawSetlists(seq = ++drawSeq) {
    const lists = (await db.getAll('setlists')).sort((a, b) => b.createdAt - a.createdAt);
    const scores = new Map((await db.getAll('scores')).map((s) => [s.id, s]));
    if (stale(seq)) return;
    fill(body,
      el('div', { class: 'row between' },
        el('p', { class: 'muted', text: 'A setlist plays scores back to back: turning past the last page opens the next score.' }),
        el('button', { class: 'ghost', onclick: newSetlist }, '+ New setlist')),
      lists.length ? null : el('p', { class: 'empty muted', text: 'No setlists yet. Use "+ Setlist" on any score.' }),
      lists.map((l) =>
        el('article', { class: 'setlist' },
          el('div', { class: 'row between' },
            el('h3', { text: l.name }),
            el('div', { class: 'row' },
              el('button', { class: 'primary small', disabled: !l.scoreIds.length, onclick: () => go(`#/setlist/${l.id}`) }, 'Play'),
              el('button', { class: 'ghost small', onclick: () => renameSetlist(l) }, 'Rename'),
              el('button', { class: 'ghost small', onclick: async () => { if (await confirmBox(`Delete setlist "${l.name}"? Scores stay in your library.`)) { await db.del('setlists', l.id); draw(); } } }, 'Delete'))),
          el('ol', { class: 'set-items' }, l.scoreIds.map((id, i) =>
            el('li', {},
              el('span', { text: scores.get(id)?.title || '(missing)' }),
              el('span', { class: 'row' },
                el('button', { class: 'ghost small', title: 'Move up', disabled: i === 0, onclick: () => move(l, i, -1) }, '↑'),
                el('button', { class: 'ghost small', title: 'Move down', disabled: i === l.scoreIds.length - 1, onclick: () => move(l, i, 1) }, '↓'),
                el('button', { class: 'ghost small', title: 'Remove', onclick: () => { l.scoreIds.splice(i, 1); db.put('setlists', l).then(draw); } }, '✕'))))))));
  }

  async function newSetlist() {
    const v = await promptForm('New setlist', [{ name: 'name', label: 'Name', placeholder: 'e.g. Sunday practice' }], { submit: 'Create' });
    if (!v?.name) return;
    await db.put('setlists', { id: db.uid(), name: v.name, scoreIds: [], createdAt: Date.now() });
    draw();
  }

  async function renameSetlist(l) {
    const v = await promptForm('Rename setlist', [{ name: 'name', label: 'Name', value: l.name }]);
    if (!v?.name) return;
    l.name = v.name;
    await db.put('setlists', l);
    draw();
  }

  async function move(l, i, d) {
    const [x] = l.scoreIds.splice(i, 1);
    l.scoreIds.splice(i + d, 0, x);
    await db.put('setlists', l);
    draw();
  }

  async function drawSpots(seq = ++drawSeq) {
    const spots = await db.getAll('spots');
    const scores = new Map((await db.getAll('scores')).map((s) => [s.id, s]));
    const groups = new Map();
    for (const sp of spots.sort((a, b) => a.page - b.page)) {
      if (!groups.has(sp.scoreId)) groups.set(sp.scoreId, []);
      groups.get(sp.scoreId).push(sp);
    }
    if (stale(seq)) return;
    fill(body,
      el('p', { class: 'muted', text: 'Two-bar spots, one goal each. Add them from the ◎ button while reading.' }),
      groups.size ? null : el('p', { class: 'empty muted', text: 'No spots yet.' }),
      [...groups].map(([sid, list]) =>
        el('article', { class: 'setlist' },
          el('h3', { text: scores.get(sid)?.title || '(missing score)' }),
          el('ul', { class: 'spot-list' }, list.map((sp) =>
            el('li', {},
              el('button', { class: 'spot-jump', onclick: () => go(`#/score/${sid}/${sp.page}`) },
                el('strong', { text: sp.label }),
                el('span', { class: 'muted', text: ` p.${sp.page}${sp.tempo ? ` · ♩=${sp.tempo}` : ''}` }),
                sp.goal ? el('div', { class: 'goal', text: sp.goal }) : null)))))));
  }

  // Practice recordings live in the app's Documents/Sessions folder; the app sends the list.
  let delArm = null;
  let tick;
  function drawSessions() {
    clearInterval(tick);
    const st = native.recording();
    const clock = (ms) => { const s = Math.round(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    const now = el('strong', { class: 'rec-clock' });
    if (st.recording) {
      const upd = () => { if (!root.contains(now)) return clearInterval(tick); now.textContent = clock(Date.now() - st.startedMs); };
      upd();
      tick = setInterval(upd, 1000);
    }
    const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    fill(body,
      el('article', { class: 'setlist rec-panel' + (st.recording ? ' live' : '') },
        el('div', { class: 'row between' },
          st.recording
            ? el('div', {}, el('span', { class: 'rec-dot' }), el('span', { text: ' Recording ' }), now)
            : el('p', { class: 'muted', text: 'Records every note you play on the piano, on any screen, until you stop. Stops by itself after 20 quiet minutes.' }),
          st.recording
            ? el('button', { class: 'danger', onclick: native.stopRecording }, '■ Stop & save')
            : el('button', { class: 'primary', onclick: native.startRecording }, '● Start recording'))),
      st.sessions.length ? null : el('p', { class: 'empty muted', text: 'No saved sessions yet.' }),
      st.sessions.length ? el('p', { class: 'muted', text: 'Share a session to the Claude app to get a practice summary. They are also in the Files app under On My iPad › Woodshed › Sessions.' }) : null,
      el('ul', { class: 'session-list' }, st.sessions.map((x) => {
        const active = x.durationMs ? Math.round((100 * x.playingMs) / x.durationMs) : 0;
        const what = [...(x.pieces || [])];
        if (x.sprintRounds) what.push(`Chord Sprint × ${x.sprintRounds}`);
        return el('li', { class: 'setlist session' },
          el('div', { class: 'session-meta' },
            el('strong', { text: when(x.started) }),
            el('span', { class: 'muted', text: `${clock(x.durationMs)} long · ${clock(x.playingMs)} playing (${active}%) · ${x.notes} notes` }),
            what.length ? el('div', { class: 'tags' }, what.map((t) => el('span', { class: 'tag', text: t }))) : null),
          el('div', { class: 'row' },
            el('button', { class: 'ghost small', onclick: () => native.shareSession(x.name) }, 'Share'),
            el('button', { class: 'ghost small' + (delArm === x.name ? ' warn' : ''), onclick: () => {
              if (delArm === x.name) { delArm = null; native.deleteSession(x.name); } else { delArm = x.name; drawSessions(); }
            } }, delArm === x.name ? 'Tap to confirm' : 'Delete')));
      })));
  }

  async function accountDialog() {
    const user = await sync.currentUser();
    if (!user) return signIn();
    const st = sync.getStatus();
    const v = await promptForm(`Signed in as ${user.email}`, [
      { name: 'out', label: st.state === 'error' ? `Last sync failed: ${st.message || 'unknown error'}. Type "sign out" to sign out.` : 'Type "sign out" to sign out of this device', value: '' },
    ], { submit: 'Sync now' });
    if (!v) return;
    if (v.out.toLowerCase() === 'sign out') { await sync.signOut(); toast('Signed out. Your scores stay on this device.'); return; }
    await sync.syncNow();
  }

  async function signIn() {
    const v = await promptForm('Sign in to sync', [
      { name: 'email', label: 'Email', type: 'email', autocomplete: 'username', placeholder: 'you@example.com' },
      { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' },
    ], { submit: 'Sign in' });
    if (!v?.email || !v.password) return;
    try {
      await sync.signInWithPassword(v.email, v.password);
      toast('Signed in. Syncing your library…');
    } catch (e) {
      toast(e.message);
    }
  }

  // Redraw when another device's changes arrive; stop listening once we leave.
  const redraw = () => { if (root.contains(view)) draw(); else sync.offRemoteChange(redraw); };
  sync.onRemoteChange(redraw);
  root._cleanup = () => { clearInterval(tick); offStatus(); offRec(); sync.offRemoteChange(redraw); };

  draw();
}
