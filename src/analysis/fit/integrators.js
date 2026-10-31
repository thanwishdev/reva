// Discrete spring integrators and integrator identification on a take set (design §4.3).
// Each hypothesis is simulated on the take's OWN frame times (stalls and remainders reproduced).
import { lm, sse, likelihood, ciHalfWidths, charge } from './numeric.js';
import { springEval } from './spring.js';

/** Hypothesis set (S3 §3.2). `native` = I4 runs in per-60-Hz-frame units. */
export const HYPOTHESES = [
  { id: 'I1(1)', kind: 'sie-substep', h: 1 }, { id: 'I1(2)', kind: 'sie-substep', h: 2 }, { id: 'I1(4)', kind: 'sie-substep', h: 4 },
  { id: 'I1(8)', kind: 'sie-substep', h: 8 }, { id: 'I1(16)', kind: 'sie-substep', h: 16 },
  { id: 'I4', kind: 'frame-unit-euler', native: true }, { id: 'I5', kind: 'rk4' }, { id: 'I6', kind: 'analytic' }, { id: 'I7', kind: 'sie-capped', cap: 1000 / 30 },
];

const targetAt = (m, t) => { let j = 0; while (j < m.tr.length && t >= m.tr[j]) j++; return m.targets[j]; };

/**
 * Simulate hypothesis `h` with params m = {k, c, t0, x0, v0, targets, tr} (k, c per s² / per s, m = 1; for I4 the
 * native kf, cf) at frame times T (ms). Returns positions.
 */
export function simulate(h, m, T) {
  if (h.kind === 'analytic') { const w = Math.sqrt(Math.max(m.k, 1e-12)); return springEval({ t0: m.t0, x0: m.x0, v0: m.v0, w, z: m.c / (2 * w), targets: m.targets, tr: m.tr }, T); }
  const out = new Array(T.length); let x = m.x0, v = m.v0 / 1000, last = m.t0;   // v in value/ms internally
  let xPrev = m.x0 - m.v0 / 60;                                                       // I4: one nominal 60 Hz frame back
  const k = m.k / 1e6, c = m.c / 1e3;                                                 // per ms² / per ms
  // L8: the target index continues from the previous frame while the time does not go back (the leading retargets passed
  // at t are passed at any later t); else it is searched from the start, as targetAt does: the same target every frame
  const tr = m.tr, ntr = tr.length; let j = 0, tPrev = -Infinity;
  for (let i = 0; i < T.length; i++) {
    const t = T[i]; if (t <= m.t0) { out[i] = m.x0; continue; }
    if (!(t >= tPrev)) j = 0; tPrev = t; while (j < ntr && t >= tr[j]) j++;
    const g = m.targets[j]; const dt = t - last; last = t;
    if (h.kind === 'sie-substep') { let o = dt; while (o > 1e-9) { const s = Math.min(o, h.h); v += (-k * (x - g) - c * v) * s; x += v * s; o -= s; } }
    else if (h.kind === 'sie-capped') { const s = Math.min(dt, h.cap); v += (-k * (x - g) - c * v) * s; x += v * s; }
    else if (h.kind === 'rk4') {
      const a = (xx, vv) => -k * (xx - g) - c * vv; const s = dt;
      const k1x = v, k1v = a(x, v), k2x = v + 0.5 * s * k1v, k2v = a(x + 0.5 * s * k1x, v + 0.5 * s * k1v);
      const k3x = v + 0.5 * s * k2v, k3v = a(x + 0.5 * s * k2x, v + 0.5 * s * k2v), k4x = v + s * k3v, k4v = a(x + s * k3x, v + s * k3v);
      x += (s / 6) * (k1x + 2 * k2x + 2 * k3x + k4x); v += (s / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
    } else if (h.kind === 'frame-unit-euler') {
      const u = (Math.min(dt, 1000 / 30) * 60) / 1000; const vel = (x - xPrev) / u; const acc = m.k * (g - x) - m.c * vel;
      const xn = x + (vel + acc) * u; xPrev = x; x = xn;
    }
    out[i] = x;
  }
  return out;
}

/** Simulate on the page frame grid `Tsim` when samples are a subset of page frames (R6 stride), else on T. */
// work meter: frames simulated, a fixed-substep integrator weighted by its sub-steps per frame (I1(1) at 60 Hz = 17)
const simCost = (h, TT) => TT.length * (h.kind === 'sie-substep' && TT.length > 1 ? Math.max(1, Math.round((TT.at(-1) - TT[0]) / (TT.length - 1) / h.h)) : 1);
const simObs = (h, m, t) => { charge(simCost(h, t.Tsim || t.T)); if (!t.Tsim) return simulate(h, m, t.T); const all = simulate(h, m, t.Tsim); return t.obs.map((i) => all[i]); };

/** Canonical (k/m, c/m) per s for comparison across hypotheses (I4: native per-frame units × 3600 / × 60). */
export const canonical = (h, k, c) => (h.native ? { k: k * 3600, c: c * 60 } : { k, c });
const fromCanonical = (h, k, c) => (h.native ? { k: k / 3600, c: c / 60 } : { k, c });

/** Terminal snap: first index of a final run (≥ 3 frames) of exactly equal values reached by a jump; else -1. */
export function detectSnap(y, sigma) {
  const n = y.length; let i = n - 1; while (i > 0 && y[i - 1] === y[i]) i--;
  if (n - i < 3 || i < 3) return -1;
  const jump = Math.abs(y[i] - y[i - 1]), prev = Math.abs(y[i - 1] - y[i - 2]); const A = Math.abs(y[i] - y[0]) || 1;
  // a snap is a small final jump onto the target (|x − g| < εx), not a large instant change
  return jump > sigma * 3 && jump > 0.2 * prev && jump <= 0.05 * A ? i : -1;
}

/**
 * A retarget in the last two frames of a window (lab case M20: a 1 s timer retargets the spring on the take's final
 * frame) shows as a third-difference spike that no later frame constrains: those frames are excluded from the fit
 * (the retarget is unidentifiable there). Returns the first excluded index, or -1.
 */
export function lateKink(y, T, sigma) {
  const n = y.length; if (n < 12) return -1;
  const d3 = (i) => y[i] - 3 * y[i - 1] + 3 * y[i - 2] - y[i - 3];
  const regular = (i) => { const a = T[i] - T[i - 1], b = T[i - 1] - T[i - 2]; return Math.abs(a - b) <= 1e-3 * Math.max(a, b); };
  const body = []; for (let i = 3; i < n - 2; i++) if (regular(i) && regular(i - 1) && regular(i - 2)) body.push(Math.abs(d3(i)));
  if (body.length < 6) return -1; body.sort((a, b) => a - b); const ref = Math.max(body[Math.floor(0.5 * (body.length - 1))], 30 * sigma);
  // a spike: far above the body's typical jerk AND above the two frames before it (an acceleration step, not a trend)
  for (const i of [n - 2, n - 1]) if (regular(i) && regular(i - 1) && regular(i - 2) && Math.abs(d3(i)) > 20 * ref && Math.abs(d3(i)) > 8 * Math.max(Math.abs(d3(i - 1)), Math.abs(d3(i - 2)))) return i;
  return -1;
}

/**
 * Joint fit of one hypothesis over a take set: shared (k, c); per take t0, v0, targets, retarget times.
 * @param {object[]} takes  [{T, y, x0, seed: {t0, v0, targets, tr, w, z}, sigma, explainBar, use}]
 */
export function fitHypothesis(h, takes, { grid = true, seedFrom = null } = {}) {
  const nT = takes.length; const disc = h.kind !== 'analytic';
  // discrete integrators switch target at a frame: retarget frames are an outer search (no gradient), analytic
  // retarget times are continuous LM parameters
  const per = takes.map((t) => 2 + t.seed.targets.length + (disc ? 0 : t.seed.tr.length));
  const offs = []; let o = 2; for (const p of per) { offs.push(o); o += p; }
  // seedFrom: another hypothesis's fit (lab case M07: a near-analytic integrator — I1(1), I1(2), RK4 — lost to I6 by
  // ΔL ≥ 10 only because its own multi-start ended in a worse optimum; I6's continuous solution is a good start)
  const sf = seedFrom && seedFrom.perTake && seedFrom.perTake.length === takes.length ? seedFrom : null;
  let trFix = takes.map((t, j) => (sf && sf.perTake[j].model.tr.length === t.seed.tr.length ? sf.perTake[j].model.tr.map((x) => t.T.findIndex((q) => q >= x)) : (t.seed.trFrames || t.seed.tr.map((x) => t.T.findIndex((q) => q >= x)))).map((i) => t.T[Math.max(1, i)] - 1e-6));
  const unpackTake = (p, j, tf = trFix) => { const b = offs[j], m = takes[j].seed.targets.length; return { k: p[0], c: p[1], t0: p[b], v0: p[b + 1], x0: takes[j].x0, targets: p.slice(b + 2, b + 2 + m), tr: disc ? tf[j] : p.slice(b + 2 + m, b + 2 + m + takes[j].seed.tr.length) }; };
  // L8: the residual vector is allocated at its final length (the used frames are fixed per take set), same values in the same order
  let nUsed = 0; for (const t of takes) for (let i = 0; i < t.T.length; i++) if (!t.use || t.use[i]) nUsed++;
  const residWith = (tf) => (p) => { const r = new Array(nUsed); let q = 0; for (let j = 0; j < nT; j++) { const t = takes[j]; const sim = simObs(h, unpackTake(p, j, tf), t); for (let i = 0; i < t.T.length; i++) if (!t.use || t.use[i]) r[q++] = sim[i] - t.y[i]; } return r; };
  // L9-A: the same residuals written into lm's preallocated buffer (lm `into`): same simulations, charges and order
  const intoWith = (tf) => (p, r) => { let q = 0; for (let j = 0; j < nT; j++) { const t = takes[j]; const sim = simObs(h, unpackTake(p, j, tf), t); for (let i = 0; i < t.T.length; i++) if (!t.use || t.use[i]) r[q++] = sim[i] - t.y[i]; } };
  let into = intoWith(trFix);
  const lower = [1e-9, 0], upper = [Infinity, Infinity]; const scale = [1, 1];
  for (const t of takes) {
    const firstMove = t.T.find((x, i) => i && Math.abs(t.y[i] - t.y[0]) > t.sigma * 3) ?? t.T.at(-1);
    lower.push(t.T[0] - 50, -Infinity, ...t.seed.targets.map(() => -Infinity), ...(disc ? [] : t.seed.tr.map((x) => x - 80)));
    upper.push(firstMove, Infinity, ...t.seed.targets.map(() => Infinity), ...(disc ? [] : t.seed.tr.map((x) => x + 80)));
    scale.push(5, 100, ...t.seed.targets.map(() => 1), ...(disc ? [] : t.seed.tr.map(() => 5)));
  }
  const nuisWith = (zeroV) => takes.flatMap((t) => [t.seed.t0, zeroV ? 0 : t.seed.v0, ...t.seed.targets, ...(disc ? [] : t.seed.tr)]);
  const nuis = nuisWith(false), nuis0 = nuisWith(true);
  // starts: each take's analytic (k, c) + a (log k, ζ) grid screened with nuisance parameters at their seeds
  const kc = takes.map((t) => ({ k: t.seed.w * t.seed.w, c: 2 * t.seed.z * t.seed.w }));
  let starts = kc.map((q) => { const n = fromCanonical(h, q.k, q.c); return [n.k, n.c, ...nuis]; });
  if (sf) { const n = fromCanonical(h, sf.k, sf.c); const nu = takes.flatMap((t, j) => { const m = sf.perTake[j].model; return [m.t0, m.v0, ...m.targets, ...(disc ? [] : m.tr)]; }); if (nu.length === nuis.length) starts.unshift([n.k, n.c, ...nu]); }
  let resid = residWith(trFix);
  if (grid) {
    const cand = [];
    for (const nu of [nuis, nuis0]) {
      for (let lk = 0.5; lk <= 5; lk += 0.25) for (const z of [0.15, 0.3, 0.45, 0.6, 0.8, 1, 1.3, 1.8, 2.6]) { const K = 10 ** lk; const n = fromCanonical(h, K, 2 * z * Math.sqrt(K)); cand.push([n.k, n.c, ...nu]); }
      for (const q of kc) for (const f of [0.5, 0.7, 1.4, 2, 3, 4.5]) for (const g of [0.6, 1, 1.6]) { const n = fromCanonical(h, q.k * f, q.c * g * Math.sqrt(f)); cand.push([n.k, n.c, ...nu]); }
    }
    const scored = cand.map((p) => ({ p, e: sse(resid(p)) })).filter((q) => Number.isFinite(q.e)).sort((a, b) => a.e - b.e);
    starts = [...starts, ...scored.slice(0, 10).map((q) => q.p)];
  }
  // two stages: a short LM from every start (nuisance parameters move too), then a long LM from the best two
  let short = starts.map((s) => lm(resid, s, { lower, upper, maxIter: 12, scale, into, m: nUsed })).filter((r) => r.ok).sort((a, b) => a.rss - b.rss);
  // the seed retarget frames come from continuous (analytic) times that fall between frames: the whole set one frame
  // later or earlier is tried too (lab case M07 I1(1) p400 at R4: seeds one frame early on the drv channel trapped the
  // per-retarget coordinate search in a k = 136 optimum against k = 200)
  if (disc && short.length) for (const d of [1, -1]) {
    const tf = trFix.map((a, j) => a.map((x) => { const T = takes[j].T; const fi = T.findIndex((t) => t >= x); const q = Math.min(T.length - 1, Math.max(1, fi + d)); return T[q] - 1e-6; }));
    const rf = residWith(tf); const rI = intoWith(tf); const r = lm(rf, short[0].p, { lower, upper, maxIter: 12, scale, into: rI, m: nUsed });
    if (r.ok && r.rss < short[0].rss) { trFix = tf; resid = rf; into = rI; short = [r, ...short.map((q) => lm(rf, q.p, { lower, upper, maxIter: 4, scale, into: rI, m: nUsed })).filter((q) => q.ok)].sort((a, b) => a.rss - b.rss); }
  }
  let best = null;
  for (const s of short.slice(0, 2)) { const r = lm(resid, s.p, { lower, upper, maxIter: 100, scale, into, m: nUsed }); if (r.ok && (!best || r.rss < best.rss)) best = r; }
  if (!best) return null;
  // discrete retarget frames: coordinate search over neighbouring frames, two rounds
  if (disc) for (let round = 0; round < 2; round++) for (let j = 0; j < nT; j++) for (let q = 0; q < trFix[j].length; q++) {
    const T = takes[j].T; const fi = T.findIndex((t) => t >= trFix[j][q]);
    for (const d of [-3, -2, -1, 1, 2, 3]) {
      const tt = T[fi + d]; if (tt == null || fi + d < 1) continue;
      const tf = trFix.map((a) => a.slice()); tf[j][q] = tt - 1e-6;
      const r = lm(null, best.p, { lower, upper, maxIter: 30, scale, into: intoWith(tf), m: nUsed });
      if (r.ok && r.rss < best.rss * (1 - 1e-9)) { best = r; trFix = tf; }
    }
  }
  resid = residWith(trFix);
  const perTake = takes.map((t, j) => { const sim = simObs(h, unpackTake(best.p, j), t); let s = 0, n = 0; for (let i = 0; i < t.T.length; i++) if (!t.use || t.use[i]) { s += (sim[i] - t.y[i]) ** 2; n++; } return { rss: s, n, rms: Math.sqrt(s / Math.max(1, n)), explains: Math.sqrt(s / Math.max(1, n)) <= t.explainBar, L: likelihood(s, n, t.sigma), sim, model: unpackTake(best.p, j) }; });
  const n = perTake.reduce((a, b) => a + b.n, 0);
  const sig = Math.max(...takes.map((t) => t.sigma));
  const half = ciHalfWidths(resid, best.p, best.rss, n, sig, scale);
  const can = canonical(h, best.p[0], best.p[1]); const f = h.native ? [3600, 60] : [1, 1];
  return { hyp: h.id, native: h.native ? { kf: best.p[0], cf: best.p[1] } : null, k: can.k, c: can.c, kCI: Number.isFinite(half[0]) ? [can.k - half[0] * f[0], can.k + half[0] * f[0]] : null,
    cCI: Number.isFinite(half[1]) ? [can.c - half[1] * f[1], can.c + half[1] * f[1]] : null, rss: best.rss, n, L: perTake.reduce((a, b) => a + b.L, 0), admissible: perTake.every((q) => q.explains), atFloor: perTake.every((q, j) => q.rms <= Math.max(10 * takes[j].sigma, 1e-5 * ((Math.max(...takes[j].y) - Math.min(...takes[j].y)) || 1))), perTake };
}

/**
 * Identification rule (design §4.3): admissible = explains every take with one (k, c); S = admissible within ΔL < 10
 * of the best admissible; identified ⇔ S non-empty and all members' (k, c) agree within 2 %.
 */
export function identify(fits) {
  const adm = fits.filter((f) => f && f.admissible).sort((a, b) => a.L - b.L);
  if (!adm.length) return { identified: false, set: [], reason: 'no hypothesis explains every take with one (k, c)', fits };
  // identifying an integrator is a finer claim than explaining the curve: the best hypothesis must reach the noise floor
  // (rms ≤ max(10 σ, 1e-5·A) in every take; 1e-5·A covers 6-significant-digit serialisation of transform strings). A best fit that only meets the explain bar (5e-4·A) is the nearest listed integrator,
  // not the identified one (lab case M07x: velocity Verlet and I1(5) read as I6 at rms 0.13 px against σ 3e-7 px)
  if (!adm[0].atFloor) return { identified: false, set: adm.filter((f) => f.L - adm[0].L < 10).map((f) => f.hyp), reason: `best hypothesis ${adm[0].hyp} leaves a residual above the noise floor (rms ${Math.max(...adm[0].perTake.map((q) => q.rms)).toExponential(2)}): the integrator is not one of the listed hypotheses or not resolved`, fits };
  const S = adm.filter((f) => f.L - adm[0].L < 10);
  const agree = S.every((f) => Math.abs(f.k / S[0].k - 1) <= 0.02 && Math.abs(f.c / S[0].c - 1) <= 0.02);
  return { identified: agree, set: S.map((f) => f.hyp), best: S[0], reason: agree ? null : `identified set ${S.map((f) => f.hyp).join(', ')} disagrees on (k, c) by more than 2 %`, fits };
}
