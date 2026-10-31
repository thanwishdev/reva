// look: plain-language lines from fitted records, by template (never by a language model).
// Every number carries one of three user-facing labels (REVA-PRODUCT §3.2 item 4) over the internal provenance values:
//   exact   = declared (read from the page's CSS / WAAPI)
//   fitted  = fitted, measured from the samples, or derived from fitted values
//   unknown = not identified (withheld, ambiguous, or not measured), with the reason
import { springProgress, settleMs } from '../export/curves.js';
import { formValue } from '../analysis/fit/series.js';
import { MAP_SHAPES } from '../analysis/fit/smoothing.js';
import { axisOfChannel, axisWord } from './fontaxes.js';

export const LABELS = ['exact', 'fitted', 'unknown'];

/** Internal provenance -> user label. */
export function labelOf(provenance) {
  if (provenance === 'declared') return 'exact';
  if (provenance === 'fitted' || provenance === 'measured' || provenance === 'inferred' || provenance === 'derived') return 'fitted';
  return 'unknown';
}

// numerical dust (|x| < 1e-6, e.g. a fitted map start of -1.2e-32 px) prints as 0
const sig = (x, n = 4) => (typeof x === 'number' && Number.isFinite(x) ? String(Math.abs(x) < 1e-6 ? 0 : +x.toPrecision(n)) : String(x));
const ms = (x) => `${sig(x, 4)} ms`;   // 4 significant digits: 166.7 ms is Lenis lerp 0.1, 167 ms is not
/**
 * One value with its label: {name, value, unit, label, reason?, text}. A missing / non-finite value is never printed as a
 * number (no "null px"): it reads "? [unknown]" with the reason kept on the value (describeRecord lists the reasons).
 */
export function val(name, value, unit, label, extra = {}) {
  const has = typeof value === 'number' ? Number.isFinite(value) : value != null;
  if (!has) return { name, value: null, unit: unit || null, label: 'unknown', ...extra, reason: extra.reason || 'not identified', text: `?${unit && unit !== 'ms' ? ` ${unit}` : unit === 'ms' ? ' ms' : ''} [unknown]` };
  const u = unit === 'ms' ? ms(value) : unit ? `${sig(value)} ${unit}` : sig(value);
  const v = { name, value, unit: unit || null, label, text: `${u} [${label}]`, ...extra };
  if (label === 'unknown' && !v.reason) v.reason = 'not identified';
  return v;
}
/** An unknown with no value to show: prints "[unknown]", the reason is listed at the end of the sentence. */
const unk = (name, reason) => ({ name, value: null, unit: null, label: 'unknown', reason, text: '[unknown]' });
/** val() from a param() result (carries its reason). */
const pval = (name, p, unit) => val(name, p ? p.value : null, unit, p ? p.label : 'unknown', p && p.reason ? { reason: p.reason } : {});
function param(rec, name) {
  const p = rec.model && rec.model.params && rec.model.params[name];
  if (!p) return null;
  if (p.value != null) return { value: p.value, label: labelOf(p.provenance), unit: p.unit || null, ...(labelOf(p.provenance) === 'unknown' ? { reason: p.reason || 'not identified' } : {}) };
  if (p.withheld_value != null) return { value: p.withheld_value, label: 'unknown', unit: p.unit || null, reason: p.reason || 'withheld' };
  return { value: null, label: 'unknown', unit: p.unit || null, reason: p.reason || 'not identified' };
}

const CH = {
  'ren:tx': 'x', 'ren:ty': 'y', 'ren:tz': 'z', 'ren:sx': 'scale x', 'ren:sy': 'scale y', 'ren:rz': 'rotation', 'ren:skx': 'skew',
  'ren:opacity': 'opacity', 'ren:filter': 'filter', 'ren:clipPath': 'clip-path', 'ren:radius': 'corner radius', 'ren:transform': 'transform',
  'ren:bx': 'box x (layout)', 'ren:by': 'box y (layout)', 'ren:bw': 'width', 'ren:bh': 'height', 'drv:transform': 'transform (as written)', 'drv:opacity': 'opacity (as written)',
  'ren:translate': 'translate', 'ren:scale': 'scale', 'ren:rotate': 'rotate',
  'ren:text': 'number shown in the text', 'ren:dash': 'line drawing offset (stroke-dashoffset)',
};
// split colour and paint-position channels (series.js SPLIT): `ren:bg.r` -> 'background colour red (0-255)'
const PAINT = { color: 'text colour', bg: 'background colour', fill: 'fill colour', stroke: 'stroke colour', bgPos: 'background position', maskPos: 'mask position' };
const PART = { r: 'red (0-255)', g: 'green (0-255)', b: 'blue (0-255)', a: 'alpha (0-1)', x: 'x', y: 'y' };
/** Channel id -> a word a designer reads. */
const GL_CAM = { fov: 'fov (°)', aspect: 'aspect', x: 'position x', y: 'position y', z: 'position z', rx: 'rotation x (°)', ry: 'rotation y (°)', rz: 'rotation z (°)' };
export function channelWord(ch) {
  const m = /^ren:clipPath\.(\w+)$/.exec(String(ch || ''));
  if (m) return `clip-path ${/^p\d+$/.test(m[1]) ? `value ${m[1].slice(1)}` : m[1]}`;
  const tp = /^ren:(translate|scale)\.([xyz])$/.exec(String(ch || ''));
  if (tp) return `${tp[1]} ${tp[2]}`;
  const pp = /^ren:(color|bg|fill|stroke|bgPos|maskPos)\.([rgbaxy])$/.exec(String(ch || ''));
  if (pp) return `${PAINT[pp[1]]} ${PART[pp[2]]}`;
  const ax = axisOfChannel(ch);
  if (ax) return axisWord(ax);
  // WebGL light: a uniform by its GLSL name, the camera by what it is
  const g = /^gl:(.+)$/.exec(String(ch || ''));
  if (g) { const c = /^camera\.(\w+)$/.exec(g[1]); return c ? `camera ${GL_CAM[c[1]] || c[1]}` : `uniform ${g[1]}`; }
  return CH[ch] || String(ch || '').replace(/^(ren|drv):/, '');
}

/** Canonical family name: labels that flip between equivalent forms from run to run become one (spike finding 6). */
export function canonicalFamily(fam) {
  const f = String(fam || '');
  if (/^(ema|dtdamp)\b/.test(f) || /unfinished ≡ dt-damp/.test(f)) return 'smoothing';
  if (/^asym/.test(f)) return 'asymmetric smoothing';
  if (f === 'spring' || /^spring/.test(f)) return 'spring';
  if (/^declared:/.test(f)) return f;
  if (/^named:|^bezier/.test(f)) return 'tween';
  if (/^scroll map/.test(f)) return 'scroll map';
  if (/^pin\b/.test(f)) return 'pin';
  return f || 'unknown';
}

// react-spring presets and Motion's default spring, for "default vs tuned" (mass 1: ω = √k, ζ = c / (2√k))
const SPRING_PRESETS = [
  ['react-spring default', 170, 26], ['react-spring gentle', 120, 14], ['react-spring wobbly', 180, 12], ['react-spring stiff', 210, 20],
  ['react-spring slow', 280, 60], ['react-spring molasses', 280, 120], ['Motion default', 100, 10],
];
export function springPreset(omega, zeta, tol = 0.03) {
  let best = null;
  for (const [name, k, c] of SPRING_PRESETS) {
    const w = Math.sqrt(k), z = c / (2 * w); const e = Math.max(Math.abs(omega / w - 1), Math.abs(zeta / z - 1));
    if (e <= tol && (!best || e < best.e)) best = { name, k, c, e };
  }
  return best;
}
export const EASE_ALIAS = {
  easeOutQuad: 'power1.out', easeOutCubic: 'power2.out', easeOutQuart: 'power3.out', easeOutQuint: 'power4.out',
  easeInQuad: 'power1.in', easeInCubic: 'power2.in', easeInQuart: 'power3.in', easeInQuint: 'power4.in',
  easeInOutQuad: 'power1.inOut', easeInOutCubic: 'power2.inOut', easeInOutQuart: 'power3.inOut', easeInOutQuint: 'power4.inOut',
  easeOutExpo: 'expo.out', easeInOutExpo: 'expo.inOut', easeOutSine: 'sine.out', easeInOutSine: 'sine.inOut', easeOutBack: 'back.out', easeOutCirc: 'circ.out',
};

function trigger(rec) {
  const a = rec.attribution && rec.attribution.label;
  if (a === 'time-driven') return 'plays on its own time';
  if (a === 'pointer') return 'reacts to the pointer';
  if (a === 'wheel' || a === 'scroll-linked') return 'tied to the scroll';
  if (a === 'scroll-triggered time-based') return 'starts when scrolled to, then plays on its own time';
  return null;
}

export function followWord(rec) {
  const drv = (rec.model.driver && rec.model.driver.kind) || (rec.attribution && /scroll|wheel/.test(rec.attribution.label) ? 'scroll' : null);
  return drv === 'pointer' ? 'the pointer' : drv === 'wheel' || drv === 'scroll' ? 'the scroll' : 'its target';
}
/** First-order smoothing sentence (ema / dtdamp, or asym with one direction seen). */
function smoothingText(rec, { tau, alpha, rate, add, opts }) {
  const parts = [`Smooth follow of ${followWord(rec)}`];
  if (tau && tau.value != null) {
    parts.push(`time constant ${add(pval('tau', tau, 'ms'))}`);
    const lerp = 1000 / (60 * tau.value);   // Lenis: lambda = lerp·60, tau = 1/lambda
    parts.push(`= lerp ${add(pval('lerp60', { ...tau, value: lerp }, null))} per 60 Hz frame${Math.abs(lerp - 0.1) <= 0.002 ? ' (Lenis default 0.1)' : ''}`);
    // an element (not the page's own box) following the scroll offset: a ScrollTrigger scrub of L seconds restarts an expo.out
    // tween of L on every scroll update, which IS this first-order curve with tau = L / (10 ln 2) (exactly, whether the
    // scroll moves every frame or holds); the same number read as GSAP's scrub value
    // (the scroll OFFSET only: a follower of the wheel sum is the page's own smooth scroll, Lenis-like)
    if (followWord(rec) === 'the scroll' && !(rec.model.driver && rec.model.driver.kind === 'wheel') && !/^ren:b[xywh]$/.test(rec.target.channel)) {
      const L = (tau.value * 10 * Math.LN2) / 1000;
      parts.push(`= GSAP scrub ${add(pval('scrubSeconds', { ...tau, value: L, ci95: tau.ci95 ? tau.ci95.map((v) => (v * 10 * Math.LN2) / 1000) : tau.ci95 }, 's'))} (a restarted expo.out of that length is this same curve)`);
    }
  }
  if (alpha && alpha.value != null && rate) parts.push(`closes ${add(pval('alpha', { ...alpha, value: alpha.value * 100 }, '%'))} of the gap each ${sig(rate, 3)} Hz frame`);
  let text = parts.join(', ');
  // one recording rate cannot tell a per-frame lerp (follows faster on a faster screen) from a time-based damp
  if (opts.oneRate) text += `; frame-rate behaviour ${add(unk('frameRateLaw', `recorded at ${sig(opts.oneRate, 3)} Hz only: a per-frame lerp and a time-based damp look the same at one rate`))}`;
  return text;
}

/**
 * The map as the text states it: a corner the samples never reached (provenance unknown, beyond the sampled scroll range)
 * is read at the sampled edge, never at the extrapolated corner. A curved map is otherwise stated from a point the page
 * never scrolled to: an easeInQuad hero fade fitted from -8697 px read "y 210.7 → -40", while at the page top (the first
 * sampled offset) it is 0. Linear maps are already anchored this way (exportword.js anchorMapToSamples).
 *
 * The clipped part of a curve is not the same curve (the last 8 % of an easeInQuad is nearly a straight line), so the
 * stated shape is the named shape that best matches the fitted curve on the sampled range, with its largest deviation
 * from it, and the fitted shape with its real (unobserved) corner. When no named shape is within 2 % of the travel,
 * only the values at the sampled edge are stated, with the fitted shape and its corner. The record and its export keep
 * the fitted map.
 */
function sampledMap(rec, m) {
  const loc = rec.evidence && rec.evidence.location; const rng = loc && loc.kind === 'scroll_range' && Array.isArray(loc.range) ? loc.range : null;
  const S = MAP_SHAPES[m.shape];
  if (!rng || !S || ![m.a, m.b, m.s0_px, m.s1_px, rng[0], rng[1]].every(Number.isFinite) || !(m.s1_px > m.s0_px)) return m;
  const lo = m.s0_provenance === 'unknown' && m.s0_px < rng[0] - 0.5, hi = m.s1_provenance === 'unknown' && m.s1_px > rng[1] + 0.5;
  if (!lo && !hi) return m;
  const at = (x) => m.a + m.b * S(Math.min(1, Math.max(0, (x - m.s0_px) / (m.s1_px - m.s0_px))));
  const s0 = lo ? rng[0] : m.s0_px, s1 = hi ? rng[1] : m.s1_px; const a = at(s0), b = at(s1) - a;
  const corner = lo && hi ? `ends ${sig(m.s0_px)} px and ${sig(m.s1_px)} px were` : lo ? `start ${sig(m.s0_px)} px was` : `end ${sig(m.s1_px)} px was`;
  const fitted = `the fitted ${m.shape}, whose ${corner} never scrolled to`;
  // the named shape closest to the fitted curve on [s0, s1], both pinned to the same ends: its largest deviation
  const N = 200; let best = null;
  if (Math.abs(b) > 1e-9) for (const [name, T] of Object.entries(MAP_SHAPES)) {
    let e = 0; for (let q = 0; q <= N; q++) { const u = q / N; e = Math.max(e, Math.abs(a + b * T(u) - at(s0 + (s1 - s0) * u))); }
    if (!best || e < best.e - 1e-12) best = { name, e };
  }
  const shape = best && best.e <= 0.02 * Math.abs(b)
    ? `${best.name} on the sampled range (at most ${sig(best.e, 2)}, ${sig((100 * best.e) / Math.abs(b), 2)} % of the travel, off ${fitted})`
    : `values at the sampled edge (${fitted}; no named shape within 2 % of the travel on the sampled range)`;
  return { ...m, a, b, s0_px: s0, s1_px: s1, shape };
}

/**
 * The travel of a declared record: 'opacity 0 → 1 [exact]'. A value declared in a relative unit is stated in it, with the
 * px it came to ('y 20 % → 0 % (24.8 px) [exact]'); an implicit end (the computed value, solved from the samples) carries
 * its own label ('opacity 0.0301 [fitted] → 1 [exact]').
 */
function declaredTravel(rec, kv) {
  const raw = rec.model.params.keyframeValues || {}; const f = rec.target.form; const n = kv.value.length;
  const w = (x) => (f ? formValue(f, sig(x, 3)) : sig(x, 3));
  const word = channelWord(rec.target.channel);
  if (raw.declaredUnit && Array.isArray(raw.declaredValues) && raw.declaredValues.length === n) {
    const d0 = raw.declaredValues[0], d1 = raw.declaredValues[n - 1]; const p0 = kv.value[0], p1 = kv.value[n - 1];
    const u = (d, p) => (d == null ? `${w(p)} px` : `${sig(d, 4)} ${raw.declaredUnit}`);
    const px = [p0, p1].filter((p, i) => Math.abs(p) > 1e-9 && [d0, d1][i] != null);
    const pxText = px.length === 1 ? ` (${sig(px[0], 3)} px)` : px.length === 2 ? ` (${sig(p0, 3)} → ${sig(p1, 3)} px)` : '';
    if (Array.isArray(raw.declaredAt)) return `${word} ${u(d0, p0)} [${raw.declaredAt[0] ? 'exact' : 'fitted'}] → ${u(d1, p1)} [${raw.declaredAt[n - 1] ? 'exact' : 'fitted'}]${pxText}`;
    return `${word} ${u(d0, p0)} → ${u(d1, p1)}${pxText} [${kv.label}]`;
  }
  if (Array.isArray(raw.declaredAt)) return `${word} ${w(kv.value[0])} [${raw.declaredAt[0] ? 'exact' : 'fitted'}] → ${w(kv.value[n - 1])} [${raw.declaredAt[n - 1] ? 'exact' : 'fitted'}]`;
  return `${word} ${w(kv.value[0])} → ${w(kv.value[n - 1])} [${kv.label}]`;
}

/**
 * One record -> {kind, family, text, values[]}. `values` carry the labels; `text` is the plain sentence with the
 * labels inline. Units of travel are the channel's own (px, deg, scale factor, opacity).
 */
export function describeRecord(rec, opts = {}) {
  const d = describeRecord0(rec, opts);
  // an ambiguous class: the best family is shown with its values withheld (labelled unknown), and the rivals named
  if (rec.tier === 'unknown' && rec.model && rec.model.family && d.kind !== 'unknown') {
    const c = rec.ambiguity && rec.ambiguity.candidates ? [...new Set(rec.ambiguity.candidates.map((q) => q.family || q.cls))].slice(0, 3).join(' / ') : null;
    d.text += `; ambiguous${c ? ` between ${c}` : ''} [unknown]`; d.label = 'unknown';
  }
  // every [unknown] value gets its reason (once per distinct reason, at the end of the sentence)
  const why = [...new Set(d.values.filter((v) => v.label === 'unknown').map((v) => v.reason || 'not identified'))];
  if (why.length) d.text += ` (unknown: ${why.join('; ')})`;
  return d;
}
function describeRecord0(rec, opts = {}) {
  const fam = rec.model && rec.model.family; const kind = canonicalFamily(fam); const values = []; let text;
  const add = (v) => { values.push(v); return v.text; };
  if (rec.tier === 'unexplained' || !fam) {
    const u = (rec.unknowns || [])[0];
    text = `moves, but no model explains it [unknown]${u ? `: ${u.reason}${u.probe ? ` (to resolve: ${u.probe})` : ''}` : ''}`;
    return { kind: 'unknown', family: fam || null, text, values, label: 'unknown' };
  }
  if (rec.tier === 'not_applicable') return { kind: 'not applicable', family: null, text: 'drawn on a canvas / WebGL: not visible to DOM channels [unknown]', values, label: 'unknown' };
  if (/^declared:/.test(fam || '')) {
    const d = param(rec, 'duration'), e = param(rec, 'easing'), dl = param(rec, 'delay'), it = param(rec, 'iterations'), kv = param(rec, 'keyframeValues');
    const births = (rec.declared && rec.declared.births) || []; const typ = births[0] && births[0].type;
    const what = typ === 'CSSTransition' ? 'CSS transition' : typ === 'CSSAnimation' ? 'CSS animation' : fam === 'declared:waapi' ? 'Web Animation' : fam === 'declared:view-transition' ? 'View transition' : 'CSS animation';
    const parts = [];
    if (d && d.value != null) parts.push(add(pval('duration', d, 'ms')));
    const ke = param(rec, 'keyframeEasings');
    if (e && e.value != null) parts.push(`${add(pval('easing', e, null))}${/keyframe/.test(String(rec.model.params.easing && rec.model.params.easing.note)) ? ' (on the keyframes)' : ''}`);
    else if (ke && Array.isArray(ke.value)) parts.push(`easing per keyframe segment: ${ke.value.join(' | ')} [${ke.label}]`);
    if (dl && dl.value) parts.push(`delay ${add(pval('delay', dl, 'ms'))}`);
    if (it && it.value != null && it.value !== 1) parts.push(`repeats ${add(pval('iterations', it, null))}`);
    let travel = null;
    if (kv && Array.isArray(kv.value) && kv.value.length >= 2 && kv.value.every((x) => typeof x === 'number')) travel = declaredTravel(rec, kv);
    const head = `${what}: ${parts.join(', ')}`;
    text = travel ? `${head}, ${travel}` : head;
    return { kind: 'declared', family: fam, text, head, travels: travel ? [travel] : [], values, label: 'exact' };
  }
  if (/^friction:/.test(fam || '')) {
    // a decay that loses a fixed share of its speed each frame is the same curve as a first-order glide to a stop point
    // (per frame the gap to the target shrinks by 1 - friction): said as a smooth follow, with the time constant
    const f = param(rec, 'friction'); const rate = rec.model.valid_at && rec.model.valid_at.refresh_hz;
    if (f && Number.isFinite(f.value) && f.value > 0 && f.value < 1 && rate) {
      const tau = { value: -(1000 / rate) / Math.log(f.value), label: f.label, ...(f.reason ? { reason: f.reason } : {}) };
      const a = { value: 1 - f.value, label: f.label };
      text = smoothingText(rec, { tau, alpha: a, rate, add, opts });
      return { kind: 'smoothing', family: fam, text, values, label: f.label };
    }
  }
  if (kind === 'spring') {
    const w = param(rec, 'omega'), z = param(rec, 'zeta'); const dv = rec.derived || {};
    if (!w || w.value == null || !z || z.value == null) { text = 'spring, parameters not identified [unknown]'; return { kind, family: fam, text, values, label: 'unknown' }; }
    const lab = w.label === 'fitted' && z.label === 'fitted' ? 'fitted' : 'unknown';
    const labWhy = lab === 'unknown' ? { reason: w.reason || z.reason || 'not identified' } : {};
    // overshoot as a share of the travel, from ζ (released from rest; derived.overshoot is in the channel's units)
    const ov = z.value < 1 ? Math.exp(-z.value * Math.PI / Math.sqrt(1 - z.value * z.value)) : 0;
    let settle = Number.isFinite(dv.settle99) ? dv.settle99 : null;
    if (settle == null) { try { settle = settleMs(springProgress(w.value, z.value, 0), 0.01, 20000); } catch { settle = null; } }
    const feel = z.value < 0.3 ? 'very bouncy' : z.value < 0.6 ? 'clearly bouncy' : z.value < 0.9 ? 'slightly bouncy' : z.value <= 1.05 ? 'no bounce (critically damped)' : 'no bounce, eases in slowly (overdamped)';
    // stiffness / damping are the fitter's own params k, c: the curve (ω, ζ) can be identified while the library value is
    // not (each integrator a library may use gives a different k, c for the same curve). Never derive them as "fitted".
    const kp = param(rec, 'k'), cp = param(rec, 'c');
    const kc = (p, fallback) => (p && p.value != null && p.label !== 'unknown' ? p
      : { value: p && p.value != null ? p.value : fallback, label: 'unknown', reason: `library value depends on the integrator${p && p.reason ? `: ${p.reason}` : ': not identified by the fitter'}` });
    const K = kc(kp, w.value * w.value), C = kc(cp, 2 * z.value * w.value);
    const bits = [`Spring, ${feel}${ov > 0.005 ? ` (overshoots ${add(val('overshoot', ov * 100, '%', lab, labWhy))})` : ''}`];
    if (settle != null) bits.push(`settles in ${add(val('settle', settle, 'ms', lab, labWhy))}`);
    bits.push(`ω ${add(pval('omega', w, 'rad/s'))}, ζ ${add(pval('zeta', z, null))}; stiffness ${add(pval('stiffness', K, null))}, damping ${add(pval('damping', C, null))}, mass 1`);
    // a preset is named only when k, c are identified; otherwise the closeness is below what the fit resolves
    const preset = springPreset(w.value, z.value);
    if (preset && K.label !== 'unknown' && C.label !== 'unknown') bits.push(`≈ ${preset.name} (k ${preset.k}, c ${preset.c}; within ${Math.max(0.1, +(preset.e * 100).toFixed(1))} %)`);
    else if (preset) bits.push(`close to ${preset.name} (k ${preset.k}, c ${preset.c}) [unknown: k, c not resolved finely enough to tell]`);
    if (rec.ambiguity && z.value >= 0.95) bits.push('spring or ease-out: they feel the same here');
    text = bits.join('; ');
    return { kind, family: fam, text, values, label: lab };
  }
  if (kind === 'tween') {
    const D = param(rec, 'D'); const parts = [];
    let ease;
    if (/^named:/.test(fam)) { const n = fam.slice(6); ease = `${n}${EASE_ALIAS[n] ? ` (= GSAP ${EASE_ALIAS[n]})` : ''}`; }
    else if (/^bezier/.test(fam)) { const b = ['x1', 'y1', 'x2', 'y2'].map((q) => param(rec, q)); ease = b.every((q) => q && q.value != null) ? `cubic-bezier(${b.map((q) => sig(q.value, 3)).join(', ')})` : 'a custom curve'; }
    const lab = D ? D.label : 'unknown';
    parts.push(`Tween, ${ease || fam} [${lab}]`);
    if (D && D.value != null) parts.push(add(pval('duration', D, 'ms')));
    if (rec.ambiguity && rec.tier !== 'unknown') parts.push('other curves fit as well [unknown]');
    text = parts.join(', ');
    return { kind, family: fam, text, values, label: lab };
  }
  if (kind === 'smoothing') {
    const tau = param(rec, 'tau_ms'); const a = param(rec, 'alpha_per_frame') || param(rec, 'alpha');
    const rate = rec.model.valid_at && rec.model.valid_at.refresh_hz;
    text = smoothingText(rec, { tau, alpha: a, rate, add, opts });
    return { kind, family: fam, text, values, label: tau ? tau.label : 'unknown' };
  }
  if (kind === 'asymmetric smoothing') {
    // one rate per direction; a rate pinned at 1 (a snap) or never exercised is not a parameter of the record
    const rate = rec.model.valid_at && rec.model.valid_at.refresh_hz; const dt = rate ? 1000 / rate : null;
    const dirs = [['alphaUp', 'rising'], ['alphaDown', 'falling']].map(([k, word]) => ({ k, word, a: param(rec, k), snap: !!(rec.model.pinned && rec.model.pinned[k] === 1) }));
    const seen = dirs.filter((d) => d.a && d.a.value != null && d.a.value < 1);
    if (seen.length === 1 && !dirs.some((d) => d.snap)) {
      // only one direction exercised: the same law as a one-rate smoothing (with the Lenis equivalence), the other
      // direction simply not measured. Run-to-run the fitter labels this take ema / dtdamp / asym; the sentence stays one.
      const d = seen[0]; const tauMs = dt ? -dt / Math.log(1 - d.a.value) : null;
      const tau = tauMs != null ? { value: tauMs, label: d.a.label, ...(d.a.reason ? { reason: d.a.reason } : {}) } : null;
      const other = dirs.find((x) => x !== d);
      text = smoothingText(rec, { tau, alpha: d.a, rate, add, opts }) + `; only ${d.word} values were seen, the ${other.word} direction ${add(unk(other.k, 'not exercised in this take'))}`;
      return { kind: 'smoothing', family: fam, text, values, label: d.a.label };
    }
    const follow = followWord(rec);
    const parts = [`Smooth follow of ${follow}, one rate per direction`];
    for (const d of dirs) {
      if (!d.a || d.a.value == null) { parts.push(`${d.word}: ${d.snap ? 'snaps (no smoothing) [fitted]' : `not identified ${add(unk(d.k, d.a && d.a.reason ? d.a.reason : 'not identified'))}`}`); continue; }
      const t = dt && d.a.value < 1 ? -dt / Math.log(1 - d.a.value) : null;
      parts.push(`${d.word}: closes ${add(pval(d.k, { ...d.a, value: d.a.value * 100 }, '%'))} of the gap per frame${t ? ` (time constant ${add(pval(d.k + '_tau', { ...d.a, value: t }, 'ms'))})` : ''}`);
    }
    text = parts.join(', ');
    return { kind, family: fam, text, values, label: values.length ? values[0].label : 'unknown' };
  }
  if (kind === 'scroll map') {
    const m = sampledMap(rec, rec.model.map || {}); const shape = m.shape || (/\(([^)]+)\)/.exec(fam || '') || [])[1] || 'unknown shape';
    // the values' label: the fitted line (mapA); a corner has its own (an unobserved one is [unknown])
    const lab = labelOf((rec.model.params.mapA || rec.model.params.mapS0 || {}).provenance || 'fitted');
    if (Number.isFinite(m.a) && Number.isFinite(m.b) && Number.isFinite(m.s0_px) && Number.isFinite(m.s1_px)) {
      const why = (n) => { const q = rec.model.params[n]; return q && q.reason ? { reason: q.reason } : {}; };
      // the map's driver (fitter: model.driver): the window scroll unless the wheel-delta sum or the pointer explains it
      const dk = rec.model.driver && rec.model.driver.kind; const dax = rec.model.driver && rec.model.driver.axis === 'y' ? 'y' : 'x';
      const [head, during] = dk === 'wheel' ? ['Wheel-linked (scrubbed)', 'while the wheel input sums'] : dk === 'pointer' ? ['Pointer-linked', `while the pointer ${dax} moves`] : ['Scroll-linked (scrubbed)', rec.model.driver && rec.model.driver.pageOwned ? 'while the page scrolls (the page moves its own scroll: the offset is already smoothed)' : 'while the page scrolls'];
      text = `${head}: ${channelWord(rec.target.channel)} ${add(val('from', m.a, null, lab, why('mapA')))} → ${add(val('to', m.a + m.b, null, lab, why('mapB')))} ${during} ${add(val('scrollStart', m.s0_px, 'px', labelOf(m.s0_provenance || 'fitted'), why('mapS0')))} → ${add(val('scrollEnd', m.s1_px, 'px', labelOf(m.s1_provenance || 'fitted'), why('mapS1')))}, ${shape}`;
    } else text = `Scroll-linked (scrubbed), ${shape} [${lab}]`;
    return { kind, family: fam, text, values, label: lab };
  }
  if (rec.class === 'restarted tween' && rec.model.ease) {
    // a tween toward the driver's mapped value, restarted from the current value on every driver change (ScrollTrigger's
    // scrub is this with expo.out: the scrub value is the tween length in seconds)
    const L = param(rec, 'L'); const dk = rec.model.driver && rec.model.driver.kind; const m = sampledMap(rec, rec.model.map || {});
    const parts = [`Scrubbed follow of ${followWord(rec)}: an ${rec.model.ease} tween${L && L.value != null ? ` of ${add(pval('restartMs', L, 'ms'))}` : ''} restarted from the current value on every change`];
    if (rec.model.ease === 'expo.out' && L && L.value != null && dk !== 'wheel' && dk !== 'pointer') parts.push(`= GSAP scrub ${add(pval('scrubSeconds', { ...L, value: L.value / 1000 }, 's'))}`);
    if ([m.a, m.b, m.s0_px, m.s1_px].every(Number.isFinite)) {
      // a value whose interval is not finite or wider than the map's own travel is not identified (a fast sweep lets the
      // map's corner and the driver lag trade off): [unknown] with the reason, the number kept as the best fit
      const span = Math.abs(m.b) || 1;
      const lab = (pname, prov) => { const q = rec.model.params[pname]; const ci = q && q.ci95;
        return !ci || ![ci[0], ci[1]].every(Number.isFinite) || ci[1] - ci[0] > (/S[01]$/.test(pname) ? Math.abs(m.s1_px - m.s0_px) || 1 : span) ? 'unknown' : labelOf(prov || 'fitted'); };
      const why = { reason: 'not identified: on a fast sweep the map corner and the driver lag trade off (interval wider than the travel)' };
      const v = (name, value, unit, pname, prov) => { const l = lab(pname, prov); return val(name, value, unit, l, l === 'unknown' ? why : {}); };
      parts.push(`${channelWord(rec.target.channel)} ${add(v('from', m.a, null, 'mapA'))} → ${add(v('to', m.a + m.b, null, 'mapB'))} over the scroll ${add(v('scrollStart', m.s0_px, 'px', 'mapS0', m.s0_provenance))} → ${add(v('scrollEnd', m.s1_px, 'px', 'mapS1', m.s1_provenance))}, ${m.shape || 'unknown shape'}`);
    }
    // a scrubbed timeline (fitter: model.scrub): the smoothing runs on the progress of the whole trigger range, and this
    // motion is the part of it between its own corners; a range edge equal to the corner is not repeated
    const sc = rec.model.scrub;
    if (sc && sc.kind === 'scrubbed timeline' && Array.isArray(sc.range_px) && (sc.range_provenance || []).some((p) => p !== 'the map corner')) {
      const edge = (name, i) => { const p = sc.range_provenance[i]; return p === 'the map corner' ? null : add(val(name, sc.range_px[i], 'px', p === 'fitted' ? 'fitted' : 'unknown', p === 'fitted' ? {} : { reason: 'the scroll did not pass this edge of the trigger range' })); };
      const a = edge('triggerStart', 0), b = edge('triggerEnd', 1);
      parts.push(`part of a scrubbed timeline whose scroll range ${a && b ? `runs ${a} → ${b}` : a ? `starts at ${a}` : `ends at ${b}`} (the smoothing runs on that range's progress)`);
    }
    if (sc && sc.shared) parts.push('same scrubbed progress as another motion on this page');
    text = parts.join(', ');
    return { kind: 'restarted tween', family: fam, text, values, label: L ? L.label : 'fitted' };
  }
  if (kind === 'pin') {
    const p = rec.model.pin || {};
    const pv = (n, q) => val(n, q && q.value, 'px', q && q.value != null ? labelOf(q.provenance || 'fitted') : 'unknown', { reason: (q && q.reason) || 'the pin edge was not reached in this take' });
    text = `Pinned: held in place while the page scrolls ${add(pv('pinStart', p.start))} → ${add(pv('pinEnd', p.end))}`;
    return { kind, family: fam, text, values, label: 'fitted' };
  }
  if (rec.class === 'step') {
    const b = param(rec, 'before'), a = param(rec, 'after'), at = param(rec, 'at');
    const onPtr = rec.model.driver && rec.model.driver.kind === 'pointer';
    text = `Instant change${onPtr ? ' when the pointer arrives' : ''}${b && a ? `: ${sig(b.value)} → ${sig(a.value)} [${a.label}]` : ''}${at && at.value != null ? ` at ${add(pval('at', at, 'ms'))}` : ''}`;
    return { kind: 'step', family: fam, text, values, label: 'fitted' };
  }
  if (rec.class === 'ramp') { const D = param(rec, 'D'); text = `Linear ramp${D && D.value != null ? `, ${add(pval('duration', D, 'ms'))}` : ''}`; return { kind: 'ramp', family: fam, text, values, label: D ? D.label : 'fitted' }; }
  if (/periodic/.test(rec.class || fam || '')) { const P = param(rec, 'period'); text = `Repeats${P && P.value != null ? ` every ${add(pval('period', P, 'ms'))}` : ''}`; return { kind: 'periodic', family: fam, text, values, label: P ? P.label : 'fitted' }; }
  text = `${rec.class || 'motion'}: ${fam || 'no family'} [${rec.tier === 'fitted' ? 'fitted' : 'unknown'}]`;
  return { kind: rec.class || 'other', family: fam, text, values, label: rec.tier === 'fitted' ? 'fitted' : 'unknown' };
}

/**
 * Records of one element -> lines, one per distinct motion. Records whose sentence matches to 2 significant digits are
 * one line (several channels of one motion, or one motion the segmenter cut in two); `times` counts the onsets.
 */
export function describeElement(records, { fallbackTrigger = null, oneRate = null } = {}) {
  const groups = new Map();
  for (const r of records) {
    const d = describeRecord(r, { oneRate });
    const t0 = r.derived && Number.isFinite(r.derived.t0) ? r.derived.t0 : null;
    const key = `${d.kind}|${d.family}|${d.text.replace(/^[^,:]*/, '').replace(/-?\d+(\.\d+)?(e-?\d+)?/g, (m) => String(+(+m).toPrecision(2)))}`;
    // declared and scroll-map lines name their channel in the text; merge only when the text matches exactly
    const k2 = d.kind === 'declared' || d.kind === 'scroll map' ? `${key}|${r.target.channel}|${t0 != null ? Math.round(t0 / 10) : 'x'}` : key;
    const g = groups.get(k2) || { ...d, channels: [], onsets: [], t0, trigger: trigger(r) || (fallbackTrigger && t0 != null ? fallbackTrigger(t0) : null), attribution: r.attribution || null };
    g.channels.push(r.target.channel); if (t0 != null && !g.onsets.some((x) => Math.abs(x - t0) < 20)) g.onsets.push(t0);
    if (t0 != null && (g.t0 == null || t0 < g.t0)) g.t0 = t0;
    groups.set(k2, g);
  }
  for (const g of groups.values()) g.times = Math.max(1, g.onsets.length);
  // collapse declared lines of one transition (same timing, several channels) into one
  const out = []; const declBy = new Map();
  for (const g of groups.values()) {
    if (g.kind !== 'declared') { out.push(g); continue; }
    const k = `${g.head}|${g.t0 != null ? Math.round(g.t0) : 'x'}`;
    const h = declBy.get(k); if (!h) { declBy.set(k, g); out.push(g); continue; }
    h.channels.push(...g.channels); h.values.push(...g.values.filter((v) => !h.values.some((q) => q.name === v.name))); h.travels.push(...g.travels);
  }
  for (const g of out) if (g.kind === 'declared') {
    // scale x and scale y with the same travel read as one "scale"
    const t = g.travels; const sx = t.find((x) => x.startsWith('scale x ')), sy = t.find((x) => x.startsWith('scale y '));
    const travels = sx && sy && sx.slice(8) === sy.slice(8) ? [...t.filter((x) => x !== sx && x !== sy), `scale ${sx.slice(8)}`] : t;
    g.text = travels.length ? `${g.head}, ${travels.join(', ')}` : g.head;
  }
  return out.sort((a, b) => (a.t0 ?? Infinity) - (b.t0 ?? Infinity));
}

/** Stagger group -> line. `count` = elements in the folded group; members are counted as distinct elements of it. */
export function describeStagger(g, count) {
  const iv = g.interval || {}; const lab = labelOf(iv.provenance);
  const dir = g.direction && g.direction.value ? `, in ${g.direction.value} order` : g.direction && g.direction.reason ? ', order unknown' : '';
  const step = g.constantStep ? 'constant step' : `steps vary (residual ${sig(g.residual_ms, 2)} ms)`;
  const n = Math.min(count, new Set((g.members || []).map((m) => String(m).split('|')[0])).size);
  const v = val('interval', iv.value, 'ms', lab, lab === 'unknown' ? { residual_ms: g.residual_ms, reason: (g.direction && g.direction.reason) || iv.reason || 'not identified' } : { residual_ms: g.residual_ms });
  const why = lab === 'unknown' ? ` (unknown: ${v.reason})` : '';
  return { kind: 'stagger', n, text: `Stagger: ${n} of ${count} start one after another, every ${v.text}, ${step}${dir}${why}`, values: [v], label: lab };
}
