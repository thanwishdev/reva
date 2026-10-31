// Time-based tweens (design §4.1): free-onset cubic-bezier + exact named eases, value units, sub-frame t0.
import { cubicBezier } from '../oracles.js';
import { fitModel } from './model.js';
import { NAMED, easeAt } from './eases.js';
import { fitCubicBezier } from './vendor/understudy/bezier.js';

/** Shared window setup: data slice, fixed endpoints, onset/duration seeds. */
export function tweenWindow(s, seg, dt) {
  const T = s.T.slice(seg.w0, seg.w1 + 1), y = s.y.slice(seg.w0, seg.w1 + 1);
  const from = seg.restBefore, to = seg.settled ? s.y[Math.min(s.y.length - 1, seg.w1)] : null;
  const t0 = s.T[seg.b] - dt * 0.75, D = Math.max(dt, s.T[seg.e] - t0);
  return { T, y, from, to, t0, D, dt, tMin: s.T[seg.w0] - 2 * dt, tMax: s.T[seg.b] };
}

function endpoints(w) {
  const spec = []; const get = [];
  if (w.from == null) { spec.push({ name: 'from', scale: Math.abs(w.y[0]) || 1 }); get.push((p, j) => p[j]); } else get.push(() => w.from);
  if (w.to == null) { spec.push({ name: 'to', scale: Math.abs(w.y.at(-1)) || 1 }); get.push((p, j) => p[j]); } else get.push(() => w.to);
  return { spec, get };
}

/** Named-ease fit: params t0, D (+ free endpoints). */
export function fitNamed(name, w, sigma, use) {
  const E = NAMED[name].fn; const ep = endpoints(w);
  const spec = [{ name: 't0', lo: w.tMin, hi: w.tMax, scale: w.dt, unit: 'ms' }, { name: 'D', lo: w.dt * 0.5, hi: 1e5, scale: w.D, unit: 'ms' }, ...ep.spec];
  const f = (p, T) => { const fr = ep.get[0](p, 2), to = ep.get[1](p, w.from == null ? 3 : 2); const out = new Array(T.length); for (let i = 0; i < T.length; i++) out[i] = fr + (to - fr) * easeAt(E, (T[i] - p[0]) / p[1]); return out; };
  const extra = ep.spec.map((s) => (s.name === 'from' ? w.y[0] : w.y.at(-1)));
  const starts = [0.8, 1, 1.3, 1.8].map((m) => [w.t0, w.D * m, ...extra]);
  const r = fitModel({ family: `named:${name}`, cls: 'tween', T: w.T, y: w.y, spec, f, starts, sigma, use });
  if (r) { r.ease = name; r.easeFn = E; r.endpoints = { from: ep.get[0](r.p, 2), to: ep.get[1](r.p, w.from == null ? 3 : 2) }; r.bezier = NAMED[name].bezier || null; }
  return r;
}

/** A fixed ease shape (fn, optional bezier) with free t0, D (+ endpoints): another segment's decided ease (sequence rule). */
export function fitShape(label, E, bezier, w, sigma, use) {
  const ep = endpoints(w);
  const spec = [{ name: 't0', lo: w.tMin, hi: w.tMax, scale: w.dt, unit: 'ms' }, { name: 'D', lo: w.dt * 0.5, hi: 1e5, scale: w.D, unit: 'ms' }, ...ep.spec];
  const f = (p, T) => { const fr = ep.get[0](p, 2), to = ep.get[1](p, w.from == null ? 3 : 2); const out = new Array(T.length); for (let i = 0; i < T.length; i++) out[i] = fr + (to - fr) * easeAt(E, (T[i] - p[0]) / p[1]); return out; };
  const extra = ep.spec.map((s) => (s.name === 'from' ? w.y[0] : w.y.at(-1)));
  const starts = [0.8, 1, 1.3, 1.8, 2.5].map((m) => [w.t0, w.D * m, ...extra]);
  const r = fitModel({ family: label, cls: 'tween', T: w.T, y: w.y, spec, f, starts, sigma, use });
  if (r) { r.easeFn = E; r.bezier = bezier || null; r.endpoints = { from: ep.get[0](r.p, 2), to: ep.get[1](r.p, w.from == null ? 3 : 2) }; r.window = w; r.derived = tweenDerived(E, r.p[0], r.p[1], r.endpoints.from, r.endpoints.to); }
  return r;
}

/** Free cubic-bezier fit: t0, D, x1, y1, x2, y2 (+ free endpoints); multi-start from the named set and understudy. */
export function fitBezier(w, sigma, use, seeds = []) {
  const ep = endpoints(w); const off = 6;
  const spec = [{ name: 't0', lo: w.tMin, hi: w.tMax, scale: w.dt, unit: 'ms' }, { name: 'D', lo: w.dt * 0.5, hi: 1e5, scale: w.D, unit: 'ms' },
    { name: 'x1', lo: 0, hi: 1, scale: 0.1 }, { name: 'y1', lo: -1, hi: 2, scale: 0.1 }, { name: 'x2', lo: 0, hi: 1, scale: 0.1 }, { name: 'y2', lo: -1, hi: 2, scale: 0.1 }, ...ep.spec];
  const f = (p, T) => { const B = cubicBezier(p[2], p[3], p[4], p[5]); const fr = ep.get[0](p, off), to = ep.get[1](p, w.from == null ? off + 1 : off); const out = new Array(T.length); for (let i = 0; i < T.length; i++) out[i] = fr + (to - fr) * easeAt(B, (T[i] - p[0]) / p[1]); return out; };
  const extra = ep.spec.map((s) => (s.name === 'from' ? w.y[0] : w.y.at(-1)));
  const ctl = [[0.25, 0.1, 0.25, 1], [0.42, 0, 0.58, 1], [0, 0, 0.58, 1], [0.42, 0, 1, 1], [0.33, 1, 0.68, 1], [0.16, 1, 0.3, 1], [0.34, 1.56, 0.64, 1], [0.65, 0, 0.35, 1]];
  // understudy seed on normalised progress (fixed t = 0 at the first moving sample; only a seed)
  const fr0 = w.from ?? w.y[0], to0 = w.to ?? w.y.at(-1);
  if (Math.abs(to0 - fr0) > 0) { const smp = w.T.map((t, i) => ({ t: t - w.t0, p: (w.y[i] - fr0) / (to0 - fr0) })).filter((q) => q.t >= 0 && q.t <= w.D); const us = fitCubicBezier(smp); if (us.sampleCount >= 4) ctl.push(us.control); }
  const starts = []; for (const c of [...seeds, ...ctl]) starts.push([w.t0, w.D, ...c, ...extra]);
  // cheap pre-screen: keep the 3 best starts, then NM + LM
  const pre = starts.map((s) => ({ s, e: sse(f(s, w.T), w.y) })).sort((a, b) => a.e - b.e).slice(0, 3).map((q) => q.s);
  const r = fitModel({ family: 'bezier', cls: 'tween', T: w.T, y: w.y, spec, f, starts: pre, sigma, use, nm: true, nmIter: 600 });
  if (r) { r.bezier = r.p.slice(2, 6); r.easeFn = cubicBezier(...r.bezier); r.endpoints = { from: ep.get[0](r.p, off), to: ep.get[1](r.p, w.from == null ? off + 1 : off) }; }
  return r;
}
const sse = (m, y) => { let s = 0; for (let i = 0; i < y.length; i++) s += (m[i] - y[i]) ** 2; return s; };

/** Derived quantities of a tween (design §4.1): t10…t99 from t0, peak velocity, overshoot, crossings. */
export function tweenDerived(E, t0, D, from, to) {
  const N = 2000; const A = to - from; const out = { t10: null, t50: null, t90: null, t99: null, peakVelocity: 0, tPeak: null, overshoot: 0, crossings: 0 };
  let prev = 0, above = false;
  for (let i = 1; i <= N; i++) {
    const p = easeAt(E, i / N); const t = (i / N) * D;
    for (const [q, key] of [[0.1, 't10'], [0.5, 't50'], [0.9, 't90'], [0.99, 't99']]) if (out[key] == null && p >= q) out[key] = t;
    const v = ((p - prev) * A) / (D / N) * 1000; if (Math.abs(v) > Math.abs(out.peakVelocity)) { out.peakVelocity = v; out.tPeak = t; }
    if (p > 1) out.overshoot = Math.max(out.overshoot, (p - 1) * Math.abs(A));
    if ((p >= 1) !== above && i > 1) { out.crossings++; above = p >= 1; }
    prev = p;
  }
  out.t0 = t0; out.unitsPerS = 'value/s';
  return out;
}

/** Candidate set for one segment: the free bezier + every named ease. */
export function tweenCandidates(s, seg, dt, sigma) {
  const w = tweenWindow(s, seg, dt); const out = [];
  for (const name of Object.keys(NAMED)) { if (name === 'expo.out') continue; const r = fitNamed(name, w, sigma); if (r) out.push(r); }
  const top = out.filter((r) => r.bezier).sort((a, b) => a.rss - b.rss).slice(0, 2).map((r) => r.bezier);
  const b = fitBezier(w, sigma, null, top); if (b) out.push(b);
  for (const r of out) { r.window = w; r.derived = tweenDerived(r.easeFn, r.p[0], r.p[1], r.endpoints.from, r.endpoints.to); r.seg = seg; }
  return out;
}
