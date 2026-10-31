// Numeric motion-diff scorer (PLAN M3; SYN §5.5; S3 §10). Source and rebuild are recorded by the same recorder, lane
// and rate; this module compares their RENDERED values only.
//   arm 1 "sweep"    : dense scrollY sweep, settled value per landing, compared at the same scrollY (ranges, map shape)
//   arm 2 "response" : native-rate step responses with exact input replay, every time measured from the input
//   lag              : its own channel (input -> onset), never aligned away
// Two layers per cue: layer 1 "is it real?" (|Δ| vs the measured self-band), layer 2 "would you notice?" in provisional
// model-observer JND units (thresholds.js). Cues pool with a Minkowski exponent of 3 (probability summation; SYN §5.5):
//   E = (Σ e_i^3)^(1/3),  score S = exp(-E^3)  = probability of NOT noticing under a Weibull (β = 3) observer.
// Cross-rate / cross-lane / cross-viewport comparisons are refused (S3 §9 rules). No DTW, no Fréchet, no VLM.
import { extractSeries, eventsOf, readbackOf, parseChannelKey } from './series.js';
import { responseCues, alignedDiff, sweepProfile, sweepCues, nrmseT } from './cues.js';
import { unitFor, PROVISIONAL } from './thresholds.js';

export const SCORE_SCHEMA = 'reva.score/0';
export const MINKOWSKI_BETA = 3;
const RESPONSE_L2 = ['lag', 't50', 't90', 'peakVel', 'amplitude'];
const RESPONSE_L1 = ['t10', 't99', 'overshoot', 'crossings'];
const SWEEP_L2 = ['rangeShiftVh', 'mapShape', 'amplitude'];
const SWEEP_L1 = ['maxAbs', 'rms'];

// ------------------------------------------------------------------ refusal (S3 §9: "comparisons across refresh rates are refused")
/** Environment check. Different lane, frame period, refresh, viewport, DPR or reduced-motion => refused. */
export function compareEnv(src, reb) {
  const refused = [], warnings = [];
  const a = src.meta, b = reb.meta;
  const R = (field, why) => refused.push({ field, src: a[field], reb: b[field], why });
  if (a.lane !== b.lane) R('lane', 'hx (virtual) and rt (real) takes differ by a systematic one-frame offset (S3 §9); record both sides in one lane');
  if (a.lane === 'hx' && b.lane === 'hx' && (a.dtMs == null || b.dtMs == null || Math.abs(a.dtMs - b.dtMs) > 1e-9)) R('dtMs', 'different virtual frame period: cross-rate comparison refused (per-frame motion moves 10-50x the floor across rates)');
  if (a.lane === 'rt' && b.lane === 'rt') {
    if (!(a.refreshHz > 0 && b.refreshHz > 0)) R('refreshHz', 'real refresh rate not measured on one side');
    else if (Math.abs(a.refreshHz / b.refreshHz - 1) > 0.05) R('refreshHz', 'different real refresh rate: cross-rate comparison refused');
  }
  if (!a.viewport || !b.viewport || a.viewport.width !== b.viewport.width || a.viewport.height !== b.viewport.height) R('viewport', 'different viewport: ranges in vh and layout differ');
  if (a.dpr !== b.dpr) R('dpr', 'different device pixel ratio');
  if (a.reducedMotion !== b.reducedMotion) R('reducedMotion', 'different prefers-reduced-motion: a different page');
  if (a.engine !== b.engine) warnings.push({ field: 'engine', src: a.engine, reb: b.engine });
  if (a.toolkit !== b.toolkit) warnings.push({ field: 'toolkit', src: a.toolkit, reb: b.toolkit });
  return { ok: refused.length === 0, refused, warnings };
}

/** Exact input replay check for arm 2: same inputs in the same order; times may differ by less than one frame. */
export function compareEvents(se, re, frameMs) {
  if (se.length !== re.length) return { ok: false, why: `input count differs (${se.length} vs ${re.length})` };
  let phase = 0;
  for (let i = 0; i < se.length; i++) {
    const a = se[i], b = re[i];
    if (a.kind !== b.kind) return { ok: false, why: `input ${i}: kind ${a.kind} vs ${b.kind}` };
    if (a.value !== b.value && !(typeof a.value === 'number' && typeof b.value === 'number' && Math.abs(a.value - b.value) <= 0.5)) return { ok: false, why: `input ${i}: value ${a.value} vs ${b.value}` };
    const d = Math.abs(a.T - b.T); phase = Math.max(phase, d);
    if (!(d < frameMs - 1e-9)) return { ok: false, why: `input ${i}: time ${a.T} vs ${b.T} (>= one frame apart: not the same schedule)` };
  }
  return { ok: true, maxPhaseMs: phase };
}

// ------------------------------------------------------------------ helpers
const range = (v) => { let lo = Infinity, hi = -Infinity; for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; } return v.length ? hi - lo : 0; };
const pairOf = (p) => typeof p === 'string' ? { src: p, reb: p } : { src: p.src, reb: p.reb || p.src };
const bandKey = (...a) => a.join('|');

/** One cue difference with both layers. `unit` from thresholds.js (null = layer-1-only cue). */
function cueDiff({ cue, s, r, delta, band, eps, unit }) {
  const d = { cue, src: s, reb: r, delta, band: band ?? null, eps };
  if (delta == null || !Number.isFinite(delta)) { d.layer1 = 'unknown'; d.reason = 'cue not measurable on one side (unsettled, too few samples, or no crossing)'; return d; }
  const b = (band ?? 0) + eps;
  d.layer1 = Math.abs(delta) <= b ? 'identical' : 'different';
  d.bandRatio = b > 0 ? Math.abs(delta) / b : (delta === 0 ? 0 : Infinity);
  if (unit) {
    d.unit = { jnd: unit.jnd, pass: unit.pass, fail: unit.fail, source: unit.source };
    d.e = Math.abs(delta) / unit.jnd;
    if (d.layer1 === 'identical') d.layer2 = 'pass';
    else if (Math.abs(delta) < unit.pass) d.layer2 = 'pass';
    else if (unit.fail != null && Math.abs(delta) > unit.fail) d.layer2 = 'fail';
    else d.layer2 = 'needs-owner';
  }
  return d;
}

// ------------------------------------------------------------------ arm 2
function scoreResponsePair(src, reb, pair, ctx) {
  const P = pairOf(pair);
  let S, R;
  try { S = extractSeries(src, P.src); } catch (e) { return { pair: P, unscorable: `source: ${e.message}` }; }
  try { R = extractSeries(reb, P.reb); } catch (e) { return { pair: P, unscorable: `rebuild: ${e.message}` }; }
  const ch = parseChannelKey(P.src).channel;
  const A = range(S.v);
  const quant = readbackOf(src, ch);
  const bar = Math.max(3 * quant, 1e-3 * A, 1e-9);
  const out = { pair: P, channel: ch, A, bar, events: [] };
  const evs = ctx.events;
  const tEndS = S.T.length ? S.T[S.T.length - 1] + 1 : Infinity, tEndR = R.T.length ? R.T[R.T.length - 1] + 1 : Infinity;
  for (let i = 0; i < evs.src.length; i++) {
    const es = evs.src[i], er = evs.reb[i];
    const ns = i + 1 < evs.src.length ? evs.src[i + 1].T : tEndS, nr = i + 1 < evs.reb.length ? evs.reb[i + 1].T : tEndR;
    const cs = responseCues(S.T, S.v, es.T, ns, { bar });
    const cr = responseCues(R.T, R.v, er.T, nr, { bar });
    const ev = { i, kind: es.kind, value: es.value, Te: es.T, src: strip(cs), reb: strip(cr), diffs: [] };
    if (cs.insufficient || cr.insufficient) { ev.unscorable = 'fewer than 2 samples in the window'; out.events.push(ev); continue; }
    const k = (cue) => bandKey(ctx.mech, ctx.pairIndex, 'response', i, cue);
    const valEps = Math.max(quant, 1e-12) / Math.max(A, 1e-12);
    const add = (cue, s, r, delta, eps, unitCtx) => ev.diffs.push(cueDiff({ cue, s, r, delta, band: ctx.band && ctx.band[k(cue)], eps, unit: unitCtx ? unitFor(cue, unitCtx) : null }));
    if (cs.static && cr.static) { ev.static = true; out.events.push(ev); continue; }
    if (cs.static !== cr.static) {
      // all motion removed (or spurious motion added) in this window: the amplitude cue carries it
      const mag = cs.static ? Math.abs(cr.maxDev) : Math.abs(cs.delta);
      add('amplitude', cs.static ? 0 : cs.delta / (A || 1), cr.static ? 0 : (cr.delta ?? cr.maxDev) / (A || 1), mag / (A || mag || 1), valEps, { kind: es.kind });
      ev.missingMotion = cs.static ? 'rebuild moves where the source is still' : 'rebuild is still where the source moves';
      out.events.push(ev); continue;
    }
    const tEps = 1e-6;
    add('lag', cs.lag, cr.lag, nz(cr.lag, cs.lag), tEps, { kind: es.kind, srcValue: cs.lag });
    add('t50', cs.t50, cr.t50, nz(cr.t50, cs.t50), tEps, { srcValue: cs.t50 });
    add('t90', cs.t90, cr.t90, nz(cr.t90, cs.t90), tEps, { srcValue: cs.t90 });
    if (cs.instant && cr.instant) ev.diffs.push({ cue: 'peakVel', src: null, reb: null, delta: 0, band: ctx.band ? (ctx.band[k('peakVel')] ?? null) : null, layer1: 'identical', layer2: 'pass', e: 0, na: 'both complete within one frame (instant step): no velocity to compare' });
    else if (cs.instant || cr.instant) add('peakVel', cs.peakVel, cr.peakVel, cs.instant ? 1 : -1, 1e-9, {});   // instant vs animated: a 100 % velocity difference
    else add('peakVel', cs.peakVel, cr.peakVel, cs.peakVel ? nz(cr.peakVel, cs.peakVel) / cs.peakVel : null, 1e-9, {});
    add('amplitude', cs.delta / (A || 1), cr.delta / (A || 1), (cr.delta - cs.delta) / (A || 1), valEps, {});
    add('t10', cs.t10, cr.t10, nz(cr.t10, cs.t10), tEps, null);
    add('t99', cs.t99, cr.t99, nz(cr.t99, cs.t99), tEps, null);
    add('overshoot', cs.overshoot, cr.overshoot, cr.overshoot - cs.overshoot, valEps, null);
    add('crossings', cs.crossings, cr.crossings, cr.crossings - cs.crossings, 0, null);
    const ad = alignedDiff(S, R, es.T, Math.min(ns, nr), Math.abs(cs.delta) || A);
    add('maxAbs', null, null, ad.maxAbs, valEps, null);
    ev.aligned = ad;
    out.events.push(ev);
  }
  out.nrmse = nrmseT(S, R, A);
  return out;
}

const nz = (a, b) => (a == null || b == null ? null : a - b);
const strip = (c) => { if (!c) return c; const { curve, ...rest } = c; return rest; };

// ------------------------------------------------------------------ arm 1
function landingsOf(input) {
  return input.inputLog.filter(e => e.type === 'scrollTo' && e.T != null).map(e => ({ T: e.T, y: e.got }));
}

function scoreSweepPair(src, reb, pair, ctx) {
  const P = pairOf(pair);
  let S, R;
  try { S = extractSeries(src, P.src); } catch (e) { return { pair: P, unscorable: `source: ${e.message}` }; }
  try { R = extractSeries(reb, P.reb); } catch (e) { return { pair: P, unscorable: `rebuild: ${e.message}` }; }
  const ch = parseChannelKey(P.src).channel;
  const ls = landingsOf(src), lr = landingsOf(reb);
  const sp = sweepProfile(S, ls), rp = sweepProfile(R, lr);
  const vh = src.meta.viewport ? src.meta.viewport.height : 800;
  const quant = readbackOf(src, ch);
  const Afull = range(S.v);
  const bar = Math.max(3 * quant, 1e-3 * Afull, 1e-9);
  const c = sweepCues(sp, rp, { vh, maxShiftPx: Math.round(0.25 * vh), bar });
  const out = { pair: P, channel: ch, landings: { src: ls.length, reb: lr.length }, unsettled: { src: sp.unsettled, reb: rp.unsettled }, cues: c, diffs: [] };
  const k = (cue) => bandKey(ctx.mech, ctx.pairIndex, 'sweep', 0, cue);
  const valEps = Math.max(quant, 1e-12) / Math.max(c.A || 0, 1e-12);
  const add = (cue, delta, eps, withUnit) => out.diffs.push(cueDiff({ cue, s: null, r: null, delta, band: ctx.band && ctx.band[k(cue)], eps, unit: withUnit ? unitFor(cue, {}) : null }));
  if (c.static) {
    if (c.rebRange > bar) add('amplitude', 1, valEps, true); // the source map is flat here and the rebuild moves
    else out.static = true;
    return out;
  }
  add('rangeShiftVh', c.shiftVh, 1 / vh / 2, true);   // the search resolution is 1 px
  add('mapShape', c.residualMax, valEps, true);
  add('maxAbs', c.maxAbs, valEps, false);
  add('rms', c.rms, valEps, false);
  if (sp.unsettled || rp.unsettled) out.note = 'some landings were still moving at their last sample: arm 1 then includes smoothing; prefer settled holds';
  return out;
}

// ------------------------------------------------------------------ pooling and verdicts
export function pool(diffs) {
  const es = diffs.filter(d => d.e != null && Number.isFinite(d.e)).map(d => d.e);
  const E = Math.pow(es.reduce((s, e) => s + Math.pow(e, MINKOWSKI_BETA), 0), 1 / MINKOWSKI_BETA);
  return { E, score: Math.exp(-Math.pow(E, MINKOWSKI_BETA)), n: es.length };
}

function verdicts(diffs, unscorable) {
  const l1 = diffs.some(d => d.layer1 === 'different') || unscorable ? 'different' : diffs.some(d => d.layer1 === 'unknown') ? 'unknown' : 'identical';
  const l2s = diffs.filter(d => d.layer2).map(d => d.layer2);
  let l2 = 'pass';
  if (unscorable || l2s.includes('fail')) l2 = 'fail';
  else if (l2s.includes('needs-owner')) l2 = 'needs-owner';
  else if (diffs.some(d => d.layer1 === 'unknown' && RESPONSE_L2.concat(SWEEP_L2).includes(d.cue))) l2 = 'needs-owner';
  return { layer1: l1, layer2: l2, layer2Provisional: true };
}

/**
 * Score one source/rebuild pair of take sets.
 * @param {object} a  {src: {response?, sweep?}, reb: {response?, sweep?}} score inputs (series.js)
 * @param {object} spec {mechanisms: [{id, pairs: [key | {src, reb}], arms?: ['response','sweep']}]}
 * @param {object} [o] {band: {key: value}, floors: {mechId: {mean, sd, n}}, events: {src?: [], reb?: []}}
 */
export function scoreTakeSets(a, spec, o = {}) {
  const rec = { schema: SCORE_SCHEMA, created: new Date().toISOString(), provisional: PROVISIONAL, pooling: { beta: MINKOWSKI_BETA, score: 'exp(-E^3), E = Minkowski-3 over strict-observer JND units' },
    inputs: {}, refused: [], arms: {}, mechanisms: [],
    rules: ['rendered values only', 'no DTW / Frechet anywhere; no VLM in the number', 'lag reported in its own channel, never aligned away', 'self-band printed next to every number'],
    unknowns: [
      { id: 'unk_choreography', reason: 'stagger step / order needs per-element onsets grouped by the fitter', probe: 'score M2 motion records (stagger) of both sides' },
      { id: 'unk_interruption_class', reason: 'interruption class (carry/restart/snap) needs fitted retarget semantics', probe: 'compare M2 retarget semantics of both sides' },
      { id: 'unk_alpha_lambda', reason: 'alpha/lambda at a declared refresh are fitted parameters, not rendered cues', probe: 'compare M2 smoothing records at the same refresh' },
    ] };
  const armsWanted = new Set(spec.mechanisms.flatMap(m => m.arms || ['response', 'sweep']));
  const ctxArms = {};
  for (const arm of ['response', 'sweep']) {
    const s = a.src[arm], r = a.reb[arm];
    if (!armsWanted.has(arm)) continue;
    if (!s || !r) { rec.arms[arm] = { skipped: !s && !r ? 'no takes for this arm' : `missing ${!s ? 'source' : 'rebuild'} take` }; continue; }
    rec.inputs[arm] = { src: { id: s.id, digest: s.digest, lane: s.meta.lane, rate: s.meta.rate }, reb: { id: r.id, digest: r.digest, lane: r.meta.lane, rate: r.meta.rate } };
    const env = compareEnv(s, r);
    if (!env.ok) { rec.refused.push({ arm, reasons: env.refused }); rec.arms[arm] = { refused: env.refused }; continue; }
    const arm0 = { warnings: env.warnings };
    if (arm === 'response') {
      const se = o.events && o.events.src ? { events: o.events.src, untimed: [] } : eventsOf(s);
      const re = o.events && o.events.reb ? { events: o.events.reb, untimed: [] } : eventsOf(r);
      if (se.untimed.length || re.untimed.length) { const why = { field: 'inputLog', why: `inputs without a frame time (${se.untimed.length + re.untimed.length}): cannot align on input` }; rec.refused.push({ arm, reasons: [why] }); rec.arms[arm] = { refused: [why] }; continue; }
      const frameMs = s.meta.dtMs || (s.meta.refreshHz ? 1000 / s.meta.refreshHz : 16.7);
      const cmp = compareEvents(se.events, re.events, frameMs);
      if (!cmp.ok) { const why = { field: 'inputs', why: `exact input replay failed: ${cmp.why}` }; rec.refused.push({ arm, reasons: [why] }); rec.arms[arm] = { refused: [why] }; continue; }
      arm0.inputs = { n: se.events.length, maxPhaseMs: cmp.maxPhaseMs };
      ctxArms.response = { s, r, events: { src: se.events, reb: re.events } };
    } else ctxArms.sweep = { s, r };
    rec.arms[arm] = arm0;
  }
  for (const m of spec.mechanisms) {
    const out = { id: m.id, pairs: [] };
    const arms = m.arms || ['response', 'sweep'];
    const diffs = []; let unscorable = null;
    m.pairs.forEach((p, pi) => {
      const row = { pair: pairOf(p) };
      for (const arm of arms) {
        const c = ctxArms[arm]; if (!c) continue;
        const ctx = { mech: m.id, pairIndex: pi, band: o.band, events: c.events };
        const res = arm === 'response' ? scoreResponsePair(c.s, c.r, p, ctx) : scoreSweepPair(c.s, c.r, p, ctx);
        row[arm] = res;
        if (res.unscorable) unscorable = unscorable || res.unscorable;
        if (arm === 'response') for (const ev of res.events || []) diffs.push(...ev.diffs.map(d => ({ ...d, where: `${arm}#${ev.i}` })));
        else diffs.push(...(res.diffs || []).map(d => ({ ...d, where: arm })));
      }
      out.pairs.push(row);
    });
    const covered = arms.filter(x => ctxArms[x]);
    if (!covered.length) { out.refused = 'no comparable arm (see refused)'; rec.mechanisms.push(out); continue; }
    out.arms = covered;
    out.pooled = pool(diffs);
    out.verdict = verdicts(diffs, unscorable);
    if (unscorable) out.unscorable = unscorable;
    out.lag = lagSummary(diffs);
    out.floor = o.floors && o.floors[m.id] ? o.floors[m.id] : { unmeasured: true, reason: 'no identity takes scored for this mechanism', probe: 'record >= 2 source takes at different sampler phases (protocol.identityFloor)' };
    out.counts = { cues: diffs.length, different: diffs.filter(d => d.layer1 === 'different').length, unknown: diffs.filter(d => d.layer1 === 'unknown').length };
    out.worst = diffs.filter(d => d.e != null).sort((x, y) => y.e - x.e).slice(0, 5).map(d => ({ where: d.where, cue: d.cue, delta: d.delta, band: d.band, e: d.e, layer2: d.layer2 }));
    rec.mechanisms.push(out);
  }
  return rec;
}

/** The separate lag channel: per event, source lag, rebuild lag, delta (ms) and its band. */
function lagSummary(diffs) {
  const ls = diffs.filter(d => d.cue === 'lag');
  if (!ls.length) return null;
  const worst = ls.reduce((w, d) => (d.delta != null && (w == null || Math.abs(d.delta) > Math.abs(w.delta)) ? d : w), null);
  return { events: ls.map(d => ({ where: d.where, srcMs: d.src, rebMs: d.reb, deltaMs: d.delta, bandMs: d.band, layer2: d.layer2 })), worstDeltaMs: worst ? worst.delta : null, worstBandMs: worst ? worst.band : null };
}

/** Every cue-difference key of a record with its |Δ| (used to build a self-band from identity comparisons). */
export function cueDeltas(rec) {
  const out = {};
  for (const m of rec.mechanisms) m.pairs.forEach((p, pi) => {
    if (p.response) for (const ev of p.response.events || []) for (const d of ev.diffs) out[bandKey(m.id, pi, 'response', ev.i, d.cue)] = d.delta == null ? null : Math.abs(d.delta);
    if (p.sweep) for (const d of p.sweep.diffs || []) out[bandKey(m.id, pi, 'sweep', 0, d.cue)] = d.delta == null ? null : Math.abs(d.delta);
  });
  return out;
}
