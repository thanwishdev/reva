// Read side of an analysis (a `look` result folder: look.json + fit.json, plus the take it recorded) for the public MCP tools.
// Ids: an analysis is its folder name under <out root>/look; inside it a motion is `m<rank>` (one element or a folded group, as
// ranked by look), `page` (the page's own scroll line), and one fitted channel of it is `m<rank>/<channel>` (e.g. m1/ren:ty).
// Everything here is read-only and deterministic: the numbers come from the fitter and the export module, never from a model.
import { glSeriesOf } from '../analysis/gl/channels.js';
import fs from 'node:fs';
import path from 'node:path';
import { outRoot } from '../util/paths.js';
import { readable, AccessError } from './access.js';
import { labelOf, springPreset, canonicalFamily, EASE_ALIAS, channelWord } from '../look/words.js';
import { springProgress, emaProgress, settleMs } from '../export/curves.js';
import { NAMED, cubicBezier } from '../export/eases.js';
import { parseEasing, canonicalEasing } from '../analysis/fit/eases.js';
import { declaredEasing } from '../export/index.js';
import { untrusted } from '../report/untrusted.js';
import { loadTake } from '../record/take.js';
import { numOf, valueForm } from '../analysis/fit/series.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;

/** Resolve an analysis id (folder name under <out root>/look) or a path to its folder / look.json, inside the data roots. */
export function analysisDir(id, env = process.env) {
  if (typeof id !== 'string' || !id) throw new AccessError('an analysis id is required');
  if (ID.test(id) && !id.includes('..')) {
    const d = path.join(outRoot(env), 'look', id);
    if (fs.existsSync(path.join(d, 'look.json'))) return d;
    throw Object.assign(new Error(`no analysis "${id}" (looked in ${path.join(outRoot(env), 'look')})`), { code: 'not_found', hint: 'run look first; its result carries the analysis id' });
  }
  const p = readable(id, env);
  const d = p.endsWith('look.json') ? path.dirname(p) : p;
  if (!fs.existsSync(path.join(d, 'look.json'))) throw Object.assign(new Error(`${d} holds no look.json`), { code: 'not_found' });
  return d;
}

export function loadAnalysis(id, env = process.env) {
  const dir = analysisDir(id, env);
  const look = JSON.parse(fs.readFileSync(path.join(dir, 'look.json'), 'utf8'));
  if (look.schema !== 'reva.look/0') throw Object.assign(new Error(`not a look result (schema ${String(look.schema).slice(0, 40)})`), { code: 'bad_source' });
  return { id: path.basename(dir), dir, look };
}

/** Every motion of an analysis as {mid, entry} (entry = look.motions[i] or look.page), in rank order, page line first. */
export function motionsOf(look) {
  const out = [];
  if (look.page) out.push({ mid: 'page', entry: { ...look.page, rank: 0, kind: 'page', count: 1 } });
  for (const m of look.motions || []) out.push({ mid: `m${m.rank}`, entry: m });
  // WebGL light: the fitted uniform / camera channels as one entry (its lines name GLSL identifiers: untrusted_content)
  const g = look.gl;
  if (g && (g.records || []).length) out.push({ mid: 'gl', entry: { rank: 'gl', kind: 'webgl', count: 1, desc: 'WebGL uniforms and camera', selector: null, webgl: true,
    lines: (g.lines || []).filter((l) => (l.channels || []).length && !/^(shader|camera)$/.test(l.kind)), records: g.records, exports: [], unknowns: [] } });
  return out;
}

/**
 * Channel ids of an entry's records, in record order: `ren:ty`, and `ren:ty#2`, `ren:ty#3` when one channel holds several
 * motions (segments). Also the index of each record among the records of its channel (the export items follow the same order).
 */
export function channelIds(records) {
  const seen = new Map();
  return (records || []).map((r) => { const ch = r.target.channel; const k = (seen.get(ch) || 0) + 1; seen.set(ch, k); return { key: k === 1 ? ch : `${ch}#${k}`, nth: k - 1 }; });
}

/** Resolve `m1`, `m1/ren:ty`, `m1/ren:ty#2`, `page`, `page/ren:by`, `m1/stagger` -> {mid, entry, channel|null, rec|null, nth, stagger}. */
export function resolveMotion(look, ref) {
  const [mid, ...rest] = String(ref).split('/'); const channel = rest.length ? realName(look, rest.join('/')) : null;
  const m = motionsOf(look).find((x) => x.mid === mid);
  if (!m) throw Object.assign(new Error(`no motion "${String(ref).slice(0, 60)}" (this analysis has ${motionsOf(look).map((x) => x.mid).join(', ') || 'none'})`), { code: 'not_found' });
  if (channel === 'stagger') { if (!m.entry.stagger) throw Object.assign(new Error(`${mid} has no stagger`), { code: 'not_found' }); return { ...m, channel: null, rec: null, stagger: true }; }
  if (!channel) return { ...m, channel: null, rec: null, stagger: false };
  const recs = m.entry.records || []; const ids = channelIds(recs); const i = ids.findIndex((x) => x.key === channel);
  if (i < 0) throw Object.assign(new Error(`${mid} has no fitted channel ${aliasText(look, channel).slice(0, 40)} (has ${ids.map((x) => aliasText(look, x.key)).join(', ') || 'none'})`), { code: 'not_found' });
  return { ...m, channel: recs[i].target.channel, key: channel, rec: recs[i], nth: ids[i].nth, stagger: false };
}

// ---------- values ----------

const sig = (x, n = 5) => (typeof x === 'number' && Number.isFinite(x) ? +(Math.abs(x) < 1e-9 ? 0 : x.toPrecision(n)) : x ?? null);
const SKIP_PARAMS = new Set(['keyframeValues']);

/** Canonical parameters with their user label (exact / fitted / unknown) and, for unknowns, the reason. */
export function paramsOf(rec) {
  const out = {};
  for (const [k, p] of Object.entries((rec.model && rec.model.params) || {})) {
    if (SKIP_PARAMS.has(k) || !p || typeof p !== 'object') continue;
    const label = p.value == null ? 'unknown' : labelOf(p.provenance);
    // a string value was read in the page (easing, fill, range): a canonical easing or a bare keyword is ours to print,
    // anything else travels as untrusted_content
    const str = (x) => { const c = canonicalEasing(x); return c || (/^[a-z][a-z-]{0,30}$/.test(x) ? x : untrusted(x, `param ${k}`, 80)); };
    const v = typeof p.value === 'number' ? sig(p.value) : typeof p.value === 'string' ? str(p.value) : Array.isArray(p.value) ? p.value.map((x) => (typeof x === 'number' ? sig(x) : typeof x === 'string' ? str(x) : x)) : p.value ?? null;
    out[k] = { value: v, ...(p.unit ? { unit: p.unit } : {}), label, ...(label === 'unknown' ? { reason: String(p.reason || 'not identified').slice(0, 160) } : {}) };
  }
  // a declared record's easing is the curve it runs (keyframe easings included), not the effect easing alone
  if (/^declared:(css|waapi)$/.test(String(rec.model && rec.model.family)) && out.easing) {
    const de = declaredEasing(rec);
    out.easing = de.easing ? { value: de.easing, label: labelOf('declared'), ...(de.source === 'keyframes' ? { source: 'keyframes (the effect easing is linear)' } : {}) }
      : { value: null, label: 'unknown', reason: String(de.why || 'not one curve').slice(0, 160), ...(de.segments ? { segments: de.segments } : {}) };
  }
  if (rec.model && Array.isArray(rec.model.bezier) && !out.x1) out.bezier = { value: rec.model.bezier.map((x) => sig(x, 4)), label: labelOf('fitted') };
  return out;
}

/** The record's user label: exact (declared), fitted, or unknown (unknown / unexplained / not applicable tiers). */
export const recordLabel = (rec) => (rec.tier === 'declared' ? 'exact' : rec.tier === 'fitted' ? 'fitted' : 'unknown');

/** A normalised progress function p(ms since t0) for the record's model, or {why} when the model is not a step response. */
export function progressOf(rec) {
  const fam = String((rec.model && rec.model.family) || ''); const P = (n) => { const p = rec.model.params && rec.model.params[n]; return p && typeof p.value === 'number' ? p.value : null; };
  if (fam === 'spring') {
    const w = P('omega') ?? (rec.derived && rec.derived.omega), z = P('zeta') ?? (rec.derived && rec.derived.zeta);
    if (!(w > 0) || !(z >= 0)) return { why: 'spring without ω / ζ' };
    return { kind: 'spring', p: springProgress(w, z, 0), omega: w, zeta: z };
  }
  if (/^named:/.test(fam) || /^bezier/.test(fam)) {
    const D = P('D'); if (!(D > 0)) return { why: 'tween without a duration' };
    const name = rec.model.ease || fam.slice(6);
    const bez = rec.model.bezier || ['x1', 'y1', 'x2', 'y2'].map(P);
    const e = /^named:/.test(fam) ? NAMED[name] && NAMED[name].fn : bez.every(Number.isFinite) ? cubicBezier(...bez) : null;
    if (!e) return { why: `ease ${String(name).slice(0, 30)} not known` };
    return { kind: 'tween', D, p: (t) => e(Math.min(1, Math.max(0, t / D))) };
  }
  if (/^declared:/.test(fam)) {
    const D = P('duration'); const de = declaredEasing(rec);
    if (!(D > 0)) return { why: 'declared transition without a duration' };
    if (!de.easing) return { why: `declared easing not one curve: ${de.why}` };
    const e = parseEasing(de.easing); if (!e) return { why: 'declared easing not parsed' };
    return { kind: 'tween', D, p: (t) => e(Math.min(1, Math.max(0, t / D))) };
  }
  if (/^(ema|dtdamp)\b/.test(fam)) {
    const tau = P('tau_ms') ?? (rec.derived && rec.derived.tau_ms); if (!(tau > 0)) return { why: 'smoothing without τ' };
    return { kind: 'smoothing', tau, p: emaProgress(tau), follows: (rec.model.driver && rec.model.driver.kind) || null };
  }
  return { why: `${canonicalFamily(fam)} is not a single step response` };
}

const firstAbove = (p, x, maxMs = 20000) => { for (let t = 0; t <= maxMs; t += 0.5) if (p(t) >= x) return t; return null; };

/**
 * Derived values every row carries (REVA-PRODUCT §3.5): t50, settle99 (|1 − p| stays ≤ 1 %), overshoot, peak velocity.
 * The fitter's own derived values are used when present; the rest is computed from the fitted curve. Label: fitted
 * (derived from fitted values) or exact (from a declared transition).
 */
export function derivedOf(rec) {
  const d = rec.derived || {}; const pr = progressOf(rec); const label = rec.tier === 'declared' ? 'exact' : rec.tier === 'fitted' ? 'fitted' : 'unknown';
  if (pr.why && !Number.isFinite(d.t50) && !Number.isFinite(d.settle99)) return { why: pr.why };
  const v = (x, unit) => (Number.isFinite(x) ? { value: sig(x, 4), unit, label } : null);
  // the fitter's overshoot is in the channel's own units (px, deg, ...); a computed one is a share of the travel
  let t50 = d.t50, settle = d.settle99 ?? d.t99, peak = d.peakVelocity;
  let overshoot = Number.isFinite(d.overshoot) ? { value: sig(d.overshoot, 4), unit: unitOf(rec.target.channel), label } : null;
  if (pr.p) {
    if (!Number.isFinite(t50)) t50 = firstAbove(pr.p, 0.5);
    if (!Number.isFinite(settle)) settle = settleMs(pr.p, 0.01, 20000);
    if (!overshoot) { let m = 0; for (let t = 0; t <= Math.min(20000, (settle || 2000) * 2); t += 1) m = Math.max(m, pr.p(t) - 1); overshoot = { value: sig(100 * m, 3), unit: '% of travel', label }; }
  }
  const out = { t50: v(t50, 'ms'), settle99: v(settle, 'ms'), overshoot };
  if (Number.isFinite(peak)) out.peak_velocity = { value: sig(peak, 4), unit: `${unitOf(rec.target.channel)}/s`, label };
  if (pr.kind === 'smoothing') out.note = `step response of the smoothing (it follows ${pr.follows === 'wheel' ? 'the scroll' : pr.follows || 'its target'}, so real motion has no single duration)`;
  return out;
}
const unitOf = (ch) => (/^ren:(tx|ty|tz|bx|by|bw|bh)$|clipPath|radius/.test(ch) ? 'px' : /^ren:(rz|skx)$/.test(ch) ? 'deg' : /opacity|^ren:s[xy]?$/.test(ch) ? 'units' : 'units');

/** Is this a library default (react-spring / Motion spring presets, a named ease, CSS's own keywords, Lenis lerp 0.1)? */
export function defaultMatch(rec) {
  const fam = String((rec.model && rec.model.family) || ''); const pr = progressOf(rec);
  if (pr.kind === 'spring') { const m = springPreset(pr.omega, pr.zeta); return m ? { match: m.name, within: `${(m.e * 100).toFixed(1)} %` } : { match: null, note: 'tuned spring (no common preset within 3 %)' }; }
  if (/^named:/.test(fam)) { const n = rec.model.ease || fam.slice(6); return { match: n, ...(EASE_ALIAS[n] ? { gsap: EASE_ALIAS[n] } : {}) }; }
  if (/^declared:/.test(fam)) { const e = String((rec.model.params.easing || {}).value || ''); return /^(ease|ease-in|ease-out|ease-in-out|linear)$/.test(e) ? { match: `CSS ${e}` } : { match: null, note: 'custom easing' }; }
  if (/^bezier/.test(fam)) return { match: null, note: 'custom cubic-bezier (no named ease within tolerance)' };
  if (pr.kind === 'smoothing') { const lerp = 1000 / (60 * pr.tau); return Math.abs(lerp - 0.1) <= 0.002 ? { match: 'Lenis default (lerp 0.1)' } : { match: null, note: `lerp ${sig(lerp, 3)} per 60 Hz frame` }; }
  return null;
}

// ---------- recorded vs fitted series ----------

const valueAt = (pts, t) => { // pts sorted [[T, y]]; linear interpolation, clamped
  if (!pts.length) return null; if (t <= pts[0][0]) return pts[0][1]; if (t >= pts.at(-1)[0]) return pts.at(-1)[1];
  let lo = 0, hi = pts.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= t) lo = m; else hi = m; }
  const [t0, y0] = pts[lo], [t1, y1] = pts[hi]; return t1 === t0 ? y0 : y0 + ((y1 - y0) * (t - t0)) / (t1 - t0);
};

/** Recorded samples [[T ms, value]] of one element channel from the take (numbers only). */
const takeRows = new Map(); // one take kept: a call reads many channels of the same take
function rowsOfTake(takeDir) {
  if (!takeRows.has(takeDir)) { takeRows.clear(); takeRows.set(takeDir, loadTake(takeDir, ['rows']).data); }
  return takeRows.get(takeDir);
}
const glCache = new WeakMap();
export function recordedSeries(takeDir, el, channel) {
  const data = rowsOfTake(takeDir);
  const pts = [];
  // a WebGL channel (gl:<uniform>, gl:camera.<q>): rebuilt from the uniform / matrix rows as the fitter reads them
  if (/^gl:/.test(String(channel))) {
    let m = glCache.get(data); if (!m) glCache.set(data, (m = glSeriesOf(data.rows || [])));
    const s = m.get(`gl|${channel}`); return s ? s.idx.map((i, j) => [data.rows[i].T, s.y[j]]) : [];
  }
  // a string value counts by its first number, as the fitter reads it (numOf: blur(16px) -> 16)
  for (const r of data.rows || []) { const v = r.v && r.v[el]; const y = v ? numOf(v[channel]) : null; if (y != null) pts.push([r.T, y]); }
  return pts;
}
/**
 * The form around the number of a channel recorded as strings (blur(<n>px)), as the fitter stores it on target.form:
 * {fn, unit} when every sample has one form, null when they differ or have none, undefined for a numeric channel.
 */
export function recordedForm(takeDir, el, channel) {
  let key, form;
  for (const r of rowsOfTake(takeDir).rows || []) {
    const raw = r.v && r.v[el] && r.v[el][channel]; if (typeof raw !== 'string' || numOf(raw) == null) continue;
    const f = valueForm(raw); const k = f ? `${f.fn}|${f.unit}` : 'none';
    if (key === undefined) { key = k; form = f; } else if (key !== k) return null;
  }
  return key === undefined ? undefined : form;
}

/**
 * The fitted curve as a function of page time, rebuilt from the record: y = from + (to − from)·p(t − t0). `from` is the
 * recorded value at t0 (the record does not store it), `to` the fitted target (or the recorded end value). Returns {fn, how}
 * or {why}. The caller reports how far the rebuild is from the recorded samples, so a bad rebuild is visible.
 */
export function fittedCurve(rec, pts) {
  const pr = progressOf(rec); if (pr.why) return { why: pr.why };
  if (pr.kind === 'smoothing') return { why: 'a smoothing follows its driver (scroll / pointer); its curve needs the driver series, not a step response' };
  const P = (n) => { const p = rec.model.params && rec.model.params[n]; return p && typeof p.value === 'number' ? p.value : null; };
  const d = rec.derived || {};
  let t0 = P('t0') ?? d.t0; if (/^declared:/.test(rec.model.family)) t0 = d.visibleOnset ?? d.t0 ?? P('start');
  if (!Number.isFinite(t0)) return { why: 'start time not identified' };
  const kv = rec.model.params.keyframeValues && Array.isArray(rec.model.params.keyframeValues.value) ? rec.model.params.keyframeValues.value : null;
  const from = P('x0') ?? valueAt(pts, t0);
  let to = P('target') ?? P('to'); let how = 'from = recorded value at t0';
  // without a fitted target: the declared last keyframe, else the recorded value where the motion ends (a later motion on the
  // same channel must not move the end point: a fade out followed by a fade in ends at 0, not at the take's last value)
  const endAt = pr.D ? t0 + pr.D : t0 + settleMs(pr.p, 0.001, 20000);
  if (to == null && kv && Number.isFinite(+kv.at(-1))) { to = +kv.at(-1); how += ', to = declared last keyframe'; } else if (to == null) { to = valueAt(pts, endAt); how += ', to = recorded value at the end of the motion'; } else how += ', to = fitted target';
  if (from == null || to == null) return { why: 'no recorded samples to anchor the curve' };
  let v0n = 0; const v0 = P('v0');
  if (pr.kind === 'spring' && v0 != null && to !== from) v0n = v0 / (to - from);
  const p = pr.kind === 'spring' ? springProgress(pr.omega, pr.zeta, v0n) : pr.p;
  return { fn: (t) => (t <= t0 ? from : from + (to - from) * p(t - t0)), t0, end: t0 + (pr.D || settleMs(p, 0.001, 20000)), how };
}

/** Largest-triangle-three-buckets downsampling of [[x, y, ...]] to at most n points (keeps peaks and turns). */
export function lttb(pts, n) {
  if (pts.length <= n || n < 3) return pts.slice(0, Math.max(n, 0) || pts.length);
  const out = [pts[0]]; const every = (pts.length - 2) / (n - 2); let a = 0;
  for (let i = 0; i < n - 2; i++) {
    const s = Math.floor((i + 1) * every) + 1, e = Math.min(Math.floor((i + 2) * every) + 1, pts.length);
    let ax = 0, ay = 0; for (let j = s; j < e; j++) { ax += pts[j][0]; ay += pts[j][1]; } ax /= e - s || 1; ay /= e - s || 1;
    const rs = Math.floor(i * every) + 1, re = Math.floor((i + 1) * every) + 1; let best = rs, area = -1;
    for (let j = rs; j < re; j++) { const ar = Math.abs((pts[a][0] - ax) * (pts[j][1] - pts[a][1]) - (pts[a][0] - pts[j][0]) * (ay - pts[a][1])); if (ar > area) { area = ar; best = j; } }
    out.push(pts[best]); a = best;
  }
  out.push(pts.at(-1)); return out;
}

/**
 * The recorded values where a step motion starts and ends ({from, to, t0, t1}), or null. `from` is the last sample at or
 * before the start, `to` the first sample at or after the end (the fitted curve's span, else the record's time range).
 */
export function recordedEnds(takeDir, rec) {
  const pts = recordedSeries(takeDir, String(rec.target.el), rec.target.channel); if (!pts.length) return null;
  const fc = fittedCurve(rec, pts);
  const loc = rec.evidence && rec.evidence.location && rec.evidence.location.kind === 'time_range' ? rec.evidence.location.range : null;
  const t0 = fc.fn ? fc.t0 : loc && loc[0]; const t1 = fc.fn ? fc.end : loc && loc[1];
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  const before = pts.filter(([t]) => t <= t0).at(-1) || pts.find(([t]) => t >= t0);
  const after = pts.find(([t]) => t >= t1) || pts.filter(([t]) => t <= t1).at(-1);
  const v = (p) => (p && Number.isFinite(p[1]) ? Math.round(p[1] * 1000) / 1000 : null);
  return { from: v(before), to: v(after), t0, t1 };
}

// ---------- page-authored custom-property names ----------
// A channel of a CSS custom property carries the page's own name (`drv:--orbit-enter-x`): page-chosen words, like a
// selector. The public surface shows each as an id of our own (`--reva-p1`, in order of first appearance in the look
// result) and gives the page's name only inside untrusted_content. Ids sent back with an alias resolve to the real channel.

const CP_CHANNEL = /^(?:drv|ren):(--.+)$/;
const CP_EMBED = /\b(?:drv|ren):(--[^\s"'`\\,;:()[\]{}<>]+)/g;
const NAME_CH = 'A-Za-z0-9_\\-\\u00A0-\\uFFFF';
const cpCache = new WeakMap();
/** {alias: Map(real -> alias), real: Map(alias -> real), re} for one look result (cached per object). */
export function customProps(look) {
  if (look && cpCache.has(look)) return cpCache.get(look);
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  const walk = (v) => {
    if (typeof v === 'string') { const m = CP_CHANNEL.exec(v); if (m) add(m[1]); else if (v.includes(':--')) for (const x of v.matchAll(CP_EMBED)) add(x[1]); }
    else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { walk(k); walk(x); }
  };
  walk(look);
  const alias = new Map(names.map((n, i) => [n, `--reva-p${i + 1}`])); const real = new Map([...alias].map(([a, b]) => [b, a]));
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alt = [...names].sort((a, b) => b.length - a.length).map(esc).join('|');
  const out = { alias, real, re: names.length ? new RegExp(`(?<![${NAME_CH}])(?:${alt})(?![${NAME_CH}])`, 'g') : null,
    reCh: names.length ? new RegExp(`(?<=(?:drv|ren):)(?:${alt})(?![${NAME_CH}])`, 'g') : null };
  if (look && typeof look === 'object') cpCache.set(look, out);
  return out;
}
/** A channel or channel id with every page custom-property name replaced by its alias (onlyChannels: only `drv:--x` forms). */
export function aliasText(look, s, { onlyChannels = false } = {}) {
  const cp = customProps(look); const re = onlyChannels ? cp.reCh : cp.re;
  return re && typeof s === 'string' && s.includes('--') ? s.replace(re, (n) => cp.alias.get(n) || n) : s;
}
/** A channel key sent back by a client: an alias becomes the page's name again (`drv:--reva-p1#2` -> `drv:--x#2`). */
export function realName(look, key) {
  const cp = customProps(look); if (!cp.real.size) return key;
  return String(key).replace(/--reva-p\d+(?![A-Za-z0-9_-])/g, (a) => cp.real.get(a) || a);
}
/**
 * A result with every page custom-property name outside untrusted_content replaced by its alias (object keys too). The
 * `next` hints are CLI lines: there only the `drv:--x` channel form is replaced, so a flag such as --analysis is never hit.
 */
export function aliasDeep(look, v, isUntrusted, key = null) {
  if (!customProps(look).re) return v;
  const walk = (x, k) => {
    if (isUntrusted(x)) return x;
    if (typeof x === 'string') return aliasText(look, x, { onlyChannels: k === 'next' });
    if (Array.isArray(x)) return x.map((y) => walk(y, k));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([kk, y]) => [aliasText(look, kk), walk(y, kk)]));
    return x;
  };
  return walk(v, key);
}

export { channelWord, sig };
