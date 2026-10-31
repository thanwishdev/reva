// Fixture Lab group A (lab-easing): group-local pure math shared by the pages and by refsim.mjs / truth.mjs.
// No DOM, no globals, no imports: it runs in the page (ES module) and in Node.
//
// Parameters are this lab's own (docs/design/M2-fitter.md section 11): none of the captured-site numbers listed in PLAN
// section 4 M2 is used. Overrides of G1-4 7.2 that the design asks for: M06 delays 12 + 30*i ms.

export const r6 = (x) => Math.round(x * 1e6) / 1e6;
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ------------------------------------------------------------------------------------------------ params in the URL hash
export function encodeParams(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeParams(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(s + '='.repeat((4 - (s.length % 4)) % 4)));
}
/** `#p=<base64url JSON>` -> object; missing/garbled -> {}. */
export function paramsFromHash(hash) {
  const m = /(?:^#|&)p=([A-Za-z0-9_-]+)/.exec(hash || '');
  if (!m) return {};
  try { return decodeParams(m[1]); } catch { return {}; }
}

// ------------------------------------------------------------------------------------------------ easing functions
/** CSS cubic-bezier(x1, y1, x2, y2) as f(x) -> y, solved to about 1e-13 in x (Newton, bisection fallback). */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t;
  const Y = (t) => ((ay * t + by) * t + cy) * t;
  const dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 12; i++) {
      const e = X(t) - x;
      if (Math.abs(e) < 1e-14) return Y(t);
      const d = dX(t);
      if (Math.abs(d) < 1e-9) break;
      const n = t - e / d;
      if (n < 0 || n > 1) break;
      t = n;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 100; i++) {
      const v = X(t);
      if (Math.abs(v - x) < 1e-14) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return Y(t);
  };
}

const C1 = 1.70158;
/** Named eases (Penner family). expo: 1 - 2^(-10 p) with the end snapped to 1 (as GSAP/anime do). */
export const NAMED = {
  linear: (p) => p,
  easeOutSine: (p) => Math.sin((p * Math.PI) / 2),
  easeInOutSine: (p) => -(Math.cos(Math.PI * p) - 1) / 2,
  easeInQuad: (p) => p * p,
  easeOutQuad: (p) => 1 - (1 - p) * (1 - p),
  easeInOutQuad: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
  easeInCubic: (p) => p * p * p,
  easeOutCubic: (p) => 1 - Math.pow(1 - p, 3),
  easeInOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  easeOutQuart: (p) => 1 - Math.pow(1 - p, 4),
  easeInOutQuart: (p) => (p < 0.5 ? 8 * p * p * p * p : 1 - Math.pow(-2 * p + 2, 4) / 2),
  easeOutQuint: (p) => 1 - Math.pow(1 - p, 5),
  easeOutExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  easeInOutExpo: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2),
  easeOutCirc: (p) => Math.sqrt(1 - Math.pow(p - 1, 2)),
  easeOutBack: (p) => 1 + (C1 + 1) * Math.pow(p - 1, 3) + C1 * Math.pow(p - 1, 2),
};
/** spec: a NAMED key or [x1, y1, x2, y2] -> f(p). */
export function easeFn(spec) {
  if (Array.isArray(spec)) return cubicBezier(spec[0], spec[1], spec[2], spec[3]);
  const f = NAMED[spec];
  if (!f) throw new Error('unknown ease ' + spec);
  return f;
}
/** CSS timing-function text for a bezier spec. */
export const cssBezier = (b) => `cubic-bezier(${b[0]}, ${b[1]}, ${b[2]}, ${b[3]})`;

/** Peak overshoot above 1 of a bezier with y(1) = 1 (fraction of the amplitude), sampled finely. */
export function bezierOvershoot(b) {
  const f = cubicBezier(b[0], b[1], b[2], b[3]);
  let mx = 0;
  for (let i = 0; i <= 20000; i++) mx = Math.max(mx, f(i / 20000));
  return Math.max(0, mx - 1);
}

// ------------------------------------------------------------------------------------------------ writing
/** `write` knob (design section 11): full | q3 | q2 decimals. */
export function quant(v, mode) {
  if (mode === 'q3') return Number(v.toFixed(3));
  if (mode === 'q2') return Number(v.toFixed(2));
  return v;
}

/** Time-based tween state -> value at `now` (ms). done once p >= 1 (the final write is exactly `to`). */
export function tweenAt(tw, now) {
  const p = (now - tw.t0) / tw.D;
  if (p >= 1) return { v: tw.to, p: 1, done: true };
  const pp = p < 0 ? 0 : p;
  return { v: tw.from + (tw.to - tw.from) * tw.ease(pp), p: pp, done: false };
}

// ------------------------------------------------------------------------------------------------ stagger
/** Delay rank of the element with DOM (row-major) index i in a cols x rows grid. */
export function staggerIndex(order, i, cols, rows) {
  const r = Math.floor(i / cols), c = i % cols;
  if (order === 'dom') return i;
  if (order === 'reverse') return cols * rows - 1 - i;
  if (order === 'column') return c * rows + r;
  throw new Error('unknown stagger order ' + order);
}
/** Keys that produce the same delay order as `order` for a cols x rows grid (design section 9). */
export function equivalentKeys(order) {
  if (order === 'dom') return ['dom-index', 'row-major'];
  if (order === 'reverse') return ['reverse-dom-index'];
  if (order === 'column') return ['column-major'];
  return [];
}

// ------------------------------------------------------------------------------------------------ geometry shared by pages and refsim
export const VIEW = { w: 1280, h: 800 };
/** M06 consumers of --e (design: translate, rotate via calc; no scale, so the matrix read-back floor matches the planted-value floor). */
export const M06_MAP = { tx: 240, rot: 14, opA: 0.25 };
/** M11 view-timeline subject (fixed so that the three scroll traces stay valid for every parameter vector). */
export const M11_GEO = { Y: 1400, H: 200 };
/** M12 grid: 3 columns x 2 rows, bars start at CSS translateY(rise) and opacity 0. */
export const M12_GEO = { cols: 3, rows: 2, rise: 28 };
/** M15 circle. */
export const M15_GEO = { cy: 60, r: 18, baseX: 40 };
/** M17 states: A -> B per group (px). */
export const M17_GEO = {
  g0: { A: { x: 100, y: 120, w: 120, h: 80 }, B: { x: 520, y: 300, w: 260, h: 140 } },
  g1: { A: { x: 100, y: 420, w: 60, h: 60 }, B: { x: 340, y: 520, w: 60, h: 60 } },
};
/** M18 states (px). */
export const M18_GEO = { A: { x: 100, y: 120, w: 160, h: 100 }, B: { x: 540, y: 300, w: 320, h: 180 } };

// ------------------------------------------------------------------------------------------------ defaults and grids (routes.json is generated from these)
const BZ = {
  soft: [0.25, 0.8, 0.25, 1],       // G1-4 7.2 M06 per-segment bezier (a generic shape, not a captured-site value)
  snap: [0.2, 0.9, 0.1, 1],         // G1-4 7.2 M12
  std: [0.45, 0.05, 0.3, 1],        // a standard-looking ease-in-out of this lab's own (not a captured-site curve)
};
export const DEFAULTS = {
  // hold = fraction of the declared duration spent flat before the visible motion (0 = control: no hold)
  m06: { D: 1500, hold: 0.6, bz: BZ.soft, base: 12, step: 30, n: 6 },
  m11: { r0: 10, r1: 70, ease: BZ.std, amp: 300 },
  m12: { step: 90, order: 'dom', du: 500, bz: BZ.snap, N: 4800, cD: 950, char: 24, text: 'Measure the motion, not the pixels.' },
  m15: { dur: 1997, from: 0, to: 420, delay: 1000.3, spline: null },
  m17: { d0: 600, e0: BZ.snap, d1: 400, e1: 'linear' },
  m18: { impl: 'waapi', D: 600, bz: BZ.snap },
  m19: { from: 0, to: 360, D: 700, ease: 'easeOutCubic', delay: 403.7, to2: 90, D2: 500, write: 'full' },
  m16e: { from: 0, to: 420, D: 1400, ease: 'easeOutExpo', write: 'full' },
  m16f: { from: 0, to: 400, D: 880, bz: [0.34, 1.517, 0.64, 1], write: 'full' },
};
export const GRIDS = {
  m06: [
    { D: 1500, hold: 0.6, bz: BZ.soft, base: 12, step: 30 },
    { D: 1200, hold: 0.45, bz: [0.3, 0.7, 0.2, 1], base: 12, step: 30 },
    { D: 1800, hold: 0.35, bz: [0.2, 0.9, 0.3, 1], base: 12, step: 45 },
    { D: 1000, hold: 0.7, bz: [0.35, 0.6, 0.15, 1], base: 12, step: 30 },
    { D: 1500, hold: 0, bz: BZ.soft, base: 12, step: 30 },   // the no-hold control
  ],
  m11: [
    { r0: 10, r1: 70, ease: BZ.std, amp: 300 },
    { r0: 20, r1: 80, ease: 'linear', amp: 260 },
    { r0: 0, r1: 60, ease: [0.65, 0, 0.35, 1], amp: 340 },
    { r0: 25, r1: 75, ease: [0.1, 0.9, 0.35, 1], amp: 280 },
    { r0: 5, r1: 55, ease: 'linear', amp: 320 },
  ],
  m12: [
    { step: 90, order: 'dom', du: 500, bz: BZ.snap, N: 4800, cD: 950, char: 24 },
    { step: 60, order: 'reverse', du: 650, bz: [0.3, 0.8, 0.2, 1], N: 3600, cD: 1100, char: 30 },
    { step: 120, order: 'column', du: 400, bz: [0.25, 1, 0.5, 1], N: 5200, cD: 750, char: 20 },
    { step: 45, order: 'dom', du: 550, bz: [0.2, 0.9, 0.1, 1], N: 2400, cD: 1000, char: 36 },
    { step: 75, order: 'reverse', du: 450, bz: [0.4, 0.9, 0.2, 1], N: 6400, cD: 800, char: 28 },
  ],
  m15: [
    { dur: 1997, from: 0, to: 420, delay: 1000.3, spline: null },
    { dur: 1403, from: 40, to: 380, delay: 700.7, spline: null },
    { dur: 2999, from: 0, to: 500, delay: 1200.1, spline: null },
    { dur: 1811, from: 0, to: 440, delay: 910.9, spline: [0.45, 0.05, 0.3, 1] },
    { dur: 2399, from: 20, to: 460, delay: 800.5, spline: [0.2, 0.8, 0.2, 1] },
  ],
  m17: [
    { d0: 600, e0: BZ.snap, d1: 400, e1: 'linear' },
    { d0: 450, e0: [0.45, 0.05, 0.3, 1], d1: 700, e1: [0.3, 0.8, 0.2, 1] },
    { d0: 800, e0: [0.65, 0, 0.35, 1], d1: 500, e1: [0.2, 0.9, 0.1, 1] },
    { d0: 350, e0: 'linear', d1: 550, e1: [0.45, 0.05, 0.3, 1] },
    { d0: 700, e0: [0.25, 1, 0.5, 1], d1: 300, e1: [0.65, 0, 0.35, 1] },
  ],
  m18: [
    { impl: 'waapi', D: 600, bz: BZ.snap },
    { impl: 'waapi', D: 450, bz: [0.45, 0.05, 0.3, 1] },
    { impl: 'raf', D: 600, bz: BZ.snap },
    { impl: 'raf', D: 750, bz: [0.3, 0.8, 0.2, 1] },
    { impl: 'raf', D: 500, bz: [0.65, 0, 0.35, 1] },
  ],
  m19: [
    { from: 0, to: 360, D: 700, ease: 'easeOutCubic', delay: 403.7, to2: 90, D2: 500 },
    { from: 40, to: 380, D: 950, ease: 'easeInOutQuad', delay: 211.3, to2: 120, D2: 600 },
    { from: 0, to: 300, D: 600, ease: 'easeOutExpo', delay: 507.1, to2: 40, D2: 450 },
    { from: 20, to: 400, D: 1100, ease: 'easeInOutCubic', delay: 320.9, to2: 200, D2: 700 },
    { from: 0, to: 340, D: 800, ease: 'easeOutQuart', delay: 156.4, to2: 60, D2: 550 },
  ],
  m16e: [
    { from: 0, to: 420, D: 1400, ease: 'easeOutExpo' },
    { from: 0, to: 360, D: 1200, ease: 'easeOutQuint' },
    { from: 20, to: 400, D: 1600, ease: 'easeOutQuart' },
    { from: 0, to: 380, D: 1000, ease: 'easeOutCubic' },
    { from: 10, to: 440, D: 1800, ease: 'easeOutExpo' },
  ],
  // overshoot targets 5.5, 7.0, 8.5, 10.0, 11.5 percent (solved in tools/solve-overshoot.mjs, asserted in test/core.test.js)
  m16f: [
    { from: 0, to: 420, D: 800, bz: [0.34, 1.408, 0.64, 1] },
    { from: 0, to: 380, D: 700, bz: [0.34, 1.465, 0.64, 1] },
    { from: 0, to: 400, D: 880, bz: [0.34, 1.517, 0.64, 1] },
    { from: 20, to: 440, D: 750, bz: [0.34, 1.567, 0.64, 1] },
    { from: 0, to: 360, D: 850, bz: [0.34, 1.615, 0.64, 1] },
  ],
};
/** Continuous-parameter boxes for the confirmation draws (design / A1.6 i): name -> [lo, hi]. */
export const BOXES = {
  m06: { D: [1000, 1800], hold: [0.3, 0.7], step: [30, 45] },
  m11: { r0: [0, 25], r1: [55, 80], amp: [260, 340] },
  m12: { step: [45, 120], du: [400, 650], cD: [750, 1100], char: [20, 36] },
  m15: { dur: [1400, 3000], delay: [700, 1250] },
  m17: { d0: [350, 800], d1: [300, 700] },
  m18: { D: [450, 750] },
  m19: { D: [600, 1100], delay: [156, 508], D2: [450, 700] },
  m16e: { D: [1000, 1800] },
  m16f: { D: [700, 880] },
};
