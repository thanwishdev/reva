// Analytic damped spring, all damping regimes (design §4.2), with retargets: shared (ω, ζ), per-piece target,
// state carried across each retarget. Init by AR(2) on uniformly sampled frames (S3 §3.1) + understudy's seed.
import { fitModel } from './model.js';
import { ols, median } from './numeric.js';
import { springSeed } from './vendor/understudy/spring.js';

/** Closed-form state after τ seconds from (d0 = x − g, v0) — any ζ. Returns [d, v]. */
export function springStep(w, z, d0, v0, tau) {
  if (tau <= 0) return [d0, v0];
  // near critical damping both closed forms lose precision (the overdamped one divides by √(ζ²−1), a hard switch at
  // ζ = 1 breaks the Jacobian of a fit sitting there: lab case M08 ζ = 1 retarget at R5, c without an interval). One
  // form smooth in s = ω²(ζ²−1): d = e^(−ζωτ)[d0·ch + B·sh], ch = cosh(√s τ), sh = sinh(√s τ)/√s, by series for |sτ²| < 1
  { const sw = w * w * (z * z - 1); const x = sw * tau * tau;
    if (Math.abs(x) < 1) {
      let ch = 0, sh = 0, term = 1;   // term = x^n/(2n)!
      for (let n = 0; n < 14; n++) { ch += term; sh += term / (2 * n + 1); term *= x / ((2 * n + 1) * (2 * n + 2)); }
      sh *= tau; const e = Math.exp(-z * w * tau), B = v0 + z * w * d0;
      return [e * (d0 * ch + B * sh), e * (-z * w * (d0 * ch + B * sh) + d0 * sw * sh + B * ch)];
    } }
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z), e = Math.exp(-z * w * tau), B = (v0 + z * w * d0) / wd, c = Math.cos(wd * tau), s = Math.sin(wd * tau);
    return [e * (d0 * c + B * s), e * (-z * w * (d0 * c + B * s) + (-d0 * wd * s + B * wd * c))];
  }
  const q = Math.sqrt(z * z - 1), r1 = -w * (z - q), r2 = -w * (z + q); const C2 = (v0 - r1 * d0) / (r2 - r1), C1 = d0 - C2;
  const e1 = Math.exp(r1 * tau), e2 = Math.exp(r2 * tau); return [C1 * e1 + C2 * e2, C1 * r1 * e1 + C2 * r2 * e2];
}

/**
 * The displacement alone of springStep (its first element), same expressions in the same order, without building the
 * velocity and the pair (L8, fit speed: springEval evaluates it once per frame per model evaluation).
 */
export function springDisp(w, z, d0, v0, tau) {
  if (tau <= 0) return d0;
  { const sw = w * w * (z * z - 1); const x = sw * tau * tau;
    if (Math.abs(x) < 1) {
      let ch = 0, sh = 0, term = 1;
      for (let n = 0; n < 14; n++) { ch += term; sh += term / (2 * n + 1); term *= x / ((2 * n + 1) * (2 * n + 2)); }
      sh *= tau; const e = Math.exp(-z * w * tau), B = v0 + z * w * d0;
      return e * (d0 * ch + B * sh);
    } }
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z), e = Math.exp(-z * w * tau), B = (v0 + z * w * d0) / wd, c = Math.cos(wd * tau), s = Math.sin(wd * tau);
    return e * (d0 * c + B * s);
  }
  const q = Math.sqrt(z * z - 1), r1 = -w * (z - q), r2 = -w * (z + q); const C2 = (v0 - r1 * d0) / (r2 - r1), C1 = d0 - C2;
  const e1 = Math.exp(r1 * tau), e2 = Math.exp(r2 * tau); return C1 * e1 + C2 * e2;
}

/**
 * Evaluate a multi-piece analytic spring at times T (ms).
 * @param {{t0:number, x0:number, v0:number, w:number, z:number, targets:number[], tr:number[]}} m  tr = retarget times (ms)
 */
export function springEval(m, T) {
  const out = new Array(T.length);
  // piece start states
  const starts = [{ t: m.t0, x: m.x0, v: m.v0 }];
  for (let j = 0; j < m.tr.length; j++) { const s = starts[j]; const [d, v] = springStep(m.w, m.z, s.x - m.targets[j], s.v, (m.tr[j] - s.t) / 1000); starts.push({ t: m.tr[j], x: d + m.targets[j], v }); }
  for (let i = 0; i < T.length; i++) {
    const t = T[i]; if (t <= m.t0) { out[i] = m.x0; continue; }
    let j = 0; while (j < m.tr.length && t >= m.tr[j]) j++;
    const s = starts[j]; out[i] = springDisp(m.w, m.z, s.x - m.targets[j], s.v, (t - s.t) / 1000) + m.targets[j];
  }
  return out;
}

/** AR(2) on uniformly sampled values → (ω, ζ) or null (S3 §3.1). */
export function ar2(T, y) {
  if (y.length < 6) return null; const dt = median(T.slice(1).map((t, i) => t - T[i])) / 1000;
  const X = [], Y = []; for (let i = 2; i < y.length; i++) { X.push([y[i - 1], y[i - 2], 1]); Y.push(y[i]); }
  const r = ols(X, Y); if (!r) return null; const [a1, a2] = r.beta;
  const disc = a1 * a1 + 4 * a2;
  if (disc < 0) { const rad = Math.sqrt(-a2), th = Math.atan2(Math.sqrt(-disc) / 2, a1 / 2); const sig = -Math.log(rad) / dt, wd = th / dt; const w = Math.hypot(sig, wd); return w > 0 ? { w, z: sig / w } : null; }
  const p1 = (a1 + Math.sqrt(disc)) / 2, p2 = (a1 - Math.sqrt(disc)) / 2; if (!(p1 > 0 && p2 > 0)) return null;
  const s1 = Math.log(p1) / dt, s2 = Math.log(p2) / dt; const w = Math.sqrt(s1 * s2); if (!(w > 0)) return null; return { w, z: -(s1 + s2) / (2 * w) };
}

/**
 * Fit the analytic spring to one segment window with given retarget frame seeds.
 * @param w   tween-style window {T, y, from, to, t0, D, dt, tMin, tMax}
 * @param bps indices (into w.T) of retarget seeds
 */
export function fitSpringAnalytic(w, sigma, bps = [], use, { fromRest = false } = {}) {
  const m = bps.length; const x0 = w.from;
  // fromRest: v0 = 0 at the onset (nested; removes the t0–v0 ridge of a spring released from rest)
  const spec = [{ name: 't0', lo: w.tMin, hi: w.tMax, scale: w.dt, unit: 'ms' }, { name: 'omega', lo: 0.5, hi: 500, scale: 10, unit: 'rad/s' }, { name: 'zeta', lo: 0.005, hi: 10, scale: 0.1 },
    fromRest ? { name: 'v0', lo: 0, hi: 0, scale: 1, unit: 'value/s', fixed: true } : { name: 'v0', scale: Math.abs(w.y.at(-1) - w.y[0]) * 10 || 1, unit: 'value/s' }];
  if (x0 == null) spec.push({ name: 'x0', scale: Math.abs(w.y[0]) || 1 });
  for (let j = 0; j <= m; j++) spec.push({ name: j ? `target${j}` : 'target', scale: Math.abs(w.y.at(-1)) || 1 });
  for (let j = 0; j < m; j++) spec.push({ name: `tr${j + 1}`, lo: w.T[Math.max(0, bps[j] - 3)], hi: w.T[Math.min(w.T.length - 1, bps[j] + 1)], scale: w.dt, unit: 'ms' });
  const ix = (n) => spec.findIndex((s) => s.name === n);
  const iT = ix('target'), iX = ix('x0');
  const unpack = (p) => ({ t0: p[0], w: p[1], z: p[2], v0: p[3], x0: x0 ?? p[iX], targets: p.slice(iT, iT + m + 1), tr: p.slice(iT + m + 1) });
  const f = (p, T) => springEval(unpack(p), T);
  // seeds: AR(2) on the first piece's moving frames, understudy's overshoot seed, a small (ζ, ω) grid
  const firstEnd = m ? bps[0] : w.T.length; const mv = []; for (let i = 0; i < firstEnd; i++) if (w.T[i] > w.t0) mv.push(i);
  const seeds = [];
  const a = ar2(mv.map((i) => w.T[i]), mv.map((i) => w.y[i])); if (a && a.w > 0.5 && a.w < 500) seeds.push([a.w, Math.min(9, Math.max(0.01, a.z))]);
  const g0 = w.to ?? w.y.at(-1), s0 = x0 ?? w.y[0];
  if (Math.abs(g0 - s0) > 0) { try { const ss = springSeed(mv.map((i) => ({ t: w.T[i] - w.t0, p: (w.y[i] - s0) / (g0 - s0) }))); if (Number.isFinite(ss.omega0)) seeds.push([ss.omega0, ss.zeta0]); } catch {} }
  const Tsc = Math.max(w.D, w.dt * 4) / 1000; for (const z of [0.3, 0.7, 1.2]) seeds.push([4 / Tsc / Math.max(z, 0.5), z]);
  const tgSeeds = []; for (let j = 0; j <= m; j++) { const end = j < m ? bps[j] : w.T.length; tgSeeds.push(j < m ? w.y[Math.max(0, end - 1)] : g0); }
  const starts = seeds.map(([om, z]) => { const p = [w.t0, om, z, 0]; if (x0 == null) p.push(w.y[0]); p.push(...tgSeeds); for (const b of bps) p.push(w.T[b] - w.dt * 0.5); return p; });
  const r = fitModel({ family: 'spring-analytic', cls: 'spring', T: w.T, y: w.y, spec, f, starts, sigma, use, nm: true, nmIter: 500 });
  if (r) { r.model = unpack(r.p); r.derived = springDerived(r.model); }
  return r;
}

/** Overshoot (value units), 2 % and 99 % settle, first piece from its start state. */
export function springDerived(m) {
  const g = m.targets[0], A = Math.abs(g - m.x0) || 1;
  const slow = m.z < 1 ? m.z * m.w : m.w * (m.z - Math.sqrt(m.z * m.z - 1)); const end = m.tr.length ? m.tr[0] : m.t0 + Math.min(60000, (1000 * 12) / Math.max(slow, 1e-3));
  let ov = 0, s2 = null, s99 = null, last2 = m.t0, last99 = m.t0; const N = 4000; const dtt = (end - m.t0) / N;
  for (let i = 1; i <= N; i++) { const t = m.t0 + i * dtt; const [d] = springStep(m.w, m.z, m.x0 - g, m.v0, (t - m.t0) / 1000);
    if (Math.sign(d) !== Math.sign(m.x0 - g) && d !== 0) ov = Math.max(ov, Math.abs(d)); if (Math.abs(d) > 0.02 * A) last2 = t; if (Math.abs(d) > 0.01 * A) last99 = t; }
  s2 = last2 - m.t0; s99 = last99 - m.t0;
  return { overshoot: ov, settle2: s2, settle99: s99, k: m.w * m.w, c: 2 * m.z * m.w };
}
