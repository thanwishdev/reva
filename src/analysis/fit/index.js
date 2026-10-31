// REVA fitter (M2): take set → explainable motion records (`reva.motion/0`) + unknowns ledger.
// Implements docs/design/M2-fitter.md (§1 data flow). Read what is declared, fit only what is not (SYN §5.1).
// The fit core never imports the lab (src/analysis/fit/lab/); a test asserts it.
import { blindView } from './blind.js';
import { extractSeries, noiseFloor, frameTiming, segment, breakpoints, springRetargets, inputEvents, detectQuantum, motionThreshold, irregularFrame, baseKey } from './series.js';
import { tweenCandidates, tweenWindow, fitNamed, fitBezier, fitShape } from './tween.js';
import { cubicBezier } from '../oracles.js';
import { fitSpringAnalytic, springDerived } from './spring.js';
import { HYPOTHESES, fitHypothesis, identify, detectSnap, lateKink } from './integrators.js';
import { smoothingCandidates, smoothingForm, fitMapShape, mapSeed, MAP_SHAPES, timelineScrub, simulateSmoother as simulateSmootherExt } from './smoothing.js';
import { fitStep, fitRamp, fitPeriodic, fitFriction, linearStops } from './simple.js';
import { checkDeclared, descMatch, declaredProps } from './declared.js';
import { parseEasing, NAMED, easeAt, canonicalEasing, effectiveEasing } from './eases.js';
import { select, holdout, guardRecord, paramValues, selectionAmbiguity, labelUnidentified } from './select.js';
import { smoothingLaw, curveClass, stallLaw } from './tworate.js';
import { attribute } from './attribution.js';
import { analyseStagger } from './stagger.js';
import { findPins, hysteresis, mapRidge } from './scrollextras.js';
import { strideRows, hybridApplies, needsFullRate, HYBRID_STRIDE, HYBRID_BUDGET_SHARE } from './hybrid.js';
import { ols, likelihood, profileCI, meter, withStage, FitBudgetError } from './numeric.js';

export { hybridOn, HYBRID_DEFAULT } from './hybrid.js';
export const MOTION_SCHEMA = 'reva.motion/0';
export const FIT_SCHEMA = 'reva.fitresult/0';
const PRIMARY_CH = ['ren:tx', 'ren:ty', 'ren:opacity', 'ren:sx', 'ren:sy', 'ren:rz', 'ren:skx', 'ren:tz'];

/** Prepare one take: blind view, series, timing. */
export function prepare(t) {
  const view = blindView(t); const ex = extractSeries(view); const timing = frameTiming(view, ex.T);
  const dt = view.dtPage || timing.medianDt;
  return { view, ...ex, timing, dt, events: inputEvents(view, ex.T, ex.sy) };
}

const isMoving = (s, nf) => { const thr = motionThreshold(nf); for (let i = 1; i < s.y.length; i++) if (Math.abs(s.y[i] - s.y[i - 1]) > thr) return true; return false; };

/** Prune channels that are exact affine copies of another moving channel of the same element (bbox vs transform, ren vs drv var). */
function pruneRedundant(list) {
  const keep = []; const pruned = [];
  const rank = (s) => (s.kind === 'drv' ? 0 : PRIMARY_CH.includes(s.ch) ? 1 : s.ch.startsWith('ren:--') ? 2 : 3);
  const byEl = new Map(); for (const x of list) { const a = byEl.get(x.s.el) || []; a.push(x); byEl.set(x.s.el, a); }
  for (const [, xs] of byEl) {
    xs.sort((a, b) => rank(a.s) - rank(b.s));
    const kept = [];
    for (const x of xs) {
      const twin = (x.s.kind === 'ren' && !PRIMARY_CH.includes(x.s.ch)) ? kept.find((k) => k.s.kind === 'ren' || (x.s.ch.startsWith('ren:--') && k.s.ch === 'drv:' + x.s.ch.slice(4))) : null;
      if (twin && sameShape(twin.s, x.s, x.nf)) { pruned.push({ key: x.s.key, desc: x.s.desc, ch: x.s.ch, redundant_with: twin.s.ch }); continue; }
      kept.push(x);
    }
    keep.push(...kept);
  }
  return { keep, pruned };
}
function sameShape(a, b, nf) {
  if (a.y.length !== b.y.length) return false; const d0 = b.y[0] - a.y[0];
  for (let i = 0; i < a.y.length; i++) if (Math.abs(b.y[i] - a.y[i] - d0) > Math.max(nf.explainBar, 2 / 64)) return false;
  return true;
}

/**
 * Quantum of rendered channels driven by a quantised driver channel (design §5.1: "the value lattice detected on the
 * driver or rendered channel"): ren = a + b·drv exactly → quantum_ren = |b|·quantum_drv.
 */
function driverQuanta(X) {
  const out = new Map();
  for (const d of X.series) {
    if (d.kind !== 'drv') continue; const q = detectQuantum(d.y); if (!q) continue; out.set(d.key, q);
    for (const r of X.series) {
      if (r.el !== d.el || r.kind !== 'ren' || r.y.length !== d.y.length) continue;
      const fit = ols(d.y.map((v) => [1, v]), r.y); if (!fit) continue;
      const rmsr = Math.sqrt(fit.rss / r.y.length); const b = fit.beta[1];
      if (Math.abs(b) > 0 && rmsr <= 1e-3 * Math.abs(b) * q) out.set(r.key, Math.abs(b) * q);
    }
  }
  return out;
}

/** The probe segment matching a primary segment: same index when the counts agree, else the nearest onset (≤ 100 ms). */
function matchSegment(sP, segsP, seg, sq, segsQ) {
  const j = segsP.findIndex((g) => g === seg || (g.b === seg.b && g.e === seg.e));
  if (segsP.length === segsQ.length && j >= 0) return segsQ[j];
  let best = null; for (const g of segsQ) { const d = Math.abs(sq.T[g.b] - sP.T[seg.b]); if (d <= 100 && (!best || d < best.d)) best = { g, d }; }
  if (best) return best.g;
  // else the probe segment overlapping the primary one the most in time (a motion from rest crosses the motion
  // threshold later at coarse frames: lab case M07 p400, onsets 667 ms at 30 Hz vs 542 ms at 120 Hz)
  let ov = null; for (const g of segsQ) { const o = Math.min(sq.T[g.e], sP.T[seg.e]) - Math.max(sq.T[g.b], sP.T[seg.b]); if (o > 0 && (!ov || o > ov.o)) ov = { g, o }; }
  return ov && ov.o >= 0.5 * (sP.T[seg.e] - sP.T[seg.b]) ? ov.g : null;
}

/** Find the series in another take matching (descriptor occurrence, channel). */
function matchSeries(P, Q, s) {
  if (!Q) return null; const occ = P.series.filter((x) => x.desc === s.desc && x.ch === s.ch).indexOf(s);
  return Q.series.filter((x) => x.desc === s.desc && x.ch === s.ch)[occ] || null;
}

const pv = (value, provenance, extra = {}) => ({ value, provenance, ...extra });
const fittedParams = (c, units = {}) => Object.fromEntries(Object.entries(c.params || {}).map(([k, v]) => [k, pv(v.value, 'fitted', { unit: v.unit || units[k] || null, ci95: v.ci95 })]));

/** Base record skeleton (design §10). */
function baseRecord(s, nf, P) {
  return { schema: MOTION_SCHEMA, target: { el: s.el, desc: s.desc, channel: s.ch, ...(s.formKey !== undefined ? { form: s.form } : {}), untrusted_content: true }, attribution: null, tier: null, class: null,
    model: { family: null, params: {}, integrator: null, law: null, valid_at: { frame_ms: P.dt, refresh_hz: P.dt ? 1000 / P.dt : null } },
    derived: {}, fit: { n: 0, rms: null, nrmse: null, sigma_floor: nf.sigma, explain_bar: nf.explainBar, quantum: nf.quantum, bic: null, holdout: null },
    runnerUp: null, rejected: [], ambiguity: null, replay: null, unknowns: [], flags: [], evidence: { takes: [P.view.digest], location: null } };
}
const unk = (rec, id, reason, probe) => { rec.unknowns.push({ id, reason, probe }); };

/**
 * L8 (fit speed): exact duplicate channels. fitSeries (without look's cross-channel stages and without a probe take) is a
 * function of the series (channel, sample indices, frame times, values, value form), its noise floor, the take and the
 * element's DESCRIPTOR (declared births, scroll-timeline and SMIL entries are matched by descriptor, the page root box by
 * name); the element id only goes into the record's target. A channel equal in all of these to one already fitted gets
 * deep copies of that fit's records (copied when the fit returned, before any later step touched them) with its own
 * target, and the evaluation meter and the work budget are charged exactly what the first fit used: the take's totals,
 * its budget cut points and its output are the same as fitting it again. Two descriptors count as equal when they are the
 * same string, or when neither matches any declared entry of the take and neither is the page root box. A copy is used
 * only while its charge stays inside the take and channel budgets (the first fit did not reach them, so the same fit from
 * here would not either); otherwise the channel is fitted as before.
 */
export function duplicateMemo(P, work) {
  const byKey = new Map(); const free = new Map();
  const same = (x, y) => {
    if (Object.is(x, y)) return true;
    if (Array.isArray(x) && Array.isArray(y)) { if (x.length !== y.length) return false; for (let i = 0; i < x.length; i++) if (!same(x[i], y[i])) return false; return true; }
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const ka = Object.keys(x), kb = Object.keys(y); if (ka.length !== kb.length) return false;
      for (const k of ka) if (!Object.prototype.hasOwnProperty.call(y, k) || !same(x[k], y[k])) return false; return true;
    }
    return false;
  };
  const OWN = new Set(['key', 'el', 'desc']);
  const sameSeries = (a, b) => { const ka = Object.keys(a).filter((k) => !OWN.has(k)), kb = Object.keys(b).filter((k) => !OWN.has(k)); if (ka.length !== kb.length) return false; for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !same(a[k], b[k])) return false; return true; };
  const declaredFree = (d) => { if (free.has(d)) return free.get(d);
    const v = !(P.view.births || []).some((b) => descMatch(b.tgt, d)) && !(P.view.declared || []).some((snap) => (snap.list || []).some((a) => descMatch(a.tgt, d)) || (snap.smil || []).some((a) => descMatch(a.tgt, d)));
    free.set(d, v); return v; };
  // F3: declaredRecord picks class composite vs declared by the element's own moving `drv:` sibling channel (same test as there),
  // so two otherwise equal series with a different answer here must never share a fit
  const drvMemo = new Map();
  const hasDrv = (s) => { if (drvMemo.has(s)) return drvMemo.get(s);
    const v = P.series.some((x) => x.el === s.el && x.kind === 'drv' && x.ch !== s.ch && isMoving(x, noiseFloor(x, P.view))); drvMemo.set(s, v); return v; };
  const sameDesc = (a, b) => a.desc === b.desc || (!isRootBox(a) && !isRootBox(b) && declaredFree(a.desc) && declaredFree(b.desc));
  const keyOf = (s) => `${s.ch}|${s.kind}|${s.y.length}|${s.idx[0]}|${s.y[0]}|${s.y[s.y.length >> 1]}|${s.y[s.y.length - 1]}`;
  const targetOf = (s) => ({ el: s.el, desc: s.desc, channel: s.ch, ...(s.formKey !== undefined ? { form: s.form } : {}), untrusted_content: true });
  return {
    find(s, nf) { const list = byKey.get(keyOf(s)); return list ? list.find((e) => same(e.nf, nf) && sameSeries(e.s, s) && sameDesc(e.s, s) && hasDrv(e.s) === hasDrv(s)) || null : null; },
    store(s, nf, rs, du, dw) {
      const tgt = targetOf(s); if (!rs.every((r) => r && same(r.target, tgt))) return;
      let recs; try { recs = structuredClone(rs); } catch { return; }
      const k = keyOf(s); const list = byKey.get(k) || []; list.push({ s, nf, recs, du, dw, where: meter.where }); byKey.set(k, list);
    },
    replay(e, s) {
      if (meter.hit || meter.units + e.du > meter.limit || meter.chan + e.du > meter.chanLimit || meter.stage + e.du > meter.stageLimit) return null;
      meter.units += e.du; meter.chan += e.du; meter.stage += e.du; meter.where = e.where; work.units += e.dw;
      const recs = structuredClone(e.recs); for (const r of recs) r.target = targetOf(s);
      return recs;
    },
  };
}
const summarize = (c) => (c ? { family: c.family, cls: c.cls, rms: c.rms, bic: c.bic, L: c.L, params: paramValues(c) } : null);

/**
 * Fit a take set.
 * @param {{primary:object, probe?:object, idle?:object}} set  loadTake() results (or the same shape in memory)
 * @param {{maxSegments?:number, integrators?:boolean}} [opts]
 */
export function fitTakeSet(set, opts = {}) {
  // arm the evaluation meter for this take (numeric.js); restored afterwards so nested/sequential callers are unaffected
  const lim = (v) => (Number.isFinite(v) && v > 0 ? v : Infinity);
  const saved = { ...meter }; Object.assign(meter, { units: 0, chan: 0, limit: lim(opts.evalBudget), chanLimit: lim(opts.channelEvalBudget), hit: null, stage: 0, stageLimit: Infinity, where: null });
  try { return fitTakeSetMetered(set, opts); } finally { Object.assign(meter, saved); }
}

function fitTakeSetMetered(set, opts) {
  const P = prepare(set.primary), Q = set.probe ? prepare(set.probe) : null, I = set.idle ? prepare(set.idle) : null;
  const ledger = []; const records = []; const statics = []; const flags = [...P.timing.flags];
  const stride = P.timing.strideInt; const strideDeclared = !!P.view.dtPage;
  if (stride && stride !== 1 && strideDeclared) flags.push({ id: 'sampling_stride', detail: `samples every ${stride} page frames (declared dt ${P.view.dtPage} ms): per-frame constants corrected to the page frame` });
  if (P.view.lane === 'rt' && !P.view.dtPage) flags.push({ id: 'rt_no_page_period', detail: 'rt take: page frame period not declared (U6)' });
  const scrollMoved = P.events.some((e) => e.kind === 'scroll');
  // moving channels
  const cands = [];
  const onlyKeys = opts.onlyKeys ? new Set(opts.onlyKeys) : null;
  const quanta = driverQuanta(P);
  for (const s of P.series) {
    if (s.kind === 'scroll') continue;
    // development aid: fit only the channels whose `desc|channel` contains one of opts.only (never set by the lab runner)
    if (opts.only && !opts.only.some((q) => `${s.desc}|${s.ch}`.includes(q))) continue;
    // exact per-element filter (look): `${elId}|${channel}` keys; repeated elements share a descriptor, so `only` cannot pick members
    if (onlyKeys && !onlyKeys.has(s.key) && !onlyKeys.has(baseKey(s.key))) continue;
    const nf = noiseFloor(s, P.view, { quantum: quanta.get(s.key) });
    if (!isMoving(s, nf)) { statics.push({ key: s.key, desc: s.desc, ch: s.ch, coverage: 'not observed moving in these takes' }); continue; }
    cands.push({ s, nf });
  }
  const { keep: kept, pruned } = pruneRedundant(cands);
  // boxes that are the text reflowing (extractSeries.covered): stated by the text channel, listed so look can say so
  for (const c of P.covered || []) if (!onlyKeys || onlyKeys.has(c.key) || onlyKeys.has(baseKey(c.key))) pruned.push({ key: c.key, desc: c.desc, ch: c.ch, redundant_with: c.covered_by, why: c.why });
  // corpus caps (CORPUS-PLAN §0.4, B2): opts.maxChannels keeps the channels with the most motion energy (total variation
  // over the channel's noise); opts.workBudget stops starting new channels once the take's fitting work is spent. Every
  // channel left out goes to the unknowns ledger with its reason, so a capped fit is partial, never silent. Without the
  // opts nothing changes.
  // Work budget, not a wall clock (corpus S4): the old 240 s deadline made the same take fit differently on a busy and an
  // idle machine (95 of 1386 corpus fits were cut by it while 12 workers shared the CPU). Work is counted in samples fed
  // to the driver-smoothing fits (smoothingCandidates: profiled at ~95 % of a slow take's CPU, ~20 ms per sample-channel
  // under load), so the cut point depends on the input only. A channel is never cut mid-fit: the check runs before each
  // channel, so a take overshoots the budget by at most one channel.
  const capped = [];
  let keep = kept;
  if (opts.maxChannels && kept.length > opts.maxChannels) {
    const energy = ({ s, nf }) => { let tv = 0; for (let i = 1; i < s.y.length; i++) tv += Math.abs(s.y[i] - s.y[i - 1]); return tv / Math.max(3 * (nf.sigma || 0), nf.quantum || 0, 1e-3); }; // TV in noise units: comparable across px / opacity channels
    const ranked = kept.map((c) => [energy(c), c]).sort((x, y) => y[0] - x[0]);
    keep = ranked.slice(0, opts.maxChannels).map((x) => x[1]);
    for (const [e, { s }] of ranked.slice(opts.maxChannels)) capped.push({ id: 'unk_fit_capped', reason: `channel not fitted: maxChannels ${opts.maxChannels} (motion energy rank below the cap, energy ${e.toPrecision(3)})`, probe: 'refit without maxChannels', target: `${s.desc}|${s.ch}` });
  }
  // fit order (look): opts.order lists the keys in the order they should spend the budget (declared channels first, then
  // one channel per motion in rank order, round by round), so a motion whose channels are slow to fit cannot use the whole
  // take budget before the next motion's first channel is tried. Keys not in the list keep their place after it.
  if (Array.isArray(opts.order) && opts.order.length) {
    const pos = new Map(opts.order.map((k, i) => [k, i])); const last = opts.order.length;
    const at = ({ s }) => pos.get(s.key) ?? pos.get(baseKey(s.key)) ?? last;
    keep = keep.map((c, i) => [at(c), i, c]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2]);
  }
  // S1b hybrid 60/120 Hz (corpus fit only: opts.hybrid, never set by look): each channel is fitted on every 2nd row first
  // and again on all rows when needsFullRate says the 60 Hz answer cannot stand in for the 120 Hz one (hybrid.js)
  const hy = opts.hybrid && !opts.onlyKeys && !opts.earlyExit && !opts.declaredFirst && !opts.only && !Q && P.view.rows.length ? (() => {
    if (!hybridApplies(P.view.rows, P.view.dtPage, P.timing.strideInt)) return null;
    const P6 = prepare({ ...set.primary, data: { ...set.primary.data, rows: strideRows(set.primary.data.rows) } });
    if (P6.timing.strideInt !== HYBRID_STRIDE) return null;
    P6.view.digest = P.view.digest;   // one take: the records name it by the full-rate digest
    return { P6, byKey: new Map(P6.series.map((x) => [x.key, x])), shared: { scrubs: [] }, refit: [], why: {} };
  })() : null;
  const hybridFit = (s, nf, declaredOnly) => {
    const s6 = hy && hy.byKey.get(s.key);
    if (!s6 || s6.y.length < 8) return fitSeries(s, nf, { P, Q, I, opts, scrollMoved, work, declaredOnly, shared });
    // the fit work budget (workBudget) is counted as the full-rate fit would count it, so the same channels are capped:
    // a kept 60 Hz fit counts twice its samples, a refit channel only its full-rate fit
    const w0 = work.units;
    // the 60 Hz pass runs under a quarter of the channel's evaluation budget: a search that is not done by then is cut and
    // the channel goes to the full-rate fit with its whole budget (the 60 Hz path of a hard channel can cost more than 120 Hz)
    const chanLimit = meter.chanLimit; let rs = [], cut = false;
    if (Number.isFinite(chanLimit)) meter.chanLimit = chanLimit * HYBRID_BUDGET_SHARE;
    try { rs = fitSeries(s6, nf, { P: hy.P6, Q, I, opts, scrollMoved, work, declaredOnly, shared: hy.shared }); }
    catch (e) { if (meter.hit !== 'channel') throw e; }
    finally { meter.chanLimit = chanLimit; }
    if (meter.hit === 'channel') { meter.hit = null; cut = true; rs = []; }   // only the reduced limit can have fired
    if (declaredOnly && !rs.length && !cut) return rs;
    let span = null; { const g = segment(s, nf, {}); if (g.length) span = s.T[g[g.length - 1].e] - s.T[g[0].b]; }
    const why = cut ? 'budget at 60 Hz' : needsFullRate(rs, span);
    if (!why) { work.units = w0 + HYBRID_STRIDE * (work.units - w0); return rs; }
    hy.refit.push(s.key); hy.why[s.key] = why; work.units = w0;
    meter.chan = 0; meter.where = null; meter.hitAt = null;   // the full-rate fit has the channel's whole evaluation budget, as in a normal fit
    return fitSeries(s, nf, { P, Q, I, opts, scrollMoved, work, declaredOnly, shared });
  };
  const work = { units: 0 }; const budget = Number.isFinite(opts.workBudget) && opts.workBudget > 0 ? opts.workBudget : Infinity;
  let budgetHit = false;
  // evaluation budget (FITFIX; numeric.js meter): a channel whose fit passes opts.channelEvalBudget evaluated frames, or
  // that is running when the take passes opts.evalBudget, is cut mid-fit and recorded as unknown with the reason; once
  // the take budget is spent the remaining channels go to the ledger unfitted (as the S4 smoothing budget does)
  let evalTakeHit = false; const evalCut = []; let maxChan = 0, maxChanKey = null; let earlyPins = null;
  const cutRecord = (s, nf, kind) => { const rec = baseRecord(s, nf, P); rec.tier = 'unknown'; rec.class = 'unknown';
    const at = meter.hitAt ? ` during ${meter.hitAt}` : '';
    const why = kind === 'take' ? `take evaluation budget ${opts.evalBudget} reached${at} in this channel (${meter.units} frame evaluations)` : `channel evaluation budget ${opts.channelEvalBudget} reached${at} (${meter.chan} frame evaluations)`;
    // what the search had not finished is not reported as a model; what was MEASURED is (cheap, no search): the window's
    // start and end values and times, so the reader gets a precise statement instead of nothing
    let seen = '';
    try {
      const segs = segment(s, nf, {}); const g0 = segs[0], g1 = segs[segs.length - 1];
      if (g0) {
        const i0 = Math.max(0, g0.b - 1), i1 = g1.e; const f = (v) => +Number(v).toPrecision(5);
        rec.derived = { t0: s.T[i0], measured: { from: f(s.y[i0]), to: f(s.y[i1]), onset_ms: Math.round(s.T[i0]), end_ms: Math.round(s.T[i1]), segments: segs.length, provenance: 'measured' } };
        rec.evidence.location = { kind: 'time_range', range: [s.T[i0], s.T[i1]] };
        seen = ` Measured: ${f(s.y[i0])} to ${f(s.y[i1])} between ${Math.round(s.T[i0])} and ${Math.round(s.T[i1])} ms${segs.length > 1 ? ` (${segs.length} separate runs)` : ''}.`;
      }
    } catch { /* the measured window is a courtesy */ }
    rec.flags.push({ id: 'fit_budget', detail: why });
    unk(rec, 'unk_fit_budget', `fit stopped: ${why}; no model is reported.${seen}`, kind === 'take' ? 'refit with a larger evalBudget' : 'refit with a larger channelEvalBudget');
    evalCut.push({ target: `${s.desc}|${s.ch}`, budget: kind, stage: meter.hitAt || null }); return rec; };
  // declared-first keys (look: opts.declaredFirst) get only the declared tier on their first visit; one the declaration
  // does not explain is requeued at the end for the full fit
  const firstOnly = (k) => !!(opts.declaredFirst && (opts.declaredFirst.has(k) || opts.declaredFirst.has(baseKey(k))));
  const queue = keep.map((c) => ({ ...c, declaredOnly: firstOnly(c.s.key) }));
  // look, native scroll: smoothed scroll progress identified on one channel (a scrubbed timeline), reused by the next
  const shared = { scrubs: [] };
  // L8: exact duplicate channels (repeated elements moving identically: 50-80 % of the moving channels on a large page)
  // are fitted once; see duplicateMemo. Off where a fit reads more than the series and the take (look's cross-channel
  // stages, a probe take matched by descriptor occurrence, development filters)
  const dupMemo = opts.earlyExit || opts.declaredFirst || opts.only || opts.noDuplicateMemo || Q || opts.debug ? null : duplicateMemo(P, work);
  for (let qi = 0; qi < queue.length; qi++) {
    const { s, nf, declaredOnly } = queue[qi];
    if (work.units >= budget) { budgetHit = true; capped.push({ id: 'unk_fit_budget', reason: `channel not fitted: fit work budget ${opts.workBudget} reached (${work.units} units spent)`, probe: 'refit with a larger workBudget', target: `${s.desc}|${s.ch}` }); continue; }
    if (meter.hit === 'take') { evalTakeHit = true; capped.push({ id: 'unk_fit_budget', reason: `channel not fitted: take evaluation budget ${opts.evalBudget} reached (${meter.units} frame evaluations)`, probe: 'refit with a larger evalBudget', target: `${s.desc}|${s.ch}` }); continue; }
    meter.chan = 0; meter.where = null; meter.hitAt = null;
    // look early exit: the translate y of a pinned element that jumps by the pin length when the pin ends is the pin's
    // release (GSAP pins with position: fixed, then puts the element where the pin spacer left it). It is the pin, not a
    // scroll map of its own (a pinned track and a pinned work rail on a Lenis + GSAP pinned-rail page read as a smoothstep map with an
    // unknown range)
    if (opts.earlyExit && scrollMoved && s.ch === 'ren:ty') {
      if (!earlyPins) earlyPins = findPins(P.view, P.sy);
      const pin = earlyPins.find((p) => p.el === s.el); const rel = pin ? pinRelease(pin, s, nf, P) : null;
      if (rel) { pruned.push({ key: s.key, desc: s.desc, ch: s.ch, redundant_with: 'ren:by', why: rel }); continue; }
    }
    // look early exit: a pinned box (findPins + the exact piecewise identity) needs no time-family fit (spike: ~30 s on a scroll-pinned track)
    if (opts.earlyExit && scrollMoved && s.ch === 'ren:by') {
      if (!earlyPins) earlyPins = findPins(P.view, P.sy);
      const pin = earlyPins.find((p) => p.el === s.el); const rec = pin ? pinRecord(pin, s, nf, P) : null;
      if (rec) { rec.flags.push({ id: 'early_exit', detail: 'look mode: pin identity holds on every sample; time families not tried' }); records.push(rec); continue; }
      // the box of an element that also moves by its own transform is page scroll + pin + that transform: take the
      // element's own translate out and look for the pin again (a pinned panel whose content slides, a sticky row
      // that fades up). When there is still no pin, the box adds nothing the own channels do not say: it is covered by
      // them, and the time families are not run on it (a Lenis + GSAP pinned-rail page: 2-2.5e8 evaluations per box for a meaningless
      // spring / piecewise fit, which spent the take budget before the scrubbed channels were reached)
      const own = P.series.filter((x) => x.el === s.el && x !== s && PRIMARY_CH.includes(x.ch) && isMoving(x, noiseFloor(x, P.view, { quantum: quanta.get(x.key) }))).map((x) => ({ s: x }));
      if (own.length) {
        const pinOwn = ownPin(s, nf, P);
        if (pinOwn) { pinOwn.flags.push({ id: 'early_exit', detail: 'look mode: pin identity holds on every sample once the element\'s own translate y is taken out; time families not tried' }); records.push(pinOwn); continue; }
        pruned.push({ key: s.key, desc: s.desc, ch: s.ch, redundant_with: own[0].s.ch, why: 'the box follows the page scroll and the element\'s own transform; no pin holds' });
        continue;
      }
    }
    try {
      let rs;
      const twin = dupMemo ? dupMemo.find(s, nf) : null;
      const again = twin ? dupMemo.replay(twin, s) : null;
      if (again) rs = again;
      else {
        const u0 = meter.units, w0 = work.units;
        try { rs = hy ? hybridFit(s, nf, declaredOnly) : fitSeries(s, nf, { P, Q, I, opts, scrollMoved, work, declaredOnly, shared }); } catch (e) { if (!meter.hit) throw e; }
        if (dupMemo && rs && !meter.hit) dupMemo.store(s, nf, rs, meter.units - u0, work.units - w0);
      }
      if (declaredOnly && !meter.hit && rs && !rs.length) { queue.push({ s, nf, declaredOnly: false }); continue; }
      if (meter.chan > maxChan) { maxChan = meter.chan; maxChanKey = `${s.desc}|${s.ch}`; }
      if (meter.hit) { const kind = meter.hit; records.push(cutRecord(s, nf, kind)); if (kind === 'take') evalTakeHit = true; else meter.hit = null; continue; }
      // SMIL is invisible to getAnimations(): an SVG element moving with no births and no style/class writes (M15)
      if (/^(circle|rect|ellipse|line|polyline|polygon|path|g|text|use|image|stop)\b/.test(s.desc || '') && !P.view.births.some((b) => b.tgt === s.desc) && !(P.view.mutations || []).some((m) => m[2] === s.el))
        for (const r of rs) unk(r, 'unk_smil_declared', 'SVG motion with no getAnimations() birth and no style/class write: likely SMIL, whose timing is not read (M15)', 'read the SMIL <animate> begin/dur/values attributes');
      records.push(...rs);
    }
    catch (e) { const rec = baseRecord(s, nf, P); rec.tier = 'unknown'; rec.class = 'unknown'; unk(rec, 'unk_fit_error', String(e && e.message).slice(0, 200), 'report the take to the fitter maintainer'); records.push(rec); }
  }
  // refits below (lag consistency) run under the same meter: a cut refit throws, its caller keeps the first fit
  const refitSeries = (k, extra) => { if (meter.hit) throw new FitBudgetError(meter.hit); meter.chan = 0;
    try { const rs = fitSeries(k.s, k.nf, { P, Q, I, opts, scrollMoved, work, shared, ...extra }); if (meter.hit) throw new FitBudgetError(meter.hit); return rs; }
    finally { if (meter.hit === 'channel') meter.hit = null; } };
  // driver-lag consistency per element (lab case M04 speed g4: the toFixed(3) channel traded one frame of driver lag
  // against α — α 0.611 + lag 1 against the true 0.38 + lag 0, equal mean delay on a slowly varying target — while the
  // element's finer channels, toFixed(2) of a 60 px range, fit lag 0): one smoother drives the element's channels, so
  // the lag of a channel resolved ≥ 3× finer (σ_floor / |b|) is imposed on a coarser one when it explains with it
  {
    const sm = records.filter((r) => r.class === 'first-order smoothing' && r.model.map && Number.isInteger(r.model.map.driverLagFrames) && r.fit && r.fit.sigma_floor > 0 && Math.abs(r.model.map.b) > 0);
    const byEl = new Map(); for (const r of sm) { const a = byEl.get(r.target.el) || []; a.push(r); byEl.set(r.target.el, a); }
    const res = (r) => r.fit.sigma_floor / Math.abs(r.model.map.b);
    // … and a coarse channel left ambiguous between first-order smoothing and another class takes the class of the
    // element's finer channels when that class explains it at their lag (lab case M04 speed g2 at R6: toFixed(3) drv:--s
    // EMA vs a restarted expo.out with a 10 ms delay, while drv:--y/--o of the same element are EMA)
    for (const r of records) if (r.ambiguity && r.model.map && Number.isInteger(r.model.map.driverLagFrames) && r.fit && r.fit.sigma_floor > 0 && Math.abs(r.model.map.b) > 0 && byEl.has(r.target.el)
      && r.ambiguity.candidates.some((c) => c.cls === 'first-order smoothing')) byEl.get(r.target.el).push(r);
    for (const list of byEl.values()) {
      if (list.length < 2) continue; const ref = [...list].filter((r) => !r.ambiguity).sort((a, b) => res(a) - res(b))[0]; if (!ref) continue;
      for (const r of list) {
        if (r === ref || res(r) < 3 * res(ref)) continue;
        if (r.ambiguity) { const k = keep.find((q) => q.s.el === r.target.el && q.s.ch === r.target.channel); if (!k) continue;
          try { const rs = refitSeries(k, { forceLag: ref.model.map.driverLagFrames, forceClass: ref.class });
            if (rs.length === 1 && rs[0].class === ref.class && rs[0].tier === 'fitted' && !rs[0].ambiguity) { rs[0].decidedBy = `class ${ref.class} and driver lag from ${ref.target.channel} of the same element (resolved ${(res(r) / res(ref)).toFixed(0)}× finer)`; records[records.indexOf(r)] = rs[0]; } } catch {}
          continue; }
        if (r.model.map.driverLagFrames === ref.model.map.driverLagFrames) continue;
        const k = keep.find((q) => q.s.el === r.target.el && q.s.ch === r.target.channel); if (!k) continue;
        try { const rs = refitSeries(k, { forceLag: ref.model.map.driverLagFrames });
          if (rs.length === 1 && rs[0].class === r.class && rs[0].tier === 'fitted' && !rs[0].ambiguity) { rs[0].decidedBy = `driver lag ${ref.model.map.driverLagFrames} frame(s) from ${ref.target.channel} of the same element (resolved ${(res(r) / res(ref)).toFixed(0)}× finer)`; records[records.indexOf(r)] = rs[0]; } } catch {}
      }
    }
    // … and when every smoothing-like channel of the element stays ambiguous (R6: one take, no probe), the finest one
    // whose ambiguous set shares τ (every member within 2 %, so one lag) fixes the lag of a ≥ 3× coarser one (lab case
    // M04 g4 speed at R6: drv:--y/--o share τ 34.86 ms at lag 0, while the toFixed(3) drv:--s set mixes lag-0 members,
    // τ 35.1 ms, with lag-1 members, τ 17.8 ms, so its τ was withheld). The class stays ambiguous; only the lag is imposed
    const shared = (r) => !!(r.ambiguity && r.model.params.tau_ms && r.model.params.tau_ms.sharedByAmbiguity && r.model.params.tau_ms.provenance === 'fitted');
    const amb = records.filter((r) => r.ambiguity && r.model.map && Number.isInteger(r.model.map.driverLagFrames) && r.fit && r.fit.sigma_floor > 0 && Math.abs(r.model.map.b) > 0 && !byEl.has(r.target.el));
    const byElA = new Map(); for (const r of amb) { const a = byElA.get(r.target.el) || []; a.push(r); byElA.set(r.target.el, a); }
    for (const list of byElA.values()) {
      const ref = list.filter(shared).sort((a, b) => res(a) - res(b))[0]; if (!ref) continue;
      for (const r of list) {
        if (r === ref || shared(r) || res(r) < 3 * res(ref)) continue;
        const k = keep.find((q) => q.s.el === r.target.el && q.s.ch === r.target.channel); if (!k) continue;
        try { const rs = refitSeries(k, { forceLag: ref.model.map.driverLagFrames });
          if (rs.length === 1 && rs[0].model.map && rs[0].model.map.driverLagFrames === ref.model.map.driverLagFrames && (shared(rs[0]) || (!rs[0].ambiguity && rs[0].tier === 'fitted' && rs[0].class === ref.ambiguity.candidates[0].cls))) {
            rs[0].decidedBy = `driver lag ${ref.model.map.driverLagFrames} frame(s) from ${ref.target.channel} of the same element (its ambiguous set shares τ; resolved ${(res(r) / res(ref)).toFixed(0)}× finer)`; records[records.indexOf(r)] = rs[0]; } } catch {}
      }
    }
  }
  // the rest is bookkeeping on the fitted records: disarm the meter so a spent take budget cannot throw there
  const evalUnits = meter.units; Object.assign(meter, { limit: Infinity, chanLimit: Infinity, hit: null, stageLimit: Infinity, where: null });
  markFlip(P, records);
  // pins and hysteresis (§4.7)
  const pins = scrollMoved ? findPins(P.view, P.sy) : [];
  // a pinned element's box channel is ONE scroll map, piecewise: it moves 1:1 with the offset, is held over the pin
  // range, and moves 1:1 again after it. Its segment-wise time records (a step at a scrollTo, 2-frame motions at the pin
  // edges) are replaced by that map when every sample fits it (lab case M04 speed: the pinned block's ren:by split into
  // a step and too-short segments)
  for (const pin of pins) {
    const k = keep.find((q) => q.s.el === pin.el && q.s.ch === 'ren:by'); if (!k) continue;
    const own = records.filter((r) => r.target.el === pin.el && r.target.channel === 'ren:by');
    if (own.some((r) => r.model && r.model.pin)) continue;   // decided before fitting (look early exit)
    const rec = pinRecord(pin, k.s, k.nf, P);
    if (!rec || !own.length) continue;
    records.splice(records.indexOf(own[0]), own.length === 1 ? 1 : 0, rec); for (const r of own) { const i = records.indexOf(r); if (i >= 0) records.splice(i, 1); }
  }
  if (scrollMoved) for (const { s } of keep) {
    if (s.kind === 'scroll' || isRootBox(s)) continue; const sib =P.series.find((x) => x.el === s.el && x !== s && x.kind === 'drv' && !x.y.every((v) => Math.abs(v - Math.round(v)) < 1e-9) && x.y.length === s.y.length);
    const h = hysteresis(s, s.idx.map((i) => P.sy[i]), sib ? sib.y : null); if (!h) continue;
    const r = records.find((x) => x.target.el === s.el && x.target.channel === s.ch); if (r) r.hysteresis = { ...h, siblingChannel: sib ? sib.ch : null };
    // an integer index that changes only in frames where the offset changed, by state-derived edges that reproduce every
    // frame, is a scroll-driven staircase (with hysteresis when the up and down edges differ): class scroll map. A
    // parametric map or a short restarted tween only approximates it (lab case M04 speed: the tab index read as
    // ambiguous scroll map (easeOutQuad) / restarted expo.out on the dense sweep)
    if (r && (r.class === 'unknown' || r.ambiguity) && records.filter((x) => x.target.el === s.el && x.target.channel === s.ch).length === 1) {
      const sy = s.idx.map((i) => P.sy[i]); let changes = 0, withScroll = 0;
      for (let i = 1; i < s.y.length; i++) if (s.y[i] !== s.y[i - 1]) { changes++; if (sy[i] !== sy[i - 1]) withScroll++; }
      const consistent = h.bands.every((b) => (!b.downEdge_interval || b.downEdge_interval[0] == null || b.downEdge_interval[1] == null || b.downEdge_interval[0] <= b.downEdge_interval[1]) && (!b.upEdge_interval || b.upEdge_interval[0] == null || b.upEdge_interval[1] == null || b.upEdge_interval[0] <= b.upEdge_interval[1]));
      if (changes >= 2 && withScroll === changes && consistent) {
        r.class = 'scroll map'; r.tier = 'fitted'; r.ambiguity = null; r.model.family = h.hysteresis ? 'staircase with hysteresis (scroll index)' : 'staircase (scroll index)';
        r.unknowns = (r.unknowns || []).filter((u) => u.id !== 'unk_ambiguous_class'); r.decidedBy = `integer index changing only with the scroll offset (${changes} changes); state-derived edges reproduce every frame`;
      }
    }
  }
  // U7: canvas content is outside DOM channels — the canvas element's DOM record says not_applicable (design X4: also
  // when a pixel channel or a uniform tap measures the content; those are their own records)
  for (const [i, d] of P.view.elements.entries()) {
    if (!d || !/^CANVAS\b/i.test(d)) continue;
    if (!P.view.rows.some((r) => r.v && r.v[i])) continue;
    records.push({ schema: MOTION_SCHEMA, target: { el: i, desc: d, channel: '*', untrusted_content: true }, attribution: null, tier: 'not_applicable', class: 'not_applicable', model: { family: null, params: {} }, derived: {}, fit: {}, unknowns: [{ id: 'unk_canvas_content', reason: 'canvas/WebGL drawing is not visible to DOM channels (U7)', probe: 'record the pixel channel (X4) or an rt take' }], flags: [], evidence: { takes: [P.view.digest], location: null } });
  }
  // View Transitions (design §3; lab case M17): the group animations run on pseudo-elements the sampler cannot read;
  // the declared layer (births with a pseudoElement) is the evidence — one record per transition group
  for (const b of P.view.births) {
    const m = /^::view-transition-group\((.+)\)$/.exec(b.pseudoElement || ''); if (!m) continue;
    const desc = `${b.tgt}${b.pseudoElement}`; if (records.some((r) => r.target.desc === desc)) continue;
    const kf = b.keyframes || []; const easing = b.easing && b.easing !== 'linear' ? b.easing : (kf[0] && kf[0].easing) || b.easing;
    const box = (k) => { if (!k) return null; let x = null, y = null; try { const t = String(k.transform || ''); const mm = /matrix\(([^)]+)\)/.exec(t); if (mm) { const v = mm[1].split(',').map(Number); x = v[4]; y = v[5]; } } catch {} return { x, y, w: parseFloat(k.width), h: parseFloat(k.height) }; };
    const companions = P.view.births.filter((q) => q !== b && new RegExp(`\\(${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`).test(q.pseudoElement || '')).map((q) => q.name);
    records.push({ schema: MOTION_SCHEMA, target: { el: null, desc, channel: '*', untrusted_content: true }, attribution: { label: 'time-driven', provenance: 'inferred', evidence: 'a document-timeline animation started by the page' },
      tier: 'declared', class: 'declared', model: { family: 'declared:view-transition', params: { duration: pv(b.duration, 'declared', { unit: 'ms' }), delay: pv(b.delay, 'declared', { unit: 'ms' }), easing: pv(canonicalEasing(easing), 'declared'), start: pv(b.T, 'declared', { unit: 'ms' }) },
        geometry: { old: box(kf[0]), new: box(kf[kf.length - 1]), provenance: 'declared' } },
      declared: { kind: 'view-transition', group: m[1], births: [{ name: b.name, pseudoElement: b.pseudoElement, duration: b.duration, easing, T: b.T, provenance: 'declared' }], companions, confirmed: false, note: 'not sampled: pseudo-elements are outside the DOM channels' },
      derived: { t0: b.T }, fit: {}, unknowns: [{ id: 'unk_vt_samples', reason: 'view-transition pseudo-elements are not sampled; values are declared, not checked against samples', probe: 'a pixel channel on the transition' }], flags: [], evidence: { takes: [P.view.digest], location: { kind: 'time_range', range: [b.T, b.T + (+b.duration || 0)] } } });
  }
  // attribution per element (design §8) from the element's first record
  // element key: page-level channels (gl uniforms, canvas pixels) have no element id; group them by their descriptor
  const elKey = (r) => (r.target.el == null ? `~${r.target.desc}` : r.target.el);
  const byEl = new Map(); for (const r of records) if (!byEl.has(elKey(r))) byEl.set(elKey(r), r);
  for (const r of records) {
    const head = byEl.get(elKey(r));
    if (!head._att) {
      const s = P.series.find((x) => x.el === head.target.el && x.ch === head.target.channel && (x.el != null || x.desc === head.target.desc));
      const segs = s ? segment(s, { sigma: head.fit.sigma_floor }) : [];
      let movesInIdle = null;
      // the descriptor carries the element's classes when it was first seen: a class the page toggles (lab case M20: the
      // 1 Hz tick toggles .on) makes 'DIV.e2' and 'DIV.e2.on' the same element in two takes
      const sameEl = (a, b) => a === b || (a && b && (a.startsWith(b + '.') || b.startsWith(a + '.')));
      if (I) { const si = I.series.filter((x) => sameEl(x.desc, head.target.desc)); movesInIdle = si.some((x) => isMoving(x, noiseFloor(x, I.view))); }
      head._att = attribute({ segments: segs.map((g) => ({ b: s.idx[g.b] })), events: P.events, movesInIdle, cls: head.declared && head.declared.scrollTimeline ? 'scroll map' : head.class });
    }
    r.attribution = head._att;
  }
  for (const r of records) delete r._att;
  // wheel latch (M05): a wheel-attributed tween during which further wheel input does not restart or retarget it
  const wheelT = P.events.filter((e) => e.kind === 'wheel' && e.i > 0).map((e) => P.T[e.i]);
  for (const r of records) {
    if (!r.attribution || r.attribution.label !== 'wheel' || r.class !== 'tween' || !r.model.params.D) continue;
    const t0 = r.model.params.t0 && r.model.params.t0.value, D = r.model.params.D.value ?? r.model.params.D.withheld_value; if (!Number.isFinite(t0) || !Number.isFinite(D)) continue;
    const inside = wheelT.filter((t) => t > t0 + P.dt && t < t0 + D - P.dt).length;
    // the wheel that started the tween: the page-side wheel log says whether the page took it (defaultPrevented) and
    // whether the document scrolled (lab case M05: a latched wheel is prevented and the scroll position is pinned)
    const i0 = P.T.findIndex((t) => t >= t0 - 1e-6); const k0 = i0 >= 0 ? P.view.rows[i0].k : null;
    const trig = k0 == null ? null : (P.view.wheel || []).filter((w) => w.k <= k0 && k0 - w.k <= 3).at(-1);
    if (trig && trig.prevented === true && trig.sy1 === trig.sy0) r.latch = { value: true, provenance: 'measured', evidence: 'the wheel that started the tween was prevented by the page and the document did not scroll' + (inside ? `; ${inside} later wheel events did not restart it` : '') };
    else if (trig && trig.prevented === false) r.latch = { value: false, provenance: 'measured', evidence: 'the wheel that started the tween was not prevented' };
    else r.latch = inside ? { value: true, provenance: 'measured', evidence: `${inside} wheel events inside the tween did not retarget it (one tween explains the segment)` }
      : { value: null, provenance: 'unknown', reason: 'no wheel input arrived during the tween', probe: 'a wheel burst longer than the tween' };
  }
  // stagger (design §9): onsets of records sharing class/shape/property
  const items = records.filter((r) => r.derived && Number.isFinite(r.derived.t0) && r.tier !== 'unknown').map((r) => {
    const s = P.series.find((x) => x.key === `${r.target.el}|${r.target.channel}`); const i0 = s ? s.idx[0] : 0; const row = P.view.rows[i0]; const v = (row && row.v[r.target.el]) || {};
    const shape = `${r.class}|${r.model.family}|${r.target.channel}|${r.model.params.D ? Math.round(r.model.params.D.value / Math.max(P.dt, 0.03 * r.model.params.D.value)) : ''}`;
    return { id: `${r.target.el}|${r.target.channel}|${r.derived.t0}`, t0: r.derived.t0, dom: r.target.el, x: +v['ren:bx'] || 0, y: +v['ren:by'] || 0, w: +v['ren:bw'] || 0, h: +v['ren:bh'] || 0, shape };
  });
  const vp = (P.view.env.viewport && P.view.env.viewport.value) || { width: 1280, height: 800 };
  const stagger = analyseStagger(items, { dtMs: P.dt, viewport: vp });
  for (const r of records) labelUnidentified(r);   // L9-A: fitted parameters the data cannot pin down (labels only)
  for (const r of records) { for (const u of r.unknowns) ledger.push({ ...u, target: `${r.target.desc}|${r.target.channel}` }); for (const p of Object.values(r.model.params)) if (p && p.provenance === 'unknown' && p.reason) { /* listed with the record */ } }
  ledger.push(...capped);
  if (capped.length) flags.push({ id: budgetHit || evalTakeHit ? 'fit_budget' : 'fit_capped', detail: `${capped.length} channel(s) not fitted (maxChannels ${opts.maxChannels || '-'}, workBudget ${opts.workBudget || '-'}${evalTakeHit ? `, evalBudget ${opts.evalBudget}` : ''})` });
  if (evalCut.length) flags.push({ id: 'fit_eval_budget', detail: `${evalCut.length} channel(s) cut mid-fit by the evaluation budget (channelEvalBudget ${opts.channelEvalBudget || '-'}, evalBudget ${opts.evalBudget || '-'}): recorded as unknown` });
  // the evaluation-budget fields appear only when that budget cut something, so a take it did not touch keeps its bytes
  const evalCap = evalCut.length || evalTakeHit ? { evalBudget: opts.evalBudget || null, channelEvalBudget: opts.channelEvalBudget || null, stepEvalBudget: opts.stepEvalBudget || null, evalUnits, evalBudgetHit: evalTakeHit, cutMidFit: evalCut } : {};
  const res = { schema: FIT_SCHEMA, partial: capped.length > 0 || evalCut.length > 0, capped: { maxChannels: opts.maxChannels || null, workBudget: opts.workBudget || null, workUnits: work.units, budgetHit, left: capped.length, ...evalCap }, takes: { primary: P.view.digest, probe: Q ? Q.view.digest : null, idle: I ? I.view.digest : null },
    env: { lane: P.view.lane, dtMs: P.dt, rateHz: P.view.rateHz, stride, probeDtMs: Q ? Q.dt : null, ...(hy ? { hybrid: { stride: HYBRID_STRIDE, fullRate: hy.refit, why: hy.why, note: 'fitted on every 2nd row; the channels listed in fullRate were fitted again on all rows and their records replace the 60 Hz ones' } } : {}) }, flags, records, stagger, pins, statics: { count: statics.length, sample: statics.slice(0, 50) }, pruned, unknowns: ledger };
  // diagnostics for calibration, not serialised
  Object.defineProperty(res, 'meterStats', { value: { evalUnits, maxChannel: maxChan, maxChannelKey: maxChanKey }, enumerable: false });
  return res;
}

/** A pinned element's box channel as ONE piecewise scroll map, or null when a sample breaks the identity (see the pin
 *  loop in fitTakeSetMetered). */
function pinRecord(pin, s, nf, P) {
  const sy = s.idx.map((i) => P.sy[i]); const tol = Math.max(2 / 64, nf.explainBar);
  const lo = pin.heldFrom_px, hi = pin.heldTo_px; let cB = null, cA = null, ok = true;
  for (let j = 0; j < s.y.length && ok; j++) { const x = sy[j], v = s.y[j]; if (!Number.isFinite(x)) continue;
    if (x >= lo && x <= hi) { ok = Math.abs(v - pin.screenY) <= tol; continue; }
    const c = v + x; if (x < lo) { if (cB == null) cB = c; ok = Math.abs(c - cB) <= tol; } else { if (cA == null) cA = c; ok = Math.abs(c - cA) <= tol; } }
  if (!ok) return null;
  const rec = baseRecord(s, nf, P); rec.tier = 'fitted'; rec.class = 'scroll map'; rec.model.family = 'pin (moves with the scroll, held over the pin range)';
  rec.model.pin = { start: pinStartAtTop(pin, sy), end: pin.end, held_px: pin.screenY, provenance: 'measured' }; rec.fit = { ...rec.fit, n: s.y.length, rms: 0, nrmse: 0, holdout: { method: 'none (exact piecewise identity)', pass: true } };
  rec.decidedBy = 'every sample is doc − offset outside the held range and the held value inside it';
  return rec;
}

/**
 * A pin held from the page top: the take starts at scroll 0 (the scroll minimum) with the element already held, so no
 * offset lies before the pin and findPins leaves the start unknown. The page cannot scroll above 0: the element is held
 * over every reachable offset from 0, which is the pin's start as the page behaves (a trigger start above the page top
 * holds the same way). Stated as 0 px, measured, with that reason; any other unknown start is left as it is.
 */
export function pinStartAtTop(pin, sy) {
  const st = pin.start;
  if (!st || st.value != null || pin.heldFrom_px !== 0) return st;
  const fin = (sy || []).filter(Number.isFinite); if (!fin.length || Math.min(...fin) < 0) return st;
  return { value: 0, ci95: [0, 0], provenance: 'measured', reason: 'held from the first offset of the take, the page top (scroll 0): the element is pinned over every offset the page can reach before it' };
}

/**
 * The pin's release on the element's translate y: two levels only, v0 up to the pin end and v0 + (end − start) after it
 * (both pin edges measured). Returns the reason text, or null.
 */
function pinRelease(pin, s, nf, P) {
  if (!(pin.start && pin.end && Number.isFinite(pin.start.value) && Number.isFinite(pin.end.value))) return null;
  const L = pin.end.value - pin.start.value; if (!(L > 0)) return null;
  const tol = Math.max(1, nf.explainBar || 0); const v0 = s.y[0];
  for (let j = 0; j < s.y.length; j++) {
    const x = P.sy[s.idx[j]]; if (!Number.isFinite(x)) continue; const v = s.y[j];
    const want = x < pin.end.value - 1 ? v0 : x > pin.end.value + 1 ? v0 + L : null;
    if (want == null ? !(Math.abs(v - v0) <= tol || Math.abs(v - v0 - L) <= tol) : Math.abs(v - want) > tol) return null;
  }
  return `the pin's release: translate y steps by the pin length (${+L.toFixed(1)} px) where the pin ends (${+pin.end.value.toFixed(1)} px of scroll), as a pin spacer leaves it`;
}

/**
 * A pin under the element's own vertical translate (look mode): the box y minus the element's ren:ty at the same row is
 * the layout box; findPins / pinRecord on that series. Null when the element has no ty series or no pin holds exactly.
 */
function ownPin(s, nf, P) {
  const ty = P.series.find((x) => x.el === s.el && x.ch === 'ren:ty'); if (!ty) return null;
  const tyAt = new Map(ty.idx.map((i, j) => [i, ty.y[j]]));
  const y = s.idx.map((i, j) => (tyAt.has(i) ? s.y[j] - tyAt.get(i) : NaN)); if (y.some((v) => !Number.isFinite(v))) return null;
  const rows = P.view.rows.map(() => ({ v: {} })); s.idx.forEach((i, j) => { rows[i].v[0] = { 'ren:by': y[j] }; });
  const pin = findPins({ rows, elements: [s.desc] }, P.sy)[0]; if (!pin) return null;
  const rec = pinRecord(pin, { ...s, y }, nf, P); if (!rec) return null;
  rec.model.pin.ownTranslateRemoved = true;
  rec.decidedBy = 'every sample of the box minus the element\'s own translate y is doc − offset outside the held range and the held value inside it';
  return rec;
}

/**
 * FLIP signature (M18): the element's layout box (bbox minus its translate) jumps by Δ at the motion onset while the
 * transform starts near −Δ and ends at identity — the layout moved instantly and the transform plays the inversion.
 */
function markFlip(P, records) {
  for (const r of records) {
    const axis = r.target.channel === 'ren:tx' ? ['ren:bx', 'ren:tx'] : r.target.channel === 'ren:ty' ? ['ren:by', 'ren:ty'] : null; if (!axis) continue;
    const el = r.target.el; const rows = P.view.rows; const t0 = r.derived && (r.derived.t0 ?? r.derived.visibleOnset); if (!Number.isFinite(t0)) continue;
    const lay = rows.map((row) => { const v = row.v[el]; return v && Number.isFinite(+v[axis[0]]) && Number.isFinite(+v[axis[1]]) ? +v[axis[0]] - +v[axis[1]] : null; });
    const tr = rows.map((row) => { const v = row.v[el]; return v ? +v[axis[1]] : null; });
    // every FLIP along the series (a declared record can hold several births: lab case M18 interrupted, a second FLIP
    // from the current position); r.flip is the one at the motion onset
    const flips = []; for (let i = 1; i < rows.length; i++) { if (lay[i] == null || lay[i - 1] == null || tr[i] == null) continue; const d = lay[i] - lay[i - 1];
      // the inversion keeps the VISUAL position (layout + transform) continuous across the layout jump: from rest that is
      // transform = −Δ; a FLIP interrupting a running one inverts from the current visual position instead (lab case M18
      // waapi interrupted: layout −440 px while the transform jumps to +381.8 px, not +440)
      const vis = tr[i - 1] != null ? Math.abs(lay[i] + tr[i] - (lay[i - 1] + tr[i - 1])) : Infinity;
      if (Math.abs(d) > 1 && (Math.abs(tr[i] + d) <= Math.max(2, 0.1 * Math.abs(d)) || vis <= Math.max(2, 0.1 * Math.abs(d)))) flips.push({ layoutDelta: d, inversion: tr[i], atFrame: rows[i].k, T: rows[i].T, provenance: 'measured' }); }
    if (flips.length > 1) r.flips = flips;
    const i0 = rows.findIndex((row) => row.T >= t0 - 1e-6); if (i0 < 1) continue;
    for (let i = Math.max(1, i0 - 2); i <= Math.min(rows.length - 1, i0 + 2); i++) {
      if (lay[i] == null || lay[i - 1] == null) continue; const d = lay[i] - lay[i - 1];
      if (Math.abs(d) > 1 && tr[i] != null && Math.abs(tr[i] + d) <= Math.max(2, 0.1 * Math.abs(d))) {
        const end = tr.filter((x) => x != null).at(-1);
        if (Math.abs(end) <= 0.5) { r.flip = { layoutDelta: d, inversion: tr[i], atFrame: rows[i].k, provenance: 'measured', evidence: 'layout box jumped by Δ while the transform started at −Δ and ended at identity' }; if (r.declared) r.declared.kind = 'flip'; r.subclass = 'flip'; }
        break;
      }
    }
  }
  // the other transform channels of a FLIP element (scale for the size change) play the same inversion: same kind
  // (lab case M18: sx/sy of the flipped box)
  for (const r of records) {
    if (r.flip || !/^ren:(sx|sy|rz|tz)$/.test(r.target.channel)) continue;
    const sib = records.find((q) => q.flip && q.target.el === r.target.el && Math.abs((q.derived.t0 ?? q.derived.visibleOnset ?? NaN) - (r.derived.t0 ?? r.derived.visibleOnset ?? NaN)) <= P.dt + 1e-6);
    if (sib) { r.flip = { ...sib.flip, via: sib.target.channel }; if (r.declared) r.declared.kind = 'flip'; r.subclass = 'flip'; }
  }
}

/** Known motion boundaries of a series from a take's discrete inputs (pointer release, click, isolated wheel). */
function inputCuts(X, s) {
  const isolatedWheel = (e) => e.kind === 'wheel' && !X.events.some((q) => q !== e && q.kind === 'wheel' && q.i >= 0 && q.i <= e.i && X.T[e.i] - X.T[q.i] <= 150 && q.i !== e.i);
  return X.events.filter((e) => (e.kind === 'pointerup' || e.kind === 'click' || isolatedWheel(e)) && e.i > 0).map((e) => s.idx.findIndex((i) => i >= e.i)).filter((j) => j > 0);
}

/** Driver = running sum of the wheel deltas the page received (input log); see the wheel block in fitSeries. */
function wheelDriver() {
  const rowOf = (PP) => { const evs = PP.events.filter((e) => e.kind === 'wheel' && e.i >= 0 && e.entry && Number.isFinite(e.entry.dy)).sort((a, b) => a.i - b.i); const row = new Array(PP.T.length).fill(0); let j = 0, acc = 0;
    for (let i = 0; i < PP.T.length; i++) { while (j < evs.length && evs[j].i <= i) { acc += evs[j].entry.dy; j++; } row[i] = acc; } return row; };
  const drvOf = (PP, ss) => { const row = rowOf(PP); return ss.idx.map((i) => row[i]); };
  drvOf.atFrame = (PP) => { const evs = PP.events.filter((e) => e.kind === 'wheel' && e.entry && Number.isInteger(e.entry.k) && Number.isFinite(e.entry.dy)).map((e) => e.entry).sort((a, b) => a.k - b.k);
    return (k) => { let acc = 0; for (const e of evs) { if (e.k < k) acc += e.dy; else break; } return acc; }; };
  drvOf.smoothingOnly = true;   // a wheel-retargeted tween (M05) is a time family, not a smoother of the delta sum
  return drvOf;
}

/**
 * Early exit for look / aim mode (opts.earlyExit; the lab and the corpus never set it): before the full driver fits, try
 * only the unsmoothed map against each input driver (scroll offset, wheel sum). When one explains the channel to the
 * explain bar, that driver's full fit short-circuits to the same map. Measured (spike, a scroll-scrubbed track):
 * the scroll-offset driver ran every smoothing law (9.8e7 frame evaluations, ~17 s) before the wheel driver found the
 * linear map at nrmse 1.8e-8.
 */
function instantDriver(s, nf, P, segs, ctx, mismatch, dec, scrollInputs) {
  const tries = [];
  if (P.events.some((e) => e.kind === 'scroll') && scrollInputs) tries.push({ drv: s.idx.map((i) => P.sy[i]), drvOf: null, kind: null });
  if (P.events.some((e) => e.kind === 'wheel' && e.i >= 0 && e.entry && Number.isFinite(e.entry.dy))) { const w = wheelDriver(); tries.push({ drv: w(P, s), drvOf: w, kind: 'wheel' }); }
  for (const t of tries) {
    const { out } = smoothingCandidates(s, t.drv, nf, { noneOnly: true });
    if (!out.some((c) => c && c.rms <= nf.explainBar)) continue;
    const drv = driverRecord(s, nf, P, segs, t.drv, ctx, true, mismatch, dec, t.drvOf);
    if (drv && drv.tier === 'fitted' && !drv.ambiguity) {
      if (t.kind === 'wheel') drv.model.driver = { kind: 'wheel', provenance: 'measured', note: 'running sum of the wheel deltas the page received (input log)' };
      drv.flags.push({ id: 'early_exit', detail: 'look mode: the unsmoothed map explains the channel; smoothing laws not tried' });
      return drv;
    }
  }
  return null;
}

/**
 * Look, native scroll (opts.earlyExit; D-SCROLLBUDGET-1): the cheap stages before the full driver search (smoothingCandidates
 * runs every law × map shape × lag × snap: 2.6–3.0e8 frame evaluations per channel on a real page, where 13 of 16 channels
 * were time tweens a scroll merely started and the search could not explain any of them).
 *  1. a smoothed progress another channel of this take identified (a scrubbed timeline): this channel's map on it;
 *  2. a probe: the held targets' unsmoothed map and one first-order law (EMA, lag 0, one start) on the three best map
 *     seeds (2e5–2e6 evaluations). Past SCRUB_NEAR × the explain bar no smoother of this driver is near: {far}, the
 *     full search is skipped and the time families decide (a tween the scroll only started);
 *  3. (scroll offset only) the scrubbed-timeline smoother seeded from the probe (timelineScrub);
 * otherwise {near} within PROBE_NEAR (the caller runs the full search as before, under opts.driverBudget), else {far}.
 * Returns {rec} when a stage explains the channel.
 */
// PROBE_NEAR: the full driver search runs only when the probe comes this close (× the explain bar). SCRUB_NEAR: the
// scrubbed-timeline fit is tried up to this far, because the probe's smoother of the child's own clamped map rounds off
// the corner where the smoothed progress crosses the child's end (own fixture scrub-native, a child filling 90 % of its
// timeline: 7.5x; a real page's rail at 99.5 %: 1.7-2.4x), while time tweens a scroll only started read 25-150x.
const PROBE_NEAR = 3, SCRUB_NEAR = 10, SPRING_NEAR = 20;
function lookDriver(s, nf, P, segs, drv, ctx, allAligned, mismatch, dec, drvOf) {
  if ((P.timing.strideInt || 1) > 1) return null;   // page-frame grid (R6): the full search handles the stride
  const shared = ctx.shared || { scrubs: [] }; const bar = nf.explainBar;
  const record = (cands, how) => {
    const rec = driverRecord(s, nf, P, segs, drv, { ...ctx, candidates: cands }, allAligned, mismatch, dec, drvOf);
    if (!rec || rec.tier !== 'fitted' || rec.ambiguity) return null;
    rec.flags.push({ id: 'early_exit', detail: how }); return rec; };
  // 1. shared smoothed progress (scroll offset only): seed the map from the (progress, value) pairs of every frame
  meter.where = 'shared scrub progress';
  if (!drvOf) for (const sp of shared.scrubs) {
    const prog = sp.series(s); const pairs = prog.map((q, k) => ({ s: q, y: s.y[k] })).filter((q) => Number.isFinite(q.s));
    // a child of the same timeline is an instant map of the smoothed progress: the (progress, value) pairs say so
    // before any simulation (an unrelated channel ends here for the cost of the pair fits)
    const maps = Object.keys(MAP_SHAPES).map((sh) => fitMapShape(sh, pairs, nf.sigma, { gridN: 16 })).filter((m) => m && Math.sqrt(m.rss / pairs.length) <= PROBE_NEAR * bar).sort((a, b) => a.rss - b.rss).slice(0, 2);
    for (const m of maps) {
      const c = timelineScrub(s, drv, nf, { lag: sp.lag, map: { shape: m.shape, a: m.p[0], b: m.p[1], s0: m.p[2], s1: m.p[3] } }, { fixed: sp, shapes: [m.shape] }).filter((r) => r.rms <= bar);
      if (c.length) { const rec = record(c, 'look mode: this channel maps the smoothed scroll progress another channel identified (same scrubbed timeline); full driver search not run'); if (rec) return { rec }; }
    }
  }
  // 2. probe
  meter.where = 'scroll driver probe';
  // (no earlyExit: the unsmoothed maps were tried by instantDriver just before; the probe's own 'none' per seed stays)
  const { out } = smoothingCandidates(s, drv, nf, { probe: true });
  const best = out.filter((c) => c && Number.isFinite(c.rms)).sort((a, b) => a.rms - b.rms)[0];
  const ratio = best ? best.rms / bar : Infinity;
  if (ratio > SCRUB_NEAR) return { far: true, ratio };
  if (ratio <= 1) return { near: true, ratio };   // a probe candidate already explains: the full search decides among the laws as before
  // 3. scrubbed timeline, seeded from the best smoother of the probe (EMA α → restarted expo.out L = 10·dt·ln 2 / −ln(1 − α))
  if (!drvOf) {
    // seeds: the best EMA of each map shape, best first (up to three). The single best one can be a degenerate seed whose
    // smoother absorbs the curve (a hero fading 1 -> 0 over 0 -> 900 px with scrub 1 s: the best probe EMA was easeInCubic
    // with its start 12000 px before the page top, and the timeline fit from it found nothing; the linear seed explains)
    const emas = out.filter((c) => c && c.law === 'ema' && c.map && c.prm && c.prm.alpha > 0 && c.prm.alpha < 1).sort((a, b) => a.rms - b.rms);
    const seeds = emas.filter((c, i) => emas.findIndex((q) => q.mapShape === c.mapShape) === i).slice(0, 3);
    let sm = null, cands = [];
    for (const c of seeds) {
      meter.where = 'scrubbed timeline';
      const dtF0 = P.view.dtPage || P.dt; const L0 = (10 * dtF0 * Math.LN2) / -Math.log(1 - c.prm.alpha);
      cands = timelineScrub(s, drv, nf, { lag: c.lag, L: L0, map: { shape: c.mapShape, a: c.map.a, b: c.map.b, s0: c.map.s0, s1: c.map.s1 } }).filter((r) => r.rms <= bar);
      if (cands.length) { sm = c; break; }
    }
    if (sm) {
      const dtF = P.view.dtPage || P.dt;
      // a scrub of at most two frames is an unsmoothed map in this family's clothes (own fixture index.html #track, a held
      // instant map the probe ranked 4.8x): the full search decides it, as before
      if (cands.length && cands[0].prm.L <= 2 * dtF) return { near: true, ratio };
      if (cands.length) {
        const rec = record(cands, 'look mode: a scrubbed timeline (restarted expo.out on the clamped scroll progress, then the map) explains the channel; full driver search not run');
        if (rec) {
          const pg = cands.find((c) => c.family === rec.model.family) || cands[0]; const g = pg.progress;
          if (!g.shared) shared.scrubs.push({ ...g, series: (ss) => { const syS = ss.idx.map((i) => P.sy[i]); const gg = syS.map((_, k) => { const x = syS[Math.max(0, k - g.lag)]; return Number.isFinite(x) ? Math.min(g.c1, Math.max(g.c0, x)) : NaN; });
            return simulateSmootherExt('restarted', { L: g.L, delay: g.delay, E: NAMED['expo.out'].fn }, gg, ss.T, gg.find(Number.isFinite) ?? 0); } });
          return { rec };
        }
      }
    }
  }
  return ratio > PROBE_NEAR ? { far: true, ratio } : { near: true, ratio };
}

/** The document root's vertical box (html / body): it rides the scroll offset itself, so it is the page scroll line. */
const isRootBox = (s) => s.ch === 'ren:by' && /^(HTML|BODY)\b/.test(String(s.desc || ''));

const PAGE_SCROLL_DRIVER = Object.freeze({ kind: 'scroll', provenance: 'measured', pageOwned: true, note: 'the page scroll offset, which the page moves itself (smooth scroller: the wheels are prevented); the wheel reaches it through the page smoothing (see the page line)' });

/** Fit one moving series → one or more records. */
function fitSeries(s, nf, ctx) {
  const driverCuts = []; const out = fitSeriesCore(s, nf, { ...ctx, driverCuts });
  if (driverCuts.length) for (const r of out) r.flags.push(...driverCuts);
  return out;
}
function fitSeriesCore(s, nf, ctx) {
  const { P, Q, opts, scrollMoved } = ctx;
  // discrete pointer inputs (release, click) are known boundaries: what follows is a new motion (M10 release, M19 click)
  // an isolated wheel (no other wheel in the 150 ms before) is a discrete input too (lab case M05 retarget: a wheel lands
  // mid-tween and restarts it from the current value)
  const cuts = inputCuts(P, s);
  const segs = segment(s, nf, { cuts }); const movingFrames = segs.reduce((a, g) => a + g.movingFrames, 0);
  // declared scroll/view-timeline animation (design §3; lab case M11): read from the declared snapshots, checked
  // against the samples as a function of the scroll position
  const sdec = scrollDeclared(P, s, nf); if (sdec) return [sdec];
  const smil = smilDeclared(P, s, nf); if (smil) return [smil];
  // declared tier (§3)
  const dec = checkDeclared(P.view, s, nf);
  if (dec && dec.explains) return [declaredRecord(s, nf, P, dec, ctx)];
  if (ctx.declaredOnly) return [];
  const mismatch = dec && !dec.scrollTimeline ? { id: 'declared_mismatch', detail: `declared model rms ${dec.rms.toExponential(2)} > explain bar ${nf.explainBar.toExponential(2)}; fitted as undeclared` } : null;
  // driver families when the scroll changed and the bursts follow it (before the step/periodic shortcuts: a scroll map
  // answers each scroll jump with a one-frame change; lab case M01)
  // alignment is judged on bursts: a quantised smoother's tail moves in steps separated by still frames (lab case M04
  // toFixed(3)), which are continuations of the response, not new motions (segments < 300 ms apart join one burst)
  const bursts = []; for (const g of segs) { const last = bursts.at(-1); if (last && s.T[g.b] - s.T[last.e] < 300) last.e = g.e; else bursts.push({ b: g.b, e: g.e }); }
  const aligned = bursts.filter((g) => P.events.some((e) => e.kind === 'scroll' && e.i <= s.idx[g.b] && s.idx[g.b] - e.i <= 2)).length;
  const sySeries = s.idx.map((i) => P.sy[i]);
  // the scroll offset is a driver only when an input moved it (a recorder scrollTo, or wheels the page let through);
  // a page that prevents its wheels and scrolls the window itself makes the offset an OUTPUT (lab case M09b scroller)
  // … except for the page's own box (html / body y), which IS the offset (y = −offset): the offset explains it trivially and
  // says nothing (a Lenis page read as "box y scrubbed linearly with the page scroll"). Its law is the page smoothing
  // between the wheel input and the offset, so the wheel sum is its only driver
  const rootBox = isRootBox(s);
  const scrollInputs = !rootBox && ((P.view.inputLog || []).some((e) => e.type === 'scrollTo') || (P.view.wheel || []).some((w) => w.prevented === false));
  // look mode, a page that owns its scroll (a smooth scroller such as Lenis prevents the wheels and moves the window
  // itself): the offset is the scroller's OUTPUT, yet a scrubbed element (ScrollTrigger and the like read the offset
  // the scroller wrote) is a function of exactly that offset. So the offset is tried as a driver too, before the wheel
  // sum, for every channel but the boxes (a box riding the page IS the offset). The smoothing between the wheel and the
  // offset is the page line's own fit (the root box against the wheel sum). The lab and the corpus (no earlyExit) keep
  // the M09b reading, where the offset is an output only.
  const pageScroll = !!opts.earlyExit && scrollMoved && !scrollInputs && !/^ren:b[xywh]$/.test(s.ch) && (P.view.wheel || []).some((w) => w.prevented === true);
  if (opts.earlyExit && scrollMoved) meter.where = 'instant maps';
  if (opts.earlyExit && scrollMoved) { const drv = instantDriver(s, nf, P, segs, ctx, mismatch, dec, scrollInputs || pageScroll); if (drv) { if (pageScroll && !drv.model.driver) drv.model.driver = { ...PAGE_SCROLL_DRIVER }; return [drv]; } }
  if (pageScroll && aligned >= 1) {
    const drv = driverRecord(s, nf, P, segs, sySeries, { ...ctx, lean: true }, aligned === bursts.length, mismatch, dec);
    if (drv && drv.tier === 'fitted') { drv.model.driver = { ...PAGE_SCROLL_DRIVER }; return [drv]; }
  }
  // look, native scroll (earlyExit; D-SCROLLBUDGET-1): cheapest first. A smoothed progress another channel identified,
  // then a one-law probe that says whether any smoother of the offset comes near; the full driver search only when it does
  const cheap = (drv, drvOf, allAl) => (opts.earlyExit && !ctx.forceClass && ctx.forceLag == null ? lookDriver(s, nf, P, segs, drv, ctx, allAl, mismatch, dec, drvOf) : null);
  // … and the full driver search runs under a stage budget (opts.driverBudget, look): cut, it yields to the time families
  // (a tween the scroll merely started) instead of spending the channel; the record says the driver search was cut
  const { driverCuts } = ctx; let scrollProbe = null;
  const full = (drv, drvOf, allAl) => {
    meter.where = 'driver search';
    if (!opts.earlyExit || !(opts.driverBudget > 0)) return driverRecord(s, nf, P, segs, drv, ctx, allAl, mismatch, dec, drvOf);
    let r = null;
    const used = withStage(opts.driverBudget, (cut) => { try { r = driverRecord(s, nf, P, segs, drv, ctx, allAl, mismatch, dec, drvOf); } catch (e) { if (!(e instanceof FitBudgetError && e.budget === 'stage') && !cut()) throw e; r = null; } });
    if (used > opts.driverBudget) driverCuts.push({ id: 'driver_search_cut', detail: `look: the ${drvOf ? 'wheel-sum' : 'scroll-offset'} driver search reached its stage budget (${opts.driverBudget} frame evaluations) without an explanation; the time families decide` });
    return r; };
  // look, page-owned scroll: the lean search above smooths the offset itself, while a ScrollTrigger scrub smooths the
  // CLAMPED progress of its trigger range (on a fast wheel the smoothed progress crosses the range end long after the
  // offset did: a hero fading over 600 → 1500 px with scrub 0.6 read "only a piecewise time curve fits"); the scrubbed-
  // timeline stages run on the offset too (a progress another channel identified, the probe, the timeline fit)
  if (pageScroll && aligned >= 1) { const c = cheap(sySeries, null, aligned === bursts.length); if (c && c.rec) { if (!c.rec.model.driver) c.rec.model.driver = { ...PAGE_SCROLL_DRIVER }; return [c.rec]; } }
  if (scrollMoved && scrollInputs && aligned >= Math.max(1, Math.ceil(bursts.length / 2))) {
    const c = cheap(sySeries, null, aligned === bursts.length); if (c && c.rec) return [c.rec]; if (c) scrollProbe = c.ratio;
    const drv = c && c.far ? null : full(sySeries, null, aligned === bursts.length);
    if (drv) return [drv];
  } else if (scrollMoved && scrollInputs && aligned >= 1 && nf.quantum) {
    // a quantised slow tail moves in single-quantum steps far apart (lab case M02 write q2 gap at R4: α 0.08 at 30 Hz,
    // a 0.01 step every 130–500 ms), so most bursts start away from any input; the driver families are still tried and
    // kept only when one of them explains the whole series unambiguously
    const c = cheap(sySeries, null, false); if (c && c.rec) return [c.rec]; if (c) scrollProbe = c.ratio;
    const drv = c && c.far ? null : full(sySeries, null, false);
    if (drv && drv.tier === 'fitted' && !drv.ambiguity && drv.fit && drv.fit.rms <= nf.explainBar) return [drv];
  }
  // pointer driver (design §4.5 "smoothing on a driver … pointer"; lab case M13): when the bursts follow pointer input,
  // the driver is the last pointer coordinate the page received on the channel's axis (held between events)
  const ptrEv = P.events.filter((e) => e.kind === 'pointer' && e.i >= 0 && e.entry && Number.isFinite(e.entry.x) && Number.isFinite(e.entry.y));
  if (ptrEv.length) {
    const alignedP = segs.filter((g) => ptrEv.some((e) => e.i <= s.idx[g.b] && s.idx[g.b] - e.i <= 2)).length;
    if (alignedP >= Math.max(1, Math.ceil(segs.length / 2))) {
      const axis = /(ty|by|bh|top|:y)$/.test(s.ch) ? 'y' : 'x';
      const drvOf = (PP, ss) => { const row = pointerDriverRow(PP, axis); return ss.idx.map((i) => row[i]); };
      // per page frame (R6 stride): the latest pointer coordinate received after a frame before k
      drvOf.atFrame = (PP) => { const evs = PP.events.filter((e) => e.kind === 'pointer' && e.entry && Number.isInteger(e.entry.k) && Number.isFinite(e.entry[axis])).map((e) => e.entry).sort((a, b) => a.k - b.k);
        return (k) => { let v = NaN; for (const e of evs) { if (e.k < k) v = e[axis]; else break; } return v; }; };
      const drv = driverRecord(s, nf, P, segs, drvOf(P, s), ctx, alignedP === segs.length, mismatch, dec, drvOf);
      if (drv) {
        drv.model.driver = { kind: 'pointer', axis, provenance: 'measured', note: 'last pointer coordinate the page received (input log), held between events' };
        // an output that only ever takes two values is a switch the pointer input triggers (a hover state), not a value
        // linked to the pointer coordinate: no 'pointer-linked … linear' map and no inverted ramp for it (open item of
        // 20 Oct: an instant change coinciding with the pointer entering was worded as a pointer-linked map)
        if (drv.class === 'scroll map' && new Set(s.y).size === 2) {
          drv.class = 'step'; drv.model.family = 'step (two-level, on pointer input)';
          drv.model.params = { ...drv.model.params, before: { value: s.y[0], provenance: 'measured' }, after: { value: s.y[s.y.length - 1], provenance: 'measured' } };
        }
        return [drv];
      }
    }
  }
  // wheel driver (design §4.5 "… wheel"; lab case M09 Lenis): the target is the running sum of the wheel deltas the
  // page received (the map's clamp covers the document limits); bursts must follow wheel input
  // (not for a channel of a page that owns its scroll, look mode: the wheel reaches the page through its offset, which
  // was tried above; the unsmoothed wheel map was tried in instantDriver. The full wheel fit cost ~1e8 evaluations per
  // time tween the scroll triggers, on a Lenis + GSAP pinned-rail page)
  const whEv = pageScroll ? [] : P.events.filter((e) => e.kind === 'wheel' && e.i >= 0 && e.entry && Number.isFinite(e.entry.dy));
  if (whEv.length) {
    const burstsW = []; for (const g of segs) { const last = burstsW.at(-1); if (last && s.T[g.b] - s.T[last.e] < 300) last.e = g.e; else burstsW.push({ b: g.b, e: g.e }); }
    const alignedW = burstsW.filter((g) => whEv.some((e) => e.i <= s.idx[g.b] && s.idx[g.b] - e.i <= 2)).length;
    if (alignedW >= Math.max(1, Math.ceil(burstsW.length / 2))) {
      const drvOf = wheelDriver();
      // on a page that lets its wheels scroll natively the wheel sum IS the offset until the page bottom: its full search
      // runs only when its probe is near AND clearly better than the offset's (the page reads the wheel itself). On a real page:
      // a tween started at the bottom read 2.7x on the wheel sum against 3.5x on the offset and spent the stage for nothing
      const c = scrollInputs && Number.isFinite(scrollProbe) && scrollProbe <= PROBE_NEAR ? { far: true } : cheap(drvOf(P, s), drvOf, alignedW === burstsW.length);
      if (c && !c.far && scrollInputs && Number.isFinite(scrollProbe) && !(c.ratio <= 0.5 * scrollProbe)) c.far = true;
      const drv = c && c.far ? null : full(drvOf(P, s), drvOf, alignedW === burstsW.length);
      if (drv) { drv.model.driver = { kind: 'wheel', provenance: 'measured', note: 'running sum of the wheel deltas the page received (input log)' }; return [drv]; }
    }
  }
  // U1 (after the driver families)
  if (meter.where === 'driver search' || meter.where === 'scroll driver probe' || meter.where === 'instant maps') meter.where = 'time families (setup)';
  // a regular train of one-frame changes is a periodic tick, not a run of unrelated steps (lab case M20 1 Hz tick)
  // … but a train whose one-frame changes all go one way is a quantised ramp (a staircase: a typed-text counter, lab case
  // M12 at R3), not a tick: a periodic output revisits its values
  const monotone = (() => { let up = 0, dn = 0; for (let i = 1; i < s.y.length; i++) { const d = s.y[i] - s.y[i - 1]; if (d > 0) up++; else if (d < 0) dn++; } return !(up && dn); })();
  if (segs.length >= 3 && segs.every((g) => g.movingFrames === 1) && !monotone) { const per0 = fitPeriodic(s, nf.sigma); if (per0) return [periodicRecord(baseRecord(s, nf, P), per0, s)]; }
  if (segs.length >= 3 && segs.every((g) => g.movingFrames === 1) && monotone) {
    const last = segs.at(-1); const merged = { ...segs[0], e: last.e, w1: last.w1, movingFrames: segs.reduce((a, g) => a + g.movingFrames, 0), settled: last.settled };
    const rec = timeRecord(s, nf, P, merged, ctx, mismatch, dec); if (rec && rec.tier === 'fitted') return [rec];
  }
  if (movingFrames < 8 && segs.length && segs.every((g) => g.movingFrames === 1)) return segs.map((g) => stepRecord(s, nf, P, g));
  if (movingFrames < 8) { const rec = baseRecord(s, nf, P); rec.tier = 'unknown'; rec.class = 'unknown'; rec.fit.n = movingFrames;
    const per = fitPeriodic(s, nf.sigma); if (per) return [periodicRecord(rec, per, s)];
    unk(rec, 'unk_too_few_samples', `${movingFrames} moving frames (< 8)`, 'longer take / denser input'); return [rec]; }
  // periodic tick
  const per = monotone ? null : fitPeriodic(s, nf.sigma); if (per && segs.length >= 3) return [periodicRecord(baseRecord(s, nf, P), per, s)];
  // time families per segment
  const out = []; let startJump = null;
  const segList = segs.slice(0, opts.maxSegments || 24);
  for (const [q, seg] of segList.entries()) {
    const amp = Math.max(...s.y.slice(seg.w0, seg.w1 + 1)) - Math.min(...s.y.slice(seg.w0, seg.w1 + 1));
    if (amp <= nf.explainBar) continue;                                     // below the explain bar: not a motion
    // a one-frame jump that a motion continues from in the very next frame is that motion's start (a FLIP inversion,
    // a tween that starts away from rest; lab case M18 rAF): one record, the jump kept as model.startJump
    const next = segList[q + 1];
    if (seg.movingFrames === 1 && next && next.b === seg.e + 1 && next.movingFrames >= 8) { startJump = { from: s.y[seg.b - 1], to: s.y[seg.b], at: s.T[seg.b], provenance: 'measured' }; continue; }
    if (seg.movingFrames === 1) { const st = stepRecord(s, nf, P, seg); st._seg = seg; out.push(st); continue; }
    if (seg.movingFrames < 8) { const rec = baseRecord(s, nf, P); rec.tier = 'unknown'; rec.class = 'unknown'; rec.fit.n = seg.movingFrames; rec.derived = { t0: s.T[seg.b - 1] ?? s.T[seg.b] };
      rec.evidence.location = { kind: 'time_range', range: [s.T[seg.w0], s.T[seg.w1]] }; unk(rec, 'unk_too_few_samples', `${seg.movingFrames} moving frames (< 8, U1)`, 'longer take / denser input / a slower rate'); rec._seg = seg; rec._few = true; out.push(rec); continue; }
    const rec = timeRecord(s, nf, P, seg, ctx, mismatch, dec); rec._seg = seg;
    if (startJump) { rec.model.startJump = startJump; startJump = null; }
    // a motion that starts at an input boundary while the previous one was still moving was retargeted by that input
    const prev = segList[q - 1];
    if (cuts.includes(seg.b) && prev && prev.e === seg.b - 1 && seg.b >= 2 && !(rec.model.retargets && rec.model.retargets.length)) {
      const v = (i) => (s.y[i] - s.y[i - 1]) / (s.T[i] - s.T[i - 1]); const vb = v(seg.b - 1), va = v(seg.b);
      const velCont = Math.abs(va - vb) <= 0.25 * Math.max(Math.abs(va), Math.abs(vb), 1e-12);
      rec.model.retargets = [{ at: s.T[seg.b - 1], semantics: velCont ? 'velocity-carry' : 'from-current', positionContinuous: true, velocityContinuous: velCont, provenance: 'measured', evidence: 'a pointer/click input split the motion; the new motion starts where the old one was' }];
    }
    out.push(rec);
  }
  // sequence consistency (lab case M19 retarget: an interrupted easeOutExpo IS an exponential decay — it never reaches
  // its end — so alone it is ambiguous with smoothing toward a constant; the next segment of the same channel completes
  // and identifies the named ease): an ambiguous segment whose rivals include the named ease another segment of this
  // channel was decided as is that ease
  // The same holds for a free bezier (lab case M18 rAF FLIP interrupted at R4: the cut-short first segment has too few
  // frames for a 4-control-point fit, the completed second one has it): the decided shape is fitted with free t0, D
  const shapeKey = (r) => (/^named:/.test(r.model.family) ? r.model.family : r.model.bezier ? 'bezier:' + r.model.bezier.map((v) => v.toFixed(3)).join(',') : null);
  // decided = a fitted tween whose segment completed (settled); an interrupted one leaves its ease weakly identified
  let decided = out.filter((r) => r.tier === 'fitted' && r.class === 'tween' && shapeKey(r) && r._seg && r._seg.settled);
  // no segment completed (every one interrupted by the next input), but two or more interrupted segments were each fitted
  // as the SAME named ease, unambiguously: that agreement decides the shape (lab case M05 retarget g4 at R4: the take
  // ends inside the third tween; the two complete-enough ones are both easeOutCubic, D 1060 ms)
  if (!decided.length) { const fitted = out.filter((r) => r.tier === 'fitted' && r.class === 'tween' && !r.ambiguity && /^named:/.test(r.model.family || '') && r._seg);
    const fams = new Set(fitted.map(shapeKey)); if (fitted.length >= 2 && fams.size === 1) decided = fitted; }
  const keys = new Set(decided.map(shapeKey));
  if (keys.size === 1) {
    const d = decided[0]; const named = /^named:/.test(d.model.family);
    const sib = { family: d.model.family, label: named ? d.model.family : `bezier (shared with another segment of this channel)`, named, fn: named ? null : cubicBezier(...d.model.bezier), bezier: d.model.bezier };
    for (const [j, r] of out.entries()) {
      // U1 segments too (lab case M05 retarget at R4: the wheel retargets a 320 ms tween after 5 frames): with the shape
      // fixed by the other segment only t0, D and the end point are free (≥ 4 moving frames)
      // … and an interrupted segment fitted as ANOTHER named ease (lab case M19 retarget g3: an easeInOutCubic cut before
      // p = 0.5 is exactly an easeInCubic of another duration; the completed segment names the ease)
      const otherEase = r.tier === 'fitted' && r.class === 'tween' && r._seg && !r._seg.settled && shapeKey(r) && shapeKey(r) !== shapeKey(d);
      if (!r._seg || !(r.ambiguity || r.tier === 'unexplained' || (r._few && r._seg.movingFrames >= 4) || otherEase)) continue;
      const r2 = timeRecord(s, nf, P, r._seg, { ...ctx, sibling: sib }, mismatch, dec); if (r2 && !r2.ambiguity && r2.tier === 'fitted') { if (r.model.startJump) r2.model.startJump = r.model.startJump; if (r.model.retargets) r2.model.retargets = r2.model.retargets || r.model.retargets; out[j] = r2; }
    }
  }
  // a one-frame jump continued in the very next frame by an unexplained motion is that motion's start, not a separate
  // step (lab case M16b jitter at R6: the first jitter sample read as a step from rest)
  for (let j = out.length - 2; j >= 0; j--) {
    const a = out[j], b = out[j + 1];
    if (a.class === 'step' && a._seg && b._seg && (b.tier === 'unexplained' || b.class === 'unknown') && (b._seg.b === a._seg.e + 1 || (b.model.startJump && b._seg.b === a._seg.e + 2))) {
      b.model.startJump = { from: s.y[a._seg.b - 1], to: s.y[a._seg.b], at: s.T[a._seg.b], provenance: 'measured' }; out.splice(j, 1); }
  }
  for (const r of out) { delete r._seg; delete r._few; }
  // look, a page that owns its scroll: a piecewise time curve on a channel that moves while the page scrolls is a
  // description of the samples, not of the mechanism (a hero on a Lenis + GSAP pinned-rail page: a scrub 0.35 on a map that starts at scroll 0 came
  // within 1.3x of the noise bar as a smoother of the offset, and the time families then "explained" it piecewise).
  // Reported as unknown with the probe instead of a fitted tween
  if (pageScroll) for (const r of out) if (r.tier === 'fitted' && r.model.family === 'piecewise') {
    r.tier = 'unexplained'; r.class = 'unknown';
    r.unknowns.unshift({ id: 'unk_scroll_piecewise', reason: 'moves while the page scrolls (its own smooth scroll); only a piecewise time curve fits it, no scroll-linked law explains it within the noise', probe: 'a slower scroll, or look --el on it' });
  }
  if (segs.length > (opts.maxSegments || 24)) { const r = out.at(-1); unk(r, 'unk_segments_capped', `${segs.length} segments, first ${opts.maxSegments || 24} fitted`, 'raise maxSegments'); }
  return out;
}

/**
 * A scroll- or view-timeline animation listed in the declared snapshots: progress is a function of the scroll offset,
 * so the declared easing (effect easing ∘ keyframe easing) is fitted as a scroll map; the range in px is measured from
 * the samples and the declared range (rangeStart/rangeEnd) is reported as read. Null when none applies or it does not
 * explain the samples.
 */
function scrollDeclared(P, s, nf) {
  const list = []; const seen = new Set();
  for (const snap of P.view.declared || []) for (const a of snap.list || []) {
    if (!a.timeline || a.timeline === 'document' || a.timeline === 'none' || !descMatch(a.tgt, s.desc)) continue;
    const props = declaredProps(s.ch); if (!(a.keyframes || []).some((kf) => Object.keys(kf).some((k) => props.includes(k)))) continue;
    const key = `${a.name}|${a.tgt}|${a.type}`; if (seen.has(key)) continue; seen.add(key); list.push(a);
  }
  if (list.length !== 1 || (list[0].keyframes || []).length !== 2) return null;
  const a = list[0]; const eff = parseEasing(a.easing) || ((x) => x); const kfE = parseEasing(a.keyframes[0].easing) || ((x) => x);
  const fn = (u) => kfE(eff(u));
  const sy = s.idx.map((i) => P.sy[i]); const byS = new Map(); let spread = 0;
  s.y.forEach((v, j) => { if (!byS.has(sy[j])) byS.set(sy[j], v); else spread = Math.max(spread, Math.abs(byS.get(sy[j]) - v)); });
  // the samples must be a pure function of the scroll offset (one value per offset, no lag): else it is not this animation
  if (spread > nf.explainBar) return null;
  const pairs = [...byS.entries()].map(([sv, yv]) => ({ s: sv, y: yv }));
  const kv = (kf) => { const c = s.ch.replace(/^ren:/, ''); if (c === 'opacity' && kf.opacity != null) return parseFloat(kf.opacity);
    const t = String(kf.transform || ''); const mm = /translateX\(([-\d.e+]+)px\)/.exec(t) || /translate\(([-\d.e+]+)px/.exec(t); if (c === 'tx' && mm) return parseFloat(mm[1]); if (c === 'tx' && t === 'none') return 0; return null; };
  let m = pairs.length >= 5 ? fitMapShape({ fn }, pairs, nf.sigma) : null; let pairsInner = null;
  if (m && m.rms > nf.explainBar) { if (pairs.length >= 12) return null; m = null; }   // few offsets: the 4-parameter range is not identifiable
  if (!m) {
    // with the declared keyframe values the range needs only two offsets inside it: invert the declared easing at each
    // interior sample (progress p) and regress the offset on p (s = s0 + p·(s1 − s0))
    const v0 = kv(a.keyframes[0]), v1 = kv(a.keyframes[1]);
    if (Number.isFinite(v0) && Number.isFinite(v1) && v1 !== v0) {
      const inv = (u) => { let lo = 0, hi = 1; for (let q = 0; q < 60; q++) { const mid = (lo + hi) / 2; if (fn(mid) < u) lo = mid; else hi = mid; } return (lo + hi) / 2; };
      const pts = pairs.map((q) => ({ s: q.s, u: (q.y - v0) / (v1 - v0) })).filter((q) => q.u > 1e-4 && q.u < 1 - 1e-4).map((q) => ({ s: q.s, p: inv(q.u) }));
      if (pts.length >= 2) { const sol = ols(pts.map((q) => [1, q.p]), pts.map((q) => q.s)); if (sol) { const s0 = sol.beta[0], s1 = sol.beta[0] + sol.beta[1]; m = { p: [v0, v1 - v0, s0, s1], rms: Math.sqrt(sol.rss / pts.length), viaKeyframes: pts.length }; } }
    }
  }
  // the range needs ≥ 2 distinct offsets strictly inside it (values strictly between the two plateaus): with one, the
  // corners trade off along the declared curve through that point (lab case M11 gap trace, range 950–1250 px with only
  // 1100 px inside; the fit returned 900/1300 exactly)
  if (m) { const lo = Math.min(m.p[2], m.p[3]), hi = Math.max(m.p[2], m.p[3]); const A0 = Math.min(m.p[0], m.p[0] + m.p[1]), A1 = Math.max(m.p[0], m.p[0] + m.p[1]); const tolv = Math.max(nf.explainBar, 1e-6 * Math.abs(m.p[1]));
    const inner = pairs.filter((q) => q.s > lo && q.s < hi && q.y > A0 + tolv && q.y < A1 - tolv).length;
    if (inner < 2) { m = null; pairsInner = inner; } }
  const rec = baseRecord(s, nf, P); rec.tier = 'declared'; rec.class = 'declared';
  const kind = a.type === 'CSSAnimation' || a.type === 'CSSTransition' ? 'css' : 'waapi';
  const rg = (r) => (r == null ? null : typeof r === 'string' ? r : `${r.name} ${r.offset}`);
  rec.model.family = `declared:${kind} scroll-timeline`;
  rec.model.params = { easing: pv(canonicalEasing(a.easing || 'linear'), 'declared'), keyframeEasing: pv(canonicalEasing(a.keyframes[0].easing || 'linear'), 'declared'), rangeStart: pv(rg(a.rangeStart), 'declared'), rangeEnd: pv(rg(a.rangeEnd), 'declared'), fill: pv(a.fill, 'declared') };
  rec.model.map = m ? { shape: 'declared easing', a: m.p[0], b: m.p[1], s0_px: m.p[2], s1_px: m.p[3], s0_ci95: m.params && m.params.s0 ? m.params.s0.ci95 : null, s1_ci95: m.params && m.params.s1 ? m.params.s1.ci95 : null, provenance: 'measured', note: 'range in scroll px measured from the samples (the declared range is relative to the subject box)' }
    : { shape: 'declared easing', s0_px: null, s1_px: null, provenance: 'unknown', reason: pairsInner != null ? `${pairsInner} distinct offset(s) inside the range: the corners are not identifiable` : `${pairs.length} distinct scroll offsets sampled: too few to measure the range`, probe: 'a dense scroll sweep through the range' };
  // the corners are not identified: report the set of ranges that reproduce every sampled offset (Amendment 2 B)
  if (!m) { const v0 = kv(a.keyframes[0]), v1 = kv(a.keyframes[1]);
    if (Number.isFinite(v0) && Number.isFinite(v1) && v1 !== v0) { const r = mapRidge({ a: v0, b: v1 - v0, S: fn, linear: false, pairs, tolv: Math.max(nf.explainBar, 1e-6 * Math.abs(v1 - v0)) });
      if (r) { rec.model.map.s0_interval = r.s0; rec.model.map.s1_interval = r.s1; rec.model.map.ridge = r.case; } } }
  rec.declared = { kind, timeline: a.timeline, timelineInfo: a.timelineInfo || null, rangeStart: rg(a.rangeStart), rangeEnd: rg(a.rangeEnd), scrollTimeline: true, confirmed: !!m, births: [{ type: a.type, name: a.name, easing: a.easing, keyframes: a.keyframes, provenance: 'declared' }] };
  if (!m) unk(rec, 'unk_scroll_range', `only ${pairs.length} scroll offsets sampled; the samples are a pure function of the offset but the range is not measurable`, 'a dense scroll sweep through the range');
  rec.fit = { ...rec.fit, n: pairs.length, rms: m ? m.rms : null, nrmse: m && nf.A ? m.rms / nf.A : null, holdout: { method: 'declared easing (map range fitted)', rms: m ? m.rms : null, pass: true } };
  rec.derived = {}; rec.evidence.location = { kind: 'scroll_range', range: [Math.min(...sy), Math.max(...sy)] };
  return rec;
}

/**
 * SMIL (design §3: invisible to getAnimations(); lab case M15): the declared snapshot carries the animation element's
 * attributes. The declared timing (dur, repeat, calcMode, keySplines) is checked against the samples with the begin
 * time and the value map (a + b·u) fitted; begin is on the take clock. Null when none applies or it does not explain.
 */
const SMIL_CH = { cx: ['ren:bx'], cy: ['ren:by'], x: ['ren:bx'], y: ['ren:by'], r: ['ren:bw', 'ren:bh'], width: ['ren:bw'], height: ['ren:bh'], opacity: ['ren:opacity'], 'fill-opacity': ['ren:opacity'] };
const smilMs = (v) => { if (v == null) return null; const t = String(v).trim(); let m = /^([\d.]+)ms$/.exec(t); if (m) return +m[1]; m = /^([\d.]+)s?$/.exec(t); if (m) return +m[1] * 1000; m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(t); if (m) return (+m[1] * 60 + +m[2]) * 1000; return null; };
function smilDeclared(P, s, nf) {
  const list = []; const seen = new Set();
  for (const snap of P.view.declared || []) for (const a of snap.smil || []) { if (!descMatch(a.tgt, s.desc) || !(SMIL_CH[a.attributeName] || []).includes(s.ch)) continue; const k = `${a.name}|${a.attributeName}|${a.tgt}`; if (!seen.has(k)) { seen.add(k); list.push(a); } }
  if (list.length !== 1) return null;
  const a = list[0]; const D = smilMs(a.dur); if (!(D > 0)) return null;
  const reps = a.repeatCount === 'indefinite' ? Infinity : a.repeatCount != null ? +a.repeatCount : 1;
  const E = a.calcMode === 'spline' && a.keySplines ? parseEasing(`cubic-bezier(${a.keySplines.trim().split(/[\s,]+/).slice(0, 4).join(', ')})`) : a.calcMode === 'discrete' ? (u) => (u < 1 ? 0 : 1) : (u) => u;
  const T = s.T, y = s.y; const thr = motionThreshold(nf); const i1 = y.findIndex((v, i) => i && Math.abs(v - y[i - 1]) > thr); if (i1 < 1) return null;
  const uAt = (t, b) => { if (t < b) return null; const el = t - b; const n = Math.floor(el / D); if (n >= reps) return a.fill === 'freeze' ? 1 : null; return E((el - n * D) / D); };
  const solve = (b) => { const X = [], Y = []; T.forEach((t, i) => { const u = uAt(t, b); X.push(u == null ? [1, 0, 1] : [0, 1, u]); Y.push(y[i]); }); const sol = ols(X, Y); if (!sol) return null; return { b, sol, rss: sol.rss }; };
  let best = null; const lo = T[i1 - 1], hi = T[i1];
  for (let q = 0; q <= 64; q++) { const r = solve(lo + ((hi - lo) * q) / 64); if (r && (!best || r.rss < best.rss)) best = r; }
  if (!best) return null;
  let l = Math.max(lo, best.b - (hi - lo) / 64), h = Math.min(hi, best.b + (hi - lo) / 64);
  for (let it = 0; it < 40; it++) { const m1 = l + (h - l) / 3, m2 = h - (h - l) / 3; const r1 = solve(m1), r2 = solve(m2); if (!r1 || !r2) break; if (r1.rss < r2.rss) h = m2; else l = m1; const rb = r1.rss < r2.rss ? r1 : r2; if (rb.rss < best.rss) best = rb; }
  const rms = Math.sqrt(best.rss / y.length); if (!(rms <= nf.explainBar)) return null;
  const rec = baseRecord(s, nf, P); rec.tier = 'declared'; rec.class = 'declared';
  rec.model.family = `declared:smil ${a.name}`;
  rec.model.params = { duration: pv(D, 'declared', { unit: 'ms' }), t0: pv(best.b, 'fitted', { unit: 'ms', ci95: [lo, hi], note: 'begin on the take clock, solved from the samples (the attribute says begin="' + a.begin + '")' }),
    repeatCount: pv(a.repeatCount ?? '1', 'declared'), calcMode: pv(a.calcMode || 'linear', 'declared'), keySplines: pv(a.keySplines, 'declared'), attributeName: pv(a.attributeName, 'declared') };
  rec.declared = { kind: 'smil', confirmed: true, births: [{ ...a, provenance: 'declared' }], note: 'SMIL is not listed by getAnimations(); declared values read from the element attributes' };
  rec.fit = { ...rec.fit, n: y.length, rms, nrmse: nf.A ? rms / nf.A : null, holdout: { method: 'declared timing (begin + value map fitted)', rms, pass: true } };
  rec.derived = { t0: best.b, period: Number.isFinite(reps) && reps <= 1 ? null : D }; rec.evidence.location = { kind: 'time_range', range: [T[0], T.at(-1)] };
  unk(rec, 'unk_smil_clock', 'SMIL runs on its own document clock; under hx it advances only if the page drives it (M15 shims it)', 'record an rt take to see the real SMIL clock');
  return rec;
}

function stepRecord(s, nf, P, seg) {
  const rec = baseRecord(s, nf, P); const i = seg.b;
  rec.tier = 'fitted'; rec.class = 'step'; rec.model.family = 'step';
  const halfFrame = (s.T[i] - s.T[i - 1]);
  rec.model.params = { before: pv(s.y[i - 1], 'measured'), after: pv(s.y[i], 'measured'), at: pv((s.T[i - 1] + s.T[i]) / 2, 'fitted', { unit: 'ms', ci95: [s.T[i - 1], s.T[i - 1] + halfFrame], note: 'the change happened between these two frames' }) };
  rec.derived = { t0: s.T[i - 1] }; rec.fit = { ...rec.fit, n: 2, rms: 0, nrmse: 0, holdout: { method: 'n/a (one-frame change)', rms: 0, pass: true } };
  rec.evidence.location = { kind: 'frame_index', range: [s.k[i - 1], s.k[i]] }; return rec;
}

function periodicRecord(rec, per, s) {
  rec.tier = 'fitted'; rec.class = 'periodic'; rec.model.family = 'periodic';
  rec.model.params = { period: pv(per.params.period.value, 'fitted', { unit: 'ms', ci95: per.params.period.ci95 }) };
  rec.derived = per.derived; rec.fit.n = s.y.length; rec.fit.rms = 0; rec.fit.holdout = { method: 'tick spacing', rms: 0, pass: true };
  rec.evidence.location = { kind: 'time_range', range: [s.T[0], s.T.at(-1)] }; guardRecord(rec); return rec;
}

/**
 * The keyframe values of a declared record, in the channel's units (px, deg, a factor): the page's own keyframe values when
 * they explain the samples (declared; a relative unit keeps its declared numbers and unit beside the px: translateY(20%) ->
 * value [24.8, 0] px, declared [20, 0] %), else solved from the samples (measured). An implicit end (a keyframe that does
 * not name the property: the computed value) stays solved, and the record says which.
 */
export function keyframeValuesParam(dec) {
  const x = dec.exact;
  if (!x || x.rejected) return pv(dec.values[0], 'measured', { note: x && x.rejected ? `solved from samples; the declared keyframe values do not explain them (rms ${+x.rms.toPrecision(3)})` : 'solved from samples; declared strings in births' });
  const all = !x.implicit.some(Boolean);
  const extra = { ...(x.unit ? { declaredValues: x.declared, declaredUnit: x.unit, factorPx: x.factor } : {}), ...(all ? {} : { declaredAt: x.implicit.map((i) => !i), declaredValuesExact: x.values.map((v, q) => (x.implicit[q] ? null : v)) }) };
  return pv(x.values, all ? 'declared' : 'measured', { ...extra, note: all ? `read from the keyframes${x.unit ? ` (declared in ${x.unit}; px from the samples)` : ''}; they explain the samples`
    : 'implicit keyframe (the computed value at the start / end): solved from the samples; the named keyframes are the declared values' });
}
function declaredRecord(s, nf, P, dec, ctx) {
  const rec = baseRecord(s, nf, P); rec.tier = 'declared';
  const drvSibling = P.series.find((x) => x.el === s.el && x.kind === 'drv' && x.ch !== s.ch && isMoving(x, noiseFloor(x, P.view)));
  const composite = dec.retargeted && drvSibling;
  // a transition that page script retargets (a magnetic button writes --mx each frame) is still the page's own transition:
  // its duration, curve and ends are exact, so the family stays declared (the line states them); the class and
  // rec.composite say a driver retargets it
  rec.class = composite ? 'composite' : 'declared'; rec.model.family = `declared:${dec.kind}`;
  const b0 = dec.births[0];
  // the curve the animation runs: the effect easing, or the keyframes' easing (a CSS animation's timing function sits on
  // its keyframes; getTiming().easing reads `linear`). Canonical CSS only: the strings are read where page script runs.
  const ee = effectiveEasing(b0.easing, b0.keyframes);
  const easing = ee.easing != null ? pv(ee.easing, 'declared', ee.source === 'keyframes' ? { note: 'keyframe easing (the effect easing is linear)' } : {})
    : pv(null, 'declared', { reason: ee.why });
  const kfEasings = ee.segments ? { keyframeEasings: pv(ee.segments, 'declared', { note: 'one easing per keyframe segment' }), ...(ee.effect && ee.effect !== 'linear' ? { effectEasing: pv(ee.effect, 'declared') } : {}) } : {};
  rec.model.params = { duration: pv(b0.duration, 'declared', { unit: 'ms' }), delay: pv(b0.delay, 'declared', { unit: 'ms' }), easing, ...kfEasings, start: pv(b0.T, 'declared', { unit: 'ms', note: 'birth time on the take clock (rule `next`)' }),
    iterations: pv(b0.iterations == null ? 'infinite' : b0.iterations, 'declared'), keyframeValues: keyframeValuesParam(dec) };
  // up to 64 births are kept whole: look states every run of a retargeted transition from them (src/look/index.js)
  rec.declared = { kind: dec.kind, births: dec.births.slice(0, 64), ...(dec.births.length > 64 ? { birthCount: dec.births.length } : {}), confirmed: true, ...(dec.ownOf ? { siblings: dec.ownOf } : {}) };
  rec.fit.n = s.y.length; rec.fit.rms = dec.rms; rec.fit.nrmse = nf.A ? dec.rms / nf.A : null; rec.fit.holdout = { method: 'declared (no fitted parameters)', rms: dec.rms, pass: true };
  if (dec.startMeasured) {
    rec.model.params.start = pv(dec.startMeasured.start, 'measured', { unit: 'ms', note: dec.startMeasured.note });
    rec.model.params.delay = pv(b0.delay, 'declared', { unit: 'ms', note: 'part of the measured start (not separable from it)' });
    rec.flags.push({ id: 'declared_start_measured', detail: `${dec.startMeasured.note}; created at ${Math.round(dec.startMeasured.birthT)} ms` });
  }
  if (dec.visible) rec.derived = { t0: dec.declaredOnset, visibleOnset: dec.visible.onsetModel ?? dec.visible.onset, visibleOnsetSource: dec.visible.onsetModel != null ? 'declared keyframes (solved values) on the take clock' : 'first frame off rest', visibleDuration: dec.visible.duration, declaredDuration: dec.declaredDuration };
  if (dec.holdFlag) rec.flags.push(dec.holdFlag);
  if (composite) {
    rec.composite = { driverChannel: drvSibling.ch, transitions: dec.retargeted, note: 'driver stage is its own record; rendered = chain of declared transitions retargeted at each driver change' };
    const lag = lagMs(drvSibling, s); if (lag != null) rec.derived.renderedLagMs = lag;
  }
  rec.evidence.location = { kind: 'time_range', range: [s.T[0], s.T.at(-1)] };
  return rec;
}
function lagMs(a, b) { // mean time for b to reach the value a had (both normalised), crude cross-correlation over shifts
  const n = Math.min(a.y.length, b.y.length); let best = null; const dt = (a.T.at(-1) - a.T[0]) / Math.max(1, a.T.length - 1);
  const na = norm(a.y), nb = norm(b.y);
  for (let sh = 0; sh < Math.min(120, n - 2); sh++) { let e = 0; for (let i = 0; i + sh < n; i++) e += (na[i] - nb[i + sh]) ** 2; e /= n - sh; if (!best || e < best.e) best = { e, sh }; }
  return best ? best.sh * dt : null;
}
const norm = (y) => { const lo = Math.min(...y), hi = Math.max(...y); return y.map((v) => (v - lo) / ((hi - lo) || 1)); };

/**
 * Scroll offset at any page frame k: the latest recorder scrollTo that landed after frame k' < k (hx: an input after
 * frame k' is seen by frame k'+1), else the sampled offset of the nearest sampled frame ≤ k.
 */
function scrollAtFrame(PP) {
  const inputs = (PP.view.inputLog || []).filter((e) => e.type === 'scrollTo' && Number.isInteger(e.k) && Number.isFinite(e.got)).sort((a, b) => a.k - b.k);
  const rows = PP.view.rows;
  return (k) => {
    let v = null, kv = -Infinity;
    for (const e of inputs) { if (e.k < k) { v = e.got; kv = e.k + 1; } else break; }
    let lo = 0, hi = rows.length - 1, best = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].k <= k) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    if (best >= 0 && rows[best].k >= kv) return rows[best].sy;
    return v != null ? v : best >= 0 ? rows[best].sy : rows[0].sy;
  };
}

/** Pointer driver per row of a take: the last pointer coordinate (axis x|y) received at or before the row, NaN before any. */
function pointerDriverRow(PP, axis) {
  const evs = PP.events.filter((e) => e.kind === 'pointer' && e.i >= 0 && e.entry && Number.isFinite(e.entry[axis])).sort((a, b) => a.i - b.i);
  const row = new Array(PP.T.length).fill(NaN); let j = 0, cur = NaN;
  for (let i = 0; i < PP.T.length; i++) { while (j < evs.length && evs[j].i <= i) { cur = evs[j].entry[axis]; j++; } row[i] = cur; }
  return row;
}

/**
 * A fitted map that is no scroll law: an end value of 1e12 or more (no CSS length, angle, ratio or counter reaches it:
 * an overflow), or one of 1e7 or more (past the browser's transform clamp, 2^25 px) on a ramp with fewer than two
 * distinct sampled offsets inside it (the samples jump across it: its slope is not observed).
 */
export function degenerateMap(map, sy) {
  const { a, b, s0, s1 } = map; if (![a, b].every(Number.isFinite)) return true;
  const big = Math.max(Math.abs(a), Math.abs(a + b));
  if (big >= 1e12) return true;
  if (big < 1e7) return false;
  const inner = new Set((sy || []).filter((v) => Number.isFinite(v) && v > s0 + 1 && v < s1 - 1)).size;
  return inner < 2;
}

/** Driver families on the whole series (§4.5, §4.7): scroll by default, or `drvOf(take, series)` (pointer). Returns null when none explains. */
/** Deterministic fit work (S4 budget): samples fed to the driver-smoothing fits, the dominant cost of a take. */
const spend = (ctx, n) => { if (ctx && ctx.work) ctx.work.units += n; };

function driverRecord(s, nf, P, segs, sySeries, ctx, allAligned, mismatch, dec, drvOf = null) {
  // R6 / U6: a declared page period with an integer sampling stride > 1 → simulate on the page frames (driver per frame)
  const stride = P.timing.strideInt || 1;
  const grid = stride > 1 && P.view.dtPage ? { stride, dtPage: P.view.dtPage, drvFrame: drvOf && drvOf.atFrame ? drvOf.atFrame(P) : scrollAtFrame(P) } : null;
  spend(ctx, s.y.length); const { out: out0 } = ctx.candidates ? { out: ctx.candidates } : smoothingCandidates(s, sySeries, nf, { grid, earlyExit: !!ctx.opts.earlyExit, lean: !!ctx.lean }); let out = drvOf && drvOf.smoothingOnly ? out0.filter((c) => c.law !== 'restarted' || c.degenerate) : out0; if (!out.length) return null;
  if (ctx.forceLag != null) { const f = out.filter((c) => c.lag === ctx.forceLag || c.lag == null); if (f.some((c) => c.lag === ctx.forceLag && c.rms <= nf.explainBar)) out = f; }
  if (ctx.forceClass) { const f = out.filter((c) => c.cls === ctx.forceClass && !c.degenerate); if (f.some((c) => c.rms <= nf.explainBar)) out = f; }
  const amps = segs.map((g) => ({ b: g.b, e: Math.min(g.w1, g.e + 8), amp: Math.abs(s.y[g.e] - s.y[Math.max(0, g.b - 1)]) }));
  for (const c of out) { c.window = { T: s.T, y: s.y }; c.derived = { t0: s.T[segs[0].b] }; }
  // holdout only for the best few (cost)
  const pre = out.filter((c) => c.rms <= nf.explainBar).sort((a, b) => a.bic - b.bic).slice(0, 4);
  // leave-one-segment-out needs comparable segments: when one segment holds most of the motion (a slow quantised tail
  // split into short segments after it; lab case M02 q3 gap at R4) the held-out refit has almost no data: use the
  // last-30 % holdout instead
  const span = amps.map((a) => a.e - a.b + 1); const tot = span.reduce((a, b) => a + b, 0);
  const segsHO = amps.length >= 2 && Math.max(...span) <= 0.6 * tot ? amps : null;
  for (const c of pre) holdout(c, nf.explainBar, { segments: segsHO });
  const sel = select(out, { explainBar: nf.explainBar, probes: { driverAligned: allAligned } });
  const dbg = ctx.opts.debug ? out.map((c) => ({ family: c.family, lag: c.lag, map: c.mapShape, rms: c.rms, L: c.L, bic: c.bic, k: c.k, holdout: c.holdout && { rms: c.holdout.rms, pass: c.holdout.pass } })).sort((a, b) => a.bic - b.bic).slice(0, 12) : null;
  // two-frame-rate class decision (G1-4 §8.4 as a probe; lab case M02 write q2/q3, where rounding lets an EMA and a
  // restarted tween both explain one take): fit both on the probe take; the law whose parameter is invariant across
  // the rates (EMA α per frame, dt-damp λ, restarted-tween duration L) decides the class
  if (sel.winner && sel.ambiguity && ctx.Q) {
    const cls = new Set(sel.ambiguity.candidates.map((c) => c.cls));
    if (cls.has('restarted tween') && (cls.has('first-order smoothing') || cls.has('asymmetric smoothing'))) {
      const sq = matchSeries(P, ctx.Q, s);
      if (sq) {
        const nq = noiseFloor(sq, ctx.Q.view); const syq = drvOf ? drvOf(ctx.Q, sq) : sq.idx.map((i) => ctx.Q.sy[i]);
        spend(ctx, sq.y.length); const oq = smoothingCandidates(sq, syq, nq, probeMaps(sel.winner)).out; const bestOf = (L, law, f) => L.filter((c) => c.law === law && !c.degenerate && (!f || f(c)) && (ctx.forceLag == null || c.lag == null || c.lag === ctx.forceLag)).sort((a, b) => a.rss - b.rss)[0];
        const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
        const eP = bestOf(out, 'ema'), eQ = bestOf(oq, 'ema'), dP = bestOf(out, 'dtdamp'), dQ = bestOf(oq, 'dtdamp'), rP = bestOf(out, 'restarted'), rQ = bestOf(oq, 'restarted');
        const inv = { ema: eP && eQ ? rel(eP.prm.alpha, eQ.prm.alpha) : Infinity, dtdamp: dP && dQ ? rel(dP.prm.lambda, dQ.prm.lambda) : Infinity, restarted: rP && rQ ? rel(rP.prm.L, rQ.prm.L) : Infinity };
        const sm = inv.ema <= inv.dtdamp ? ['ema', eP] : ['dtdamp', dP];
        if (inv[sm[0]] <= 0.05 && inv.restarted > 0.05 && sm[1] && sm[1].rms <= nf.explainBar) { sel.winner = sm[1]; sel.ambiguity = null; sel.winner.decidedBy = `two-rate: ${sm[0] === 'ema' ? 'α per frame' : 'λ'} invariant (${(100 * inv[sm[0]]).toFixed(2)} %), restarted-tween duration not (${(100 * inv.restarted).toFixed(1)} %)`; }
        else if (inv.restarted <= 0.05 && Math.min(inv.ema, inv.dtdamp) > 0.05 && rP && rP.rms <= nf.explainBar) { sel.winner = rP; sel.ambiguity = null; sel.winner.decidedBy = `two-rate: restarted-tween duration invariant (${(100 * inv.restarted).toFixed(2)} %), smoothing rates not`; }
      }
    }
  }
  // still ambiguous: the class is a property of the page, not of the take; when the probe take (another rate, same
  // scenario) decides it by likelihood, that decision is the decisive probe of design §5.3 (lab case M21 reversal at R5:
  // the 100 ms stall swallowed one of the two tween completions, so one take alone cannot tell the laws apart)
  if (sel.winner && sel.ambiguity && ctx.Q && !drvOf) {
    const sq = matchSeries(P, ctx.Q, s);
    if (sq) {
      const nq = noiseFloor(sq, ctx.Q.view); const syq = sq.idx.map((i) => ctx.Q.sy[i]);
      spend(ctx, sq.y.length); const oq = smoothingCandidates(sq, syq, nq, probeMaps(sel.winner)).out;
      const amps = []; for (const c of oq.filter((c) => c.rms <= nq.explainBar).sort((a, b) => a.bic - b.bic).slice(0, 4)) holdout(c, nq.explainBar);
      const sq2 = select(oq, { explainBar: nq.explainBar });
      const classes = new Set(sel.ambiguity.candidates.map((c) => c.cls));
      if (sq2.winner && !sq2.ambiguity && classes.has(sq2.winner.cls)) {
        const pick = out.filter((c) => c.cls === sq2.winner.cls && c.rms <= nf.explainBar && (!c.holdout || c.holdout.pass)).sort((a, b) => a.bic - b.bic)[0];
        if (pick) { sel.winner = pick; sel.ambiguity = null; pick.decidedBy = `probe take (${ctx.Q.dt.toFixed(3)} ms frames) decides the class: ${sq2.winner.family}`; void amps; }
      }
    }
  }
  // an instant map and a restarted tween of a few frames both explaining a quantised channel (an integer index, lab case
  // M04 tab index): within the quantisation the short tween IS the instant map (nested) → scroll map
  if (sel.winner && sel.ambiguity) {
    const none = out.filter((c) => c.law === 'none' && c.rms <= nf.explainBar).sort((a, b) => a.bic - b.bic)[0];
    const rivals = sel.ambiguity.candidates.filter((c) => c.cls !== 'scroll map');
    if (none && rivals.length && rivals.every((c) => c.cls === 'restarted tween' && c.params && Number.isFinite(c.params.L) && c.params.L + (c.params.delay || 0) <= 4 * P.dt)) { sel.winner = none; sel.ambiguity = null; none.decidedBy = 'the rival restarted tweens last ≤ 4 frames: an instant map within the quantisation'; }
  }
  // look, the offset of a page that owns its scroll (ctx.lean): a restarted expo.out and a first-order smoother (with its
  // snap) that agree on tau are one curve, not two classes (each restart covers 1 − 2^(−10 t / L) of the gap: an
  // exponential with tau = L / (10 ln 2), cut to the target at L). ScrollTrigger's scrub is exactly that; the smoother is
  // reported (one parameter), the scrub length is its tau read back (words: "= GSAP scrub")
  if (ctx.lean && sel.winner && sel.ambiguity) {
    const dtF = P.view.dtPage || P.dt; const lawOf = (c) => (/^restarted/.test(c.family) ? 'restarted' : /^ema/.test(c.family) ? 'ema' : /^dtdamp/.test(c.family) ? 'dtdamp' : null);
    const tau = (c) => { const q = c.params || {}; const law = lawOf(c);
      if (law === 'restarted') return c.ease === 'expo.out' && q.L > 0 ? q.L / (10 * Math.LN2) : NaN;
      if (law === 'ema') return q.alpha > 0 && q.alpha < 1 ? -dtF / Math.log(1 - q.alpha) : NaN; if (law === 'dtdamp') return q.lambda > 0 ? 1000 / q.lambda : NaN; return NaN; };
    const cands = sel.ambiguity.candidates; const ts = cands.map(tau);
    const sm = cands.filter((c) => lawOf(c) === 'ema' || lawOf(c) === 'dtdamp').sort((a, b) => a.rms - b.rms)[0];
    const smooth = sm && out.find((c) => c.family === sm.family && c.rms === sm.rms);
    if (smooth && ts.every(Number.isFinite) && Math.max(...ts) <= 1.03 * Math.min(...ts)) {
      sel.winner = smooth; sel.ambiguity = null;
      smooth.decidedBy = `a restarted expo.out and a first-order smoother agree on tau (${ts.map((t) => t.toFixed(1)).join(' / ')} ms): one curve (a scrub)`;
    }
  }
  if (!sel.winner) return null;
  // one driver change and one response: a tween started by that change, not a restarted tween (restarting needs a
  // second change during the motion); the time families describe it (lab case M12 at R3: a counter tween started by
  // the scroll that reveals it)
  // … but a dense sweep moves the driver on every frame of ONE continuous segment: there the tween IS restarted by every
  // change, and the class question is the usual one against the smoothers (lab case M03 speed draw d22 at R6, drv:--b:
  // EMA+snap, dt-damp+snap and restarted expo.out L 846.6 ms all explain at rms 7.3e-5; returning null here threw the
  // channel to the time families → unexplained, τ withheld). Count the driver changes inside the moving frames
  const drvChanges = (() => { const g = segs[0]; if (!g) return 0; let n = 0; for (let i = Math.max(1, g.b - 2); i <= g.e; i++) if (sySeries[i] !== sySeries[i - 1] && Number.isFinite(sySeries[i]) && Number.isFinite(sySeries[i - 1])) n++; return n; })();
  if (sel.winner.law === 'restarted' && segs.length === 1 && drvChanges <= 1) return null;
  // an unfinished restarted expo.out IS a dt-damp curve: when an EMA/dt-damp explains within ΔL < 10, report that law
  // (lab case M04 toFixed(2) channels, where quantisation lets both explain)
  if (sel.winner.degenerate) { const alt = out.filter((c) => (c.law === 'ema' || c.law === 'dtdamp') && c.rms <= nf.explainBar && (!c.holdout || c.holdout.pass) && c.L - sel.winner.L < 10).sort((a, b) => a.bic - b.bic)[0]; if (alt) sel.winner = alt; }
  // an asymmetric fit whose two rates agree within 2 % (the identified-set agreement of design §4.3) has not resolved an
  // asymmetry: the first-order law explains instead (lab case M04 g0 gap at R6: α_up 0.07000 / α_down 0.06994, the 0.09 %
  // split absorbed a map-shape misfit on few offsets)
  if (sel.winner && sel.winner.law === 'asym' && sel.winner.prm && Math.abs(sel.winner.prm.alphaUp / sel.winner.prm.alphaDown - 1) <= 0.02) {
    const alt = out.filter((c) => (c.law === 'ema' || c.law === 'dtdamp') && c.rms <= nf.explainBar && (!c.holdout || c.holdout.pass !== false)).sort((a, b) => a.bic - b.bic)[0];
    if (alt) { alt.decidedBy = `asymmetric fit not resolved (α_up/α_down = ${(sel.winner.prm.alphaUp / sel.winner.prm.alphaDown).toFixed(4)})`; sel.winner = alt; sel.ambiguity = null; }
  }
  // a map whose output does not move with its driver (y = a + b·S(..): |b| within the series' noise bar, the start and
  // end values the same) says nothing about that driver: it is no link. The channel moved for another reason (e.g. a
  // scroll progress bar while a hover's scroll-into-view ran before the first pointer input) and is left to the other
  // families, never reported as "linked" with a code export for it
  if (sel.winner.map && Number.isFinite(sel.winner.map.b) && Math.abs(sel.winner.map.b) <= Math.max(nf.explainBar, 2 / 64)) return null;
  // … nor is a map whose end values leave every range a page value can take, fitted on a ramp the samples never enter
  // (a ray layer whose tan() overflows when its angle reaches 90°: --rw 4670 → 3.0e19 over 6550 → 6569 px of a scroll
  // moving 400 px per frame, x −1020 → −3.4e7, the browser's transform clamp). That is a jump between two samples to an
  // overflowing value, not a law of the scroll; it is left to the other families
  if (sel.winner.map && degenerateMap(sel.winner.map, sySeries)) return null;
  // look, page-owned scroll (lean): a first-order law whose rate closes the whole gap every frame IS the unsmoothed map
  // (doors on a 60 Hz pinned-rail page: EMA α = 1 on an exact easeInOutCubic map, read as "smooth follow, closes 100 %")
  if (ctx.lean && /^(ema|dtdamp)$/.test(sel.winner.family || '') && (sel.winner.law === 'ema' ? sel.winner.prm.alpha : 1 - Math.exp(-(sel.winner.prm.lambda || 0) * (P.view.dtPage || P.dt) / 1000)) >= 0.9999) {
    const w0 = sel.winner;
    sel.winner = { ...w0, law: 'none', cls: 'scroll map', family: 'none', prm: {}, params: Object.fromEntries(Object.entries(w0.params || {}).filter(([k]) => !/^(alpha|lambda)$/.test(k))), decidedBy: 'a first-order law that closes the whole gap every frame is the unsmoothed map' };
  }
  const w = sel.winner; const rec = baseRecord(s, nf, P); if (dbg) rec.debug = dbg;
  rec.tier = 'fitted'; rec.class = w.cls; rec.model.family = w.law === 'none' ? `scroll map (${w.mapShape})` : w.family;
  // an unsmoothed map whose output only ever takes two values and switches a frame AFTER the offset changed is a
  // discrete switch reacting to the scroll: the simpler class `step` (A1.6 a; lab case M16d, a two-level function of
  // the offset one frame late). In the same frame it stays a scroll map: layout tied to the offset (lab case M04, the
  // pinned block's box at offsets that are all inside the pin); the map stays in the record either way
  if (w.law === 'none' && new Set(s.y).size === 2 && w.lag >= 1) { rec.class = 'step'; rec.model.family = `step (two-level scroll map, ${w.mapShape})`; }
  const units = { lambda: '1/s' };
  rec.model.params = fittedParams(w, units);
  const shapeOk = w.map.shapeIdentified !== false;   // free per-offset targets: the dynamics are fitted, the map shape is not identified
  rec.model.map = { shape: shapeOk ? w.mapShape : null, shapeCandidate: shapeOk ? undefined : w.mapShape, a: w.map.a, b: w.map.b, s0_px: w.map.s0, s1_px: w.map.s1, s0_ci95: (w.params.mapS0 && w.params.mapS0.ci95) || (w.map.s0_ci95 || null), s1_ci95: (w.params.mapS1 && w.params.mapS1.ci95) || (w.map.s1_ci95 || null), s0_vh: w.map.s0 / ((P.view.env.viewport && P.view.env.viewport.value && P.view.env.viewport.value.height) || 800) * 100, s1_vh: w.map.s1 / ((P.view.env.viewport && P.view.env.viewport.value && P.view.env.viewport.value.height) || 800) * 100, driverLagFrames: w.lag };
  // a clamped map's corner is identified only when the samples reach past it (the flat part observed); otherwise any
  // corner beyond the data fits with a re-scaled (a, b) (lab case M01 o = 0: corner at the scroll minimum)
  { const lo = Math.min(...sySeries.filter(Number.isFinite)), hi = Math.max(...sySeries.filter(Number.isFinite));
    rec.model.map.s0_provenance = shapeOk && lo < w.map.s0 - 1 ? 'fitted' : 'unknown'; rec.model.map.s1_provenance = shapeOk && hi > w.map.s1 + 1 ? 'fitted' : 'unknown';
    // an instant map's corner counts as observed only when a sample beyond it READS the plateau: an offset past the
    // corner whose value lies on the ramp instead (a seed sample the residuals skip, measured on a reading-progress bar:
    // first offset 100 px on the line, corner claimed at 200 px) means the corner was not seen
    if (w.law === 'none' && shapeOk) {
      const tolP = Math.max(nf.explainBar, 1e-6 * Math.abs(w.map.b)); const seen = [];
      for (let j = 0; j < s.y.length; j++) { const x = sySeries[j - (w.lag || 0)]; if (Number.isFinite(x) && Number.isFinite(s.y[j])) seen.push([x, s.y[j]]); }
      if (rec.model.map.s0_provenance === 'fitted' && !seen.some(([x, y]) => x < w.map.s0 - 1 && Math.abs(y - w.map.a) <= tolP)) rec.model.map.s0_provenance = 'unknown';
      if (rec.model.map.s1_provenance === 'fitted' && !seen.some(([x, y]) => x > w.map.s1 + 1 && Math.abs(y - (w.map.a + w.map.b)) <= tolP)) rec.model.map.s1_provenance = 'unknown';
    }
    // the ramp between the corners needs ≥ 2 distinct offsets strictly inside it: with one, the slope and with it both
    // corners trade off along a line through that point (lab case M01 gap trace with a 320 px range: only 450 px inside)
    const inner = new Set(sySeries.filter((v) => Number.isFinite(v) && v > w.map.s0 + 1 && v < w.map.s1 - 1)).size;
    if (inner < 2) { rec.model.map.s0_provenance = 'unknown'; rec.model.map.s1_provenance = 'unknown'; unk(rec, 'unk_map_range', `${inner} distinct offset(s) inside the fitted range: the corners are not identifiable`, 'scroll through the range (≥ 2 offsets inside it)'); }
    // an unidentified corner reports the set that reproduces every sampled offset (Amendment 2 B; instant maps only)
    if ((rec.model.map.s0_provenance === 'unknown' || rec.model.map.s1_provenance === 'unknown') && w.law === 'none' && shapeOk && MAP_SHAPES[w.mapShape]) {
      const byS = new Map(); for (let j = 0; j < s.y.length; j++) { const x = sySeries[j - (w.lag || 0)]; if (Number.isFinite(x)) byS.set(x, s.y[j]); }
      const r = mapRidge({ a: w.map.a, b: w.map.b, S: MAP_SHAPES[w.mapShape], linear: w.mapShape === 'linear', pairs: [...byS.entries()].map(([x, y]) => ({ s: x, y })), tolv: Math.max(nf.explainBar, 1e-6 * Math.abs(w.map.b)), s0: w.map.s0, s1: w.map.s1 });
      if (r) { if (rec.model.map.s0_provenance === 'unknown' && r.s0) rec.model.map.s0_interval = r.s0; if (rec.model.map.s1_provenance === 'unknown' && r.s1) rec.model.map.s1_interval = r.s1; if (r.slope) rec.model.map.slope_interval = r.slope; rec.model.map.ridge = r.case; } }
    if (rec.model.map.s0_provenance === 'unknown') unk(rec, 'unk_map_start', `no sample below the map start (${w.map.s0.toFixed(1)} px): the corner is not identifiable`, 'scroll above the start of the range');
    if (rec.model.map.s1_provenance === 'unknown') unk(rec, 'unk_map_end', `no sample past the map end (${w.map.s1.toFixed(1)} px): the corner is not identifiable`, 'scroll past the end of the range'); }
  rec.fit = { ...rec.fit, n: w.n, rms: w.rms, nrmse: nf.A ? w.rms / nf.A : null, bic: w.bic, holdout: w.holdout || { method: 'none', pass: true } };
  rec.runnerUp = summarize(sel.runnerUp); rec.rejected = sel.rejected.slice(0, 12);
  { const sa = selectionAmbiguity(sel, w); if (sa) rec.selectionAmbiguity = sa; }   // L9-A: decided within the noise of L
  if (sel.ambiguity) { rec.ambiguity = sel.ambiguity; rec.class = 'unknown'; rec.tier = 'unknown'; unk(rec, 'unk_ambiguous_class', sel.ambiguity.reason, 'second rate, stall (R5) or an interruption'); }
  if (w.decidedBy) rec.decidedBy = w.decidedBy;
  if (mismatch) rec.flags.push(mismatch);
  // smoothing law: two rates (§7) or stall; stride correction (R6)
  if (w.law === 'ema' || w.law === 'dtdamp' || w.law === 'asym') {
    // candidates simulated on the page frames (R6 grid) already carry per-page-frame parameters
    // asymmetric smoothing: the eased direction's α carries the law (the other direction is often a snap, α = 1)
    const stride = w.perPageFrame ? 1 : (P.timing.strideInt || 1); let alpha = w.law === 'ema' ? w.prm.alpha : w.law === 'asym' ? Math.min(w.prm.alphaUp, w.prm.alphaDown) : w.law === 'dtdamp' ? 1 - Math.exp(-w.prm.lambda * (w.perPageFrame ? P.view.dtPage : P.timing.medianDt) / 1000) : null;
    let law = 'unknown'; let lawEv = null;
    if (ctx.Q && alpha != null) {
      const sq = matchSeries(P, ctx.Q, s);
      if (sq) { const nq = noiseFloor(sq, ctx.Q.view); const syq = drvOf ? drvOf(ctx.Q, sq) : sq.idx.map((i) => ctx.Q.sy[i]); const lawQ = w.law === 'asym' ? 'asym' : 'ema'; const cqAll = (spend(ctx, sq.y.length), smoothingCandidates(sq, syq, nq, probeMaps(w))).out.filter((c) => c.law === lawQ);
        // the driver lag in frames is a property of the page, not of the rate (hx: an input handled at T_k lands in frame
        // k+1 at any rate): the probe's smoother is read at the primary's lag when one explains there (lab case M04 g4
        // speed, toFixed(3) drv:--s: the probe traded α 0.611 + lag 1 against the true 0.38 + lag 0, so the two-rate law
        // read non-LTI while the element's finer channels read per-frame)
        const cqLag = cqAll.filter((c) => c.lag === w.lag && c.rms <= nq.explainBar); const cq = (cqLag.length ? cqLag : cqAll).sort((a, b) => a.rss - b.rss)[0];
        const aq = cq ? (lawQ === 'asym' ? Math.min(cq.prm.alphaUp, cq.prm.alphaDown) : cq.prm.alpha) : null;
        if (cq) { const r = smoothingLaw({ alpha: alphaPage(alpha, stride), dtMs: P.dt }, { alpha: alphaPage(aq, ctx.Q.timing.strideInt || 1), dtMs: ctx.Q.dt }); law = r.law; lawEv = r; } }
    } else {
      const stallsIn = P.timing.stalls.some((i) => segs.some((g) => s.idx[g.b] <= i && i <= s.idx[g.e]));
      if (stallsIn) {
        const ce = out.filter((c) => c.law === 'ema' && c.lag === w.lag).sort((a, b) => a.rss - b.rss)[0], cd = out.filter((c) => c.law === 'dtdamp' && c.lag === w.lag).sort((a, b) => a.rss - b.rss)[0];
        const r = stallLaw(ce, cd, true); if (r) { law = r.law; lawEv = r; }
      }
    }
    rec.model.law = law; rec.model.lawEvidence = lawEv;
    if (law === 'unknown') unk(rec, 'unk_smoothing_law', 'one fixed-rate take and no stall: per-frame EMA and dt-damp are the same curve (U5)', 'record a second rate ≥ 1.5× apart or an R5 stall take');
    if (w.perPageFrame && (P.timing.strideInt || 1) > 1) rec.model.strideCorrection = { stride: P.timing.strideInt, method: 'smoother simulated on the page frames (driver per frame from its inputs), read at the sampled frames', alphaPerPageFrame: alpha };
    if (stride !== 1 && P.view.dtPage) { rec.model.strideCorrection = { stride, alphaPerSample: alpha, alphaPerPageFrame: alphaPage(alpha, stride) }; alpha = alphaPage(alpha, stride); }
    else if (stride !== 1 && !P.view.dtPage) { unk(rec, 'unk_page_period', 'sampling stride ≠ 1 and the page frame period is not declared (U6)', 'record in hx or declare the page period'); }
    const form = smoothingForm({ ...w, prm: { ...w.prm, alpha: alpha ?? w.prm.alpha } }, P.view.dtPage || P.dt, law);
    rec.smoothing = form;
    const dtA = (w.perPageFrame ? P.view.dtPage : P.timing.medianDt) / 1000;
    const aKey = w.law === 'asym' ? (w.prm.alphaUp <= w.prm.alphaDown ? 'alphaUp' : 'alphaDown') : 'alpha';
    const aCI = w.law === 'asym' ? (w.params[aKey] && w.params[aKey].ci95 ? w.params[aKey].ci95.map((a) => alphaPage(a, stride)) : null) : w.law === 'dtdamp' ? (w.params.lambda && w.params.lambda.ci95 ? w.params.lambda.ci95.map((l) => alphaPage(1 - Math.exp(-Math.max(0, l) * dtA), stride)) : null) : scaleCI(w.params.alpha && w.params.alpha.ci95, alpha, w.prm.alpha);
    if (alpha != null) { rec.model.params.alpha_per_frame = pv(alpha, 'fitted', { ci95: aCI }); rec.model.params.tau_ms = pv(form.tau_ms, 'fitted', { unit: 'ms', ci95: tauCI(rec.model.params.alpha_per_frame.ci95, P.view.dtPage || P.dt) }); }
    rec.derived = { t0: s.T[segs[0].b], settle_frames: form.settle_frames, tau_ms: form.tau_ms };
    // settle tail CI from the α interval (settle frames = ⌈ln 1e-3 / ln(1 − α)⌉ is monotone in α)
    { const ci = rec.model.params.alpha_per_frame && rec.model.params.alpha_per_frame.ci95; const sf = (a) => Math.ceil(Math.log(1e-3) / Math.log(1 - Math.min(0.999999, Math.max(1e-9, a))));
      if (ci && ci.every(Number.isFinite)) rec.derived.settle_frames_ci95 = [sf(ci[1]), sf(ci[0])]; }
  }
  if (w.law === 'restarted') { rec.model.ease = w.ease; rec.model.law = 'time-based, non-LTI'; rec.derived = { t0: s.T[segs[0].b], stepResponseMs: w.prm.L }; }
  // a scrubbed timeline (lookDriver / timelineScrub): the smoothing runs on the clamped scroll progress of the whole
  // trigger range [c0, c1], and this channel's map covers [s0, s1] inside it. An edge of the range is measured only where
  // it differs from the map's corner and the scroll went past it; on a sweep that restarts the tween every frame the
  // restarted expo.out is the first-order smoother with tau = L / (10 ln 2) (the class the page's library runs, not one
  // this take alone can tell from an EMA)
  if (w.timelineScrub && w.progress) {
    const g = w.progress; const lo = Math.min(...sySeries.filter(Number.isFinite)), hi = Math.max(...sySeries.filter(Number.isFinite));
    const edge = (d, past) => (d <= 1 ? 'the map corner' : past ? 'fitted' : 'unknown');
    rec.model.scrub = { kind: 'scrubbed timeline', law: 'restarted expo.out on the clamped scroll progress, then the map', L_ms: g.L, tau_ms: g.L / (10 * Math.LN2), delay_ms: g.delay,
      range_px: [g.c0, g.c1], range_provenance: [edge(g.d0, lo < g.c0 - 1), edge(g.d1, hi > g.c1 + 1)], shared: !!g.shared,
      note: g.shared ? 'smoothed progress identified on another channel of this take (same trigger range and scrub), only the map fitted here' : 'progress range and scrub fitted on this channel' };
    rec.model.params.tau_ms = pv(g.L / (10 * Math.LN2), 'fitted', { unit: 'ms', ci95: rec.model.params.L && rec.model.params.L.ci95 ? rec.model.params.L.ci95.map((v) => v / (10 * Math.LN2)) : null, note: 'restarted expo.out on a sweep = first-order smoothing, tau = L / (10 ln 2)' });
  }
  rec.evidence.location = { kind: 'scroll_range', range: [Math.min(...sySeries), Math.max(...sySeries)] };
  if (dec && dec.scrollTimeline) { rec.tier = 'declared'; rec.class = 'declared'; rec.declared = { kind: 'scroll-timeline', births: dec.births, confirmed: true }; unk(rec, 'unk_declared_range', 'the recorder does not read animation.rangeStart/rangeEnd; range measured from the fitted map', 'read rangeStart/rangeEnd in the declared snapshot'); }
  // an ambiguity between first-order smoothing and a restarted expo.out tween (no delay) is a class ambiguity only: both
  // are the same exponential, τ = −T/ln(1 − α) = 1/λ = L/(10·ln 2), and differ only in the terminal snap (A2-C2). When
  // every member of the set agrees on τ within 2 %, τ and α per page frame are identified and reported (as the M07
  // identified-set rule); the class stays `unknown` (lab case M02 write q3 gap at R6: EMA τ 200.03 ms, restarted expo.out
  // L 1386 ms = τ 200.0 ms, the quantisation hides both snaps)
  if (rec.ambiguity && ((rec.model.params.tau_ms && rec.model.params.tau_ms.provenance === 'fitted') || (rec.model.params.L && rec.model.params.L.provenance === 'fitted' && Array.isArray(rec.model.params.L.ci95) && w.ease === 'expo.out'))) {
    // dense driver: the scroll offset changed on at least half of the frames from the first motion to the last
    const denseDriver = (() => { const b = segs[0] ? segs[0].b : 1, e = segs.length ? segs.at(-1).e : sySeries.length - 1; let n = 0, ch = 0; for (let i = Math.max(1, b); i <= e; i++) { n++; if (sySeries[i] !== sySeries[i - 1]) ch++; } return n > 0 && ch >= 0.5 * n; })();
    const dtF = P.view.dtPage || P.dt; const tauOf = (c) => { const q = c.params || {};
      if (c.cls === 'first-order smoothing' && /^ema/.test(c.family) && q.alpha > 0 && q.alpha < 1) return -dtF / Math.log(1 - q.alpha);
      if (c.cls === 'first-order smoothing' && /^dtdamp/.test(c.family) && q.lambda > 0) return 1000 / q.lambda;
      if (c.cls === 'asymmetric smoothing' && q.alphaUp > 0 && q.alphaDown > 0 && q.alphaUp < 1 && q.alphaDown < 1 && Math.abs(q.alphaUp / q.alphaDown - 1) <= 0.02) return -dtF / Math.log(1 - (q.alphaUp + q.alphaDown) / 2);
      // a restarted tween (any of the three eases, any delay) that is restarted in the frame after each driver change
      // covers the fraction E((T − delay)/L) of the gap in that frame: the per-frame response an EMA with that α gives.
      // Its τ is the EMA-equivalent −T/ln(1 − E((T − delay)/L)); for expo.out without delay that is L/(10·ln 2) exactly
      // (lab case M04 g4 speed at R6: EMA α 0.3774 against restarted expo.out L 33.8 ms + 14.4 ms delay, power2.out
      // 37.5 + 8.7, power3.out 37.6 + 11.2 — all 0.377 per page frame on a sweep that moves the driver every frame)
      // That per-frame reading holds where the tween is restarted on (almost) every frame, a dense sweep. Between holds a
      // restarted expo.out is one exponential whatever its delay (the delay only shifts it in time): τ = L/(10·ln 2)
      // (lab case M02 gw5 gap at R6: EMA τ 200.34 ms against expo.out L 1386.1 ms + 0.32 ms delay = τ 199.96 ms; the
      // per-frame reading, 203.9 ms, broke the shared τ that revision 15 had found). Other eases are not exponential.
      if ((c.cls === 'restarted tween' || /^restarted/.test(c.family || '')) && RESTART_EASE[c.ease] && q.L > 0) {
        if (!denseDriver) return c.ease === 'expo.out' ? q.L / (10 * Math.LN2) : null;
        const u = (dtF - (q.delay || 0)) / q.L; if (!(u > 0 && u < 1)) return null; const a = easeAt(RESTART_EASE[c.ease], u);
        return a > 0 && a < 1 ? -dtF / Math.log(1 - a) : null; }
      return null; };
    const taus = rec.ambiguity.candidates.map(tauOf);
    if (taus.every(Number.isFinite) && Math.max(...taus) <= 1.02 * Math.min(...taus) && !rec.model.params.tau_ms && w.ease === 'expo.out' && (!denseDriver || !(w.prm.delay > 0.05 * dtF))) {
      // the restarted expo.out member won: τ = L/(10·ln 2), α per page frame = 1 − e^(−T/τ), intervals mapped from L's
      const f = 10 * Math.LN2; const Lp = rec.model.params.L; const tau = Lp.value / f; const tci = Lp.ci95.map((v) => v / f);
      rec.model.params.tau_ms = pv(tau, 'fitted', { unit: 'ms', ci95: tci }); rec.model.params.alpha_per_frame = pv(1 - Math.exp(-dtF / tau), 'fitted', { ci95: tci.map((t) => 1 - Math.exp(-dtF / t)) });
    }
    if (taus.every(Number.isFinite) && Math.max(...taus) <= 1.02 * Math.min(...taus)) for (const k of ['tau_ms', 'alpha_per_frame']) if (rec.model.params[k]) { rec.model.params[k].sharedByAmbiguity = true; rec.model.params[k].note = `shared by every member of the ambiguous set (τ ${taus.map((t) => t.toFixed(2)).join(' / ')} ms)`; }
  }
  rec.downgrades = guardRecord(rec);
  return rec;
}
// the probe take sees the same page, so the same scroll map: the primary's fitted map seeds the probe's smoothers (a
// probe-side map search can land on another shape and bias the probe α; lab case M02 speed draw, law read as non-LTI)
const probeMaps = (w) => { const m = w && w.map && w.law !== undefined && !w.targetsFromHolds ? mapSeed({ shape: w.mapShape, a: w.map.a, b: w.map.b, s0: w.map.s0, s1: w.map.s1 }) : null; return m ? { maps: [m] } : {}; };
const RESTART_EASE = { 'expo.out': NAMED['expo.out'].fn, 'power2.out': NAMED.easeOutQuad.fn, 'power3.out': NAMED.easeOutCubic.fn };
const alphaPage = (a, stride) => (stride > 1 ? 1 - (1 - a) ** (1 / stride) : a);
const scaleCI = (ci, aNew, aOld) => (ci ? ci.map((v) => (aOld ? (v * aNew) / aOld : v)) : null);
const tauCI = (ci, dt) => (ci ? [ -dt / Math.log(1 - Math.min(0.999999, ci[0])), -dt / Math.log(1 - Math.min(0.999999, Math.max(1e-9, ci[1]))) ].sort((a, b) => a - b) : null);

/** Frames a spring fit uses: before a terminal snap (detectSnap) and before a retarget in the last two frames (lateKink). */
function useMask(w, sigma) {
  const snap = detectSnap(w.y, sigma); const lk = lateKink(w.y, w.T, sigma);
  const cut = [snap, lk].filter((i) => i > 0); if (!cut.length) return null; const c = Math.min(...cut);
  return w.T.map((_, i) => i < c);
}

/** Time families on one segment (§4.1–4.4, §4.8), springs with integrator identification (§4.3). */
function timeRecord(s, nf, P, seg, ctx, mismatch, dec) {
  const rec = baseRecord(s, nf, P); const dt = P.dt;
  // the stage now running: names the place a budget cut happened (meter.where -> the unknown's reason); opts.trace
  // (development aid) lists [stage, evaluations this channel had spent when it started]
  const tr = (stage) => { meter.where = stage; if (ctx.opts.trace) ctx.opts.trace.push([stage, meter.chan]); };
  const w = tweenWindow(s, seg, dt);
  const bpsAbs = breakpoints(s.T, s.y, seg.b, seg.e, nf); const bps = bpsAbs.map((i) => i - seg.w0);
  const useSnap = useMask(w, nf.sigma);
  const cands = [];
  // a single tween competes even when breakpoints were found: the spike detector also fires on the jerk step of a
  // piecewise-polynomial ease (easeInOutCubic at p = 0.5; lab case M19 timer g3, read as two pieces)
  tr('tween families'); cands.push(...tweenCandidates(s, seg, dt, nf.sigma));
  if (bps.length) { const pw = piecewiseTween(w, bps, nf, dt); if (pw) cands.push(pw); }
  tr('analytic spring'); let sp = fitSpringAnalytic(w, nf.sigma, bps, useSnap);
  tr('spring retargets');
  // model-based retargets (series.springRetargets; lab case M07 p400 at R4/R5) as a second seed set for the spring forms
  let bpsSpring = null;
  { const sb = springRetargets(s.T, s.y, seg.b, seg.e, nf).map((i) => i - seg.w0).filter((i) => i > 0 && i < w.T.length);
    if (sb.length && (sb.length !== bps.length || sb.some((x, j) => x !== bps[j]))) { const sp2 = fitSpringAnalytic(w, nf.sigma, sb, useSnap); if (sp2 && (!sp || sp2.bic < sp.bic - 10)) { sp = sp2; bpsSpring = sb; } } }
  const sbps = bpsSpring ? [...bpsSpring] : [...bps];   // the retarget set the spring forms use (the tween families keep bps)
  // retargets the spike detector missed (coarse frames make every frame "kinky"): greedily add the strongest jerk
  // frame while it improves BIC by ≥ 10, up to 24 retargets
  for (let it = 0; sp && sp.rms > nf.explainBar && sbps.length < 24 && it < 24; it++) {   // cap 4 → 24 (lab case M07 p400: a retarget every 400 ms, 15 per take)
    const d3 = []; for (let i = 3; i < w.y.length; i++) d3.push([i, Math.abs(w.y[i] - 3 * w.y[i - 1] + 3 * w.y[i - 2] - w.y[i - 3])]);
    const onset = seg.b - seg.w0; const cand = d3.filter(([i]) => i > onset + 3 && i < seg.e - seg.w0 - 2 && !irregularFrame(w.T, i) && sbps.every((b) => Math.abs(b - i) > 3)).sort((a, b) => b[1] - a[1])[0];
    if (!cand) break; const nb = [...sbps, cand[0]].sort((a, b) => a - b);
    const sp2 = fitSpringAnalytic(w, nf.sigma, nb, useSnap); if (!sp2 || !(sp2.bic < sp.bic - 10)) break;
    sp = sp2; sbps.splice(0, sbps.length, ...nb);
  }
  tr('spring from rest');
  // a spring released from rest (rest before onset): the nested v0 = 0 form wins unless free v0 improves L by ≥ 10
  if (sp && seg.restBefore != null) { const sr = fitSpringAnalytic(w, nf.sigma, sbps, useSnap, { fromRest: true }); if (sr && sr.L - sp.L < 10 && sr.rms <= Math.max(nf.explainBar, sp.rms)) sp = sr; }
  if (sp) { sp.window = w; sp.seg = seg; cands.push(sp); }
  tr('ramp, step and decay families');
  const ramp = fitRamp(w, nf.sigma); if (ramp) { ramp.window = w; cands.push(ramp); }
  const step = fitStep(w, nf.sigma); if (step) { step.window = w; cands.push(step); }
  // friction needs a release: a pointer input ≤ 2 frames before the onset (§4.4); without one the same geometric
  // decay is first-order smoothing toward a constant target (α = 1 − f), never a fabricated momentum record
  // a release ends a DRAG: a pointerup preceded by pointer moves with a button down (a click alone is not a release; lab
  // case M19 click-started tween)
  const released = P.events.some((e) => e.kind === 'pointerup' && e.i >= 0 && e.i <= s.idx[seg.b] && s.idx[seg.b] - e.i <= 2
    && P.events.some((q) => q.kind === 'pointer' && q.entry && (q.entry.buttons > 0 || q.entry.ev === 'pointerdown') && q.i <= e.i && P.T[e.i] - P.T[Math.max(0, q.i)] <= 5000));
  if (!bps.length) for (const law of ['per-frame', 'dt-aware']) {
    const f = fitFriction(w, nf.sigma, law, { freeStart: (P.timing.strideInt || 1) > 1 && released }); if (!f) continue; f.window = w;   // free start/stop only for a real release (else the free stop absorbs a tween's completion: M19 at R6)
    if (!released) { f.cls = 'first-order smoothing'; f.family = `ema-to-constant:${law}`; f.emaConst = true; }
    cands.push(f);
  }
  tr('holdout and selection');
  // holdout on the explaining candidates (cost: only the 6 best by BIC)
  const expl = cands.filter((c) => c.rms <= nf.explainBar).sort((a, b) => a.bic - b.bic).slice(0, 6);
  for (const c of expl) holdout(c, nf.explainBar);
  let sel = select(cands, { explainBar: nf.explainBar });
  // springs: integrator identification whenever the analytic spring is the best or a competing explainer
  let ident = null;
  // nothing explains → an integrator may (the analytic form is the wrong model for a discrete spring, G1-4 §6.1)
  const springBest = sp && (sel.winner === sp || (sel.ambiguity && sel.ambiguity.candidates.some((c) => c.cls === 'spring')) || !sel.winner);
  // look (earlyExit; D-SCROLLBUDGET-1): nothing explains and the analytic spring is far from the samples. A linear
  // discrete spring is a sampled damped sinusoid, so the analytic form fits it to near the bar with effective (omega,
  // zeta); an integrator cannot close a gap of SPRING_NEAR × the bar (a real page: three channels of one svg at 93-105x,
  // each spending the whole 1e8 identification stage and then unexplained, which left six later elements unfitted)
  const springFar = !!(ctx.opts.earlyExit && sp && !sel.winner && !(sp.rms <= SPRING_NEAR * nf.explainBar));
  if (sp && springBest && ctx.opts.integrators !== false && !springFar) {
    tr('spring integrator identification'); ident = identifySpring(s, nf, P, seg, sp, ctx, useSnap, sbps); tr('selection after identification');
    if (ident && ident.fits.some((f) => f && f.admissible)) {
      // an admissible integrator is a spring explanation even if the analytic form is not (G1-4 §6.1)
      const bestH = ident.best || ident.fits.filter((f) => f && f.admissible).sort((a, b) => a.L - b.L)[0];
      const pt = bestH.perTake[0];
      const hc = { family: `spring:${bestH.hyp}`, cls: 'spring', n: pt.n, k: 2 + 2 + sp.model.targets.length, rss: pt.rss, rms: pt.rms, L: pt.L, bic: pt.L + (4 + sp.model.targets.length) * Math.log(pt.n), params: {}, holdout: { method: ctx.Q ? 'cross-rate (shared k, c)' : 'single take', rms: pt.rms, pass: true } };
      sel = select([...cands.filter((c) => c !== sp), hc, sp], { explainBar: nf.explainBar });
      if (sel.winner === hc || sel.winner === sp) {
        // the record's fit statistics come from whichever spring form explains (the integrator when the analytic does not)
        if ((sel.winner === hc && !(sp.rms <= nf.explainBar)) || ident.identified) { sp.rms = hc.rms; sp.rss = hc.rss; sp.n = hc.n; sp.L = hc.L; sp.bic = hc.bic; sp.holdout = hc.holdout; sp.statsFrom = hc.family; }
        sel.winner = sp; sp.identified = ident; sp.hc = hc;
      }
    }
  }
  // degenerate spring (FITFIX): an analytic spring whose ζ ends on its fit bound (0.005 or 10) is a limit of the family,
  // not a measured spring (ζ → 10 is an overdamped crawl that a tween or a decay also draws; ζ → 0.005 an undamped
  // oscillation). An identified integrator's (k, c) decides instead when there is one (its ζ has no bound: at or past
  // the bound it is the same limit). Such a fit is not reported as a spring: the best non-spring candidate takes the
  // record when one is selected (decidedBy says why), else the record is unknown (corpus: 343 records at ζ 0.005 / 10)
  let springDegenerate = null;
  if (sel.winner && sel.winner.cls === 'spring' && sp && sp.model) {
    const zs = (sp.spec || []).find((q) => q.name === 'zeta');
    const z = ident && ident.identified && ident.best && ident.best.k > 0 ? ident.best.c / (2 * Math.sqrt(ident.best.k)) : sp.model.z;
    const at = zs && Number.isFinite(z) ? (z <= zs.lo * (1 + 1e-3) ? zs.lo : z >= zs.hi * (1 - 1e-3) ? zs.hi : undefined) : undefined;
    if (at !== undefined) {
      springDegenerate = `analytic spring fit ended on the ζ bound (ζ ${+z.toPrecision(6)}, bound ${at}): a degenerate limit of the spring family, not a measured spring`;
      // an ambiguous selection stays ambiguous (unknown): dropping the spring must not promote a rival to a confident fit
      const alt = sel.ambiguity ? null : select(cands.filter((c) => c.cls !== 'spring'), { explainBar: nf.explainBar });
      if (alt && alt.winner) { sel = alt; alt.winner.decidedBy = `${springDegenerate}; next explaining family`; springDegenerate = { alt: true, detail: springDegenerate }; }
      else springDegenerate = { alt: false, detail: springDegenerate };
    }
  }
  // named ease snapping (§5.3): a named ease replaces the free bezier when it explains and ΔBIC ≤ 6
  if (sel.winner && sel.winner.family === 'bezier') { const nm = cands.filter((c) => c.family.startsWith('named:') && c.explains && (!c.holdout || c.holdout.pass) && c.bic - sel.winner.bic <= 6).sort((a, b) => a.bic - b.bic)[0]; if (nm) { sel.freeFit = sel.winner; sel.winner = nm; } }
  if (sel.winner && sel.winner.family.startsWith('named:')) sel.freeFit = cands.find((c) => c.family === 'bezier') || null;
  // sequence rule (see fitSeries): another segment of this channel decided this ease shape
  if (ctx.sibling && sel.winner && !sel.ambiguity && sel.winner.cls === 'tween' && sel.winner.family !== ctx.sibling.family) {
    const sb = ctx.sibling; const pf = sb.named ? cands.find((c) => c.family === sb.family) : fitShape(sb.label, sb.fn, sb.bezier, w, nf.sigma, useSnap);
    if (pf && pf.rms <= nf.explainBar && pf.L - sel.winner.L < 10) { if (!pf.holdout) holdout(pf, nf.explainBar); if (!pf.holdout || pf.holdout.pass !== false) { const dL = pf.L - sel.winner.L; sel.winner = pf; pf.decidedBy = `sequence: equivalent here (ΔL ${dL.toFixed(1)}) to ${sb.family}, which another segment of this channel completes as`; } }
  }
  if ((sel.ambiguity || !sel.winner) && ctx.sibling) {
    const sb = ctx.sibling; let pf = sb.named ? cands.find((c) => c.family === sb.family) : null;
    if (!pf && !sb.named) { pf = fitShape(sb.label, sb.fn, sb.bezier, w, nf.sigma, useSnap); if (pf) { pf.explains = pf.rms <= nf.explainBar; if (pf.explains) holdout(pf, nf.explainBar); } }
    if (pf && pf.rms <= nf.explainBar && (!pf.holdout || pf.holdout.pass) && (!sel.ambiguity || sb.named ? sel.ambiguity == null || sel.ambiguity.candidates.some((c) => c.family === pf.family) : true)) {
      sel.winner = pf; sel.ambiguity = null; pf.decidedBy = `sequence: another segment of this channel completes as ${sb.family}`; }
  }
  rec.rejected = sel.rejected.slice(0, 12); rec.runnerUp = summarize(sel.runnerUp);
  { const sa = selectionAmbiguity(sel, sel.winner); if (sa) rec.selectionAmbiguity = sa; }   // L9-A: decided within the noise of L
  if (ctx.opts.debug) rec.debug = cands.map((c) => ({ family: c.family, cls: c.cls, rms: c.rms, L: c.L, bic: c.bic, k: c.k, holdout: c.holdout && { rms: c.holdout.rms, pass: c.holdout.pass } })).sort((a, b) => a.bic - b.bic).slice(0, 10);
  rec.evidence.location = { kind: 'time_range', range: [w.T[0], w.T.at(-1)] };
  if (mismatch) rec.flags.push(mismatch);
  if (!seg.settled) unk(rec, 'unk_not_settled', 'motion not settled at the end of the take (U8)', 'longer take');
  if (!sel.winner) {
    rec.tier = 'unexplained'; rec.class = 'unknown'; rec.model.family = 'unexplained';
    if (springFar) rec.flags.push({ id: 'spring_identify_skipped', detail: `look: the analytic spring is ${(sp.rms / nf.explainBar).toFixed(0)}x the explain bar away; integrator identification not run` });
    rec.replay = { linear: [linearStops(w.T, w.y, 0.001), linearStops(w.T, w.y, 0.01)].map(({ points, ...x }) => x) };
    unk(rec, 'unk_unexplained', `no family explains (best ${sel.runnerUp ? sel.runnerUp.family + ' rms ' + sel.runnerUp.rms.toExponential(2) : 'none'})`, 'more takes / a probe rate; inspect the replay samples');
    rec.fit.n = w.T.length; return rec;
  }
  const win = sel.winner;
  rec.tier = 'fitted'; rec.class = win.cls; rec.model.family = win.family; if (win.decidedBy) rec.decidedBy = win.decidedBy;
  rec.fit = { ...rec.fit, n: win.n, rms: win.rms, nrmse: nf.A ? win.rms / nf.A : null, bic: win.bic, holdout: win.holdout || { method: 'none', pass: true } };
  // ridged parameters (design §5.4: spring ω/ζ, D of ease-outs): profile-likelihood intervals; the rest keep the
  // covariance interval (measured on 120 synthetic tweens + springs with 6-significant-digit serialisation noise:
  // covariance everywhere 89.7 % coverage, profile everywhere 100 %, this split — see the M2 fitter notes)
  if (win.rssWithFixed && (win.cls === 'tween' || win.family === 'spring-analytic')) for (const name of (win.cls === 'spring' ? ['omega', 'zeta'] : ['D'])) {
    const i = win.spec.findIndex((q) => q.name === name); if (i < 0) continue;
    const cov = win.params[name].ci95; const h0 = cov && cov.every(Number.isFinite) ? (cov[1] - cov[0]) / 4 : null;
    const ci = profileCI((v) => win.rssWithFixed(i, v), win.p[i], win.n, nf.sigma, { step: h0 && h0 > 0 ? h0 : Math.max(1e-6, 1e-4 * Math.abs(win.p[i])) });
    if (ci.every(Number.isFinite)) { win.params[name].ci95 = ci; win.params[name].ciMethod = 'profile likelihood'; }
    else win.params[name].ci95 = null;   // unbounded profile: the parameter is not identified in this window
  }
  rec.model.params = fittedParams(win, { t0: 'ms', D: 'ms' });
  if (win.ease) rec.model.ease = win.ease;
  if (win.bezier) rec.model.bezier = win.bezier;
  if (sel.freeFit && sel.freeFit !== win) rec.freeFit = { family: 'bezier', bezier: sel.freeFit.bezier, rms: sel.freeFit.rms, bic: sel.freeFit.bic };
  rec.derived = { ...(win.derived || {}) };
  if (win.cls === 'spring') springParams(rec, win, ident);
  if (win.cls === 'friction') {
    // per-frame vs dt-aware decay are one curve at one fixed rate (both explain): the two-rate test decides (G1-4 §8.4
    // form on the decay factor; lab case M10 dt law at R2/R4, where the per-frame fit won the BIC tie with f = 0.92²)
    let law = win.law; let lawEv = null;
    const other = cands.find((c) => c.cls === 'friction' && c.law !== win.law && c.rms <= nf.explainBar);
    if (other && !P.timing.stalls.length) {
      law = 'unknown';
      const sq = ctx.Q && matchSeries(P, ctx.Q, s);
      if (sq) { const nq = noiseFloor(sq, ctx.Q.view); const gq = matchSegment(s, segment(s, nf, { cuts: inputCuts(P, s) }), seg, sq, segment(sq, nq, { cuts: inputCuts(ctx.Q, sq) }));
        if (gq) { const fq = fitFriction(tweenWindow(sq, gq, ctx.Q.dt), nq.sigma, 'per-frame');
          const fp = win.law === 'per-frame' ? win : other;
          if (fq && fq.rms <= nq.explainBar) { const r = smoothingLaw({ alpha: 1 - fp.p[0], dtMs: P.dt }, { alpha: 1 - fq.p[0], dtMs: ctx.Q.dt }); lawEv = r; if (r.law === 'per-frame' || r.law === 'dt-aware') law = r.law; } } }
      if (law !== 'unknown' && law !== win.law) { const w2 = cands.find((c) => c.cls === 'friction' && c.law === law); if (w2) { rec.model.family = w2.family; rec.fit = { ...rec.fit, n: w2.n, rms: w2.rms, nrmse: nf.A ? w2.rms / nf.A : null, bic: w2.bic, holdout: w2.holdout || rec.fit.holdout }; rec.model.params = fittedParams(w2, { t0: 'ms', D: 'ms' }); rec.derived = { ...(w2.derived || {}) }; } }
      if (law === 'unknown') unk(rec, 'unk_friction_law', 'one fixed-rate take and no stall: per-frame and dt-aware decay are the same curve', 'a probe take at a rate ≥ 1.5× apart or an R5 stall');
    }
    rec.model.law = law; if (lawEv) rec.model.lawEvidence = lawEv; rec.derived.stoppingDistance = (rec.derived.stoppingDistance ?? win.derived.stoppingDistance);
    // undeclared sampling stride (R6) with the page period declared: a per-frame decay fitted per SAMPLE is f^stride
    // (lab case M10 at R6); the dt-aware form already runs on the sample times
    // stopping-distance CI: the stop position's own interval (stride fits) or the geometric sum v0·f/(1 − f) at the
    // friction interval (v0 held)
    { const xs = rec.model.params.xStop, fr0 = rec.model.params.friction, sd = rec.derived.stoppingDistance;
      if (xs && xs.ci95 && xs.ci95.every(Number.isFinite) && xs.value != null) rec.derived.stoppingDistance_ci95 = xs.ci95.map((v) => v - (xs.value - sd)).sort((a, b) => a - b);
      else if (fr0 && fr0.ci95 && fr0.ci95.every(Number.isFinite) && fr0.value > 0 && fr0.value < 1 && Number.isFinite(sd)) { const g = (f) => f / (1 - f); const k0 = g(fr0.value); rec.derived.stoppingDistance_ci95 = fr0.ci95.map((f) => (sd * g(Math.min(0.999999, Math.max(1e-9, f)))) / k0).sort((a, b) => a - b); } }
    const st = P.timing.strideInt || 1; const fr = rec.model.params.friction;
    if (st > 1 && P.view.dtPage && fr && fr.value != null && /per-frame/.test(rec.model.family)) {
      rec.model.strideCorrection = { stride: st, frictionPerSample: fr.value, method: 'f per page frame = f per sample^(1/stride)' };
      fr.value = Math.pow(fr.value, 1 / st); if (fr.ci95) fr.ci95 = fr.ci95.map((v) => Math.pow(Math.max(0, v), 1 / st));
    }
  }
  if (win.emaConst) {
    const f = rec.model.params.friction; rec.model.params.alpha_per_frame = pv(1 - f.value, 'fitted', { ci95: f.ci95 && [1 - f.ci95[1], 1 - f.ci95[0]] });
    rec.model.law = 'unknown';
    const sq = ctx.Q && matchSeries(P, ctx.Q, s);
    if (sq) { const nq = noiseFloor(sq, ctx.Q.view); const gq = matchSegment(s, segment(s, nf), seg, sq, segment(sq, nq));
      if (gq) { const fq = fitFriction(tweenWindow(sq, gq, ctx.Q.dt), nq.sigma, 'per-frame');
        if (fq && fq.rms <= nq.explainBar) { const r = smoothingLaw({ alpha: 1 - f.value, dtMs: P.dt }, { alpha: 1 - fq.p[0], dtMs: ctx.Q.dt }); rec.model.law = r.law; rec.model.lawEvidence = r; } } }
    if (rec.model.law === 'unknown') unk(rec, 'unk_smoothing_law', 'one fixed-rate take and no stall: per-frame EMA and dt-damp are the same curve (U5)', 'record a second rate ≥ 1.5× apart or an R5 stall take');
    rec.derived.settle_frames = Math.ceil(Math.log(1e-3) / Math.log(f.value)); rec.derived.tau_ms = -P.dt / Math.log(f.value);
  }
  if (sel.ambiguity) { rec.ambiguity = sel.ambiguity; rec.class = 'unknown'; rec.tier = 'unknown'; unk(rec, 'unk_ambiguous_class', sel.ambiguity.reason, 'second rate, stall (R5) or an interruption'); }
  if (springDegenerate) {
    rec.flags.push({ id: 'spring_zeta_bound', detail: springDegenerate.detail });
    if (!springDegenerate.alt) { rec.tier = 'unknown'; rec.class = 'unknown'; rec.model.valid_for_reproduction_only = true;
      unk(rec, 'unk_spring_degenerate', `${springDegenerate.detail}; ${sel.ambiguity ? 'the class was already ambiguous' : 'no other family explains the segment'}`, 'a longer take or a probe rate'); }
  }
  if (win.pieces) { rec.model.family = 'piecewise'; rec.model.pieces = win.pieces; rec.model.retargets = win.retargets; rec.class = win.cls; }
  // two-rate class for curves (§7)
  if (ctx.Q && (win.cls === 'tween' || win.cls === 'ramp')) {
    const sq = matchSeries(P, ctx.Q, s);
    if (sq) { const nq = noiseFloor(sq, ctx.Q.view); const gq = matchSegment(s, segment(s, nf), seg, sq, segment(sq, nq));
      if (gq) { const r = curveClass({ T: w.T, y: w.y, onsetIdx: seg.b - seg.w0, endIdx: seg.e - seg.w0, model: win.predict, dtMs: dt }, { T: sq.T.slice(gq.w0, gq.w1 + 1), y: sq.y.slice(gq.w0, gq.w1 + 1), onsetIdx: gq.b - gq.w0, dtMs: ctx.Q.dt }, nf.explainBar); rec.model.law = r.cls; rec.model.lawEvidence = r; } }
  }
  rec.replay = { samples: w.T.length, linear: null };
  rec.downgrades = guardRecord(rec);
  return rec;
}

/**
 * Retargeted motion as consecutive pieces split at the breakpoints (design §4.1 retarget semantics): each piece is
 * fitted by ramp / named eases / free bezier with free endpoints; the aggregate competes with the multi-target spring.
 */
function piecewiseTween(w, bps, nf, dt) {
  const cuts = [0, ...bps, w.T.length]; const pieces = []; let rss = 0, k = 0, n = 0;
  for (let j = 0; j + 1 < cuts.length; j++) {
    const a = Math.max(0, cuts[j] - (j ? 1 : 0)), b = cuts[j + 1] - 1; if (b - a < 3) return null;
    const T = w.T.slice(a, b + 1), y = w.y.slice(a, b + 1);
    const pw = { T, y, from: j === 0 ? w.from : null, to: j === cuts.length - 2 ? w.to : null, t0: j === 0 ? w.t0 : T[0], D: Math.max(dt, T.at(-1) - T[0]), dt, tMin: T[0] - 2 * dt, tMax: j === 0 ? w.tMax : T[1] };
    const seg = { b: 0, e: T.length - 1, w0: 0, w1: T.length - 1 };
    const cs = [fitRamp(pw, nf.sigma), ...['linear', 'ease', 'ease-in-out', 'ease-out', 'easeOutCubic', 'easeInOutCubic', 'easeOutQuad', 'easeOutExpo'].map((nm) => fitNamedSafe(nm, pw, nf.sigma)), fitBezierSafe(pw, nf.sigma)].filter(Boolean);
    const best = cs.filter((c) => Number.isFinite(c.rss)).sort((x, y2) => x.bic - y2.bic)[0]; if (!best) return null;
    // overlap frame (the retarget frame) counted once
    const m = best.predictFull; let r = 0; for (let i = j ? 1 : 0; i < y.length; i++) r += (m[i] - y[i]) ** 2;
    rss += r; k += best.k; n += y.length - (j ? 1 : 0);
    pieces.push({ family: best.family, cls: best.cls, params: paramValues(best), rms: best.rms, T0: T[0], T1: T.at(-1), predict: best.predict, seg });
  }
  const retargets = [];
  for (let j = 1; j < pieces.length; j++) {
    const tr = pieces[j].T0, h = 1e-3; const a = pieces[j - 1], b = pieces[j];
    const xa = a.predict([tr])[0], xb = b.predict([tr])[0]; const va = (xa - a.predict([tr - h])[0]) / h, vb = (b.predict([tr + h])[0] - xb) / h;
    const A = Math.max(...w.y) - Math.min(...w.y) || 1; const posCont = Math.abs(xa - xb) <= Math.max(nf.explainBar, 1e-3 * A); const velCont = Math.abs(va - vb) <= 0.05 * Math.max(Math.abs(va), Math.abs(vb), 1e-9);
    const first = pieces[0].params.from ?? w.from;
    const semantics = !posCont ? (first != null && Math.abs(xb - first) <= Math.max(nf.explainBar, 1e-3 * A) ? 'restart-from-start' : 'snap') : velCont ? 'velocity-carry' : 'from-current';
    retargets.push({ at: tr, semantics, positionContinuous: posCont, velocityContinuous: velCont, provenance: 'fitted' });
  }
  const cls = pieces.every((p) => p.cls === pieces[0].cls) ? pieces[0].cls : 'tween';
  const L = likelihood(rss, n, nf.sigma);
  const predict = (TT) => TT.map((t) => { let j = 0; while (j + 1 < pieces.length && t >= pieces[j + 1].T0) j++; return pieces[j].predict([t])[0]; });
  return { family: 'piecewise', cls, n, k, rss, rms: Math.sqrt(rss / n), L, bic: L + k * Math.log(n), params: {}, predict, pieces: pieces.map(({ predict: _p, seg, ...p }) => p), retargets, window: w, derived: { t0: pieces[0].params.t0 ?? w.t0 },
    holdout: { method: 'per-piece fits (leave-one-piece-out not applicable: each piece has its own endpoints)', rms: null, pass: true } };
}
const fitNamedSafe = (nm, w, sg) => { try { return fitNamed(nm, w, sg); } catch { return null; } };
const fitBezierSafe = (w, sg) => { try { return fitBezier(w, sg); } catch { return null; } };

// cheapest first on the same window (evaluations measured on a 1.5 s two-phase opacity ramp: I6 1.3 M, I5 6 M, I1(16) 7 M, I1(1) 49 M)
const IDENT_COST_ORDER = ['I6', 'I5', 'I4', 'I7', 'I1(16)', 'I1(8)', 'I1(4)', 'I1(2)', 'I1(1)'];

/** Integrator identification on the take set (primary + probe), seeds from per-take analytic fits. */
function identifySpring(s, nf, P, seg, sp, ctx, useSnap, bpsW) {
  const mk = (X, ser, sg, a, nfx, use, bpsW) => {
    const T = ser.T.slice(sg.w0, sg.w1 + 1), y = ser.y.slice(sg.w0, sg.w1 + 1);
    // discrete integrators switch target at a frame: the data's own acceleration-step frames are the seeds
    const t = { T, y, x0: sg.restBefore ?? y[0], sigma: nfx.sigma, explainBar: nfx.explainBar, use, seed: { t0: a.model.t0, v0: a.model.v0, targets: a.model.targets, tr: a.model.tr, trFrames: bpsW && bpsW.length === a.model.tr.length ? bpsW : null, w: a.model.w, z: a.model.z } };
    const st = X.timing.strideInt; if (st && st > 1 && X.view.dtPage) { const dp = X.view.dtPage; const n = Math.round((T.at(-1) - T[0]) / dp); t.Tsim = Array.from({ length: n + 1 }, (_, i) => Math.round((T[0] + i * dp) * 1e6) / 1e6); t.obs = T.map((x) => Math.round((x - T[0]) / dp)); }
    return t;
  };
  const takes = [mk(P, s, seg, sp, nf, useSnap, bpsW)];
  if (ctx.Q) {
    const sq = matchSeries(P, ctx.Q, s);
    if (sq) { const nq = noiseFloor(sq, ctx.Q.view); let gq = matchSegment(s, segment(s, nf), seg, sq, segment(sq, nq));
      if (gq) {
        // the probe may not have settled where the primary did (per-frame dynamics differ by rate): cut its window at
        // the primary window's end time so both cover the same targets
        const tEnd = s.T[seg.w1] + 1e-6; let w1q = gq.w1; while (w1q > gq.b + 8 && sq.T[w1q] > tEnd) w1q--; const eq = Math.min(gq.e, w1q);
        gq = { ...gq, w1: w1q, e: eq, settled: gq.settled && eq === gq.e };
        const w2 = tweenWindow(sq, gq, ctx.Q.dt); let b2 = breakpoints(sq.T, sq.y, gq.b, gq.e, nq).map((i) => i - gq.w0);
        if (b2.length !== sp.model.tr.length) { const sb2 = springRetargets(sq.T, sq.y, gq.b, gq.e, nq).map((i) => i - gq.w0).filter((i) => i > 0 && i < w2.T.length); if (sb2.length === sp.model.tr.length) b2 = sb2; }
        const u2 = useMask(w2, nq.sigma);
        // the probe needs the same number of retargets: detected spikes first, then the strongest jerk frames
        if (b2.length < sp.model.tr.length) { const on2 = gq.b - gq.w0; const d3 = []; for (let i = 3; i < w2.y.length; i++) d3.push([i, Math.abs(w2.y[i] - 3 * w2.y[i - 1] + 3 * w2.y[i - 2] - w2.y[i - 3])]);
          for (const [i] of d3.filter(([i]) => i > on2 + 3 && i < gq.e - gq.w0 - 2 && !irregularFrame(w2.T, i)).sort((a, b) => b[1] - a[1])) { if (b2.length >= sp.model.tr.length) break; if (b2.every((b) => Math.abs(b - i) > 3)) b2.push(i); } b2.sort((a, b) => a - b); }
        const a2 = b2.length === sp.model.tr.length ? fitSpringAnalytic(w2, nq.sigma, b2, u2) : null;
        if (a2) takes.push(mk(ctx.Q, sq, gq, a2, nq, u2, b2)); } }
  }
  // look (opts.identifyBudget): this stage may spend that many evaluations. The cheapest hypotheses go first (I6 analytic
  // costs ~1 M evaluations, the sub-stepped I1(1) ~50 M on the same window), and when the budget runs out the stage keeps
  // the hypotheses it finished: a partial table, never claimed as an identification (see below). Without the option the
  // order is the table's and nothing is cut, as before.
  const budgeted = Number.isFinite(ctx.opts.identifyBudget) && ctx.opts.identifyBudget > 0;
  const order = budgeted ? IDENT_COST_ORDER.map((id) => HYPOTHESES.findIndex((h) => h.id === id)).filter((i) => i >= 0) : HYPOTHESES.map((h, i) => i);
  let fits = HYPOTHESES.map(() => null); let skipped = [];
  const used = withStage(budgeted ? ctx.opts.identifyBudget : Infinity, (cut) => {
    for (const i of order) {
      const h = HYPOTHESES[i];
      if (cut()) { skipped.push(h.id); continue; }
      try { fits[i] = fitHypothesis(h, takes); } catch { fits[i] = null; } finally { if (ctx.opts.trace) ctx.opts.trace.push(['hyp ' + h.id, meter.chan]); }
      if (cut()) { fits[i] = null; skipped.push(h.id); }   // a hypothesis cut mid-fit is half searched: not a candidate
    }
    // every hypothesis that fits worse than the best one is refitted from the best one's solution (its own starts can end
    // in a worse optimum; lab case M07 I1(1)/I1(2)/I5 losing to I6, and the reverse)
    const bestF = fits.filter(Boolean).sort((a, b) => a.L - b.L)[0];
    if (bestF && !cut()) fits = fits.map((f, i) => {
      if (!f || f === bestF || f.L - bestF.L < 10 || cut()) return f;
      try { const g = fitHypothesis(HYPOTHESES[i], takes, { grid: false, seedFrom: bestF }); return cut() ? f : g && g.L < f.L ? g : f; } catch { return f; }
    });
    if (cut()) skipped.push('refits');
  });
  const id = identify(fits); id.nTakes = takes.length;
  if (skipped.length) {
    // partial: the table covers only the hypotheses finished inside the budget, so no identification is claimed
    const done = fits.filter(Boolean).map((f) => f.hyp);
    id.partial = { budget: ctx.opts.identifyBudget, used, fitted: done, skipped };
    id.identified = false;
    id.reason = `integrator identification stopped at its evaluation budget (${ctx.opts.identifyBudget}): ${done.length} of ${HYPOTHESES.length} hypotheses fitted (${done.join(', ') || 'none'}; not reached: ${skipped.join(', ')})${id.best || (id.set && id.set.length) ? `; best so far ${(id.best && id.best.hyp) || id.set[0]}` : ''}. ${id.reason || ''}`.trim();
  }
  return id;
}

function springParams(rec, sp, ident) {
  const m = sp.model; const P = rec.model.params;
  rec.model.family = 'spring';
  const analytic = { omega: P.omega, zeta: P.zeta };
  rec.model.integrator = ident ? { set: ident.set, identified: !!ident.identified, takes: ident.nTakes, reason: ident.reason, table: ident.fits.filter(Boolean).map((f) => ({ hyp: f.hyp, k: f.k, c: f.c, rms: f.perTake.map((q) => q.rms), admissible: f.admissible, L: f.L })) } : { set: [], identified: false, reason: 'not run' };
  if (ident && ident.identified) {
    const b = ident.best;
    P.k = pv(b.k, 'fitted', { unit: '1/s² (k/m)', ci95: b.kCI }); P.c = pv(b.c, 'fitted', { unit: '1/s (c/m)', ci95: b.cCI });
    if (b.native) { P.kf = pv(b.native.kf, 'fitted', { unit: 'per 60 Hz frame (native I4)', ci95: b.kCI && b.kCI.map((v) => v / 3600) }); P.cf = pv(b.native.cf, 'fitted', { unit: 'per 60 Hz frame (native I4)', ci95: b.cCI && b.cCI.map((v) => v / 60) }); }
    rec.model.integrator.best = b.hyp;
    const pm = b.perTake[0].model; rec.model.replayModel = { hyp: b.hyp, k: pm.k, c: pm.c, t0: pm.t0, x0: pm.x0, v0: pm.v0, targets: pm.targets, tr: pm.tr, units: b.native ? 'native I4 (per 60 Hz frame)' : 'k/m 1/s², c/m 1/s' };
    if (b.hyp !== 'I6') { for (const k of ['omega', 'zeta']) if (P[k]) { P[k].provenance = 'inferred'; P[k].note = 'analytic equivalent; source parameters are k, c with the identified integrator'; } rec.model.valid_for_reproduction_only = false; }
    rec.model.valid_at.refresh_hz = b.hyp === 'I6' ? 'frame-invariant' : rec.model.valid_at.refresh_hz;
    // law of the identified set: one law only when every member of S shares it
    const lawOf = (h) => (h === 'I6' ? 'time-based' : /^I1/.test(h) ? 'fixed-substep' : 'per-frame');
    const laws = [...new Set(ident.set.map(lawOf))];
    rec.model.law = laws.length === 1 ? laws[0] : 'unknown';
    if (laws.length > 1) rec.model.lawEvidence = { reason: `identified set ${ident.set.join(', ')} spans ${laws.join(' / ')}; k, c agree within 2 %` };
  } else {
    P.k = pv(null, 'unknown', { reason: ident ? (ident.reason || 'integrator not identified') : 'integrator not identified', probe: 'record a take at a third rate or with a stall (R5)' });
    P.c = pv(null, 'unknown', { reason: P.k.reason, probe: P.k.probe });
    rec.model.valid_for_reproduction_only = true;
    for (const k of Object.keys(analytic)) if (P[k]) P[k].valid_for_reproduction_only = true;
    unk(rec, 'unk_spring_integrator', P.k.reason + ' (U4)', P.k.probe);
    rec.model.law = 'unknown';
  }
  // the identified integrator IS the analytic form (I6): the reported (ω, ζ) and the derived curve numbers come from the
  // identified fit (cross-rate, at the noise floor), not from the free analytic-family fit, which can sit in another
  // optimum with an extra retarget (lab case M08 retarget ζ 1.0/1.5 at R5: analytic family ω 8.29 / ζ 1.30 at the
  // explain bar while I6 fits k 100, c 30 = ω 10, ζ 1.5 at rms 3e-13)
  let mD = m, dD = sp.derived;
  const outside = (q, v) => !(q && Array.isArray(q.ci95) && q.ci95.every(Number.isFinite) && q.ci95[0] <= v && v <= q.ci95[1]);
  if (ident && ident.identified && ident.best.hyp === 'I6' && ident.best.k > 0 && (outside(P.omega, Math.sqrt(ident.best.k)) || outside(P.zeta, ident.best.c / (2 * Math.sqrt(ident.best.k))))) {
    const b = ident.best; const pm = b.perTake[0].model; const w = Math.sqrt(b.k), z = b.c / (2 * w);
    const wCI = b.kCI && b.kCI[0] > 0 ? b.kCI.map(Math.sqrt) : null; const zCI = wCI && b.cCI ? [b.cCI[0] / (2 * wCI[1]), b.cCI[1] / (2 * wCI[0])] : null;
    P.omega = pv(w, 'fitted', { unit: 'rad/s', ci95: wCI, note: 'from the identified I6 fit (k, c)' }); P.zeta = pv(z, 'fitted', { ci95: zCI, note: 'from the identified I6 fit (k, c)' });
    mD = { t0: pm.t0, w, z, v0: pm.v0 ?? m.v0, x0: pm.x0 ?? m.x0, targets: pm.targets, tr: pm.tr || [] };
    if (mD.targets && mD.targets.length && [mD.t0, mD.x0, mD.v0].every(Number.isFinite)) dD = springDerived(mD); else mD = m;
  }
  rec.derived = { ...rec.derived, t0: mD.t0, overshoot: dD.overshoot, settle2: dD.settle2, settle99: dD.settle99, omega: mD.w, zeta: mD.z };
  // overshoot CI from the ζ interval: an underdamped response's overshoot scales with e^(−πζ/√(1−ζ²)) (0 for ζ ≥ 1)
  { const zc = P.zeta && P.zeta.ci95; const os = dD.overshoot; const r = (z) => (z >= 1 ? 0 : Math.exp((-Math.PI * z) / Math.sqrt(1 - z * z)));
    if (zc && zc.every(Number.isFinite) && Number.isFinite(os)) { const r0 = r(mD.z); const lo = r0 > 0 ? (os * r(zc[1])) / r0 : 0, hi = r0 > 0 ? (os * r(Math.max(0, zc[0]))) / r0 : (zc[0] < 1 ? Infinity : 0); rec.derived.overshoot_ci95 = [Math.min(lo, hi), Math.max(lo, hi)]; } }
}

export { blindView } from './blind.js';
