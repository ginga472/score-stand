// The reader: shows one score (or a setlist of scores) full screen.
// Two pages side by side in landscape, one in portrait. Page turns from a
// Bluetooth pedal (pedals send arrow / page keys), keyboard, or taps on the
// left and right thirds of the screen.
import * as db from './db.js';
import { loadPdf, renderPage } from './pdf.js';
import { attachInk, drawStrokes } from './ink.js';
import { el, clear, fill, promptForm, toast } from './ui.js';

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter']);
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']);
const COLORS = [
  ['#d22', 'Red'],
  ['#1660d6', 'Blue'],
  ['#111', 'Black'],
];

const prefs = loadPrefs();
function loadPrefs() {
  try {
    return { halfTurn: false, pencilOnly: true, ...JSON.parse(localStorage.getItem('reader-prefs') || '{}') };
  } catch {
    return { halfTurn: false, pencilOnly: true };
  }
}
function savePrefs() {
  try { localStorage.setItem('reader-prefs', JSON.stringify(prefs)); } catch {}
}

export async function openReader(root, { scoreIds, startIndex = 0, startPage, title, onExit }) {
  const scores = (await Promise.all(scoreIds.map((id) => db.get('scores', id)))).filter(Boolean);
  if (!scores.length) {
    toast('That score is no longer in your library.');
    onExit();
    return () => {};
  }

  const docs = new Map();
  async function docFor(score) {
    if (!docs.has(score.id)) {
      const file = await db.get('files', score.id);
      docs.set(score.id, loadPdf(file.blob));
    }
    return docs.get(score.id);
  }

  const state = {
    idx: Math.min(startIndex, scores.length - 1),
    page: 1,
    half: false, // showing top of next page over bottom of this one
    ink: { enabled: false, tool: 'pen', color: COLORS[0][0], width: 0.004, pencilOnly: prefs.pencilOnly },
    chrome: true,
  };
  state.page = startPage || scores[state.idx].lastPage || 1;

  // Per-page ink, loaded on demand, plus an undo stack per page.
  const inkCache = new Map();
  const undo = new Map();
  const inkKey = (sid, p) => `${sid}:${p}`;
  async function inkFor(sid, p) {
    const k = inkKey(sid, p);
    if (!inkCache.has(k)) inkCache.set(k, await db.getInk(sid, p));
    return inkCache.get(k);
  }

  // ---- DOM ----
  const pageLabel = el('span', { class: 'page-label' });
  const titleLabel = el('span', { class: 'title-label' });
  const halfBtn = el('button', { class: 'tool', title: 'Half-page turns', onclick: () => { prefs.halfTurn = !prefs.halfTurn; savePrefs(); state.half = false; render(); } }, '½');
  const penBtn = el('button', { class: 'tool', title: 'Markup', onclick: () => { state.ink.enabled = !state.ink.enabled; state.half = false; render(); } }, '✎');
  const spotBtn = el('button', { class: 'tool', title: 'Practice spots', onclick: () => toggleSpots() }, '◎');

  const topbar = el('header', { class: 'reader-bar' },
    el('button', { class: 'tool', title: 'Library', onclick: () => onExit() }, '‹ Library'),
    el('div', { class: 'reader-title' }, titleLabel, pageLabel),
    el('div', { class: 'row' }, halfBtn, spotBtn, penBtn));

  const swatches = COLORS.map(([c, name]) =>
    el('button', { class: 'swatch', title: name, dataset: { color: c }, onclick: () => { state.ink.tool = 'pen'; state.ink.color = c; syncInkBar(); } }));
  const hlBtn = el('button', { class: 'tool', title: 'Highlighter', onclick: () => { state.ink.tool = 'hl'; state.ink.color = '#ffd400'; syncInkBar(); } }, 'HL');
  const eraseBtn = el('button', { class: 'tool', title: 'Eraser', onclick: () => { state.ink.tool = 'erase'; syncInkBar(); } }, 'Erase');
  const undoBtn = el('button', { class: 'tool', title: 'Undo', onclick: () => doUndo() }, 'Undo');
  const pencilBtn = el('button', { class: 'tool', title: 'Only the Pencil draws; fingers still turn pages', onclick: () => { state.ink.pencilOnly = prefs.pencilOnly = !prefs.pencilOnly; savePrefs(); syncInkBar(); } }, 'Pencil only');
  const widthInput = el('input', { type: 'range', min: '0.002', max: '0.012', step: '0.001', value: String(state.ink.width), title: 'Pen width', oninput: (e) => { state.ink.width = Number(e.target.value); } });
  const inkbar = el('div', { class: 'ink-bar' }, swatches, hlBtn, eraseBtn, widthInput, undoBtn, pencilBtn);

  const stage = el('main', { class: 'stage' });
  const spotsPanel = el('aside', { class: 'spots-panel', hidden: true });
  const view = el('div', { class: 'reader' }, topbar, inkbar, stage, spotsPanel);
  fill(root, view);

  function syncInkBar() {
    for (const s of swatches) s.classList.toggle('on', state.ink.tool === 'pen' && state.ink.color === s.dataset.color);
    hlBtn.classList.toggle('on', state.ink.tool === 'hl');
    eraseBtn.classList.toggle('on', state.ink.tool === 'erase');
    pencilBtn.classList.toggle('on', state.ink.pencilOnly);
  }
  syncInkBar();

  // ---- layout ----
  const score = () => scores[state.idx];
  const twoUp = () => !prefs.halfTurn && stage.clientWidth > stage.clientHeight * 1.15;
  const step = () => (twoUp() ? 2 : 1);

  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    const s = score();
    const pdf = await docFor(s);
    if (seq !== renderSeq) return;
    state.page = Math.max(1, Math.min(state.page, pdf.numPages));
    if (state.half && state.page >= pdf.numPages) state.half = false;

    view.classList.toggle('chrome-hidden', !state.chrome && !state.ink.enabled);
    halfBtn.classList.toggle('on', prefs.halfTurn);
    penBtn.classList.toggle('on', state.ink.enabled);
    inkbar.hidden = !state.ink.enabled;
    titleLabel.textContent = scores.length > 1 ? `${title || 'Setlist'} · ${s.title} (${state.idx + 1}/${scores.length})` : s.title;

    const W = stage.clientWidth;
    const H = stage.clientHeight;
    const frag = document.createDocumentFragment();
    const jobs = [];

    if (state.half) {
      // forScore-style half turn: top half shows the next page, bottom half
      // still shows the end of the current one.
      const wrap = el('div', { class: 'half-wrap' });
      const top = makeSlot(s, state.page + 1, W, H, 'top');
      const bottom = makeSlot(s, state.page, W, H, 'bottom');
      wrap.append(bottom.node, top.node);
      frag.append(wrap);
      jobs.push(top.job, bottom.job);
      pageLabel.textContent = `${state.page}–${state.page + 1} / ${pdf.numPages}`;
    } else if (twoUp() && state.page < pdf.numPages) {
      const a = makeSlot(s, state.page, W / 2, H);
      const b = makeSlot(s, state.page + 1, W / 2, H);
      frag.append(a.node, b.node);
      jobs.push(a.job, b.job);
      pageLabel.textContent = `${state.page}–${state.page + 1} / ${pdf.numPages}`;
    } else {
      const a = makeSlot(s, state.page, W, H);
      frag.append(a.node);
      jobs.push(a.job);
      pageLabel.textContent = `${state.page} / ${pdf.numPages}`;
    }

    fill(stage, frag);
    await Promise.all(jobs.map((j) => j()));
    if (seq !== renderSeq) return;
    s.lastPage = state.page;
    s.openedAt = Date.now();
    db.put('scores', s);
    if (!spotsPanel.hidden) renderSpots();
  }

  function makeSlot(s, pageNum, w, h, half) {
    const pdfCanvas = el('canvas', { class: 'pdf' });
    const inkCanvas = el('canvas', { class: 'ink' });
    const node = el('div', { class: 'page-slot' + (half ? ` half-${half}` : '') }, el('div', { class: 'page' }, pdfCanvas, inkCanvas));
    let size = { width: 0, height: 0 };
    const job = async () => {
      const pdf = await docFor(s);
      size = await renderPage(pdf, pageNum, pdfCanvas, w - 8, h - 8);
      const strokes = await inkFor(s.id, pageNum);
      drawStrokes(inkCanvas, strokes, size.width, size.height);
      if (half) {
        // Clip with CSSOM (allowed under our CSP) rather than inline style attributes.
        node.style.clipPath = half === 'top' ? 'inset(0 0 50% 0)' : 'inset(50% 0 0 0)';
        return;
      }
      inkCanvas.classList.toggle('live', state.ink.enabled);
      if (state.ink.enabled) {
        attachInk(inkCanvas, {
          size: () => size,
          getState: () => state.ink,
          getStrokes: () => inkCache.get(inkKey(s.id, pageNum)) || [],
          onChange: (next) => {
            const k = inkKey(s.id, pageNum);
            const hist = undo.get(k) || [];
            hist.push(inkCache.get(k) || []);
            undo.set(k, hist.slice(-50));
            inkCache.set(k, next);
            lastInkPage = { sid: s.id, page: pageNum, canvas: inkCanvas, size };
            drawStrokes(inkCanvas, next, size.width, size.height);
            db.saveInk(s.id, pageNum, next);
          },
        });
      }
    };
    return { node, job };
  }

  let lastInkPage = null;
  function doUndo() {
    if (!lastInkPage) return;
    const { sid, page, canvas, size } = lastInkPage;
    const k = inkKey(sid, page);
    const hist = undo.get(k);
    if (!hist?.length) return;
    const prev = hist.pop();
    inkCache.set(k, prev);
    drawStrokes(canvas, prev, size.width, size.height);
    db.saveInk(sid, page, prev);
  }

  // ---- navigation ----
  async function next() {
    const pdf = await docFor(score());
    if (prefs.halfTurn && !state.half && state.page < pdf.numPages) {
      state.half = true;
    } else if (state.half) {
      state.half = false;
      state.page += 1;
    } else if (state.page + step() <= pdf.numPages) {
      state.page += step();
    } else if (state.idx < scores.length - 1) {
      state.idx += 1;
      state.page = 1;
    } else {
      flash('End');
      return;
    }
    render();
  }

  async function prev() {
    if (state.half) {
      state.half = false;
    } else if (prefs.halfTurn && state.page > 1) {
      state.page -= 1;
      state.half = true;
    } else if (state.page > 1) {
      state.page = Math.max(1, state.page - step());
    } else if (state.idx > 0) {
      state.idx -= 1;
      const pdf = await docFor(score());
      state.page = twoUp() ? Math.max(1, pdf.numPages - 1) : pdf.numPages;
    } else {
      flash('Start');
      return;
    }
    render();
  }

  function flash(msg) {
    const f = el('div', { class: 'edge-flash', text: msg });
    stage.append(f);
    setTimeout(() => f.remove(), 700);
  }

  function onKey(e) {
    if (e.target.closest('input, textarea, dialog')) return;
    if (NEXT_KEYS.has(e.key)) { e.preventDefault(); next(); }
    else if (PREV_KEYS.has(e.key)) { e.preventDefault(); prev(); }
    else if (e.key === 'Escape') { if (!spotsPanel.hidden) toggleSpots(); else onExit(); }
  }

  function onTap(e) {
    if (!spotsPanel.hidden) { toggleSpots(); return; }
    if (e.target.closest('.ink.live') && !(state.ink.pencilOnly && lastPointer === 'touch')) return;
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (x < 0.33) prev();
    else if (x > 0.67) next();
    else { state.chrome = !state.chrome; view.classList.toggle('chrome-hidden', !state.chrome && !state.ink.enabled); }
  }

  // Safari's click events don't always say what made them, so remember the last pointer.
  let lastPointer = 'mouse';
  stage.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; }, true);
  stage.addEventListener('click', onTap);
  document.addEventListener('keydown', onKey);
  let resizeTimer;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); };
  window.addEventListener('resize', onResize);

  // ---- practice spots ----
  function toggleSpots() {
    spotsPanel.hidden = !spotsPanel.hidden;
    spotBtn.classList.toggle('on', !spotsPanel.hidden);
    if (!spotsPanel.hidden) renderSpots();
  }

  async function renderSpots() {
    const s = score();
    const spots = (await db.byIndex('spots', 'scoreId', s.id)).sort((a, b) => a.page - b.page);
    fill(spotsPanel, 
      el('div', { class: 'row between' },
        el('h3', { text: 'Practice spots' }),
        el('div', { class: 'row' },
          el('button', { class: 'primary small', onclick: addSpot, text: `+ Page ${state.page}` }),
          el('button', { class: 'ghost small', title: 'Close', onclick: () => toggleSpots(), text: '✕' }))),
      spots.length ? null : el('p', { class: 'muted', text: 'Mark the tricky bars on this page so you can jump straight back to them.' }),
      el('ul', { class: 'spot-list' }, spots.map((sp) =>
        el('li', { class: sp.page === state.page ? 'here' : '' },
          el('button', { class: 'spot-jump', onclick: () => { state.page = sp.page; state.half = false; render(); } },
            el('strong', { text: sp.label }),
            el('span', { class: 'muted', text: ` p.${sp.page}${sp.tempo ? ` · ♩=${sp.tempo}` : ''}` }),
            sp.goal ? el('div', { class: 'goal', text: sp.goal }) : null),
          el('button', { class: 'ghost small', title: 'Edit', onclick: () => editSpot(sp) }, 'Edit')))));
  }

  async function addSpot() {
    const v = await promptForm(`New spot on page ${state.page}`, [
      { name: 'label', label: 'Name', placeholder: 'e.g. Bars 9–10 LH jump' },
      { name: 'goal', label: 'One goal', placeholder: 'e.g. Loose wrist on the leap' },
      { name: 'tempo', label: 'Target tempo (♩=)', type: 'number', inputmode: 'numeric' },
    ]);
    if (!v) return;
    await db.put('spots', { id: db.uid(), scoreId: score().id, page: state.page, label: v.label || `Page ${state.page}`, goal: v.goal, tempo: v.tempo ? Number(v.tempo) : null, createdAt: Date.now() });
    renderSpots();
  }

  async function editSpot(sp) {
    const v = await promptForm('Edit spot', [
      { name: 'label', label: 'Name', value: sp.label },
      { name: 'goal', label: 'One goal', value: sp.goal },
      { name: 'tempo', label: 'Target tempo (♩=)', type: 'number', value: sp.tempo ?? '', inputmode: 'numeric' },
      { name: 'del', label: 'Type "delete" to remove this spot', value: '' },
    ]);
    if (!v) return;
    if (v.del.toLowerCase() === 'delete') await db.del('spots', sp.id);
    else await db.put('spots', { ...sp, label: v.label || sp.label, goal: v.goal, tempo: v.tempo ? Number(v.tempo) : null });
    renderSpots();
  }

  await render();

  // Cleanup when leaving the reader.
  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    for (const p of docs.values()) p.then((d) => d.loadingTask.destroy()).catch(() => {});
  };
}
