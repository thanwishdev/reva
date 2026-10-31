// Generic least-squares model fit used by every family: multi-start (Nelder–Mead, vendored) + LM polish (own),
// residuals in value units, covariance intervals (design §5.4), and a refit hook for holdout (design §5.2).
import { lm, nelderMead, sse, ciHalfWidths, likelihood, bic, charge } from './numeric.js';

/**
 * @param {object} o
 * @param {string} o.family      e.g. 'bezier', 'named:easeOutCubic', 'spring-analytic'
 * @param {string} o.cls         class (A1.6 a taxonomy)
 * @param {number[]} o.T         sample times (ms)
 * @param {number[]} o.y         samples (value units)
 * @param {{name:string, lo?:number, hi?:number, scale?:number, unit?:string}[]} o.spec
 * @param {(p:number[], T:number[])=>number[]} o.f   model prediction
 * @param {number[][]} o.starts  start vectors
 * @param {number} o.sigma       σ_floor of the channel
 * @param {boolean[]} [o.use]    frames used in the residual (holdout / snap exclusion)
 * @param {boolean} [o.nm]       run Nelder–Mead from each start before LM
 * @param {number} [o.nmIter]
 */
export function fitModel(o) {
  // parameters with `fixed: true` stay at their start value (lo = hi); they are not counted in k and get no CI
  if (o.spec.some((q) => q.fixed)) return fitWithFixed(o);
  const lo = o.spec.map((s) => s.lo ?? -Infinity), hi = o.spec.map((s) => s.hi ?? Infinity), scale = o.spec.map((s) => s.scale ?? 1);
  const use = o.use || o.T.map(() => true); const idx = []; use.forEach((u, i) => u && idx.push(i));
  const yu = idx.map((i) => o.y[i]);
  const inBox = (p) => p.every((v, i) => v >= lo[i] && v <= hi[i]);
  // the model is always evaluated on the full frame list (recursive models — smoothers, simulations — need every
  // frame); unused frames are dropped from the residual only
  const rf = (p) => { charge(o.T.length); const m = o.f(p, o.T); const r = new Array(idx.length); for (let i = 0; i < idx.length; i++) r[i] = m[idx[i]] - yu[i]; return r; };
  // L9-A (fit speed): the optimisers' evaluations write no residual array. The Nelder–Mead objective sums the squared
  // residuals in the pass that forms them, and LM gets them in preallocated buffers (lm `into`). A model may also give a
  // fused evaluator `o.fx` ({sse(p, y, mask), resid(p, y, mask, out)}: simulation, residual and SSE in one loop, no
  // prediction array; smoothing.js perMap). Each path computes m[idx[i]] − yu[i] and sums the squares over i ascending
  // from 0, exactly as sse(rf(p)), with the same meter charge before the evaluation: bit-identical. The allocating `rf`
  // stays for the intervals and the profile refits.
  const nU = idx.length; let fx = o.fx || null; let mask = null;
  // the fused evaluator reads the used frames from a mask over the model's frames (null: every frame, in order)
  if (fx && !(nU === o.T.length && (nU === 0 || idx[nU - 1] === nU - 1))) {
    mask = new Uint8Array(o.T.length); for (const i of idx) { if (i < o.T.length) mask[i] = 1; else fx = null; }
  }
  const into = (p, out) => {
    charge(o.T.length);
    if (fx) { fx.resid(p, o.y, mask, out); return; }
    const m = o.f(p, o.T); for (let i = 0; i < nU; i++) out[i] = m[idx[i]] - yu[i];
  };
  const obj = (p) => {
    if (!inBox(p)) return Infinity;
    charge(o.T.length);
    if (fx) return fx.sse(p, o.y, mask);
    const m = o.f(p, o.T); let s = 0; for (let i = 0; i < nU; i++) { const d = m[idx[i]] - yu[i]; s += d * d; } return s;
  };
  // L9-B: a model may bring its own search (o.search, smoothing.js perMap: drivesearch.js), returning {p, rss} at the
  // optimum or null; null (and no o.search: REVA_FIT_SEARCH=exact) runs the multi-start Nelder–Mead + LM below
  let best = o.search && fx ? o.search({ lo, hi, scale, mask, nU }) : null;
  if (!best) for (const s0 of o.starts) {
    let p = s0.map((v, i) => Math.min(hi[i], Math.max(lo[i], v)));
    if (o.nm) { const r = nelderMead(obj, p, { initialStep: scale.map((s, i) => (Math.abs(p[i]) * 0.05 || s * 0.05)), maxIterations: o.nmIter || 400, tolFun: 1e-14, tolX: 1e-10 }); if (Number.isFinite(r.fx)) p = r.x; }
    const r = lm(rf, p, { lower: lo, upper: hi, maxIter: o.lmIter || 60, scale, into, m: nU });
    if (!best || r.rss < best.rss) best = { p: r.p, rss: r.rss };
  }
  if (!best || !Number.isFinite(best.rss)) return null;
  const n = idx.length, k = o.spec.length;
  // a parameter sitting on its bound (e.g. α_up = 1: a snap on rise, lab case M03) makes the covariance singular for
  // every parameter: compute the intervals of the free parameters with the bound ones held, and report the bound value
  // with a one-sided interval [bound, bound]
  let half;
  if (o.noCI) half = o.spec.map(() => Infinity);
  else {
    const atB = best.p.map((v, i) => (Number.isFinite(lo[i]) && Math.abs(v - lo[i]) <= 1e-6 * (scale[i] || 1)) || (Number.isFinite(hi[i]) && Math.abs(v - hi[i]) <= 1e-6 * (scale[i] || 1)));
    if (atB.some(Boolean) && !atB.every(Boolean)) {
      const free = atB.map((b, i) => (b ? -1 : i)).filter((i) => i >= 0);
      const put = (q) => { const pp = best.p.slice(); free.forEach((i, a) => { pp[i] = q[a]; }); return pp; };
      const hf = ciHalfWidths((q) => rf(put(q)), free.map((i) => best.p[i]), best.rss, n, o.sigma, free.map((i) => scale[i]));
      half = o.spec.map((_, i) => (atB[i] ? 0 : hf[free.indexOf(i)]));
    } else half = ciHalfWidths(rf, best.p, best.rss, n, o.sigma, scale);
  }
  const params = {};
  o.spec.forEach((s, i) => { params[s.name] = { value: best.p[i], unit: s.unit || null, ci95: Number.isFinite(half[i]) ? [best.p[i] - half[i], best.p[i] + half[i]] : null }; });
  const full = o.f(best.p, o.T);
  return {
    family: o.family, cls: o.cls, p: best.p, params, spec: o.spec, n, k, rss: best.rss, rms: Math.sqrt(best.rss / Math.max(1, n)),
    L: likelihood(best.rss, n, o.sigma), bic: bic(best.rss, n, k, o.sigma), predictFull: full,
    predict: (T) => o.f(best.p, T),
    refit: (use2) => fitModel({ ...o, search: null, use: use2, starts: [best.p], nm: false, noCI: true }),
    /** RSS re-optimised with parameter i held at v (profile likelihood, design §5.4). */
    rssWithFixed: (i, v) => {
      const keep = o.spec.map((_, j) => j).filter((j) => j !== i); if (!keep.length) return sse(rf(best.p.map((x, j) => (j === i ? v : x))));
      const put = (q) => { const p = best.p.slice(); keep.forEach((j, a) => { p[j] = q[a]; }); p[i] = v; return p; };
      const r = lm((q) => rf(put(q)), keep.map((j) => best.p[j]), { lower: keep.map((j) => lo[j]), upper: keep.map((j) => hi[j]), maxIter: 25, scale: keep.map((j) => scale[j]) });
      return r.ok ? r.rss : Infinity;
    },
  };
}

function fitWithFixed(o) {
  const free = o.spec.map((q, i) => (q.fixed ? -1 : i)).filter((i) => i >= 0);
  const full = (q) => { const p = o.spec.map((sp) => (sp.fixed ? sp.lo ?? 0 : 0)); free.forEach((i, a) => { p[i] = q[a]; }); return p; };
  const inner = { ...o, fx: null, spec: free.map((i) => o.spec[i]), f: (q, T) => o.f(full(q), T), starts: o.starts.map((st) => free.map((i) => st[i])) };
  const r = fitModel(inner); if (!r) return null;
  const params = {}; o.spec.forEach((sp, i) => { params[sp.name] = sp.fixed ? { value: sp.lo ?? 0, unit: sp.unit || null, ci95: null, fixed: true } : r.params[sp.name]; });
  const p = full(r.p);
  return { ...r, p, params, spec: o.spec, predict: (T) => o.f(p, T),
    refit: (use2) => { const x = r.refit(use2); return x && { ...x, p: full(x.p) }; },
    rssWithFixed: (i, v) => { const a = free.indexOf(i); return a < 0 ? r.rss : r.rssWithFixed(a, v); } };
}
