// Thin wrapper around the bundled pdf.js. Locked down: no scripting, no XFA,
// no network fetches beyond our own vendored font/wasm files.
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const base = new URL('../vendor/pdfjs/', import.meta.url).href;

export async function loadPdf(blob) {
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({
    data,
    enableXfa: false,
    standardFontDataUrl: base + 'standard_fonts/',
    wasmUrl: base + 'wasm/',
    useSystemFonts: false,
    stopAtErrors: false,
  }).promise;
}

// Render one page into a canvas sized to fit (cssWidth x cssHeight), sharp on retina.
// Returns the CSS size actually used so overlays can match it.
export async function renderPage(pdf, pageNum, canvas, cssWidth, cssHeight) {
  const page = await pdf.getPage(pageNum);
  const unit = page.getViewport({ scale: 1 });
  const scale = Math.min(cssWidth / unit.width, cssHeight / unit.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const viewport = page.getViewport({ scale: scale * dpr });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const w = viewport.width / dpr;
  const h = viewport.height / dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  if (canvas._task) canvas._task.cancel();
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, annotationMode: pdfjs.AnnotationMode.DISABLE });
  canvas._task = task;
  try {
    await task.promise;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') throw e;
  } finally {
    if (canvas._task === task) canvas._task = null;
  }
  return { width: w, height: h };
}

export async function makeThumb(pdf) {
  const canvas = document.createElement('canvas');
  const page = await pdf.getPage(1);
  const unit = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 360 / unit.width });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}
