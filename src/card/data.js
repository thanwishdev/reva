// REVA motion card — data layer: a look result (look.json) + the take's recorded rows -> the card's content-free data.
// Every curve is progress of the travel (0 = start value, 1 = end value), so the card shows the feel of a motion,
// never the page's geometry or content. Recorded points come from the take's own frames; fitted points are the
// fitted model evaluated with the same reference formulas the exporters use (src/export/curves.js, fit/eases.js).
import { glSeriesOf } from '../analysis/gl/channels.js';
import fs from 'node:fs';
import path from 'node:path';
import { loadTake } from '../record/take.js';
import { numOf } from '../analysis/fit/series.js';
import { NAMED, parseEasing } from '../analysis/fit/eases.js';
import { cubicBezier } from '../analysis/oracles.js';
import { springProgress, emaProgress, settleMs } from '../export/curves.js';
import { familyKind, exportRecord } from '../export/index.js';
import { asExportRecord, exportWord } from '../look/exportword.js';
import { shapeFn } from '../export/eases.js';
import { channelWord, followWord } from '../look/words.js';
import { axisOfChannel, axisWord } from '../look/fontaxes.js';

export const CARD_SCHEMA = 'reva.card/0';
const LIB_ORDER = ['css', 'gsap', 'motion', 'lenis', 'raf', 'react-spring'];
const LIB_NAME = { css: 'CSS', gsap: 'GSAP', motion: 'Motion', lenis: 'Lenis', raf: 'JS', 'react-spring': 'react-spring' };
const MAX_REC = 320;      // recorded points per curve (the chart and the recorded specimen)
const FIT_N = 240;        // fitted points per curve
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r1 = (x) => Math.round(x * 10) / 10;

/** Param value (or the withheld value) of a record. */
const pv = (rec, k) => { const p = rec && rec.model && rec.model.params && rec.model.params[k]; return p ? (p.value ?? p.withheld_value ?? null) : null; };

/**
 * Progress function of a record's fitted model, on its own axis (time in ms since t0, or scroll px), or null.
 * {axis:'time'|'scroll'|'step', fn, span, t0?, s0?, s1?, a?, b?, from?, to?, x0?}
 * `rows` (the take's frames) give a spring its start value when the fit kept it fixed (the value at rest before the
 * onset is not a fitted parameter), so the fitted initial velocity v0 is drawn as fitted.
 */
export function fittedProgress(rec, rows = null) {
  const fam = rec && rec.model && rec.model.family; const kind = familyKind(fam);
  const t0 = rec.derived && Number.isFinite(rec.derived.t0) ? rec.derived.t0 : pv(rec, 't0');
  if (kind === 'tween') {
    let ease = null, D = pv(rec, 'D'), start = t0;
    if (fam === 'bezier' || fam.startsWith('bezier ')) {
      const b = rec.model.bezier || ['x1', 'y1', 'x2', 'y2'].map((k) => pv(rec, k));
      if (b.every(Number.isFinite)) ease = cubicBezier(...b);
    } else if (fam.startsWith('named:')) { const n = NAMED[rec.model.ease || fam.slice(6)]; if (n) ease = n.fn; }
    else { ease = parseEasing(pv(rec, 'easing')); D = pv(rec, 'duration'); if (start == null) start = (pv(rec, 'start') ?? 0) + (pv(rec, 'delay') ?? 0); }
    if (!ease || !(D > 0) || !Number.isFinite(start)) return null;
    return { axis: 'time', t0: start, span: D, fn: (t) => (t <= 0 ? 0 : t >= D ? 1 : ease(t / D)) };
  }
  if (kind === 'spring') {
    const w = pv(rec, 'omega'), z = pv(rec, 'zeta'); if (!(w > 0) || !(z > 0) || !Number.isFinite(t0)) return null;
    const v0 = pv(rec, 'v0'), tg = pv(rec, 'target');
    let x0 = pv(rec, 'x0'); if (x0 == null) x0 = restBefore(rows, rec, t0);
    const travel = x0 != null && tg != null ? tg - x0 : null;
    const fn0 = springProgress(w, z, v0 && travel ? v0 / travel : 0);
    // a spring that retargets (target1 ...) ends elsewhere: its first target is not the end value of the recording
    const ends = travel && pv(rec, 'target1') == null ? { from: x0, to: tg } : {};
    return { axis: 'time', t0, span: Math.min(settleMs(fn0, 0.002, 20000), 20000), fn: (t) => (t <= 0 ? 0 : fn0(t)), x0, ...ends };
  }
  if (kind === 'smoothing') {
    let tau = pv(rec, 'tau_ms'); const lam = pv(rec, 'lambda');
    if (!(tau > 0) && lam > 0) tau = 1000 / lam;
    if (!(tau > 0)) return null;
    const fn0 = emaProgress(tau);
    return { axis: 'step', span: tau * 5, tau, fn: (t) => (t <= 0 ? 0 : fn0(t)) };
  }
  if (kind === 'scroll map') {
    const m = rec.model.map; const shape = (/\(([^)]+)\)/.exec(fam) || [])[1] || (m && m.shape) || 'linear'; const sh = shapeFn(shape);
    if (!m || !sh || ![m.a, m.b, m.s0_px, m.s1_px].every(Number.isFinite) || m.s1_px === m.s0_px || noTravel(m)) return null;
    const span = m.s1_px - m.s0_px;
    return { axis: 'scroll', s0: m.s0_px, s1: m.s1_px, a: m.a, b: m.b, span, fn: (s) => sh.fn(Math.min(1, Math.max(0, (s - m.s0_px) / span))) };
  }
  return null;
}

/**
 * A scroll map whose travel b is zero up to rounding (b ≈ 1e-17 next to a ≈ 1.7): the channel did not move along the
 * map. Dividing the recording by such a b gives progress of ~1e17, so the card treats it as "did not move".
 */
export const noTravel = (m) => !m || !Number.isFinite(m.b) || Math.abs(m.b) <= 1e-9 * Math.max(1, Math.abs(m.a || 0));
/** A record that is a scroll map with no travel. */
export const isStillMap = (rec) => familyKind(rec && rec.model && rec.model.family) === 'scroll map' && noTravel(rec.model.map);

/**
 * What a scroll map is driven by (the fitter's model.driver): the window scroll offset (no driver field), the running
 * sum of the wheel deltas the page received, or the last pointer coordinate on one axis. Each has its own x axis.
 */
export function driverOf(rec) {
  const d = rec && rec.model && rec.model.driver;
  if (!d || !d.kind || d.kind === 'scroll') return { kind: 'scroll', unit: 'px of scroll', word: 'the window scroll offset' };
  if (d.kind === 'wheel') return { kind: 'wheel', unit: 'px of wheel input', word: 'the running sum of the wheel deltas the page received' };
  if (d.kind === 'pointer') { const ax = d.axis === 'y' ? 'y' : 'x'; return { kind: 'pointer', axis: ax, unit: `px of pointer ${ax}`, word: `the pointer ${ax} coordinate the page received` }; }
  return { kind: String(d.kind), unit: `of ${d.kind}`, word: `its ${d.kind} driver` };
}

/**
 * The driver value of each take row (row -> number), the same way the fitter builds it from the input log
 * (src/analysis/fit/index.js wheelDriver / pointerDriverRow): an input logged at page frame k first shows on the rows
 * after k. Null when the rows or the input log cannot give it (no frame keys, no inputs of that kind).
 */
export function driverAt(rows, inputs, drv) {
  if (!rows) return null;
  if (drv.kind === 'scroll') return (r) => r.sy;
  if (!Array.isArray(inputs) || !rows.length || !rows.every((r) => Number.isFinite(r.k))) return null;
  const byK = [...rows].sort((a, b) => a.k - b.k); const val = new Map();
  if (drv.kind === 'wheel') {
    const evs = inputs.filter((e) => e && e.type === 'wheel' && Number.isInteger(e.k) && Number.isFinite(e.dy)).sort((a, b) => a.k - b.k);
    if (!evs.length) return null;
    let j = 0, acc = 0; for (const r of byK) { while (j < evs.length && evs[j].k < r.k) acc += evs[j++].dy; val.set(r, acc); }
  } else if (drv.kind === 'pointer') {
    const evs = inputs.filter((e) => e && e.type === 'pointer' && Number.isInteger(e.k) && Number.isFinite(e[drv.axis])).sort((a, b) => a.k - b.k);
    if (!evs.length) return null;
    let j = 0, cur = NaN; for (const r of byK) { while (j < evs.length && evs[j].k < r.k) cur = evs[j++][drv.axis]; val.set(r, cur); }
  } else return null;
  return (r) => val.get(r);
}

/** Raw samples [{T, sy, y}] of one element channel from the take rows, within [from, to] ms (or all). */
const glRows = new WeakMap();
function samplesOf(rows, el, ch, from = -Infinity, to = Infinity) {
  const out = [];
  // a WebGL channel (gl:<uniform>, gl:camera.<q>): the uniform / matrix rows as the fitter reads them
  if (/^gl:/.test(String(ch))) {
    if (!Array.isArray(rows)) return out;
    let m = glRows.get(rows); if (!m) glRows.set(rows, (m = glSeriesOf(rows)));
    const s = m.get(`gl|${ch}`); if (!s) return out;
    s.idx.forEach((i, j) => { const r = rows[i]; if (r.T >= from && r.T <= to) out.push({ T: r.T, sy: r.sy, y: s.y[j], row: r }); });
    return out;
  }
  for (const r of rows) {
    if (!(r.T >= from && r.T <= to)) continue;
    const v = r.v && r.v[el]; if (!v || !(ch in v)) continue;
    const y = numOf(v[ch]); if (y != null) out.push({ T: r.T, sy: r.sy, y, row: r });
  }
  return out;
}
/** The recorded value of a record's channel at rest just before t0 (the last frame at or before it), or null. */
function restBefore(rows, rec, t0) {
  if (!rows || !Number.isFinite(t0)) return null;
  const pts = samplesOf(rows, String(rec.target.el), rec.target.channel, t0 - 1000, t0 + 1000); if (!pts.length) return null;
  let a = null; for (const p of pts) if (p.T <= t0 + 1e-6) a = p; else break;
  return (a || pts[0]).y;
}
/** Share of a map's span at each end where a recorded frame still counts as an end, not as inside the ramp. */
export const RAMP_EDGE = 0.01;
const thin = (pts, n) => (pts.length <= n ? pts : Array.from({ length: n }, (_, i) => pts[Math.round((i * (pts.length - 1)) / (n - 1))]));
const nearest = (pts, T) => { let best = null; for (const p of pts) if (!best || Math.abs(p.T - T) < Math.abs(best.T - T)) best = p; return best; };

/**
 * One curve: recorded and fitted progress on the same axis, plus the property the specimen animates.
 * Returns {axis, span, lead, rec:[[x,p]], fit:[[x,p]], gap, prop, note} (x in ms since t0, or scroll px since s0).
 */
export function curveOf(rec, rows, inputs = null) {
  if (isStillMap(rec)) return null;
  const fp = fittedProgress(rec, rows);
  const ch = rec.target.channel; const el = String(rec.target.el);
  const range = rec.evidence && rec.evidence.location && rec.evidence.location.kind === 'time_range' ? rec.evidence.location.range : null;
  const prop = propOf(ch);
  if (fp && fp.axis === 'step') {
    // a follower's recorded path follows a moving target (pointer, scroll): it is not one step, so no overlay
    const fit = Array.from({ length: FIT_N + 1 }, (_, i) => { const t = (fp.span * i) / FIT_N; return [r1(t), r4(fp.fn(t))]; });
    return { axis: 'step', span: r1(fp.span), lead: 0, rec: [], fit, gap: null, prop: { ...prop, from: null, to: null }, tau: r1(fp.tau), follows: followWord(rec),
      note: 'Response to one jump of the target. The recording follows a moving target (pointer or scroll), so it is not drawn against this curve.' };
  }
  if (fp && fp.axis === 'scroll') {
    // the x axis is the map's own driver: window scroll, wheel-delta sum or pointer coordinate (model.driver)
    const drv = driverOf(rec); const xOf = driverAt(rows, inputs, drv);
    const lead = fp.span * 0.12; const lo = fp.s0 - lead, hi = fp.s1 + lead;
    // x is rounded relative to the ramp (a 3.7 px ramp at 0.1 px would be 3 % off): 4 significant digits of the span
    const rx = (x) => { const k = 10 ** Math.max(1, 3 - Math.floor(Math.log10(Math.max(1e-9, Math.abs(fp.span))))); return Math.round(x * k) / k; };
    const pts = xOf ? samplesOf(rows, el, ch).map((p) => ({ ...p, x: xOf(p.row) })).filter((p) => Number.isFinite(p.x) && p.x >= lo && p.x <= hi) : [];
    const toPt = (p) => [rx(p.x - fp.s0), r4((p.y - fp.a) / fp.b)];
    const recPts = thin(pts.sort((a, b) => a.x - b.x), MAX_REC).map(toPt);
    // only frames inside the ramp test its start, end and shape: frames before s0 or after s1 sit on the flat ends,
    // which any ramp between the same two values matches (a driver that jumps across the ramp proves nothing). A frame
    // within RAMP_EDGE of an end is an end too (a wheel sum of 0 against a fitted s0 of -0.04 px tests nothing).
    const edge = Math.abs(fp.span) * RAMP_EDGE;
    const inside = pts.filter((p) => p.x > Math.min(fp.s0, fp.s1) + edge && p.x < Math.max(fp.s0, fp.s1) - edge);
    const fit = Array.from({ length: FIT_N + 1 }, (_, i) => { const s = lo + ((hi - lo) * i) / FIT_N; return [rx(s - fp.s0), r4(fp.fn(s))]; });
    const via = drv.kind !== 'scroll' ? ' (read from the input log), not by the window scroll; the x axis is that value' : '';
    const note = !xOf ? `Driven by ${drv.word}, not by the window scroll. The recording does not hold that value here, so only the fitted curve is drawn.`
      : !recPts.length ? `Driven by ${drv.word}${via}. No recorded frame falls inside this range (the driver jumps across it between frames), so only the fitted curve is drawn.`
      : !inside.length ? `Driven by ${drv.word}${via}. No recorded frame falls inside this range (the driver jumps across it between frames): the recording holds only the two flat ends, so the ramp's start, end and shape are not measured and there is no gap to report.`
      : via ? `Driven by ${drv.word}${via}.` : undefined;
    return { axis: 'scroll', unit: drv.unit, driver: drv.kind, span: rx(fp.span), lead: rx(lead), rec: recPts, fit,
      gap: gapOf(thin(inside, MAX_REC).map(toPt), (x) => fp.fn(x + fp.s0)), checked: inside.length > 0, inRamp: inside.length,
      prop: { ...prop, from: r4(fp.a), to: r4(fp.a + fp.b) }, ...(note ? { note } : {}) };
  }
  if (fp && fp.axis === 'time') {
    const lead = Math.max(fp.span * 0.1, 40); const tail = fp.span * 0.15;
    const lo = fp.t0 - lead, hi = fp.t0 + fp.span + tail;
    let pts = rows ? samplesOf(rows, el, ch, range ? Math.max(lo, range[0] - 1) : lo, range ? Math.min(hi, range[1] + 1) : hi) : [];
    // start and end values: the affine fit of the recording to the fitted shape (offset + travel, as the fitter
    // does), so a recording cut before the motion ends is still on the right scale; plain first / last otherwise
    // a spring with its own start and target values is drawn on those (the law as fitted, initial velocity included)
    const own = Number.isFinite(fp.from) && Number.isFinite(fp.to) && Math.abs(fp.to - fp.from) > 1e-9;
    const { from, to, scaled } = own ? { from: fp.from, to: fp.to, scaled: false } : travelOf(pts, (p) => fp.fn(p.T - fp.t0));
    let recPts = [];
    if (from != null && to != null && Math.abs(to - from) > 1e-9) recPts = thin(pts, MAX_REC).map((p) => [r1(p.T - fp.t0), r4((p.y - from) / (to - from))]);
    const fit = Array.from({ length: FIT_N + 1 }, (_, i) => { const t = -lead + ((fp.span + lead + tail) * i) / FIT_N; return [r1(t), r4(fp.fn(t))]; });
    return { axis: 'time', span: r1(fp.span), lead: r1(lead), rec: recPts, fit, gap: gapOf(recPts, fp.fn), scaled, x0: Number.isFinite(fp.x0) ? fp.x0 : null,
      prop: { ...prop, from: from != null ? r4(from) : null, to: to != null ? r4(to) : null } };
  }
  // no fitted law the card can evaluate: the recording alone, normalised to its own range
  if (!rows || !range) return null;
  const pts = samplesOf(rows, el, ch, range[0], range[1]); if (pts.length < 3) return null;
  const from = pts[0].y, to = pts[pts.length - 1].y;
  let lo = Math.min(...pts.map((p) => p.y)), hi = Math.max(...pts.map((p) => p.y));
  const [y0, y1] = Math.abs(to - from) > 1e-9 ? [from, to] : [lo, hi]; if (!(Math.abs(y1 - y0) > 1e-9)) return null;
  const T0 = pts[0].T;
  return { axis: 'time', span: r1(pts[pts.length - 1].T - T0), lead: 0, rec: thin(pts, MAX_REC).map((p) => [r1(p.T - T0), r4((p.y - y0) / (y1 - y0))]), fit: [], gap: null,
    prop: { ...prop, from: r4(y0), to: r4(y1) }, note: 'No fitted law to draw for this motion; the recording alone.' };
}

/**
 * Start and end values of a recording against a fitted shape f (progress per sample): least squares y ≈ from + (to − from)·f.
 * Falls back to the first and last samples when the shape barely changes over the samples.
 */
export function travelOf(pts, f) {
  if (pts.length < 2) return { from: null, to: null, scaled: false };
  const n = pts.length; let sf = 0, sy = 0; for (const p of pts) { sf += f(p); sy += p.y; }
  const mf = sf / n, my = sy / n; let sff = 0, sfy = 0; for (const p of pts) { const d = f(p) - mf; sff += d * d; sfy += d * (p.y - my); }
  if (sff / n < 1e-3) return { from: pts[0].y, to: pts[n - 1].y, scaled: false };
  const k = sfy / sff; const from = my - k * mf;
  return { from, to: from + k, scaled: true };
}

/** Largest |recorded − fitted| in progress units, with where it happens. */
function gapOf(recPts, fn) {
  if (!recPts.length) return null;
  let max = 0, at = 0; for (const [x, p] of recPts) { const e = Math.abs(p - fn(x)); if (e > max) { max = e; at = x; } }
  // a gap above 1000 % of the travel (or not finite) is a broken scale, not a measurement: omitted
  if (!Number.isFinite(max) || max > 10) return null;
  return { maxPct: Math.round(max * 1000) / 10, at: r1(at) };
}

/** What the neutral box does in the specimen: move (x), fade, scale or turn; distance is always normalised. */
export function propOf(ch) {
  const n = String(ch || '').split(':')[1] || '';
  if (n === 'opacity') return { kind: 'opacity', word: 'opacity' };
  if (axisOfChannel(ch)) return { kind: 'x', word: axisWord(axisOfChannel(ch)) };
  if (/^(sx|sy|s|scale)$/.test(n)) return { kind: 'scale', word: n === 'sx' ? 'scale x' : n === 'sy' ? 'scale y' : 'scale' };
  if (/^(rz|rotate)$/.test(n)) return { kind: 'rotate', word: 'rotation' };
  if (/^(tx|bx|ty|by|tz|translate)$/.test(n)) return /y$/.test(n) ? { kind: 'x', word: 'y position', dir: 'y' } : { kind: 'x', word: /x$/.test(n) ? 'x position' : 'position' };
  return { kind: 'x', word: n.replace(/^--/, '') || 'value' };
}

const parses = (code) => { try { new Function(code); return true; } catch { return false; } };

/**
 * A record with the values the recording measured and the fit left out, so the snippet is complete: a spring's start
 * value (at rest before the onset), a tween's start and end values (the same least-squares ends the chart uses).
 */
function withRecorded(rec, curve) {
  if (!curve || !curve.prop) return rec;
  const ps = { ...(rec.model.params || {}) };
  const put = (k, v) => { const p = ps[k]; if (!(p && (p.value ?? p.withheld_value) != null) && Number.isFinite(v)) ps[k] = { value: v, provenance: 'recorded' }; };
  const kind = familyKind(rec.model.family);
  if (kind === 'spring') { put('x0', curve.x0); put('target', curve.prop.to); }
  else if (kind === 'tween' && !ps.keyframeValues) { put('from', curve.prop.from); put('to', curve.prop.to); }
  return { ...rec, model: { ...rec.model, params: ps } };
}

/**
 * Code of ONE law: each channel's own record (the one the law was drawn from: same family, nearest onset) exported
 * with its recorded ends. Libraries with code become tabs; the rest are listed with why. A law whose family has no
 * exporter (unexplained, unknown) has no code; a snippet that does not parse is never offered.
 */
function lawCode(line, chans, meta, rate) {
  const per = new Map(); const na = new Map(); const notes = new Set();
  for (const { rec, curve } of chans) {
    if (!rec || !rec.model || rec.model.family !== line.family) continue;
    const it = exportRecord(withRecorded(asExportRecord(rec), curve), { meta });
    if (it.skipped) continue;
    for (const n of it.notes || []) notes.add(n);
    // a map with no recorded frame inside its ramp: the snippet reproduces a ramp the recording never tested
    const unmeasured = curve && curve.axis === 'scroll' && curve.checked === false;
    for (const x of it.exports) {
      const m = x.code && unmeasured ? { word: 'unknown model', why: 'no recorded frame falls inside the ramp, so its start, end and shape are not measured' } : exportWord(rec, it, x, rate);
      if (x.code && x.lib !== 'css' && !parses(x.code)) { if (!na.has(x.lib)) na.set(x.lib, 'the generated snippet failed a syntax check'); continue; }
      if (!x.code) { if (!na.has(x.lib)) na.set(x.lib, m.why || (x.accuracy && (x.accuracy.why || x.accuracy.label)) || 'not representable'); continue; }
      const list = per.get(x.lib) || []; per.set(x.lib, list);
      if (list.some((e) => e.channel === it.channel && e.form === (x.form || null))) continue;
      list.push({ channel: it.channel, chWord: propOf(it.channel).word, form: x.form || null, word: m.word, why: m.why || null, note: x.note || null, code: x.code });
    }
  }
  const tabs = LIB_ORDER.filter((l) => per.has(l)).map((l) => ({ lib: l, name: LIB_NAME[l], entries: per.get(l) }));
  const missing = LIB_ORDER.filter((l) => !per.has(l) && na.has(l)).map((l) => ({ lib: l, name: LIB_NAME[l], why: na.get(l) }));
  return { tabs, missing, notes: [...notes] };
}

const stripLabels = (s) => String(s || '').replace(/\s*\[(exact|fitted|unknown|declared)[^\]]*\]/g, '').replace(/\s+,/g, ',').trim();
/** Drop parenthetical groups that start with a word (balanced parens: reasons can hold "I1(2)"). */
function dropParens(s, words = /^\((unknown|withheld|library value)/) {
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '(' && words.test(s.slice(i))) { let d = 0, j = i; for (; j < s.length; j++) { if (s[j] === '(') d++; else if (s[j] === ')' && --d === 0) break; } i = j + 1; while (out.endsWith(' ')) out = out.slice(0, -1); continue; }
    out += s[i++];
  }
  return out;
}
/** The headline of a law: its first clause, without labels or unknown reasons (the values below carry those). */
export const headlineOf = (text) => tidyNumbers(dropParens(stripLabels(text)).split(/;\s*/)[0].trim());
/**
 * Numbers as people read them in a headline: 1.06e-6 -> 0, 23.671894 -> 23.7. Only e-notation and 5+ decimals are
 * touched, never inside an easing function (cubic-bezier / linear / steps keep their exact values); the values list
 * below the headline keeps the full precision.
 */
export const tidyNumbers = (s) => s.split(/((?:cubic-bezier|linear|steps)\([^)]*\))/).map((part, k) => (k % 2 ? part : part.replace(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi, (m) => {
  if (!/e|\.\d{5,}/i.test(m)) return m; const x = Number(m); if (!Number.isFinite(x)) return m;
  const r = Math.abs(x) < 5e-4 ? 0 : Number(x.toFixed(Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2));
  return String(Object.is(r, -0) ? 0 : r);
}))).join('');

/** The record a look line was built from (same family, a channel of the line, nearest onset). */
function recordOfLine(line, recs, channel = null) {
  const chs = channel ? [channel] : line.channels;
  const c = recs.filter((r) => chs.includes(r.target.channel) && (r.model && r.model.family) === line.family);
  const pool = c.length ? c : recs.filter((r) => chs.includes(r.target.channel));
  return pool.sort((a, b) => Math.abs(((a.derived && a.derived.t0) ?? 1e12) - (line.t0 ?? 0)) - Math.abs(((b.derived && b.derived.t0) ?? 1e12) - (line.t0 ?? 0)))[0] || null;
}
// the chart draws one channel: a position before a scale, a turn, a fade or anything else
const PRIORITY = { x: 0, scale: 1, rotate: 2, opacity: 3 };
const rank = (ch) => { const k = propOf(ch); return (PRIORITY[k.kind] ?? 4) + (k.kind === 'x' && !/^(tx|bx|ty|by|tz|translate)$/.test(String(ch).split(':')[1] || '') ? 4 : 0); };

/**
 * A scroll map's sentence and value names on its own driver. Looks saved before the driver wording say "Scroll-linked
 * ... while the page scrolls" for a wheel or pointer map, and every look names the driver's ends scrollStart /
 * scrollEnd; the card rewrites both from model.driver so a pointer map never reads as scroll.
 */
const DRIVER_TEXT = { wheel: ['Wheel-linked (scrubbed)', 'while the wheel input sums'], pointer: (ax) => ['Pointer-linked', `while the pointer ${ax} moves`] };
export function onDriver(text, drv) {
  if (drv.kind !== 'wheel' && drv.kind !== 'pointer') return text;
  const [head, during] = drv.kind === 'wheel' ? DRIVER_TEXT.wheel : DRIVER_TEXT.pointer(drv.axis);
  return String(text || '').replace(/^Scroll-linked \(scrubbed\)/, head).replace('while the page scrolls', during);
}
export function valueName(name, drv) {
  const end = name === 'scrollStart' ? 'start' : name === 'scrollEnd' ? 'end' : null;
  if (!end) return name;
  return drv.kind === 'wheel' ? `wheel sum ${end}` : drv.kind === 'pointer' ? `pointer ${drv.axis} ${end}` : `scroll ${end}`;
}
/** Split on commas outside parentheses ("cubic-bezier(0.2, 0, 0, 1)" stays whole). */
function topCommas(s) {
  const out = []; let d = 0, cur = '';
  for (const c of s) { if (c === '(') d++; else if (c === ')') d--; if (c === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += c; }
  out.push(cur.trim()); return out.filter(Boolean);
}
export const HERO_MAX = 60;
/**
 * The hero line: one idea in display type. The law's first plain clause, plus the next one when it is a value that
 * fits (a smoothing's time constant, a tween's easing); equivalents (= lerp ...), rates and the rest stay in the law
 * below and behind "How sure". A scroll map reads "<Driver>-linked: <channel> from → to, shape".
 */
export function heroOf(headline, mapParts = null) {
  if (mapParts) return tidyNumbers(`${mapParts.head}: ${mapParts.what} ${mapParts.from} → ${mapParts.to}${mapParts.shape ? `, ${mapParts.shape}` : ''}`);
  const [first = '', second0 = ''] = topCommas(String(headline || ''));
  const second = second0.replace(/^time constant\s+/, '');
  if (!second || /^=/.test(second)) return first;
  const two = `${first}, ${second}`;
  return two.length <= HERO_MAX ? two : first;
}

function laws(lines, recs, rows, meta, rate, inputs = null) {
  const out = lines.map((l) => {
    const order = [...l.channels].sort((a, b) => rank(a) - rank(b));
    const chans = order.map((ch) => { const rec = recordOfLine(l, recs, ch); return { ch, rec, curve: rec ? curveOf(rec, rows, inputs) : null }; });
    const main = chans.find((c) => c.curve) || null;
    let curve = main ? main.curve : null;
    if (!curve) { const rec = recordOfLine(l, recs); curve = rec ? curveOf(rec, rows, inputs) : null; }
    const rec = main ? main.rec : recordOfLine(l, recs);
    // a scroll map with zero travel on every channel: the element did not move along it (no chart, gap or specimen)
    const still = !curve && chans.length > 0 && chans.every((c) => c.rec && isStillMap(c.rec));
    // the specimen plays every channel of the law on the same progress (a rise and a fade together), one per kind
    if (curve) {
      const props = [curve.prop]; const seen = new Set([curve.prop.kind]);
      for (const c of chans) { const k = propOf(c.ch).kind; if (seen.has(k) || !c.curve || !c.curve.prop) continue; props.push(c.curve.prop); seen.add(k); }
      curve.props = props;
    }
    const fit = rec && rec.fit ? { n: rec.fit.n ?? null, nrmse: rec.fit.nrmse ?? null, holdout: rec.fit.holdout ?? null } : null;
    const ci = rec && rec.model && rec.model.params ? Object.entries(rec.model.params).filter(([, p]) => p && Array.isArray(p.ci95)).map(([k, p]) => ({ name: k, lo: p.ci95[0], hi: p.ci95[1], unit: p.unit || null })) : [];
    const code = lawCode(l, chans, meta, rate);
    const isMap = !!(rec && familyKind(rec.model && rec.model.family) === 'scroll map');
    const drv = isMap ? driverOf(rec) : { kind: 'scroll' };
    const text = isMap ? onDriver(l.text, drv) : l.text;
    const vs = (l.values || []).map((v) => ({ name: isMap ? valueName(v.name, drv) : v.name, value: v.value, unit: v.unit || null, label: v.label, reason: v.reason || null, text: stripLabels(v.text) }));
    let mapParts = null;
    if (isMap) {
      const by = new Map(vs.map((v) => [v.name, v])); const m = rec.model.map || {};
      const from = by.get('from'), to = by.get('to');
      if (from && to && from.value != null && to.value != null) {
        mapParts = { head: (/^[^:(]+/.exec(text) || ['Scroll-linked'])[0].trim(), what: channelWord(rec.target.channel), from: from.text, to: to.text,
          shape: m.shape || (/\(([^)]+)\)/.exec(rec.model.family) || [])[1] || null };
      }
    }
    const headline = headlineOf(text);
    return {
      headline, hero: heroOf(headline, mapParts), sentence: stripLabels(text), label: l.label, kind: l.kind, family: l.family || null, t0: l.t0 ?? null, trigger: l.trigger || null, times: l.times || 1, runs: 1,
      channels: l.channels, channelWords: [...new Set(order.map((ch) => propOf(ch).word))], values: vs,
      curve, still, fit, ci, notes: code.notes, tabs: code.tabs, missing: code.missing,
    };
  });
  return mergeRepeats(out);
}

export const SAME_LAW_TOL = 0.03;   // relative: two fits of one law on one element differ by noise, not by 3 %
/**
 * The same law fitted again on the same element (a repeat: clicked twice, hovered in and out) is one law with
 * "runs N times": same family, label and channels, and every value within SAME_LAW_TOL (texts equal).
 */
export function sameLaw(a, b) {
  if (a.family !== b.family || a.kind !== b.kind || a.label !== b.label || [...a.channels].sort().join() !== [...b.channels].sort().join()) return false;
  if (a.values.length !== b.values.length || !a.values.length) return false;
  const by = new Map(a.values.map((v) => [v.name, v]));
  return b.values.every((v) => {
    const u = by.get(v.name); if (!u) return false;
    if (!Number.isFinite(u.value) || !Number.isFinite(v.value)) return u.value === v.value && u.text === v.text;
    return Math.abs(u.value - v.value) <= Math.max(SAME_LAW_TOL * Math.max(Math.abs(u.value), Math.abs(v.value)), 1e-9);
  });
}
function mergeRepeats(ls) {
  const kept = [];
  for (const l of ls) {
    const first = kept.find((k) => sameLaw(k, l));
    if (first) { first.times += l.times; first.runs += 1; } else kept.push(l);
  }
  return kept;
}

/** Rows of the take a look result points at, or null (moved or deleted). */
export function rowsOf(look) { return seriesOf(look, 'rows'); }
/** The take's input log (wheel, pointer, scrollTo entries with their page frame k), or null. */
export function inputsOf(look) { return seriesOf(look, 'inputLog'); }
function seriesOf(look, name) {
  const dir = look && look.take && look.take.dir;
  if (!dir || !fs.existsSync(path.join(dir, 'take.json'))) return null;
  try { return loadTake(dir, [name]).data[name] || null; } catch { return null; }
}

/** look.json -> card data. `rows` and `inputs` default to the take's own frames and input log (rowsOf, inputsOf). */
export function buildCardData(look, { rows, inputs } = {}) {
  if (rows === undefined) rows = rowsOf(look);
  if (inputs === undefined) inputs = inputsOf(look);
  const src0 = look.source || {}; const rate = look.take && look.take.rate;
  // the same source comment look writes into its snippets (url, take, date)
  const meta = { url: src0.kind === 'archive' ? src0.startUrl : src0.url, date: (look.take && look.take.dir && (/(\d{4}-\d\d-\d\d)T/.exec(look.take.dir) || [])[1]) || undefined, takeName: look.action && look.action.do ? `look-${look.action.do}` : undefined };
  const motions = (look.motions || []).map((m) => {
    const ls = laws(m.lines || [], m.records || [], rows, meta, rate, inputs);
    let stagger = null;
    if (m.stagger) {
      const iv = m.stagger.group && m.stagger.group.interval ? m.stagger.group.interval.value : null;
      stagger = { text: stripLabels(m.stagger.text), intervalMs: Number.isFinite(iv) ? r1(iv) : null, count: m.count,
        tabs: (m.stagger.exports || []).filter((x) => x.code).map((x) => ({ lib: x.lib, name: LIB_NAME[x.lib] || x.lib, entries: [{ channel: 'stagger', form: null, word: x.accuracy.label === 'exact' ? 'matches fit' : x.accuracy.label, why: null, note: null, code: x.code }] })) };
    }
    return {
      rank: m.rank, desc: m.desc, lead: m.lead ?? null, count: m.count || 1, selector: m.selector || null, selectorWhy: m.selectorWhy || null, leadSelector: m.leadSelector || null,
      share: m.weightShare ?? null, laws: ls, stagger,
      unknowns: (m.unknowns || []).map((u) => ({ channel: u.channel, kind: u.kind, reason: u.reason })),
      notFitted: (look.notFitted || []).filter((n) => n.el === m.lead).map((n) => ({ channel: n.channel, reason: n.reason })),
    };
  });
  const page = look.page ? { desc: 'Page scroll', laws: laws(look.page.lines || [], look.page.records || [], rows, meta, rate, inputs), unknowns: (look.page.unknowns || []).map((u) => ({ channel: u.channel, reason: u.reason })) } : null;
  const src = look.source || {};
  return {
    schema: CARD_SCHEMA,
    source: { kind: src.kind || null, url: src.kind === 'archive' ? src.startUrl : src.url, offline: src.kind === 'archive' || src.live === false },
    action: { do: look.action && look.action.do, el: look.action && look.action.el, on: look.action && look.action.on },
    take: { rate: look.take && look.take.rate, frames: look.take && look.take.frames, misses: src.kind === 'archive' && look.take && look.take.net ? look.take.net.misses : null, started: (look.take && look.take.dir && (/(\d{4}-\d\d-\d\d)T/.exec(look.take.dir) || [])[1]) || null },
    status: look.status, warnings: look.warnings || [], errors: look.errors || [],
    recorded: !!rows, page, motions,
    // WebGL light: the fitted uniform / camera lines as laws (same curves as an element's), programs without their sources
    gl: look.gl && (look.gl.lines || []).length ? {
      laws: laws((look.gl.lines || []).filter((l) => (l.channels || []).length && !/^(shader|camera|clock|unknown)$/.test(l.kind)), look.gl.records || [], rows, meta, rate, inputs),
      notes: (look.gl.lines || []).filter((l) => /^(shader|camera|clock|unknown)$/.test(l.kind)).map((l) => ({ text: l.text, label: l.label, kind: l.kind })),
      programs: (look.gl.programs || []).map((p) => ({ id: p.id, hash: p.hash, used: p.used, summary: p.summary })),
    } : null,
    others: (look.others || []).length,
    // the design summary is content-free by construction (src/design/summary.js): passed through as is
    design: look.design || null,
    declaredOnly: Array.isArray(look.declaredOnly) ? look.declaredOnly.slice(0, 20).map((x) => ({ kind: x.kind, desc: x.desc, selector: x.selector || null, durationMs: x.durationMs, delayMs: x.delayMs, easing: x.easing, properties: x.properties })) : [],
  };
}
