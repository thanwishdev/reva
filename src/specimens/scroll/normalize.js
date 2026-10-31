// Record adapters for the scroll specimens: motion records -> mechanism specs.
//
// Two record dialects are accepted and mapped onto one internal "view":
//   * Fixture Lab truth items (`reva.labtruth/0` items: `target: "sel|channel"`, `params.map`, `params.alpha.value` ...),
//     which the M3 gate uses as specimen input for the lab specimens;
//   * fitted records (`reva.motion/0`: `target.desc` + `target.channel`, `model.map`, `model.params.alpha_per_frame`,
//     `smoothing`, `hysteresis` ...) as written by src/analysis/fit.
// H6: nothing is filled silently. A parameter the record marks unknown is either supplied by its withheld value and listed
// in `unknowns` as a placeholder, or the record is skipped with a reason; every default the builder adds is an
// `assumptions` entry.
import { easeKey, EASE_NAMES, rectOf, flipDelta } from './core.js';
import { pointerScript } from './input.js';
import { isSchema } from '../../util/schema.js';

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const val = (p) => (p && typeof p === 'object' && 'value' in p ? num(p.value) : num(p));

export const VIEWPORT_DEFAULT = { width: 1280, height: 800 };

// ------------------------------------------------------------------------------------------------ views
function splitTarget(t) {
  const i = t.indexOf('|');
  if (i < 0) return { sel: t, ch: '' };
  return { sel: t.slice(0, i), ch: t.slice(i + 1) };
}
const chName = (ch) => (/^--/.test(ch) ? 'drv:' + ch : ch);

function viewTruth(it) {
  const { sel, ch } = splitTarget(String(it.target));
  const p = it.params || {};
  const v = {
    dialect: 'labtruth', raw: it, key: String(it.target), sel, ch: chName(ch), role: it.role === 'rendered-mirror' ? 'mirror' : it.role || (it.scored === false ? 'mirror' : 'driver'),
    mirrorOf: it.mirrorOf || null, cls: it.class, family: it.family, law: it.law || null, attribution: it.attribution || null,
    tier: it.provenance === 'declared' ? 'declared' : 'truth', unknowns: [],
    params: {
      alpha: val(p.alpha), alphaUp: val(p.alpha_up), alphaDown: val(p.alpha_down), lambda: val(p.lambda), lerp: val(p.lerp), snap: val(p.snap_eps),
      write: p.write || null, friction: val(p.friction), stopEps: val(p.stop_eps_px_per_frame), duration: val(p.duration), ease: p.ease || null,
      map: null, edges: p.edges_px || null, levels: val(p.levels), pin: p.pin || null, latch: p.latch || null,
    },
  };
  if (p.map && typeof p.map === 'object') {
    const m = p.map;
    v.params.map = { shape: m.shape, bezier: m.bezier || null, a: num(m.a), b: num(m.b), s0: num(m.px && m.px.s0), s1: num(m.px && m.px.s1), provenance: { s0: 'declared', s1: 'declared' } };
  }
  return v;
}

function strip(desc) { return String(desc || '').replace(/^[A-Za-z0-9]+(?=#|\.)/, ''); }
const NONE_TIERS = new Set(['unknown', 'unexplained']);

function viewFitted(rec) {
  const sel = strip(rec.target && rec.target.desc) || String(rec.target && rec.target.el);
  const m = rec.model || {}; const mp = m.params || {}; const sm = rec.smoothing || null;
  const v = {
    dialect: 'fitted', raw: rec, key: `${sel}|${rec.target.channel}`, sel, ch: rec.target.channel, role: rec.target.channel.startsWith('drv:') ? 'driver' : 'rendered', mirrorOf: null,
    cls: rec.class, family: m.family, law: m.law || (sm && sm.law) || null, attribution: rec.attribution && rec.attribution.label, tier: rec.tier,
    unknowns: (rec.unknowns || []).map((u) => u.id), params: {},
  };
  const alpha = val(mp.alpha_per_frame) ?? (sm && num(sm.alpha)) ?? val(mp.alpha);
  v.params = { alpha, lambda: sm && num(sm.lambda), snap: (sm && num(sm.snap_eps)) ?? val(mp.eps), alphaUp: val(mp.alphaUp), alphaDown: val(mp.alphaDown), L: val(mp.L), ease: m.ease || null, map: null, write: null };
  if (sm && sm.asymmetric && typeof sm.asymmetric === 'object') { v.params.alphaUp = num(sm.asymmetric.alphaUp ?? sm.asymmetric.up); v.params.alphaDown = num(sm.asymmetric.alphaDown ?? sm.asymmetric.down); }
  if (m.map) {
    const s0 = num(m.map.s0_px), s1 = num(m.map.s1_px);
    const w0 = num(mp.mapS0 && mp.mapS0.withheld_value), w1 = num(mp.mapS1 && mp.mapS1.withheld_value);
    v.params.map = {
      shape: m.map.shape || (String(m.family || '').match(/scroll map \((.+)\)/) || [])[1] || null, bezier: m.map.bezier || null, a: num(m.map.a), b: num(m.map.b),
      s0: s0 ?? w0, s1: s1 ?? w1, driverLagFrames: num(m.map.driverLagFrames) ?? 0, provenance: { s0: m.map.s0_provenance || 'fitted', s1: m.map.s1_provenance || 'fitted' },
      placeholder: { s0: s0 == null && w0 != null, s1: s1 == null && w1 != null },
    };
    if (m.map.s0_provenance === 'unknown' && s0 != null) v.params.map.provenance.s0 = 'unknown';
    if (m.map.s1_provenance === 'unknown' && s1 != null) v.params.map.provenance.s1 = 'unknown';
  }
  return v;
}

/** Flat list of views from any accepted input shape. */
export function viewsOf(src) {
  const items = Array.isArray(src) ? src : src && Array.isArray(src.records) ? src.records : src && Array.isArray(src.items) ? src.items : [];
  return items.map((it) => (it && isSchema(it.schema, 'reva.motion/0') ? viewFitted(it) : it && typeof it.target === 'string' ? viewTruth(it) : null)).filter(Boolean);
}

// ------------------------------------------------------------------------------------------------ builders
const SMOOTH_CLASSES = new Set(['scroll-map', 'scroll map', 'first-order smoothing', 'asymmetric smoothing', 'restarted tween']);
const REN_PROPS = new Set(['tx', 'ty', 'sx', 'sy', 'opacity']);

function lawOf(v, ctx) {
  const c = v.cls;
  if (c === 'scroll-map' || c === 'scroll map') return { law: 'none' };
  if (c === 'asymmetric smoothing') {
    const up = v.params.alphaUp, down = v.params.alphaDown;
    if (up == null || down == null) return { skip: 'asymmetric smoothing without alpha_up / alpha_down' };
    return { law: 'asym', alphaUp: up, alphaDown: down };
  }
  if (c === 'restarted tween') {
    if (v.params.L == null || !v.params.ease) return { skip: 'restarted tween without duration / ease' };
    return { law: 'restarted', L: v.params.L, ease: v.params.ease };
  }
  if (c === 'first-order smoothing') {
    const damp = /damp/i.test(String(v.family)) || v.law === 'dt-aware' || v.law === 'dtdamp';
    if (damp) {
      const lambda = v.params.lambda ?? (v.params.lerp != null ? 60 * v.params.lerp : null);
      if (lambda == null) return { skip: 'dt-aware smoothing without lambda' };
      return { law: 'dtdamp', lambda };
    }
    if (v.params.alpha == null) return { skip: 'first-order smoothing without alpha' };
    const out = { law: 'ema', alpha: v.params.alpha };
    if (v.law == null || v.law === 'unknown') ctx.unk(`unk_law:${v.key}`, 'the smoothing law (per-frame vs dt-aware) is not identified in the record; a per-frame EMA at the recorded alpha is used', 'record a second rate or a stall take (R5)', v.key);
    return out;
  }
  return { skip: `class "${c}" is not a scroll-driven smoother` };
}

function mapSpec(v, ctx) {
  const m = v.params.map;
  if (!m) return { skip: 'no scroll map in the record (the driver is raw scrollY in px: nothing to normalise)' };
  if (num(m.s0) == null || num(m.s1) == null || m.s1 === m.s0) return { skip: 'map range unknown' };
  if (!m.shape && !m.bezier) return { skip: 'map shape not identified' };
  if (!m.bezier && !easeKey(m.shape)) return { skip: `map shape "${m.shape}" is not in the specimen shape set (${EASE_NAMES.length} names)` };
  for (const e of ['s0', 's1']) {
    if (m.placeholder && m.placeholder[e]) ctx.unk(`unk_map_${e}:${v.key}`, `the map corner ${e} is not identifiable from the record (no sample past it); the withheld fitted value ${m[e]} is used as a placeholder`, 'scroll across the corner', v.key, true);
    else if (m.provenance && m.provenance[e] === 'unknown') ctx.unk(`unk_map_${e}:${v.key}`, `the map corner ${e} is flagged unknown in the record; its stored value is used as a placeholder`, 'scroll across the corner', v.key, true);
  }
  return { map: { shape: m.bezier ? 'bezier' : m.shape, bezier: m.bezier || null, s0: m.s0, s1: m.s1, ...(m.driverLagFrames > 0 ? { lagFrames: m.driverLagFrames } : {}) } };
}

const nearly = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * Normalise records into specimen parts. `opts`: { viewport, docHeight, frameMs }.
 * Returns { mechanisms, subjects, pins, channelMap, skipped, unknowns, assumptions, docHeight }.
 */
export function normalizeRecords(src, opts = {}) {
  const viewport = opts.viewport || VIEWPORT_DEFAULT;
  const views = viewsOf(src);
  const skipped = [], unknowns = [], assumptions = [], channelMap = [];
  const ctx = {
    unk: (id, reason, probe, target, placeholder) => { if (!unknowns.some((u) => u.id === id)) unknowns.push({ id, reason, probe, target, placeholder: !!placeholder }); },
    assume: (id, note) => { if (!assumptions.some((a) => a.id === id)) assumptions.push({ id, note }); },
  };
  const skip = (v, reason, kind) => skipped.push({ target: v.key, class: v.cls || null, reason, kind: kind || null });
  const subjects = new Map();
  const subjectOf = (sel) => {
    if (!subjects.has(sel)) {
      const n = subjects.size;
      subjects.set(sel, { id: 'b' + n, source: sel, x: 40 + (n % 4) * 300, y: 40 + Math.floor(n / 4) * 150, w: 180, h: 100, hue: (n * 67 + 200) % 360 });
    }
    return subjects.get(sel);
  };
  const mechanisms = [], pins = [], declared = [];
  const used = new Set();
  const mark = (v) => used.add(v);
  const varCount = new Map();
  const nextVar = (subj) => { const n = varCount.get(subj) || 0; varCount.set(subj, n + 1); return `--v${n}`; };

  // ---- scroll-driven (map + smoothing), wheel smooth scrollers, latch tweens, hysteresis, pins, inertia, flip, view transitions
  const isWheelDriven = (v) => v.attribution === 'wheel';

  // 1. wheel smooth scrollers (a smoother whose driver is the wheel: library-class smooth scroll)
  for (const v of views) {
    if (used.has(v) || v.role === 'mirror' || v.cls !== 'first-order smoothing' || !isWheelDriven(v)) continue;
    mark(v);
    const damp = /damp/i.test(String(v.family)) || v.law === 'dt-aware';
    const lerpV = v.params.lerp ?? v.params.alpha;
    const lam = v.params.lambda ?? (v.params.lerp != null ? 60 * v.params.lerp : null);
    if (damp ? lam == null : lerpV == null) { skip(v, 'wheel smoother without its lerp / lambda', 'wheel-smooth'); continue; }
    ctx.assume('wheel_mult', 'the wheel delta multiplier is not in a record; 1 is used (a record carries the smoothing only)');
    ctx.assume('wheel_limit', 'the scroll limit is the specimen document height minus the viewport');
    const subj = subjectOf(v.sel); const prop = nextVar(subj.id);
    const channels = [{ name: 'drv:' + prop, kind: 'var', prop, of: 'y', k0: 0, k1: 1, write: 'full', role: 'driver', source: v.key, compare: true }];
    for (const m of views) if (m.mirrorOf === v.key && REN_PROPS.has(m.ch.slice(4))) { mark(m); }
    mechanisms.push({ kind: 'wheel-smooth', subject: subj.id, law: damp ? 'dtdamp' : 'ema', lambda: damp ? lam : undefined, lerp: damp ? undefined : lerpV, mult: 1, limit: null, channels, sources: [v.key], tier: v.tier });
    channelMap.push({ source: v.key, specimen: `${subj.id}|drv:${prop}`, compare: true });
    // mirrors: the source's stylesheet maps the driver to a rendered channel; the affine is not in a lab mirror record
    for (const m of views) if (m.mirrorOf === v.key) skip(m, 'rendered mirror of a wheel smoother: no affine map in the record (the driver channel carries the dynamics)', 'wheel-smooth');
  }

  // 2. wheel-latched tween (scroll hijack): a tween whose attribution is the wheel and which carries a latch description
  for (const v of views) {
    if (used.has(v) || v.cls !== 'tween' || !isWheelDriven(v) || !v.params.latch) continue;
    mark(v);
    const L = v.params.latch, sec = L.section_px;
    if (!sec || v.params.duration == null) { skip(v, 'latched tween without section geometry / duration', 'wheel-latch'); continue; }
    const subj = subjectOf(v.sel); const prop = nextVar(subj.id);
    const m = /(\d+(?:\.\d+)?)%/.exec(String(L.arming_root_margin || ''));
    const mechSpec = {
      kind: 'wheel-latch', subject: subj.id, dur: v.params.duration, ease: v.params.ease || 'easeOutCubic', section: { top: sec.top, height: sec.height },
      armMarginVh: m ? parseFloat(m[1]) / 100 : 2, visMinVh: num(L.visible_height_min_vh) ?? 0.45, bottomSlack: num(L.bottom_max_vh_plus_px) ?? 8,
      channels: [{ name: 'drv:' + prop, kind: 'var', prop, of: 'm', k0: 0, k1: 1, write: 'full', role: 'driver', source: v.key, compare: true }], sources: [v.key], tier: v.tier,
    };
    mechanisms.push(mechSpec); channelMap.push({ source: v.key, specimen: `${subj.id}|drv:${prop}`, compare: true });
    for (const m2 of views) if (m2.mirrorOf === v.key) { mark(m2); skip(m2, 'rendered mirror of a latched tween: the record gives the ease and duration, not an affine map; the driver carries it', 'wheel-latch'); }
    for (const m2 of views) if (m2 !== v && m2.sel === v.sel && m2.attribution === 'wheel' && m2.role !== 'mirror' && !used.has(m2)) { mark(m2); skip(m2, 'derived affine channel of the latched tween (not stored as a map)', 'wheel-latch'); }
    ctx.assume('latch_geometry', 'the latch section is a fixed box at the recorded document position; its arming uses geometry, not an IntersectionObserver');
  }

  // 3. hysteresis staircases
  for (const v of views) {
    if (used.has(v)) continue;
    let up = null, down = null, levels = null;
    if (v.dialect === 'labtruth' && v.params.edges && v.params.edges.up) { up = v.params.edges.up; down = v.params.edges.down; levels = v.params.levels ?? up.length + 1; }
    else if (v.dialect === 'fitted' && v.raw.hysteresis && v.raw.hysteresis.hysteresis) {
      const bands = (v.raw.hysteresis.bands || []).filter((b) => Array.isArray(b.between) && b.between[1] === b.between[0] + 1 && b.between[0] >= 0 && num(b.downEdge_px) != null && num(b.upEdge_px) != null);
      bands.sort((a, b) => a.between[0] - b.between[0]);
      if (bands.length && bands.every((b, i) => b.between[0] === i)) { up = bands.map((b) => b.downEdge_px); down = bands.map((b) => b.upEdge_px); levels = bands.length + 1; ctx.unk(`unk_hyst_res:${v.key}`, 'hysteresis edges are measured on a 10 px grid (resolution of the dense sweep)', 'sweep with a finer step around the edges', v.key, false); }
    }
    if (!up) continue;
    mark(v);
    const subj = subjectOf(v.sel); const prop = nextVar(subj.id);
    mechanisms.push({ kind: 'hysteresis', subject: subj.id, up, down, levels, init: 0, channels: [{ name: 'drv:' + prop, kind: 'var', prop, of: 'i', k0: 0, k1: 1, write: 'int', role: 'driver', source: v.key, compare: true }], sources: [v.key], tier: v.tier });
    channelMap.push({ source: v.key, specimen: `${subj.id}|drv:${prop}`, compare: true });
  }

  // 4. pins (layout)
  for (const v of views) {
    if (used.has(v) || !(v.params.pin && v.dialect === 'labtruth')) continue;
    mark(v);
    const p = v.params.pin;
    if (num(p.start_px) == null || num(p.end_px) == null) { skip(v, 'pin without start / end', 'pin'); continue; }
    const subj = subjectOf(v.sel);
    pins.push({ subject: subj.id, start: p.start_px, end: p.end_px, held: num(p.held_value) ?? 0, source: v.key });
    channelMap.push({ source: v.key, specimen: `${subj.id}|ren:by`, compare: true });
  }
  if (src && Array.isArray(src.pins)) {
    // a fit result lists every held interval of an element; a page has ONE sticky runway per element: the widest interval wins
    const cand = new Map();
    for (const p of src.pins) {
      const start = num(p.start_px) ?? (p.start && p.start.interval ? (p.start.interval[0] + p.start.interval[1]) / 2 : null);
      const end = num(p.end_px) ?? (p.end && p.end.interval ? (p.end.interval[0] + p.end.interval[1]) / 2 : null);
      const key = `${strip(p.desc)}|pin`;
      if (start == null || end == null || end <= start) { skipped.push({ target: key, class: null, reason: 'pin range not identified', kind: 'pin' }); continue; }
      const prev = cand.get(p.desc);
      if (prev && prev.end - prev.start >= end - start) { skipped.push({ target: key, class: null, reason: 'a wider held interval of the same element is the pin (one sticky runway per element)', kind: 'pin' }); continue; }
      if (prev) skipped.push({ target: key, class: null, reason: 'a wider held interval of the same element is the pin (one sticky runway per element)', kind: 'pin' });
      cand.set(p.desc, { p, start, end, key });
    }
    for (const { p, start, end, key } of cand.values()) {
      if (pins.some((q) => q.source === key || q.subject === subjectOf(strip(p.desc)).id)) { skipped.push({ target: key, class: null, reason: 'the element already has a pin from a record', kind: 'pin' }); continue; }
      const subj = subjectOf(strip(p.desc));
      if (num(p.start_px) == null) ctx.unk(`unk_pin_start:${key}`, `pin start only bracketed to ${JSON.stringify(p.start && p.start.interval)}; its midpoint is a placeholder`, 'sweep the pin start at a finer step', key, true);
      if (num(p.end_px) == null) ctx.unk(`unk_pin_end:${key}`, `pin end only bracketed to ${JSON.stringify(p.end && p.end.interval)}; its midpoint is a placeholder`, 'sweep the pin end at a finer step', key, true);
      pins.push({ subject: subj.id, start, end, held: 0, source: key });
    }
  }

  // 5. scroll-driven mechanisms (map + smoothing law); one mechanism per (selector, map, law) group, its channels the
  //    driver variables and the rendered channels that share the group
  const cands = views.filter((v) => !used.has(v) && v.role !== 'mirror' && SMOOTH_CLASSES.has(v.cls) && !NONE_TIERS.has(v.tier) && v.params.map && !isWheelDriven(v));
  const groups = [];
  for (const v of cands) {
    const l = lawOf(v, ctx); const mp = mapSpec(v, ctx);
    if (l.skip || mp.skip) { skip(v, l.skip || mp.skip, 'scroll-driven'); mark(v); continue; }
    const g = groups.find((q) => q.sel === v.sel && q.map.shape === mp.map.shape && (q.map.lagFrames | 0) === (mp.map.lagFrames | 0) && nearly(q.map.s0, mp.map.s0, 2) && nearly(q.map.s1, mp.map.s1, 2) && q.law.law === l.law
      && ['alpha', 'lambda', 'alphaUp', 'alphaDown', 'L'].every((k) => (q.law[k] == null && l[k] == null) || (q.law[k] != null && l[k] != null && nearly(q.law[k], l[k], 0.02 * Math.abs(q.law[k]) + 1e-9))));
    if (g) g.members.push(v); else groups.push({ sel: v.sel, map: mp.map, law: l, members: [v] });
    mark(v);
  }
  for (const g of groups) {
    const subj = subjectOf(g.sel);
    const primary = g.members.find((m) => m.ch.startsWith('drv:--')) || g.members[0];
    const pm = primary.params.map;
    const flip = (pm.b ?? 1) < 0;
    // affine of a channel over the smoothed quantity x (x = 1 - p when the primary falls, so the primary rises with x)
    const aff = (m) => { const a = m.a ?? 0, b = m.b ?? 1; return flip ? { k0: a + b, k1: -b } : { k0: a, k1: b }; };
    const snaps = g.members.map((m) => m.params.snap).filter((s) => s != null);
    const snap = snaps.length ? snaps[0] : null;
    const smoothing = { law: g.law.law };
    for (const k of ['alpha', 'lambda', 'alphaUp', 'alphaDown', 'L', 'ease']) if (g.law[k] != null) smoothing[k] = g.law[k];
    if (g.law.law !== 'none') {
      if (snap == null) ctx.assume(`snap:${subj.id}`, 'the snap epsilon of the smoother is not in the record; 0 (no snap, an exponential tail) is used');
      smoothing.snap = snap ?? 0;
    }
    const channels = [];
    const driverIdx = {};
    // var channels first
    const writeOf = (m) => (m.raw && m.raw.params && m.raw.params.write) || m.params.write || 'full';
    for (const m of g.members) {
      if (!m.ch.startsWith('drv:--')) continue;
      const prop = nextVar(subj.id); const a = aff(m.params.map);
      driverIdx[m.key] = channels.length;
      channels.push({ name: 'drv:' + prop, kind: 'var', prop, of: 'x', k0: a.k0, k1: a.k1, write: writeOf(m), role: m === primary ? 'driver' : 'driver', source: m.key, compare: true });
      channelMap.push({ source: m.key, specimen: `${subj.id}|drv:${prop}`, compare: true });
    }
    const firstVar = channels.findIndex((c) => c.kind === 'var');
    for (const m of g.members) {
      if (m.ch.startsWith('drv:--')) continue;
      const prop = m.ch.slice(4);
      if (!REN_PROPS.has(prop)) { skip(m, `rendered channel "${m.ch}" is layout-derived (it follows the transform / pin; not written directly)`, 'scroll-driven'); continue; }
      const a = aff(m.params.map);
      const mirrorDriver = m.mirrorOf && driverIdx[m.mirrorOf] != null ? driverIdx[m.mirrorOf] : firstVar;
      const ch = { name: m.ch, kind: 'ren', prop, of: 'x', k0: a.k0, k1: a.k1, role: 'rendered', source: m.key, compare: true };
      if (mirrorDriver >= 0 && Math.abs(channels[mirrorDriver].k1) > 1e-12) {
        const d = channels[mirrorDriver]; ch.via = mirrorDriver; ch.k1 = a.k1 / d.k1; ch.k0 = a.k0 - ch.k1 * d.k0;
      }
      channels.push(ch); channelMap.push({ source: m.key, specimen: `${subj.id}|${m.ch}`, compare: true });
    }
    // lab truth mirrors: rendered channels of the driver
    for (const v of views) {
      if (v.role !== 'mirror' || !v.mirrorOf) continue;
      const di = driverIdx[v.mirrorOf]; if (di == null) continue;
      mark(v);
      const prop = v.ch.slice(4);
      if (!REN_PROPS.has(prop)) { skip(v, `rendered mirror "${v.ch}" is layout-derived`, 'scroll-driven'); continue; }
      if (!v.params.map || v.params.map.a == null) { skip(v, 'rendered mirror without an affine map in the record (the driver channel carries the dynamics)', 'scroll-driven'); continue; }
      const a = aff(v.params.map); const d = channels[di];
      const ch = { name: v.ch, kind: 'ren', prop, via: di, k1: a.k1 / d.k1, k0: a.k0 - (a.k1 / d.k1) * d.k0, of: 'x', role: 'rendered', source: v.key, compare: true };
      channels.push(ch); channelMap.push({ source: v.key, specimen: `${subj.id}|${v.ch}`, compare: true });
    }
    if (!channels.length) { skip(primary, 'no writable channel', 'scroll-driven'); continue; }
    mechanisms.push({ kind: 'scroll-driven', subject: subj.id, map: { ...g.map, flip }, smoothing, init: 'target', channels, sources: g.members.map((m) => m.key), tier: primary.tier });
  }

  // 6. inertia (friction after a pointer release)
  for (const v of views) {
    if (used.has(v) || v.cls !== 'friction') continue;
    mark(v);
    if (v.params.friction == null) { skip(v, 'friction record without a coefficient', 'inertia'); continue; }
    const subj = subjectOf(v.sel); const prop = nextVar(subj.id);
    if (v.params.stopEps == null) ctx.assume(`stop_eps:${subj.id}`, 'the stop threshold is not in the record; 0.05 px per frame is used');
    ctx.assume('inertia_release', 'release velocity = pointer displacement over the last 100 ms, converted at a nominal 60 Hz frame (a property of the source mechanism, not stored in a record)');
    ctx.assume(`inertia_x0:${subj.id}`, 'the start position of the box is not in the record; 100 px is used (the post-release trajectory does not depend on it)');
    mechanisms.push({ kind: 'inertia', subject: subj.id, friction: v.params.friction, law: v.law === 'dt-aware' ? 'dt' : 'frame', stopEps: v.params.stopEps ?? 0.05, velWindowMs: 100, nominalHz: 60, x0: 100,
      channels: [{ name: 'drv:' + prop, kind: 'var', prop, of: 'x', k0: 0, k1: 1, write: 'full', role: 'driver', source: v.key, compare: true }, { name: 'ren:tx', kind: 'ren', prop: 'tx', of: 'x', k0: -100, k1: 1, role: 'visual', source: null, compare: false }],
      sources: [v.key], tier: v.tier });
    channelMap.push({ source: v.key, specimen: `${subj.id}|drv:${prop}`, compare: true });
  }
  const inputHints = { pointer: [], triggers: [] };
  for (const v of views) {
    if (!used.has(v) && v.raw && v.raw.segment === 'drag') {
      mark(v); skip(v, 'the drag segment follows the input pointer (an input, not a fitted mechanism)', 'inertia');
      const d = v.raw.derived || {}, rel = views.find((q) => q.cls === 'friction' && q.raw.derived && q.raw.derived.release_ms != null);
      if (d.from_ms != null && d.to_ms != null && d.speed_px_ms != null && rel) {
        inputHints.pointer = pointerScript({ downT: d.from_ms - 10, x0: 160, speed: d.speed_px_ms, moveFromT: d.from_ms, moveToT: d.to_ms, upT: rel.raw.derived.release_ms });
        ctx.assume('pointer_script', 'the pointer path is reconstructed from the record (drag start / end / speed / release time); the start x is arbitrary');
      }
    }
  }

  // 7. FLIP and View Transitions (declared)
  const flipItems = views.filter((v) => !used.has(v) && v.raw && v.raw.sub === 'flip');
  if (flipItems.length) buildFlip(flipItems, mechanisms, channelMap, subjectOf, ctx, skip, mark, nextVar);
  const vtItems = views.filter((v) => !used.has(v) && v.raw && v.raw.sub === 'view-transition');
  if (vtItems.length) buildViewTransition(vtItems, views, mechanisms, subjects, subjectOf, ctx, skip, mark, opts.frameMs ?? 1000 / 120, declared);

  // leftovers
  for (const v of views) {
    if (used.has(v)) continue;
    if (v.role === 'mirror' && v.mirrorOf && views.some((q) => used.has(q) && q.key === v.mirrorOf)) { skip(v, 'rendered mirror of a mechanism that was not built', null); continue; }
    if (v.raw && v.raw.family === 'layout-update') { skip(v, 'live-element layout step of a view transition (follows the layout toggle)', 'view-transition'); continue; }
    if (v.raw && v.raw.role === 'derived') { skip(v, 'derived combination of other channels (stored as its parts)', null); continue; }
    skip(v, NONE_TIERS.has(v.tier) ? `record tier "${v.tier}": no model to rebuild` : `no specimen mechanism for class "${v.cls}" family "${v.family}"`, null);
  }

  // a mechanism without a rendered channel gets a synthetic visual one so the box moves (never compared with the source)
  const VISUAL = { 'scroll-driven': ['x', 240], hysteresis: ['i', 60], 'wheel-smooth': ['y', 0.1], 'wheel-latch': ['m', 240] };
  const rendered = new Set(mechanisms.filter((m) => m.channels.some((c) => c.kind === 'ren')).map((m) => m.subject));
  for (const m of mechanisms) {
    const vis = VISUAL[m.kind];
    if (vis && !rendered.has(m.subject) && !m.channels.some((c) => c.kind === 'ren')) {
      m.channels.push({ name: 'ren:tx', kind: 'ren', prop: 'tx', of: vis[0], k0: 0, k1: vis[1], role: 'visual', source: null, compare: false });
      rendered.add(m.subject);
    }
  }

  // document height: wheel limit and pin runways need room
  let docHeight = opts.docHeight || 0;
  const need = [];
  for (const m of mechanisms) {
    if (m.kind === 'scroll-driven') need.push(m.map.s1);
    if (m.kind === 'hysteresis') need.push(Math.max(...m.up));
  }
  for (const p of pins) need.push(p.end + viewport.height);
  if (!docHeight) {
    docHeight = Math.ceil((Math.max(0, ...need) + viewport.height) / 100) * 100;
    if (need.length) ctx.assume('doc_height', `document height ${docHeight} px = the furthest recorded scroll position plus one viewport`);
  }
  for (const m of mechanisms) if (m.kind === 'wheel-smooth') m.limit = Math.max(0, docHeight - viewport.height);

  for (const m of mechanisms) if ((m.kind === 'flip' || m.kind === 'view-transition') && m.triggers) for (const T of m.triggers) inputHints.triggers.push({ T });
  inputHints.triggers.sort((a, b) => a.T - b.T);
  return { viewport, mechanisms, subjects: [...subjects.values()], pins, channelMap, skipped, unknowns, assumptions, docHeight, inputHints, declared };
}

// ------------------------------------------------------------------------------------------------ FLIP / view transitions
function buildFlip(items, mechanisms, channelMap, subjectOf, ctx, skip, mark, nextVar) {
  const bySel = new Map();
  for (const v of items) { mark(v); const a = bySel.get(v.sel) || []; a.push(v); bySel.set(v.sel, a); }
  for (const [sel, list] of bySel) {
    const tx = list.filter((v) => v.ch === 'ren:tx').sort((a, b) => a.raw.params.segment - b.raw.params.segment);
    if (!tx.length) { for (const v of list) skip(v, 'flip record without a tx channel', 'flip'); continue; }
    const s1 = tx[0].raw.params;
    const D = s1.duration_ms, ez = s1.easing;
    if (!(D > 0) || !s1.layout_delta) { for (const v of list) skip(v, 'flip record without duration / layout delta', 'flip'); continue; }
    const subj = subjectOf(sel);
    const d1 = s1.layout_delta;
    // the transform channels depend only on the ratios and offsets of the two layout states (origin top-left): the absolute
    // size of the box is not identifiable from a record and does not change them
    const box = { w: 160, h: 100 };
    ctx.assume(`flip_box:${subj.id}`, 'the absolute box size is not identifiable from a record (tx, ty, sx, sy depend only on the offsets and ratios of the two layout states); 160 x 100 is used');
    const A = { x: 100, y: 120, w: box.w, h: box.h };
    const B = { x: A.x - d1.dx, y: A.y - d1.dy, w: box.w / d1.sx, h: box.h / d1.sy };
    const triggers = [...new Set(tx.map((v) => v.raw.params.trigger_ms))].filter((x) => x != null).sort((a, b) => a - b);
    mechanisms.push({ kind: 'flip', subject: subj.id, impl: s1.impl === 'raf' ? 'raf' : 'waapi', D, ease: ez, A, B, triggers, subjectBox: { x: A.x, y: A.y, w: A.w, h: A.h },
      channels: ['tx', 'ty', 'sx', 'sy'].map((p) => ({ name: 'ren:' + p, kind: 'ren', prop: p, of: p, k0: 0, k1: 1, role: 'rendered', source: `${sel}|ren:${p}`, compare: true })), sources: tx.map((v) => v.key), tier: 'declared' });
    for (const p of ['tx', 'ty', 'sx', 'sy']) channelMap.push({ source: `${sel}|ren:${p}`, specimen: `${subj.id}|ren:${p}`, compare: true });
    subj.fixedBox = { x: A.x, y: A.y, w: A.w, h: A.h }; subj.layoutSwitch = true; subj.origin = '0 0';
  }
}

export { rectOf, flipDelta };

function buildViewTransition(items, all, mechanisms, subjects, subjectOf, ctx, skip, mark, frameMs, declared) {
  const groups = [];
  let start = null, latency = 2;
  for (const v of items) {
    mark(v);
    const m = /view-transition-group\(([^)]+)\)/.exec(v.sel);
    const p = v.raw.params;
    if (!m || !p.old || !p.new || !(p.duration_ms > 0)) { skip(v, 'view-transition record without group name / old-new boxes / duration', 'view-transition'); continue; }
    if (start == null) { start = p.start_ms; latency = p.frames_after_trigger ?? 2; }
    groups.push({ name: m[1], d: p.duration_ms, delay: p.delay_ms || 0, ease: p.easing, A: p.old, B: p.new });
    declared.push({ source: v.key, specimen: `html::view-transition-group(${m[1]})`, kind: 'view-transition-group', name: m[1], duration_ms: p.duration_ms, delay_ms: p.delay_ms || 0, easing: p.easing, start_ms: p.start_ms, compare: true });
  }
  if (!groups.length) return;
  const subs = groups.map((g) => { const s = subjectOf('vt:' + g.name); s.vt = g; s.fixedBox = { ...g.A }; s.hue = (s.hue + 20) % 360; return s; });
  mechanisms.push({ kind: 'view-transition', subject: subs[0].id, groups: groups.map((g, i) => ({ ...g, subject: subs[i].id })), latencyFrames: latency, triggers: start != null ? [Math.round((start - latency * frameMs) * 1e6) / 1e6] : [], channels: [], sources: items.map((v) => v.key), tier: 'declared' });
  ctx.assume('vt_trigger', 'the view-transition callback toggles the layout state of every group at once; the trigger time is an input of the scenario');
}
