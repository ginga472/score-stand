// Sessions screen (iPad app only): practice recordings saved in the app's Documents/Sessions folder.
// The app sends the list through native.js; sharing and deleting go back to the app.
import { el, fill } from './ui.js';
import * as native from './native.js';

const clock = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function renderSessions(root, go) {
  const app = native.appBar(el, 'sessions', go);
  const list = el('ul', { class: 'session-list' });
  let delArm = null;
  let tick;

  function draw() {
    clearInterval(tick);
    const st = native.recording();
    const live = st.recording ? el('li', { class: 'session live' },
      el('div', { class: 'session-meta' },
        el('strong', {}, el('span', { class: 'rec-dot' }), ' Recording now'),
        el('span', { class: 'muted rec-clock' })),
      el('span', { class: 'muted', text: 'Tap the red bar at the bottom to stop.' })) : null;
    if (live) {
      const upd = () => { live.querySelector('.rec-clock').textContent = clock(Date.now() - st.startedMs); };
      upd();
      tick = setInterval(upd, 1000);
    }
    fill(list, live, st.sessions.map((x) => {
      const active = x.durationMs ? Math.round((100 * x.playingMs) / x.durationMs) : 0;
      const what = [...(x.pieces || [])];
      if (x.sprintRounds) what.push(`Chord Sprint × ${x.sprintRounds}`);
      return el('li', { class: 'session' },
        el('div', { class: 'session-meta' },
          el('strong', { text: when(x.started) }),
          el('span', { class: 'muted', text: `${clock(x.durationMs)} long · ${clock(x.playingMs)} playing (${active}%) · ${x.notes} notes` }),
          what.length ? el('div', { class: 'tags' }, what.map((t) => el('span', { class: 'tag', text: t }))) : null),
        el('div', { class: 'row' },
          el('button', { class: 'ghost small', onclick: () => native.shareSession(x.name) }, 'Share'),
          el('button', { class: 'ghost small' + (delArm === x.name ? ' warn' : ''), onclick: () => {
            if (delArm === x.name) { delArm = null; native.deleteSession(x.name); } else { delArm = x.name; draw(); }
          } }, delArm === x.name ? 'Tap to confirm' : 'Delete')));
    }));
    empty.hidden = !!(st.sessions.length || st.recording);
  }

  const empty = el('div', { class: 'empty' },
    el('p', { text: 'No sessions yet.' }),
    el('p', { class: 'muted', text: 'Tap Record before you practice. Every note you play is saved, on any screen, until you stop or go 20 minutes without playing.' }));

  fill(root, el('div', { class: 'library' },
    el('header', { class: 'lib-head' }, app.bar),
    el('section', { class: 'lib-body' },
      el('p', { class: 'muted', text: 'Share a session to the Claude app for a practice summary. Sessions are also in the Files app under On My iPad › Woodshed › Sessions.' }),
      empty,
      list)));

  const off = native.onRecording(draw);
  draw();
  root._cleanup = () => { clearInterval(tick); off(); app.off(); };
}
