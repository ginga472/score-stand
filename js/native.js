// Bridge to the Woodshed iPad app, which bundles Score Stand next to Chord Sprint.
// In a browser none of this exists and every call is a no-op.
export const inApp = !!window.__pianoApp;

function post(handler, body) {
  try { window.webkit.messageHandlers[handler].postMessage(body); } catch { /* not in the app */ }
}

export const openChordSprint = () => post('nav', { to: 'sprint' });

// Practice-session recording runs in the app (it hears the piano over USB).
let state = { recording: false, startedMs: 0, sessions: [] };
const listeners = new Set();
window.sessionState = (st) => {
  state = { recording: !!st.recording, startedMs: st.startedMs || 0, sessions: st.sessions || state.sessions };
  listeners.forEach((fn) => fn(state));
};
export const recording = () => state;
export function onRecording(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// Tells a running recording what's on screen (score and page), for the practice summary.
export const mark = (marker) => { if (state.recording) post('session', { cmd: 'marker', ...marker }); };
export const startRecording = () => post('session', { cmd: 'start' });
export const stopRecording = () => post('session', { cmd: 'stop' });
export const shareSession = (name) => post('session', { cmd: 'share', name });
export const deleteSession = (name) => post('session', { cmd: 'delete', name });
if (inApp) post('session', { cmd: 'list' });

// The bar at the top of every screen in the app: where you are, and the one Record button.
// While recording, the red pill at the bottom of the screen is the stop control instead.
export function appBar(el, current, go) {
  const dest = [['music', 'Music', () => go('#/')], ['sprint', 'Chord Sprint', openChordSprint], ['sessions', 'Sessions', () => go('#/sessions')]];
  const rec = el('button', { class: 'ghost rec-btn', onclick: startRecording }, '● Record');
  const show = (st) => { rec.hidden = st.recording; };
  show(state);
  const off = onRecording(show);
  const bar = el('div', { class: 'app-bar' },
    el('nav', { class: 'switch', 'aria-label': 'Screens' }, dest.map(([id, label, open]) =>
      el('button', { class: id === current ? 'on' : null, 'aria-current': id === current ? 'page' : null, onclick: id === current ? null : open }, label))),
    rec);
  return { bar, off };
}
