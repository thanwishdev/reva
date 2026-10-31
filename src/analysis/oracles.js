// Generic analytic oracles used by the recorder's gates (own code; the same formulas as the W2G1-2 research).
// Nothing site-specific lives here (PLAN H2): site oracles stay in private storage.
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t, dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1; let t = x;
    for (let i = 0; i < 8; i++) { const e = sx(t) - x; if (Math.abs(e) < 1e-10) return sy(t); const d = dx(t); if (Math.abs(d) < 1e-7) break; t -= e / d; }
    let lo = 0, hi = 1; t = x; for (let i = 0; i < 80; i++) { const v = sx(t); if (Math.abs(v - x) < 1e-12) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sy(t);
  };
}
export const clamp01 = (v) => Math.max(0, Math.min(1, v));
/** Unit step response of a damped spring (k, c, m), x(0)=0, v(0)=0, target 1. */
export function springClosed(K, C, M, t) {
  const w0 = Math.sqrt(K / M), z = C / (2 * Math.sqrt(K * M)); if (t <= 0) return 0;
  if (z < 1) { const wd = w0 * Math.sqrt(1 - z * z); return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + (z * w0 / wd) * Math.sin(wd * t)); }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}
/** Underdamped spring from (x0, v0 px/s) toward tgt; returns {x, v}. */
export function springFrom(K, C, M, x0, v0, tgt, t) {
  const w0 = Math.sqrt(K / M), z = C / (2 * Math.sqrt(K * M)), wd = w0 * Math.sqrt(1 - z * z);
  const d = x0 - tgt, A = d, B = (v0 + z * w0 * d) / wd, e = Math.exp(-z * w0 * t);
  const cs = Math.cos(wd * t), sn = Math.sin(wd * t);
  return { x: tgt + e * (A * cs + B * sn), v: e * ((-z * w0) * (A * cs + B * sn) + (-A * wd * sn + B * wd * cs)) };
}
export const expoOut = (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
export function stats(a) {
  a = a.filter(Number.isFinite); if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { n: a.length, min: s[0], p05: q(0.05), median: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: a.reduce((x, y) => x + y, 0) / a.length };
}
/** Linear interpolation of points [{x, y}] sorted by x. */
export function interp(pts, x) {
  if (!pts.length) return NaN; if (x <= pts[0].x) return pts[0].y; const n = pts.length - 1; if (x >= pts[n].x) return pts[n].y;
  let lo = 0, hi = n; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].x <= x) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi], d = b.x - a.x; return d === 0 ? a.y : a.y + (b.y - a.y) * (x - a.x) / d;
}
