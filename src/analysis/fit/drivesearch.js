// L9-B (fit speed, FIT-SPEED idea 1): the search of the scroll-driver fits of smoothing.js perMap with the models' own
// derivatives. The post-L9-A search (multi-start Nelder–Mead + LM with forward-difference Jacobians over [dynamics…, a, b,
// s0, s1]) is the reference; REVA_FIT_SEARCH chooses (searchMode):
//  - 'exact': the post-L9-A search, untouched (fitModel without a search hook);
//  - 'jacobian': the same search with the forward-difference Jacobian replaced by forward sensitivities: one pass gives
//    x_k and ∂x_k/∂p (each law's recursion differentiated) and accumulates JᵀJ, Jᵀr and the SSE as it goes, in place of P + 1
//    simulations and a Jacobian matrix per LM iteration. Same starts, same Nelder–Mead for the restarted tween, same LM
//    schedule: with a forward-difference pass it reproduces the post-L9-A fits byte for byte (lanes/L9B.md), so the
//    Jacobian is its only difference;
//  - 'varpro': the full structured optimiser: variable projection of the map's (a, b) (none / EMA / dt-damp / the restarted
//    tween without snap are affine in them), gain-ratio LM with a stop that fires, and a log grid over L × delay for the
//    restarted tween in place of Nelder–Mead.
// The SSE reported is always the exact evaluator's (simResidFused) at the optimum found. Identical starts run once.
import { charge, nelderMead } from './numeric.js';
import { NAMED } from './eases.js';
import { clamp01 } from '../oracles.js';

/**
 * REVA_FIT_SEARCH, read per call: 'jacobian' or 'varpro' (see driverSearch); anything else is 'exact', the post-L9-A
 * search (no search hook at all). The default stays 'exact' until the owner decides (lanes/L9B.md): neither faster mode
 * met the L9-B proof gate (both flip knife-edge class decisions that the post-L9-A output itself does not hold under a 1 %
 * change of its forward-difference step). Flip DEFAULT_SEARCH to make one of them the default.
 */
export const DEFAULT_SEARCH = 'exact';
export const searchMode = () => { const m = process.env.REVA_FIT_SEARCH || DEFAULT_SEARCH; return m === 'jacobian' || m === 'varpro' ? m : 'exact'; };

/** Counters of the fast search (measurement only; never read by the fit). */
export const searchStats = { searches: 0, fallbacks: 0, lm: 0, lmIters: 0, lmCapped: 0, passes: 0, gridPasses: 0, dupStarts: 0 };

const powD = (n) => ({ in: (p) => n * p ** (n - 1), out: (p) => n * (1 - p) ** (n - 1), inOut: (p) => (p < 0.5 ? 2 ** (n - 1) * n * p ** (n - 1) : n * (-2 * p + 2) ** (n - 1)) });
const d2 = powD(2), d3 = powD(3), d4 = powD(4);
/** S′(u) of every MAP_SHAPES entry on (0, 1) (the branches of the inOut eases split where theirs do). */
export const SHAPE_DERIV = {
  linear: () => 1, smoothstep: (u) => 6 * u * (1 - u), smootherstep: (u) => 30 * u * u * (1 - u) * (1 - u),
  easeInQuad: d2.in, easeOutQuad: d2.out, easeInOutQuad: d2.inOut, easeInCubic: d3.in, easeOutCubic: d3.out, easeInOutCubic: d3.inOut,
  easeInQuart: d4.in, easeOutQuart: d4.out, easeInOutQuart: d4.inOut,
};
/** E′(p) of the restarted tween's eases on (0, 1), keyed by the ease function. */
export const EASE_DERIV = new Map([
  [NAMED['expo.out'].fn, (p) => 10 * Math.LN2 * 2 ** (-10 * p)],
  [NAMED.easeOutQuad.fn, (p) => 2 * (1 - p)],
  [NAMED.easeOutCubic.fn, (p) => 3 * (1 - p) * (1 - p)],
]);
/** Which derivative slot (0 or 1) of a law each dynamics parameter is (spec names), or null when the law/spec is not covered. */
export function dynSlots(law, spec) {
  const names = { none: [], ema: ['alpha'], dtdamp: ['lambda'], asym: ['alphaUp', 'alphaDown'], restarted: ['L', 'delay'] }[law];
  if (!names) return null; const out = [];
  for (const q of spec) { const i = names.indexOf(q.name); if (i < 0) return null; out.push(i); }
  return new Set(out).size === out.length ? out : null;
}

/**
 * perMap's map driver per distinct offset, with its derivatives: v = a + b·S(t), t = (s − s0)/den, den = s1 − s0 with
 * s1 = max(s1r, s0 + 1e-6), the clamped ends read S(0) / S(1). v is mapDriverVals' expression (same values); db = ∂v/∂b,
 * d0 = ∂v/∂s0, d1 = ∂v/∂s1r (∂v/∂a = 1). An offset on a clamped end has no corner derivative.
 */
export function driverSens(S, Sd, S0, S1, a, b, s0, s1r, vals, out) {
  const s1 = Math.max(s1r, s0 + 1e-6); const den = s1 - s0 || 1e-9; const tied = !(s1r >= s0 + 1e-6);   // tied: s1 follows s0
  const v = out.v, db = out.db, d0 = out.d0, d1 = out.d1;
  for (let j = 0; j < vals.length; j++) {
    const sc = vals[j]; const t = (sc - s0) / den;
    if (t <= 0) { v[j] = a + b * S0; db[j] = S0; d0[j] = 0; d1[j] = 0; }
    else if (t >= 1) { v[j] = a + b * S1; db[j] = S1; d0[j] = 0; d1[j] = 0; }
    else {
      const u = S(clamp01(t)); v[j] = a + b * u; db[j] = u; const g = (b * Sd(t)) / den;
      if (tied) { d0[j] = -g; d1[j] = 0; } else { d0[j] = (g * (sc - s1)) / den; d1[j] = (-g * (sc - s0)) / den; }
    }
  }
}

/** Accumulator layout of sensPass: [SSE, g over the six slots (d0 d1 a b s0 s1), JᵀJ upper triangle row by row]. */
export const ACC = 28;
const tri = (u, v) => 7 + u * 6 - (u * (u - 1)) / 2 + (v - u);

/**
 * One pass of a driver law: simulation, residuals x_k − y_k on the kept frames and their derivatives by forward
 * sensitivities, with the SSE, Jᵀr and JᵀJ accumulated over the kept frames in frame order (acc, ACC entries; slots: the
 * law's dynamics derivatives d0 d1, then a, b, s0, s1). x_k is simResidFused's, expression by expression (the same values);
 * the derivative recursions differentiate them: EMA ∂x_k = (1 − α)∂x_(k−1) + α∂g_k (+ (g_k − x_(k−1)) for α), dt-damp the
 * same with f = 1 − e^(−λΔt) (∂f/∂λ = Δt·e^(−λΔt)), asym with the rate of the branch taken, a snap sets ∂x = ∂g, the
 * restarted tween x = from + (to − from)·E(p) with ∂from / ∂to kept from its restart and ∂p/∂L = −p/L, ∂p/∂delay = −1/L.
 * full = false: the (a, b) slots only (the dynamics and corner derivatives are not accumulated). rows (tests): {r, J[6]}
 * gets the residual and the six derivatives of every kept frame. Returns the SSE, or −1 when a residual is not finite.
 */
export function sensPass(law, prm, eps, snapMode, at, drv, T, y, y0, mask, acc, full, Ed, rows = null) {
  const n = T.length; const v = drv.v, db = drv.db, d0 = drv.d0, d1 = drv.d1;
  let x = y0, xa = 0, xb = 0, x0 = 0, x1 = 0, xd0 = 0, xd1 = 0, bad = false, j = 0;
  let f = 0, g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0;
  let A00 = 0, A01 = 0, A02 = 0, A03 = 0, A04 = 0, A05 = 0, A11 = 0, A12 = 0, A13 = 0, A14 = 0, A15 = 0;
  let A22 = 0, A23 = 0, A24 = 0, A25 = 0, A33 = 0, A34 = 0, A35 = 0, A44 = 0, A45 = 0, A55 = 0;
  const lw = law === 'ema' ? 1 : law === 'none' ? 2 : law === 'asym' ? 3 : law === 'dtdamp' ? 4 : 5;
  const snap = !!eps && lw !== 5; const pre = snap && snapMode === 'pre';
  const alpha = prm.alpha, up = prm.alphaUp, down = prm.alphaDown, lambda = prm.lambda, E = prm.E, L = prm.L, delay = prm.delay;
  let lastDt = 0, fac = NaN, dfac = NaN, haveDt = false;
  let on = false, ts = 0, from = 0, to = 0, gPrev = n ? v[at[0]] : 0;
  let fa = 0, fb = 0, f0 = 0, f1 = 0, fd0 = 0, fd1 = 0, tb = 0, t0 = 0, t1 = 0;   // ∂from (a, b, s0, s1, dyn), ∂to (∂to/∂a = 1)
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      const q = at[k]; const gk = v[q];
      if (lw === 5) {
        if (Number.isFinite(gk)) {
          if (gk !== gPrev) { on = true; ts = T[k - 1] + delay; from = x; to = gk; fa = xa; fb = xb; f0 = x0; f1 = x1; fd0 = xd0; fd1 = xd1; tb = db[q]; t0 = d0[q]; t1 = d1[q]; }
          if (on) {
            const p = (T[k] - ts) / L;
            if (p <= 0) { x = from + (to - from) * 0; xa = fa; xb = fb; x0 = f0; x1 = f1; xd0 = fd0; xd1 = fd1; }
            else if (p >= 1) { x = from + (to - from) * 1; xa = 1; xb = tb; x0 = t0; x1 = t1; xd0 = 0; xd1 = 0; }
            else {
              const e = E(p); const w = 1 - e; x = from + (to - from) * e;
              xa = fa * w + e; xb = fb * w + tb * e;
              if (full) { const gd = ((to - from) * Ed(p)) / L; x0 = f0 * w + t0 * e; x1 = f1 * w + t1 * e; xd0 = fd0 * w - gd * p; xd1 = fd1 * w - gd; }
            }
          }
        }
        gPrev = gk;
      } else if (Number.isFinite(gk)) {
        const gb = db[q], gs0 = d0[q], gs1 = d1[q];
        if (pre && lw !== 2 && Math.abs(gk - x) < eps) { x = gk; xa = 1; xb = gb; x0 = gs0; x1 = gs1; xd0 = 0; xd1 = 0; }
        else {
          if (lw === 1) { const e = gk - x; x = x + alpha * e; const w = 1 - alpha; xd0 = w * xd0 + e; xa = w * xa + alpha; xb = w * xb + alpha * gb; x0 = w * x0 + alpha * gs0; x1 = w * x1 + alpha * gs1; }
          else if (lw === 2) { x = gk; xa = 1; xb = gb; x0 = gs0; x1 = gs1; }
          else if (lw === 3) {
            const e = gk - x; const isUp = gk >= x; const al = isUp ? up : down; x = x + al * e; const w = 1 - al;
            xd0 = w * xd0 + (isUp ? e : 0); xd1 = w * xd1 + (isUp ? 0 : e); xa = w * xa + al; xb = w * xb + al * gb; x0 = w * x0 + al * gs0; x1 = w * x1 + al * gs1;
          } else {
            const dt = T[k] - T[k - 1];
            if (!haveDt || !Object.is(dt, lastDt)) { haveDt = true; lastDt = dt; const ee = Math.exp(-lambda * dt / 1000); fac = 1 - ee; dfac = (dt / 1000) * ee; }
            const e = gk - x; x = x + e * fac; const w = 1 - fac; xd0 = w * xd0 + e * dfac; xa = w * xa + fac; xb = w * xb + fac * gb; x0 = w * x0 + fac * gs0; x1 = w * x1 + fac * gs1;
          }
          if (snap && !pre && Math.abs(gk - x) < eps) { x = gk; xa = 1; xb = gb; x0 = gs0; x1 = gs1; xd0 = 0; xd1 = 0; }
        }
      }
    }
    if (mask === null || mask[k] === 1) {
      const e = x - y[k]; if (!Number.isFinite(e)) bad = true;
      f += e * e; g2 += xa * e; g3 += xb * e; A22 += xa * xa; A23 += xa * xb; A33 += xb * xb;
      if (full) {
        g0 += xd0 * e; g1 += xd1 * e; g4 += x0 * e; g5 += x1 * e;
        A00 += xd0 * xd0; A01 += xd0 * xd1; A02 += xd0 * xa; A03 += xd0 * xb; A04 += xd0 * x0; A05 += xd0 * x1;
        A11 += xd1 * xd1; A12 += xd1 * xa; A13 += xd1 * xb; A14 += xd1 * x0; A15 += xd1 * x1;
        A24 += xa * x0; A25 += xa * x1; A34 += xb * x0; A35 += xb * x1; A44 += x0 * x0; A45 += x0 * x1; A55 += x1 * x1;
      }
      if (rows) { rows.r[j] = e; const J = rows.J; J[0][j] = xd0; J[1][j] = xd1; J[2][j] = xa; J[3][j] = xb; J[4][j] = x0; J[5][j] = x1; }
      j++;
    }
  }
  acc[0] = f; acc[1] = g0; acc[2] = g1; acc[3] = g2; acc[4] = g3; acc[5] = g4; acc[6] = g5;
  acc[7] = A00; acc[8] = A01; acc[9] = A02; acc[10] = A03; acc[11] = A04; acc[12] = A05;
  acc[13] = A11; acc[14] = A12; acc[15] = A13; acc[16] = A14; acc[17] = A15;
  acc[18] = A22; acc[19] = A23; acc[20] = A24; acc[21] = A25; acc[22] = A33; acc[23] = A34; acc[24] = A35; acc[25] = A44; acc[26] = A45; acc[27] = A55;
  return bad ? -1 : f;
}

/** The normal equations of the parameters (slot of each: sl) from a sensPass accumulator. */
export function unpackAcc(acc, sl, A, g) {
  const P = sl.length;
  for (let i = 0; i < P; i++) { g[i] = acc[1 + sl[i]]; for (let k = i; k < P; k++) { const u = Math.min(sl[i], sl[k]), w = Math.max(sl[i], sl[k]); A[i][k] = A[k][i] = acc[tri(u, w)]; } }
}

/**
 * Variable projection on the normal equations (st: {f, g, A} at p): the exact least-squares (Δa, Δb) of the two
 * parameters the residual is affine in (lin = [ia, ib]); f, g, A and p are updated in place to the new point (the law being
 * affine, r + Δa·∂r/∂a + Δb·∂r/∂b IS the residual there: f' = f + Δa·g_a + Δb·g_b, g' = g + Δa·A[·][a] + Δb·A[·][b]). The
 * corner derivatives are proportional to b and are rescaled with it. Returns 'same' (nothing to gain), 'ok', or 'exact'
 * (the update cancelled most of f: the caller re-evaluates the new point).
 */
export function projectAcc(p, st, lin, corners) {
  const [ia, ib] = lin; const A = st.A, g = st.g, f = st.f; const P = p.length;
  const saa = A[ia][ia], sab = A[ia][ib], sbb = A[ib][ib], sar = g[ia], sbr = g[ib];
  const det = saa * sbb - sab * sab; let da, dbv;
  if (det > 1e-12 * saa * sbb && det > 0) { da = -(sbb * sar - sab * sbr) / det; dbv = -(saa * sbr - sab * sar) / det; }
  else if (saa > 0) { da = -sar / saa; dbv = 0; }   // the b response is a multiple of the a response (a flat map): a alone
  else return 'same';
  if (!Number.isFinite(da) || !Number.isFinite(dbv)) return 'same';
  const f1 = f + da * sar + dbv * sbr; if (!(f1 < f)) return 'same';
  for (let i = 0; i < P; i++) g[i] += da * A[i][ia] + dbv * A[i][ib];
  g[ia] = 0; g[ib] = 0;
  const b0 = p[ib]; p[ia] += da; p[ib] += dbv; st.f = f1;
  if (corners && b0 !== 0 && Number.isFinite(b0)) {
    const k = p[ib] / b0; const isC = (i) => i === corners[0] || i === corners[1];
    for (const c of corners) { g[c] *= k; for (let i = 0; i < P; i++) if (!isC(i)) { A[c][i] *= k; A[i][c] *= k; } }
    for (const c of corners) for (const c2 of corners) A[c][c2] *= k * k;
  }
  return f1 < 1e-6 * f ? 'exact' : 'ok';
}

/**
 * Levenberg–Marquardt on normal equations from an analytic Jacobian: pass(p, st) fills st = {f, g, A} at p and returns f
 * (−1: a residual not finite). Box bounds by projection and Marquardt scaling (λ·max(A_ii, 1e-30)) as numeric.js lm.
 * schedule 'marquardt' (the 'jacobian' search): numeric.js lm's own schedule, step for step (λ0 1e-3, ÷5 on an accepted
 * step down to 1e-12, ×8 on a rejected one, ×10 on a singular system, 12 tries, stop when an accepted step gains less
 * than 1e-12 of the SSE, maxIter iterations): with a forward-difference Jacobian in `pass` it reproduces lm() bit for bit
 * (checked: lanes/L9B.md). schedule 'nielsen' (the 'varpro' search): damping by the gain ratio, `lin` = [ia, ib] solved
 * exactly at every accepted point (projectAcc), stop when a step gains less than relTol of max(SSE, floorRss) or moves no
 * other parameter by stepTol of max(|p|, scale).
 */
export function lmSens(pass, p0, { lower, upper, scale, maxIter = 60, P, schedule = 'marquardt', lin = null, corners = null, floorRss = 0, relTol = 1e-10, stepTol = 1e-10 }) {
  const nielsen = schedule === 'nielsen'; if (!nielsen) lin = null;
  const mk = () => ({ f: 0, g: new Float64Array(P), A: Array.from({ length: P }, () => new Float64Array(P)) });
  let st = mk(), sq = mk(); const M = Array.from({ length: P }, () => new Float64Array(P + 1)); const d = new Float64Array(P);
  let p = new Float64Array(P), q = new Float64Array(P);
  for (let i = 0; i < P; i++) p[i] = Math.max(lower[i], Math.min(upper[i], p0[i]));
  if (pass(p, st) < 0) return { p: Array.from(p), rss: Infinity, iters: 0, ok: false };
  if (lin && projectAcc(p, st, lin, corners) !== 'same') { if (pass(p, st) < 0) return { p: Array.from(p), rss: Infinity, iters: 0, ok: false }; }   // fresh normal equations at the projected start
  let lam = 1e-3, nu = 2, it = 0;
  for (; it < maxIter; it++) {
    const A = st.A, g = st.g; let improved = false, done = false;
    for (let tries = 0; tries < 12; tries++) {
      for (let a = 0; a < P; a++) { const Ma = M[a], Aa = A[a]; for (let b = 0; b < P; b++) Ma[b] = Aa[b]; Ma[a] = Aa[a] + lam * Math.max(Aa[a], 1e-30); Ma[P] = -g[a]; }
      if (!solveAug(M, P, d)) { lam *= 10; continue; }
      for (let i = 0; i < P; i++) q[i] = Math.max(lower[i], Math.min(upper[i], p[i] + d[i]));
      let fq = pass(q, sq);
      if (fq >= 0 && lin) { const pr = projectAcc(q, sq, lin, corners); fq = pr === 'exact' ? pass(q, sq) : sq.f; }
      if (!(fq >= 0)) fq = Infinity;
      if (fq < st.f) {
        if (nielsen) {
          let pred = 0; for (let a = 0; a < P; a++) { let ad = 0; const Aa = A[a]; for (let b = 0; b < P; b++) ad += Aa[b] * d[b]; pred -= g[a] * d[a] + 0.5 * d[a] * ad; }
          const rho = pred > 0 ? (st.f - fq) / pred : 0;
          const rel = (st.f - fq) / Math.max(fq, floorRss, 1e-300); let step = 0;
          for (let i = 0; i < P; i++) if (!lin || (i !== lin[0] && i !== lin[1])) step = Math.max(step, Math.abs(q[i] - p[i]) / Math.max(Math.abs(p[i]), scale[i] || 0, 1e-9));
          lam = Math.max(lam * Math.max(1 / 3, 1 - (2 * rho - 1) ** 3), 1e-12); nu = 2;
          if (rel < relTol || step < stepTol) done = true;
        } else { if ((st.f - fq) / Math.max(st.f, 1e-300) < 1e-12) done = true; lam = Math.max(lam / 5, 1e-12); }
        const t = p; p = q; q = t; const ts = st; st = sq; sq = ts; improved = true;
        break;
      }
      if (nielsen) { lam *= nu; nu *= 2; } else lam *= 8;
    }
    if (!improved) break;
    if (done) { it++; break; }
  }
  searchStats.lm++; searchStats.lmIters += it; if (it >= maxIter) searchStats.lmCapped++;
  return { p: Array.from(p), rss: st.f, iters: it, ok: true };
}

/** Gaussian elimination with partial pivoting on an augmented P × (P + 1) matrix (overwritten); false when singular. */
function solveAug(M, P, out) {
  for (let c = 0; c < P; c++) {
    let pv = c; for (let r = c + 1; r < P; r++) if (Math.abs(M[r][c]) > Math.abs(M[pv][c])) pv = r;
    if (!(Math.abs(M[pv][c]) > 1e-300)) return false;
    if (pv !== c) { const t = M[c]; M[c] = M[pv]; M[pv] = t; }
    const Mc = M[c];
    for (let r = c + 1; r < P; r++) { const Mr = M[r]; const f = Mr[c] / Mc[c]; if (f) for (let k = c; k <= P; k++) Mr[k] -= f * Mc[k]; }
  }
  for (let r = P - 1; r >= 0; r--) { const Mr = M[r]; let s = Mr[P]; for (let k = r + 1; k < P; k++) s -= Mr[k] * out[k]; out[r] = s / Mr[r]; }
  for (let i = 0; i < P; i++) if (!Number.isFinite(out[i])) return false;
  return true;
}

/**
 * The search of one perMap candidate (fitModel's `search` hook). o: {mode, law, nm, slots, toPrm, eps, snapMode, S, Sd, S0,
 * S1, plan: {at, vals}, T, y, y0, starts, nmStarts (the restarted tween: Nelder–Mead from each start first), dt, sigma, Ed,
 * exactSse(p, mask)}. ctx (from fitModel): {lo, hi, scale, mask, nU}. Returns {p, rss} or null (null: fitModel runs the
 * exact search).
 *  mode 'jacobian' (the default): the post-L9-A search with the forward-difference Jacobian replaced by the sensitivity
 *    pass: the same starts, the same Nelder–Mead for the restarted tween (its evaluations are the exact evaluator's, so it
 *    takes the same path), the same LM schedule. Only the Jacobian differs (exact instead of a forward difference).
 *  mode 'varpro': variable projection of (a, b), gain-ratio LM with the stop above, and for the restarted tween a log grid
 *    over L × delay instead of Nelder–Mead (FIT-SPEED idea 1 in full; not the default: lanes/L9B.md).
 * Both: a start equal to one already run is not run again (the same LM gives the same result).
 */
export function driverSearch(o, ctx) {
  searchStats.searches++;
  const { lo, hi, scale, mask, nU } = ctx; const nm = o.nm, P = nm + 4, n = o.T.length; const at = o.plan.at, vals = o.plan.vals;
  const nv = vals.length; const drv = { v: new Float64Array(nv), db: new Float64Array(nv), d0: new Float64Array(nv), d1: new Float64Array(nv) };
  const varpro = o.mode === 'varpro'; const affine = o.law !== 'asym' && !o.eps; const lin = varpro && affine ? [nm, nm + 1] : null; const corners = [nm + 2, nm + 3];
  const sl = [...o.slots, 2, 3, 4, 5]; const acc = new Float64Array(ACC);
  const pass = (p, st) => {
    charge(PASS_UNITS * n); searchStats.passes++;
    driverSens(o.S, o.Sd, o.S0, o.S1, p[nm], p[nm + 1], p[nm + 2], p[nm + 3], vals, drv);
    const f = sensPass(o.law, o.toPrm(p), o.eps, o.snapMode, at, drv, o.T, o.y, o.y0, mask, acc, true, o.Ed);
    if (f < 0) return -1; unpackAcc(acc, sl, st.A, st.g); st.f = f; return f;
  };
  const clampP = (st) => st.map((v, i) => Math.min(hi[i], Math.max(lo[i], v)));
  const floorRss = nU * o.sigma * o.sigma;
  const lmOpts = { lower: lo, upper: hi, scale, P, schedule: varpro ? 'nielsen' : 'marquardt', lin, corners, floorRss };
  const done = []; const once = (st) => { if (done.some((q) => q.every((v, i) => Object.is(v, st[i])))) { searchStats.dupStarts++; return false; } done.push(st); return true; };
  let best = null; const consider = (r) => { if (r && r.ok && Number.isFinite(r.rss) && (!best || r.rss < best.rss)) best = { p: r.p, rss: r.rss }; };
  if (!varpro && o.nmStarts) {
    // model.js's restarted search: Nelder–Mead from each start on the exact objective (same evaluations, same path), then LM
    const inBox = (p) => p.every((v, i) => v >= lo[i] && v <= hi[i]);
    const obj = (p) => { if (!inBox(p)) return Infinity; charge(n); return o.exactSse(p, mask); };
    for (const s0 of o.starts) {
      let p = clampP(s0); if (!once(p)) continue;
      const r = nelderMead(obj, p, { initialStep: scale.map((sc, i) => (Math.abs(p[i]) * 0.05 || sc * 0.05)), maxIterations: o.nmIter || 400, tolFun: 1e-14, tolX: 1e-10 });
      if (Number.isFinite(r.fx)) p = r.x;
      consider(lmSens(pass, p, lmOpts));
    }
  } else {
    if (varpro && o.nmStarts && affine && nm === 2) {
      // restarted tween: (L, delay) on a log grid with the map at the seed's corners and (a, b) projected
      const p0 = clampP(o.starts[0]); driverSens(o.S, o.Sd, o.S0, o.S1, p0[nm], p0[nm + 1], p0[nm + 2], p0[nm + 3], vals, drv);
      const st = { f: 0, g: new Float64Array(P), A: Array.from({ length: P }, () => new Float64Array(P)) };
      const Llo = Math.max(lo[0], 1e-9), Lhi = hi[0]; const Ls = Array.from({ length: GRID_L }, (_, i) => Llo * (Lhi / Llo) ** (i / (GRID_L - 1)));
      const delays = [...new Set([0, o.dt / 2].map((dl) => Math.min(hi[1], Math.max(lo[1], dl))))];
      const pts = [];
      for (const dl of delays) {
        const row = [];
        for (const Lv of Ls) {
          const p = p0.slice(); p[0] = Lv; p[1] = dl; charge(n); searchStats.gridPasses++;
          const f = sensPass(o.law, o.toPrm(p), o.eps, o.snapMode, at, drv, o.T, o.y, o.y0, mask, acc, false, o.Ed);
          let fp = Infinity;
          if (f >= 0) { unpackAcc(acc, sl, st.A, st.g); st.f = f; projectAcc(p, st, lin, null); fp = st.f; }
          row.push({ p, f: fp });
        }
        // local minima along L (a grid end counts when it is lower than its one neighbour)
        row.forEach((q, i) => { if (Number.isFinite(q.f) && (i === 0 || q.f <= row[i - 1].f) && (i === row.length - 1 || q.f <= row[i + 1].f)) pts.push(q); });
      }
      pts.sort((u, w) => u.f - w.f);
      for (const q of pts.slice(0, 2)) if (once(q.p)) consider(lmSens(pass, q.p, lmOpts));
    }
    for (const s0 of o.starts) { const st = clampP(s0); if (once(st)) consider(lmSens(pass, st, lmOpts)); }
  }
  if (!best) { searchStats.fallbacks++; return null; }
  // the reported SSE is the exact evaluator's at the optimum. In 'jacobian' mode the pass computes the same SSE (same
  // expressions); in 'varpro' the projected SSE is a closed form that loses digits on maps with huge cancelling a, b
  // (measured up to 4e-8 relative). A difference beyond 1e-6 of max(SSE, n·σ²) means the search was misled (the law was not
  // affine where it assumed so), and the exact search runs instead
  const ex = o.exactSse(best.p, mask);
  if (!(Math.abs(ex - best.rss) <= 1e-6 * Math.max(ex, floorRss, 1e-300))) { searchStats.fallbacks++; return null; }
  return { p: best.p, rss: ex };
}
/** Meter units of one sensitivity pass, per frame (measured: about two fused evaluations). */
export const PASS_UNITS = 2;
const GRID_L = 24;
