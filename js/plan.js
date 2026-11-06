// "Plan for today" on the Music screen (iPad app only): a few short blocks suggested in the notes of
// your latest reviewed session. A suggestion, not a script: start any block in any order, stretch it,
// skip it, or fold the whole card away. Starting a block opens the score at its page, sets the
// metronome to its tempo (if it has one), and runs a soft timer that chimes when the time is up.
import * as db from './db.js';
import { el, fill, toast } from './ui.js';
import * as native from './native.js';
import { parseNotes } from './sessions.js';

const MAX_AGE = 5 * 864e5;  // older plans are stale

// The newest session whose notes carry a plan.
function latestPlan() {
  for (const x of native.recording().sessions) {
    if (Date.now() - x.started > MAX_AGE) return null;
    const n = x.review ? parseNotes(x.review) : null;
    if (n?.plan) return { session: x.name, started: x.started, by: n.by, ...n.plan };
  }
  return null;
}

const blockId = (plan, i) => `${plan.session}#${i}`;

async function progress(plan) {
  const p = await db.getMeta('plan');
  return p && p.session === plan.session ? p : { session: plan.session, done: [], folded: false };
}

// Ticks blocks off when you tap "Done with this" on the plan timer, from any screen.
export function trackPlan() {
  native.onPractice(async (_st, event) => {
    if (!event?.planEnded || event.reason !== 'done') return;
    const [session, i] = String(event.planEnded).split('#');
    const p = await db.getMeta('plan');
    const cur = p && p.session === session ? p : { session, done: [], folded: false };
    if (!cur.done.includes(Number(i))) cur.done.push(Number(i));
    await db.setMeta('plan', cur);
  });
}

// Finds the score a block names: the exact title first (reviews copy it from the session), then the
// closest match by words, so "Sonatina Op. 55 No. 1" still finds "sonatina-op55-no1-kuhlau".
async function findScore(name) {
  if (!name) return null;
  const scores = await db.getAll('scores');
  const words = (t) => t.toLowerCase().replace(/([a-z])(\d)|(\d)([a-z])/g, '$1$3 $2$4').split(/[^a-z0-9]+/).filter(Boolean);
  const exact = scores.find((s) => s.title.toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  const want = words(name);
  let best = null, bestScore = 0;
  for (const s of scores) {
    const have = new Set(words(s.title));
    const hit = want.filter((w) => have.has(w)).length / (want.length || 1);
    if (hit > bestScore) { best = s; bestScore = hit; }
  }
  return bestScore >= 0.6 ? best : null;
}

const day = (ms) => {
  const d = new Date(ms), today = new Date();
  if (d.toDateString() === today.toDateString()) return "today's";
  const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "yesterday's";
  return `${d.toLocaleDateString(undefined, { weekday: 'long' })}'s`;
};

export function planCard(go) {
  const card = el('section', { class: 'plan', hidden: true });
  if (!native.inApp) return { node: card, off: () => {} };
  let tick = null;
  let seq = 0;

  async function draw() {
    const my = ++seq;
    clearInterval(tick);
    const plan = latestPlan();
    if (!plan) { card.hidden = true; return; }
    const prog = await progress(plan);
    if (my !== seq) return;
    const running = native.practice().plan;
    const save = async (changes) => { await db.setMeta('plan', { ...prog, ...changes }); draw(); };
    const left = plan.blocks.filter((_, i) => !prog.done.includes(i)).length;

    const head = el('div', { class: 'plan-head' },
      el('div', {},
        el('h2', { text: 'Plan for today' }),
        el('p', { class: 'muted', text: prog.folded
          ? `${left ? `${left} of ${plan.blocks.length} blocks to go` : 'All done'} · from ${day(plan.started)} session`
          : `Suggested after ${day(plan.started)} session${plan.by ? ` by ${plan.by}` : ''}. Pick any block, in any order, or skip it.` })),
      el('button', { class: 'ghost small', onclick: () => save({ folded: !prog.folded }) }, prog.folded ? 'Show' : 'Fold away'));

    if (prog.folded) { fill(card, head); card.hidden = false; card.classList.add('folded'); return; }
    card.classList.remove('folded');

    const rows = plan.blocks.map((b, i) => {
      const id = blockId(plan, i);
      const done = prog.done.includes(i);
      const live = running?.id === id;
      const meta = [b.score, b.page ? `p.${b.page}` : '', b.bars ? `bars ${b.bars}` : '', `${b.min} min`, b.bpm ? `♩ ${b.bpm}` : '']
        .filter(Boolean).join(' · ');
      const clock = el('span', { class: 'plan-clock' });
      const start = async () => {
        native.startPlan({ id, label: b.label, goal: b.goal, min: b.min, bpm: b.bpm, bars: b.bars });
        if (/chord sprint/i.test(b.score)) { native.openChordSprint(); return; }
        const score = await findScore(b.score);
        if (score) go(`#/score/${score.id}${b.page ? `/${b.page}` : ''}`);
        else if (b.score) toast(`Couldn't find "${b.score}" in your library. Open it yourself; the timer is running.`);
      };
      const actions = live
        ? [clock, el('button', { class: 'primary small', onclick: () => native.endPlan('done') }, 'Done')]
        : done
          ? [el('span', { class: 'plan-done', text: '✓ Done' }), el('button', { class: 'ghost small', onclick: start }, 'Again')]
          : [el('button', { class: 'primary small', onclick: start }, 'Start')];
      if (live) {
        const upd = () => {
          const s = Math.max(0, Math.round((running.endsMs - Date.now()) / 1000));
          clock.textContent = s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left` : "Time's up";
        };
        upd();
        tick = setInterval(upd, 1000);
      }
      return el('li', { class: 'plan-block' + (done ? ' done' : '') + (live ? ' live' : '') },
        el('span', { class: 'plan-num', text: String(i + 1) }),
        el('div', { class: 'plan-text' },
          el('strong', { text: b.label }),
          el('span', { class: 'muted', text: meta }),
          b.goal ? el('span', { class: 'plan-goal', text: b.goal }) : null),
        el('div', { class: 'plan-actions' }, actions));
    });

    fill(card, head,
      plan.note ? el('p', { class: 'plan-note', text: plan.note }) : null,
      el('ol', { class: 'plan-list' }, rows),
      el('p', { class: 'muted plan-foot', text: 'Tempos are a ceiling, not a target: slower is always fine. Starting a block records it, so the next review sees what you tried.' }));
    card.hidden = false;
  }

  const offRec = native.onRecording(draw);
  const offPrac = native.onPractice(() => setTimeout(draw, 50));  // after trackPlan has saved
  draw();
  return { node: card, off: () => { clearInterval(tick); offRec(); offPrac(); } };
}
