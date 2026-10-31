// X4 canvas pixel channel (M2 design §12). Self-contained in-page function, written by the lab-webgl builder and
// wired into the recorder by the integrator (session.js scene.pixelKeys, inpage.js W.sample). It has no imports and no references outside its own body: it is serialised
// with Function.prototype.toString exactly like src/record/inpage.js.
//
// What it does, in the page, before any page script runs (add it with addInitScript, same as the recorder runtime):
//   1. Hooks HTMLCanvasElement.prototype.getContext. WebGL contexts are created with preserveDrawingBuffer: true
//      (so the frame the page drew is still readable when the recorder samples); 2D contexts with
//      willReadFrequently: true (CPU-backed, cheap getImageData). Both overrides are recorded in `flags`.
//   2. Counts draw calls (GL draw*, 2D fill/stroke/drawImage/fillRect/strokeRect/fillText/putImageData) so the
//      fitter can tell "a canvas that draws" from "a canvas that never did" (U7: DOM record not_applicable).
//   3. Exposes window.__WR_PIX = { cfg, flags, status(), read() }.
//
// read() is called by the sampler once per sampled frame. For every configured key {key, rgb, tol, canvas?} it returns
//   pix:<key>:x, pix:<key>:y   centroid of the pixels whose colour is within `tol` (max abs channel difference)
//                              of rgb, in VIEWPORT CSS px, y down (canvas rect offset added, scale-corrected);
//                              null when no pixel matches
//   pix:<key>:n                number of matching pixels
// Wiring (integrator): in W.sample(), after the row is built:  if (window.__WR_PIX) row.pix = window.__WR_PIX.read();
// (until then a session can use scene.probe = '() => window.__WR_PIX.read()', which stores it in row.probe).
export function wrPixelChannel(CFG) {
  if (window.__WR_PIX) return;
  const flags = { preserveDrawingBuffer: false, willReadFrequently: false, contexts: 0 };
  const draws = { gl: 0, c2d: 0 };
  const canvases = [];                         // {el, ctx, kind}
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const t = String(type);
    let a = attrs;
    if (/^(experimental-)?webgl2?$/.test(t)) { a = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true }); flags.preserveDrawingBuffer = true; }
    else if (t === '2d') { a = Object.assign({}, attrs || {}, { willReadFrequently: true }); flags.willReadFrequently = true; }
    const ctx = orig.call(this, type, a);
    if (ctx && !canvases.some((c) => c.el === this)) { canvases.push({ el: this, ctx, kind: t === '2d' ? '2d' : 'gl' }); flags.contexts++; }
    return ctx;
  };
  const count = (P, names, key) => {
    for (const n of names) {
      const f = P && P[n]; if (typeof f !== 'function') continue;
      P[n] = function (...args) { draws[key]++; return f.apply(this, args); };
    }
  };
  for (const P of [window.WebGLRenderingContext && WebGLRenderingContext.prototype, window.WebGL2RenderingContext && WebGL2RenderingContext.prototype])
    count(P, ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'], 'gl');
  count(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype,
    ['fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'fillText', 'strokeText', 'putImageData'], 'c2d');

  let buf = null;
  const pixels = (c) => {
    const w = c.el.width, h = c.el.height;
    if (c.kind === 'gl') {
      const gl = c.ctx;
      if (!buf || buf.length !== w * h * 4) buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return { data: buf, w, h, flipY: true };
    }
    return { data: c.ctx.getImageData(0, 0, w, h).data, w, h, flipY: false };
  };
  window.__WR_PIX = {
    cfg: CFG, flags, canvases: () => canvases.length,
    status: () => ({ flags: Object.assign({}, flags), draws: Object.assign({}, draws), canvases: canvases.map((c) => ({ kind: c.kind, w: c.el.width, h: c.el.height })) }),
    read() {
      const out = {};
      const keys = CFG.pixelKeys || [];
      const byCanvas = new Map();
      for (const k of keys) { const ci = k.canvas || 0; if (!byCanvas.has(ci)) byCanvas.set(ci, []); byCanvas.get(ci).push(k); }
      for (const [ci, ks] of byCanvas) {
        const c = canvases[ci];
        if (!c) { for (const k of ks) { out['pix:' + k.key + ':x'] = null; out['pix:' + k.key + ':y'] = null; out['pix:' + k.key + ':n'] = 0; } continue; }
        const { data, w, h, flipY } = pixels(c);
        const rect = c.el.getBoundingClientRect();
        const sx = rect.width / w, sy = rect.height / h;
        const acc = ks.map(() => ({ n: 0, x: 0, y: 0 }));
        for (let row = 0; row < h; row++) {
          const yTop = flipY ? h - 1 - row : row;
          let i = row * w * 4;
          for (let col = 0; col < w; col++, i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            for (let j = 0; j < ks.length; j++) {
              const k = ks[j];
              if (Math.abs(r - k.rgb[0]) <= k.tol && Math.abs(g - k.rgb[1]) <= k.tol && Math.abs(b - k.rgb[2]) <= k.tol) { const a = acc[j]; a.n++; a.x += col + 0.5; a.y += yTop + 0.5; }
            }
          }
        }
        ks.forEach((k, j) => {
          const a = acc[j];
          out['pix:' + k.key + ':x'] = a.n ? rect.left + (a.x / a.n) * sx : null;
          out['pix:' + k.key + ':y'] = a.n ? rect.top + (a.y / a.n) * sy : null;
          out['pix:' + k.key + ':n'] = a.n;
        });
      }
      return out;
    },
  };
}

/** Init-script text (addInitScript / scene.init). cfg = { pixelKeys: [{key, rgb: [r,g,b], tol, canvas?}] }. */
export function pixelChannelSource(cfg) {
  return `(${wrPixelChannel.toString()})(${JSON.stringify(cfg)});`;
}
