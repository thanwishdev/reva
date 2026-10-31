// Normalisers: fit results (`reva.motion/0` records, design M2-fitter.md §10) and Fixture Lab truth files
// (`reva.labtruth/0`) -> mechanisms {elemKey, channel, motion, provenance, impl?, label, assumptions} for build.js.
// Nothing is guessed silently (PLAN H6): every value that is not in the input is listed under `assumptions` with its reason,
// every record that cannot become a specimen is listed under `skipped` with the reason.
import { K } from './kernel.js';
import { isSchema } from '../../util/schema.js';

// ------------------------------------------------------------------------------------------------------------ easing
const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?';
/** Any easing input -> ease spec {kind, ...} or null. Accepts specs, [x1, y1, x2, y2], names and CSS strings. */
export function parseEase(x) {
  if (x == null) return { kind: 'linear' };
  if (typeof x === 'object' && !Array.isArray(x) && x.kind) return x;
  if (Array.isArray(x)) return x.length === 4 && x.every(Number.isFinite) ? { kind: 'bezier', p: x.slice() } : null;
  const s = String(x).trim();
  if (s === 'linear' || s === 'linear-flat') return { kind: 'linear' };
  let m = new RegExp(`^cubic-bezier\\(\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\)$`, 'i').exec(s);
  if (m) return { kind: 'bezier', p: [+m[1], +m[2], +m[3], +m[4]] };
  m = /^steps\(\s*(\d+)\s*(?:,\s*([a-z-]+))?\s*\)$/.exec(s);
  if (m) return { kind: 'steps', n: +m[1], pos: m[2] || 'end' };
  if (s === 'step-start') return { kind: 'steps', n: 1, pos: 'start' };
  if (s === 'step-end') return { kind: 'steps', n: 1, pos: 'end' };
  m = /^linear\((.+)\)$/.exec(s);
  if (m) return parseLinearStops(m[1]);
  if (K.namedFn(s)) return { kind: 'named', name: s };
  return null;
}
function parseLinearStops(body) {
  const raw = [];
  for (const part of body.split(',')) {
    const t = part.trim().split(/\s+/); const y = +t[0];
    if (!Number.isFinite(y)) return null;
    const xs = t.slice(1).map((v) => parseFloat(v) / 100);
    if (!xs.length) raw.push({ y, x: null }); else for (const x of xs) raw.push({ y, x });
  }
  if (raw[0].x == null) raw[0].x = 0;
  if (raw[raw.length - 1].x == null) raw[raw.length - 1].x = 1;
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i].x != null) continue;
    let j = i; while (raw[j].x == null) j++;
    for (let q = i; q < j; q++) raw[q].x = raw[i - 1].x + ((raw[j].x - raw[i - 1].x) * (q - i + 1)) / (j - i + 1);
  }
  return { kind: 'stops', stops: raw.map((r) => [r.x, r.y]) };
}

/** Largest |dE/du| of an ease in units per second for a duration D (used to recover an amplitude from a peak velocity). */
export function unitPeakSlope(ease, D) {
  const f = K.easeFn(ease), n = 4000; let best = 0, prev = 0;
  for (let i = 1; i <= n; i++) { const e = f(i / n); best = Math.max(best, Math.abs(e - prev) * n); prev = e; }
  return (best * 1000) / D;
}

// ----------------------------------------------------------------------------------------------------------- channels
/** Recorder channel name -> specimen channel {ch, name?, mapTo?, source, assumption?}; null when not representable. */
export function channelOf(name) {
  const m = /^(ren|drv):(.+)$/.exec(String(name));
  if (!m) return null;
  const side = m[1], c = m[2];
  if (['tx', 'ty', 'rz', 'sx', 'sy', 'opacity'].includes(c)) return { ch: c, side };
  if (c.startsWith('--')) return { ch: 'var', name: c, mapTo: 'tx', side, assumption: `custom property ${c}: how the page maps it to a visual property is not in the record; mapped to translateX(px) so the box moves` };
  const bbox = { bx: 'tx', by: 'ty', bw: 'w', bh: 'h' }[c];
  if (bbox) return { ch: bbox, side, assumption: `bounding-box channel ${c} reproduced by the ${bbox} channel (base geometry is not in the record)` };
  return null;
}

// -------------------------------------------------------------------------------------------------- fit-record helpers
const pv = (p) => (p == null ? undefined : typeof p === 'object' && 'value' in p ? p.value : p);
const withheld = (p) => (p == null ? undefined : typeof p === 'object' ? (p.value != null ? p.value : p.withheld_value) : p);
const finite = (x) => Number.isFinite(x);
const iterOf = (x) => (x == null || x === 'Infinity' || x === 'infinite' || x === Infinity ? Infinity : +x);

/** I1(16) / I4 / I6 ... -> integrator spec. */
export function integratorFromHyp(h) {
  const m = /^I1\((\d+(?:\.\d+)?)\)$/.exec(String(h));
  if (m) return { id: 'i1', h: +m[1] };
  const id = String(h).toLowerCase();
  if (['i4', 'i5', 'i6', 'i7'].includes(id)) return { id };
  return null;
}

/**
 * Value range of a tween record. Order of evidence: caller ranges > fitted from/to > amplitude recovered from the peak
 * velocity (inferred) > unit range 0..1 (unknown, flagged).
 */
function rangeOf(rec, ease, D, ranges, chKey) {
  const p = rec.model.params || {}, as = [];
  const given = ranges && ranges[chKey];
  if (given) return { from: given.from, to: given.to, prov: 'given', as };
  let from = pv(p.from), to = pv(p.to);
  if (finite(from) && finite(to)) return { from, to, prov: 'fitted', as };
  const pk = rec.derived && rec.derived.peakVelocity;
  if (finite(pk) && D > 0) {
    const A = Math.sign(pk) * Math.abs(pk) / unitPeakSlope(ease, D);
    if (finite(from)) to = from + A; else if (finite(to)) from = to - A; else { from = 0; to = A; as.push({ field: 'from', value: 0, reason: 'record carries neither from nor to; start assumed 0, amplitude recovered from derived.peakVelocity' }); }
    return { from, to, prov: 'inferred', as: [...as, { field: 'amplitude', value: A, reason: 'recovered from derived.peakVelocity and the fitted ease (inferred)' }] };
  }
  return { from: finite(from) ? from : 0, to: finite(to) ? to : 1, prov: 'unknown', as: [{ field: 'range', value: [0, 1], reason: 'amplitude is not in the record (settled tweens carry no from/to): normalised 0..1' }] };
}

const num = (x, d) => (finite(+x) && x !== null ? +x : d);
/** Unanimated value of a channel (what an element shows before a declared animation exists). Unknown channels: undefined. */
const IDENTITY = { tx: 0, ty: 0, rz: 0, sx: 1, sy: 1, opacity: 1 };
/**
 * Birth emulation: a declared animation exists from its birth on (the recorder's birth time); before it the channel shows its identity
 * value. Only where the identity is evidenced: a FLIP (the record says the transform starts at -delta and ends at identity), or when
 * the caller asks (`birth: 'identity'`). Otherwise the pre-birth value is unknown (a stylesheet animation usually shows its first
 * keyframe from the start) and the animation simply fills backwards.
 */
function withBirth(motion, chn, birthMs, enabled) {
  if (!enabled || !finite(birthMs) || IDENTITY[chn.ch] === undefined || chn.ch === 'var') return motion;
  return { ...motion, birthMs, base: IDENTITY[chn.ch] };
}

// ------------------------------------------------------------------------------------------------------- fit records
/**
 * @param {object} fit           fitTakeSet result ({records, stagger, env, ...}) or a plain records array
 * @param {object} [opts]        {ranges: {'ren:tx': {from, to}}, impl: 'js'|'declared'}
 * @returns {{mechanisms: object[], skipped: object[]}}
 */
export function mechanismsFromFit(fit, opts = {}) {
  const records = Array.isArray(fit) ? fit : fit.records || [];
  const stagger = Array.isArray(fit) ? [] : fit.stagger || [];
  const mechanisms = [], skipped = [];
  const memberGroup = new Map();
  stagger.forEach((g, gi) => (g.members || []).forEach((mem) => { const [el, ch] = String(mem).split('|'); memberGroup.set(`${el}|${ch}`, gi); }));
  records.forEach((rec, ri) => {
    const skip = (reason) => skipped.push({ index: ri, channel: rec.target && rec.target.channel, tier: rec.tier, class: rec.class, reason });
    if (!rec || !isSchema(rec.schema, 'reva.motion/0')) return skip('not a reva.motion/0 record');
    const chn = channelOf(rec.target.channel);
    if (!chn) return skip(`channel ${rec.target.channel} has no specimen mapping`);
    const out = { elemKey: 'el' + rec.target.el, order: rec.target.el, channel: chn, label: `${rec.tier}:${rec.class}`, assumptions: [], source: { record: ri, channel: rec.target.channel, side: chn.side } };
    if (chn.assumption) out.assumptions.push({ field: 'channel', reason: chn.assumption });
    const g = memberGroup.get(`${rec.target.el}|${rec.target.channel}`);
    if (g != null) out.group = 'stagger' + g;
    const built = fromFitRecord(rec, opts, out);
    if (typeof built === 'string') return skip(built);
    mechanisms.push(built);
  });
  return dropShadowed(mechanisms, skipped);
}

function fromFitRecord(rec, opts, out) {
  const M = rec.model || {}, P = M.params || {};
  const hz = M.valid_at && M.valid_at.frame_ms;
  if (hz) out.frameMs = hz;
  if (rec.tier === 'declared') return fromDeclared(rec, opts, out);
  if (rec.tier === 'unknown' && M.family === 'spring' && M.valid_for_reproduction_only) return fromSpringRepro(rec, out);
  if (rec.tier !== 'fitted') return `tier ${rec.tier} (${rec.class}) has no model to rebuild`;
  const chKey = rec.target.channel;
  switch (rec.class) {
    case 'tween': {
      const ease = M.bezier ? { kind: 'bezier', p: M.bezier } : parseEase(M.ease || String(M.family || '').replace(/^named:/, ''));
      if (!ease) return `tween ease not understood: ${M.ease || M.family}`;
      const t0 = pv(P.t0), D = pv(P.D);
      if (!finite(t0) || !finite(D)) return 'tween without t0 / D';
      const r = rangeOf(rec, ease, D, opts.ranges, chKey);
      out.assumptions.push(...r.as);
      out.motion = { kind: 'tween', from: r.from, to: r.to, startMs: t0, durationMs: D, ease };
      out.provenance = { tier: 'fitted', range: r.prov, family: M.family };
      return out;
    }
    case 'ramp': {
      const t0 = pv(P.t0), D = pv(P.D), from = pv(P.from), to = pv(P.to);
      if (![t0, D, from, to].every(finite)) return 'ramp without t0 / D / from / to';
      out.motion = { kind: 'tween', from, to, startMs: t0, durationMs: D, ease: { kind: 'linear' } };
      out.provenance = { tier: 'fitted', family: 'ramp' };
      return out;
    }
    case 'step': {
      const before = pv(P.before), after = pv(P.after), at = pv(P.at);
      if (![before, after, at].every(finite)) return 'step without before / after / at';
      out.motion = { kind: 'step', atMs: at, before, after };
      out.provenance = { tier: 'fitted', family: 'step' };
      return out;
    }
    case 'spring': return fromSpringFitted(rec, out);
    case 'friction': {
      const f = pv(P.friction), v0 = pv(P.v0), t0 = (rec.derived && rec.derived.t0) != null ? rec.derived.t0 : pv(P.t0);
      if (![f, v0, t0].every(finite)) return 'friction without friction / v0 / t0';
      const dtAware = /dt/.test(String(M.law || M.family));
      const given = opts.ranges && opts.ranges[chKey];
      out.assumptions.push({ field: 'x0', value: given ? given.from : 0, reason: given ? 'given by the caller' : 'start position is not in the record (friction fits v0 only); assumed 0' });
      const epsV = rec.derived && rec.derived.epsV;
      out.motion = { kind: 'friction', startMs: t0, x0: given ? given.from : 0, v0, friction: f, law: dtAware ? 'dt' : 'frame', ...(finite(epsV) ? { stopV: epsV } : {}) };
      out.provenance = { tier: 'fitted', family: M.family, law: M.law };
      return out;
    }
    case 'periodic': return `class periodic: tick / period parameters are not part of the record yet`;
    default: return `class ${rec.class} is not a time-based mechanism the specimens cover`;
  }
}

function fromSpringFitted(rec, out) {
  const M = rec.model, P = M.params || {}, R = M.replayModel;
  if (!R) return 'spring record without replayModel';
  const integ = integratorFromHyp(R.hyp);
  if (!integ) return `integrator ${R.hyp} is not in the specimen set`;
  const targets = R.targets || [], tr = R.tr || [];
  if (!targets.length) return 'spring replayModel without targets';
  const m = { kind: 'spring', integrator: integ, start: { t: R.t0, x: R.x0 || 0, v: R.v0 || 0 }, g0: targets[0], events: tr.map((t, i) => ({ t, g: targets[i + 1] })), onsetMs: R.t0 };
  if (integ.id === 'i4') { m.kf = R.k; m.cf = R.c; } else { m.k = R.k; m.c = R.c; }
  out.motion = m;
  out.provenance = { tier: 'fitted', integrator: R.hyp, integratorIdentified: !!(M.integrator && M.integrator.identified), units: R.units };
  if (!(M.integrator && M.integrator.identified)) out.assumptions.push({ field: 'integrator', reason: 'integrator not identified by the fitter; the best hypothesis is replayed' });
  return out;
}

function fromSpringRepro(rec, out) {
  const M = rec.model, P = M.params || {};
  const w = withheld(P.omega), z = withheld(P.zeta), t0 = withheld(P.t0), x0 = withheld(P.x0), v0 = withheld(P.v0), g0 = withheld(P.target);
  if (![w, z, t0, g0].every(finite)) return 'reproduction-only spring without omega / zeta / t0 / target';
  const events = []; for (let i = 1; ; i++) { const g = withheld(P['target' + i]), t = withheld(P['tr' + i]); if (!finite(g) || !finite(t)) break; events.push({ t, g }); }
  out.motion = { kind: 'spring', integrator: { id: 'i6' }, k: w * w, c: 2 * z * w, start: { t: t0, x: finite(x0) ? x0 : 0, v: finite(v0) ? v0 : 0 }, g0, events, onsetMs: t0 };
  out.provenance = { tier: 'unknown', reproductionOnly: true, validAt: M.valid_at };
  out.assumptions.push({ field: 'model', reason: 'valid_for_reproduction_only: analytic (omega, zeta) fitted at one frame period; integrator and class not decided by the fitter' });
  return out;
}

function fromDeclared(rec, opts, out) {
  const M = rec.model, P = M.params || {}, d = rec.declared || {};
  const kind = d.kind || String(M.family || '').replace(/^declared:/, '');
  if (/^smil/.test(kind) || /smil/.test(String(M.family))) {
    const dur = pv(P.duration), t0 = pv(P.t0);
    if (!finite(dur) || !finite(t0)) return 'SMIL record without duration / begin';
    const rep = pv(P.repeatCount);
    const given = opts.ranges && opts.ranges[rec.target.channel];
    out.assumptions.push({ field: 'range', value: given ? [given.from, given.to] : [0, 1], reason: given ? 'given by the caller' : 'SMIL from/to are not in the record: normalised 0..1' });
    const spline = pv(P.keySplines);
    out.motion = { kind: 'keyframes', startMs: t0, durationMs: dur, iterations: rep === 'indefinite' || rep == null ? Infinity : +rep, direction: 'normal', fill: 'both', easingScope: 'segment', easing: null,
      frames: [{ offset: 0, value: given ? given.from : 0, easing: pv(P.calcMode) === 'spline' && spline ? parseEase(String(spline).split(';')[0].trim().split(/[\s,]+/).map(Number)) : { kind: 'linear' } }, { offset: 1, value: given ? given.to : 1 }] };
    out.provenance = { tier: 'declared', kind: 'smil' };
    return out;
  }
  if (!['css', 'waapi', 'cssanimation', 'csstransition', 'animation', 'flip'].some((k) => kind.toLowerCase().includes(k))) return `declared kind ${kind} is not covered`;
  const birth = (d.births || [])[0];
  if (!birth || !Array.isArray(birth.keyframes) || !birth.keyframes.length) return 'declared record without a birth with keyframes';
  const vals = pv(P.keyframeValues);
  if (!Array.isArray(vals) || vals.length !== birth.keyframes.length) return 'declared keyframe values do not match the keyframes';
  const dur = pv(P.duration), delay = pv(P.delay) || 0, start = pv(P.start);
  if (!finite(dur) || !finite(start)) return 'declared record without duration / start';
  const isCss = /^CSS/.test(String(birth.type));
  const eff = parseEase(birth.easing);
  // computed keyframes of a two-keyframe WAAPI animation carry offset null: evenly spaced
  const n = birth.keyframes.length;
  const frames = birth.keyframes.map((kf, i) => ({ offset: kf.offset == null ? i / (n - 1) : kf.offset, value: vals[i], easing: parseEase(kf.easing) || { kind: 'linear' } }));
  out.motion = withBirth({ kind: 'keyframes', startMs: start + delay, durationMs: dur, iterations: iterOf(birth.iterations == null ? pv(P.iterations) : birth.iterations), direction: birth.direction || 'normal', fill: birth.fill || 'both',
    easingScope: isCss ? 'segment' : 'effect', easing: isCss ? null : eff, frames }, out.channel, start, kind === 'flip' || rec.subclass === 'flip' || opts.birth === 'identity');
  out.impl = isCss ? 'css' : 'waapi';
  out.provenance = { tier: 'declared', kind, valuesFrom: 'measured keyframe values (solved from samples)', birthType: birth.type };
  out.assumptions.push({ field: 'start', reason: 'birth time + delay on the take clock (recorder birth rule `next`)' });
  return out;
}

/**
 * Channels that only mirror another channel of the same element and motion are dropped (listed under `skipped`):
 *  - a `ren:` channel next to the `drv:` channel it mirrors (the driver is written, the render follows);
 *  - a `ren:--var` next to a directly renderable `ren:` channel (tx, rz, opacity, ...) of the same motion: the variable's
 *    mapping to a visual property is not in the record, the real channel is.
 */
function dropShadowed(mechs, skipped) {
  const keep = [];
  const same = (a, b) => a !== b && a.elemKey === b.elemKey && a.motion.kind === b.motion.kind && Math.abs(K.startOf(a.motion) - K.startOf(b.motion)) < 50;
  const BBOX = /^ren:b[xywh]$/;
  for (const m of mechs) {
    const side = m.source && m.source.side;
    let why = null;
    if (side === 'ren' && mechs.some((d) => same(m, d) && d.source && d.source.side === 'drv')) why = 'mirrors the driver channel of the same element and motion';
    else if (side === 'ren' && m.channel.ch === 'var' && mechs.some((d) => same(m, d) && d.channel.ch !== 'var' && d.source && d.source.side === 'ren')) why = 'variable channel shadowed by a directly renderable channel of the same motion';
    else if (m.source && BBOX.test(m.source.channel || '') && mechs.some((d) => same(m, d) && d.source && /^ren:(tx|ty|sx|sy|rz|opacity)$/.test(d.source.channel || ''))) why = 'bounding-box channel derived from the transform channels of the same element and motion';
    if (why) skipped.push({ channel: m.source.channel || m.channel.name, reason: 'redundant: ' + why, tier: m.provenance && m.provenance.tier });
    else keep.push(m);
  }
  return { mechanisms: mergeSegments(keep), skipped };
}

/** Several fitted tweens on one channel of one element are the segments of one retargeted motion: a chain (last started part wins). */
function mergeSegments(mechs) {
  const out = [], seen = new Map();
  for (const m of mechs) {
    if (m.motion.kind !== 'tween' || !m.source) { out.push(m); continue; }
    const key = [m.elemKey, m.channel.ch, m.channel.name || '', m.source.side].join('|');
    if (!seen.has(key)) { seen.set(key, [m]); out.push({ __chain: key }); } else seen.get(key).push(m);
  }
  return out.map((m) => {
    if (!m.__chain) return m;
    const segs = seen.get(m.__chain).sort((a, b) => a.motion.startMs - b.motion.startMs);
    if (segs.length === 1) return segs[0];
    const first = { ...segs[0] };
    first.motion = { kind: 'chain', parts: segs.map((x) => x.motion) };
    first.assumptions = segs.flatMap((x) => x.assumptions || []);
    first.provenance = { ...segs[0].provenance, segments: segs.length };
    first.source = { ...segs[0].source, record: segs[0].source.record, records: segs.map((x) => x.source.record) };
    first.label = 'retargeted tweens';
    return first;
  });
}

/**
 * Group mechanisms into specimens: a stagger group (all members) becomes one specimen, everything else one specimen per
 * source element and motion kind.
 */
export function planSpecimens(mechanisms) {
  // stagger groups over the same set of elements describe one choreography (tx, rz and opacity of the same six cards): one specimen
  const elemSet = new Map();
  for (const m of mechanisms) if (m.group) { if (!elemSet.has(m.group)) elemSet.set(m.group, new Set()); elemSet.get(m.group).add(m.elemKey); }
  const canon = new Map();
  for (const [g, set] of elemSet) { const k = [...set].sort().join(','); if (!canon.has(k)) canon.set(k, g); }
  const groupOf = (m) => (m.group ? canon.get([...elemSet.get(m.group)].sort().join(',')) : null);
  const groups = new Map();
  for (const m of mechanisms) {
    const key = groupOf(m) || `${m.elemKey}|${m.motion.kind}|${m.provenance && m.provenance.tier}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.entries()].map(([key, mechs]) => ({ key, mechanisms: mechs }));
}

// ------------------------------------------------------------------------------------------------------ lab truth
const px = (x) => (finite(+x) && x !== null ? +x : undefined);
const selOf = (t) => String(t).split('|')[0];

/** Truth files round the frame period to 4 decimals; the recorder's grid is exactly 1000 / rate. */
function snapDt(dt) {
  if (!finite(dt)) return undefined;
  for (const hz of [120, 60, 30, 240]) if (Math.abs(dt - 1000 / hz) < 1e-3) return 1000 / hz;
  return dt;
}

/** Truth-case selection for the committed lab set: one case per (integrator|law, damping ratio, trace). */
function caseKey(c) { return `${c.params.integrator || c.params.law || ''}|${c.params.zeta != null ? 'z' + c.params.zeta : ''}|${c.trace || c.variant || ''}`; }

/**
 * Lab truth file -> cases [{id, route, params, variant, regime, frameMs, mechanisms, skipped}].
 * `opts.regime` (default R3, the 120 Hz reference rate) picks the regime of cell-style files; `opts.allCells` keeps every
 * parameter set instead of the first per (integrator|law, trace).
 */
export function casesFromLabTruth(truth, opts = {}) {
  const regime = opts.regime || 'R3';
  const cases = [];
  if (Array.isArray(truth.cells)) {
    const seen = new Set();
    for (const c of truth.cells) {
      const key = caseKey(c);
      if (!opts.allCells && seen.has(key)) continue; seen.add(key);
      const reg = c.regimes && c.regimes[regime]; if (!reg) continue;
      const dt = snapDt(reg.planned && reg.planned.dtMs);
      const r = mechanismsFromLabItems(reg.items, { route: truth.route, params: c.params, trace: c.trace, dt, birth: opts.birth });
      cases.push({ id: `${truth.route}-${c.params.integrator || c.params.law || (c.params.zeta != null ? 'z' + c.params.zeta : 'x')}-${c.trace}`, route: truth.route, params: c.params, variant: c.trace, regime, frameMs: dt || 1000 / 120, ...r });
    }
  } else if (Array.isArray(truth.items)) {
    const r = mechanismsFromLabItems(truth.items, { route: truth.route, params: truth.params, trace: truth.variant, dt: undefined, stagger: truth.stagger, metrics: truth.metrics, birth: opts.birth });
    cases.push({ id: `${truth.route}-${truth.variant}`, route: truth.route, params: truth.params, variant: truth.variant, regime: truth.regime, frameMs: 1000 / 120, ...r });
  }
  return cases;
}

function mechanismsFromLabItems(items, ctx) {
  const mechs = [], skipped = [];
  const byTarget = new Map();                                      // target -> segment items
  const tweenLike = (it) => it.class === 'tween' || it.class === 'declared';
  for (const it of items) { const key = it.target + '|' + (tweenLike(it) ? 'tween' : it.class + '/' + (it.segment || '')); if (!byTarget.has(key)) byTarget.set(key, []); byTarget.get(key).push(it); }
  for (const [, its] of byTarget) {
    const first = its[0], target = first.target;
    const skip = (reason) => skipped.push({ target, class: first.class, sub: first.sub, family: first.family, reason });
    if (first.scored === false && first.class === 'ramp') { skip('pointer-driven drag leg (not a time motion)'); continue; }
    if (first.class === 'static') { skip('static: nothing moves'); continue; }
    if (first.class === 'spring') { const m = labSpring(first, target, ctx); if (typeof m === 'string') skip(m); else mechs.push(m); continue; }
    if (first.class === 'friction') { const m = labFriction(first, target, ctx); if (typeof m === 'string') skip(m); else mechs.push(m); continue; }
    if (first.class === 'tween' || (first.class === 'declared' && ['css', 'waapi', 'flip', 'smil'].includes(first.sub)) || first.class === 'ramp') {
      const m = labTweens(its, target, ctx); if (typeof m === 'string') skip(m); else mechs.push(m); continue;
    }
    skip(`${first.class}${first.sub ? '/' + first.sub : ''} is not a seekable time mechanism (scroll- or document-driven)`);
  }
  const shadow = dropShadowed(mechs.map((m) => ({ ...m, source: { side: m.side } })), skipped);
  return { mechanisms: shadow.mechanisms.map(({ source, ...m }) => m), skipped };
}

function labChannel(target) {
  const ch = String(target).split('|')[1] || '';
  const c = channelOf(ch.includes(':') ? ch : (ch.startsWith('--') ? 'drv:' + ch : 'ren:' + ch));
  return c;
}

function labSpring(it, target, ctx) {
  const P = it.params, chn = labChannel(target);
  if (!chn) return 'channel not representable';
  const id = String(it.integrator || 'i6');
  const integ = K.integratorOf(id === 'i1h16' || /^i1h/.test(id) ? id : id);
  const ev = (it.retargets || []).map((r) => ({ t: r.t_ms, g: r.target_px, ...(finite(r.v0_px_s) && r.v0_px_s !== null ? { v: r.v0_px_s } : {}) }));
  if (!ev.length) return 'spring truth without retargets';
  const m = { kind: 'spring', integrator: integ, start: { t: 0, x: 0, v: 0 }, g0: 0, events: ev, onsetMs: ev[0].t };
  if (integ.id === 'i4') { m.kf = P.native.kf; m.cf = P.native.cf; } else { m.k = P.k_over_m != null ? P.k_over_m : P.omega0 * P.omega0; m.c = P.c_over_m != null ? P.c_over_m : 2 * P.zeta * P.omega0; }
  if (integ.id === 'i7' || integ.id === 'i4') { if (P.dt_cap_ms) m.cap = P.dt_cap_ms; }
  if (P.snap && integ.id !== 'i6') m.snap = { x: P.snap.x_px, v: P.snap.v_px_s };
  return { elemKey: selOf(target), channel: chn, motion: m, provenance: { tier: 'truth', route: ctx.route, integrator: id }, label: `spring ${id}`, assumptions: [], side: chn.side };
}

function labFriction(it, target, ctx) {
  const P = it.params, D = it.derived || {}, chn = labChannel(target);
  if (!chn) return 'channel not representable';
  const rel = D.release_ms, x0 = D.x_at_release_px, v0 = P.release_velocity_px_per_frame_60hz;
  if (![rel, x0, v0, P.friction].every(finite)) return 'friction truth without release state';
  // the coast starts at the last frame at or before the release: the page integrates it frame by frame, so the first coast frame sees the full frame gap
  const startMs = ctx.dt ? Math.floor((rel + 1e-6) / ctx.dt) * ctx.dt : rel;
  return { elemKey: selOf(target), channel: chn, motion: { kind: 'friction', startMs, x0, v0, friction: P.friction, law: /dt/.test(String(P.law)) ? 'dt' : 'frame', stopV: P.stop_eps_px_per_frame },
    provenance: { tier: 'truth', route: ctx.route }, label: 'friction', assumptions: [{ field: 'drag leg', reason: 'the pointer-driven drag before the release is omitted; the coast starts at the release state' }], side: chn.side };
}

/** One or more segments of a tween-like truth item (retargets become a chain). */
function labTweens(its, target, ctx) {
  const chn = labChannel(target);
  if (!chn) return 'channel not representable';
  const parts = [];
  let declaredCandidate = null;
  for (const it of its) {
    const P = it.params || {};
    if (it.sub === 'smil') {
      const dur = P.duration_ms, t0 = P.begin_ms, from = P.from, to = P.to;
      if (![dur, t0, from, to].every(finite)) return 'SMIL truth without duration / begin / from / to';
      const spl = P.key_splines ? parseEase(P.key_splines) : { kind: 'linear' };
      return { elemKey: selOf(target), channel: chn, side: chn.side, label: 'smil sawtooth', provenance: { tier: 'truth', route: ctx.route, kind: 'smil' }, assumptions: chn.assumption ? [{ field: 'channel', reason: chn.assumption }] : [],
        motion: { kind: 'keyframes', startMs: t0, durationMs: dur, iterations: P.repeat === 'indefinite' ? Infinity : +P.repeat || 1, direction: 'normal', fill: 'both', easingScope: 'segment', easing: null,
          frames: [{ offset: 0, value: from, easing: spl || { kind: 'linear' } }, { offset: 1, value: to }] } };
    }
    if (it.class === 'declared') {
      const d = P.declared || P;
      const start = (d.start_ms != null ? d.start_ms : P.start_ms) + (d.delay_ms || 0);
      const dur = d.duration_ms != null ? d.duration_ms : P.duration_ms;
      const easing = d.easing != null ? d.easing : P.easing;
      const from = P.from, to = P.to;
      if (![start, dur, from, to].every(finite)) return 'declared truth without start / duration / from / to';
      if (d.keyframes && d.keyframes.length > 2 && Array.isArray(d.keyframes)) {
        // hold: a keyframe with easing 'linear-flat' keeps its value until the next keyframe (value equals the next one's predecessor)
        const kf = d.keyframes; const vals = [from];
        for (let i = 1; i < kf.length; i++) vals.push(i === kf.length - 1 ? to : (kf[i - 1].easing === 'linear-flat' ? vals[i - 1] : from + (to - from) * kf[i].offset));
        declaredCandidate = withBirth({ kind: 'keyframes', startMs: start, durationMs: dur, iterations: iterOf(d.iterations), direction: 'normal', fill: d.fill || 'both', easingScope: 'segment', easing: null,
          frames: kf.map((k, i) => ({ offset: k.offset, value: vals[i], easing: parseEase(k.easing) || { kind: 'linear' } })) }, chn, d.start_ms != null ? d.start_ms : P.start_ms, it.sub === 'flip' || ctx.birth === 'identity');
        parts.push(null);
      } else {
        const ease = parseEase(easing); if (!ease) return `easing not understood: ${JSON.stringify(easing)}`;
        parts.push(withBirth({ kind: 'tween', from, to, startMs: start, durationMs: dur, ease }, chn, d.start_ms != null ? d.start_ms : P.start_ms, it.sub === 'flip' || ctx.birth === 'identity'));
        parts[parts.length - 1]._impl = it.sub === 'waapi' || it.sub === 'flip' ? 'waapi' : 'css';
      }
    } else if (it.class === 'ramp' && it.family === 'quantised-ramp') {
      const t0 = P.t0_ms, dur = P.duration_ms, len = P.length;
      if (![t0, dur, len, P.lattice].every(finite)) return 'quantised ramp without t0 / duration / length / lattice';
      parts.push({ kind: 'tween', from: 0, to: len, startMs: t0, durationMs: dur, ease: { kind: 'linear' }, quantum: P.lattice, _impl: 'js' });
    } else {
      const t0 = P.t0_ms, dur = P.duration_ms, from = P.from, to = P.to;
      if (![t0, dur, from, to].every(finite)) return 'tween truth without t0 / duration / from / to';
      const ease = parseEase(P.ease); if (!ease) return `ease not understood: ${JSON.stringify(P.ease)}`;
      parts.push({ kind: 'tween', from, to, startMs: t0, durationMs: dur, ease, _impl: 'js' });
    }
  }
  const asm = chn.assumption ? [{ field: 'channel', reason: chn.assumption }] : [];
  if (declaredCandidate) return { elemKey: selOf(target), channel: chn, side: chn.side, motion: declaredCandidate, impl: 'css', label: 'declared keyframes', provenance: { tier: 'truth', route: ctx.route, kind: 'css' }, assumptions: asm };
  const impl = parts[0]._impl;
  const clean = parts.map(({ _impl, ...t }) => t);
  if (clean.length === 1) return { elemKey: selOf(target), channel: chn, side: chn.side, motion: clean[0], impl: impl === 'js' ? undefined : impl, label: 'tween', provenance: { tier: 'truth', route: ctx.route }, assumptions: asm };
  return { elemKey: selOf(target), channel: chn, side: chn.side, motion: { kind: 'chain', parts: clean }, label: 'retargeted tweens', provenance: { tier: 'truth', route: ctx.route, segments: clean.length }, assumptions: asm };
}
