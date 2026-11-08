// Bridge to the Woodshed iPad app, which bundles Score Stand next to Chord Sprint.
// In a browser none of this exists and every call is a no-op.
export const inApp = !!window.__pianoApp;

function post(handler, body) {
  try { window.webkit.messageHandlers[handler].postMessage(body); } catch { /* not in the app */ }
}

export const openChordSprint = () => post('nav', { to: 'sprint' });

// Practice-session recording runs in the app (it hears the piano over USB).
let state = { recording: false, paused: false, activeMs: 0, at: 0, startedMs: 0, sessions: [] };
const listeners = new Set();
window.sessionState = (st) => {
  state = { recording: !!st.recording, paused: !!st.paused, activeMs: st.activeMs || 0, at: Date.now(),
    startedMs: st.startedMs || 0, sessions: st.sessions || state.sessions };
  listeners.forEach((fn) => fn(state));
};
export const recording = () => state;
// Recorded time so far, not counting pauses (frozen while paused).
export const activeMs = () => state.activeMs + (state.recording && !state.paused ? Date.now() - state.at : 0);
export function onRecording(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// Tells a running recording what's on screen (score and page), for the practice summary.
export const mark = (marker) => { if (state.recording) post('session', { cmd: 'marker', ...marker }); };
export const startRecording = () => post('session', { cmd: 'start' });
export const stopRecording = () => post('session', { cmd: 'stop' });
export const shareSession = (name) => post('session', { cmd: 'share', name });
export const deleteSession = (name) => post('session', { cmd: 'delete', name });
export const saveNotes = (name, text) => post('session', { cmd: 'notes', name, text });
// A saved session's file contents (null if it's gone), for uploading.
const reads = new Map();
window.sessionFile = (name, text) => { reads.get(name)?.(text); reads.delete(name); };
export function readSession(name) {
  return new Promise((resolve) => {
    reads.set(name, resolve);
    post('session', { cmd: 'read', name });
    setTimeout(() => { if (reads.get(name) === resolve) { reads.delete(name); resolve(null); } }, 10_000);
  });
}
// Asks the app for the clipboard; the text comes back through window.pastedText.
export const paste = () => post('session', { cmd: 'paste' });
if (inApp) post('session', { cmd: 'list' });

// Metronome and plan blocks (js/practice.js, loaded before this module). Null outside the app.
const practiceApi = () => (inApp ? window.WoodshedPractice || null : null);
export const metronomeButton = () => practiceApi()?.button() || null;
export const practice = () => practiceApi()?.state || { metronome: { on: false }, plan: null };
export const onPractice = (fn) => practiceApi()?.onChange(fn) || (() => {});
export const startPlan = (block) => practiceApi()?.startPlan(block);
export const endPlan = (reason) => practiceApi()?.endPlan(reason);

// The bar at the top of every screen: the app's name, where you are, and the one Record button.
// While recording, the red pill at the bottom of the screen is the stop control instead.
// Outside the app (the Score Stand website) it shows just the name and whatever `end` holds.
export function appBar(el, current, go, end = []) {
  const dest = [['music', 'Music', () => go('#/')], ['sprint', 'Chord Sprint', openChordSprint], ['sessions', 'Sessions', () => go('#/sessions')]];
  const rec = inApp ? el('button', { class: 'rec-btn', onclick: startRecording }, 'Record') : null;
  const met = metronomeButton();
  const show = (st) => { if (rec) rec.hidden = st.recording; };
  show(state);
  const offRec = onRecording(show);
  const off = () => { offRec(); met?._off?.(); };
  const bar = el('header', { class: 'appbar' },
    el('div', { class: 'brand' },
      el('img', { src: inApp ? 'icons/woodshed-mark.png' : 'icons/icon-192.png', alt: '' }),
      el('span', { text: inApp ? 'Woodshed' : 'Score Stand' })),
    inApp ? el('nav', { class: 'switch', 'aria-label': 'Screens' }, dest.map(([id, label, open]) =>
      el('button', { class: id === current ? 'on' : null, 'aria-current': id === current ? 'page' : null, onclick: id === current ? null : open }, label))) : null,
    el('div', { class: 'appbar-end' }, end, met, rec));
  return { bar, off };
}
