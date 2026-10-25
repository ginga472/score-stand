// Pencil markup. Strokes are stored in page-relative coordinates (0..1) so they
// line up at any zoom or screen size:
//   {tool: 'pen'|'hl', color, size, pts: [[x, y, pressure], ...]}
// size is a fraction of page width.
import { getStroke } from '../vendor/perfect-freehand.mjs';

export const TOOLS = {
  pen: { thinning: 0.6, smoothing: 0.5, streamline: 0.5, alpha: 1 },
  hl: { thinning: 0, smoothing: 0.5, streamline: 0.6, alpha: 0.3 },
};

function pathFrom(points) {
  if (points.length < 2) return null;
  const p = new Path2D();
  p.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  p.closePath();
  return p;
}

export function drawStrokes(canvas, strokes, cssW, cssH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (canvas.width !== Math.floor(cssW * dpr)) {
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  for (const s of strokes) drawOne(ctx, s, cssW, cssH);
}

function drawOne(ctx, s, w, h) {
  const opts = TOOLS[s.tool] || TOOLS.pen;
  const pts = s.pts.map(([x, y, p]) => [x * w, y * h, p]);
  const outline = getStroke(pts, {
    size: s.size * w,
    thinning: opts.thinning,
    smoothing: opts.smoothing,
    streamline: opts.streamline,
    simulatePressure: pts.every((p) => p[2] === 0.5),
    last: true,
  });
  const path = pathFrom(outline);
  if (!path) return;
  ctx.globalAlpha = opts.alpha;
  ctx.fillStyle = s.color;
  ctx.fill(path);
  ctx.globalAlpha = 1;
}

// Is point (x, y) (page-relative) within reach of the stroke?
function hits(s, x, y, w, h) {
  const r = Math.max(s.size * w, 10);
  return s.pts.some(([px, py]) => Math.hypot((px - x) * w, (py - y) * h) < r);
}

// Attach drawing to an overlay canvas. `getState` returns the current tool
// settings; `onChange(strokes)` is called after each finished stroke or erase.
export function attachInk(canvas, { getStrokes, getState, onChange, size }) {
  let current = null;

  const rel = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5];
  };

  const accepts = (e) => {
    const st = getState();
    if (!st.enabled) return false;
    // With "Pencil only" on, fingers stay free for scrolling and page turns.
    if (st.pencilOnly && e.pointerType === 'touch') return false;
    return true;
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    canvas.setPointerCapture(e.pointerId);
    const st = getState();
    const { width, height } = size();
    if (st.tool === 'erase') {
      current = { erase: true };
      eraseAt(rel(e), width, height);
      return;
    }
    current = { tool: st.tool, color: st.color, size: st.tool === 'hl' ? 0.018 : st.width, pts: [rel(e)] };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    e.preventDefault();
    const { width, height } = size();
    if (current.erase) {
      eraseAt(rel(e), width, height);
      return;
    }
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of events) current.pts.push(rel(ce));
    drawStrokes(canvas, [...getStrokes(), current], width, height);
  });

  const finish = () => {
    if (!current) return;
    const done = current;
    current = null;
    if (done.erase) return;
    onChange([...getStrokes(), done]);
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  function eraseAt([x, y], w, h) {
    const strokes = getStrokes();
    const kept = strokes.filter((s) => !hits(s, x, y, w, h));
    if (kept.length !== strokes.length) onChange(kept);
  }
}
