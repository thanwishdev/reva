// REVA export — reference curves, sampling, error metric and the CSS linear() builder.
// Every curve here is a function of time in ms (or of progress p in [0,1]) that returns progress of the travel:
// 0 = start value, 1 = target. Errors are reported as a fraction of the travel, so "1 %" means 1 % of |target − start|.
import { parseEasing } from '../analysis/fit/eases.js';

/**
 * Analytic damped spring step response, normalised.
 * omega (rad/s), zeta, v0n = initial velocity in travel units/s (positive = towards the target).
 * Returns p(tMs) with p(0) = 0, p(∞) = 1.
 */
export function springProgress(omega, zeta, v0n = 0) {
  const w = -v0n;                      // e = 1 − p, e(0) = 1, e'(0) = −v0n
  if (zeta < 1 - 1e-9) {
    const wd = omega * Math.sqrt(1 - zeta * zeta), B = (w + zeta * omega) / wd;
    return (tMs) => { const t = tMs / 1000; return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + B * Math.sin(wd * t)); };
  }
  if (zeta <= 1 + 1e-9) return (tMs) => { const t = tMs / 1000; return 1 - Math.exp(-omega * t) * (1 + (w + omega) * t); };
  const s = Math.sqrt(zeta * zeta - 1), r1 = -omega * (zeta - s), r2 = -omega * (zeta + s), C2 = (w - r1) / (r2 - r1), C1 = 1 - C2;
  return (tMs) => { const t = tMs / 1000; return 1 - (C1 * Math.exp(r1 * t) + C2 * Math.exp(r2 * t)); };
}

/** First-order smoothing (EMA / dt-damp) step response with time constant tauMs: p = 1 − e^(−t/τ). */
export const emaProgress = (tauMs) => (tMs) => 1 - Math.exp(-tMs / tauMs);

/**
 * Time after which |1 − p(t)| stays ≤ tol (searched on a 1 ms grid up to maxMs).
 * Used as the duration of a sampled spring (CSS linear(), GSAP CustomEase).
 */
export function settleMs(p, tol = 0.001, maxMs = 20000) {
  let last = 0;
  for (let t = 0; t <= maxMs; t += 1) if (Math.abs(1 - p(t)) > tol) last = t;
  return last + 1;
}

/**
 * Max |a − b| over n+1 evenly spaced points on [0, spanMs]; returns {max, atMs}.
 * a, b are functions of time in ms returning progress.
 */
export function maxError(a, b, spanMs, n = 4000) {
  let max = 0, atMs = 0;
  for (let i = 0; i <= n; i++) { const t = (spanMs * i) / n; const e = Math.abs(a(t) - b(t)); if (e > max) { max = e; atMs = t; } }
  return { max, atMs };
}

/** Accuracy label from a measured error. `exactTol` covers printed-decimal rounding only (default 0.05 % of travel). */
export function accuracy(err, exactTol = 5e-4, unit = 'ms') {
  if (err == null) return { label: 'not representable', maxErrorPct: null, atMs: null };
  const pct = err.max * 100;
  if (err.max <= exactTol) return { label: 'exact', maxErrorPct: round(pct, 4), atMs: round(err.atMs, 1) };
  return { label: `approx (max error ${fmtPct(pct)} % of travel, at ${Math.round(err.atMs)} ${unit})`, maxErrorPct: round(pct, 4), atMs: round(err.atMs, 1) };
}
export const notRepresentable = (lib, why) => ({ label: `not representable in ${lib}`, why, maxErrorPct: null, atMs: null });

export const sig = (x, n = 6) => Number(Number(x).toPrecision(n));
export const round = (x, d = 3) => { const k = 10 ** d; const r = Math.round(x * k) / k; return Object.is(r, -0) ? 0 : r; };
const fmtPct = (pct) => (pct >= 0.1 ? pct.toFixed(2) : pct.toPrecision(2));

/** Ramer–Douglas–Peucker on points [{x,y}] with vertical (y) distance, keeps endpoints. */
export function rdpVertical(pts, tol) {
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop(); const a = pts[i0], b = pts[i1]; let worst = -1, wi = -1;
    for (let i = i0 + 1; i < i1; i++) { const p = pts[i]; const yl = a.y + ((b.y - a.y) * (p.x - a.x)) / (b.x - a.x); const d = Math.abs(p.y - yl); if (d > worst) { worst = d; wi = i; } }
    if (worst > tol) { keep[wi] = 1; stack.push([i0, wi], [wi, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Build a CSS `linear()` easing that reproduces progress function p(tMs) over [0, durationMs] within maxErr
 * (fraction of travel). The curve ends exactly at 1 (the CSS end value), so the truncation at durationMs is part
 * of the measured error. Returns {css, stops:[{x,y}], durationMs, err:{max, atMs}} where err is measured by parsing
 * the emitted string back (reusing the fitter's own linear() parser) and comparing on a dense grid.
 */
export function buildLinear(p, durationMs, maxErr = 0.01) {
  const N = Math.min(40000, Math.max(1000, Math.ceil(durationMs / 0.25))); const dense = [];   // ≥ 4 samples per ms
  for (let i = 0; i <= N; i++) dense.push({ x: i / N, y: i === N ? 1 : p((durationMs * i) / N) });
  dense[0].y = 0;
  // Decimals of the % positions: rounding a position by 10^-xd % of the duration must move the curve by ≤ maxErr/4.
  let slope = 0; for (let i = 1; i <= N; i++) slope = Math.max(slope, Math.abs(dense[i].y - dense[i - 1].y) * N);   // per unit x
  const xd = Math.min(6, Math.max(2, Math.ceil(Math.log10((slope / 100) / (maxErr / 4)))));
  let tol = maxErr * 0.6, best = null;
  for (let iter = 0; iter < 12; iter++) {
    const stops = rdpVertical(dense, tol).map((s) => ({ x: round(s.x * 100, xd), y: round(s.y, 4) }));
    const css = `linear(${stops.map((s, i) => (i === 0 ? '0' : i === stops.length - 1 ? '1' : `${s.y} ${s.x}%`)).join(', ')})`;
    const fn = parseEasing(css);
    const err = maxError((t) => fn(t / durationMs), (t) => (t >= durationMs ? 1 : p(t)), durationMs, Math.max(8000, 2 * N));
    best = { css, stops, durationMs, err };
    if (err.max <= maxErr) return best;
    tol *= 0.6;
  }
  return best;
}

/** GSAP CustomEase path from linear stops (straight cubic segments, so it draws the same polyline). */
export function customEasePath(stops) {
  const pts = stops.map((s) => [s.x / 100, s.y]);
  let d = `M0,0`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const c = (k) => `${round(x0 + ((x1 - x0) * k) / 3, 4)},${round(y0 + ((y1 - y0) * k) / 3, 4)}`;
    d += ` C${c(1)} ${c(2)} ${round(x1, 4)},${round(y1, 4)}`;
  }
  return d;
}
