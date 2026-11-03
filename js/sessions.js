// Sessions screen (iPad app only): practice recordings saved in the app's Documents/Sessions folder.
// The app sends the list through native.js; sharing and deleting go back to the app.
import { el, fill, toast } from './ui.js';
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
    ['With notes', `${recent.filter((x) => x.review).length} of ${recent.length}`],
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

// Notes on a session (from a teacher, Claude, or yourself) arrive as a fenced block:
//   ```woodshed
//   {"woodshed": 1, "session": "session-….json", "by": "optional author", "headline": "…",
//    "breakdown": [{"label": "…", "min": 6}], "findings": ["…"], "next": ["…"]}
//   ```
// Copy the message (or just the block) and tap "Paste notes". Synced notes arrive the same way.
export function parseNotes(text) {
  const fenced = /```\s*woodshed\s*\n([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let n;
  try { n = JSON.parse(raw); } catch { return null; }
  if (!n || n.woodshed !== 1 || typeof n.session !== 'string') return null;
  const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string').map((x) => x.slice(0, 400)).slice(0, 12) : []);
  return {
    woodshed: 1,
    session: n.session,
    by: typeof n.by === 'string' ? n.by.trim().slice(0, 40) : '',
    headline: typeof n.headline === 'string' ? n.headline.slice(0, 300) : '',
    breakdown: (Array.isArray(n.breakdown) ? n.breakdown : [])
      .filter((b) => b && typeof b.label === 'string' && Number.isFinite(b.min) && b.min >= 0)
      .map((b) => ({ label: b.label.slice(0, 120), min: Math.round(b.min * 10) / 10 })).slice(0, 12),
    findings: strs(n.findings),
    next: strs(n.next),
  };
}

function readNotes(x) {
  try { return x.review ? JSON.parse(x.review) : null; } catch { return null; } // unreadable notes are ignored
}

// One line that sums the notes up while the card is closed.
function gist(n) {
  const parts = [];
  const top = [...(n.breakdown || [])].sort((a, b) => b.min - a.min)[0];
  if (top) parts.push(`Most time: ${top.label} (${top.min} min)`);
  const f = (n.findings || []).length, nx = (n.next || []).length;
  if (f) parts.push(`${f} observation${f === 1 ? '' : 's'}`);
  if (nx) parts.push(`${nx} next step${nx === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function review(x, open, toggle) {
  const n = readNotes(x);
  if (!n) return null;
  const total = n.breakdown.reduce((t, b) => t + b.min, 0) || 1;
  const list = (title, items, cls) => (items.length ? el('div', { class: 'review-col' },
    el('h4', { text: title }), el(cls === 'ol' ? 'ol' : 'ul', {}, items.map((t) => el('li', { text: t })))) : null);
  return el('div', { class: 'review' + (open ? ' open' : '') },
    el('button', { class: 'review-head', onclick: toggle },
      el('span', { class: 'review-badge', text: 'Notes' }),
      el('span', { class: 'review-text' },
        el('span', { class: 'review-headline', text: n.headline || 'Session notes' }),
        el('span', { class: 'review-gist muted', text: [n.by ? `From ${n.by}` : '', open ? '' : gist(n)].filter(Boolean).join(' · ') })),
      el('span', { class: 'muted', text: open ? 'Hide' : 'Show' })),
    open ? el('div', { class: 'review-body' },
      n.breakdown.length ? el('div', { class: 'review-col breakdown' },
        el('h4', { text: 'Where the time went' }),
        n.breakdown.map((b) => el('div', { class: 'brow' },
          el('span', { text: b.label }),
          el('div', { class: 'bbar' }, el('i', { style: { width: `${(100 * b.min) / total}%` } })),
          el('b', { text: `${b.min} min` })))) : null,
      list('What stood out', n.findings),
      list('Next session', n.next, 'ol')) : null);
}

export function renderSessions(root, go) {
  const app = native.appBar(el, 'sessions', go);
  const summary = el('div', { class: 'week' });
  const list = el('ul', { class: 'session-list' });
  let delArm = null;
  let tick;
  const opened = new Set();

  window.pastedText = (text) => {
    const n = parseNotes(text || '');
    if (!n) { toast("The clipboard doesn't have session notes. Copy the whole message, or the woodshed block in it."); return; }
    if (!native.recording().sessions.some((x) => x.name === n.session)) { toast(`No session called ${n.session} on this iPad.`); return; }
    opened.add(n.session);
    native.saveNotes(n.session, JSON.stringify(n));
  };
  window.notesSaved = (ok) => toast(ok ? 'Notes added to the session.' : "Couldn't save those notes.");

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
      const toggle = () => { if (opened.has(x.name)) opened.delete(x.name); else opened.add(x.name); draw(); };
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
          } }, delArm === x.name ? 'Tap to confirm' : 'Delete')),
        review(x, opened.has(x.name), toggle));
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
        el('p', { class: 'sub', text: 'Your recordings, with notes from whoever reviewed them.' })),
      el('div', { class: 'head-actions' },
        el('div', { class: 'legend' }, el('span', {}, el('i'), 'Playing'), el('span', {}, el('i', { class: 'sprint' }), 'Chord Sprint')),
        el('button', { onclick: native.paste }, 'Paste notes'))),
    summary,
    empty,
    list));

  const off = native.onRecording(draw);
  draw();
  root._cleanup = () => { clearInterval(tick); off(); app.off(); window.pastedText = null; window.notesSaved = null; };
}
