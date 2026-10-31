// look: screenshots for the card (look.json "screens") and the canvas boxes for the WebGL motion entries (rank.js glMotions).
// All CDP Page.captureScreenshot: no page script runs, the page clock does not advance. Each capture is raced against a
// timeout and never fails the look (null instead).
//   before  rest state just before the action (hover / click / scroll): JPEG file + a small PNG for the canvas pixel check
//           (a load look takes only the small PNG, after boot: there is no rest state before a load)
//   end     the viewport at the end of the take: the PNG the crops are cut from (index.js) + a JPEG file
//   page    scroll looks: one full-page JPEG at the end, at most PAGE_MAX_PX image px tall
import { PNG } from 'pngjs';

export const JPEG_Q = 70;
export const PAGE_MAX_PX = 12000;
const SMALL = 0.25;   // css -> image px of the pixel-check PNG

async function cap(S, params, ms = 8000) {
  const r = await Promise.race([S.cdp.send('Page.captureScreenshot', { fromSurface: true, ...params }), new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timeout')), ms).unref())]);
  return Buffer.from(r.data, 'base64');
}

/** In the page: viewport, scroll, page size and every canvas box (shadow roots too), keyed by the recorder's element id. */
export function viewInPage() {
  const W = window.__WR; const out = [];
  const walk = (root) => {
    for (const c of root.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect(); let id = null;
      try { id = W && W.idOf ? W.idOf(c) : null; } catch (e) { id = null; }
      // a selector for the card / --el: the canvas's id or classes, only when it names this canvas alone
      let sel = null;
      try { const q = c.id ? `canvas#${CSS.escape(c.id)}` : c.classList.length ? `canvas.${[...c.classList].map((x) => CSS.escape(x)).join('.')}` : null; if (q && document.querySelectorAll(q).length === 1) sel = q; } catch (e) { sel = null; }
      if (id != null && r.width > 0 && r.height > 0) out.push({ id, box: { x: r.x, y: r.y, w: r.width, h: r.height }, sel });
    }
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot);
  };
  try { walk(document); } catch (e) { /* a page that throws on access: no canvases */ }
  const de = document.documentElement;
  return { w: innerWidth, h: innerHeight, scrollY, dpr: devicePixelRatio, pageW: de.clientWidth, pageH: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0), canvases: out };
}

const view = (S) => S.evRetry(viewInPage).catch(() => null);
const rnd = (x) => Math.round(x * 100) / 100;

/** Before the action. `file`: also a JPEG of the viewport (rest state). */
export async function shotBefore(S, { file = true } = {}) {
  const t0 = Date.now();
  const v = await view(S); if (!v) return null;
  const small = await cap(S, { format: 'png', clip: { x: 0, y: 0, width: v.w, height: v.h, scale: SMALL } }).catch(() => null);
  const jpg = file ? await cap(S, { format: 'jpeg', quality: JPEG_Q }).catch(() => null) : null;
  return { view: v, small, jpg, ms: Date.now() - t0 };
}

/** End of the take: the crop PNG (full resolution), a JPEG file, a small PNG (pixel check), the canvas boxes. */
export async function shotEnd(S) {
  const t0 = Date.now();
  const v = await view(S);
  const png = await cap(S, { format: 'png', captureBeyondViewport: false }).catch(() => null);
  const jpg = await cap(S, { format: 'jpeg', quality: JPEG_Q, captureBeyondViewport: false }).catch(() => null);
  const small = v ? await cap(S, { format: 'png', clip: { x: 0, y: 0, width: v.w, height: v.h, scale: SMALL } }).catch(() => null) : null;
  return { view: v, png, jpg, small, ms: Date.now() - t0 };
}

/**
 * One full-page JPEG (scroll looks), taken last before the browser closes: rendering beyond the viewport can make the page
 * lay out again, so nothing is measured after it. At most PAGE_MAX_PX image px tall (scaled down when the page is longer).
 */
export async function shotPage(S) {
  const t0 = Date.now();
  const v = await view(S); if (!v || !(v.pageH > 0)) return null;
  // image px per css px: the device scale, lowered so the image stays within PAGE_MAX_PX
  const scale = Math.min(1, PAGE_MAX_PX / (v.pageH * (v.dpr || 1)));
  const data = await cap(S, { format: 'jpeg', quality: JPEG_Q, captureBeyondViewport: true, clip: { x: 0, y: 0, width: v.pageW || v.w, height: v.pageH, scale } }, 15000).catch(() => null);
  if (!data) return null;
  return { data, w: v.pageW || v.w, h: v.pageH, scale: rnd(scale * (v.dpr || 1)), ...(scale < 1 ? { capped: `scaled down to stay within ${PAGE_MAX_PX} px tall` } : {}), ms: Date.now() - t0 };
}

/**
 * Mean RGB difference (0..1) inside a CSS box between two decoded RGBA images of the same viewport at their own scales,
 * read on a grid of at most 96 × 96 points. null when the box is outside either image.
 */
export function boxDiffAt(a, sa, b, sb, box) {
  if (!a || !b || !box || !(box.w > 0) || !(box.h > 0)) return null;
  const nx = Math.max(1, Math.min(96, Math.round(box.w * Math.min(sa, sb)))), ny = Math.max(1, Math.min(96, Math.round(box.h * Math.min(sa, sb))));
  let s = 0, n = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cx = box.x + ((i + 0.5) * box.w) / nx, cy = box.y + ((j + 0.5) * box.h) / ny;
    const ax = Math.floor(cx * sa), ay = Math.floor(cy * sa), bx = Math.floor(cx * sb), by = Math.floor(cy * sb);
    if (ax < 0 || ay < 0 || ax >= a.width || ay >= a.height || bx < 0 || by < 0 || bx >= b.width || by >= b.height) continue;
    const p = (ay * a.width + ax) * 4, q = (by * b.width + bx) * 4;
    s += Math.abs(a.data[p] - b.data[q]) + Math.abs(a.data[p + 1] - b.data[q + 1]) + Math.abs(a.data[p + 2] - b.data[q + 2]); n += 3;
  }
  return n ? s / (n * 255) : null;
}

const same = (a, b) => !!a && !!b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;

/**
 * Canvas boxes at the end (and before), with the pixel change inside the box when both frames show it in the same place
 * (a canvas the scroll moved cannot be compared pixel for pixel: `why` says so).
 */
export function canvasesOf(before, end) {
  if (!end || !end.view) return [];
  let a = null, b = null;
  try { a = before && before.small ? PNG.sync.read(before.small) : null; } catch { a = null; }
  try { b = end.small ? PNG.sync.read(end.small) : null; } catch { b = null; }
  const sb = SMALL;   // both frames at the same scale: the same downsampling, so detail does not read as change
  const prior = new Map(((before && before.view && before.view.canvases) || []).map((c) => [c.id, c.box]));
  return end.view.canvases.map((c) => {
    const pb = prior.get(c.id) || null;
    let diff = null, why = null;
    if (!before || !a) why = 'no frame before the action to compare';
    else if (!b) why = 'no end frame to compare';
    else if (!pb) diff = boxDiffAt(a, SMALL, b, sb, c.box);   // the canvas appeared during the take: compared with what was there
    else if (!same(pb, c.box)) why = 'the canvas moved on screen (page scroll) between the two frames';
    else diff = boxDiffAt(a, SMALL, b, sb, c.box);
    return { id: c.id, end: c.box, before: pb, diff, sel: c.sel || null, ...(why ? { why } : {}) };
  });
}
