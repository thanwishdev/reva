// Scroll maps (design §4.7) and smoothing on a driver (§4.5): per-frame EMA, asymmetric EMA, dt-damp, restarted
// tween, none. Driver g_k = map(scrollY at frame k − lag); lag ∈ {0, 1, 2} frames is searched (hx: an input after
// frame k is handled at T_k and its rAF work lands in frame k+1, design §11 / A1.6 g).
import { fitModel } from './model.js';
import { bic as bicOf, ciHalfWidths } from './numeric.js';
import { clamp01 } from '../oracles.js';
import { cubicBezier } from '../oracles.js';
import { NAMED, easeAt } from './eases.js';
import { searchMode, driverSearch, dynSlots, SHAPE_DERIV, EASE_DERIV } from './drivesearch.js';

export const MAP_SHAPES = {
  linear: (u) => u,
  smoothstep: (u) => u * u * (3 - 2 * u),
  smootherstep: (u) => u * u * u * (u * (u * 6 - 15) + 10),
  easeInQuad: NAMED.easeInQuad.fn, easeOutQuad: NAMED.easeOutQuad.fn, easeInOutQuad: NAMED.easeInOutQuad.fn,
  easeInCubic: NAMED.easeInCubic.fn, easeOutCubic: NAMED.easeOutCubic.fn, easeInOutCubic: NAMED.easeInOutCubic.fn,
  easeInQuart: NAMED.easeInQuart.fn, easeOutQuart: NAMED.easeOutQuart.fn, easeInOutQuart: NAMED.easeInOutQuart.fn,
};
const mapAt = (S, a, b, s0, s1, s) => a + b * S(clamp01((s - s0) / (s1 - s0 || 1e-9)));

/**
 * (scroll, value) pairs at the end of every hold (dense-sweep holds, step-response ends). A hold whose response has
 * not settled is extrapolated with Aitken's Δ² when its last increments decay geometrically (exact for an EMA tail);
 * these pairs only seed the map — the map is refined jointly with the dynamics on every frame.
 */
export function settledPairs(s, sy, sigma, thr = sigma * 3) {
  const out = []; const y = s.y;
  for (let i = 3; i < y.length; i++) {
    const end = i === y.length - 1 || sy[i + 1] !== sy[i]; if (!end) continue;
    if (sy[i] !== sy[i - 1] || sy[i - 1] !== sy[i - 2] || sy[i - 2] !== sy[i - 3]) continue;
    const d1 = y[i] - y[i - 1], d2 = y[i - 1] - y[i - 2], d3 = y[i - 2] - y[i - 3];
    // an exact plateau (a snap ended the approach) is settled even when the frame before it jumped
    if (Math.abs(d1) <= thr && (Math.abs(d2) <= thr || d1 === 0)) { out.push({ s: sy[i], y: y[i], i, settled: true }); continue; }
    const r1 = d1 / d2, r2 = d2 / d3;
    if (r1 > 0 && r1 < 0.999 && Math.abs(r1 - r2) <= 0.05 * r1) out.push({ s: sy[i], y: y[i] + (d1 * r1) / (1 - r1), i, settled: false, aitken: true });
  }
  return out;
}

/** Instant-map seeds from every frame (look early exit): each lag 0-2, each shape, on at most 40 distinct offsets. */
function framePairMaps(s, sy, nf) {
  const out = [];
  for (const lag of [0, 1, 2]) {
    const byS = new Map(); for (let k = lag; k < s.y.length; k++) { const x = sy[k - lag]; if (Number.isFinite(x) && !byS.has(x)) byS.set(x, s.y[k]); }
    let pairs = [...byS].map(([x, v]) => ({ s: x, y: v })).sort((a, b) => a.s - b.s);
    if (pairs.length > 40) { const st = (pairs.length - 1) / 39; pairs = Array.from({ length: 40 }, (_, i) => pairs[Math.round(i * st)]); }
    if (pairs.length < 3) continue;
    for (const sh of Object.keys(MAP_SHAPES)) { const m = fitMapShape(sh, pairs, nf.sigma, { gridN: 32 }); if (m && Math.sqrt(m.rss / pairs.length) <= nf.explainBar) out.push(m); }
  }
  return out.sort((a, b) => a.rss - b.rss).slice(0, 6);
}

/** Fit a static scroll map of one shape to (s, y) pairs, profiling s0, s1 on a 1 px grid then refining. */
export function fitMapShape(shape, pairs, sigma, { profileOnly = false, gridN = 64, cache = null } = {}) {
  if (pairs.length < 3) return null;
  const S = MAP_SHAPES[shape] || (shape && shape.fn) || cubicBezier(...shape.bezier);
  const ss = pairs.map((p) => p.s), ys = pairs.map((p) => p.y);
  const smin = Math.min(...ss), smax = Math.max(...ss); const span = Math.max(1, smax - smin);
  // profile: candidate (s0, s1) on the observed scroll positions ± span, solve (a, b) by OLS
  // a clamped map's corners usually fall between the sampled offsets (lab case M01: 120 and 800 px between samples at
  // 0, 40, 150, …): profile on the samples plus a 64-point grid over the span (±25 %), then refine
  const grid = Array.from({ length: gridN + 1 }, (_, q) => smin - span * 0.25 + (span * 1.5 * q) / gridN);
  const cands = [...new Set([...ss, ...grid])].sort((x, y) => x - y);
  // L8 (fit speed): one buffer for every corner pair (was a new array per pair), and the shape is evaluated only inside
  // (0, 1): clamp01 sends v <= 0 to +0 and v >= 1 to 1 exactly, so those points take S(0) / S(1) computed once (S is a
  // pure ease); NaN still goes through S. Same u values, same sums in the same order: bit-identical.
  let best = null; const u = new Float64Array(ss.length); const S0 = S(clamp01(0)), S1 = S(clamp01(1));
  // L9-B: the shape values of every corner pair and their sums depend on the offsets only, not on the values: a caller that
  // profiles many value sets on the same offsets (invertedMapSeeds: every α, the golden-section refinement) passes a
  // cache and they are computed once per shape. Same values and sums, summed in the same order: bit-identical.
  const C = cache && typeof shape === 'string' ? mapProfileCache(cache, shape, S, S0, S1, ss, cands) : null;
  if (C) {
    const n = ss.length; let sy = 0; for (let k = 0; k < n; k++) sy += ys[k];
    for (let q = 0; q < C.np; q++) {
      if (C.skip[q]) continue; const o = q * n; let sxy = 0; for (let k = 0; k < n; k++) sxy += C.U[o + k] * ys[k];
      const sx = C.SX[q]; const det = C.DET[q]; const b = (n * sxy - sx * sy) / det, a = (sy - b * sx) / n;
      let e = 0; for (let k = 0; k < n; k++) { e += (a + b * C.U[o + k] - ys[k]) ** 2; if (best && e >= best.e) break; } if (!best || e < best.e) best = { e, s0: C.S0s[q], s1: C.S1s[q], a, b };
    }
  } else for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
    const s0 = cands[i], s1 = cands[j]; let sx = 0, sxx = 0, sy = 0, sxy = 0; const n = ss.length;
    // L9-A: the shape values and the four sums in one pass (each sum still runs over k ascending: same values)
    for (let k = 0; k < n; k++) { const v = (ss[k] - s0) / (s1 - s0); const uk = v <= 0 ? S0 : v >= 1 ? S1 : S(clamp01(v)); u[k] = uk; sx += uk; sxx += uk * uk; sy += ys[k]; sxy += uk * ys[k]; }
    const det = n * sxx - sx * sx; if (Math.abs(det) < 1e-12) continue; const b = (n * sxy - sx * sy) / det, a = (sy - b * sx) / n;
    // L9-A: the sum of squares only grows (rounding is monotone), so once it reaches the best pair's it cannot win: stop
    let e = 0; for (let k = 0; k < n; k++) { e += (a + b * u[k] - ys[k]) ** 2; if (best && e >= best.e) break; } if (!best || e < best.e) best = { e, s0, s1, a, b };
  }
  if (!best) return null;
  if (profileOnly) return { rss: best.e, shape, prof: best };
  const spec = [{ name: 'a', scale: Math.abs(best.a) || 1 }, { name: 'b', scale: Math.abs(best.b) || 1 }, { name: 's0', scale: 1, unit: 'px' }, { name: 's1', scale: 1, unit: 'px' }];
  const f = (p, X) => X.map((s) => mapAt(S, p[0], p[1], p[2], Math.max(p[3], p[2] + 1e-6), s));
  const r = fitModel({ family: `map:${typeof shape === 'string' ? shape : shape && shape.fn ? 'custom' : 'bezier'}`, cls: 'scroll map', T: ss, y: ys, spec, f, starts: [[best.a, best.b, best.s0, best.s1]], sigma });
  if (r) { r.shape = shape && shape.fn ? 'custom' : shape; r.S = S; r.map = (s) => mapAt(S, r.p[0], r.p[1], r.p[2], r.p[3], s); }
  return r;
}

/**
 * L9-B: fitMapShape's corner-pair profile without the values: per pair (cands i < j, the loop order of fitMapShape) the
 * shape values u_k, Σu, and the OLS determinant n·Σu² − (Σu)² (pairs below 1e-12 skipped), each summed over k ascending as
 * fitMapShape does. Kept in `cache` per shape; reused while the offsets and the corner candidates are the same.
 */
function mapProfileCache(cache, shape, S, S0, S1, ss, cands) {
  const same = (x, y) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]));
  const hit = cache.get(shape); if (hit && same(hit.ss, ss) && same(hit.cands, cands)) return hit;
  const n = ss.length, m = cands.length, np = (m * (m - 1)) / 2;
  const U = new Float64Array(np * n), SX = new Float64Array(np), DET = new Float64Array(np), S0s = new Float64Array(np), S1s = new Float64Array(np), skip = new Uint8Array(np);
  let q = 0;
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++, q++) {
    const s0 = cands[i], s1 = cands[j]; let sx = 0, sxx = 0; const o = q * n;
    for (let k = 0; k < n; k++) { const v = (ss[k] - s0) / (s1 - s0); const uk = v <= 0 ? S0 : v >= 1 ? S1 : S(clamp01(v)); U[o + k] = uk; sx += uk; sxx += uk * uk; }
    const det = n * sxx - sx * sx; SX[q] = sx; DET[q] = det; S0s[q] = s0; S1s[q] = s1; skip[q] = Math.abs(det) < 1e-12 ? 1 : 0;
  }
  const C = { ss: ss.slice(), cands: cands.slice(), np, U, SX, DET, S0s, S1s, skip }; cache.set(shape, C); return C;
}

/**
 * Simulate a smoother over the take's own frames.
 * @param {'ema'|'asym'|'dtdamp'|'none'|'restarted'} law
 */
export function simulateSmoother(law, prm, g, T, y0) {
  // L8 (fit speed): the known laws run in their own loop (no per-frame law / snap tests, the dt-damp factor reused
  // while the frame interval repeats). Every update is the same expression on the same values as the generic loop
  // below, in the same order, so the output is bit-identical (test/analysis/fit-speed.test.js compares both).
  if (FAST_LAWS.has(law)) return simulateFast(law, prm, g, T, y0);
  return simulateSmootherGeneric(law, prm, g, T, y0);
}
const FAST_LAWS = new Set(['none', 'ema', 'asym', 'dtdamp', 'restarted']);
function simulateFast(law, prm, g, T, y0) {
  const n = T.length; const out = new Array(n); let x = y0;
  if (!n) return out;
  out[0] = x;
  const eps = prm.eps; const snap = !!eps; const pre = snap && prm.snapMode === 'pre';
  if (law === 'restarted') {
    // (the snap tests never apply to a restarted tween)
    const E = prm.E, L = prm.L, delay = prm.delay; let on = false, ts = 0, from = 0, to = 0;
    for (let k = 1; k < n; k++) {
      const gk = g[k];
      if (!Number.isFinite(gk)) { out[k] = x; continue; }
      if (g[k] !== g[k - 1]) { on = true; ts = T[k - 1] + delay; from = x; to = gk; }
      if (on) { const p = (T[k] - ts) / L; x = from + (to - from) * (p <= 0 ? 0 : p >= 1 ? 1 : E(p)); }
      out[k] = x;
    }
    return out;
  }
  const alpha = prm.alpha, up = prm.alphaUp, down = prm.alphaDown, lambda = prm.lambda;
  let lastDt = 0, fac = NaN, haveDt = false;
  for (let k = 1; k < n; k++) {
    const gk = g[k];
    if (!Number.isFinite(gk)) { out[k] = x; continue; }
    if (pre && law !== 'none' && Math.abs(gk - x) < eps) { x = gk; out[k] = x; continue; }
    if (law === 'ema') x = x + alpha * (gk - x);
    else if (law === 'none') x = gk;
    else if (law === 'asym') x = x + (gk >= x ? up : down) * (gk - x);
    else { const dt = T[k] - T[k - 1]; if (!haveDt || !Object.is(dt, lastDt)) { haveDt = true; lastDt = dt; fac = 1 - Math.exp(-lambda * dt / 1000); } x = x + (gk - x) * fac; }
    if (snap && !pre && Math.abs(gk - x) < eps) x = gk;
    out[k] = x;
  }
  return out;
}
/**
 * L9-A (fit speed): fused evaluator of a known law (FAST_LAWS) on a driver given as distinct values `v` gathered per
 * frame by `at` (mapDriverVals): simulation, residual against `y` and SSE in one loop, no driver, prediction or residual
 * array. The state update of every law is simulateFast's, expression by expression and in the same order, so x_k is
 * bit-identical to simulateSmoother(law, {...prm, eps, snapMode}, g, T, y0)[k]; the residual is x_k − y[k] on the frames
 * the mask keeps (null: all), summed as r·r from 0 in frame order (= sse of fitModel's residual array).
 * @param {number|undefined} eps snap ε (falsy: no snap), @param {string|undefined} snapMode
 * @param {Uint8Array|null} mask  @param {Float64Array|null} out  null: return the SSE; else write the residuals, return their count
 */
export function simResidFused(law, prm, eps, snapMode, at, v, T, y, y0, mask, out) {
  const n = T.length; let x = y0, s = 0, j = 0, r = 0;
  if (!n) return out ? 0 : s;
  if (mask === null || mask[0] === 1) { r = x - y[0]; if (out !== null) out[j++] = r; else s += r * r; }
  if (law === 'restarted') {
    const E = prm.E, L = prm.L, delay = prm.delay; let on = false, ts = 0, from = 0, to = 0; let gPrev = v[at[0]];
    // L9-B: E is a pure ease, so a progress equal to the previous one reuses its value (the same number: bit-identical); a
    // sweep that restarts the tween every frame repeats it whenever the frame interval repeats (18 % of calls, pudding)
    let lastP = NaN, lastE = 0;
    for (let k = 1; k < n; k++) {
      const gk = v[at[k]];
      if (Number.isFinite(gk)) {
        if (gk !== gPrev) { on = true; ts = T[k - 1] + delay; from = x; to = gk; }
        if (on) { const p = (T[k] - ts) / L; let e; if (p <= 0) e = 0; else if (p >= 1) e = 1; else if (p === lastP) e = lastE; else { e = E(p); lastP = p; lastE = e; } x = from + (to - from) * e; }
      }
      gPrev = gk;
      if (mask === null || mask[k] === 1) { r = x - y[k]; if (out !== null) out[j++] = r; else s += r * r; }
    }
    return out !== null ? j : s;
  }
  const snap = !!eps; const pre = snap && snapMode === 'pre';
  const lw = law === 'ema' ? 1 : law === 'none' ? 2 : law === 'asym' ? 3 : 4;
  const alpha = prm.alpha, up = prm.alphaUp, down = prm.alphaDown, lambda = prm.lambda;
  let lastDt = 0, fac = NaN, haveDt = false;
  for (let k = 1; k < n; k++) {
    const gk = v[at[k]];
    if (Number.isFinite(gk)) {
      if (pre && lw !== 2 && Math.abs(gk - x) < eps) x = gk;
      else {
        if (lw === 1) x = x + alpha * (gk - x);
        else if (lw === 2) x = gk;
        else if (lw === 3) x = x + (gk >= x ? up : down) * (gk - x);
        else { const dt = T[k] - T[k - 1]; if (!haveDt || !Object.is(dt, lastDt)) { haveDt = true; lastDt = dt; fac = 1 - Math.exp(-lambda * dt / 1000); } x = x + (gk - x) * fac; }
        if (snap && !pre && Math.abs(gk - x) < eps) x = gk;
      }
    }
    if (mask === null || mask[k] === 1) { r = x - y[k]; if (out !== null) out[j++] = r; else s += r * r; }
  }
  return out !== null ? j : s;
}

export function simulateSmootherGeneric(law, prm, g, T, y0) {
  const out = new Array(T.length); let x = y0; let tw = null;
  for (let k = 0; k < T.length; k++) {
    if (k === 0) { out[0] = x; continue; }
    const gk = g[k], dt = T[k] - T[k - 1];
    if (!Number.isFinite(gk)) { out[k] = x; continue; }        // no driver value yet (before the first pointer input): hold
    if (prm.eps && prm.snapMode === 'pre' && law !== 'restarted' && law !== 'none' && Math.abs(gk - x) < prm.eps) { x = gk; out[k] = x; continue; }
    if (law === 'none') x = gk;
    else if (law === 'ema') x = x + prm.alpha * (gk - x);
    else if (law === 'asym') x = x + (gk >= x ? prm.alphaUp : prm.alphaDown) * (gk - x);
    else if (law === 'dtdamp') x = x + (gk - x) * (1 - Math.exp(-prm.lambda * dt / 1000));
    else if (law === 'restarted') {
      if (g[k] !== g[k - 1]) tw = { ts: T[k - 1] + prm.delay, from: x, to: gk };
      if (tw) x = tw.from + (tw.to - tw.from) * easeAt(prm.E, (T[k] - tw.ts) / prm.L);
    }
    if (prm.eps && prm.snapMode !== 'pre' && law !== 'restarted' && Math.abs(gk - x) < prm.eps) x = gk;
    out[k] = x;
  }
  return out;
}

/**
 * Snap ε of a smoother (design §4.5 "snap"; lab cases M02, M13, M20: `|target − x| < ε → x = target`), estimated from
 * one-step-ahead predictions on the observed series: frames that land exactly on the driver while the plain update would
 * not, against frames that stay off it. Two placements exist in real code: checked before the update ('pre') or after it
 * ('post'). Returns {eps, snapMode, lo, hi, events} for a placement whose interval (lo, hi] is non-empty, else null.
 */
export function estimateSnap(law, prm, sy, y, T, tol, stride = 1, quantum = 0) {
  const step = (x, gk, dt) => (law === 'ema' ? x + prm.alpha * (gk - x) : law === 'asym' ? x + (gk >= x ? prm.alphaUp : prm.alphaDown) * (gk - x) : law === 'dtdamp' ? x + (gk - x) * (1 - Math.exp(-prm.lambda * dt / 1000)) : null);
  // a snap ends an approach on an exact plateau (a geometric approach never reaches its target): the plateau value is
  // the target of that hold, so the evidence does not depend on the fitted map
  const holds = []; let h0 = 0;
  for (let k = 1; k <= y.length; k++) if (k === y.length || sy[k] !== sy[k - 1]) { holds.push([h0, k - 1]); h0 = k; }
  const out = [];
  for (const mode of ['pre', 'post']) {
    let lo = 0, hi = Infinity, events = 0;
    for (const [a, b] of holds) {
      // the snap lands on the plateau that lasts to the end of the hold (the target of that hold); on a quantised
      // channel a slow tail also stalls on repeated values, so the plateau counts as a snap only when the plain update
      // from the frame before could not have landed on it (lab case M04: toFixed(2) channels, snap 1e-3 of the eased
      // progress = 0.06 px, i.e. 6 quanta; the first repeated value of the hold was a quantisation stall)
      if (b - a < 2 || Math.abs(y[b] - y[b - 1]) > tol) continue;
      let k = b; while (k > Math.max(a, 1) && Math.abs(y[k - 1] - y[b]) <= tol) k--;
      if (k <= Math.max(a, 1) - 1 || Math.abs(y[k] - y[k - 1]) <= tol) continue;
      const g = y[k];
      { const h = (T[k] - T[k - 1]) / stride; let x = y[k - 1]; for (let q = 0; q < stride; q++) { x = step(x, g, h); if (x == null) return null; }
        if (Math.abs(x - g) <= 4 * tol) continue; }
      // with a sampling stride the page took `stride` steps per sample; d is taken at the LAST sub-step (the smallest
      // gap of the sample), which bounds ε from below for a snapped sample and from above for an unsnapped one
      const dOf = (j) => { const h = (T[j] - T[j - 1]) / stride; let x = y[j - 1], xb = x; for (let q = 0; q < stride; q++) { xb = x; x = step(x, g, h); if (x == null) return null; }
        return mode === 'pre' ? Math.abs(g - xb) : Math.abs(g - x); };
      const dk = dOf(k); if (dk == null) return null;
      lo = Math.max(lo, dk); events++;
      // unsnapped frames bound ε from above: the frames of this hold, and before it the frames of the same monotone
      // approach to g (the snap may land on the first frame of a hold whose offset maps to the same target; M04)
      let j0 = Math.max(a, 1) + 1;
      if (k === a) { const dir = Math.sign(g - y[k - 1]); j0 = k - 1; while (j0 > 1 && Math.sign(y[j0] - y[j0 - 1]) !== -dir && Math.sign(g - y[j0 - 1]) === dir) j0--; j0 = Math.max(j0 + 1, 1); }
      for (let j = j0; j < k; j++) { const d = dOf(j); if (d != null && Math.abs(y[j] - g) > tol) hi = Math.min(hi, d); }
    }
    // a quantised channel reads each x to ±q/2, so both bounds carry that slack (M04 toFixed(2): the last unsnapped and
    // the snapped frame both read 0.06 from the target)
    const qh = quantum / 2;
    if (events && lo - qh < hi + qh) out.push({ snapMode: mode, lo: Math.max(0, lo - qh), hi: hi + qh, events,
      eps: Number.isFinite(hi) ? (qh ? (Math.max(0, lo - qh) + hi + qh) / 2 : Math.sqrt(lo * hi)) : qh ? lo + qh : lo * 1.5 });
  }
  return out.sort((u, v) => (v.hi / Math.max(v.lo, 1e-300)) - (u.hi / Math.max(u.lo, 1e-300)))[0] || null;
}

/** Driver from a fitted map and a lag: g_k = map(sy_{k − lag}). */
/** A fitted map record ({shape, a, b, s0, s1}) as a map seed for smoothingCandidates({maps}). */
export function mapSeed(mp) { const S = MAP_SHAPES[mp.shape]; if (!S || ![mp.a, mp.b, mp.s0, mp.s1].every(Number.isFinite)) return null; const p = [mp.a, mp.b, mp.s0, mp.s1]; return { shape: mp.shape, S, p, rss: 0, map: (sc) => mapAt(S, p[0], p[1], p[2], p[3], sc) }; }

// L8 (fit speed): `map` is a pure function of the offset (a fitted map, a table of held targets), and a take holds each
// offset for many frames, so the map is evaluated once per DISTINCT offset and gathered per frame (profiled: the driver
// was ~25 % of a scroll take's fit CPU). Same values as sy.map((_, k) => map(sy[max(0, k − lag)])): bit-identical.
// The plan (distinct offsets + per-frame index) is kept per source array and lag; source arrays are never mutated.
const PLANS = new WeakMap();
function planOf(src, lag) {
  let byLag = PLANS.get(src); if (!byLag) { byLag = new Map(); PLANS.set(src, byLag); }
  let pl = byLag.get(lag); if (pl && pl.n === src.length) return pl;
  const n = src.length; const at = new Int32Array(n); const vals = []; const seen = new Map(); let negZero = -1;
  for (let k = 0; k < n; k++) {
    const v = src[Math.max(0, k - lag)]; let j;
    if (v === 0 && 1 / v < 0) { if (negZero < 0) { negZero = vals.length; vals.push(v); } j = negZero; }   // −0 kept apart from +0 (a Map key would merge them)
    else { j = seen.get(v); if (j === undefined) { j = vals.length; vals.push(v); seen.set(v, j); } }
    at[k] = j;
  }
  pl = { n, at, vals }; byLag.set(lag, pl); return pl;
}
export const driverOf = (map, sy, lag) => {
  const pl = planOf(sy, lag); const vals = pl.vals, at = pl.at; const v = new Array(vals.length);
  for (let j = 0; j < vals.length; j++) v[j] = map(vals[j]);
  const out = new Array(pl.n); for (let k = 0; k < pl.n; k++) out[k] = v[at[k]];
  return out;
};
/**
 * L9-A: perMap's driver without the per-frame gather: {at, v} with v[at[k]] === driverOf(map, sy, lag)[k] for perMap's
 * clamped map a + b·S((sc − s0)/den) (ends S(0) / S(1) given), evaluated inline once per distinct offset.
 */
export const mapDriverVals = (S, S0, S1, a, b, s0, den, sy, lag) => {
  const pl = planOf(sy, lag); const vals = pl.vals; const v = new Float64Array(vals.length);
  for (let j = 0; j < vals.length; j++) { const t = (vals[j] - s0) / den; v[j] = a + b * (t <= 0 ? S0 : t >= 1 ? S1 : S(clamp01(t))); }
  return { at: pl.at, v };
};

/**
 * Smoothing candidates for one series on a scroll driver.
 * @returns candidate list (fitModel results with .law, .lag, .map)
 */
// earlyExit (look / aim mode only; the lab and corpus never set it): once the unsmoothed map (law 'none') explains the
// channel to the explain bar, every smoother would have to be that map (alpha 1, lambda infinite) to match, so the
// other laws and maps are not tried. Measured on a scroll-scrubbed track (spike): 1.23e8 frame evaluations for
// an answer the map gives at nrmse 1.8e-8.
export function smoothingCandidates(s, sy, nf, { maps, grid, earlyExit = false, noneOnly = false, lean = false, probe = false } = {}) {
  // noneOnly (look's instantDriver) answers the same question as earlyExit's first stage, "is it instant?": without it
  // here an instant map found on the per-frame pairs was dropped and instantDriver never fired (D-SCROLLBUDGET-1)
  let instant = false; const isInstant = (r) => (earlyExit || noneOnly) && r && r.rms <= nf.explainBar;
  const pairs = settledPairs(s, sy, nf.sigma, Math.max(nf.sigma * 3, 2e-5 * (nf.A || 0))); const out = [];
  // undeclared sampling stride (R6, U6): the page steps every frame while rows exist every `stride` frames. With the
  // page period known and the driver known per frame (its inputs carry frame keys), the smoother is simulated on the
  // page's own frames and read at the sampled ones (lab case M02/M13 at R6)
  const G = grid && grid.stride > 1 && s.k && s.k.length ? (() => {
    const k0 = s.k[0], kN = s.k.at(-1); const K = []; for (let k = k0; k <= kN; k++) K.push(k);
    return { K, TF: K.map((k) => s.T[0] + (k - k0) * grid.dtPage), raw: K.map((k) => grid.drvFrame(k)), pos: s.k.map((k) => k - k0), stride: grid.stride };
  })() : null;
  // L8: the driver is split from the simulation so a fit can reuse it while only the dynamics parameters move (the
  // Jacobian columns of α / λ / L, a fixed-map refit); simAt also reuses it for the same driver function and lag (the
  // held-target table). Drivers are read-only arrays; the values are the ones simAt computed before.
  const drvFor = (gOfRaw, lag) => driverOf(gOfRaw, G ? G.raw : sy, lag);
  const simDrv = (law, prm, drv, y0) => {
    if (!G) return simulateSmoother(law, prm, drv, s.T, y0);
    const full = simulateSmoother(law, prm, drv, G.TF, y0); return G.pos.map((q) => full[q]);
  };
  let lastFn = null, lastLag = null, lastDrv = null;
  const simAt = (law, prm, gOfRaw, lag, y0) => {
    if (gOfRaw !== lastFn || lag !== lastLag) { lastDrv = drvFor(gOfRaw, lag); lastFn = gOfRaw; lastLag = lag; }
    return simDrv(law, prm, lastDrv, y0);
  };
  // a dense sweep (one frame per offset, lab trace `speed`) has no settled holds: seed the map from the per-frame
  // inversion of the smoother instead (inverted seeds below)
  // every inverted shape is kept: the top three are tried first, the rest when nothing explains (lab case M01 g4 speed
  // at R3: the inversion ranked linear 4th and the dense take had no fallback)
  const invertedAll = pairs.length < 3 && !maps ? invertedMapSeeds(s, sy, nf, G) : null; const inverted = invertedAll ? invertedAll.slice(0, 3) : null;
  const noData = pairs.length < 3 && !(inverted && inverted.length) && !(maps && maps.length);
  if (noData && !(earlyExit || noneOnly)) return { out, pairs, maps: [] };
  const mapFits = noData ? [] : maps || (pairs.length >= 3 ? Object.keys(MAP_SHAPES).map((sh) => fitMapShape(sh, pairs, nf.sigma)).filter(Boolean).sort((a, b) => a.rss - b.rss) : invertedAll);
  const topMaps = mapFits.slice(0, 3);
  const T = s.T, y = s.y;
  // "never finishes inside any hold" = longer than the LONGEST hold (lab case M21: a 750 ms tween finishes in the long
  // holds of a trace that also has short ones; the shortest hold made it look unfinished everywhere)
  let minHold = 0, last = null; for (let k = 1; k < sy.length; k++) if (sy[k] !== sy[k - 1]) { if (last != null) minHold = Math.max(minHold, T[k] - T[last]); last = k; }
  if (last != null) minHold = Math.max(minHold, T.at(-1) - T[last]); if (!minHold) minHold = Infinity;
  // Targets from the holds (lab case M03 --b): when every scroll offset the take visits was held long enough to settle
  // (or its tail is Aitken-extrapolated), the target at each offset is measured directly and the dynamics need no map
  // shape at all; few offsets inside the range cannot identify a shape, and a wrong shape makes the true law misfit.
  // The parametric maps stay candidates; the shape is reported from the best of them.
  const table = (() => {
    const t = new Map(); for (const q of pairs) if (!t.has(q.s)) t.set(q.s, q.y);
    const src = G ? G.raw : sy; for (const v of src) if (Number.isFinite(v) && !t.has(v)) return null;
    return t.size >= 2 ? t : null;
  })();
  if (table && topMaps.length) {
    const T = s.T, y = s.y; const dt = (T.at(-1) - T[0]) / Math.max(1, T.length - 1); const m0 = topMaps[0];
    const look = (sc) => (table.has(sc) ? table.get(sc) : NaN);
    for (const lag of [0, 1, 2]) {
      const g = driverOf(look, sy, lag); let num = 0, den = 0; for (let k = 1; k < y.length; k++) { const e = g[k] - y[k - 1]; if (Number.isFinite(e) && Math.abs(e) > nf.sigma * 3) { num += (y[k] - y[k - 1]) * e; den += e * e; } }
      let a0 = den > 0 ? Math.min(1, Math.max(1e-4, num / den)) : 0.5; if (G) a0 = 1 - Math.pow(1 - Math.min(0.999999, a0), 1 / G.stride);
      const dtF = G ? G.TF[1] - G.TF[0] : dt; const lam = (a) => -Math.log(1 - Math.min(0.999, a)) / (dtF / 1000);
      const mkT = (law, spec, starts, toPrm, extra = {}) => {
        const snapP = extra.snap ? { eps: extra.snap.eps, snapMode: extra.snap.snapMode } : {};
        const f = (p) => simAt(law, { ...toPrm(p), ...snapP }, look, lag, y[0]);
        const r = fitModel({ family: law, cls: extra.cls || 'first-order smoothing', T, y, spec, f, starts, sigma: nf.sigma, nm: !!extra.nm });
        if (!r) return null;
        r.perPageFrame = !!G; r.law = law; r.lag = lag; r.mapShape = typeof m0.shape === 'string' ? m0.shape : 'bezier'; r.targetsFromHolds = table.size;
        r.map = { shape: r.mapShape, a: m0.p[0], b: m0.p[1], s0: m0.p[2], s1: m0.p[3], s0_ci95: m0.params && m0.params.s0 ? m0.params.s0.ci95 : null, s1_ci95: m0.params && m0.params.s1 ? m0.params.s1.ci95 : null, targets: 'measured at each held offset' }; r.prm = { ...toPrm(r.p), ...snapP }; r.dtFrame = dt;
        r.refit = (use) => (spec.length === 0 ? { predictFull: f([]) } : fitModel({ family: law, cls: r.cls, T, y, spec, f, starts: [r.p], sigma: nf.sigma, use, noCI: true }));
        if (extra.snap) { r.k += 1; r.bic = bicOf(r.rss, r.n, r.k, nf.sigma); r.family = `${law}+snap`; r.params.eps = { value: extra.snap.eps, unit: null, ci95: Number.isFinite(extra.snap.hi) ? [extra.snap.lo, extra.snap.hi] : null }; }
        r.family += ' (targets from holds)'; return r;
      };
      out.push(mkT('none', [], [[]], () => ({}), { cls: 'scroll map' }));
      if (isInstant(out.at(-1))) { instant = true; break; }
      if (probe) continue;   // probe: the measured targets' unsmoothed map only (no free parameter, no fit)
      const SMT = [
        ['ema', [{ name: 'alpha', lo: 1e-4, hi: 1, scale: 0.01 }], (p) => ({ alpha: p[0] }), {}, [[a0], [Math.min(1, a0 * 2)], [a0 / 2]]],
        ['asym', [{ name: 'alphaUp', lo: 1e-4, hi: 1, scale: 0.01 }, { name: 'alphaDown', lo: 1e-4, hi: 1, scale: 0.01 }], (p) => ({ alphaUp: p[0], alphaDown: p[1] }), { cls: 'asymmetric smoothing' }, [[a0, a0], [1, a0], [a0, 1]]],
        ['dtdamp', [{ name: 'lambda', lo: 1e-3, hi: 1e4, scale: 1, unit: '1/s' }], (p) => ({ lambda: p[0] }), {}, [[lam(a0)], [lam(Math.min(0.999, a0 * 2))], [lam(a0 / 2)]]],
      ];
      const baseT = SMT.map(([law, spec, toPrm, extra, st]) => { const r = mkT(law, spec, st, toPrm, extra); out.push(r); return r; });
      const sns = SMT.map(([law], j) => (baseT[j] && baseT[j].rms > nf.sigma ? estimateSnap(law, baseT[j].prm, sy.map((_, k) => sy[Math.max(0, k - lag)]), y, T, Math.max(nf.sigma, 1e-12 * (nf.A || 1)), G ? G.stride : 1, nf.quantum || 0) : null));
      SMT.forEach(([law, spec, toPrm, extra], j) => { const r = baseT[j]; if (!r || r.rms <= nf.sigma) return; const sn = sns[j] || sns.find(Boolean); if (sn) out.push(mkT(law, spec, [r.p], toPrm, { ...extra, snap: sn })); });
      for (const E of lean ? ['expo.out'] : ['expo.out', 'easeOutQuad', 'easeOutCubic']) {
        let minHold = 0, last = null; for (let k = 1; k < sy.length; k++) if (sy[k] !== sy[k - 1]) { if (last != null) minHold = Math.max(minHold, T[k] - T[last]); last = k; }
        if (last != null) minHold = Math.max(minHold, T.at(-1) - T[last]); if (!minHold) minHold = Infinity;
        const r = mkT('restarted', [{ name: 'L', lo: dt, hi: 5000, scale: 10, unit: 'ms' }, { name: 'delay', lo: 0, hi: dt, scale: dt / 4, unit: 'ms' }], [[300, dt / 2], [800, dt / 2]], (p) => ({ L: p[0], delay: p[1], E: NAMED[E].fn }), { cls: 'restarted tween', nm: true });
        if (!r) continue; r.ease = E === 'easeOutQuad' ? 'power2.out' : E === 'easeOutCubic' ? 'power3.out' : 'expo.out';
        if (E === 'expo.out' && r.prm.L >= minHold) { r.cls = 'first-order smoothing'; r.family = 'restarted expo.out (unfinished ≡ dt-damp)'; r.degenerate = true; }
        if (r.prm.L + r.prm.delay <= dt * 1.01) continue; out.push(r);
      }
    }
  }
  // the shape ranking from the settled pairs is only a seed order: few or noisy pairs can rank the true shape below the
  // top three (lab case M02 at R6: smoothstep ranked 4th on the --e driver, nothing explained). When no candidate of
  // the top three explains, the remaining shapes are tried too
  const perMap = (m, pass = null) => { const mS0 = m.S(clamp01(0)), mS1 = m.S(clamp01(1)); for (const lag of pass === 'probe' ? [0] : [0, 1, 2]) {
    const g = driverOf(m.map, sy, lag);
    // OLS through the origin: Δx_k = α (g_k − x_{k−1}) (jump-and-trace, S3 §4.1)
    let num = 0, den = 0; for (let k = 1; k < y.length; k++) { const e = g[k] - y[k - 1]; if (Math.abs(e) > nf.sigma * 3) { num += (y[k] - y[k - 1]) * e; den += e * e; } }
    let a0 = den > 0 ? Math.min(1, Math.max(1e-4, num / den)) : 0.5;
    if (G) a0 = 1 - Math.pow(1 - Math.min(0.999999, a0), 1 / G.stride);          // per sample → per page frame
    const dt = (T.at(-1) - T[0]) / Math.max(1, T.length - 1);
    const mk = (law, spec, starts, toPrm, extra = {}) => {
      // joint refine with the map parameters (a, b, s0, s1)
      const nm = spec.length;
      const spec2 = [...spec, { name: 'mapA', scale: Math.abs(m.p[0]) || 1 }, { name: 'mapB', scale: Math.abs(m.p[1]) || 1 }, { name: 'mapS0', scale: 1, unit: 'px' }, { name: 'mapS1', scale: 1, unit: 'px' }];
      const snapP = extra.snap ? { eps: extra.snap.eps, snapMode: extra.snap.snapMode } : {};
      // L8: the driver depends on the four map parameters only: rebuilt when one of them changed (Object.is, so −0 / NaN
      // never alias), reused when only the dynamics moved
      let cA = 0, cB = 0, cS0 = 0, cS1 = 0, cDrv = null;
      const f = (p) => {
        const a = p[nm], b = p[nm + 1], s0 = p[nm + 2], s1r = p[nm + 3];
        if (!(cDrv && Object.is(a, cA) && Object.is(b, cB) && Object.is(s0, cS0) && Object.is(s1r, cS1))) {
          // = mapAt(m.S, a, b, s0, s1, sc), with the clamped ends read from S(0) / S(1) (clamp01 gives exactly +0 / 1 there)
          const s1 = Math.max(s1r, s0 + 1e-6); const den = s1 - s0 || 1e-9;
          cDrv = drvFor((sc) => { const v = (sc - s0) / den; return a + b * (v <= 0 ? mS0 : v >= 1 ? mS1 : m.S(clamp01(v))); }, lag); cA = a; cB = b; cS0 = s0; cS1 = s1r;
        }
        return simDrv(law, { ...toPrm(p), ...snapP }, cDrv, y[0]);
      };
      // L9-A: the optimisers' evaluations go through the fused evaluator (no per-frame driver, no prediction or residual
      // array, no parameter spread); same driver cache rule as f, same values (simResidFused). Not on a page-frame grid.
      const snapEps = extra.snap ? extra.snap.eps : undefined, snapMode = extra.snap ? extra.snap.snapMode : undefined;
      let xA = 0, xB = 0, xS0 = 0, xS1 = 0, xDrv = null;
      const fxDrv = (p) => {
        const a = p[nm], b = p[nm + 1], s0 = p[nm + 2], s1r = p[nm + 3];
        if (!(xDrv && Object.is(a, xA) && Object.is(b, xB) && Object.is(s0, xS0) && Object.is(s1r, xS1))) {
          const s1 = Math.max(s1r, s0 + 1e-6); const den = s1 - s0 || 1e-9;
          xDrv = mapDriverVals(m.S, mS0, mS1, a, b, s0, den, sy, lag); xA = a; xB = b; xS0 = s0; xS1 = s1r;
        }
        return xDrv;
      };
      const fx = G || !FAST_LAWS.has(law) ? null : {
        sse: (p, yv, mask) => { const d = fxDrv(p); return simResidFused(law, toPrm(p), snapEps, snapMode, d.at, d.v, T, yv, y[0], mask, null); },
        resid: (p, yv, mask, out) => { const d = fxDrv(p); simResidFused(law, toPrm(p), snapEps, snapMode, d.at, d.v, T, yv, y[0], mask, out); },
      };
      // L9-B: REVA_FIT_SEARCH=jacobian | varpro searches with the models' own derivatives (drivesearch.js) for a known law
      // on a built-in map shape; the default ('exact') and anything the sensitivities do not cover keep the post-L9-A
      // search (Nelder–Mead + forward-difference LM in fitModel)
      const mode = searchMode(); const Sd = typeof m.shape === 'string' ? SHAPE_DERIV[m.shape] : null; const slots = dynSlots(law, spec);
      const Ed = law === 'restarted' ? EASE_DERIV.get(toPrm(starts[0]).E) : null;
      const search = fx && Sd && slots && (law !== 'restarted' || Ed) && mode !== 'exact'
        ? (ctx) => driverSearch({ mode, law, nm, slots, toPrm, eps: snapEps, snapMode, S: m.S, Sd, S0: mS0, S1: mS1, plan: planOf(sy, lag), T, y, y0: y[0], starts: starts.map((st) => [...st, ...m.p]), nmStarts: !!extra.nm, dt, sigma: nf.sigma, Ed, exactSse: (p, mask) => fx.sse(p, y, mask) }, ctx)
        : null;
      const r = fitModel({ family: `${law}`, cls: extra.cls || 'first-order smoothing', T, y, spec: spec2, f: (p) => f(p), fx, search, starts: starts.map((st) => [...st, ...m.p]), sigma: nf.sigma, nm: !!extra.nm });
      if (r) {
        r.perPageFrame = !!G; r.law = law; r.lag = lag; r.mapShape = typeof m.shape === 'string' ? m.shape : 'bezier'; r.map = { shape: r.mapShape, a: r.p[nm], b: r.p[nm + 1], s0: r.p[nm + 2], s1: r.p[nm + 3] }; r.prm = { ...toPrm(r.p), ...snapP }; r.dtFrame = dt;
        if (extra.snap) {   // ε is a fitted parameter (estimated from the snap events, not by the optimiser): count it in k
          r.k += 1; r.bic = bicOf(r.rss, r.n, r.k, nf.sigma); r.family = `${law}+snap`;
          r.params.eps = { value: extra.snap.eps, unit: null, ci95: Number.isFinite(extra.snap.hi) ? [extra.snap.lo, extra.snap.hi] : null, note: `snap checked ${extra.snap.snapMode} the update; ${extra.snap.events} snap events` };
        }
        // a map whose corners the samples cannot place (few offsets, none past a clamp) can carry the dynamics into a
        // singular covariance (lab case M21 g1 steps at R5: L 299.999 ms without an interval, after the dense-sweep seeds
        // of revision 11 made a map with an unplaced end corner win). The responses depend on the map only through the
        // targets at the visited offsets: an interval the joint covariance cannot give is computed with those targets as
        // free nuisance parameters (each identified by its hold) in place of the map's (a, b, s0, s1)
        if (nm > 0 && spec.some((q) => !(r.params[q.name] && r.params[q.name].ci95))) {
          const offs = [...new Set((G ? G.raw : sy).filter(Number.isFinite))];
          if (offs.length >= 1 && offs.length <= 32) {
            const q0 = r.p.slice(nm); const map0 = (sc) => mapAt(m.S, q0[0], q0[1], q0[2], Math.max(q0[3], q0[2] + 1e-6), sc);
            const g0 = offs.map(map0); const dyn = r.p.slice(0, nm);
            const fT = (d, g) => { const tb = new Map(offs.map((o, j) => [o, g[j]])); return simAt(law, { ...toPrm(d), ...snapP }, (sc) => tb.get(sc), lag, y[0]); };
            // a target no response ever moves toward (the starting offset, where the series already rests) has no
            // influence and stays fixed; the others are the nuisance parameters
            const m0 = fT(dyn, g0); const dg = (nf.A || 1) * 1e-3;
            const live = offs.map((_, j) => { const g = g0.slice(); g[j] += dg; return fT(dyn, g).some((v, i) => Math.abs(v - m0[i]) > nf.sigma); });
            const li = live.map((b, j) => (b ? j : -1)).filter((j) => j >= 0);
            const put = (q) => { const g = g0.slice(); li.forEach((j, a) => { g[j] = q[nm + a]; }); return fT(q.slice(0, nm), g); };
            const rfT = (q) => { const mm = put(q); return mm.map((v, i) => v - y[i]); };
            const half = ciHalfWidths(rfT, [...dyn, ...li.map((j) => g0[j])], r.rss, r.n, nf.sigma, [...spec.map((q) => q.scale ?? 1), ...li.map(() => (nf.A || 1) * 0.1)]);
            spec.forEach((q, i) => { const P = r.params[q.name]; if (P && !P.ci95 && Number.isFinite(half[i])) { P.ci95 = [P.value - half[i], P.value + half[i]]; P.ciMethod = 'targets at the visited offsets as nuisance parameters (map corners not identified)'; } });
          }
        }
        // holdout refit: the map is a separate measurement (settled pairs), so leave-one-segment-out refits only the
        // dynamics and predicts the held-out response through the fixed map
        const mp = r.p.slice(nm); const fixedF = (q) => f([...q, ...mp]);
        const fxF = fx && { sse: (q, yv, mask) => fx.sse([...q, ...mp], yv, mask), resid: (q, yv, mask, out) => fx.resid([...q, ...mp], yv, mask, out) };
        r.refit = (use) => (nm === 0 ? { predictFull: fixedF([]) } : fitModel({ family: law, cls: r.cls, T, y, spec, f: fixedF, fx: fxF, starts: [r.p.slice(0, nm)], sigma: nf.sigma, use, noCI: true }));
      }
      return r;
    };
    if (pass !== 'skipNone') out.push(mk('none', [], [[]], () => ({}), { cls: 'scroll map' }));
    if (pass === 'noneOnly') { if (isInstant(out.at(-1))) { instant = true; return; } continue; }
    const SM = [
      ['ema', [{ name: 'alpha', lo: 1e-4, hi: 1, scale: 0.01 }], (p) => ({ alpha: p[0] }), {}],
      ['asym', [{ name: 'alphaUp', lo: 1e-4, hi: 1, scale: 0.01 }, { name: 'alphaDown', lo: 1e-4, hi: 1, scale: 0.01 }], (p) => ({ alphaUp: p[0], alphaDown: p[1] }), { cls: 'asymmetric smoothing' }],
      ['dtdamp', [{ name: 'lambda', lo: 1e-3, hi: 1e4, scale: 1, unit: '1/s' }], (p) => ({ lambda: p[0] }), {}],
    ].filter(([law]) => !lean || law !== 'asym');   // lean: first-order laws only (see the restarted eases below)
    const lam = (a) => -Math.log(1 - Math.min(0.999, a)) / ((G ? G.TF[1] - G.TF[0] : dt) / 1000);
    const startsOf = { ema: [[a0], [Math.min(1, a0 * 2)], [a0 / 2]], asym: [[a0, a0], [1, a0], [a0, 1]], dtdamp: [[lam(a0)], [lam(Math.min(0.999, a0 * 2))], [lam(a0 / 2)]] };
    const base = (pass === 'emaOnly' || pass === 'probe' ? SM.slice(0, 1) : SM).map(([law, spec, toPrm, extra]) => { const r = mk(law, spec, pass === 'probe' ? startsOf[law].slice(0, 1) : startsOf[law], toPrm, extra); out.push(r); return r; });
    if (pass === 'emaOnly' || pass === 'probe') continue;   // lean shape probe: one first-order law per shape
    // snap variants: ε from the snap events (plateaus) of each law's fit; a law whose own fit did not reach a
    // consistent interval borrows another law's estimate (the snap rule is the same; only the step differs)
    // holds for the snap evidence = runs of a constant TARGET (the base fit's map at the lagged offset): on a dense sweep
    // the offset changes every frame while the target is flat outside the map range (lab case M02 speed draw)
    const tgtOf = (r) => { const q = r.p.slice(r.p.length - 4); return sy.map((_, k) => mapAt(m.S, q[0], q[1], q[2], Math.max(q[3], q[2] + 1e-6), sy[Math.max(0, k - lag)])); };
    const sns = SM.map(([law], j) => (base[j] && base[j].rms > nf.sigma ? estimateSnap(law, base[j].prm, tgtOf(base[j]), y, T, Math.max(nf.sigma, 1e-12 * (nf.A || 1)), G ? G.stride : 1, nf.quantum || 0) : null));
    // asymmetric smoothing whose one direction is a snap (α = 1): the joint fit stops short of the bound (lab case M03
    // speed draw d22: α_up 0.9996, α_down 0.3312 on the right smoothstep map, rms 3.4e-5 against σ 1e-9), and a rise
    // that does not quite reach its target reads as snap events that contradict the fall's real terminal snap, so no
    // consistent ε exists and the snap variant is never tried (holdout then fails on the residual). The rate at the
    // bound is pinned at 1 (a nested one-rate law, one parameter fewer) and refitted; its snap variant follows as usual
    const ab = lean ? null : base[1];
    if (ab && ab.rms > nf.sigma) for (const pin of ['alphaUp', 'alphaDown']) {
      if (!(ab.prm[pin] >= 0.99)) continue;
      const other = pin === 'alphaUp' ? 'alphaDown' : 'alphaUp';
      const toPrm1 = (p) => (pin === 'alphaUp' ? { alphaUp: 1, alphaDown: p[0] } : { alphaUp: p[0], alphaDown: 1 });
      const spec1 = [{ name: other, lo: 1e-4, hi: 1, scale: 0.01 }];
      const r1 = mk('asym', spec1, [[ab.prm[other]], [a0]], toPrm1, { cls: 'asymmetric smoothing' }); if (!r1) continue;
      r1.pinned = { [pin]: 1 }; out.push(r1);
      if (r1.rms <= nf.sigma) continue;
      const sn = estimateSnap('asym', r1.prm, tgtOf(r1), y, T, Math.max(nf.sigma, 1e-12 * (nf.A || 1)), G ? G.stride : 1, nf.quantum || 0);
      if (sn) { const r2 = mk('asym', spec1, [r1.p.slice(0, 1)], toPrm1, { cls: 'asymmetric smoothing', snap: sn }); if (r2) { r2.pinned = { [pin]: 1 }; out.push(r2); } }
    }
    SM.forEach(([law, spec, toPrm, extra], j) => {
      const r = base[j]; if (!r || r.rms <= nf.sigma) return;
      const sn = sns[j] || sns.find(Boolean); if (!sn) return;
      // seeds: this law's own fit, and the best other law's rate mapped to this law (an EMA α ≈ the asym α's mean)
      const best = base.filter(Boolean).sort((a, b) => a.rss - b.rss)[0]; const aB = best && best.law === 'asym' ? (best.prm.alphaUp + best.prm.alphaDown) / 2 : best && best.law === 'ema' ? best.prm.alpha : best && best.law === 'dtdamp' ? 1 - Math.exp(-best.prm.lambda * dt / 1000) : null;
      const seeds = [r.p.slice(0, spec.length)]; if (aB != null) seeds.push(law === 'ema' ? [aB] : law === 'asym' ? [aB, aB] : [lam(aB)]);
      out.push(mk(law, spec, seeds, toPrm, { ...extra, snap: sn }));
    });
    for (const E of lean ? ['expo.out'] : ['expo.out', 'easeOutQuad', 'easeOutCubic']) {
      const r = mk('restarted', [{ name: 'L', lo: dt, hi: 5000, scale: 10, unit: 'ms' }, { name: 'delay', lo: 0, hi: dt, scale: dt / 4, unit: 'ms' }], [[300, dt / 2], [800, dt / 2]], (p) => ({ L: p[0], delay: p[1], E: NAMED[E].fn }), { cls: 'restarted tween', nm: true });
      if (r) {
        r.ease = E === 'easeOutQuad' ? 'power2.out' : E === 'easeOutCubic' ? 'power3.out' : 'expo.out';
        // an expo.out tween restarted from the current value that never completes inside any hold is exactly a
        // time-based exponential (dt-damp): its finite duration is unobserved, so it is not a different class
        if (E === 'expo.out' && r.prm.L >= minHold) { r.cls = 'first-order smoothing'; r.family = 'restarted expo.out (unfinished ≡ dt-damp)'; r.degenerate = true; }
        // a restarted tween that completes within one frame is the unsmoothed map itself (lab case M01): not a rival class
        if (r.prm.L + r.prm.delay <= dt * 1.01) continue;
        out.push(r);
      }
    }
  } };
  // "explained" for the fallbacks = a smoothing law or an unsmoothed map explains (a restarted tween with a long L can
  // mimic a smoother on a wrong map)
  const explained = () => out.some((c) => c && c.law !== 'restarted' && c.rms <= nf.explainBar);
  // earlyExit: the unsmoothed map at every lag of EVERY map shape first (one 4-parameter fit each), the smoothing laws
  // only when none explains. All shapes, not the top three: few settled pairs can rank the true shape low (spike, a scrubbed track:
  // linear ranked 4th, so 9 smoothing fits ran before the fallback reached it)
  const noneTried = new Set();
  let invE = null;
  // fewer than 3 settled pairs (a native scroll with one hold at each end): every shape fits two points exactly, so the
  // settled-pair list says nothing about the shape and its first entry would win. The per-frame (driver, value) pairs carry
  // the shape; they go first, and an instant map found there ends the search before the shape-blind settled seeds are tried
  let frameTried = false;
  if ((earlyExit || noneOnly) && !instant && pairs.length < 3 && !maps && !G) {
    frameTried = true; const n0 = out.length;
    for (const m of framePairMaps(s, sy, nf)) { perMap(m, 'noneOnly'); if (instant) break; }
    if (!instant) out.length = n0;
  }
  if ((earlyExit || noneOnly) && !instant) {
    for (const m of mapFits || []) { noneTried.add(m); perMap(m, 'noneOnly'); if (instant) break; }
    // … and the seeds inverted from the smoother (their corners come from the samples, not from the few settled pairs)
    if (!instant && !maps && pairs.length >= 3) { invE = invertedMapSeeds(s, sy, nf, G); for (const m of invE) { noneTried.add(m); perMap(m, 'noneOnly'); if (instant) break; } }
    // … and maps fitted to every frame as a (driver, value) pair at lags 0-2: a page that maps the offset instantly
    // needs no settled holds (a continuous wheel at 100 px per frame has none; own fixture `look`, #track)
    // these seeds only answer "is it instant?": when not, their candidates leave again (they must not compete in the
    // full selection; measured on a Lenis-smoothed footer, an asymmetric smoother won once they stayed)
    if (!instant && !maps && !G && !frameTried) { const n0 = out.length; for (const m of framePairMaps(s, sy, nf)) { perMap(m, 'noneOnly'); if (instant) break; } if (!instant) out.length = n0; }
  }
  if (instant || noneOnly) return { out: instant ? out.filter(Boolean) : [], pairs, maps: mapFits, earlyExit: instant };
  // probe (look, native scroll): the unsmoothed maps did not explain; one first-order law (EMA, one start, lag 0: the
  // map corners absorb a frame of lag on a sweep) on the three best map seeds says whether ANY smoother of the offset
  // comes near the samples. The caller runs the full search only when it does
  if (probe) { if (!noData) for (const m of topMaps) perMap(m, 'probe'); return { out: out.filter(Boolean), pairs, maps: mapFits, probe: true }; }
  if (noData) return { out: [], pairs, maps: [] };
  for (const m of topMaps) perMap(m, noneTried.has(m) ? 'skipNone' : null);
  // few settled pairs (mostly a dense sweep) or nothing explains: the settled pairs may mislead (few or unsettled
  // holds); seed from the inversion, then the remaining shapes
  let inv = null;
  if (!maps && pairs.length >= 3 && (pairs.length < 6 || !explained())) { inv = (invE || invertedMapSeeds(s, sy, nf, G)).slice(0, pairs.length < 6 ? 4 : 2); for (const m of inv) perMap(m, noneTried.has(m) ? 'skipNone' : null); }
  // lean (look, the scroll offset of a page that owns its scroll, tried before the wheel sum): first-order laws and the
  // restarted expo.out only (a ScrollTrigger scrub is one of them), and no sweep of the remaining map shapes. The full
  // set cost 2.8e8 evaluations on a channel a time tween explains (a Lenis + GSAP pinned-rail page, per-letter text)
  if (!explained() && !lean) for (const m of mapFits.slice(3)) perMap(m, noneTried.has(m) ? 'skipNone' : null);
  // lean: the remaining shapes are probed with the EMA alone (the inversion can rank the true shape low on a dense sweep),
  // and only the best of them gets the other first-order laws
  if (!explained() && lean && mapFits.length > 3) {
    const rest = mapFits.slice(3); const n0 = out.length;
    for (const m of rest) perMap(m, 'emaOnly');
    const best = out.slice(n0).filter((c) => c && c.law === 'ema').sort((a, b) => a.rss - b.rss)[0];
    const m = best && rest.find((q) => q.shape === best.mapShape); if (m) perMap(m, 'skipNone');
  }
  // Free targets (lab case M02 q3 gap trace at R4: holds too short to settle, three settled pairs, five offsets — every
  // S-shaped map fits them, so a wrong shape made the true law misfit): with few distinct offsets the target at each
  // offset is a nuisance parameter and the dynamics need no map; the map shape stays unidentified (reported from the
  // best parametric map, if any explains)
  const freeTargets = () => { const offs = [...new Set((G ? G.raw : sy).filter(Number.isFinite))];
  if (!table && offs.length >= 2 && offs.length <= 12 && y.length > 4 * offs.length) {
    const dt0 = (T.at(-1) - T[0]) / Math.max(1, T.length - 1); const m0 = topMaps[0] || null;
    const lastAt = new Map(); sy.forEach((v, k) => lastAt.set(v, y[k]));
    for (const lag of [0, 1]) {
      const mkF = (law, spec, starts, toPrm, extra = {}) => {
        const nm = spec.length; const snapP = extra.snap ? { eps: extra.snap.eps, snapMode: extra.snap.snapMode } : {};
        const f = (p) => { const tb = new Map(offs.map((o, j) => [o, p[nm + j]])); return simAt(law, { ...toPrm(p), ...snapP }, (sc) => tb.get(sc), lag, y[0]); };
        const spec2 = [...spec, ...offs.map((o, j) => ({ name: `g${j}`, scale: (nf.A || 1) * 0.1 }))];
        const r = fitModel({ family: law, cls: extra.cls || 'first-order smoothing', T, y, spec: spec2, f, starts: starts.map((st) => [...st, ...offs.map((o) => lastAt.get(o))]), sigma: nf.sigma, nm: !!extra.nm });
        if (!r) return null;
        r.perPageFrame = !!G; r.law = law; r.lag = lag; r.mapShape = m0 && typeof m0.shape === 'string' ? m0.shape : 'unknown'; r.targetsFree = offs.length; r.prm = { ...toPrm(r.p), ...snapP }; r.dtFrame = dt0;
        r.map = m0 ? { shape: r.mapShape, a: m0.p[0], b: m0.p[1], s0: m0.p[2], s1: m0.p[3], targets: 'fitted per held offset (shape not identified)', shapeIdentified: false } : { shape: 'unknown', a: NaN, b: NaN, s0: NaN, s1: NaN, targets: 'fitted per held offset', shapeIdentified: false };
        const tp = r.p.slice(nm); r.refit = (use) => (nm === 0 ? { predictFull: f(r.p) } : fitModel({ family: law, cls: r.cls, T, y, spec, f: (q) => f([...q, ...tp]), starts: [r.p.slice(0, nm)], sigma: nf.sigma, use, noCI: true }));
        if (extra.snap) { r.k += 1; r.bic = bicOf(r.rss, r.n, r.k, nf.sigma); r.family = `${law}+snap`; r.params.eps = { value: extra.snap.eps, unit: null, ci95: Number.isFinite(extra.snap.hi) ? [extra.snap.lo, extra.snap.hi] : null }; }
        for (let j = 0; j < offs.length; j++) delete r.params[`g${j}`];
        r.family += ' (targets per offset)'; return r;
      };
      // α seed from OLS through the origin with the last value of each hold as its target
      let num = 0, den = 0; for (let k = 1; k < y.length; k++) { const g = lastAt.get(sy[Math.max(0, k - lag)]); const e = g - y[k - 1]; if (Number.isFinite(e) && Math.abs(e) > nf.sigma * 3) { num += (y[k] - y[k - 1]) * e; den += e * e; } }
      let a0 = den > 0 ? Math.min(1, Math.max(1e-4, num / den)) : 0.3; if (G) a0 = 1 - Math.pow(1 - Math.min(0.999999, a0), 1 / G.stride); const dtF0 = G ? G.TF[1] - G.TF[0] : dt0; const lam = (a) => -Math.log(1 - Math.min(0.999, a)) / (dtF0 / 1000);
      const SMF = [['ema', [{ name: 'alpha', lo: 1e-4, hi: 1, scale: 0.01 }], (p) => ({ alpha: p[0] }), {}, [[a0], [Math.min(1, a0 * 1.5)]]],
        ['dtdamp', [{ name: 'lambda', lo: 1e-3, hi: 1e4, scale: 1, unit: '1/s' }], (p) => ({ lambda: p[0] }), {}, [[lam(a0)]]],
        ['asym', [{ name: 'alphaUp', lo: 1e-4, hi: 1, scale: 0.01 }, { name: 'alphaDown', lo: 1e-4, hi: 1, scale: 0.01 }], (p) => ({ alphaUp: p[0], alphaDown: p[1] }), { cls: 'asymmetric smoothing' }, [[a0, a0], [1, a0], [a0, 1]]]];
      const base = SMF.map(([law, spec, toPrm, extra, st]) => { const r = mkF(law, spec, st, toPrm, extra); if (r) out.push(r); return r; });
      const tgt = sy.map((_, k) => lastAt.get(sy[Math.max(0, k - lag)]));
      SMF.forEach(([law, spec, toPrm, extra], j) => { const r = base[j]; if (!r || r.rms <= nf.sigma) return; const tb = new Map(offs.map((o, q) => [o, r.p[spec.length + q]]));
        const sn = estimateSnap(law, r.prm, sy.map((_, k) => tb.get(sy[Math.max(0, k - lag)])), y, T, Math.max(nf.sigma, 1e-12 * (nf.A || 1)), G ? G.stride : 1, nf.quantum || 0); void tgt;
        if (sn) { const r2 = mkF(law, spec, [r.p.slice(0, spec.length)], toPrm, { ...extra, snap: sn }); if (r2) out.push(r2); } });
      const rr = mkF('restarted', [{ name: 'L', lo: dt0, hi: 5000, scale: 10, unit: 'ms' }, { name: 'delay', lo: 0, hi: dt0, scale: dt0 / 4, unit: 'ms' }], [[300, dt0 / 2], [800, dt0 / 2]], (p) => ({ L: p[0], delay: p[1], E: NAMED['expo.out'].fn }), { cls: 'restarted tween', nm: true });
      if (rr && rr.prm.L + rr.prm.delay > dt0 * 1.01) { rr.ease = 'expo.out'; if (rr.prm.L >= minHold) { rr.cls = 'first-order smoothing'; rr.family = 'restarted expo.out (unfinished ≡ dt-damp)'; rr.degenerate = true; } out.push(rr); }
    }
  }
  };
  // only when no parametric map explains: where one does, the extra free parameters only add rivals (M02 at R6)
  if (!explained()) freeTargets();
  return { out: out.filter(Boolean), pairs, maps: mapFits };
}

/**
 * Map seeds by inverting a per-frame first-order smoother: for a rate α the implied driver is g_k = x_(k−1) +
 * (x_k − x_(k−1))/α (α = 1: the series itself, an unsmoothed map). The α whose implied (offset, g) pairs a map shape
 * fits best seeds the joint fits (shape, a, b, s0, s1); the dynamics are then fitted on every frame as usual.
 * Lab cases M01/M02/M03/M04/M09 on the dense `speed` sweep (no holds, so no settled pairs).
 */
export function invertedMapSeeds(s, sy, nf, G = null) {
  const y = s.y; const n = y.length; if (n < 8) return [];
  const idx = []; const step = Math.max(1, Math.floor((n - 1) / 40)); for (let k = 1; k < n; k += step) if (Number.isFinite(sy[k])) idx.push(k);
  const A = nf.A || (Math.max(...y) - Math.min(...y)) || 1; const best = new Map();
  const cache = new Map();   // L9-B: the offsets are the same for every α: the shape profile is computed once per shape (bit-identical)
  const alphas = [1]; for (let a = 0.6; a >= 0.012; a *= 0.82) alphas.push(a);
  for (const a0 of alphas) {
    const a = G && G.stride > 1 ? 1 - Math.pow(1 - Math.min(a0, 0.999999), G.stride) : a0;   // per sample at a stride
    const pairs = idx.map((k) => ({ s: sy[k], y: y[k - 1] + (y[k] - y[k - 1]) / a }));
    if (pairs.some((q) => !Number.isFinite(q.y) || Math.abs(q.y) > 1e6 * A)) continue;
    // ranking by the cheap profile only (grid OLS); the full fit runs once per shape at its best α
    for (const sh of Object.keys(MAP_SHAPES)) {
      const m = fitMapShape(sh, pairs, nf.sigma / a, { profileOnly: true, gridN: 24, cache }); if (!m) continue;
      const prev = best.get(sh); if (!prev || m.rss < prev.rss) best.set(sh, { rss: m.rss, a, a0, pairs });
    }
  }
  // refine α per shape (golden section in log α between the neighbouring grid values): a grid α off by one step leaves
  // a large inversion residual that can rank the wrong shape first (lab case M02 speed draw: α 0.323 between 0.33/0.27)
  const pairsAt = (a0) => { const a = G && G.stride > 1 ? 1 - Math.pow(1 - Math.min(a0, 0.999999), G.stride) : a0; return { a, pairs: idx.map((k) => ({ s: sy[k], y: y[k - 1] + (y[k] - y[k - 1]) / a })) }; };
  // every shape is refined and returned (the caller tries the best three first, the rest only when nothing explains):
  // the coarse 24-point corner grid can rank the true shape low (lab case M01 g4 speed at R3: linear outside the top 4)
  const ref = [...best.entries()].sort((u, v) => u[1].rss - v[1].rss).map(([sh, b]) => {
    const f = (la) => { const { pairs } = pairsAt(Math.exp(la)); const m = fitMapShape(sh, pairs, nf.sigma, { profileOnly: true, gridN: 24, cache }); return m ? m.rss : Infinity; };
    let lo = Math.log(Math.max(0.005, b.a0 * 0.82)), hi = Math.log(Math.min(1, b.a0 / 0.82));
    const gr = (Math.sqrt(5) - 1) / 2; let x1 = hi - gr * (hi - lo), x2 = lo + gr * (hi - lo), f1 = f(x1), f2 = f(x2);
    for (let it = 0; it < 18; it++) { if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - gr * (hi - lo); f1 = f(x1); } else { lo = x1; x1 = x2; f1 = f2; x2 = lo + gr * (hi - lo); f2 = f(x2); } }
    const la = f1 < f2 ? x1 : x2; const fr = Math.min(f1, f2);
    return fr < b.rss ? { sh, rss: fr, a0: Math.exp(la) } : { sh, rss: b.rss, a0: b.a0 };
  }).sort((u, v) => u.rss - v.rss);
  return ref.map((b) => { const { a, pairs } = pairsAt(b.a0); const m = fitMapShape(b.sh, pairs, nf.sigma / a); if (m) m.seedAlpha = b.a0; return m; }).filter(Boolean).sort((u, v) => u.rss - v.rss);
}

/** Stored smoothing form (S3 §4.3). */
export function smoothingForm(r, dtMs, law) {
  const alpha = r.law === 'ema' ? r.prm.alpha : r.law === 'dtdamp' ? 1 - Math.exp(-r.prm.lambda * dtMs / 1000) : null;
  const lambda = r.law === 'dtdamp' ? r.prm.lambda : alpha != null && alpha < 1 ? -Math.log(1 - alpha) / (dtMs / 1000) : null;
  const tau = lambda ? 1000 / lambda : null;
  return { type: r.law, alpha, lambda, snap_eps: r.prm.eps ?? null, asymmetric: r.law === 'asym' ? { alpha_up: r.prm.alphaUp, alpha_down: r.prm.alphaDown, snap_on_rise: r.prm.alphaUp > 0.999 } : null,
    law: law || 'unknown', measured_at_hz: dtMs ? 1000 / dtMs : null, settle_frames: alpha ? Math.ceil(Math.log(1e-3) / Math.log(1 - alpha)) : null, tau_ms: tau };
}

/**
 * Scrub of a timeline (look, native scroll; D-SCROLLBUDGET-1): GSAP's ScrollTrigger smooths the PROGRESS of the whole
 * animation it scrubs (restarted expo.out of scrub seconds toward the clamped progress) and each child tween then maps
 * that smoothed progress through its own position and ease. A child that ends before the timeline does (a real page: the
 * horizontal rail stops at 99.5 % of its trigger range) has a sharp corner where the smoothed progress crosses its end,
 * which a smoother of the child's own clamped map rounds off (rms 6.7 px against a 3.9 px bar on a 7890 px rail).
 * Model: g_k = clamp(scrollY_(k−lag), c0, c1) (c0 = s0 − d0, c1 = s1 + d1), v = restarted expo.out (L, delay) of g,
 * x = a + b · S((v − s0) / (s1 − s0)) clamped. d0 = d1 = 0 is the smoother of a single tween's own range.
 * `seed`: {lag, L, map:{shape,a,b,s0,s1}}; `fixed`: {L, delay, d0, d1} reuses another channel's smoothed progress (same
 * timeline), fitting the map only. Returns fitModel candidates (law 'restarted', ease expo.out), best first.
 */
export function timelineScrub(s, sy, nf, seed, { fixed = null, shapes = null } = {}) {
  const T = s.T, y = s.y; const dt = (T.at(-1) - T[0]) / Math.max(1, T.length - 1); const E = NAMED['expo.out'].fn;
  const fin = sy.filter(Number.isFinite); if (!fin.length || !seed || !seed.map) return [];
  const syLo = Math.min(...fin), syHi = Math.max(...fin); const span = Math.max(1, syHi - syLo);
  const lags = fixed ? [fixed.lag] : [0, 1, 2]; const out = [];
  const shapeList = [...new Set([...(shapes || []), seed.map.shape, 'linear'].filter((sh) => MAP_SHAPES[sh]))];
  for (const lag of lags) {
  const progress = (L, delay, c0, c1) => { const g = sy.map((_, k) => { const v = sy[Math.max(0, k - lag)]; return Number.isFinite(v) ? Math.min(c1, Math.max(c0, v)) : NaN; });
    return simulateSmoother('restarted', { L, delay, E }, g, T, g.find(Number.isFinite) ?? 0); };
  for (const shape of shapeList) {
    const S = MAP_SHAPES[shape]; const { a, b, s0, s1 } = seed.map;
    const mapOn = (v, ma, mb, ms0, ms1r) => { const ms1 = Math.max(ms1r, ms0 + 1e-6); return v.map((q) => ma + mb * S(clamp01((q - ms0) / (ms1 - ms0)))); };
    const mapSpec = [{ name: 'mapA', scale: Math.abs(a) || 1 }, { name: 'mapB', scale: Math.abs(b) || 1 }, { name: 'mapS0', scale: 1, unit: 'px' }, { name: 'mapS1', scale: 1, unit: 'px' }];
    let spec, f, starts;
    if (fixed) {
      // the shared progress keeps its own clamp range (c0, c1) and dynamics: only this channel's map is fitted
      const v = progress(fixed.L, fixed.delay, fixed.c0, fixed.c1);
      spec = mapSpec; f = (p) => mapOn(v, p[0], p[1], p[2], p[3]); starts = [[a, b, s0, s1]];
    } else {
      const L0 = Math.min(5000, Math.max(dt, seed.L || 300));
      // the restart is aligned to the frame before the change (GSAP's resetTo puts the playhead at the last tick): no
      // delay parameter. A delay trades with L on a sweep that restarts every frame and makes the search land in a far
      // basin (measured on a real page: rms 15-28 px from the delayed start against 2.2 px without)
      spec = [{ name: 'L', lo: dt, hi: 5000, scale: 10, unit: 'ms' }, ...mapSpec,
        { name: 'd0', lo: 0, hi: span, scale: 1, unit: 'px' }, { name: 'd1', lo: 0, hi: span, scale: 1, unit: 'px' }];
      f = (p) => { const s1x = Math.max(p[4], p[3] + 1e-6); return mapOn(progress(p[0], 0, p[3] - p[5], s1x + p[6]), p[1], p[2], p[3], p[4]); };
      starts = [[L0, a, b, s0, s1, 0, 0.02 * Math.abs(s1 - s0)], ...(syHi > s1 + 1 ? [[L0, a, b, s0, s1, 0, syHi - s1]] : [])];
    }
    const r = fitModel({ family: 'restarted', cls: 'restarted tween', T, y, spec, f, starts, sigma: nf.sigma, nm: true, nmIter: 1500 });
    if (!r) continue;
    const q = fixed ? [fixed.L, fixed.delay, ...r.p, fixed.d0, fixed.d1] : [r.p[0], 0, ...r.p.slice(1)];
    const [L, delay, ma, mb, ms0, ms1r, d0, d1] = q; const ms1 = Math.max(ms1r, ms0 + 1e-6);
    const c0 = fixed ? fixed.c0 : ms0 - d0, c1 = fixed ? fixed.c1 : ms1 + d1;
    r.law = 'restarted'; r.lag = lag; r.ease = 'expo.out'; r.mapShape = shape; r.prm = { L, delay, E }; r.dtFrame = dt; r.timelineScrub = true;
    r.map = { shape, a: ma, b: mb, s0: ms0, s1: ms1 };
    r.family = `restarted expo.out (scrubbed timeline${fixed ? ', shared progress' : ''})`;
    for (const k of ['d0', 'd1']) delete r.params[k];
    if (fixed) r.params.L = { value: fixed.L, unit: 'ms', ci95: fixed.ci95 && fixed.ci95.L || null, shared: true };
    r.refit = (use) => fitModel({ family: 'restarted', cls: r.cls, T, y, spec, f, starts: [r.p], sigma: nf.sigma, use, noCI: true });
    r.progress = { L, delay, c0, c1, d0, d1, lag, shared: !!fixed, ci95: { L: r.params.L && r.params.L.ci95 } };
    out.push(r);
  }
  }
  // one candidate per shape. On a sweep that moves the offset by the same step every frame, a lag of one frame is the
  // same curve with both corners one step earlier (a real page: 100 px per frame, rms equal to 4 digits at lags 0, 1, 2):
  // the first lag that explains is kept (0: the page reads the offset in the frame it changed) and the corners' intervals
  // cover every lag that explains too, so the trade-off is reported, not hidden
  const best = [];
  for (const shape of new Set(out.map((r) => r.mapShape))) {
    const list = out.filter((r) => r.mapShape === shape); const ok = list.filter((r) => r.rms <= nf.explainBar);
    const r = ok[0] || [...list].sort((u, v) => u.rss - v.rss)[0];
    if (ok.length > 1) {
      for (const [k, key] of [['s0', 'mapS0'], ['s1', 'mapS1']]) { const P = r.params[key]; if (!P) continue;
        const lo = Math.min(...ok.map((q) => (q.params[key] && q.params[key].ci95 ? q.params[key].ci95[0] : q.map[k]))), hi = Math.max(...ok.map((q) => (q.params[key] && q.params[key].ci95 ? q.params[key].ci95[1] : q.map[k])));
        P.ci95 = [lo, hi]; P.ciMethod = `covers driver lags ${ok.map((q) => q.lag).join(', ')} (each explains; the lag and the corner trade off on this sweep)`; }
      r.lagTrade = ok.map((q) => ({ lag: q.lag, s0: q.map.s0, s1: q.map.s1, rms: q.rms }));
    }
    best.push(r);
  }
  return best.sort((u, v) => u.rss - v.rss);
}
