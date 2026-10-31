// Closed-form evaluation of truth items (written from the truth object's parameters, not from refsim), so a take can be
// compared with the truth file directly: truth <-> browser, independent of refsim's scheduler model.
import { easeFn, cubicBezier } from '../core.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const bezierOf = (e) => (Array.isArray(e) ? cubicBezier(e[0], e[1], e[2], e[3]) : e === 'linear' ? (x) => x : easeFn(e));
const r6 = (x) => Math.round(x * 1e6) / 1e6;

const keyframesHold = (it, T) => {
  const p = it.params, d = p.declared, hold = p.visible.hold_fraction, f = cubicBezier(...p.segment_bezier);
  const local = T - d.start_ms - d.delay_ms;
  let e;
  if (local <= 0) e = 0; else if (local >= d.duration_ms) e = 1;
  else { const u = local / d.duration_ms; e = u <= hold ? 0 : f((u - hold) / (1 - hold)); }
  return p.from + (p.to - p.from) * e;
};
const cssBezierAnim = (it, T) => {
  const p = it.params, d = p.declared, f = cubicBezier(...d.easing), local = T - d.start_ms - d.delay_ms;
  return p.from + (p.to - p.from) * (local <= 0 ? 0 : local >= d.duration_ms ? 1 : f(local / d.duration_ms));
};
const scrollMap = (it, T, sy) => {
  const m = it.params.map, f = bezierOf(m.shape && m.shape.bezier ? m.shape.bezier : m.shape);
  return m.a + (m.b - m.a) * f(clamp01((sy - m.s0) / (m.s1 - m.s0)));
};
const smil = (it, T) => {
  const p = it.params;
  if (T < p.begin_ms) return p.from;
  const f = p.key_splines ? cubicBezier(...p.key_splines) : (x) => x;
  return p.from + (p.to - p.from) * f((r6(T - p.begin_ms) % p.duration_ms) / p.duration_ms);
};
/** FLIP / segmented bezier tweens: items of one target with a `segment` index and start_ms */
const flipSegments = (group, T) => {
  const segs = [...group].sort((a, b) => a.params.segment - b.params.segment);
  let cur = null;
  for (const s of segs) if (s.params.start_ms <= T) cur = s;
  if (!cur) return segs[0].params.to;
  const p = cur.params;
  return p.from + (p.to - p.from) * cubicBezier(...p.easing)(clamp01((T - p.start_ms) / p.duration_ms));
};
/** time tweens with a named ease or bezier, one item per segment (m19, m16) */
const tweenSegments = (group, T) => {
  const segs = [...group].sort((a, b) => a.segment - b.segment);
  let cur = null;
  for (const s of segs) if (s.params.t0_ms <= T) cur = s;
  if (!cur) return segs[0].params.from;
  const p = cur.params;
  return p.from + (p.to - p.from) * easeFn(p.ease)(clamp01((T - p.t0_ms) / p.duration_ms));
};
const countUp = (it, T) => { const p = it.params; return p.from + (p.to - p.from) * easeFn(p.ease)(clamp01((T - p.t0_ms) / p.duration_ms)); };
const typing = (it, T) => { const p = it.params; return T < p.t0_ms ? 0 : Math.min(p.length, Math.floor((T - p.t0_ms) / p.char_ms)); };

/** {channels} for compareToTake from a truth object, on the rows of a take (frames carry T and sy). */
export function truthChannels(tr, rows, marks = []) {
  const goK = (marks.find((m) => m.name === 'go') || {}).k;
  const byTarget = new Map();
  for (const it of tr.items) { if (!byTarget.has(it.target)) byTarget.set(it.target, []); byTarget.get(it.target).push(it); }
  const channels = {};
  for (const [target, group] of byTarget) {
    if (target.startsWith('html::')) continue;
    const it = group[0];
    let f = null;
    if (it.family === 'css-keyframes-bezier-segments') f = (r) => keyframesHold(it, r.T);
    else if (it.family === 'css-animation-bezier') f = (r) => cssBezierAnim(it, r.T);
    else if (it.family === 'scroll-timeline') f = (r) => scrollMap(it, r.T, r.sy);
    else if (it.family === 'smil-animate-sawtooth') f = (r) => smil(it, r.T);
    else if (it.family === 'waapi-bezier' || (it.family === 'bezier' && it.params.impl)) f = (r) => flipSegments(group, r.T);
    else if (it.family === 'quantised-ramp') f = (r) => typing(it, r.T);
    else if (it.family === 'layout-update') f = (r) => (r.k > goK ? it.params.to : it.params.from);   // the update callback runs in the real frame of step k+1
    else if (it.segment != null) f = (r) => tweenSegments(group, r.T);          // m19, m16e, m16f
    else if (it.family.startsWith('named:')) f = (r) => countUp(it, r.T);
    if (f) channels[target] = rows.map(f);
  }
  return { channels };
}
