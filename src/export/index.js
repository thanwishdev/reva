// REVA export layer: fitted motion model -> code for CSS / GSAP / Motion / Lenis / rAF / react-spring.
// Every emitted snippet carries an accuracy label computed numerically by sampling the emitted curve (as the
// library would evaluate it) against the fitted curve. Distances are normalised to the travel (feel, not geometry).
import { springProgress, emaProgress, settleMs, maxError, accuracy, notRepresentable, round, sig, buildLinear, customEasePath } from './curves.js';
import { parseEasing, canonicalEasing, effectiveEasing } from '../analysis/fit/eases.js';
import { formValue } from '../analysis/fit/series.js';
import { CONTROL_CHARS } from '../report/untrusted.js';
import { NAMED, cubicBezier, EASINGS_NET_BEZIER, gsapEase, gsapNameFor, pennerSource, evalSource, shapeFn } from './eases.js';
import { schemaKind } from '../util/schema.js';

export const LIBS = ['css', 'gsap', 'motion', 'lenis', 'raf', 'react-spring'];
const CSS_MAX_ERR = 0.01;   // linear() budget: 1 % of travel

// ---------- record helpers ----------

/** Param value; falls back to `withheld_value` (value withheld for lack of a finite CI) and says so. */
function param(rec, name) {
  const p = rec.model && rec.model.params && rec.model.params[name];
  if (!p) return { value: null };
  if (p.value != null) return { value: p.value, provenance: p.provenance };
  if (p.withheld_value != null) return { value: p.withheld_value, withheld: true, reason: p.reason };
  return { value: null, reason: p.reason };
}

/** A named hole (FROM / TO / VALUE) stays bare inside a CSS function: `translateY(FROM)`, never `translateY(FROMpx)`. */
const isHole = (v) => /^[A-Z]+$/.test(String(v));
const u = (v, unit) => (isHole(v) ? String(v) : `${v}${unit}`);
/** Channel -> property names per library. Box channels (ren:bx/by/bw/bh) are layout-derived; exported as translate / size. */
const CHANNEL = {
  tx: { css: 'transform', gsap: 'x', motion: 'x', fn: (v) => `translateX(${u(v, 'px')})` },
  ty: { css: 'transform', gsap: 'y', motion: 'y', fn: (v) => `translateY(${u(v, 'px')})` },
  tz: { css: 'transform', gsap: 'z', motion: 'z', fn: (v) => `translateZ(${u(v, 'px')})` },
  bx: { css: 'transform', gsap: 'x', motion: 'x', fn: (v) => `translateX(${u(v, 'px')})`, note: 'box-x channel (layout position) exported as translateX' },
  by: { css: 'transform', gsap: 'y', motion: 'y', fn: (v) => `translateY(${u(v, 'px')})`, note: 'box-y channel (layout position) exported as translateY' },
  bw: { css: 'width', gsap: 'width', motion: 'width', fn: (v) => u(v, 'px'), note: 'box-width channel (layout size) exported as width' },
  bh: { css: 'height', gsap: 'height', motion: 'height', fn: (v) => u(v, 'px'), note: 'box-height channel (layout size) exported as height' },
  rz: { css: 'transform', gsap: 'rotation', motion: 'rotate', fn: (v) => `rotate(${u(v, 'deg')})` },
  skx: { css: 'transform', gsap: 'skewX', motion: 'skewX', fn: (v) => `skewX(${u(v, 'deg')})` },
  sky: { css: 'transform', gsap: 'skewY', motion: 'skewY', fn: (v) => `skewY(${u(v, 'deg')})` },
  sx: { css: 'transform', gsap: 'scaleX', motion: 'scaleX', fn: (v) => `scaleX(${v})` },
  sy: { css: 'transform', gsap: 'scaleY', motion: 'scaleY', fn: (v) => `scaleY(${v})` },
  s: { css: 'transform', gsap: 'scale', motion: 'scale', fn: (v) => `scale(${v})` },
  radius: { css: 'border-top-left-radius', gsap: 'borderTopLeftRadius', motion: 'borderTopLeftRadius', fn: (v) => u(v, 'px'), note: 'radius channel is the top-left corner radius (border-top-left-radius)' },
  opacity: { css: 'opacity', gsap: 'opacity', motion: 'opacity', fn: (v) => `${v}` },
};
/** Recorded channel names that ARE a CSS property of the same name (the recorder's ren:/drv: names outside CHANNEL). */
const SAME_NAME = new Set(['transform', 'translate', 'scale', 'rotate', 'filter', 'clipPath']);
/**
 * Property names of a channel per library, or {unmapped} when the channel names no animatable property (a component of a
 * compound value, or a recorder channel with no property of that name): the export never invents a property name.
 */
export function channelProps(channel, form) {
  const [, name] = String(channel || '').split(':');
  if (CHANNEL[name]) return CHANNEL[name];
  const p = namedProps(name);
  if (p.css == null || p.css.startsWith('--')) return p;
  // a CSS property recorded as a string (filter: blur(16px)): the number goes back into its recorded form, as a string
  // in JS; without a known form the property cannot be written (a bare `filter: 16` is not CSS)
  if (form && typeof form === 'object') { const fn = (v) => (isHole(v) ? (form.fn ? `${form.fn}(${v})` : String(v)) : formValue(form, v)); return { ...p, fn, js: (v) => JSON.stringify(fn(v)), form }; }
  return { css: null, gsap: null, motion: null, fn: (v) => `${v}`, noform: p.css };
}
const jsv = (props, v) => (props.js ? props.js(v) : v);
/** The value for GSAP: its own writer when the property differs from the CSS one (yPercent takes a bare number). */
const jsvG = (props, v) => (props.gsapJs ? props.gsapJs(v) : jsv(props, v));
function namedProps(name) {
  const raw = name || 'value';   // drv:<css property>, or a ren:<camelCase> property
  // one component of a compound value (clipPath.bottom: one inset of clip-path) has no property of its own
  if (!/^(--[\w-]+|[a-zA-Z][a-zA-Z0-9-]*)$/.test(raw)) return { css: null, gsap: null, motion: null, fn: (v) => `${v}`, part: raw };
  if (!raw.startsWith('--') && !SAME_NAME.has(raw)) return { css: null, gsap: null, motion: null, fn: (v) => `${v}`, unmapped: raw };
  const css = raw.startsWith('--') ? raw : raw.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  // a JS object key: camelCase (clipPath; `clip-path` unquoted would not parse), a custom property quoted
  const js = css.startsWith('--') ? `"${css}"` : css.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return { css, gsap: js, motion: js, fn: (v) => `${v}` };
}
/**
 * CSS for a transition from one state to the other: the start state with the transition on the element, the end state in
 * a class added to play it. Both values are written out (a named hole when unmeasured), so the travel is in the snippet.
 */
/**
 * `@property` registration for a custom property: an unregistered one does not interpolate (a transition on it flips at
 * the end). The syntax follows the value's form; '' for a normal property or a form with no interpolable syntax.
 */
export function propertyRule(prop, sample) {
  if (!String(prop || '').startsWith('--')) return '';
  const v = String(sample).trim();
  const syntax = /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i.test(v) ? '<number>' : /^-?[\d.]+px$/.test(v) ? '<length>'
    : /^-?[\d.]+(deg|rad|turn)$/.test(v) ? '<angle>' : /^-?[\d.]+%$/.test(v) ? '<percentage>' : null;
  return syntax ? `@property ${prop} { syntax: '${syntax}'; inherits: false; initial-value: ${v}; }\n` : '';
}
function cssStates(props, from, to, timing) {
  const st = (v, h) => props.fn(fmt(v, 3, h));
  return `${propertyRule(props.css, st(from, 'FROM'))}.el { ${props.css}: ${st(from, 'FROM')}; transition: ${props.css} ${timing}; }\n.el.to { ${props.css}: ${st(to, 'TO')}; }`;
}
/** The parts of a css state snippet, for joining the channels of one motion into one rule (combineCss). */
function cssDecl(props, from, to, timing, delayMs = 0) {
  const st = (v, h) => props.fn(fmt(v, 3, h));
  return { prop: props.css, from: st(from, 'FROM'), to: st(to, 'TO'), timing, delayMs, pre: propertyRule(props.css, st(from, 'FROM')) };
}
/** A declared delay in ms (CSS transition-delay / animation-delay, WAAPI delay), or 0. */
function declaredDelay(rec) {
  const fam = rec.model && rec.model.family; if (fam !== 'declared:css' && fam !== 'declared:waapi') return 0;
  const d = param(rec, 'delay').value; return Number.isFinite(d) && d >= 1 ? round(d, 1) : 0;
}
/** Order of transform functions in a composed transform: translate, rotate, skew, scale (the decomposition order). */
const TF_ORDER = ['translate', 'rotate', 'skew', 'scale'];
const tfRank = (f) => { const i = TF_ORDER.findIndex((n) => String(f).startsWith(n)); return i < 0 ? TF_ORDER.length : i; };
/**
 * One CSS rule per element for the channels of one motion: each property set once, one composed transform, and one
 * transition list (a later `transition` would override an earlier one, and a later `transform` would replace the other
 * functions, so pasting per-channel snippets together animates one property only). parts: [{el, id, decl, delayMs}].
 * Returns {code} or {why} when the channels cannot share one rule (two motions on one property, or transform functions
 * with different timings: one transform property has one timing).
 */
export function combineCss(parts) {
  const byEl = new Map(); for (const p of parts) { if (!byEl.has(p.el)) byEl.set(p.el, []); byEl.get(p.el).push(p); }
  const rules = []; const els = [...byEl.keys()];
  // the authored delay (declared channels) of the channel that starts first is the base; the measured offsets add to it
  const first = parts.reduce((a, p) => (!a || (p.delayMs || 0) < (a.delayMs || 0) ? p : a), null);
  const base = (first && first.decl.delayMs) || 0;
  const pre = [...new Set(parts.map((p) => p.decl.pre).filter(Boolean))];
  for (const [i, el] of els.entries()) {
    const ps = byEl.get(el); const sel = els.length > 1 ? `.el-${i + 1}` : '.el';
    const props = new Map(); const tf = [];
    for (const p of ps) {
      const dl = base + (p.delayMs || 0); const timing = `${p.decl.timing}${dl >= 1 ? ` ${round(dl, 1)}ms` : ''}`;
      if (p.decl.prop === 'transform') { tf.push({ ...p, timing }); continue; }
      if (props.has(p.decl.prop)) return { why: `${props.get(p.decl.prop).id} and ${p.id} both animate ${p.decl.prop} (two motions in a row on one property): export them by channel id` };
      props.set(p.decl.prop, { ...p, timing });
    }
    // a declared whole transform (several functions in one declaration) is written once; the channels it covers carry
    // the same value, so their parts are one part
    const wholes = tf.filter((p) => p.decl.whole);
    if (wholes.length) {
      const w = wholes[0]; const key = (p) => `${p.decl.from}|${p.decl.to}|${p.timing}`;
      const other = tf.find((p) => !p.decl.whole || key(p) !== key(w));
      if (other) return { why: `${w.id} runs the whole declared transform (${w.decl.to}) and ${other.id} another transform: export them by channel id` };
      tf.splice(0, tf.length, { ...w, id: wholes.map((p) => p.id).join(' + ') });
    }
    if (tf.length) {
      const t0 = tf[0].timing; const odd = tf.find((p) => p.timing !== t0);
      if (odd) return { why: `the transform channels run with different timings (${tf[0].id}: ${t0}; ${odd.id}: ${odd.timing}); one transform property has one timing: export them by channel id` };
      const fns = new Set(); for (const p of tf) { const f = String(p.decl.from).replace(/\(.*$/, ''); if (fns.has(f)) return { why: `${p.id} repeats the transform function ${f}: export by channel id` }; fns.add(f); }
      const sorted = [...tf].sort((a, b) => tfRank(a.decl.from) - tfRank(b.decl.from));
      props.set('transform', { id: tf.map((p) => p.id).join(' + '), decl: { prop: 'transform', from: sorted.map((p) => p.decl.from).join(' '), to: sorted.map((p) => p.decl.to).join(' ') }, timing: t0 });
    }
    const list = [...props.values()];
    rules.push(`${els.length > 1 ? `/* ${sel}: ${ps.map((p) => p.id).join(', ')} */\n` : ''}${sel} { ${list.map((p) => `${p.decl.prop}: ${p.decl.from};`).join(' ')} transition: ${list.map((p) => `${p.decl.prop} ${p.timing}`).join(', ')}; }\n${sel}.to { ${list.map((p) => `${p.decl.prop}: ${p.decl.to};`).join(' ')} }`);
  }
  return { code: pre.join('') + rules.join('\n') };
}
/** Channel props of a record, with the recorded value form of a string channel (fitter: target.form). */
const propsOf = (rec) => channelProps(rec.target && rec.target.channel, rec.target && rec.target.form);
/** Libraries whose snippet names the animated property (lenis and the rAF follower only produce a number). */
const NAMES_PROP = new Set(['css', 'gsap', 'motion', 'react-spring']);

// page text in a code comment: no comment close, no line breaks, no terminal escapes or bidi overrides (CONTROL_CHARS), and
// no markup: `</script>` or `<!--` inside a JS comment still closes an inline <script> when the snippet is pasted into HTML,
// so < and > become ‹ › (as cleanText does)
const sanitize = (s, n = 80) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(CONTROL_CHARS, '').replace(/\*\//g, '* /').replace(/</g, '‹').replace(/>/g, '›').slice(0, n);
/** `/* REVA: measured from <url> <element> <take>, <date> *\/` from the record and the run metadata. */
export function sourceComment(rec, meta = {}) {
  const t = rec.target || {}; const take = (rec.evidence && rec.evidence.takes && rec.evidence.takes[0]) || meta.take || '?';
  return `/* REVA: measured from ${sanitize(meta.url || 'unknown-url', 200)} ${sanitize(t.desc || `el ${t.el}`)} [${sanitize(t.channel, 40)}] take ${sanitize(take, 40)}${meta.takeName ? ` (${sanitize(meta.takeName, 40)})` : ''}, ${sanitize(meta.date || 'unknown-date', 30)} */`;
}

// an unmeasured start / end value is a named placeholder (FROM / TO): the snippet still parses, and running it
// without defining the name fails loudly instead of animating to a made-up value
const fmt = (x, d = 3, hole = 'VALUE') => (x == null || !Number.isFinite(x) ? hole : String(round(x, d)));
const HOLES = /\b(FROM|TO|VALUE)\b/g;
const out = (lib, code, acc, extra = {}) => ({ lib, code, accuracy: acc, ...extra });

// ---------- spring ----------

/** react-spring v9 stepping: semi-implicit Euler with 1 ms sub-steps (tension·1e-6, friction·1e-3 per ms units). */
function reactSpringProgress(tension, friction, v0n) {
  const cache = [0]; let x = 0, v = v0n / 1000;
  return (tMs) => {
    const n = Math.floor(tMs);
    while (cache.length <= n + 1) { const a = -tension * 1e-6 * (x - 1) - friction * 1e-3 * v; v += a; x += v; cache.push(x); }
    const f = tMs - n; return f ? cache[n] + (cache[Math.min(n + 1, cache.length - 1)] - cache[n]) * f : cache[n];
  };
}

function exportSpring(rec, libs) {
  const omega = param(rec, 'omega'), zeta = param(rec, 'zeta'), v0 = param(rec, 'v0'), x0 = param(rec, 'x0'), target = param(rec, 'target');
  if (omega.value == null || zeta.value == null) return { skipped: 'spring without ω/ζ' };
  const w = omega.value, z = zeta.value, travel = x0.value != null && target.value != null ? target.value - x0.value : null;
  const notes = [];
  for (const [k, p] of Object.entries({ v0, x0 })) if (p.withheld) notes.push(`${k} uses the withheld fit value (no finite CI)`);
  let v0n = 0;
  if (v0.value != null && travel) v0n = v0.value / travel; else if (v0.value) notes.push('v0 dropped: travel unknown');
  const integ = rec.model.integrator;
  if (rec.model.law === 'per-frame') notes.push('fitted law is per-frame (frame-rate dependent); exports use the time-based spring at the recorded rate');
  if (integ && integ.identified === false) notes.push('integrator not identified; reference curve is the analytic spring from ω, ζ');
  const ref = springProgress(w, z, v0n);
  const T = settleMs(ref, 0.001, 20001);
  const span = Math.min(T, 20000) * 1.5;
  const props = propsOf(rec);
  const from = x0.value, to = target.value;
  const res = [];

  if (libs.has('motion')) {
    const k = sig(w * w), c = sig(2 * z * w), vel = sig(v0.value || 0);
    const em = springProgress(Math.sqrt(k), c / (2 * Math.sqrt(k)), travel ? vel / travel : 0);
    res.push(out('motion', `animate(el, { ${props.motion}: [${jsv(props, fmt(from, 3, 'FROM'))}, ${jsv(props, fmt(to, 3, 'TO'))}] }, { type: "spring", stiffness: ${k}, damping: ${c}, mass: 1, velocity: ${vel} })`,
      accuracy(maxError(ref, em, span)), { form: 'physics' }));
    if (z >= 0.05 && z <= 1) {
      const vd = round((2 * Math.PI) / (1.2 * w), 3), bounce = round(1 - z, 3);
      const w2 = (2 * Math.PI) / (vd * 1.2), z2 = Math.min(1, Math.max(0.05, 1 - bounce));
      const em2 = springProgress(w2, z2, 0);   // duration form: no velocity carry-over
      res.push(out('motion', `animate(el, { ${props.motion}: [${jsv(props, fmt(from, 3, 'FROM'))}, ${jsv(props, fmt(to, 3, 'TO'))}] }, { type: "spring", visualDuration: ${vd}, bounce: ${bounce} })`,
        accuracy(maxError(ref, em2, span)), { form: 'duration', note: v0n ? 'duration form drops the initial velocity' : undefined }));
    } else res.push(out('motion', null, notRepresentable('motion (duration form)', `ζ = ${round(z, 3)} outside 0.05..1; use the physics form`), { form: 'duration' }));
  }
  const SETTLE_CAP = 20000;
  if ((libs.has('css') || libs.has('gsap')) && T > SETTLE_CAP) {
    const why = `does not settle (1 ‰) within ${SETTLE_CAP / 1000} s (ζ = ${round(z, 4)}, ω = ${round(w, 3)}): a sampled curve would end in a jump${z <= 0.0051 || z >= 9.99 ? '; ζ sits at the fitter bound, check the fit' : ''}`;
    for (const l of ['css', 'gsap']) if (libs.has(l)) res.push(out(l, null, notRepresentable(l, why)));
  } else if (libs.has('css') || libs.has('gsap')) {
    const lin = buildLinear(ref, T, CSS_MAX_ERR);
    const acc = accuracy(lin.err);
    const caveat = 'sampled curve: velocity on interrupt / retarget is not reproduced';
    if (libs.has('css')) res.push(out('css', cssStates(props, from, to, `${T}ms ${lin.css}`), acc, { stops: lin.stops.length, note: caveat, decl: cssDecl(props, from, to, `${T}ms ${lin.css}`) }));
    if (libs.has('gsap')) {
      // CustomEase draws the same polyline as linear() (straight cubic segments): same stops, same measured error.
      res.push(out('gsap', `gsap.registerPlugin(CustomEase);\ngsap.fromTo(el, { ${props.gsap}: ${jsv(props, fmt(from, 3, 'FROM'))} }, { ${props.gsap}: ${jsv(props, fmt(to, 3, 'TO'))}, duration: ${round(T / 1000, 3)}, ease: CustomEase.create("reva-spring", "${customEasePath(lin.stops)}") });`, acc, { note: caveat }));
    }
  }
  if (libs.has('react-spring')) {
    const k = round(w * w, 2), c = round(2 * z * w, 3);
    res.push(out('react-spring', `useSpring({ from: { ${props.motion}: ${jsv(props, fmt(from, 3, 'FROM'))} }, to: { ${props.motion}: ${jsv(props, fmt(to, 3, 'TO'))} }, config: { tension: ${k}, friction: ${c}, mass: 1, velocity: ${fmt(v0n / 1000, 5)} } })`,
      accuracy(maxError(ref, reactSpringProgress(k, c, v0n), span)), { note: 'react-spring steps semi-implicit Euler at 1 ms; error measured against that stepper' }));
  }
  for (const l of ['lenis', 'raf']) if (libs.has(l)) res.push(out(l, null, notRepresentable(l, 'spring is second-order; use Motion physics form')));
  return { kind: 'spring', model: { omega: round(w, 4), zeta: round(z, 4), v0n: round(v0n, 4), settle_ms: T }, notes, exports: res };
}

// ---------- tween (bezier / named / declared) ----------

function bezierParams(rec) {
  const b = rec.model.bezier || ['x1', 'y1', 'x2', 'y2'].map((n) => param(rec, n).value);
  return b.every(Number.isFinite) ? b : null;
}

/**
 * The easing a declared record runs, in canonical CSS form: from its births (effect easing and keyframe easings, so a CSS
 * animation whose timing function sits on its keyframes is not read as linear), else its easing param. {easing, why}:
 * easing null when no single canonical curve describes it (per-segment easings, or text outside the CSS grammar).
 */
export function declaredEasing(rec) {
  const bs = rec.declared && rec.declared.births; const b0 = Array.isArray(bs) ? bs[0] : bs && Array.isArray(bs.first) ? bs.first[0] : null;
  if (b0 && Array.isArray(b0.keyframes) && b0.keyframes.length >= 2) { const ee = effectiveEasing(b0.easing, b0.keyframes); return { easing: ee.easing, why: ee.why || null, source: ee.source, segments: ee.segments || null }; }
  const p = param(rec, 'easing').value; if (p == null) return { easing: null, why: (rec.model.params.easing && rec.model.params.easing.reason) || 'no declared easing' };
  const c = canonicalEasing(String(p)); return c ? { easing: c, why: null, source: 'effect' } : { easing: null, why: 'the declared easing is not a CSS easing' };
}

// a declared transform keyframe value, rebuilt from parsed parts: only allowlisted transform functions with numeric
// arguments (and CSS units) pass, so page text never lands in generated code
const TF_NAMES = ['translate', 'translateX', 'translateY', 'translateZ', 'translate3d', 'scale', 'scaleX', 'scaleY', 'scaleZ', 'scale3d',
  'rotate', 'rotateX', 'rotateY', 'rotateZ', 'rotate3d', 'skew', 'skewX', 'skewY', 'matrix', 'matrix3d', 'perspective'];
const TF_CASE = new Map(TF_NAMES.map((n) => [n.toLowerCase(), n]));
const TF_ARG = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(px|%|deg|rad|turn|grad|em|rem|vw|vh|vmin|vmax)?$/i;
/** A CSS transform value in canonical form ('none' or allowlisted functions with numeric arguments), else null. */
export function canonicalTransform(value) {
  const v = String(value ?? '').trim();
  if (v === 'none') return 'none';
  if (!v || v.length > 600) return null;
  const re = /([a-zA-Z0-9]+)\(([^()]*)\)\s*/y; const fns = [];
  for (let pos = 0; pos < v.length;) {
    re.lastIndex = pos; const m = re.exec(v); if (!m) return null; pos = re.lastIndex;
    const name = TF_CASE.get(m[1].toLowerCase()); if (!name) return null;
    const args = m[2].split(',').map((a) => a.trim());
    const parts = args.map((a) => TF_ARG.exec(a)); if (!args.length || parts.some((x) => !x)) return null;
    fns.push(`${name}(${parts.map((x) => `${round(Number(x[1]), 4)}${(x[2] || '').toLowerCase()}`).join(', ')})`);
  }
  return fns.length ? fns.join(' ') : null;
}
/**
 * The whole transform a declared transition / animation runs, when it is composed of several functions
 * (translateY(-8px) scale(1.03)), or of a function other than the channel's own (scale on scaleX, a matrix): {from, to}
 * in canonical form, else null. A per-channel export of such a declaration
 * would write one function only (scale) and drop the others; the export writes the declared value as a whole instead.
 * Two-keyframe effects only (a transition, or an animation from 0 to 1): more keyframes are not one transition.
 */
export function declaredTransform(rec, ownFn = null) {
  const bs = rec && rec.declared && rec.declared.births; const b0 = Array.isArray(bs) ? bs[0] : bs && Array.isArray(bs.first) ? bs.first[0] : null;
  const kf = b0 && Array.isArray(b0.keyframes) ? b0.keyframes : null;
  if (!kf || kf.length !== 2 || typeof kf[0].transform !== 'string' || typeof kf[1].transform !== 'string') return null;
  const from = canonicalTransform(kf[0].transform); const to = canonicalTransform(kf[1].transform);
  if (!from || !to) return null;
  // the per-channel export is the declaration only when it is this channel's own single function (translateY on ty);
  // anything else (several functions, scale on scaleX, a matrix) is written whole
  const names = new Set([from, to].filter((t) => t !== 'none').flatMap((t) => t.split(') ').map((f) => f.replace(/\(.*$/, ''))));
  if (!names.size) return null;
  return names.size > 1 || ![...names][0] || [...names][0] !== ownFn ? { from, to } : null;
}

function exportTween(rec, libs) {
  const fam = rec.model.family; const notes = [];
  let ref, D, name = null, bez = null, declared = null;
  if (fam === 'bezier' || fam.startsWith('bezier ')) { bez = bezierParams(rec); if (!bez) return { skipped: 'bezier without control points' }; ref = cubicBezier(...bez); D = param(rec, 'D').value; }
  else if (fam.startsWith('named:')) { name = rec.model.ease || fam.slice(6); if (!NAMED[name]) return { skipped: `unknown named ease ${name}` }; ref = NAMED[name].fn; D = param(rec, 'D').value; if (NAMED[name].kind === 'css') bez = NAMED[name].bezier; }
  else if (fam === 'declared:css' || fam === 'declared:waapi') {
    // only the canonical form (rebuilt from parsed numbers) is emitted: the string was read where page script runs
    const de = declaredEasing(rec); declared = de.easing; D = param(rec, 'duration').value;
    if (!declared) return { skipped: `declared easing not reproducible as one CSS curve: ${de.why}${de.segments ? ` (${de.segments.join(' | ')})` : ''}` };
    if (de.source === 'keyframes') notes.push('easing from the keyframes (animation-timing-function); the effect easing is linear');
    const n = NAMED[declared]; if (n && n.kind === 'css') { bez = n.bezier; ref = n.fn; }
    else { const m = /^cubic-bezier\(([^)]+)\)$/.exec(declared); if (m) { bez = m[1].split(',').map(Number); ref = cubicBezier(...bez); } else { ref = parseEasing(declared); if (!ref) return { skipped: 'declared easing not mapped' }; } }
  } else return { skipped: `family ${fam}` };
  if (!Number.isFinite(D) || D <= 0) return { skipped: 'tween without duration' };
  D = round(D, 1);
  const refT = (t) => ref(Math.min(1, Math.max(0, t / D)));
  const errT = (fn) => maxError(refT, (t) => fn(Math.min(1, Math.max(0, t / D))), D);
  let props = propsOf(rec);
  let kv = param(rec, 'keyframeValues').value; let to = kv ? kv[kv.length - 1] : param(rec, 'to').value; let from = kv ? kv[0] : param(rec, 'from').value;
  // a declared transform of several functions: every library writes the declared value as a whole (from and to are
  // left unset, so the value formatter's FROM / TO slots take the two canonical strings)
  const whole = declared && props.css === 'transform' ? declaredTransform(rec, String(props.fn(1)).replace(/\(.*$/, '')) : null;
  if (whole) {
    const fn = (h) => (h === 'FROM' ? whole.from : h === 'TO' ? whole.to : h);
    props = { css: 'transform', gsap: 'transform', motion: 'transform', fn, js: (h) => JSON.stringify(fn(h)) };
    from = null; to = null; kv = null;
    notes.push(`the whole declared transform (${whole.to}), not this channel alone: one transform runs all its functions`);
  }
  // a translation the page declares in a relative unit (translateY(20%)) is written in that unit with the declared numbers:
  // the px it came to holds for this element's size only (GSAP: xPercent / yPercent for %, a unit string otherwise)
  const kvp = rec.model.params && rec.model.params.keyframeValues; const chn = String(rec.target && rec.target.channel || '').replace(/^(ren|drv):/, '');
  const relU = !whole && kvp && kvp.declaredUnit && Array.isArray(kvp.declaredValues) && /^t[xy]$/.test(chn) && kvp.declaredValues.length >= 2
    && kvp.declaredValues.every((x) => Number.isFinite(x)) && /^[a-z%]{1,6}$/.test(kvp.declaredUnit) ? kvp.declaredUnit : null;
  if (relU) {
    const px = [from, to]; from = kvp.declaredValues[0]; to = kvp.declaredValues.at(-1); kv = null;
    const fnName = chn === 'tx' ? 'translateX' : 'translateY'; const str = (v) => (isHole(v) ? String(v) : `${v}${relU}`);
    props = { ...props, fn: (v) => `${fnName}(${u(v, relU)})`, js: (v) => JSON.stringify(str(v)), ...(relU === '%' ? { gsap: chn === 'tx' ? 'xPercent' : 'yPercent', gsapJs: (v) => v } : {}) };
    notes.push(`declared in ${relU}: ${fmt(from, 3)}${relU} → ${fmt(to, 3)}${relU} (${px.map((x) => fmt(x, 2)).join(' → ')} px on this element), written in ${relU}`);
  }
  // a segment that starts where it ends (rotation 0 -> 0: one piece of a multi-segment channel read with the wrong ends) is not a tween
  if (!whole && !kv && Number.isFinite(from) && Number.isFinite(to) && Math.abs(from - to) < 5e-4) return { skipped: `from equals to (${fmt(from, 3)}): not a tween; a segment of a multi-segment channel needs its own ends` };
  const res = [];
  const bz = bez ? bez.map((x) => round(x, 4)) : null;
  const bezCssOk = bz && bz[0] >= 0 && bz[0] <= 1 && bz[2] >= 0 && bz[2] <= 1;
  const dly = declaredDelay(rec); const dCss = dly ? ` ${dly}ms` : ''; const dJs = dly ? `, delay: ${round(dly / 1000, 4)}` : '';
  if (dly) notes.push(`declared delay ${dly} ms written into the code`);

  if (libs.has('css')) {
    let css, acc, extra = {};
    if (declared) { css = declared; acc = accuracy({ max: 0, atMs: 0 }); extra.note = 'declared value emitted as authored'; }
    else if (bezCssOk) { css = `cubic-bezier(${bz.join(', ')})`; acc = accuracy(errT(cubicBezier(...bz))); }
    else {
      const enb = name && EASINGS_NET_BEZIER[name];
      const e1 = enb ? errT(cubicBezier(...enb)) : null;
      if (e1 && e1.max <= CSS_MAX_ERR) { css = `cubic-bezier(${enb.join(', ')})`; acc = accuracy(e1); extra.note = `easings.net bezier for ${name}`; }
      else { const lin = buildLinear(refT, D, CSS_MAX_ERR); css = lin.css; acc = accuracy(lin.err); extra.note = bz ? 'x control point outside 0..1 is invalid in CSS; sampled to linear()' : `no CSS bezier within 1 % for ${name}; sampled to linear()`; }
    }
    if (whole) extra.note = 'declared value emitted as authored (the whole transform)';
    const decl = cssDecl(props, from, to, `${D}ms ${css}`, dly);
    res.push(out('css', cssStates(props, from, to, `${D}ms ${css}${dCss}`), acc, { ...extra, decl: whole ? { ...decl, whole: true } : decl }));
  }
  if (libs.has('gsap')) {
    const gn = name && gsapNameFor(name);
    if (gn) res.push(out('gsap', `gsap.fromTo(el, { ${props.gsap}: ${jsvG(props, fmt(from, 3, 'FROM'))} }, { ${props.gsap}: ${jsvG(props, fmt(to, 3, 'TO'))}, duration: ${round(D / 1000, 4)}${dJs}, ease: "${gn}" });`, accuracy(errT(gsapEase(gn)))));
    else if (bz) res.push(out('gsap', `gsap.registerPlugin(CustomEase);\ngsap.fromTo(el, { ${props.gsap}: ${jsvG(props, fmt(from, 3, 'FROM'))} }, { ${props.gsap}: ${jsvG(props, fmt(to, 3, 'TO'))}, duration: ${round(D / 1000, 4)}${dJs}, ease: CustomEase.create("reva-ease", "M0,0 C${bz[0]},${bz[1]} ${bz[2]},${bz[3]} 1,1") });`, accuracy(errT(cubicBezier(...bz)))));
  }
  if (libs.has('motion')) {
    const src = name && pennerSource(name);
    const ease = src || (bz ? `[${bz.join(', ')}]` : null);
    const fn = src ? evalSource(src) : bz ? cubicBezier(...bz) : null;
    if (ease) res.push(out('motion', `animate(el, { ${props.motion}: [${jsv(props, fmt(from, 3, 'FROM'))}, ${jsv(props, fmt(to, 3, 'TO'))}] }, { duration: ${round(D / 1000, 4)}${dJs}, ease: ${ease} })`, accuracy(errT(fn)),
      src ? { note: 'easing function: Motion runs it on the JS thread (WAAPI gets a sampled linear())' } : {}));
  }
  for (const l of ['lenis', 'raf', 'react-spring']) if (libs.has(l)) res.push(out(l, null, notRepresentable(l, 'fixed-duration tween')));
  if (rec.derived && rec.derived.t0 != null) notes.push(`starts at ${round(rec.derived.t0, 1)} ms on the take clock`);
  return { kind: 'tween', model: { duration_ms: D, ease: name || declared || null, bezier: bz }, notes, exports: res };
}

// ---------- first-order smoothing (EMA / dt-damp) ----------

function exportSmoothing(rec, libs) {
  const tauP = param(rec, 'tau_ms'); const lambda = param(rec, 'lambda');
  let tau = tauP.value != null ? tauP.value : lambda.value != null ? 1000 / lambda.value : null;
  if (tau == null && rec.derived && rec.derived.tau_ms) tau = rec.derived.tau_ms;
  if (!(tau > 0)) return { skipped: 'smoothing without τ' };
  const fam = rec.model.family; const notes = [];
  const perFrame = /per-frame/.test(fam) || rec.model.law === 'per-frame';
  if (perFrame) { const hz = rec.model.valid_at && rec.model.valid_at.refresh_hz; notes.push(`per-frame EMA (frame-rate dependent), measured at ${round(hz || 0, 1)} Hz: on a screen twice as fast it follows twice as fast. Exported dt-correct; do not copy that bug.`); }
  if (/\+snap/.test(fam)) notes.push('the site snaps to the target near the end (snap not exported)');
  if (rec.model.map) notes.push(`driven by a scroll map (${rec.model.map.shape || 'unknown shape'}); this export covers the smoothing only`);
  const ref = emaProgress(tau); const span = tau * 8; const res = [];
  const tauS = round(tau / 1000, 6);
  if (libs.has('lenis')) {
    // Lenis damps with 1 − e^(−λ·dt), λ = 60·lerp (dt in s). So lerp = 1 / (60 τ) reproduces e^(−t/τ) at any rate.
    const lerp = Number((1 / (60 * (tau / 1000))).toPrecision(4));
    res.push(out('lenis', `new Lenis({ lerp: ${lerp} })`, accuracy(maxError(ref, emaProgress(1000 / (60 * lerp)), span)),
      { note: `Lenis smooths the scroll position only; per-frame factor at 60 Hz = ${round(1 - Math.exp(-lerp), 4)}${lerp > 1 ? '; lerp > 1 means near-instant' : ''}` }));
  }
  const rafSrc = `const TAU = ${tauS}; // s\nlet last = performance.now();\nfunction tick(now) {\n  const dt = (now - last) / 1000; last = now;\n  x += (target - x) * (1 - Math.exp(-dt / TAU));\n  render(x);\n  requestAnimationFrame(tick);\n}\nrequestAnimationFrame(tick);`;
  const tickErr = () => { // sample the snippet's own stepping at 60 Hz against the continuous fit
    const dt = 1000 / 60; let x = 0; const pts = [0];
    for (let t = dt; t <= span + dt; t += dt) { x += (1 - x) * (1 - Math.exp(-(dt / 1000) / tauS)); pts.push(x); }
    let max = 0, atMs = 0; pts.forEach((v, i) => { const e = Math.abs(v - ref(i * dt)); if (e > max) { max = e; atMs = i * dt; } });
    return { max, atMs };
  };
  if (libs.has('raf')) res.push(out('raf', rafSrc, accuracy(tickErr()), { note: 'frame-rate independent; error measured at 60 Hz frame instants' }));
  if (libs.has('gsap')) res.push(out('gsap', `const TAU = ${tauS};\ngsap.ticker.add((time, deltaMs) => {\n  x += (target - x) * (1 - Math.exp(-(deltaMs / 1000) / TAU));\n  gsap.set(el, { ${propsOf(rec).gsap}: ${propsOf(rec).form ? `\`${formValue(propsOf(rec).form, '${x}')}\`` : 'x'} });\n});`,
    accuracy(tickErr()), { note: 'gsap.quickTo is not equivalent (it restarts a fixed-duration tween); ticker form is exact' }));
  if (libs.has('motion')) res.push(out('motion', null, notRepresentable('motion', 'no first-order follower; use the rAF snippet or useAnimationFrame with the same factor')));
  if (libs.has('css')) res.push(out('css', null, notRepresentable('css', 'continuous re-targeting needs JS')));
  return { kind: 'smoothing', model: { tau_ms: round(tau, 4), per_frame: perFrame }, notes, exports: res };
}

// ---------- scroll map ----------

function exportScrollMap(rec, libs) {
  const m = rec.model.map; if (!m) return { skipped: 'scroll map without map' };
  const shape = (/\(([^)]+)\)/.exec(rec.model.family) || [])[1] || m.shape || 'linear';
  const sh = shapeFn(shape); if (!sh) return { skipped: `map shape ${shape}` };
  const notes = []; if (['mapA', 'mapB', 'mapS0', 'mapS1'].some((k) => param(rec, k).withheld)) notes.push('map parameters use withheld fit values (no finite CI)');
  // printed with 6 significant figures (a fixed 0.1 px / 0.01 is up to ~1 % of a short ramp's travel); the accuracy check
  // compares the printed snippet with the UNROUNDED fitted map, so any rounding left shows up in it (recheck item 38)
  const P6 = (x) => Number(Number(x).toPrecision(6));
  const a = m.a, b = m.b, s0 = P6(m.s0_px), s1 = P6(m.s1_px);
  if (![a, b, s0, s1].every(Number.isFinite) || s1 === s0) return { skipped: 'map not identified' };
  const props = propsOf(rec);
  const span = s1 - s0; const S0 = m.s0_px, SPAN = m.s1_px - m.s0_px;
  const clamp01 = (u) => Math.min(1, Math.max(0, u));
  const res = []; const v0 = P6(a), v1 = P6(a + b);
  // error in units of the travel: the fitted value a + b·shape(true progress) against the snippet's v0 + (v1 - v0)·fn(printed progress)
  const errS = (fn) => {
    const lo = Math.min(S0, s0) - 0.05 * Math.abs(SPAN), hi = Math.max(S0 + SPAN, s1) + 0.05 * Math.abs(SPAN);
    const e = maxError((t) => a + b * sh.fn(clamp01((lo + t - S0) / SPAN)), (t) => v0 + (v1 - v0) * fn(clamp01((lo + t - s0) / span)), hi - lo);
    return { max: e.max / (Math.abs(b) > 1e-9 ? Math.abs(b) : 1), atMs: e.atMs };
  };
  // the map's driver (fitter: model.driver): the window scroll offset unless the fit found the wheel-delta sum or a
  // pointer coordinate explains the channel; a non-scroll driver is fed from its own input, never from scrollY
  const drv = rec.model.driver && rec.model.driver.kind && rec.model.driver.kind !== 'scroll' ? rec.model.driver : null;
  if (drv) return exportInputMap(rec, libs, { drv, sh, props, s0, s1, v0, v1, span, errS, notes, shape });
  if (libs.has('gsap')) {
    let ease, fn;
    if (sh.kind === 'linear') { ease = '"none"'; fn = (u) => u; }
    else if (sh.kind === 'named' && gsapNameFor(sh.name)) { const g = gsapNameFor(sh.name); ease = `"${g}"`; fn = gsapEase(g); }
    else if (sh.bezier) { const b = sh.bezier.map((x) => round(x, 4)); ease = `CustomEase.create("reva-map", "M0,0 C${b[0]},${b[1]} ${b[2]},${b[3]} 1,1")`; fn = cubicBezier(...b); }
    else { const lin = buildLinear((t) => sh.fn(t / 1000), 1000, 0.002); ease = `CustomEase.create("reva-map", "${customEasePath(lin.stops)}")`; fn = evalLin(lin); }
    res.push(out('gsap', `gsap.fromTo(el, { ${props.gsap}: ${jsv(props, v0)} }, { ${props.gsap}: ${jsv(props, v1)}, ease: ${ease}, scrollTrigger: { start: ${s0}, end: ${s1}, scrub: true } });`, accuracy(errS(fn), 5e-4, 'px scroll')));
  }
  if (libs.has('motion')) {
    const src = sh.kind === 'named' ? pennerSource(sh.name) : sh.kind === 'smoothstep' ? '(p) => p * p * (3 - 2 * p)' : sh.kind === 'smootherstep' ? '(p) => p * p * p * (p * (p * 6 - 15) + 10)' : null;
    res.push(out('motion', `const { scrollY } = useScroll();\nconst v = useTransform(scrollY, [${s0}, ${s1}], [${jsv(props, v0)}, ${jsv(props, v1)}]${src ? `, { ease: ${src} }` : ''});`, accuracy(errS(src ? evalSource(src) : (u) => u), 5e-4, 'px scroll')));
  }
  if (libs.has('css')) {
    let tf, fn;
    if (sh.kind === 'linear') { tf = 'linear'; fn = (u) => u; }
    else if (sh.bezier) { const bz = sh.bezier.map((x) => round(x, 3)); tf = `cubic-bezier(${bz.join(', ')})`; fn = cubicBezier(...bz); }
    else if (sh.kind === 'named' && NAMED[sh.name].kind === 'css') { tf = sh.name; fn = NAMED[sh.name].fn; }
    else { const lin = buildLinear((t) => sh.fn(t / 1000), 1000, CSS_MAX_ERR); tf = lin.css; fn = evalLin(lin); }
    const kf = (v) => `${props.css}: ${props.fn(v)}`;
    res.push(out('css', `@keyframes reva-map { from { ${kf(v0)}; } to { ${kf(v1)}; } }\n.el { animation: reva-map linear both; animation-timing-function: ${tf}; animation-timeline: scroll(root); animation-range: ${s0}px ${s1}px; }`,
      accuracy(errS(fn), 5e-4, 'px scroll'), { note: 'scroll-driven animations: Chromium 115+, Safari 26; check Firefox before shipping' }));
  }
  for (const l of ['lenis', 'raf', 'react-spring']) if (libs.has(l)) res.push(out(l, null, notRepresentable(l, 'scroll map (no time axis)')));
  return { kind: 'scroll map', model: { shape, s0_px: s0, s1_px: s1, from: v0, to: v1 }, notes, exports: res };
}
const evalLin = (lin) => parseEasing(lin.css);

/**
 * A map driven by an input instead of the scroll offset (model.driver): the wheel-delta sum the page received, or the
 * last pointer coordinate on one axis. GSAP: a paused tween whose progress the input sets; Motion: a motion value the
 * input feeds; CSS scroll timelines cannot read either, so CSS is not representable.
 */
function exportInputMap(rec, libs, { drv, sh, props, s0, s1, v0, v1, span, errS, notes, shape }) {
  const res = []; const axis = drv.axis === 'y' ? 'y' : 'x';
  const what = drv.kind === 'wheel' ? 'the running sum of the wheel deltas the page received' : drv.kind === 'pointer' ? `the pointer ${axis} coordinate` : `its ${drv.kind} input`;
  const unit = drv.kind === 'wheel' ? 'px wheel input' : drv.kind === 'pointer' ? `px pointer ${axis}` : 'driver units';
  notes.push(`driven by ${what}, not by the window scroll`);
  const known = drv.kind === 'wheel' || drv.kind === 'pointer';
  const feed = (set) => (drv.kind === 'wheel'
    ? `let d = 0;   // ${what} (px, summed since the page loaded, never clamped: as measured)\naddEventListener('wheel', (e) => { d += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1); ${set('d')} }, { passive: true });`
    : `addEventListener('pointermove', (e) => { ${set(`e.client${axis.toUpperCase()}`)} });   // ${what}`);
  if (libs.has('gsap')) {
    let ease = null, fn = null;
    if (sh.kind === 'linear') { ease = '"none"'; fn = (u) => u; }
    else if (sh.kind === 'named' && gsapNameFor(sh.name)) { const g = gsapNameFor(sh.name); ease = `"${g}"`; fn = gsapEase(g); }
    else if (sh.bezier) { const b = sh.bezier.map((x) => round(x, 4)); ease = `CustomEase.create("reva-map", "M0,0 C${b[0]},${b[1]} ${b[2]},${b[3]} 1,1")`; fn = cubicBezier(...b); }
    else { const lin = buildLinear((t) => sh.fn(t / 1000), 1000, 0.002); ease = `CustomEase.create("reva-map", "${customEasePath(lin.stops)}")`; fn = evalLin(lin); }
    res.push(known
      ? out('gsap', `const tw = gsap.fromTo(el, { ${props.gsap}: ${jsv(props, v0)} }, { ${props.gsap}: ${jsv(props, v1)}, ease: ${ease}, paused: true });\n${feed((x) => `tw.progress(gsap.utils.clamp(0, 1, (${x} - ${s0}) / ${sig(span, 6)}));`)}`, accuracy(errS(fn), 5e-4, unit), { note: `driven by ${what}, not by ScrollTrigger` })
      : out('gsap', null, notRepresentable('gsap', `driven by ${what}`)));
  }
  if (libs.has('motion')) {
    const src = sh.kind === 'named' ? pennerSource(sh.name) : sh.kind === 'smoothstep' ? '(p) => p * p * (3 - 2 * p)' : sh.kind === 'smootherstep' ? '(p) => p * p * p * (p * (p * 6 - 15) + 10)' : null;
    res.push(known
      ? out('motion', `const d = motionValue(0);   // ${what}\n${drv.kind === 'wheel' ? `addEventListener('wheel', (e) => { d.set(d.get() + e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1)); }, { passive: true });   // px (line / page deltas converted)` : `addEventListener('pointermove', (e) => { d.set(e.client${axis.toUpperCase()}); });`}\nconst v = useTransform(d, [${s0}, ${s1}], [${jsv(props, v0)}, ${jsv(props, v1)}]${src ? `, { ease: ${src} }` : ''});`, accuracy(errS(src ? evalSource(src) : (u) => u), 5e-4, unit), { note: `driven by ${what}, not by useScroll` })
      : out('motion', null, notRepresentable('motion', `driven by ${what}`)));
  }
  if (libs.has('css')) res.push(out('css', null, notRepresentable('css', `driven by ${what}; CSS scroll timelines read the scroll position only`)));
  for (const l of ['lenis', 'raf', 'react-spring']) if (libs.has(l)) res.push(out(l, null, notRepresentable(l, `map of ${what} (no time axis)`)));
  return { kind: 'scroll map', model: { shape, s0_px: s0, s1_px: s1, from: v0, to: v1, driver: drv.kind }, notes, exports: res };
}

// ---------- stagger ----------

export function exportStagger(group, libs) {
  const iv = group.interval && group.interval.value; if (!(iv > 0)) return { skipped: 'stagger without interval' };
  const starts = (group.members || []).map((m) => +String(m).split('|').pop()).filter(Number.isFinite).sort((x, y) => x - y);
  // Best constant-step fit in time order: start_i ≈ s + i·iv with s the mean offset; report the max residual.
  const s = starts.reduce((acc, x, i) => acc + x - i * iv, 0) / (starts.length || 1);
  let max = 0, at = 0; starts.forEach((x, i) => { const e = Math.abs(x - s - i * iv); if (e > max) { max = e; at = i; } });
  const sec = round(iv / 1000, 4);
  const acc = max <= 1 ? { label: 'exact', maxErrorMs: round(max, 2) } : { label: `approx (max start error ${round(max, 1)} ms, at member ${at}${group.residual_ms != null ? `; fitter residual ${round(group.residual_ms, 1)} ms` : ''})`, maxErrorMs: round(max, 1) };
  const res = [];
  if (libs.has('gsap')) res.push(out('gsap', `gsap.from(els, { /* per-element tween props */ stagger: ${sec} });`, acc));
  if (libs.has('motion')) res.push(out('motion', `animate(els, { /* … */ }, { delay: stagger(${sec}) })`, acc));
  if (libs.has('css')) res.push(out('css', `.el { transition-delay: calc(var(--i) * ${round(iv, 1)}ms); } /* set --i per element */`, acc));
  return { kind: 'stagger', model: { interval_ms: round(iv, 2), members: starts.length, constantStep: !!group.constantStep, shape: group.shape }, notes: group.constantStep === false ? ['the measured steps are not constant; the interval is the best single step'] : [], exports: res };
}

// ---------- dispatch ----------

const SMOOTH = /^(ema|dtdamp|asym)|ema-to-constant/;
export function familyKind(fam) {
  if (!fam) return null;
  if (fam === 'spring') return 'spring';
  if (fam === 'bezier' || fam.startsWith('bezier ') || fam.startsWith('named:') || fam === 'declared:css' || fam === 'declared:waapi') return 'tween';
  if (SMOOTH.test(fam) && !fam.startsWith('asym')) return 'smoothing';
  if (fam.startsWith('scroll map')) return 'scroll map';
  return null;
}

/** Export one `reva.motion/0` record. Returns {kind, model, notes, exports:[{lib, code, accuracy}], source} or {skipped}. */
/** The params a tween's or spring's snippet needs for its ends (the fit measures the shape; the ends can be recorded). */
export const ENDS = { spring: ['x0', 'target'], tween: ['from', 'to'] };
export const hasValue = (p) => !!p && (p.value ?? p.withheld_value) != null;
export const numericKeyframes = (p) => !!p && Array.isArray(p.value) && p.value.length >= 2 && p.value.every((x) => Number.isFinite(+x) && x !== '' && x !== null);
/**
 * A record with its unmeasured ends filled from the recording (endsOf(rec) -> {from, to} | null: the recorded values at the
 * motion's start and end), labelled provenance 'recorded'. One path for the card, look.json and the MCP, so the same law
 * gives the same snippet everywhere. Returns {rec, filled: ['from'|'to', ...]}.
 */
export function withRecordedEnds(rec, endsOf) {
  const keys = ENDS[familyKind(rec.model && rec.model.family)]; if (!keys) return { rec, filled: [] };
  const ps = { ...(rec.model.params || {}) };
  if (keys[0] === 'from' && ps.keyframeValues) { if (numericKeyframes(ps.keyframeValues)) return { rec, filled: [] }; delete ps.keyframeValues; }
  if (keys.every((k) => hasValue(ps[k]))) return { rec, filled: [] };
  const e = endsOf(rec); const filled = [];
  if (e) keys.forEach((k, i) => { const v = e[i ? 'to' : 'from']; if (!hasValue(ps[k]) && Number.isFinite(v)) { ps[k] = { value: v, provenance: 'recorded' }; filled.push(i ? 'to' : 'from'); } });
  return { rec: { ...rec, model: { ...rec.model, params: ps } }, filled };
}

export function exportRecord(rec, { to = LIBS, meta = {} } = {}) {
  const libs = new Set(to); const fam = rec.model && rec.model.family; const kind = familyKind(fam);
  const fn = { spring: exportSpring, tween: exportTween, smoothing: exportSmoothing, 'scroll map': exportScrollMap }[kind];
  const base = { el: rec.target && rec.target.el, channel: rec.target && rec.target.channel, family: fam };
  if (!fn) return { ...base, skipped: `no export for family ${fam}` };
  const r = fn(rec, libs);
  if (r.skipped) return { ...base, ...r };
  const ch = propsOf(rec); if (ch.note) r.notes.push(ch.note);
  if (ch.noform) r.exports = r.exports.map((e) => (e.code && NAMES_PROP.has(e.lib) ? out(e.lib, null, notRepresentable(e.lib, `the recorded ${sanitize(ch.noform, 40)} value's form around its number (e.g. blur(<n>px)) is not known, so no ${e.lib} value can be written`), e.form ? { form: e.form } : {}) : e));
  if (ch.form) r.notes.push(`values are ${formValue(ch.form, 'N')} (the recorded form around the number)`);
  if (ch.unmapped) r.exports = r.exports.map((e) => (e.code && NAMES_PROP.has(e.lib) ? out(e.lib, null, notRepresentable(e.lib, `the recorded channel ${sanitize(ch.unmapped, 40)} names no ${e.lib} property, so no snippet can animate it`), e.form ? { form: e.form } : {}) : e));
  if (ch.part) r.exports = r.exports.map((e) => (e.code && NAMES_PROP.has(e.lib) ? out(e.lib, null, notRepresentable(e.lib, `${sanitize(ch.part, 40)} is one component of a compound value; no single property animates it`), e.form ? { form: e.form } : {}) : e));
  const src = sourceComment(rec, meta);
  for (const e of r.exports) if (e.code) {
    const holes = [...new Set(e.code.match(HOLES) || [])];
    e.code = `${src}\n${holes.length ? `// ${holes.join(', ')}: ${holes.length > 1 ? 'values' : 'value'} not measured in this recording; define before use\n` : ''}${e.code}`;
  }
  return { ...base, ...r, fit: rec.fit ? { n: rec.fit.n, rms: rec.fit.rms, nrmse: rec.fit.nrmse } : null, source: src };
}

/** Export a whole fit result (`reva.fitresult/0`) or a single record. */
export function exportFit(doc, { to = LIBS, meta = {}, el = null } = {}) {
  const recs = doc.schema && schemaKind(doc.schema).startsWith('motion') ? [doc] : doc.records || [];
  const take = doc.takes && doc.takes.primary;
  const m = { take, ...meta };
  const items = recs.filter((r) => el == null || (r.target && r.target.el === el)).map((r) => exportRecord(r, { to, meta: m }));
  const stagger = (doc.stagger || []).map((g) => exportStagger(g, new Set(to)));
  for (const g of stagger) if (!g.skipped) {
    const src = `/* REVA: measured from ${sanitize(m.url || 'unknown-url', 200)} stagger ${sanitize(g.model.shape, 60)} take ${sanitize(take || '?', 40)}${m.takeName ? ` (${sanitize(m.takeName, 40)})` : ''}, ${sanitize(m.date || 'unknown-date', 30)} */`;
    for (const e of g.exports) e.code = `${src}\n${e.code}`;
  }
  return { schema: 'reva.export/0', meta: m, items: items.filter((i) => !i.skipped), skipped: items.filter((i) => i.skipped).length, stagger: stagger.filter((s) => !s.skipped) };
}
