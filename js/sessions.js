// Sessions screen (iPad app only): practice recordings saved in the app's Documents/Sessions folder.
// The app sends the list through native.js; sharing and deleting go back to the app.
import { el, fill } from './ui.js';
import * as native from './native.js';

const clock = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const minutes = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
};
const when = (ms) => {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
};

// Totals for the last 7 days.
function week(sessions) {
  const since = Date.now() - 7 * 864e5;
  const recent = sessions.filter((x) => x.started >= since);
  const byPiece = new Map();
  for (const x of recent) for (const p of x.pieces || []) byPiece.set(p, (byPiece.get(p) || 0) + 1);
  const top = [...byPiece].sort((a, b) => b[1] - a[1])[0];
  return [
    ['Last 7 days', `${recent.length} session${recent.length === 1 ? '' : 's'}`],
    ['Playing time', minutes(recent.reduce((t, x) => t + x.playingMs, 0))],
    ['Chord Sprint', `${recent.reduce((t, x) => t + (x.sprintRounds || 0), 0)} rounds`],
    ['Most practiced', top ? top[0] : '–', 'small'],
  ];
}

// One bar per session: amber where you played, sunset where it was Chord Sprint.
function timeline(x) {
  const pct = (f) => `${(f * 100).toFixed(1)}%`;
  const bar = (cls) => ([a, b]) => el('i', { class: cls, style: { left: pct(a), width: pct(Math.max(0.004, b - a)) } });
  return el('div', { class: 'timeline', title: 'When you were playing' },
    (x.playing || []).map(bar(null)), (x.sprint || []).map(bar('sprint')));
}

export function renderSessions(root, go) {
  const app = native.appBar(el, 'sessions', go);
  const summary = el('div', { class: 'week' });
  const list = el('ul', { class: 'session-list' });
  let delArm = null;
  let tick;

  function draw() {
    clearInterval(tick);
    const st = native.recording();
    fill(summary, week(st.sessions).map(([k, v, cls]) => el('div', {}, el('span', { text: k }), el('b', { class: cls, text: v }))));
    summary.hidden = !st.sessions.length;
    const live = st.recording ? el('li', { class: 'session live' },
      el('div', { class: 'session-meta' },
        el('strong', {}, el('span', { class: 'rec-dot' }), ' Recording now'),
        el('span', { class: 'muted rec-clock' })),
      el('span', { class: 'muted', text: 'Every note is being saved, on every screen.' }),
      el('span', { class: 'muted', text: 'Tap the red bar to stop' })) : null;
    if (live) {
      const upd = () => { live.querySelector('.rec-clock').textContent = clock(Date.now() - st.startedMs); };
      upd();
      tick = setInterval(upd, 1000);
    }
    fill(list, live, st.sessions.map((x) => {
      const what = [...(x.pieces || [])];
      if (x.sprintRounds) what.push(`Chord Sprint × ${x.sprintRounds}`);
      return el('li', { class: 'session' },
        el('div', { class: 'session-meta' },
          el('strong', { text: when(x.started) }),
          el('span', { class: 'muted', text: `${minutes(x.durationMs)} · ${minutes(x.playingMs)} playing · ${x.notes} notes` })),
        el('div', {},
          timeline(x),
          what.length ? el('div', { class: 'tags' }, what.map((t) => el('span', { class: 'tag', text: t }))) : null),
        el('div', { class: 'row' },
          el('button', { onclick: () => native.shareSession(x.name) }, 'Share'),
          el('button', { class: 'ghost' + (delArm === x.name ? ' warn' : ''), onclick: () => {
            if (delArm === x.name) { delArm = null; native.deleteSession(x.name); } else { delArm = x.name; draw(); }
          } }, delArm === x.name ? 'Tap to confirm' : 'Delete')));
    }));
    empty.hidden = !!(st.sessions.length || st.recording);
  }

  const empty = el('div', { class: 'empty' },
    el('p', { text: 'No sessions yet.' }),
    el('p', { class: 'muted', text: 'Tap Record before you practice. Every note you play is saved, on any screen, until you stop or go 20 minutes without playing.' }));

  fill(root, el('div', { class: 'library' },
    app.bar,
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { text: 'Sessions' }),
        el('p', { class: 'sub', text: 'Share a session with Claude for a practice summary.' })),
      el('div', { class: 'legend' }, el('span', {}, el('i'), 'Playing'), el('span', {}, el('i', { class: 'sprint' }), 'Chord Sprint'))),
    summary,
    empty,
    list));

  const off = native.onRecording(draw);
  draw();
  root._cleanup = () => { clearInterval(tick); off(); app.off(); };
}
