// Vendored from understudy 0.3.0 (@amabush/understudy, https://github.com/Amir-Abushanab/understudy),
// src/analyze/bezier.ts (sha256 0415174615c1e968d927e98f06e6ae7579ba0327d1033995c5bdcc251ff7212b).
// MIT License, Copyright (c) 2026 understudy contributors — full text in ./LICENSE.
// Port: TypeScript types removed; logic unchanged. REVA uses `fitCubicBezier` only as one multi-start seed on
// normalised progress; the real fit (free onset t0, duration, value units, LM polish) is in ../../tween.js, because
// this fitter fixes t = 0 at the first sample, which biases the result (SYN §5.2).
import { nelderMead } from './optimize.js';

/**
 * Evaluate a cubic-bezier easing at time fraction `t` in [0, 1]. Inverts X(s)=t with Newton plus a bisection
 * fallback, then reads Y(s). Matches the WebKit UnitBezier reference implementation.
 * @param {[number,number,number,number]} control
 * @param {number} t
 */
export function evalCubicBezier(control, t) {
  const [x1, y1, x2, y2] = control;
  if (t <= 0) return 0;
  if (t >= 1) return 1;

  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (s) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s) => ((ay * s + by) * s + cy) * s;
  const sampleDX = (s) => (3 * ax * s + 2 * bx) * s + cx;

  let s = t;
  for (let i = 0; i < 8; i++) {
    const d = sampleX(s) - t;
    if (Math.abs(d) < 1e-6) return sampleY(s);
    const dx = sampleDX(s);
    if (Math.abs(dx) < 1e-6) break;
    s -= d / dx;
  }
  let lo = 0;
  let hi = 1;
  s = t;
  for (let i = 0; i < 32; i++) {
    const xs = sampleX(s);
    if (Math.abs(xs - t) < 1e-6) break;
    if (t > xs) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return sampleY(s);
}

/** Normalize raw progress samples to fit-ready (x in [0,1] time fraction, y = progress). */
function normalize(samples) {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const tMax = sorted.length > 0 ? sorted[sorted.length - 1].t : 0;
  if (tMax <= 0) return [];
  // Drop the trivial endpoints where every easing agrees; they carry no shape info.
  return sorted.map((sample) => ({ x: sample.t / tMax, y: sample.p })).filter((point) => point.x > 0 && point.x < 1);
}

/**
 * Fit a cubic-bezier easing to sampled progress {t, p}. Tries several starting curves and keeps the best simplex
 * result, because the error surface has shallow local minima.
 */
export function fitCubicBezier(samples) {
  const points = normalize(samples);
  if (points.length < 4) {
    // Not enough shape to trust; report linear with a deliberately poor residual.
    return { control: [0.25, 0.25, 0.75, 0.75], residual: 1, sampleCount: points.length };
  }

  const objective = (c) => {
    const [x1, y1, x2, y2] = c;
    // X control points must stay in [0,1] for the easing to be a function of time.
    if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return Number.POSITIVE_INFINITY;
    let sse = 0;
    for (const point of points) {
      const err = evalCubicBezier(c, point.x) - point.y;
      sse += err * err;
    }
    return sse + penaltyOutside(y1) + penaltyOutside(y2);
  };

  const starts = [
    [0.25, 0.25, 0.75, 0.75], // linear-ish
    [0.42, 0, 0.58, 1], // ease-in-out
    [0, 0, 0.58, 1], // ease-out
    [0.42, 0, 1, 1], // ease-in
    [0.33, 1, 0.68, 1], // ease-out-cubic
  ];

  let best = { x: starts[0], fx: Number.POSITIVE_INFINITY };
  for (const start of starts) {
    const result = nelderMead(objective, start, { initialStep: 0.08, maxIterations: 500 });
    if (result.fx < best.fx) best = { x: result.x, fx: result.fx };
  }

  const control = [clamp01(best.x[0]), best.x[1], clamp01(best.x[2]), best.x[3]];
  const residual = Math.sqrt(best.fx / points.length);
  return { control, residual, sampleCount: points.length };
}

/** RMS residual of a known easing curve against sampled progress. */
export function bezierResidual(control, samples) {
  const points = normalize(samples);
  if (points.length === 0) return 1;
  let sse = 0;
  for (const point of points) {
    const err = evalCubicBezier(control, point.x) - point.y;
    sse += err * err;
  }
  return Math.sqrt(sse / points.length);
}

/** Euclidean distance between two easing curves' control points. */
export function controlDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

const Y_LOW = -0.75;
const Y_HIGH = 1.75;
const Y_PENALTY_WEIGHT = 8;

function penaltyOutside(y) {
  if (y < Y_LOW) return Y_PENALTY_WEIGHT * (Y_LOW - y) ** 2;
  if (y > Y_HIGH) return Y_PENALTY_WEIGHT * (y - Y_HIGH) ** 2;
  return 0;
}

/** A cubic-bezier that reads as a real easing: X in [0,1], Y within a band. */
export function isSaneEasing(control) {
  const [x1, y1, x2, y2] = control;
  return x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1 && y1 >= -1 && y1 <= 2 && y2 >= -1 && y2 <= 2;
}

/** Round bezier control points for stable, readable emission. */
export function roundControl(control, places = 2) {
  const factor = 10 ** places;
  return control.map((v) => Math.round(v * factor) / factor);
}
