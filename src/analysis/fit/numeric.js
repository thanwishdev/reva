// Numeric core of the fitter (own code): Levenberg–Marquardt with bounds, covariance + t-intervals, profile
// likelihood intervals, small linear algebra. Plain JS, no dependency (D-M2-1). Nelder–Mead is vendored
// (./vendor/understudy/optimize.js).
import { nelderMead } from './vendor/understudy/optimize.js';
export { nelderMead };

/**
 * Deterministic fit work meter (corpus FITFIX): every model evaluation inside an optimiser (fitModel residuals,
 * Nelder–Mead objective, LM Jacobian columns, integrator simulations) charges the number of frames it evaluates
 * (integrator sub-steps weighted). The S4 smoothing budget counted only driver-smoothing samples; profiling the takes
 * that still timed out showed the cost in spring identification (identifySpring → fitHypothesis, ~60–95 % of CPU) and
 * the analytic spring / named-tween fits, which it did not count. fitTakeSet arms the meter with a per-channel and a
 * per-take limit; past a limit every further evaluation throws FitBudgetError (sticky, so a throw swallowed by a
 * candidate's own try/catch cannot leave a half-searched fit looking complete: the caller checks meter.hit and drops
 * the channel's result). Work units only, never the clock: the cut point depends on the input alone.
 */
export const meter = { units: 0, chan: 0, limit: Infinity, chanLimit: Infinity, hit: null, stage: 0, stageLimit: Infinity, where: null, hitAt: null };
export class FitBudgetError extends Error { constructor(kind) { super(`fit evaluation budget reached (${kind})`); this.budget = kind; } }
export function charge(n) {
  if (meter.hit) throw new FitBudgetError(meter.hit);
  meter.units += n; meter.chan += n; meter.stage += n;
  if (meter.units > meter.limit) meter.hit = 'take'; else if (meter.chan > meter.chanLimit) meter.hit = 'channel'; else if (meter.stage > meter.stageLimit) meter.hit = 'stage';
  if (meter.hit) { meter.hitAt = meter.where; throw new FitBudgetError(meter.hit); }
}
/**
 * Run `fn` under a stage budget (look: the integrator identification of a spring). `fn` gets `cut()`, true once the stage
 * budget is spent: the stage hit is cleared here so the caller can keep what the stage finished before it (a partial,
 * labelled result), while a channel or take hit passes through untouched. Returns the number of evaluations the stage used.
 * Stage limits do not nest: an inner call replaces the outer one for its duration.
 * @param {number} limit  evaluations (Infinity / non-positive: no stage limit)
 * @param {(cut:()=>boolean)=>void} fn
 */
export function withStage(limit, fn) {
  const saved = { stage: meter.stage, stageLimit: meter.stageLimit };
  meter.stage = 0; meter.stageLimit = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
  try { fn(() => meter.hit === 'stage'); return meter.stage; } finally { if (meter.hit === 'stage') meter.hit = null; meter.stage = saved.stage; meter.stageLimit = saved.stageLimit; }
}

export const sum = (a) =>{ let s = 0; for (const v of a) s += v; return s; };
export const sse = (r) => { let s = 0; for (const v of r) s += v * v; return s; };
export const rms = (r) => (r.length ? Math.sqrt(sse(r) / r.length) : NaN);
export const median = (a) => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** Solve A x = b (A n×n, row arrays) by Gaussian elimination with partial pivoting. Returns null if singular. */
export function solve(A, b) {
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-300)) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x.every(Number.isFinite) ? x : null;
}

/** Inverse of a symmetric positive (semi)definite matrix; null when singular. */
export function invert(A) {
  const n = A.length; const out = [];
  for (let j = 0; j < n; j++) { const e = new Array(n).fill(0); e[j] = 1; const c = solve(A, e); if (!c) return null; out.push(c); }
  return A.map((_, i) => out.map((c) => c[i]));
}

/** Ordinary least squares y ≈ X β (X rows). Returns {beta, rss} or null. */
export function ols(X, y) {
  const p = X[0].length; const A = Array.from({ length: p }, () => new Array(p).fill(0)); const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < p; a++) { b[a] += X[i][a] * y[i]; for (let c = 0; c < p; c++) A[a][c] += X[i][a] * X[i][c]; }
  const beta = solve(A, b); if (!beta) return null;
  let rss = 0; for (let i = 0; i < X.length; i++) { let f = 0; for (let a = 0; a < p; a++) f += X[i][a] * beta[a]; rss += (y[i] - f) ** 2; }
  return { beta, rss };
}

/** Numeric Jacobian (forward differences) of residual vector function r(p). */
export function jacobian(r, p, r0, scale) {
  const J = Array.from({ length: r0.length }, () => new Array(p.length).fill(0));
  for (let j = 0; j < p.length; j++) {
    const h = 1e-7 * Math.max(Math.abs(p[j]), scale ? scale[j] : 1e-3, 1e-9);
    const q = p.slice(); q[j] += h; const r1 = r(q);
    for (let i = 0; i < r0.length; i++) J[i][j] = (r1[i] - r0[i]) / h;
  }
  return J;
}

/**
 * Levenberg–Marquardt on a residual function with box bounds (projected steps).
 * @param {(p:number[])=>ArrayLike<number>} rf residual vector
 * @param {number[]} p0
 * @param {{lower?:number[], upper?:number[], maxIter?:number, scale?:number[]}} [o]
 */
export function lm(rf, p0, o = {}) {
  if (o.into) return lmInto(o.into, o.m, p0, o);
  const n = p0.length; const lo = o.lower || new Array(n).fill(-Infinity), hi = o.upper || new Array(n).fill(Infinity);
  const proj = (p) => p.map((v, i) => clamp(v, lo[i], hi[i]));
  const R = (p) => { const r = rf(p); for (let i = 0; i < r.length; i++) if (!Number.isFinite(r[i])) return null; return r; };
  let p = proj(p0.slice()); let r = R(p); if (!r) return { p, rss: Infinity, iters: 0, ok: false };
  let f = sse(r); let lam = 1e-3; let it = 0;
  for (; it < (o.maxIter || 100); it++) {
    // L8 (fit speed): the Jacobian is held column-wise in typed arrays instead of an array of row arrays (allocating the
    // rows was ~7 % of a scroll take's fit CPU). Same evaluations in the same order (column j ascending, so the meter
    // charges and any budget throw happen at the same call), same forward differences, and JᵀJ / Jᵀr accumulate over
    // the rows in the same order: the result is bit-identical to jacobian() + the row loop.
    const m = r.length; const cols = new Array(n);
    for (let j = 0; j < n; j++) {
      const h = 1e-7 * Math.max(Math.abs(p[j]), o.scale ? o.scale[j] : 1e-3, 1e-9);
      const q = p.slice(); q[j] += h; const r1 = rf(q); const c = new Float64Array(m);
      for (let i = 0; i < m; i++) c[i] = (r1[i] - r[i]) / h;
      cols[j] = c;
    }
    // each entry is summed over the rows in ascending order from 0, as the row loop did (one accumulator per entry)
    const A = Array.from({ length: n }, () => new Array(n).fill(0)); const g = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      const ca = cols[a]; let sg = 0; for (let i = 0; i < m; i++) sg += ca[i] * r[i]; g[a] = sg;
      for (let b = a; b < n; b++) { const cb = cols[b]; let s = 0; for (let i = 0; i < m; i++) s += ca[i] * cb[i]; A[a][b] = s; }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const M = A.map((row, a) => row.map((v, b) => (a === b ? v + lam * Math.max(v, 1e-30) : v)));
      const d = solve(M, g.map((v) => -v));
      if (!d) { lam *= 10; continue; }
      const q = proj(p.map((v, i) => v + d[i])); const rq = R(q);
      const fq = rq ? sse(rq) : Infinity;
      if (fq < f) { const rel = (f - fq) / Math.max(f, 1e-300); p = q; r = rq; f = fq; lam = Math.max(lam / 5, 1e-12); improved = true; if (rel < 1e-12) it = 1e9; break; }
      lam *= 8;
    }
    if (!improved) break;
  }
  return { p, rss: f, r, iters: it, ok: true };
}

/**
 * L9-A (fit speed): lm with the residuals written into preallocated buffers. `into(p, out)` fills out[0..m) with the
 * residual vector rf(p) would return (same values, same evaluation and meter charge per call). Every step of lm above
 * is kept with the same operations in the same order: the residual check and its SSE run in one pass over the same
 * values in the same order (a non-finite residual rejects the point before its sum is used, as R() did), the Jacobian
 * column is evaluated into its own buffer and turned into the forward difference in place ((r1[i] − r[i]) / h), the
 * current and trial residuals swap buffers on acceptance. Result p / rss / iters are bit-identical to lm(rf, …); `r`
 * is the current residual buffer (a Float64Array).
 */
function lmInto(into, m, p0, o) {
  const n = p0.length; const lo = o.lower || new Array(n).fill(-Infinity), hi = o.upper || new Array(n).fill(Infinity);
  const proj = (p) => p.map((v, i) => clamp(v, lo[i], hi[i]));
  // residuals into buf; their SSE, or −1 when one is not finite (R() returned null)
  const Rs = (p, buf) => { into(p, buf); let s = 0; for (let i = 0; i < m; i++) { const v = buf[i]; if (!Number.isFinite(v)) return -1; s += v * v; } return s; };
  let r = new Float64Array(m), rq = new Float64Array(m);
  let p = proj(p0.slice()); let f = Rs(p, r); if (f < 0) return { p, rss: Infinity, iters: 0, ok: false };
  const cols = Array.from({ length: n }, () => new Float64Array(m));
  const A = Array.from({ length: n }, () => new Array(n).fill(0)); const g = new Array(n).fill(0);
  const vecs = new Array(n + 1), dots = new Float64Array(n + 1);
  let lam = 1e-3; let it = 0;
  for (; it < (o.maxIter || 100); it++) {
    for (let j = 0; j < n; j++) {
      const h = 1e-7 * Math.max(Math.abs(p[j]), o.scale ? o.scale[j] : 1e-3, 1e-9);
      const q = p.slice(); q[j] += h; const c = cols[j]; into(q, c);
      for (let i = 0; i < m; i++) c[i] = (c[i] - r[i]) / h;
    }
    // g[a] = Σ ca·r and A[a][b] = Σ ca·cb (b ≥ a): several entries per pass over the rows, each entry still its own
    // accumulator summed over i ascending from 0 (the same sums; the passes only stop waiting on one add chain)
    for (let a = 0; a < n; a++) {
      vecs[0] = r; for (let b = a; b < n; b++) vecs[1 + b - a] = cols[b];
      dotsInto(cols[a], vecs, n - a + 1, m, dots);
      g[a] = dots[0]; for (let b = a; b < n; b++) A[a][b] = dots[1 + b - a];
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const M = A.map((row, a) => row.map((v, b) => (a === b ? v + lam * Math.max(v, 1e-30) : v)));
      const d = solve(M, g.map((v) => -v));
      if (!d) { lam *= 10; continue; }
      const q = proj(p.map((v, i) => v + d[i])); const sq = Rs(q, rq);
      const fq = sq < 0 ? Infinity : sq;
      if (fq < f) { const rel = (f - fq) / Math.max(f, 1e-300); p = q; const t = r; r = rq; rq = t; f = fq; lam = Math.max(lam / 5, 1e-12); improved = true; if (rel < 1e-12) it = 1e9; break; }
      lam *= 8;
    }
    if (!improved) break;
  }
  return { p, rss: f, r, iters: it, ok: true };
}

/**
 * out[q] = Σ_i x[i]·vecs[q][i] for q < k, each sum in its own accumulator over i = 0 … m−1 ascending (bit-identical to
 * one loop per q); four, then two sums share a pass over the rows.
 */
export function dotsInto(x, vecs, k, m, out) {
  let q = 0;
  for (; q + 4 <= k; q += 4) {
    const v0 = vecs[q], v1 = vecs[q + 1], v2 = vecs[q + 2], v3 = vecs[q + 3]; let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let i = 0; i < m; i++) { const xi = x[i]; s0 += xi * v0[i]; s1 += xi * v1[i]; s2 += xi * v2[i]; s3 += xi * v3[i]; }
    out[q] = s0; out[q + 1] = s1; out[q + 2] = s2; out[q + 3] = s3;
  }
  for (; q + 2 <= k; q += 2) {
    const v0 = vecs[q], v1 = vecs[q + 1]; let s0 = 0, s1 = 0;
    for (let i = 0; i < m; i++) { const xi = x[i]; s0 += xi * v0[i]; s1 += xi * v1[i]; }
    out[q] = s0; out[q + 1] = s1;
  }
  for (; q < k; q++) { const v0 = vecs[q]; let s0 = 0; for (let i = 0; i < m; i++) s0 += x[i] * v0[i]; out[q] = s0; }
}

/** Two-sided 97.5 % Student-t quantile (Cornish–Fisher expansion; exact enough for df ≥ 3). */
export function t975(df) {
  if (!(df > 0)) return Infinity; const z = 1.959963985;
  const g1 = (z ** 3 + z) / 4, g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96, g3 = (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3;
}

/**
 * Covariance-based 95 % intervals at the optimum: σ_eff²(JᵀJ)⁻¹ with σ_eff = max(σ_floor, sqrt(RSS/(n−p))) (design §5.4).
 * Returns half-widths (Infinity when the information matrix is singular).
 */
export function ciHalfWidths(rf, p, rss, n, sigmaFloor, scale) {
  const r0 = rf(p); const J = jacobian(rf, p, r0, scale); const k = p.length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < J.length; i++) for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) A[a][b] += J[i][a] * J[i][b];
  let inv = invert(A); let lam = 0;
  // a singular JᵀJ (redundant parameters, e.g. the corners of a map whose clamps no sample reaches: lab case M13 pointer
  // map at R4) must not take the identified parameters' intervals with it: a tiny ridge keeps the inverse defined and
  // a parameter whose variance is carried by the ridge (λ·var not ≪ 1) is reported as unidentified (∞)
  if (!inv || inv.some((r, i) => !(r[i] > 0) || !Number.isFinite(r[i]))) {
    const dmax = Math.max(...A.map((r, i) => Math.abs(r[i])), 1e-300); lam = 1e-10 * dmax;
    inv = invert(A.map((r, i) => r.map((v, j) => (i === j ? v + lam : v))));
  }
  const sEff = Math.max(sigmaFloor, Math.sqrt(rss / Math.max(1, n - k)));
  const t = t975(Math.max(1, n - k));
  // numerical resolution: the solver works with a forward-difference Jacobian of step h = 1e-7·max(|p|, scale), so it
  // cannot place an optimum closer than about h; an interval narrower than 2h claims a precision the solver does not
  // have (lab cases: noise-free hx takes where the statistical width collapses to 1e-12 relative and the estimate is off
  // by 1e-8 — M07 c, M09 τ, M10 stopping at R2–R5; calibration A1.6 d)
  const hNum = (i) => 2e-7 * Math.max(Math.abs(p[i]), scale ? scale[i] : 1e-3, 1e-9);
  return p.map((_, i) => (inv && inv[i][i] > 0 && Number.isFinite(inv[i][i]) && !(lam && lam * inv[i][i] > 1e-3) ? Math.max(t * sEff * Math.sqrt(inv[i][i]), hNum(i)) : Infinity));
}

/** Likelihood term L = n·ln(RSS_eff/n), RSS_eff = max(RSS, n·σ_floor²) (design §5.1–5.2). */
export function likelihood(rss, n, sigmaFloor) { const eff = Math.max(rss, n * sigmaFloor * sigmaFloor, 1e-300); return n * Math.log(eff / n); }
export function bic(rss, n, p, sigmaFloor) { return likelihood(rss, n, sigmaFloor) + p * Math.log(n); }

/**
 * Profile-likelihood 95 % interval for parameter `idx`: the set of values where the re-optimised likelihood rises
 * by ≤ 3.84 (χ²₁) above the optimum. `refit(value)` returns the re-optimised RSS with parameter idx fixed.
 */
export function profileCI(refit, est, n, sigmaFloor, { rel = 0.02, step = null, maxSteps = 24 } = {}) {
  const L0 = likelihood(refit(est), n, sigmaFloor); const out = [];
  for (const dir of [-1, 1]) {
    let stepv = step || Math.abs(est) * rel || rel; let inside = est, outside = null;
    for (let s = 0; s < maxSteps; s++) {
      const v = est + dir * stepv; const L = likelihood(refit(v), n, sigmaFloor);
      if (!(L - L0 <= 3.84)) { outside = v; break; }
      inside = v; stepv *= 2;
    }
    if (outside == null) { out.push(dir < 0 ? -Infinity : Infinity); continue; }
    for (let b = 0; b < 16; b++) { const m = (inside + outside) / 2; const L = likelihood(refit(m), n, sigmaFloor); if (L - L0 <= 3.84) inside = m; else outside = m; }
    out.push(inside);
  }
  return out;
}

/** mulberry32 PRNG (seeded draws for the lab runner). */
export function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
