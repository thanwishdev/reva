// The law check (DESIGN 3.5): does one fitted law hold on another run of its class? Each run gets its own start, scale and offset, the
// law's shape stays. A fit costs a second, this costs microseconds, and it closes the 5-11 % of pairs where two runs share a class and
// not a law. It reads the same evaluator the card draws from, so what is checked is what is shown. A law the evaluator cannot read has
// `null`, never a pass: a step, a composite, a restarted tween or a follower has no one curve to hold a run against.
import { fittedProgress, travelOf, isStillMap, driverOf } from '../../card/data.js';
import { familyKind } from '../../export/index.js';
import { FIT } from './contract.js';

const DT = 1000 / 60, SHIFT_FRAMES = 3;

/** The parts of a record that a check and the code need, so a law crosses a worker's message cheaply. */
export function slimRecord(rec) {
  return { target: { el: rec.target?.el, channel: rec.target?.channel, form: rec.target?.form ?? undefined, desc: rec.target?.desc }, tier: rec.tier, class: rec.class, model: rec.model, derived: rec.derived, fit: rec.fit, declared: rec.declared, evidence: rec.evidence };
}

/**
 * A record as a function of its own axis, or null when no single curve describes it.
 * A spring whose start value the fit left out gets it from `x0`, so a later check needs no rows of the exemplar.
 * @returns {{axis:'time'|'scroll', fn:function, t0?:number, span:number, s0?:number, s1?:number, x0?:number}|null}
 */
export function evaluator(rec, { x0 = null } = {}) {
  if (!rec || !rec.model || isStillMap(rec)) return null;
  if (rec.model.family === 'ramp') {   // constant speed: a tween the card's evaluator has no family for
    const D = rec.model.params?.D?.value ?? rec.model.params?.D?.withheld_value, t0 = Number.isFinite(rec.derived?.t0) ? rec.derived.t0 : rec.model.params?.t0?.value;
    return D > 0 && Number.isFinite(t0) ? { axis: 'time', t0, span: D, fn: (t) => (t <= 0 ? 0 : t >= D ? 1 : t / D) } : null;
  }
  let r = rec;
  if (x0 != null && familyKind(rec.model.family) === 'spring' && !(rec.model.params?.x0?.value != null)) r = { ...rec, model: { ...rec.model, params: { ...rec.model.params, x0: { value: x0 } } } };
  let ev; try { ev = fittedProgress(r, null); } catch { return null; }
  if (!ev || ev.axis === 'step') return null;
  if (ev.axis === 'scroll' && driverOf(rec).kind !== 'scroll') return null;
  return ev;
}

/** Largest gap between a track and a shape, with the best start and scale, as a share of the track's own range. */
function gapOf(xs, ys, f) {
  const pts = xs.map((x, i) => ({ x, y: ys[i] }));
  const { from, to } = travelOf(pts, (p) => f(p.x));
  if (from == null || to == null) return null;
  const lo = Math.min(...ys), hi = Math.max(...ys), range = hi - lo;
  if (!(range > 0)) return null;
  let max = 0; for (const p of pts) { const e = Math.abs(p.y - (from + (to - from) * f(p.x))); if (e > max) max = e; }
  return { pct: (max / range) * 100, from, to };
}

/**
 * Error of a law on one track, in % of that track's range, or null when the law cannot be evaluated there.
 * @param {object} ev  evaluator()
 * @param {{T:number[], y:number[], sy:number[]}} track
 * @param {{shift?:number}} o  how far this run starts after the run the law was fitted on, in ms, or in px of scroll for a scroll law
 * @returns {{errorPct:number, shift:number, from:number, to:number}|null}
 */
export function lawError(ev, track, { shift = 0 } = {}) {
  if (!ev || !track || track.T.length < 3) return null;
  if (ev.axis === 'scroll') {
    const g = gapOf(track.sy, track.y, (s) => ev.fn(s - shift));
    return g && { errorPct: g.pct, shift, from: g.from, to: g.to };
  }
  let best = null;
  for (let f = -SHIFT_FRAMES; f <= SHIFT_FRAMES; f += 0.5) {
    // a time law says nothing about the frames before it starts: a value set just before the tween is no error of the tween
    const s = shift + f * DT, from = track.T.findIndex((t) => t >= ev.t0 + s - DT);
    if (from < 0 || track.T.length - from < 3) continue;
    const g = gapOf(track.T.slice(from), track.y.slice(from), (t) => ev.fn(t - ev.t0 - s));
    if (g && (!best || g.pct < best.errorPct)) best = { errorPct: g.pct, shift: s, from: g.from, to: g.to };
  }
  return best;
}

export const holds = (e) => e != null && e.errorPct <= FIT.lawCheckShare * 100;

/** Up to `n` runs of a class to check, spread over its list, so one take cannot speak for all of them. */
export function pickInstances(runs, exemplar, n = FIT.lawCheckInstances) {
  const rest = runs.filter((r) => r !== exemplar);
  if (rest.length <= n) return rest;
  return Array.from({ length: n }, (_, i) => rest[Math.floor((i * rest.length) / n)]);
}
