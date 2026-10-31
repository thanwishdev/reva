// Pixel check (review F3 layer 2): pixelmatch with threshold <= 0.03 and anti-aliased pixels COUNTED (includeAA),
// so a colour error of a few levels or a missing icon cannot hide. Pass = differing px <= measured noise cap for the
// point AND largest 8-connected diff blob <= 64 px^2. Writes a heatmap (pixelmatch diff image) on request.
import fs from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { paintRects } from './scriptowned.js';

export const PM_THRESHOLD = 0.03;
export const MAX_BLOB = 64;

/** Largest 8-connected component in a 0/1 mask (Uint8Array, w*h). Returns {area, box:[x0,y0,x1,y1]}. */
export function largestBlob(mask, w, h) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let best = { area: 0, box: null };
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    let sp = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = i; seen[i] = 1;
    while (sp) {
      const j = stack[--sp]; area++;
      const x = j % w, y = (j / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (mask[k] && !seen[k]) { seen[k] = 1; stack[sp++] = k; }
      }
    }
    if (area > best.area) best = { area, box: [x0, y0, x1, y1] };
  }
  return best;
}

/** Diff two PNG buffers. Returns {sizeMismatch} or {diffPx, pct, blob, w, h}. heatmap: path to write the diff image. */
/** mask: rects [x0,y0,x1,y1] painted identically into both images before the diff (script-owned regions, see
 *  scriptowned.js); maskedPx = painted px. */
/** Image-decoder tolerance (D1b, measured): the same JPEG drawn small (a real site: large photos drawn at 32-44 px, a URL
 *  also used elsewhere on the page) rasterises 1-2 levels differently depending on the decode history of the
 *  renderer (which scale it was first decoded at), with identical src, box and computed style. A differing pixel
 *  inside an <img> box (decodeRects: only given when the element oracle passed exactly) whose channels differ by at
 *  most DECODE_LEVELS is counted as decodePx, not as a difference. Anything larger, or outside an image, counts. */
export const DECODE_LEVELS = 2;

export function diffPng(bufA, bufB, { heatmap = null, threshold = PM_THRESHOLD, mask = null, decodeRects = null } = {}) {
  const A = PNG.sync.read(bufA), B = PNG.sync.read(bufB);
  if (A.width !== B.width || A.height !== B.height) return { sizeMismatch: [A.width, A.height, B.width, B.height], diffPx: Infinity, blob: { area: Infinity } };
  const { width: w, height: h } = A;
  const maskedPx = mask && mask.length ? (paintRects(A, mask), paintRects(B, mask)) : 0;
  const out = new PNG({ width: w, height: h });
  let diffPx = pixelmatch(A.data, B.data, out.data, w, h, { threshold, includeAA: true, alpha: 0.15, diffColor: [255, 0, 0] });
  let decodePx = 0;
  if (diffPx && decodeRects && decodeRects.length) {
    const inImg = new Uint8Array(w * h);
    for (const [x0, y0, x1, y1] of decodeRects) for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) inImg[y * w + x] = 1;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      if (!inImg[i] || !(out.data[o] === 255 && out.data[o + 1] === 0 && out.data[o + 2] === 0)) continue;
      if (Math.max(Math.abs(A.data[o] - B.data[o]), Math.abs(A.data[o + 1] - B.data[o + 1]), Math.abs(A.data[o + 2] - B.data[o + 2]), Math.abs(A.data[o + 3] - B.data[o + 3])) > DECODE_LEVELS) continue;
      out.data[o] = 0; out.data[o + 1] = 0; out.data[o + 2] = 255; decodePx++; diffPx--;
    }
  }
  let blob = { area: 0, box: null };
  if (diffPx) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) { const o = i * 4; mask[i] = out.data[o] === 255 && out.data[o + 1] === 0 && out.data[o + 2] === 0 ? 1 : 0; }
    blob = largestBlob(mask, w, h);
  }
  if (heatmap && diffPx) fs.writeFileSync(heatmap, PNG.sync.write(out));
  return { diffPx, pct: +(100 * diffPx / (w * h)).toFixed(4), blob, w, h, maskedPx, decodePx };
}

/** Gate rule for one point. noiseCap = max differing px between identical replays at this point. */
export function pixelVerdict(d, noiseCap) {
  if (d.sizeMismatch) return { pass: false, reason: `size ${d.sizeMismatch.join('x')}` };
  if (d.diffPx > noiseCap) return { pass: false, reason: `diffPx ${d.diffPx} > noise cap ${noiseCap}` };
  if (d.blob.area > MAX_BLOB) return { pass: false, reason: `blob ${d.blob.area} px^2 > ${MAX_BLOB}` };
  return { pass: true };
}
