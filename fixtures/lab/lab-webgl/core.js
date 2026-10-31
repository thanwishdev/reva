// Fixture Lab group D (WebGL / canvas / pointer / negatives / composites): pure math shared by the pages and by
// refsim.mjs. No DOM, no globals except btoa/atob/TextEncoder (present in browsers and Node). Design: docs/design/M2-fitter.md §11.
//
// Every number a route reads comes from DEFAULTS[route] merged with the JSON in `location.hash` (#p=<base64url JSON>).
// Own parameters only (design §11): no value from a captured site is used anywhere in this folder.

export const VIEWPORT = { width: 1280, height: 800 };

// ---------------------------------------------------------------------------------------------------------------- params
export const DEFAULTS = {
  // pointer follow: law 'frame' = per-frame lerp (alpha per page frame), 'dt' = dt-aware (lambda per second)
  m13: { law: 'frame', alpha: 0.10, lambda: 8, snap: 0.01, write: 'full' },
  // camera angle driven by scroll through a dt-capped spring (mode 'spring') or by the wall clock (mode 'orbit')
  m14: { mode: 'spring', zeta: 0.45, lag: 0.8, gain: 0.0012, capMs: 1000 / 30, orbitRate: 0.0005, snapV: 1e-4, snapX: 1e-5 },
  m14b: { mode: 'spring', zeta: 0.45, lag: 0.8, gain: 0.0012, capMs: 1000 / 30, orbitRate: 0.0005, snapV: 1e-4, snapX: 1e-5 },
  m16a: { x: 120, y: 60, opacity: 1 },
  m16b: { seed: 11, base: 200, amp: 6 },
  m16c: { speed: 300, gain: 0.6, max: 600 },
  m16d: { amp: 140, threshold: 200 },
  m20: { alpha: 0.14, snap: 0.01, scrollGain: 0.25, scrollMax: 1200, k: 210, c: 11, hMs: 16, amp1: 160, tickOffsetMs: 350, tweenMs: 700, tweenAmp: 200, write: 'full' },
  m21: { durMs: 750, gain: 0.5, max: 700, write: 'full' },
  m22: { alpha: 0.16, snap: 0.05, gain: 0.5, max: 700, durMs: 420, ease: [0.31, 0.12, 0.18, 0.97], write: 'full' },
};

export function encodeParams(o) {
  const s = JSON.stringify(o);
  const bin = Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join('');
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeParams(str) {
  const b = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}
/** Parameters of a route: defaults overridden by `#p=<base64url JSON>` (page side) or by an object (refsim side). */
export function parseParams(route, hashOrObject) {
  let over = {};
  if (typeof hashOrObject === 'string') {
    const m = /(?:^#|&)p=([A-Za-z0-9_-]+)/.exec(hashOrObject);
    if (m) over = decodeParams(m[1]);
  } else if (hashOrObject) over = hashOrObject;
  return { ...DEFAULTS[route], ...over };
}

/** `write` knob: quantise the value a page writes (internal state stays unquantised). */
export const quant = (v, mode) => (mode === 'q3' ? Math.round(v * 1e3) / 1e3 : mode === 'q2' ? Math.round(v * 1e2) / 1e2 : v);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);

/** Seeded PRNG (the standard mulberry32 recurrence). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------------------------------------------------- smoothing
/** One per-frame lerp step. */
export const lerp1 = (x, g, alpha) => x + (g - x) * alpha;
/** One dt-aware step; lambda in 1/s, dt in ms. */
export const damp = (x, g, lambda, dtMs) => x + (g - x) * (1 - Math.exp((-lambda * dtMs) / 1000));

/** Pointer follow (M13). s = {x,y}, g = {x,y}. Both axes share the law. */
export function followStep(s, g, P, dtMs) {
  if (P.law === 'dt') { s.x = damp(s.x, g.x, P.lambda, dtMs); s.y = damp(s.y, g.y, P.lambda, dtMs); }
  else { s.x = lerp1(s.x, g.x, P.alpha); s.y = lerp1(s.y, g.y, P.alpha); }
  if (Math.abs(g.x - s.x) < P.snap) s.x = g.x;
  if (Math.abs(g.y - s.y) < P.snap) s.y = g.y;
}

/** Slew limiter (M16c): moves toward g at constant speed (px/s), never faster. */
export function slewStep(x, g, speedPxPerS, dtMs) {
  const m = (speedPxPerS * dtMs) / 1000;
  return x + clamp(g - x, -m, m);
}

// -------------------------------------------------------------------------------------------------------------- springs
/** Spring constants from the user-facing (zeta, lag) pair: omega = 2.9 / lag (the ElasticGridScroll pattern). */
export function springConsts(zeta, lagS) {
  const omega = 2.9 / lagS;
  return { omega, zeta, k: omega * omega, c: 2 * zeta * omega };
}
/** I7: semi-implicit Euler, one step of min(dt, cap) per frame. s = {x, v}. */
export function springI7(s, g, k, c, dtMs, capMs) {
  const h = Math.min(dtMs, capMs) / 1000;
  s.v += (-k * (s.x - g) - c * s.v) * h;
  s.x += s.v * h;
}
/** I1(h): semi-implicit Euler in fixed substeps of at most hMs, with a remainder substep. */
export function springI1(s, g, k, c, dtMs, hMs) {
  let o = dtMs;
  while (o > 0) {
    const stepMs = Math.min(o, hMs);
    const h = stepMs / 1000;
    s.v += (-k * (s.x - g) - c * s.v) * h;
    s.x += s.v * h;
    o -= stepMs;
  }
}

// ---------------------------------------------------------------------------------------------------------------- easing
export const easeOutQuart = (p) => 1 - Math.pow(1 - p, 4);
export const expoOut = (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
/**
 * CSS cubic-bezier(x1, y1, x2, y2) as a function of time fraction (solved to ~1e-12; browsers solve to ~1e-7).
 * Own implementation (no import from src/).
 */
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
    for (let i = 0; i < 10; i++) {
      const e = X(t) - x;
      if (Math.abs(e) < 1e-13) return Y(t);
      const d = dX(t);
      if (Math.abs(d) < 1e-9) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 80; i++) {
      const e = X(t) - x;
      if (Math.abs(e) < 1e-13) break;
      if (e > 0) hi = t; else lo = t;
      t = (lo + hi) / 2;
    }
    return Y(t);
  };
}

/** A restartable time-based tween: {from, to, t0, dur, ease}. */
export const tweenAt = (tw, now) => (tw.dur <= 0 ? tw.to : tw.from + (tw.to - tw.from) * tw.ease(clamp01((now - tw.t0) / tw.dur)));

// --------------------------------------------------------------------------------------------------------- camera (M14)
/** Scene constants shared by the GL shader (injected as literals), the 2D painter and the analytic projection. */
export const CAM = {
  dist: 6.2, height: 2.2, look: [0, 0.3, 0], fovY: (45 * Math.PI) / 180, near: 0.1, far: 50,
  W: 800, H: 500,                                         // canvas size in CSS px (DPR 1)
  left: 240, top: 150,                                    // canvas position in the viewport
  markers: { m: { pos: [1.4, 0.9, 0.3], rgb: [255, 0, 255] }, n: { pos: [-1.1, 0.6, -1.3], rgb: [255, 191, 0] } },
  markerPx: 20,                                           // sprite size in px (disc radius 10)
};

/** Analytic projection of a world point for a camera orbiting the Y axis at `angle`; returns canvas px, y down. */
export function project(pos, angle, cam = CAM) {
  const eye = [cam.dist * Math.sin(angle), cam.height, cam.dist * Math.cos(angle)];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
  const f = norm(sub(cam.look, eye));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const d = sub(pos, eye);
  const vx = dot(d, r), vy = dot(d, u), vz = dot(d, f);
  const foc = 1 / Math.tan(cam.fovY / 2);
  const ndcX = (vx * foc / (cam.W / cam.H)) / vz, ndcY = (vy * foc) / vz;
  return { x: (ndcX * 0.5 + 0.5) * cam.W, y: (0.5 - ndcY * 0.5) * cam.H, depth: vz };
}
/** Same point in viewport CSS px (canvas offset added): what the pixel channel reports. */
export function projectViewport(pos, angle, cam = CAM) {
  const p = project(pos, angle, cam);
  return { x: cam.left + p.x, y: cam.top + p.y, depth: p.depth };
}

/** Camera angle driver shared by M14 and M14b: mode 'spring' tracks gain*scrollY, mode 'orbit' is the wall clock. */
export function cameraTarget(P, scrollY) { return scrollY * P.gain; }
