import { NAMED, parseEasing } from '../eases.js';
import { cubicBezier } from '../../oracles.js';
import { MAP_SHAPES } from '../smoothing.js';
// Registered recovery metrics (D-M2-2: G1-4 §8.2 + Amendment 1). Each metric compares a fitted record value with a
// truth value under the registered tolerance; tolerances are copied from the pre-registration, never tuned here.
// Truth items come from the lab's truth.mjs (design §11); the fitter core never sees them.

/** Class taxonomy normaliser (A1.6 a). Ambiguous / abstained records are `unknown`. */
export function predictedClass(rec) {
  // no record: the fitter emits a record for every series that moved above its floor, so a sampled channel without one
  // was observed static in these takes (coverage tri-state: "not observed moving")
  if (!rec) return 'static';
  if (rec.ambiguity || rec.tier === 'unknown' || rec.tier === 'unexplained') return 'unknown';
  return rec.class === 'periodic' ? 'periodic' : rec.class;
}

const frameMs = (ctx) => ctx.dtMs;
const relErr = (a, b) => Math.abs(a - b) / Math.abs(b || 1e-12);

/**
 * Metric registry: id → {get(rec, fit, item) → {value, ci95, provenance}, truth(item) → number, err(v, t, ctx, item) →
 * error in tolerance units' scale, tol(ctx, item) → registered pass tolerance, kind}.
 */
export const METRICS = {
  alpha: { get: (r) => p(r, 'alpha_per_frame'), truth: (it) => it.params.alpha, err: relErr, tol: (ctx) => (ctx.regime === 'R6' ? 0.10 : ctx.write === 'q2' ? 0.08 : ctx.write === 'q3' ? 0.03 : 0.05), unit: 'rel', row: 'M02/M03/M04 alpha (R6: corrected within 10 % or abstain)' },
  tau: { get: (r) => p(r, 'tau_ms'), truth: (it) => it.derived && it.derived.tau_ms, err: relErr, tol: () => 0.05, unit: 'rel', row: 'tau at measured T' },
  settle_tail: { get: (r) => ({ value: r.derived && r.derived.settle_frames, provenance: 'fitted', ci95: (r.derived && r.derived.settle_frames_ci95) || null }), truth: (it) => it.derived && it.derived.settle_frames, err: (a, b) => Math.abs(a - b), tol: () => 2, unit: 'frames', row: 'M02 settle tail' },
  k: { get: (r, f, it) => p(r, it.integrator === 'I4' ? 'kf' : 'k'), truth: (it) => (it.integrator === 'I4' ? it.params.kf : it.params.k), err: relErr, tol: () => 0.05, unit: 'rel', row: 'M07 k (identified only)' },
  c: { get: (r, f, it) => p(r, it.integrator === 'I4' ? 'cf' : 'c'), truth: (it) => (it.integrator === 'I4' ? it.params.cf : it.params.c), err: relErr, tol: () => 0.05, unit: 'rel', row: 'M07 c (identified only)' },
  omega: { get: (r) => ({ ...(p(r, 'omega') || {}), value: r.derived && r.derived.omega }), truth: (it) => it.params.omega, err: relErr, tol: () => 0.05, unit: 'rel', row: 'M08 omega' },
  zeta: { get: (r) => ({ ...(p(r, 'zeta') || {}), value: r.derived && r.derived.zeta }), truth: (it) => it.params.zeta, err: relErr, tol: () => 0.05, unit: 'rel', row: 'M08 zeta' },
  overshoot: { get: (r) => ({ value: r.derived && r.derived.overshoot, provenance: 'fitted', ci95: (r.derived && r.derived.overshoot_ci95) || null }), truth: (it) => it.derived && it.derived.overshoot, err: (a, b, ctx, it) => Math.abs(a - b) / (it.derived.A || 1), tol: () => 0.02, unit: 'A', row: 'M08 overshoot' },
  settle2: { get: (r) => ({ value: r.derived && r.derived.settle2, provenance: 'fitted', ci95: null }), truth: (it) => it.derived && it.derived.settle2, err: (a, b) => Math.abs(a - b), tol: (ctx, it) => frameMs(ctx) + 0.05 * (it.derived.settle2 || 0), unit: 'ms', row: 'M08 settle 2 %' },
  friction: { get: (r) => p(r, 'friction'), truth: (it) => it.params.friction, err: relErr, tol: () => 0.05, unit: 'rel', row: 'M10 friction' },
  stopping: { get: (r) => ({ value: r.derived && r.derived.stoppingDistance, provenance: 'fitted', ci95: (r.derived && r.derived.stoppingDistance_ci95) || null }), truth: (it) => it.derived && it.derived.stoppingDistance, err: relErr, tol: () => 0.03, unit: 'rel', row: 'M10 stopping distance' },
  duration: { get: (r) => p(r, 'D') || p(r, 'duration'), truth: (it) => it.params.D ?? it.params.duration, err: (a, b) => Math.abs(a - b), tol: (ctx) => frameMs(ctx) + 8, unit: 'ms', row: 'M05 tween duration' },
  onset: { get: (r) => (r.derived && Number.isFinite(r.derived.visibleOnset) ? { value: r.derived.visibleOnset, provenance: 'measured', ci95: null } : p(r, 't0') || { value: r.derived && r.derived.t0, provenance: 'fitted', ci95: null }), truth: (it) => it.params.t0 ?? (it.derived && it.derived.t0), err: (a, b) => Math.abs(a - b), tol: (ctx) => frameMs(ctx), unit: 'ms', row: 'M06 visible onset' },
  map_s0: { get: (r) => ({ value: r.model.map && r.model.map.s0_px, provenance: r.model.map && (r.model.map.provenance === 'unknown' || r.model.map.s0_provenance === 'unknown') ? 'unknown' : 'fitted', ci95: r.model.map ? r.model.map.s0_ci95 || null : null }), truth: (it) => it.params.map && it.params.map.s0, err: (a, b) => Math.abs(a - b), tol: () => 2, unit: 'px', row: 'M01 range endpoints' },
  map_s1: { get: (r) => ({ value: r.model.map && r.model.map.s1_px, provenance: r.model.map && (r.model.map.provenance === 'unknown' || r.model.map.s1_provenance === 'unknown') ? 'unknown' : 'fitted', ci95: r.model.map ? r.model.map.s1_ci95 || null : null }), truth: (it) => it.params.map && it.params.map.s1, err: (a, b) => Math.abs(a - b), tol: () => 2, unit: 'px', row: 'M01 range endpoints' },
  pin_start: { scope: 'cell', get: (r, f, it) => pinOf(f, it, 'start_px'), truth: (it) => it.params.pin && it.params.pin.start, err: (a, b) => Math.abs(a - b), tol: (ctx, it) => Math.max(2, 0.005 * Math.abs((it.params.pin.end - it.params.pin.start) || 0)), unit: 'px', row: 'M04 pin range start' },
  pin_end: { scope: 'cell', get: (r, f, it) => pinOf(f, it, 'end_px'), truth: (it) => it.params.pin && it.params.pin.end, err: (a, b) => Math.abs(a - b), tol: (ctx, it) => Math.max(2, 0.005 * Math.abs((it.params.pin.end - it.params.pin.start) || 0)), unit: 'px', row: 'M04 pin range end' },
  hysteresis_down: { get: (r) => ({ value: r.hysteresis && r.hysteresis.bands[0] && r.hysteresis.bands[0].downEdge_sibling, provenance: 'measured', ci95: null }), truth: (it) => it.params.hysteresis && it.params.hysteresis.down, err: (a, b) => Math.abs(a - b), tol: () => 0.05, unit: 'index', row: 'M04 hysteresis band edges' },
  hysteresis_up: { get: (r) => ({ value: r.hysteresis && r.hysteresis.bands[0] && r.hysteresis.bands[0].upEdge_sibling, provenance: 'measured', ci95: null }), truth: (it) => it.params.hysteresis && it.params.hysteresis.up, err: (a, b) => Math.abs(a - b), tol: () => 0.05, unit: 'index', row: 'M04 hysteresis band edges' },
  // M21 (A1.3): step-response duration of a restarted tween, relative error ≤ 5 % (the τ row value)
  step_response: { get: (r) => (r.derived && Number.isFinite(r.derived.stepResponseMs) ? { value: r.derived.stepResponseMs, provenance: r.model.params.L ? r.model.params.L.provenance : 'fitted', ci95: r.model.params.L ? r.model.params.L.ci95 : null } : null), truth: (it) => it.derived && it.derived.step_response_duration_ms, err: relErr, tol: () => 0.05, unit: 'rel', row: 'M21 step-response duration' },
  stagger_step: { scope: 'cell', get: (r, f) => ({ value: f.stagger[0] && f.stagger[0].interval.value, provenance: f.stagger[0] ? f.stagger[0].interval.provenance : 'unknown', ci95: f.stagger[0] && f.stagger[0].interval.ci95 }), truth: (it, tr) => tr.stagger && tr.stagger.step_ms, err: (a, b) => Math.abs(a - b), tol: (ctx) => Math.max(8, frameMs(ctx)), unit: 'ms', row: 'M06/M12 stagger interval' },
};
function pinOf(f, it, key) { const sel = (it.target || '').split('|')[0]; const pin = (f.pins || []).find((q) => selectorMatches(sel, q.desc)); return { value: pin ? pin[key] : null, provenance: pin ? 'measured' : 'unknown', ci95: null }; }
function p(r, name) { const v = r && r.model && r.model.params && r.model.params[name]; return v && typeof v === 'object' ? v : null; }

/** Simple selector (tag, #id, .class…) against a recorder descriptor TAG#id.c1.c2. */
export function selectorMatches(sel, desc) {
  if (!desc) return false; const m = /^([^#.]+)?(?:#([^.]+))?(.*)$/.exec(desc); const tag = (m[1] || '').toLowerCase(), id = m[2] || null, cls = (m[3] || '').split('.').filter(Boolean);
  const t = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+)*)$/.exec(sel.trim()); if (!t) return false;
  if (t[1] && t[1].toLowerCase() !== tag) return false;
  for (const part of (t[2] || '').match(/[#.][\w-]+/g) || []) { if (part[0] === '#' && part.slice(1) !== id) return false; if (part[0] === '.' && !cls.includes(part.slice(1))) return false; }
  return true;
}

/** Records for a truth target "<selector>|<channel>" (optionally a segment index). */
export function recordsFor(fit, target, segment, channels) {
  // latent / page-level targets (group D): 'gl:<uniform>' = the WebGL uniform channel, 'dom' = the DOM verdict on a canvas page
  if (/^gl:/.test(target)) { const rs = fit.records.filter((r) => r.target.channel === target); return segment != null ? (rs[segment] ? [rs[segment]] : []) : rs; }
  if (target === 'dom') return fit.records.filter((r) => r.class === 'not_applicable');
  if (/::/.test(target) && !target.includes('|')) { const rs = fit.records.filter((r) => String(r.target.desc || '').toLowerCase() === target.toLowerCase()); return rs; }
  const [sel, ch0] = target.split('|');
  // a channel may be given unprefixed ('--x'): try the driver, then the rendered form; an item may list channels
  const tries = [...new Set([ch0, ...(ch0 && !/^(ren|drv|pix):/.test(ch0) ? ['drv:' + ch0, 'ren:' + ch0] : []), ...(channels || [])].filter(Boolean))];
  let rs = []; let ch = ch0;
  for (const c of tries.length ? tries : [null]) { rs = fit.records.filter((r) => selectorMatches(sel, r.target.desc) && (!c || r.target.channel === c)); if (rs.length) { ch = c; break; } }
  if (!rs.length && ch) {   // a channel pruned as an exact copy of another channel of the same element: score that one (follow chains)
    let c = ch; const seenCh = new Set();
    for (let pr; !rs.length && (pr = (fit.pruned || []).find((q) => selectorMatches(sel, q.desc) && q.ch === c)) && !seenCh.has(c);) {
      seenCh.add(c); c = pr.redundant_with; rs = fit.records.filter((r) => selectorMatches(sel, r.target.desc) && r.target.channel === c);
    }
  }
  return segment != null ? (rs[segment] ? [rs[segment]] : []) : rs;
}

/** Lab integrator ids (group B core.js) → fitter hypothesis ids; out-of-set ids keep their own name. */
const INTEGRATOR_IDS = { i1h16: 'I1(16)', i1h2: 'I1(2)', i1h1: 'I1(1)', i1h4: 'I1(4)', i1h8: 'I1(8)', i1h5: 'I1(5)', i4: 'I4', i5: 'I5', i6: 'I6', i7: 'I7', verlet: 'verlet' };
const OUT_OF_SET = new Set(['I1(5)', 'verlet']);

/**
 * Normalise a group's truth item to the scorer's field names (the four lab groups were built in parallel against
 * design §11; their item shapes differ in naming only). Unknown fields pass through.
 */
export function normalizeItem(it, idxAmongTarget = 0) {
  // group C wraps numbers as {value, unit}: unwrap one level (params and derived)
  const unwrap = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) && 'value' in v && Object.keys(v).every((q) => ['value', 'unit', 'note', 'at_dt_ms', 'stride', 'eps', 'per'].includes(q)) ? v.value : v]));
  const P = unwrap(it.params); const D = unwrap(it.derived); const out = { ...it, params: { ...P }, derived: { ...D } };
  // field-name variants across the four groups (A1.6 a units unchanged)
  if (out.params.alpha == null && P.alpha_per_frame != null) out.params.alpha = P.alpha_per_frame;
  if (out.params.alpha == null && P.alpha_down != null) out.params.alpha = Math.min(P.alpha_down, P.alpha_up ?? 1);   // asymmetric: the eased direction
  if (out.derived.tau_ms == null) out.derived.tau_ms = D.tau_ms_at_T ?? P.tau_ms ?? undefined;
  if (out.derived.settle_frames == null && D.settle_frames_unit_step != null) out.derived.settle_frames = D.settle_frames_unit_step;
  if (P.map && P.map.px && P.map.s0 == null) out.params.map = { ...P.map, s0: P.map.px.s0, s1: P.map.px.s1 };
  if (out.latch == null && P.blocks_scroll === true && P.latch) out.latch = true;
  if (out.derived.stoppingDistance == null && D.stopping_distance_px != null) out.derived.stoppingDistance = D.stopping_distance_px;
  if (it.integrator && typeof it.integrator === 'object') {   // group D: {id: 'I7' | 'I1', h_ms}
    const I = it.integrator; it = { ...it, integrator: I.id === 'I1' && I.h_ms != null ? `I1(${I.h_ms})` : I.id }; out.integrator = it.integrator;
  }
  if (it.integrator) { out.integrator = INTEGRATOR_IDS[it.integrator] || it.integrator; out.outOfSet = OUT_OF_SET.has(out.integrator) || (it.expect && it.expect.inFitterSet === false); }
  const p = out.params;
  if (p.k == null && P.k_over_m != null) p.k = P.k_over_m;
  if (p.c == null && P.c_over_m != null) p.c = P.c_over_m;
  if (p.omega == null && P.omega0 != null) p.omega = P.omega0;
  if (P.native && P.native.kf != null) { p.kf = P.native.kf; p.cf = P.native.cf; }
  if (p.duration == null && P.declared && P.declared.duration_ms != null) p.duration = P.declared.duration_ms;
  if (p.t0 == null && P.visible && P.visible.onset_ms != null) p.t0 = P.visible.onset_ms;
  if (it.sub === 'smil') { if (p.duration == null && P.duration_ms != null) p.duration = P.duration_ms; if (p.t0 == null && P.begin_ms != null) p.t0 = P.begin_ms; }
  if (out.derived.overshoot == null && D.first_segment_overshoot_px != null) { out.derived.overshoot = D.first_segment_overshoot_px; out.derived.A = D.amplitude_ref_px ?? P.amplitude_px ?? out.derived.A; }
  if (out.derived.A == null && D.amplitude != null) out.derived.A = D.amplitude;
  if (typeof it.segment === 'string') out.segment = idxAmongTarget;
  if (out.class === 'scroll-map') out.class = 'scroll map';                 // group C spelling of the A1.6 a label
  if (out.class === 'not_scored') out.scored = false;                       // group D pixel items: measured by the runner (M14 row), not classed
  if (it.sub && it.class === 'declared' && !out.declaredKind) out.declaredKind = it.sub;
  return out;
}

/**
 * Registered rows per route (D-M2-2: G1-4 §8.2 + A1.3). Only these parameter metrics are scored for a route; a truth
 * item may carry more derived numbers (for review), which are not registered and so not gated.
 */
export const ROUTE_METRICS = {
  m01: ['map_s0', 'map_s1'], m02: ['alpha', 'tau', 'settle_tail'], m03: ['alpha', 'tau'], m04: ['alpha', 'tau', 'pin_start', 'pin_end', 'hysteresis_down', 'hysteresis_up'],
  m05: ['duration'], m06: ['onset', 'stagger_step'], m12: ['stagger_step'],
  m07: ['k', 'c'], m07x: ['k', 'c'], m08: ['omega', 'zeta', 'overshoot', 'settle2'], m09: ['tau'], m09b: ['alpha'], m10: ['friction', 'stopping'],
  m11: ['map_s0', 'map_s1'], m13: ['alpha', 'tau'], m15: ['duration', 'onset'], m17: [], m18: ['duration'], m19: ['onset', 'duration'],
  m14: [], m14b: [], m16a: [], m16b: [], m16c: [], m16d: [], m16e: [], m16f: [], m20: [], m21: ['step_response'], m22: ['alpha'],
};
/** Routes whose attribution rows are registered (the "attribution 100 % on the attribution scene" row: M20). */
export const ATTRIBUTION_ROUTES = new Set(['m20']);

/**
 * Score one cell: class, attribution, registered parameter metrics, integrator, law, calibration population and
 * confident-wrong population.
 */
export function scoreCell({ fit, truth, ctx }) {
  const allowed = ctx && ctx.route && ROUTE_METRICS[ctx.route] ? new Set(ROUTE_METRICS[ctx.route]) : null;
  const rows = []; const calib = []; const confusion = [];
  const seen = new Map();
  // numeric segment labels are ranked per target (group A numbers segments from 1, the fitter's records from 0)
  const segRank = new Map();
  for (const x of truth.items || []) if (typeof x.segment === 'number') { const a = segRank.get(x.target) || []; if (!a.includes(x.segment)) a.push(x.segment); segRank.set(x.target, a); }
  for (const a of segRank.values()) a.sort((u, v) => u - v);
  // group D declares negatives at the truth level ({negative: {accept, forbid}}): every item of the cell is a negative
  const neg = truth.negative && typeof truth.negative === 'object' ? truth.negative : null;
  const items = (truth.items || []).map((x) => { const n = seen.get(x.target) || 0; seen.set(x.target, n + 1); let y = typeof x.segment === 'number' ? { ...x, segment: segRank.get(x.target).indexOf(x.segment) } : x;
    if (neg && y.negative == null) y = { ...y, negative: true, acceptClasses: [...(y.acceptClasses || []), ...(neg.accept || [])], forbidClasses: neg.forbid || [] };
    // group A negatives (M16e/M16f): `negativeFor: 'spring'` + `abstainOk` = unknown or the correct simpler class (tween)
    if (y.negativeFor && y.negative == null) y = { ...y, negative: true };
    return normalizeItem(y, n); }).filter((x) => x.scored !== false);
  for (const it of items) {
    const recs = recordsFor(fit, it.target, it.segment, it.channels); const rec = recs[0] || null;
    const r0 = rows.length;
    try {
    const pred = predictedClass(rec); const accept = new Set([it.class, ...(it.acceptClasses || [])]);
    const correct = it.negative ? (pred === 'unknown' || pred === 'none' || accept.has(pred)) : accept.has(pred);
    confusion.push({ target: it.target, truth: it.class, pred, correct, negative: !!it.negative, abstain: pred === 'unknown' });
    if (it.negative) {
      const falseSpringEma = ['spring', 'first-order smoothing', 'asymmetric smoothing'].includes(pred) && !accept.has(pred);
      rows.push({ metric: 'negatives', target: it.target, pass: correct, falseSpringEma });
    }
    if (it.integrator && rec) {
      const I = rec.model.integrator || {}; const identified = !!I.identified;
      const kOk = identified && (it.params.k != null || it.params.kf != null) ? metricRow('k', rec, fit, it, ctx, truth) : null;
      const inSet = identified && (I.set || []).includes(it.integrator);
      const idCorrect = identified && inSet && kOk && kOk.pass && metricRow('c', rec, fit, it, ctx, truth).pass;
      rows.push({ metric: ctx && ctx.route && !['m07', 'm07x'].includes(ctx.route) ? 'integrator_info' : 'integrator', target: it.target, truth: it.integrator, identified, set: I.set, pass: !!idCorrect, wrongConfident: identified && !idCorrect, outOfSet: !!it.outOfSet });
      // M07: curve replay of the identified model, NRMSE_t ≤ 0.005 (registered)
      if (identified && (!ctx || !ctx.route || ['m07', 'm07x'].includes(ctx.route))) rows.push({ metric: 'spring_replay_nrmse', target: it.target, truth: 0, value: rec.fit && rec.fit.nrmse, err: rec.fit && rec.fit.nrmse, tol: 0.005, pass: !!rec.fit && Number.isFinite(rec.fit.nrmse) && rec.fit.nrmse <= 0.005 });
      // the row applies when analytic (ω, ζ) are REPORTED without an identified integrator (G1-4 §8.2 "analytic (omega,
      // zeta) reported alone"); a record that reports no spring parameters at all (unexplained) reports nothing to tag
      const reportsAnalytic = !!(rec.model.params && rec.model.params.omega && rec.model.params.omega.value != null);
      if (!identified && reportsAnalytic && (!ctx || !ctx.route || ['m07', 'm07x'].includes(ctx.route))) rows.push({ metric: 'analytic.valid_for_reproduction_only', target: it.target, pass: rec.model.valid_for_reproduction_only === true && rec.model.params.k.provenance === 'unknown' });
    }
    // A1.6 a: the law sub-label is scored by the two-rate rows and on R5 stall takes, not on a single R6 take
    if (it.law && rec && !(ctx && ctx.regime === 'R6')) rows.push({ metric: 'law', target: it.target, truth: it.law, pred: rec.model.law, pass: rec.model.law === it.law, abstain: rec.model.law === 'unknown' });
    // detection rows (M05 latch, retarget semantics, M17/M18 detection, declared kind): exact match
    if (it.latch != null) rows.push({ metric: 'latch', target: it.target, truth: it.latch, pred: rec ? rec.latch && rec.latch.value : null, pass: !!rec && !!rec.latch && rec.latch.value === it.latch });
    if (it.retarget) { const sem = rec && rec.model.retargets ? rec.model.retargets.map((x) => x.semantics) : []; rows.push({ metric: 'retarget_semantics', target: it.target, truth: it.retarget, pred: sem, pass: sem.length > 0 && sem.every((x) => x === it.retarget) }); }
    if (it.flip != null) rows.push({ metric: 'flip_detected', target: it.target, truth: !!it.flip, pred: !!(rec && rec.flip), pass: !!(rec && rec.flip) === !!it.flip });
    // M11: the declared range read exactly (0 error) — the declared rangeStart/rangeEnd strings against truth
    if (it.params.declared && it.params.declared.range_start != null) { const d = rec && rec.declared; rows.push({ metric: 'declared_range', target: it.target, truth: [it.params.declared.range_start, it.params.declared.range_end], pred: d ? [d.rangeStart, d.rangeEnd] : null, pass: !!d && d.rangeStart === it.params.declared.range_start && d.rangeEnd === it.params.declared.range_end }); }
    // M17: declared timing read exactly (0 error) and old/new group geometry ≤ 2 px (registered A1.3 forms)
    if (it.sub === 'view-transition' && it.params.duration_ms != null) {
      const bz = (e) => (Array.isArray(e) ? `cubic-bezier(${e.join(', ')})` : String(e));
      const pp = rec && rec.model.params; rows.push({ metric: 'vt_timing', target: it.target, truth: [it.params.duration_ms, bz(it.params.easing)], pred: pp ? [pp.duration && pp.duration.value, pp.easing && pp.easing.value] : null, pass: !!pp && pp.duration && pp.duration.value === it.params.duration_ms && pp.easing && pp.easing.value === bz(it.params.easing) });
      const g = rec && rec.model.geometry; const err = (a, b) => (a && b ? Math.max(...['x', 'y', 'w', 'h'].map((q) => Math.abs((a[q] ?? NaN) - b[q]))) : Infinity);
      const e = g ? Math.max(err(g.old, it.params.old), err(g.new, it.params.new)) : Infinity; rows.push({ metric: 'vt_geometry', target: it.target, truth: [it.params.old, it.params.new], pred: g ? [g.old, g.new] : null, err: e, tol: 2, pass: Number.isFinite(e) && e <= 2 });
    }
    for (const r of extraRows(it, rec, { ...ctx, fit })) { rows.push(r); if (r.provenance === 'fitted' && r.err != null) calib.push({ metric: r.metric, target: it.target, covered: r.covered ?? null, error: r.err, tol: r.tol, confidentWrong: r.err > 3 * r.tol && r.covered !== true }); }
    if (it.declaredKind) rows.push({ metric: 'declared_kind', target: it.target, truth: it.declaredKind, pred: rec && rec.declared ? rec.declared.kind : null, pass: !!rec && !!rec.declared && rec.declared.kind === it.declaredKind });
    if (!rec) continue;
    for (const m of it.metrics || Object.keys(METRICS).filter((k) => METRICS[k].scope !== 'cell')) {
      if (m === 'stagger_step') continue;
      if (allowed && !allowed.has(m)) continue;
      if ((m === 'k' || m === 'c') && it.integrator && !(rec.model.integrator && rec.model.integrator.identified)) continue;   // registered: only with the integrator identified
      if (!METRICS[m]) continue;
      // composite (M22): the driver α/τ rows are scored on the driver stage's own channel record
      const recM = (m === 'alpha' || m === 'tau') && it.driver && it.class === 'composite' ? recordsFor(fit, it.driver)[0] || rec : rec;
      const r = metricRow(m, recM, fit, it, ctx, truth); if (!r) continue; rows.push(r);
      if (r.provenance === 'fitted') calib.push({ metric: m, target: it.target, covered: r.covered, error: r.err, tol: r.tol, confidentWrong: r.confidentWrong });
    }
    } finally { if (rec) for (const r of rows.slice(r0)) certifyRow(r, rec, it, ctx, fit); }
  }
  if (truth.attribution) for (const [target, label] of Object.entries(truth.attribution)) {
    const rec = recordsFor(fit, target)[0]; const pred = rec ? rec.attribution && rec.attribution.label : 'static';
    rows.push({ metric: ctx && ctx.route && !ATTRIBUTION_ROUTES.has(ctx.route) ? 'attribution_info' : 'attribution', target, truth: label, pred, pass: pred === label });
  }
  // M06: declared vs visible duration disagreement flagged (and never invented on the no-hold control)
  if (truth.metrics && typeof truth.metrics['m06.declared_vs_visible'] === 'boolean') {
    const want = truth.metrics['m06.declared_vs_visible'];
    for (const it of items.filter((x) => x.class === 'declared')) { const rec = recordsFor(fit, it.target, it.segment, it.channels)[0]; const got = !!(rec && (rec.flags || []).some((f) => f.id === 'visible_onset_after_declared'));
      rows.push({ metric: 'declared_vs_visible', target: it.target, truth: want, pred: rec ? got : null, pass: !!rec && got === want }); }
  }
  if (truth.stagger && (!allowed || allowed.has('stagger_step'))) {
    const st = fit.stagger[0]; const r = metricRow('stagger_step', null, fit, {}, ctx, truth); if (r) rows.push(r);
    // vocabulary: the lab names orders 'dom' / 'dom-index' / 'reverse-dom-index' (+ direction forward|reverse); the
    // fitter names its order keys 'dom', 'reverse-dom', 'x', 'y', 'row-major', … with the equivalent keys alongside
    const norm = (k) => String(k).replace(/-index$/, '');
    const want = new Set([truth.stagger.order, ...(truth.stagger.equivalent || [])].filter(Boolean).map(norm));
    if (!want.size && truth.stagger.direction) want.add(truth.stagger.direction === 'reverse' ? 'reverse-dom' : 'dom');
    const got = st && st.direction.value ? [st.direction.value, ...(st.direction.equivalent || [])].map(norm) : [];
    rows.push({ metric: 'stagger_direction', truth: [...want], pred: got, pass: got.some((k) => want.has(k)), abstain: !!st && st.direction.provenance === 'unknown' });
  }
  // A1.1: R6 gates only the rows that name it (α corrected within 10 % or abstain), class, α and τ; the rest of an R6
  // single take is reported, not gated
  if (ctx && ctx.regime === 'R6') {
    for (const r of rows) {
      if (r.metric === 'alpha' && r.abstain) r.pass = true;                       // "or abstain"
      if (!['alpha', 'tau', 'negatives'].includes(r.metric) && !/_info$/.test(r.metric)) r.metric += '_info';
    }
    return { rows, calib: calib.filter((c) => c.metric === 'alpha' || c.metric === 'tau'), confusion };
  }
  return { rows, calib, confusion };
}

/**
 * Registered rows that compare a recovered SHAPE or a detection with truth (G1-4 §8.2 + A1.3), added after the checker
 * found them unscored: M01 slope (rel ≤ 0.5 %), M02 target-mapping family (RMSE ≤ 0.01 A), M03 asymmetry (snap on
 * rise, 100 %), M05/M19 easing (NRMSE_t ≤ 0.015 of the identified ease), M18 FLIP detected + layout delta ≤ 2 px,
 * M22 transition timing read exactly. Tolerances are the registered values.
 */
function extraRows(it, rec, ctx) {
  const out = []; const route = ctx && ctx.route; const P = it.params || {};
  const curveOf = (r) => { if (!r) return null; if (r.model.ease && NAMED[r.model.ease]) return NAMED[r.model.ease].fn; if (r.model.bezier) return cubicBezier(...r.model.bezier); const f = /^named:(.+)$/.exec(r.model.family || ''); return f && NAMED[f[1]] ? NAMED[f[1]].fn : null; };
  const nrmse = (f, g) => { let s2 = 0; const N = 200; for (let i = 0; i <= N; i++) { const q = i / N; s2 += (f(q) - g(q)) ** 2; } return Math.sqrt(s2 / (N + 1)); };
  if (route === 'm01' && P.slope != null && P.map) {
    const m = rec && rec.model.map; const ok = m && m.shape === 'linear' && !(rec.unknowns || []).some((u) => u.id === 'unk_map_range') && Number.isFinite(m.b) && m.s1_px !== m.s0_px;   // the slope of the ramp is identified from ≥ 2 interior offsets even when a corner is not
    const v = ok ? m.b / (m.s1_px - m.s0_px) : null; const e = v != null ? Math.abs(v - P.slope) / Math.abs(P.slope) : null;
    out.push({ metric: 'slope', target: it.target, truth: P.slope, value: v, err: e, tol: 0.005, pass: e != null && e <= 0.005 && rec.class === 'scroll map', abstain: v == null });
  }
  if (route === 'm02' && P.map && P.map.shape && P.map.s0 != null) {
    const m = rec && rec.model.map; const S = m && MAP_SHAPES[m.shape]; const T = MAP_SHAPES[P.map.shape];
    let e = null;
    if (S && T && [m.a, m.b, m.s0_px, m.s1_px].every(Number.isFinite)) { const lo = Math.min(P.map.s0, P.map.s1), hi = Math.max(P.map.s0, P.map.s1); const A = Math.abs(P.map.b) || 1; let s2 = 0, mx = 0; const N = 200;
      const at = (sh, a, b, s0, s1, x) => a + b * sh(Math.min(1, Math.max(0, (x - s0) / ((s1 - s0) || 1e-9))));
      for (let i = 0; i <= N; i++) { const x = lo + ((hi - lo) * i) / N; const d = Math.abs(at(S, m.a, m.b, m.s0_px, m.s1_px, x) - at(T, P.map.a, P.map.b, P.map.s0, P.map.s1, x)) / A; s2 += d * d; mx = Math.max(mx, d); }
      e = Math.sqrt(s2 / (N + 1)); out.push({ metric: 'map_family', target: it.target, truth: P.map.shape, pred: m.shape, value: e, maxErr: mx, tol: 0.01, pass: e <= 0.01 && mx <= 0.03 }); }
    else out.push({ metric: 'map_family', target: it.target, truth: P.map.shape, pred: m ? m.shape : null, pass: false, abstain: true });
  }
  if (route === 'm03' && it.class === 'asymmetric smoothing' && P.alpha_up != null) {
    const a = rec && rec.smoothing && rec.smoothing.asymmetric; const want = P.alpha_up >= 0.999;
    out.push({ metric: 'asymmetry', target: it.target, truth: want ? 'snap on rise' : 'eased both', pred: a ? (a.snap_on_rise ? 'snap on rise' : 'eased both') : null, pass: !!a && a.snap_on_rise === want });
  }
  if ((route === 'm05' || route === 'm19') && (it.ease || P.ease) && it.class === 'tween') {
    const name = it.ease || P.ease; const T = NAMED[name] && NAMED[name].fn; const F = curveOf(rec);
    const e = T && F ? nrmse(F, T) : null; out.push({ metric: 'easing', target: it.target, truth: name, pred: rec ? rec.model.ease || rec.model.family : null, value: e, tol: 0.015, pass: e != null && e <= 0.015, abstain: e == null });
  }
  if (route === 'm18' && it.sub === 'flip' && P.layout_delta) {
    const ch = (it.target.split('|')[1] || ''); const want = /tx$/.test(ch) ? P.layout_delta.dx : /ty$/.test(ch) ? P.layout_delta.dy : null;
    out.push({ metric: 'flip_detected', target: it.target, truth: true, pred: !!(rec && rec.flip), pass: !!(rec && rec.flip) });
    // truth names the FLIP inversion (the transform's start value: First − Last, or from the current visual position when a
    // FLIP interrupts a running one); the record carries both the layout move (Last − First) and the measured inversion
    if (want != null) { const fl = rec && rec.flips && P.start_ms != null ? [...rec.flips].sort((a, b) => Math.abs(a.T - P.start_ms) - Math.abs(b.T - P.start_ms))[0] : rec && rec.flip; const v = fl ? (fl.inversion ?? -fl.layoutDelta) : null; const e = v != null ? Math.abs(v - want) : null; out.push({ metric: 'layout_delta', target: it.target, truth: want, value: v, err: e, tol: 2, pass: e != null && e <= 2 }); }
  }
  // M04 pin range start/end (≤ 2 px or 0.5 % of the range) on the pinned element's box channel
  if (route === 'm04' && P.pin && P.pin.start_px != null && ctx.fit) {
    const sel = (it.target || '').split('|')[0]; const pin = (ctx.fit.pins || []).find((q) => selectorMatches(sel, q.desc)); const tol = Math.max(2, 0.005 * Math.abs(P.pin.end_px - P.pin.start_px));
    for (const [k, t] of [['start', P.pin.start_px], ['end', P.pin.end_px]]) { const q = pin && pin[k]; const v = q && q.provenance !== 'unknown' ? q.value : null; const e = v != null ? Math.abs(v - t) : null;
      out.push({ metric: `pin_${k}`, target: it.target, truth: t, value: v, err: e, tol, pass: e != null && e <= tol, abstain: v == null, provenance: v != null ? 'fitted' : 'unknown', ci95: q && q.ci95, interval: q && q.interval, covered: q && q.ci95 && v != null ? q.ci95[0] <= t && t <= q.ci95[1] : null }); }
  }
  // M04 hysteresis band edges (≤ 0.05 index units): truth `up` edges switch i → i+1 while scrolling down the page
  if (route === 'm04' && P.edges_px && P.unit_px && rec && rec.hysteresis) {
    const unit = P.unit_px.value ?? P.unit_px; const tol = 0.05 * unit;
    for (const b of rec.hysteresis.bands) { const i = Math.min(...b.between); if (!Number.isInteger(i) || Math.abs(b.between[1] - b.between[0]) !== 1) continue;   // a jump over several indices brackets each crossed edge only loosely: scored per adjacent band
      for (const [dir, list, iv] of [['up', P.edges_px.up, b.downEdge_interval], ['down', P.edges_px.down, b.upEdge_interval]]) { const t = list && list[i]; if (t == null) continue;
        const ivf = ivOf(iv); const v = ivf && Number.isFinite(ivf[0]) && Number.isFinite(ivf[1]) && ivf[1] - ivf[0] <= 2 * tol ? (ivf[0] + ivf[1]) / 2 : null; const e = v != null ? Math.abs(v - t) : null;
        out.push({ metric: `hysteresis_${dir}`, target: it.target, band: b.between, truth: t, value: v, interval: iv, err: e, tol, pass: e != null && e <= tol, abstain: v == null, provenance: v != null ? 'fitted' : 'unknown', covered: ivf && v != null ? ivf[0] <= t && t <= ivf[1] : null, edges: P.edges_px, edgeIndex: i, edgeDir: dir }); } }
  }
  if (route === 'm22' && it.class === 'composite' && P.duration_ms != null) {
    const pp = rec && rec.model.params; const d = pp && pp.duration ? pp.duration.value : null; const ez = pp && pp.easing ? String(pp.easing.value) : null;
    const want = Array.isArray(P.easing) ? `cubic-bezier(${P.easing.join(', ')})` : String(P.easing);
    out.push({ metric: 'transition_timing', target: it.target, truth: [P.duration_ms, want], pred: [d, ez], pass: d === P.duration_ms && ez === want });
  }
  return out;
}

function metricRow(m, rec, fit, it, ctx, truth) {
  const M = METRICS[m]; const t = M.truth(it, truth); if (t == null || !Number.isFinite(t)) return null;
  const g = M.get(rec, fit, it) || {}; const tol = M.tol(ctx, it);
  if (g.value == null || g.provenance === 'unknown') return { metric: m, target: it.target, truth: t, value: null, provenance: 'unknown', pass: false, abstain: true, tol };
  const err = M.err(g.value, t, ctx, it); const ci = g.ci95; const covered = Array.isArray(ci) && ci.every(Number.isFinite) ? ci[0] <= t && t <= ci[1] : null;
  // §8.1: confident-wrong = `fitted`, claimed uncertainty smaller than the true error, true error > 3× tolerance (a value
  // without an interval claims no uncertainty at all)
  return { metric: m, target: it.target, truth: t, value: g.value, provenance: g.provenance || 'fitted', err, tol, pass: err <= tol, covered, confidentWrong: (g.provenance || 'fitted') === 'fitted' && err > 3 * tol && covered !== true, unit: M.unit };
}

// ---- Amendment 2 B (owner-approved 2026-10-15): scorer-certified abstentions ------------------------------------------
// An abstention with an interval counts as correct-not-confident only when (1) the truth is inside the interval and
// (2) the SCORER certifies from truth that the replays at the interval ends, and at points spaced no more than one
// tolerance apart inside it, agree with the truth replay within σ_floor on every sampled offset of the take set. An
// uncertified abstention stays a miss; a certified one is never confident-wrong (it is not a `fitted` value). Set-valued
// abstentions (class / law / integrator sets) are not certified here: they stay misses (stricter than A2-B allows).
// Rows the B rule never applies to on their designed trace (A2-B "no row can pass on abstentions alone"): see
// DESIGNED_TRACE and the report.
export const CERTIFIABLE = new Set(['map_s0', 'map_s1', 'slope', 'hysteresis_up', 'hysteresis_down', 'pin_end']);
/** The trace variant design §8 assigns to measure a row (A2-B): there every item must pass on the registered tolerance. */
export const DESIGNED_TRACE = { m01: { map_s0: 'speed', map_s1: 'speed', slope: 'speed' }, m02: { map_family: 'speed' },
  m04: { hysteresis_up: 'speed', hysteresis_down: 'speed', pin_start: 'speed', pin_end: 'speed' }, m11: { map_s0: 'sweep', map_s1: 'sweep' } };
const ivOf = (iv) => (Array.isArray(iv) && iv.length === 2 ? [iv[0] ?? -Infinity, iv[1] ?? Infinity] : null);

function certifyRow(r, rec, it, ctx, fit) {
  if (!r.abstain || r.pass || !CERTIFIABLE.has(r.metric) || !ctx || !Array.isArray(ctx.visited) || !ctx.visited.length) return;
  let ok = false, why = null;
  try {
    if (r.metric === 'hysteresis_up' || r.metric === 'hysteresis_down') {
      // replay the truth index state machine (switch up when the offset reaches up[i], down when it reaches down[i]) on
      // every frame's offset of the take set, with this edge moved to each checked value: the index sequence must not change
      const iv = ivOf(r.interval); const E = r.edges;
      if (!iv) why = 'no interval';
      else if (!(iv[0] <= r.truth && r.truth <= iv[1])) why = 'truth outside the interval';
      else if (!E || !Array.isArray(E.up) || !Array.isArray(ctx.visitedSeq)) why = 'no truth edges / frame sequence';
      else {
        const n = E.up.length + 1; const run = (up, down) => ctx.visitedSeq.map((seq) => { let i = 0; return seq.map((x) => { while (i < n - 1 && x >= up[i]) i++; while (i > 0 && x <= down[i - 1]) i--; return i; }).join(','); }).join('|');
        const ref = run(E.up, E.down); const all = ctx.visitedSeq.flat(); const span = Math.max(...all) - Math.min(...all) || 1;
        const lo = Number.isFinite(iv[0]) ? iv[0] : iv[1] - 4 * span, hi = Number.isFinite(iv[1]) ? iv[1] : iv[0] + 4 * span;
        const N = Math.max(1, Math.ceil((hi - lo) / r.tol)); ok = true;
        for (let k = 0; k <= N && ok; k++) { const v = lo + ((hi - lo) * k) / N; const up = [...E.up], down = [...E.down]; (r.edgeDir === 'up' ? up : down)[r.edgeIndex] = v; if (run(up, down) !== ref) { ok = false; why = `the index sequence changes with the edge at ${v.toFixed(3)} px`; } }
        if (ok) why = `${N + 1} edge values replayed, index sequence unchanged`;
      }
    } else if (r.metric === 'pin_end') {
      // the output depends on the threshold only through which sampled offsets lie on either side of it
      const iv = ivOf(r.interval); if (!iv) why = 'no interval';
      else if (!(iv[0] <= r.truth && r.truth <= iv[1])) why = 'truth outside the interval';
      else if (ctx.visited.some((x) => x > iv[0] && x < iv[1])) why = 'a sampled offset lies inside the interval';
      else ok = true;
    } else {
      const m = rec.model && rec.model.map; const P = it.params || {}; const tm = P.map;
      const iv = ivOf(m && (r.metric === 'map_s0' ? m.s0_interval : r.metric === 'map_s1' ? m.s1_interval : m.slope_interval));
      if (!iv) why = 'no interval';
      else if (!tm || tm.s0 == null || tm.s1 == null) why = 'no truth map';
      else { const sigma = (rec.fit && rec.fit.sigma_floor) || 1e-9 * Math.abs(tm.b || 1); const res = certifyMap(tm, r.metric, iv, ctx.visited, sigma, r.metric === 'slope' ? Math.abs(r.truth) * 0.005 : 2, r.truth); ok = res.ok; why = res.why; }
    }
  } catch (e) { ok = false; why = 'certificate error: ' + String(e && e.message || e).slice(0, 120); }
  r.certificate = { ok, why };
  if (ok) { r.pass = true; r.certified = true;
    // judgement D-M2-12: a map start whose whole interval lies at or below the scroll minimum (0) cannot be observed
    // by ANY trace (no offset below 0 exists): flagged so the report can tell it from an abstention a better trace
    // would resolve (lab case M01 o = 0)
    if (r.metric === 'map_s0') { const m = rec.model && rec.model.map; const iv = ivOf(m && m.s0_interval); if (iv && iv[1] <= 0) r.unobservableAnywhere = true; } }
}

const shapeFnOf = (shape) => (typeof shape === 'string' ? MAP_SHAPES[shape] : shape && Array.isArray(shape.bezier) ? cubicBezier(...shape.bezier) : null);
const clamp01 = (u) => Math.max(0, Math.min(1, u));
/**
 * Profile certificate for a map parameter (corner s0, s1, or the slope of a linear map): for every checked value v, the
 * best map with that value (other corner / offset free, a and b by least squares) reproduces the truth map at every
 * sampled offset within σ.
 */
export function certifyMap(tm, metric, iv, X0, sigma, tol, truthVal) {
  const S = shapeFnOf(tm.shape); if (!S) return { ok: false, why: 'unknown truth shape' };
  const X = [...new Set(X0.filter(Number.isFinite))].sort((p, q) => p - q);
  const at = (a, b, s0, s1, x) => a + b * S(clamp01((x - s0) / (s1 - s0 || 1e-12)));
  const yT = X.map((x) => at(tm.a, tm.b, tm.s0, tm.s1, x));
  const span = Math.abs(tm.s1 - tm.s0) || 1; const xmin = X[0], xmax = X.at(-1);
  if (!(iv[0] <= truthVal && truthVal <= iv[1])) return { ok: false, why: 'truth outside the interval' };
  // max residual after a, b by least squares for given corners
  const resAB = (s0, s1) => { const u = X.map((x) => S(clamp01((x - s0) / (s1 - s0 || 1e-12)))); const n = X.length; let su = 0, suu = 0, sy = 0, suy = 0;
    for (let i = 0; i < n; i++) { su += u[i]; suu += u[i] * u[i]; sy += yT[i]; suy += u[i] * yT[i]; } const d = n * suu - su * su;
    let a, b; if (Math.abs(d) < 1e-18) { a = sy / n; b = 0; } else { b = (n * suy - su * sy) / d; a = (sy - b * su) / n; }
    let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(a + b * u[i] - yT[i])); return mx; };
  const min1 = (f, lo, hi) => { const N = 400; let bi = 0, bv = Infinity; const xs = []; for (let i = 0; i <= N; i++) { const x = lo + ((hi - lo) * i) / N; xs.push(x); const v = f(x); if (v < bv) { bv = v; bi = i; } }
    let a = xs[Math.max(0, bi - 1)], b = xs[Math.min(N, bi + 1)]; const g = (Math.sqrt(5) - 1) / 2;
    for (let k = 0; k < 90 && b - a > 1e-12 * (1 + Math.abs(a)); k++) { const c = b - g * (b - a), d = a + g * (b - a); if (f(c) <= f(d)) b = d; else a = c; }
    return Math.min(bv, f((a + b) / 2)); };
  let prof;
  if (metric === 'map_s0') prof = (v) => min1((s1) => resAB(v, s1), v + 1e-6, Math.max(v + 1e-3, xmax + 2 * span));
  else if (metric === 'map_s1') prof = (v) => min1((s0) => resAB(s0, v), Math.min(v - 1e-3, xmin - 2 * span), v - 1e-6);
  else {   // slope u of a linear map: y = a + u·clamp(x − s0, 0, W), a by least squares, (s0, W) searched
    if (tm.shape !== 'linear') return { ok: false, why: 'slope certificate needs a linear truth map' };
    const resU = (u, s0, W) => { const v = X.map((x) => u * Math.max(0, Math.min(W, x - s0))); let a = 0; for (let i = 0; i < X.length; i++) a += yT[i] - v[i]; a /= X.length; let mx = 0; for (let i = 0; i < X.length; i++) mx = Math.max(mx, Math.abs(a + v[i] - yT[i])); return mx; };
    prof = (u) => min1((s0) => min1((W) => resU(u, s0, W), 1e-6, 2 * (xmax - xmin) + 2 * span), xmin - 2 * span, xmax);
  }
  // checked values: both ends (infinite ends truncated 4 ranges beyond the finite one) and steps ≤ tol inside
  let lo = iv[0], hi = iv[1];
  if (metric === 'slope') { const t = Math.abs(truthVal); if (!Number.isFinite(lo)) lo = -10 * t; if (!Number.isFinite(hi)) hi = 10 * t; }
  else { if (!Number.isFinite(lo)) lo = hi - 4 * span; if (!Number.isFinite(hi)) hi = lo + 4 * span; }
  if (!(Number.isFinite(lo) && Number.isFinite(hi))) return { ok: false, why: 'unbounded interval' };
  const n = Math.max(1, Math.ceil((hi - lo) / tol)); const vals = []; for (let i = 0; i <= n; i++) vals.push(lo + ((hi - lo) * i) / n);
  for (const v of vals) { const e = prof(v); if (!(e <= sigma)) return { ok: false, why: `replay at ${v.toPrecision(6)} differs by ${e.toExponential(2)} > σ ${sigma.toExponential(2)}` }; }
  return { ok: true, why: `${vals.length} values checked, max |Δ| ≤ σ ${sigma.toExponential(2)}` };
}
