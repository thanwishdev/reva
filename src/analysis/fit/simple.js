// Simple classes (design §4.8): static, step, ramp, periodic; friction/inertia (§4.4); `unexplained` RDP linear().
import { fitModel } from './model.js';
import simplify from './vendor/simplify-js/simplify.js';
import { median } from './numeric.js';

/** One-frame change: all motion inside one frame interval. Params: tStep (between frames), before, after. */
export function fitStep(w, sigma) {
  const { T, y } = w; let bi = 1, best = -1;
  for (let i = 1; i < y.length; i++) { const d = Math.abs(y[i] - y[i - 1]); if (d > best) { best = d; bi = i; } }
  const spec = [{ name: 'before' }, { name: 'after' }];
  const f = (p, X) => X.map((t) => (t < T[bi] ? p[0] : p[1]));
  const r = fitModel({ family: 'step', cls: 'step', T, y, spec, f, starts: [[y[bi - 1], y[bi]]], sigma });
  if (r) { r.stepAt = [T[bi - 1], T[bi]]; r.derived = { t0: T[bi - 1], stepWindow: [T[bi - 1], T[bi]] }; }
  return r;
}

/** Constant velocity between free onset and end (ramp). */
export function fitRamp(w, sigma) {
  const { T, y } = w; const from = w.from ?? y[0], to = w.to ?? y.at(-1);
  const spec = [{ name: 't0', lo: w.tMin, hi: w.tMax, scale: w.dt, unit: 'ms' }, { name: 'D', lo: w.dt * 0.5, hi: 1e6, scale: w.D, unit: 'ms' }, { name: 'from' }, { name: 'to' }];
  const f = (p, X) => X.map((t) => p[2] + (p[3] - p[2]) * Math.max(0, Math.min(1, (t - p[0]) / p[1])));
  const r = fitModel({ family: 'ramp', cls: 'ramp', T, y, spec, f, starts: [[w.t0, w.D, from, to]], sigma });
  if (r) r.derived = { t0: r.p[0], velocity: ((r.p[3] - r.p[2]) / r.p[1]) * 1000 };
  return r;
}

/** Periodic tick: repeated equal steps at a constant period (e.g. a 1 Hz counter). */
export function fitPeriodic(s, sigma) {
  const ch = []; for (let i = 1; i < s.y.length; i++) if (Math.abs(s.y[i] - s.y[i - 1]) > sigma * 3) ch.push(i);
  if (ch.length < 3) return null;
  const gaps = ch.slice(1).map((c, j) => s.T[c] - s.T[ch[j]]); const P = median(gaps);
  // a tick lands on the first frame at or after its due time: its spacing varies by up to the LONGEST frame period of
  // the take (an R5 stall frame is 100 ms), not the first frame period
  let maxDt = 0; for (let i = 1; i < s.T.length; i++) maxDt = Math.max(maxDt, s.T[i] - s.T[i - 1]);
  if (!(P > 0) || gaps.some((g) => Math.abs(g - P) > Math.max(1.01 * maxDt, 0.02 * P))) return null;
  // each change is a single-frame step (tick), not a tween
  const multi = ch.filter((c, j) => j && c === ch[j - 1] + 1).length; if (multi > ch.length * 0.2) return null;
  return { family: 'periodic', cls: 'periodic', params: { period: { value: P, unit: 'ms', ci95: [P - (s.T[1] - s.T[0]), P + (s.T[1] - s.T[0])] }, ticks: { value: ch.length, unit: null, ci95: null } },
    n: s.y.length, k: 2, rss: 0, rms: 0, derived: { t0: s.T[ch[0] - 1], period: P } };
}

/** Friction / inertia (design §4.4): per-frame or dt-aware geometric velocity decay, stop below εv. */
export function fitFriction(w, sigma, law = 'per-frame', { freeStart = false } = {}) {
  const { T, y } = w; const x0 = w.from ?? y[0];
  const b = T.findIndex((t, i) => i && Math.abs(y[i] - y[i - 1]) > sigma * 3); if (b < 1) return null;
  let e = y.length - 1; while (e > b && y[e] === y[e - 1]) e--;   // last frame with any change (stop rule |v| < εv)
  // freeStart: the decay's virtual start position at the sample before the onset is a parameter (lab case M10 at R6:
  // the release lands on an unsampled page frame, so the first observed step is not a term of the sampled geometric
  // sequence that starts at the resting sample)
  const sim = (p, X) => { const out = []; let x = freeStart ? p[2] : x0, v = p[1]; for (let i = 0; i < X.length; i++) {
    const t = X[i]; if (t < T[b]) { out.push(x0); continue; }
    // at a stride the stop (|v| < εv) can land on an unsampled page frame: the last moving sample is partial and the
    // stop position is a parameter (lab case M10 at R6)
    if (freeStart && t >= T[e]) { out.push(p[3]); continue; }
    if (t > T[e]) { out.push(x); continue; }
    const dtf = law === 'dt-aware' ? (60 * (t - (i ? X[i - 1] : t))) / 1000 : 1;
    if (t > T[b]) v = law === 'dt-aware' ? v * p[0] ** dtf : v * p[0];
    x += v * dtf; out.push(x); } return out; };
  const v0 = y[b] - y[b - 1]; const f0 = e > b + 1 ? Math.min(0.999, Math.max(0.3, (y[b + 2] - y[b + 1]) / (y[b + 1] - y[b] || 1e-9))) : 0.9;
  const spec = [{ name: 'friction', lo: 0.05, hi: 0.99999, scale: 0.01 }, { name: 'v0', scale: Math.abs(v0) || 1, unit: law === 'dt-aware' ? 'value/(1/60 s)' : 'value/frame' }, ...(freeStart ? [{ name: 'xStart', scale: Math.abs(x0) || 1 }, { name: 'xStop', scale: Math.abs(y[e]) || 1 }] : [])];
  const st = (f, v) => (freeStart ? [f, v, x0, y[e]] : [f, v]);
  const r = fitModel({ family: `friction:${law}`, cls: 'friction', T, y, spec, f: sim, starts: [st(f0, v0), st(Math.sqrt(f0), v0), st(Math.min(0.999, f0 * 1.02), v0 * 1.2)], sigma });
  if (r) { const full = sim(r.p, T); r.derived = { t0: T[b - 1], stopT: T[e], stoppingDistance: (freeStart ? r.p[3] : full.at(-1)) - x0, epsV: Math.abs(r.p[1]) * r.p[0] ** (e - b + 1) }; r.law = law; }
  return r;
}

/**
 * `unexplained` fallback (U2): RDP-simplified samples as CSS `linear()` stops at tolerances 0.001·A and 0.01·A.
 * x = normalised time over the window, y = normalised value; simplify-js measures perpendicular distance, so the max
 * vertical error is measured and reported next to each tolerance.
 */
export function linearStops(T, y, tolRel) {
  const t0 = T[0], D = T.at(-1) - t0 || 1, y0 = y[0], A = (Math.max(...y) - Math.min(...y)) || 1;
  const pts = T.map((t, i) => ({ x: (t - t0) / D, y: (y[i] - y0) / A }));
  const sp = simplify(pts, tolRel, true);
  let maxErr = 0; let j = 0;
  for (const p of pts) { while (j < sp.length - 2 && sp[j + 1].x < p.x) j++; const a = sp[j], b = sp[j + 1] || a; const v = b.x === a.x ? a.y : a.y + ((b.y - a.y) * (p.x - a.x)) / (b.x - a.x); maxErr = Math.max(maxErr, Math.abs(v - p.y)); }
  const css = `linear(${sp.map((p) => `${(+(p.y * A / ((y.at(-1) - y0) || A))).toFixed(4)} ${(p.x * 100).toFixed(2)}%`).join(', ')})`;
  return { tol: tolRel, stops: sp.length, maxVerticalErrRel: maxErr, css, durationMs: D, points: sp.map((p) => [p.x, p.y]) };
}
