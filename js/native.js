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
