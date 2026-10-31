// `reva compare`: does page B move like page A? Two look results of the same action and target, compared motion by motion
// and value by value (start, duration, curve, start / end values, stagger). Typical use: A = the original site, B = a
// rebuild made from REVA's numbers. Pure: look results in, a comparison out (no browser here; src/compare/run.js runs
// the two looks, one after the other).
import { fittedProgress } from '../card/data.js';
import { progressOf } from '../mcp/analysis.js';
import { familyKind } from '../export/index.js';
import { settleMs } from '../export/curves.js';
import { channelWord } from '../look/words.js';
import { CONTROL_CHARS } from '../report/untrusted.js';

export const COMPARE_SCHEMA = 'reva.compare/0';

/**
 * What a person would not see, in one place. Each entry: `same` = within it nobody sees a difference; `close` = a trained
 * eye might, side by side; beyond `close` = different.
 *  - time (start, duration, stagger step): one frame at 120 Hz or 3 % of the longer value; close: 4 frames or 10 %
 *  - curve: the largest gap between the two eased curves over 0-1 of their own durations, as a share of the travel
 *  - values by channel kind: px (position, size) 1 px, opacity 0.01, scale 0.01, angle 0.5 deg; close also allows a share
 *    of the travel
 *  - scroll range (a scroll-linked value): 1 px of scroll or 3 %; close: 8 px or 10 %
 */
export const COMPARE_TOL = {
  time: { sameMs: 1000 / 120, sameShare: 0.03, closeMs: 4000 / 120, closeShare: 0.10 },
  curve: { same: 0.02, close: 0.06 },
  value: {
    px: { same: 1, close: 3, closeShare: 0.05, unit: 'px' },
    opacity: { same: 0.01, close: 0.03, closeShare: 0.05, unit: '' },
    scale: { same: 0.01, close: 0.03, closeShare: 0.05, unit: '' },
    deg: { same: 0.5, close: 2, closeShare: 0.05, unit: 'deg' },
    other: { same: 0.01, close: 0.03, closeShare: 0.05, unit: '', sameShare: 0.01 },
  },
  scroll: { samePx: 1, sameShare: 0.03, closePx: 8, closeShare: 0.10 },
};
const CURVE_N = 101;       // samples of each normalised curve (0, 0.01, ... 1)
const PLOT_N = 80;         // points per side of the overlay plot (card)

const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const labelOf = (rec) => (rec.tier === 'declared' ? 'exact' : rec.tier === 'fitted' ? 'fitted' : 'unknown');

/** Which tolerance a channel's values use. */
export function valueKind(ch) {
  const c = String(ch || '');
  if (/opacity/.test(c)) return 'opacity';
  if (/^ren:(sx|sy|s|scale(\.[xyz])?)$/.test(c)) return 'scale';
  if (/^ren:(rz|rx|ry|skx|sky|rotate)$/.test(c)) return 'deg';
  if (/^ren:(tx|ty|tz|bx|by|bw|bh|translate\.[xyz])$|clipPath|radius|^ren:w$|^ren:h$/.test(c)) return 'px';
  return 'other';
}

/** same / close / different for a time pair (ms). */
export function judgeTime(a, b) {
  const T = COMPARE_TOL.time; const d = Math.abs(b - a); const big = Math.max(Math.abs(a), Math.abs(b));
  return d <= Math.max(T.sameMs, T.sameShare * big) ? 'same' : d <= Math.max(T.closeMs, T.closeShare * big) ? 'close' : 'different';
}
/** same / close / different for a scroll position pair (px of scroll). */
function judgeScroll(a, b) {
  const T = COMPARE_TOL.scroll; const d = Math.abs(b - a); const big = Math.max(Math.abs(a), Math.abs(b));
  return d <= Math.max(T.samePx, T.sameShare * big) ? 'same' : d <= Math.max(T.closePx, T.closeShare * big) ? 'close' : 'different';
}
/** same / close / different for an end value of a channel; `travel` = A's travel (for the share). */
export function judgeValue(ch, a, b, travel = null) {
  const T = COMPARE_TOL.value[valueKind(ch)]; const d = Math.abs(b - a); const tr = Math.abs(travel || 0);
  const same = Math.max(T.same, (T.sameShare || 0) * tr);
  return d <= same + 1e-9 ? 'same' : d <= Math.max(T.close, T.closeShare * tr) + 1e-9 ? 'close' : 'different';
}
export const judgeCurve = (m) => (m <= COMPARE_TOL.curve.same ? 'same' : m <= COMPARE_TOL.curve.close ? 'close' : 'different');
const WORST = ['same', 'close', 'different'];
const worst = (vs) => vs.reduce((w, v) => (WORST.indexOf(v) > WORST.indexOf(w) ? v : w), 'same');

/** The action's time on a look's take clock (lines carry t0 and rel = t0 - action); 0 for a load. */
export function actionTime(look) {
  const ds = [];
  for (const m of look.motions || []) for (const l of m.lines || []) if (num(l.t0) != null && num(l.rel) != null) ds.push(l.t0 - l.rel);
  if (!ds.length) return 0;
  ds.sort((x, y) => x - y); return ds[ds.length >> 1];
}

/**
 * Start and end values a record states itself: the declared keyframes [exact], a spring's start / target, a scroll map's
 * two ends, or fitted from / to params [fitted]. null when it states none (the caller can read the recording instead).
 */
export function ownEnds(rec, fp = null) {
  const P = (k) => { const p = rec.model && rec.model.params && rec.model.params[k]; return p ? num(p.value) : null; };
  const kf = rec.model && rec.model.params && rec.model.params.keyframeValues;
  if (kf && Array.isArray(kf.value) && kf.value.length >= 2) {
    const v = kf.value.map(Number); if (v.every(Number.isFinite)) return { from: v[0], to: v[v.length - 1], label: 'exact' };
  }
  if (fp && num(fp.from) != null && num(fp.to) != null) return { from: fp.from, to: fp.to, label: labelOf(rec) };
  const m = rec.model && rec.model.map;
  if (m && num(m.a) != null && num(m.b) != null) return { from: r3(m.a), to: r3(m.a + m.b), label: 'fitted' };
  if (P('from') != null && P('to') != null) return { from: P('from'), to: P('to'), label: labelOf(rec) };
  if (P('x0') != null && P('target') != null) return { from: P('x0'), to: P('target'), label: labelOf(rec) };
  return null;
}

/**
 * One record reduced to what is compared. `tRef`: the action time of its look; `endsOf(rec)`: optional {from, to, label}
 * from the recording, used when the record states no ends of its own.
 */
export function segmentOf(rec, { tRef = 0, endsOf = null } = {}) {
  const fam = String((rec.model && rec.model.family) || '');
  const label = labelOf(rec);
  let fp = null; try { fp = fittedProgress(rec); } catch { fp = null; }
  let kind = familyKind(fam) || rec.class || null;
  let fn = null, span = null, start = null, durationMs = null, durationWord = 'lasts', axis = 'time';
  if (fp && fp.axis === 'time') { fn = fp.fn; start = fp.t0; span = fp.span; durationMs = fp.span; }
  else if (fp && fp.axis === 'step') { fn = fp.fn; span = fp.span; durationMs = fp.tau; durationWord = 'follows with a lag of'; }
  else if (fp && fp.axis === 'scroll') { axis = 'scroll'; fn = fp.fn; start = fp.s0; span = fp.span; }
  else {
    let pr = null; try { pr = progressOf(rec); } catch { pr = null; }
    if (pr && pr.p) { fn = pr.p; span = pr.kind === 'tween' ? pr.D : pr.kind === 'smoothing' ? 5 * pr.tau : settleMs(pr.p, 0.01, 20000); durationMs = pr.kind === 'smoothing' ? pr.tau : span; kind = pr.kind; }
  }
  if (kind === 'spring' && fn) {
    // a spring has no fixed duration: the time it takes to stay within 1 % of its travel (look's "settles in")
    const s = rec.derived && num(rec.derived.settle99);
    durationMs = s ?? settleMs(fn, 0.01, 20000); durationWord = 'settles in';
  }
  if (start == null && axis === 'time') {
    const d = rec.derived || {}; const P = (k) => { const p = rec.model && rec.model.params && rec.model.params[k]; return p ? num(p.value) : null; };
    start = /^declared:/.test(fam) ? num(d.visibleOnset) ?? num(d.t0) : P('t0') ?? num(d.t0);
  }
  if (axis === 'time' && start != null) start -= tRef;
  // the shape: progress over 0-1 of its own span (a spring: of its 1 % settle), so duration and curve are judged apart
  const shapeSpan = kind === 'spring' && durationMs > 0 ? durationMs : span;
  const curve = fn && shapeSpan > 0 ? Array.from({ length: CURVE_N }, (_, i) => r3(axis === 'scroll' ? fn(start + (i / (CURVE_N - 1)) * shapeSpan) : fn((i / (CURVE_N - 1)) * shapeSpan))) : null;
  const own = ownEnds(rec, fp);
  let ends = own;
  if (!ends && endsOf) { try { ends = endsOf(rec) || null; } catch { ends = null; } }
  // the overlay for the card: progress against time since the action (or against scroll px), from a little before the start
  let plot = null;
  if (fn && span > 0) {
    const s0 = axis === 'time' ? (start ?? 0) : axis === 'scroll' ? start : 0;
    const lo = s0 - span * 0.1, hi = s0 + span * 1.15;
    plot = Array.from({ length: PLOT_N + 1 }, (_, i) => { const x = lo + ((hi - lo) * i) / PLOT_N; return [r1(x), r3(axis === 'scroll' ? fn(x) : fn(x - s0))]; });
  }
  const scrollEnd = axis === 'scroll' && start != null && span != null ? start + span : null;
  return {
    channel: rec.target.channel, family: fam || null, kind, label, axis,
    start: start != null ? r1(start) : null, durationMs: durationMs != null ? r1(durationMs) : null, durationWord,
    scrollEnd: scrollEnd != null ? r1(scrollEnd) : null,
    from: ends && num(ends.from) != null ? r3(ends.from) : null, to: ends && num(ends.to) != null ? r3(ends.to) : null,
    endsLabel: ends ? ends.label || 'fitted' : null,
    curve, plot,
  };
}

/** A motion of a look reduced to what is paired and compared. */
export function motionOf(m, opts = {}) {
  const recs = (m.records || []).filter((r) => r && r.target && r.tier !== 'unknown' && r.tier !== 'not_applicable' && (m.lead == null || r.target.el === m.lead));
  const segs = recs.map((r) => segmentOf(r, opts)).filter((s) => s.curve || s.start != null || s.durationMs != null);
  const byCh = new Map();
  for (const s of segs) byCh.set(s.channel, [...(byCh.get(s.channel) || []), s]);
  for (const v of byCh.values()) v.sort((x, y) => (x.start ?? Infinity) - (y.start ?? Infinity));
  const starts = segs.map((s) => (s.axis === 'time' ? s.start : null)).filter((x) => x != null);
  const st = m.stagger && (m.stagger.values || [])[0];
  return {
    rank: m.rank, desc: m.desc || null, selector: m.selector || null, leadSelector: m.leadSelector || null, box: m.box || null,
    count: m.count || 1, weightShare: num(m.weightShare), first: starts.length ? Math.min(...starts) : null, channels: byCh,
    stagger: st && num(st.value) != null ? { stepMs: st.value, label: st.label || 'fitted', n: m.stagger.n ?? null }
      : m.starts && Array.isArray(m.starts.offsetsMs) && m.starts.offsetsMs.length > 1 ? { stepMs: r1(m.starts.spreadMs / (m.starts.offsetsMs.length - 1)), label: 'fitted', n: m.starts.n, fromStarts: true } : null,
  };
}

/** The motions of a look that can be compared (its page scroll first, when it has one with records). */
export function motionsOfLook(look, opts = {}) {
  const tRef = actionTime(look);
  const o = { ...opts, tRef, endsOf: opts.endsOf ? (rec) => opts.endsOf(look, rec) : null };
  const out = [];
  if (look.page && (look.page.records || []).length) out.push(motionOf({ ...look.page, rank: 0, desc: 'the page scroll', selector: '(page)', lead: null }, o));
  for (const m of look.motions || []) out.push(motionOf(m, o));
  return out.filter((m) => m.channels.size);
}

/**
 * Pair the motions of A and B: the same selector, then the same lead selector, then the same unique descriptor; the rest
 * by start order and visual weight among motions that move at least one channel in common.
 */
export function pairMotions(A, B) {
  const pairs = []; const usedB = new Set(); const leftA = [];
  for (const a of A) {
    let hit = null, by = null;
    for (const [k, word] of [['selector', 'selector'], ['leadSelector', 'lead selector']]) {
      if (hit || !a[k]) continue;
      const c = B.filter((b) => !usedB.has(b) && b[k] === a[k]); if (c.length === 1) { hit = c[0]; by = word; }
    }
    if (!hit && a.desc) {
      const c = B.filter((b) => !usedB.has(b) && b.desc === a.desc);
      if (c.length === 1 && A.filter((x) => x.desc === a.desc).length === 1) { hit = c[0]; by = 'descriptor'; }
    }
    if (hit) { usedB.add(hit); pairs.push({ a, b: hit, by }); } else leftA.push(a);
  }
  const onlyA = [];
  const share = (x, y) => [...x.channels.keys()].some((c) => y.channels.has(c));
  for (const a of [...leftA].sort((x, y) => (x.first ?? Infinity) - (y.first ?? Infinity))) {
    const c = B.filter((b) => !usedB.has(b) && share(a, b));
    if (!c.length) { onlyA.push(a); continue; }
    const cost = (b) => Math.abs((b.first ?? 0) - (a.first ?? 0)) / 100 + Math.abs(Math.log(((b.weightShare ?? 0.01) + 1e-3) / ((a.weightShare ?? 0.01) + 1e-3)));
    const best = c.sort((x, y) => cost(x) - cost(y))[0]; usedB.add(best); pairs.push({ a, b: best, by: 'start order and visual weight' });
  }
  pairs.sort((x, y) => x.a.rank - y.a.rank);
  return { pairs, onlyA, onlyB: B.filter((b) => !usedB.has(b)) };
}

/** Largest gap between two normalised curves and where it is ('at the start' / 'in the middle' / 'at the end'). */
export function curveGap(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let m = 0, at = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) { m = d; at = i / (a.length - 1); } }
  return { maxDiff: r3(m), at: r3(at), where: at < 0.34 ? 'at the start' : at < 0.67 ? 'in the middle' : 'at the end' };
}

const val = (a, b, verdict, extra = {}) => ({ a, b, diff: a != null && b != null ? r3(b - a) : null, verdict, ...extra });

/** Two segments of one channel, value by value. */
export function compareSegments(sa, sb) {
  const out = { channel: sa.channel, labels: { a: sa.label, b: sb.label }, values: {} };
  const V = out.values;
  if (sa.kind && sb.kind && sa.kind !== sb.kind) V.law = { a: sa.kind, b: sb.kind, verdict: 'different' };
  if (sa.axis === 'scroll' || sb.axis === 'scroll') {
    if (sa.axis === sb.axis) {
      if (sa.start != null && sb.start != null) V.scrollStart = val(sa.start, sb.start, judgeScroll(sa.start, sb.start), { unit: 'px of scroll' });
      if (sa.scrollEnd != null && sb.scrollEnd != null) V.scrollEnd = val(sa.scrollEnd, sb.scrollEnd, judgeScroll(sa.scrollEnd, sb.scrollEnd), { unit: 'px of scroll' });
    } else V.axis = { a: sa.axis, b: sb.axis, verdict: 'different' };
  } else if (sa.start != null && sb.start != null) V.start = val(sa.start, sb.start, judgeTime(sa.start, sb.start), { unit: 'ms', labels: { a: sa.label, b: sb.label } });
  if (sa.durationMs != null && sb.durationMs != null) V.duration = val(sa.durationMs, sb.durationMs, judgeTime(sa.durationMs, sb.durationMs), { unit: 'ms', word: sa.durationWord, labels: { a: sa.label, b: sb.label } });
  const g = curveGap(sa.curve, sb.curve);
  if (g) V.curve = { ...g, verdict: judgeCurve(g.maxDiff), labels: { a: sa.label, b: sb.label } };
  const travel = sa.from != null && sa.to != null ? sa.to - sa.from : null;
  for (const k of ['from', 'to']) if (sa[k] != null && sb[k] != null) V[k] = val(sa[k], sb[k], judgeValue(sa.channel, sa[k], sb[k], travel), { unit: COMPARE_TOL.value[valueKind(sa.channel)].unit, labels: { a: sa.endsLabel, b: sb.endsLabel } });
  // a declared end of a spring may sit a hair from the fitted target; a time-based curve on a scroll map is a different law
  const vs = Object.values(V).map((v) => v.verdict);
  out.verdict = vs.length ? worst(vs) : 'unknown';
  out.plot = { a: sa.plot, b: sb.plot, axis: sa.axis };
  return out;
}

/** One motion pair: every channel both move, segment by segment; channels only one side moves are named. */
export function comparePairMotion(a, b) {
  const channels = []; const onlyA = [], onlyB = [];
  for (const [ch, segsA] of a.channels) {
    const segsB = b.channels.get(ch);
    if (!segsB) { onlyA.push(ch); continue; }
    const n = Math.min(segsA.length, segsB.length);
    for (let i = 0; i < n; i++) channels.push({ ...compareSegments(segsA[i], segsB[i]), segment: i + 1, segments: { a: segsA.length, b: segsB.length } });
  }
  for (const ch of b.channels.keys()) if (!a.channels.has(ch)) onlyB.push(ch);
  let stagger = null;
  if (a.stagger && b.stagger) stagger = { ...val(a.stagger.stepMs, b.stagger.stepMs, judgeTime(a.stagger.stepMs, b.stagger.stepMs)), unit: 'ms', labels: { a: a.stagger.label, b: b.stagger.label } };
  else if (a.stagger || b.stagger) stagger = { a: a.stagger ? a.stagger.stepMs : null, b: b.stagger ? b.stagger.stepMs : null, verdict: 'different', unit: 'ms' };
  const segMismatch = channels.some((c) => c.segments.a !== c.segments.b);
  const vs = [...channels.map((c) => c.verdict).filter((v) => v !== 'unknown'), ...(stagger ? [stagger.verdict] : []), ...(onlyA.length || onlyB.length || segMismatch ? ['different'] : [])];
  return { channels, onlyA, onlyB, stagger, verdict: vs.length ? worst(vs) : 'unknown' };
}

// ---------- words ----------

const ms = (x) => `${Math.round(x)} ms`;
const signedMs = (x) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x))} ms`;
const fmtV = (x, unit) => `${Math.abs(x) >= 10 ? Math.round(x * 10) / 10 : r3(x)}${unit ? ` ${unit}` : ''}`;
const nameOf = (m) => `${m.desc || 'element'}${m.count > 1 ? ` ×${m.count}` : ''}${m.selector && m.selector !== m.desc ? ` (${m.selector})` : ''}`;
const later = (d, w = 'later', e = 'earlier') => `${Math.round(Math.abs(d))} ms ${d > 0 ? w : e}`;

/** The phrases of one compared value that is not the same. */
function phrase(key, v, ch) {
  const cw = channelWord(ch); const close = '';
  switch (key) {
    case 'law': return `A is a ${v.a}, B a ${v.b}`;
    case 'axis': return `A follows ${v.a === 'scroll' ? 'the scroll' : 'time'}, B ${v.b === 'scroll' ? 'the scroll' : 'time'}`;
    case 'start': return `${close}B starts ${later(v.diff)} (${signedMs(v.a)} → ${signedMs(v.b)} after the ${'action'})`;
    case 'duration': return v.word === 'settles in' ? `${close}B settles ${later(v.diff)} (${ms(v.a)} → ${ms(v.b)})`
      : v.word === 'follows with a lag of' ? `${close}B follows ${v.diff > 0 ? 'more slowly' : 'faster'} (lag ${ms(v.a)} → ${ms(v.b)})`
      : `${close}B lasts ${Math.round(Math.abs(v.diff))} ms ${v.diff > 0 ? 'longer' : 'shorter'} (${ms(v.a)} → ${ms(v.b)})`;
    case 'curve': return `${close}curve differs ${v.where} (up to ${Math.round(v.maxDiff * 100)} % of the travel)`;
    case 'from': return `${close}${cw} starts from ${fmtV(v.b, v.unit)} in B, ${fmtV(v.a, v.unit)} in A`;
    case 'to': return `${close}${cw} ends at ${fmtV(v.b, v.unit)} in B, ${fmtV(v.a, v.unit)} in A`;
    case 'scrollStart': return `${close}B starts at ${Math.round(v.b)} px of scroll, A at ${Math.round(v.a)} px`;
    case 'scrollEnd': return `${close}B ends at ${Math.round(v.b)} px of scroll, A at ${Math.round(v.a)} px`;
    default: return null;
  }
}

/** The plain line of one pair. */
export function pairLine(p) {
  const name = nameOf(p.a);
  const r = p.result; const parts = [];
  const timeKeys = ['start', 'duration', 'scrollStart', 'scrollEnd'];
  const seen = new Set(); const add0 = (s) => { if (s && !seen.has(s)) { seen.add(s); parts.push(s); } };
  // inside a pair that is different, a value that is only close says so
  let cur = null; const add = (s) => { const o = add0(s && cur === 'close' && r.verdict === 'different' ? `${s} (close)` : s); cur = null; return o; };
  const at = (v, s) => { cur = v ? v.verdict : null; return s; };
  const multi = new Set(r.channels.map((c) => c.channel)).size > 1;
  const tag = (c, s) => (multi && s && !/^(A is|A follows)/.test(s) ? `${channelWord(c.channel)}: ${s}` : s);
  // a value that differs the same way on every channel (a CSS animation moving y and opacity together) is said once
  const collapse = (key) => { const vs = r.channels.map((c) => c.values[key]).filter(Boolean).filter((v) => v.verdict !== 'same'); return vs.length && vs.every((v) => v.a === vs[0].a && v.b === vs[0].b && v.maxDiff === vs[0].maxDiff && v.where === vs[0].where) && vs.length === r.channels.filter((c) => c.values[key]).length; };
  const timeOff = r.channels.some((c) => timeKeys.some((k) => c.values[k] && c.values[k].verdict !== 'same') || (c.values.law));
  const curveOff = r.channels.some((c) => c.values.curve && c.values.curve.verdict !== 'same');
  const valOff = r.channels.some((c) => ['from', 'to'].some((k) => c.values[k] && c.values[k].verdict !== 'same'));
  for (const c of r.channels) if (c.values.law) add(phrase('law', c.values.law, c.channel));
  for (const c of r.channels) if (c.values.axis) add(phrase('axis', c.values.axis, c.channel));
  if (!timeOff) {
    // the numbers both share, so a "same" line still says what was matched
    const c0 = r.channels.find((c) => c.values.start || c.values.duration || c.values.scrollStart);
    const v = c0 ? c0.values : {};
    const nums = [v.start ? `starts ${signedMs(v.start.a)}` : null, v.duration ? `${v.duration.word === 'settles in' ? 'settles in ' : v.duration.word === 'follows with a lag of' ? 'lag ' : ''}${ms(v.duration.a)}` : null,
      v.scrollStart && v.scrollEnd ? `scroll ${Math.round(v.scrollStart.a)}-${Math.round(v.scrollEnd.a)} px` : null].filter(Boolean);
    add(`same timing${nums.length ? ` (${nums.join(', ')})` : ''}`);
  }
  else for (const k of timeKeys) {
    if (collapse(k)) { const c = r.channels.find((x) => x.values[k] && x.values[k].verdict !== 'same'); add(at(c.values[k], phrase(k, c.values[k], c.channel))); continue; }
    for (const c of r.channels) if (c.values[k] && c.values[k].verdict !== 'same') add(at(c.values[k], tag(c, phrase(k, c.values[k], c.channel))));
  }
  if (!curveOff) { if (r.channels.some((c) => c.values.curve)) add('same curve'); }
  else if (collapse('curve')) { const c = r.channels.find((x) => x.values.curve && x.values.curve.verdict !== 'same'); add(at(c.values.curve, phrase('curve', c.values.curve, c.channel))); }
  else for (const c of r.channels) if (c.values.curve && c.values.curve.verdict !== 'same') add(at(c.values.curve, tag(c, phrase('curve', c.values.curve, c.channel))));
  if (!valOff) { if (r.channels.some((c) => c.values.from || c.values.to)) add('same values'); }
  else for (const c of r.channels) for (const k of ['from', 'to']) if (c.values[k] && c.values[k].verdict !== 'same') add(at(c.values[k], phrase(k, c.values[k], c.channel)));
  for (const c of r.channels) if (c.segments.a !== c.segments.b && c.segment === 1) add(`${channelWord(c.channel)} moves ${c.segments.a} time(s) in A, ${c.segments.b} in B`);
  if (r.stagger && r.stagger.verdict !== 'same') add(r.stagger.a != null && r.stagger.b != null ? `${r.stagger.verdict === 'close' ? 'close: ' : ''}stagger step ${ms(r.stagger.a)} in A, ${ms(r.stagger.b)} in B` : r.stagger.a != null ? 'A staggers its members, B does not' : 'B staggers its members, A does not');
  else if (r.stagger) add('same stagger');
  if (r.onlyA.length) add(`only A moves ${r.onlyA.map(channelWord).join(', ')}`);
  if (r.onlyB.length) add(`only B moves ${r.onlyB.map(channelWord).join(', ')}`);
  if (!r.channels.length && !r.stagger && !r.onlyA.length && !r.onlyB.length) add('nothing both sides measured to compare');
  // labels: say when a side's values were only fitted (measured from frames), not read from the page
  const lab = (side) => { const ls = new Set(r.channels.map((c) => c.labels[side])); return ls.size === 1 ? [...ls][0] : 'mixed'; };
  const la = lab('a'), lb = lab('b');
  const labs = r.channels.length ? (la === lb ? (la === 'exact' ? '' : ` [both ${la}]`) : ` [A ${la}, B ${lb}]`) : '';
  const head = { same: 'the same', close: 'close', different: 'different', unknown: 'not compared' }[r.verdict];
  const pairedBy = p.by && p.by !== 'selector' ? ` (paired by ${p.by} with B's ${nameOf(p.b)})` : '';
  return `${name}: ${head}${pairedBy}: ${parts.join(', ')}${labs}`;
}

/** The headline. */
export function headlineOf(c) {
  const k = c.counts; const n = k.pairs + k.onlyA + k.onlyB;
  if (!n) return 'Nothing to compare: neither page moved during the action.';
  const rest = [k.close ? `${k.close} close` : null, k.different ? `${k.different} different` : null, k.unknown ? `${k.unknown} not compared` : null,
    k.onlyA ? `${k.onlyA} only in A` : null, k.onlyB ? `${k.onlyB} only in B` : null].filter(Boolean);
  const verb = k.different || k.onlyA || k.onlyB ? 'B does not move like A yet' : k.close || k.unknown ? 'B moves almost like A' : 'B moves like A';
  const total = k.pairs + k.onlyA;   // A's motions: what B should reproduce
  if (!rest.length) return `${verb}: all ${k.same} motion${k.same === 1 ? '' : 's'} the same`;
  return `${verb}: ${k.same} of ${total} motion${total === 1 ? '' : 's'} the same, ${rest.join(', ')}`;
}

/**
 * Compare two look results (look.json objects). opts.endsOf(look, rec) -> {from, to, label} | null reads a record's start
 * and end values from the recording when the record states none (the CLI / MCP pass src/mcp/analysis.js recordedEnds).
 * @returns {object} the reva.compare/0 structure: headline, counts, pairs (with per-channel values), onlyA, onlyB, lines
 */
export function comparePair(lookA, lookB, opts = {}) {
  const A = motionsOfLook(lookA, opts), B = motionsOfLook(lookB, opts);
  const { pairs, onlyA, onlyB } = pairMotions(A, B);
  const done = pairs.map((p) => ({ ...p, result: comparePairMotion(p.a, p.b) }));
  const counts = { pairs: done.length, same: 0, close: 0, different: 0, unknown: 0, onlyA: onlyA.length, onlyB: onlyB.length };
  for (const p of done) counts[p.result.verdict]++;
  const side = (m) => ({ rank: m.rank, desc: m.desc, selector: m.selector, count: m.count, channels: [...m.channels.keys()] });
  const out = {
    schema: COMPARE_SCHEMA,
    action: { do: (lookA.action && lookA.action.do) || null, el: (lookA.action && lookA.action.el) || null, on: (lookA.action && lookA.action.on) || null },
    a: { source: srcOf(lookA), dir: lookA.dir || null, motions: A.length },
    b: { source: srcOf(lookB), dir: lookB.dir || null, motions: B.length },
    tolerances: COMPARE_TOL,
    counts,
    verdict: counts.different || counts.onlyA || counts.onlyB ? 'different' : counts.close ? 'close' : counts.unknown && !counts.same ? 'unknown' : 'same',
    pairs: done.map((p) => ({ a: side(p.a), b: side(p.b), pairedBy: p.by, verdict: p.result.verdict, line: pairLine(p),
      channels: p.result.channels, onlyA: p.result.onlyA, onlyB: p.result.onlyB, stagger: p.result.stagger })),
    onlyA: onlyA.map(side), onlyB: onlyB.map(side),
  };
  out.headline = headlineOf(out);
  out.lines = [...out.pairs.map((p) => p.line),
    ...onlyA.map((m) => `${nameOf(m)}: only in A (B has no matching motion)`), ...onlyB.map((m) => `${nameOf(m)}: only in B (A has no matching motion)`)];
  return out;
}
const srcOf = (look) => (look.source ? look.source.shown || look.source.url || look.source.startUrl || null : null);

/** Text report: the headline, then one line per motion. */
export function formatCompare(c) {
  const L = [`REVA compare · ${c.action.do || 'load'}${c.action.el ? ` ${c.action.el}` : ''}${c.action.on ? ` (trigger ${c.action.on})` : ''}`,
    `A: ${c.a.source || '?'} (${c.a.motions} motion${c.a.motions === 1 ? '' : 's'})`, `B: ${c.b.source || '?'} (${c.b.motions} motion${c.b.motions === 1 ? '' : 's'})`, '', c.headline, ''];
  for (const l of c.lines) L.push(`  ${l}`);
  L.push('', 'same = nobody would see it (time within 1 frame at 120 Hz or 3 %, curve within 2 % of the travel, position 1 px, opacity / scale 0.01); close = within 4 frames or 10 %, curve 6 %; [fitted] = measured from the frames, not read from the page');
  // page text (descriptors, selectors) never reaches the terminal with escapes or bidi overrides
  return L.map((l) => String(l).replace(CONTROL_CHARS, '')).join('\n');
}
