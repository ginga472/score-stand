// Metronome panel and plan-block bridge, shared by the Music and Chord Sprint screens of the
// Woodshed iPad app. A plain script (not a module) so both pages can load it. The click itself
// runs in the app, which also writes it into the session recording; this page only shows controls.
// Outside the app (the Score Stand website) it does nothing.
(function () {
  'use strict';
  if (!window.__pianoApp) return;

  const post = (body) => {
    try { window.webkit.messageHandlers.practice.postMessage(body); } catch (e) { /* not in the app */ }
  };
  let state = { metronome: { on: false, bpm: 60, beats: 4, sub: 1, volume: 0.8 }, plan: null };
  const listeners = new Set();
  window.practiceState = (st) => {
    state = { metronome: Object.assign({}, state.metronome, st.metronome || {}), plan: st.plan || null };
    listeners.forEach((fn) => { try { fn(state, st.event || null); } catch (e) { console.error(e); } });
  };

  // Text only through textContent, never innerHTML.
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }

  const clamp = (v) => Math.max(20, Math.min(240, Math.round(v)));
  const set = (changes) => post(Object.assign({ cmd: 'metronome' }, state.metronome, changes));

  // ---- the panel ----
  let dlg = null;
  function open() {
    if (dlg) return;
    const m = () => state.metronome;
    const bpmOut = h('output', { class: 'met-bpm' });
    const slider = h('input', { type: 'range', min: '20', max: '200', step: '1', 'aria-label': 'Tempo' });
    slider.addEventListener('input', () => { bpmOut.textContent = slider.value; });
    slider.addEventListener('change', () => set({ bpm: Number(slider.value) }));
    const nudge = (d) => h('button', { class: 'met-step', onclick: () => set({ bpm: clamp(m().bpm + d) }) }, d > 0 ? `+${d}` : `−${-d}`);
    const presets = [30, 40, 50, 60, 72, 80, 100].map((b) => h('button', { class: 'met-chip', onclick: () => set({ bpm: b }) }, String(b)));
    const seg = (label, key, opts) => {
      const btns = opts.map(([v, t]) => h('button', { onclick: () => set({ [key]: v }), 'data-v': String(v) }, t));
      return { row: h('div', { class: 'met-row' }, h('span', { class: 'met-label', text: label }), h('div', { class: 'met-seg' }, btns)), btns, key };
    };
    const accent = seg('Accent', 'beats', [[1, 'Off'], [2, '2'], [3, '3'], [4, '4']]);
    const clicks = seg('Clicks on', 'sub', [[1, 'Beats'], [2, 'Eighths']]);
    const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', 'aria-label': 'Volume' });
    vol.addEventListener('change', () => set({ volume: Number(vol.value) }));
    const go = h('button', { class: 'met-go', onclick: () => set({ on: !m().on }) });

    dlg = h('dialog', { class: 'met-panel' },
      h('div', { class: 'met-head' },
        h('h2', { text: 'Metronome' }),
        h('button', { class: 'met-close', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
      h('div', { class: 'met-tempo' }, nudge(-5), nudge(-1), h('div', { class: 'met-read' }, bpmOut, h('span', { text: 'beats per minute' })), nudge(1), nudge(5)),
      slider,
      h('div', { class: 'met-chips' }, presets),
      accent.row,
      clicks.row,
      h('div', { class: 'met-row' }, h('span', { class: 'met-label', text: 'Volume' }), vol),
      go,
      h('p', { class: 'met-note', text: 'While you record, the clicks are saved with your playing, so a review can tell you where you stayed with them and where you drifted.' }));

    const draw = () => {
      const s = m();
      bpmOut.textContent = String(s.bpm);
      slider.value = String(s.bpm);
      vol.value = String(s.volume);
      for (const g of [accent, clicks]) for (const b of g.btns) b.classList.toggle('on', Number(b.dataset.v) === s[g.key]);
      go.textContent = s.on ? 'Stop' : 'Start';
      go.classList.toggle('on', s.on);
    };
    draw();
    listeners.add(draw);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });  // tap outside closes
    dlg.addEventListener('close', () => { listeners.delete(draw); dlg.remove(); dlg = null; });
    document.body.append(dlg);
    dlg.showModal();
  }

  // A top-bar button that shows the tempo and lights up while the click is running.
  function button(existing) {
    const b = existing || h('button', {});
    b.classList.add('met-btn');
    b.hidden = false;
    b.setAttribute('aria-label', 'Metronome');
    b.addEventListener('click', open);
    const draw = () => {
      b.textContent = `♩ ${state.metronome.bpm}`;
      b.classList.toggle('on', state.metronome.on);
    };
    draw();
    listeners.add(draw);
    b._off = () => listeners.delete(draw);
    return b;
  }

  window.WoodshedPractice = {
    get state() { return state; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    open,
    button,
    // block: {id, label, goal, min, bpm?, bars?}
    startPlan: (block) => post(Object.assign({ cmd: 'plan_start' }, block)),
    endPlan: (reason) => post({ cmd: 'plan_end', reason }),
  };

  const wire = () => { const b = document.getElementById('metbtn'); if (b) button(b); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  post({ cmd: 'state' });
})();
