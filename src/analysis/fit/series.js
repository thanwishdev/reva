// Channels, noise floor, explain bar, segmentation (design §2, §5.1, §6 U1/U6/U10).
import { median, r6 } from './numeric.js';
import { envVal } from './blind.js';
import { glSeriesOf } from '../gl/channels.js';

const SKIP = new Set(['ren:transform']);   // decomposed into tx..skx by the recorder

/**
 * First number in a value ('12px', 'blur(3px)', 'inset(4%)'); null for keywords. A digit that is part of a name is not
 * a number: 'translate3d(0px, ...)', 'matrix3d(1, ...)', 'scale3d(1, ...)' read their first argument, not the 3 (GSAP's
 * force3D "auto" switches translate3d(0px, 0px, 0px) -> translate(0px, 0px) at a tween's end: a fake 3 -> 0 step).
 */
export function numOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v === 'none' || v === 'auto' || v === '') return null;
  const m = /(?<![a-z_\d.])-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i.exec(v); return m ? +m[0] : null;
}

/** CSS functions whose single numeric argument a channel can carry, with the units they take ('' = a plain number). */
const FORM_FNS = { blur: ['px'], brightness: ['', '%'], contrast: ['', '%'], grayscale: ['', '%'], 'hue-rotate': ['deg', 'turn', 'rad'], invert: ['', '%'], opacity: ['', '%'], saturate: ['', '%'], sepia: ['', '%'] };
const FORM_UNITS = new Set(['', 'px', 'deg', '%', 'turn', 'rad', 'em', 'rem', 'vw', 'vh']);
/**
 * The form of a string value around its number: 'blur(16px)' -> {fn: 'blur', unit: 'px'}, '45deg' -> {fn: null, unit:
 * 'deg'}; null for anything else (several functions or arguments, keywords). Function and unit come from fixed lists, so
 * the form holds no page text.
 */
export function valueForm(v) {
  if (typeof v !== 'string') return null; const t = v.trim();
  const N = '([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?)([a-z%]*)';
  let m = new RegExp(`^([a-z-]+)\\(\\s*${N}\\s*\\)$`, 'i').exec(t);
  if (m) { const fn = m[1].toLowerCase(), unit = m[3].toLowerCase(); return FORM_FNS[fn] && FORM_FNS[fn].includes(unit) ? { fn, unit } : null; }
  m = new RegExp(`^${N}$`, 'i').exec(t);
  if (m) { const unit = m[2].toLowerCase(); return FORM_UNITS.has(unit) ? { fn: null, unit } : null; }
  return null;
}
/** A number written back in its form: ({fn: 'blur', unit: 'px'}, 16) -> 'blur(16px)'. */
export const formValue = (form, v) => (form.fn ? `${form.fn}(${v}${form.unit})` : `${v}${form.unit}`);

/**
 * clip-path shape -> its numbers by name: inset() as the four sides (CSS shorthand expanded: 1-4 values), any other
 * shape (polygon, circle, ellipse, xywh, rect) as p0, p1, ... in order. null when the value has no shape function.
 * The fitter's `ren:clipPath` channel is the FIRST number only (numOf), which misses a wipe on any other side.
 */
export function clipParts(v) {
  if (typeof v !== 'string') return null;
  const m = /^\s*([a-z-]+)\((.*)\)/i.exec(v); if (!m) return null;
  const nums = (str) => (str.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
  if (m[1] === 'inset') {
    const n = nums(m[2].split(/\bround\b/)[0]); if (!n.length || n.length > 4) return null;
    const [t, r = t, b = t, l = r] = n; return { top: t, right: r, bottom: b, left: l };
  }
  const n = nums(m[2]); if (!n.length) return null;
  return Object.fromEntries(n.slice(0, 64).map((x, i) => [`p${i}`, x]));
}
/**
 * The individual transform properties as numbers by axis: translate '0px 40px' -> {x: 0, y: 40}, scale '1 1.2' ->
 * {x: 1, y: 1.2} (CSS: a missing y repeats x for scale, is 0 for translate; a missing z is 0 / 1). null for 'none',
 * a percentage or calc() (not a px number the fitter can map).
 */
export function axisParts(ch, v) {
  if (typeof v !== 'string') return null; const t = v.trim(); if (!t || t === 'none') return null;
  const parts = t.split(/\s+/);
  if (parts.length > 3) return null;
  const re = ch === 'ren:translate' ? /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)px$/i : /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)$/i;
  const n = parts.map((p) => { const m = re.exec(p); return m ? +m[1] : null; }); if (n.some((x) => x == null)) return null;
  const [x, y = ch === 'ren:scale' ? x : 0, z = ch === 'ren:scale' ? 1 : 0] = n;
  return { x, y, z };
}
const AXIS_CH = new Set(['ren:translate', 'ren:scale']);

/**
 * The rotate property as one angle in degrees: '45deg' -> 45, 'z 90deg' / 'x 30deg' / '0 0 1 0.25turn' -> the angle (the
 * last value, CSS puts the axis first), 'none' -> 0. null for anything else. The recorder stores the computed string;
 * the first number of '0 0 1 45deg' is the axis, not the angle.
 */
export function rotateDeg(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null; const t = v.trim(); if (t === 'none') return 0;
  const m = /(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(deg|turn|rad|grad)$/i.exec(t); if (!m) return null;
  const k = { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 }[m[2].toLowerCase()]; return +m[1] * k;
}

/**
 * A computed colour -> {r, g, b, a} (r, g, b 0..255, a 0..1): rgb()/rgba() in the legacy comma form or the space form,
 * color(srgb r g b / a) scaled to 0..255. null for keywords and other colour spaces (oklch, lab: not split).
 */
export function colorParts(v) {
  if (typeof v !== 'string') return null; const t = v.trim().toLowerCase();
  if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const N = '(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?)(%?)';
  let m = new RegExp(`^rgba?\\(\\s*${N}[\\s,]+${N}[\\s,]+${N}(?:\\s*[,/]\\s*${N})?\\s*\\)$`).exec(t);
  if (m) {
    const c = (i) => (m[i + 1] === '%' ? (+m[i] * 255) / 100 : +m[i]);
    const a = m[7] == null ? 1 : m[8] === '%' ? +m[7] / 100 : +m[7];
    return { r: c(1), g: c(3), b: c(5), a };
  }
  m = new RegExp(`^color\\(srgb\\s+${N}\\s+${N}\\s+${N}(?:\\s*/\\s*${N})?\\s*\\)$`).exec(t);
  if (m) { const c = (i) => (m[i + 1] === '%' ? (+m[i] * 255) / 100 : +m[i] * 255); return { r: c(1), g: c(3), b: c(5), a: m[7] == null ? 1 : m[8] === '%' ? +m[7] / 100 : +m[7] }; }
  return null;
}

/**
 * background-position / mask-position -> the first layer's {x, y} numbers in their unit ('100% 0%' -> {x: 100, y: 0},
 * '-20px 50%' -> {x: -20, y: 50}); null when a value is not a single number (calc(), keywords other than the ones the
 * computed value never keeps). `unit` is the form of both ('% %', 'px %') so a series only joins samples of one form.
 */
export function positionParts(v) {
  if (typeof v !== 'string') return null; const first = v.split(',')[0].trim(); if (!first) return null;
  const parts = first.split(/\s+/); if (parts.length !== 2) return null;
  const n = parts.map((p) => /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(px|%)?$/i.exec(p)); if (n.some((x) => !x)) return null;
  return { x: +n[0][1], y: +n[1][1], unit: `${n[0][2] || 'px'} ${n[1][2] || 'px'}` };
}

// Channels the recorder stores as strings that the fitter reads as numbers by part. Only parts that move by more than
// their floor become channels (the floor is the noise floor of the part: an 8-bit colour step, a 1/64 px layout unit), so
// a page that sits still gains no motion from them. The raw string channel itself is not a series.
const SPLIT = {
  'ren:color': { parts: colorParts, names: ['r', 'g', 'b', 'a'] },
  'ren:bg': { parts: colorParts, names: ['r', 'g', 'b', 'a'] },
  'ren:fill': { parts: colorParts, names: ['r', 'g', 'b', 'a'] },
  'ren:stroke': { parts: colorParts, names: ['r', 'g', 'b', 'a'] },
  'ren:bgPos': { parts: positionParts, names: ['x', 'y'] },
  'ren:maskPos': { parts: positionParts, names: ['x', 'y'] },
};
const SPLIT_FLOOR = { r: 0.5, g: 0.5, b: 0.5, a: 0.002, x: 1 / 64, y: 1 / 64 };
/** `el|ren:clipPath.side` -> `el|ren:clipPath` (the recorded channel a derived clip-path part comes from); the same for the
 *  axes of the individual transform properties (`el|ren:translate.y` -> `el|ren:translate`) and the parts of a split
 *  colour / position (`el|ren:bg.r` -> `el|ren:bg`). */
export const baseKey = (key) => String(key).replace(/\|ren:clipPath\.\w+$/, '|ren:clipPath').replace(/\|ren:(translate|scale)\.[xyz]$/, '|ren:$1')
  .replace(/\|ren:(color|bg|fill|stroke)\.[rgba]$/, '|ren:$1').replace(/\|ren:(bgPos|maskPos)\.[xy]$/, '|ren:$1');

/** Read-back floor key (D3) for a channel name. */
export function floorKind(ch) {
  const c = ch.replace(/^(ren|drv):/, '').replace(/^clipPath\.\w+$/, 'clipPath').replace(/^(translate|scale)\.[xyz]$/, '$1');
  if (c === 'opacity') return 'opacity';
  if (/^(color|bg|fill|stroke)\.[rgba]$/.test(c)) return 'colour';
  if (/^(bgPos|maskPos)\.[xy]$/.test(c)) return 'paint-position';
  if (c === 'text') return 'text-number';
  if (c === 'dash') return 'stroke-dashoffset';
  if (/^(wght|wdth|fvar\..+)$/.test(c)) return 'font-axis';   // computed numbers, no planted read-back: the relative float floor applies
  if (['tx', 'ty', 'tz'].includes(c)) return 'translateX(px)';
  if (['sx', 'sy'].includes(c) || c === 'scale') return 'scale';
  if (['rz', 'skx', 'rotate'].includes(c)) return 'rotate(deg)';
  if (c === 'translate') return 'translate-prop(px)';
  if (['bx', 'by', 'bw', 'bh'].includes(c)) return 'left(px)';
  if (c === 'radius') return 'border-radius(px)';
  if (c === 'filter') return 'filter-blur(px)';
  if (c === 'clipPath') return 'clip-inset(%)';
  if (c.startsWith('--')) return '--var(unregistered)';
  return null;
}
const LAYOUT_FLOOR = 1 / 64;   // LayoutUnit (D-M1-3)

/**
 * Extract every numeric channel per element plus the scroll channels from a blind view.
 * @returns {{T:number[], k:number[], sy:number[], sx:number[], series: object[]}}
 */
/** Unwrap a principal-angle series in degrees in place: each sample is moved by whole turns to lie within 180° of the previous one. */
export function unwrapDegrees(y) {
  let off = 0;
  for (let i = 1; i < y.length; i++) {
    const raw = y[i] + off, d = raw - y[i - 1];
    if (Math.abs(d) > 180) off -= 360 * Math.round(d / 360);
    y[i] += off;
  }
  return y;
}

export function extractSeries(view) {
  const rows = view.rows; const T = rows.map((r) => r.T), k = rows.map((r) => r.k), sy = rows.map((r) => r.sy), sx = rows.map((r) => r.sx);
  const map = new Map(); const clips = new Map(); const axes = new Map(); const splits = new Map();
  rows.forEach((r, i) => {
    for (const [el, chs] of Object.entries(r.v || {})) for (const [ch, raw] of Object.entries(chs)) {
      if (ch === 'ren:clipPath') { const parts = clipParts(raw); if (parts) { let c = clips.get(el); if (!c) clips.set(el, (c = { idx: [], parts: [] })); c.idx.push(i); c.parts.push(parts); } }
      if (AXIS_CH.has(ch)) { const p = axisParts(ch, raw); if (p) { const k = `${el}|${ch}`; let c = axes.get(k); if (!c) axes.set(k, (c = { el, ch, idx: [], parts: [] })); c.idx.push(i); c.parts.push(p); } }
      const sp = SPLIT[ch];
      if (sp) { const p = sp.parts(raw); if (p) { const k = `${el}|${ch}`; let c = splits.get(k); if (!c) splits.set(k, (c = { el, ch, sp, idx: [], parts: [] })); c.idx.push(i); c.parts.push(p); } continue; }
      if (SKIP.has(ch)) continue; const v = ch === 'ren:rotate' ? rotateDeg(raw) : numOf(raw); if (v == null) continue;
      const key = `${el}|${ch}`; let s = map.get(key);
      if (!s) map.set(key, (s = { key, el: +el, desc: view.elements[+el] ?? null, ch, kind: ch.split(':')[0], idx: [], y: [] }));
      s.idx.push(i); s.y.push(v);
      // a string value's form around its number (blur(<n>px)): one form for every sample, else `mixed` (no form)
      if (typeof raw === 'string') { const f = valueForm(raw); const k = f ? `${f.fn}|${f.unit}` : 'none'; if (s.formKey === undefined) { s.formKey = k; s.form = f; } else if (s.formKey !== k) { s.formKey = 'mixed'; s.form = null; } }
    }
    if (r.pix) for (const [ch, v] of Object.entries(r.pix)) { if (!Number.isFinite(v)) continue; const key = `canvas|pix:${ch}`; let s = map.get(key); if (!s) map.set(key, (s = { key, el: null, desc: 'canvas', ch: `pix:${ch}`, kind: 'pix', idx: [], y: [] })); s.idx.push(i); s.y.push(v); }
  });
  // WebGL light (src/analysis/gl/channels.js): float uniforms per component and the decoded camera, sample-and-hold
  for (const [key, g] of glSeriesOf(rows)) map.set(key, g);
  // clip-path parts: a part that moves and is not the first number (already the ren:clipPath channel) becomes its own
  // channel `ren:clipPath.<side|pN>` (a bottom-edge wipe: inset(0% 0% 0% → 100%) has a constant first number). At most
  // four per element, the widest ranges first; only samples where the shape keeps the same parts count.
  for (const [el, c] of clips) {
    const names = Object.keys(c.parts[0]); const first = names[0];
    const same = c.parts.map((p, j) => [p, c.idx[j]]).filter(([p]) => Object.keys(p).length === names.length);
    if (same.length < 2) continue;
    const ranked = names.slice(1).map((n) => { const ys = same.map(([p]) => p[n]); return { n, ys, range: Math.max(...ys) - Math.min(...ys) }; })
      .filter((x) => x.range > 0 && x.ys.some((y, j) => y !== same[j][0][first])).sort((a, b) => b.range - a.range).slice(0, 4);
    for (const x of ranked) {
      const ch = `ren:clipPath.${x.n}`; const key = `${el}|${ch}`;
      map.set(key, { key, el: +el, desc: view.elements[+el] ?? null, ch, kind: 'ren', idx: same.map(([, i]) => i), y: x.ys });
    }
  }
  // the individual transform properties: the recorded channel is the FIRST number (x); a y or z that moves becomes its own
  // channel `ren:translate.y` (a scrubbed drift written as translate: '0px 40px' -> '0px -40px' has a constant x)
  for (const c of axes.values()) {
    if (c.parts.length < 2) continue;
    for (const n of ['y', 'z']) {
      const ys = c.parts.map((p) => p[n]);
      if (Math.max(...ys) - Math.min(...ys) <= 0 || ys.every((y, j) => y === c.parts[j].x)) continue;
      const ch = `${c.ch}.${n}`; const key = `${c.el}|${ch}`;
      map.set(key, { key, el: +c.el, desc: view.elements[+c.el] ?? null, ch, kind: 'ren', idx: c.idx.slice(), y: ys });
    }
  }
  // split colours and paint positions: one channel per part that moves past its floor (`ren:bg.r`, `ren:bgPos.x`); a
  // position series keeps only the samples of its most common unit (px and % never mix in one series)
  for (const c of splits.values()) {
    let use = c.parts.map((p, j) => [p, c.idx[j]]);
    if (use[0] && use[0][0].unit !== undefined) {
      const n = new Map(); for (const [p] of use) n.set(p.unit, (n.get(p.unit) || 0) + 1);
      const unit = [...n.entries()].sort((a, b) => b[1] - a[1])[0];
      use = use.filter(([p]) => p.unit === unit[0]);
    }
    if (use.length < 2) continue;
    for (const n of c.sp.names) {
      const ys = use.map(([p]) => p[n]); if (ys.some((y) => !Number.isFinite(y))) continue;
      if (Math.max(...ys) - Math.min(...ys) <= SPLIT_FLOOR[n]) continue;
      const ch = `${c.ch}.${n}`; const key = `${c.el}|${ch}`;
      map.set(key, { key, el: +c.el, desc: view.elements[+c.el] ?? null, ch, kind: 'ren', idx: use.map(([, i]) => i), y: ys });
    }
  }
  // a box that changes size or place only in the frames where the element's text number changes, by steps of glyph size,
  // is the text reflowing (a counter's width grows with its digits): the text channel states that motion, the box steps
  // are not a motion of their own. Glyph reflow is told from a real layout motion that moves in the same frames (a
  // progress bar with its % inside: width 0 -> 300 px while the text runs 0 -> 100) by its shape: each step is at most
  // about two line heights, and either the box steps in clearly fewer frames than the text (a digit-count change with
  // tabular figures) or it goes back and forth (proportional digits: path well over the net range). A box that steps
  // with every text change and travels one way is a motion and stays. Listed in `covered` (key + reason), not fitted;
  // fitTakeSet carries the list into `pruned`, so look shows it as covered.
  const covered = [];
  for (const t of map.values()) {
    if (t.ch !== 'ren:text') continue;
    const tChange = new Set(); for (let j = 1; j < t.y.length; j++) if (t.y[j] !== t.y[j - 1]) tChange.add(t.idx[j]);
    if (!tChange.size) continue;
    const bhS = map.get(`${t.el}|ren:bh`); const line = bhS && bhS.y.length ? Math.min(...bhS.y.filter((v) => v > 0)) : NaN;
    const maxGlyphStep = 2 * (Number.isFinite(line) && line > 0 ? line : 24);
    for (const bch of ['ren:bx', 'ren:bw', 'ren:bh']) {
      const b = map.get(`${t.el}|${bch}`); if (!b) continue;
      let moved = 0, outside = 0, path = 0, maxStep = 0;
      for (let j = 1; j < b.y.length; j++) {
        const d = Math.abs(b.y[j] - b.y[j - 1]); if (d <= LAYOUT_FLOOR) continue;
        moved++; path += d; if (d > maxStep) maxStep = d;
        if (!tChange.has(b.idx[j])) { outside++; break; }
      }
      if (!moved || outside || maxStep > maxGlyphStep) continue;
      const net = Math.max(...b.y) - Math.min(...b.y);
      const fewer = moved <= 0.5 * tChange.size, backAndForth = path > 1.5 * net;
      if (!fewer && !backAndForth) continue;
      map.delete(b.key);
      covered.push({ key: b.key, desc: b.desc, ch: bch, covered_by: 'ren:text', why: `text reflow: the box changes only in frames where its text number changes, in glyph-size steps (${fewer ? 'fewer steps than the text' : 'back and forth'}, largest ${+maxStep.toFixed(2)} px)` });
    }
  }
  // the rendered rotation is read back from the matrix as its principal angle (−180°, 180°]: a scrubbed 0 → 240° turn
  // reads 162° then −177.6° and ends at −120°, which no scroll map explains (it was read as a bouncy spring). A matrix
  // cannot tell 182.4° from −177.6°; the continuous reading (each sample within 180° of the one before) is the turn
  for (const s of map.values()) if (s.ch === 'ren:rz') unwrapDegrees(s.y);
  const series = [...map.values()].map((s) => ({ ...s, T: s.idx.map((i) => T[i]), k: s.idx.map((i) => k[i]), sy: s.idx.map((i) => sy[i]) }));
  series.push({ key: 'scroll|scrollY', el: null, desc: 'window', ch: 'scrollY', kind: 'scroll', idx: T.map((_, i) => i), y: sy.slice(), T: T.slice(), k: k.slice(), sy: sy.slice() });
  return { T, k, sy, sx, series, covered };
}

/**
 * Detect a decimal value lattice (quantum ∈ {1, 0.1, …, 1e-4}, design §5.1) among the values of a series; null when
 * none. Only decimal lattices count: a linear motion sampled at a fixed rate also lands on a lattice (its per-frame
 * step), which is not quantisation.
 */
export function detectQuantum(y) {
  const vals = [...new Set(y)]; if (vals.length < 4) return null;
  for (const q of [1e-4, 1e-3, 1e-2, 1e-1, 1].reverse()) {
    if (vals.every((v) => Math.abs(v / q - Math.round(v / q)) < 1e-6)) return q;
  }
  return null;
}

/**
 * σ_floor and the explain bar (design §5.1).
 * σ_floor = max(read-back floor of the channel kind, quantum/√12, 1e-9·A); explain bar = max(3σ_floor, 5e-4·A).
 */
export function noiseFloor(s, view, extra = {}) {
  const A = Math.max(...s.y) - Math.min(...s.y);
  const rb = envVal(view.env.readbackFloor) || {};
  const kind = floorKind(s.ch);
  let rbf = 0; let source = 'none';
  if (s.kind === 'scroll') { rbf = 0.5; source = 'scroll integer px'; }
  else if (s.kind === 'pix') { rbf = 0.5; source = 'pixel centroid'; }
  else if (s.kind === 'gl') { rbf = 0; source = 'uniform value as the page passed it (exact)'; }
  else if (kind === 'left(px)') { rbf = Math.max(LAYOUT_FLOOR, rb[kind] ? rb[kind].maxAbsErr : 0); source = 'layout unit 1/64 px'; }
  else if (kind && rb[kind]) {
    // D3 stores the MAX read-back error of 64 planted values over [0, R]. Computed values serialise with a fixed
    // number of significant digits (D3: opacity 5e-7 over 0..1, scale 5e-6 over 0..2, translateX 5.2e-4 over
    // 0..1000), so the quantum is constant within a decade of magnitude: most planted values sit in the decade below
    // R, and the series' own largest magnitude sets its decade. A uniform error of max m has σ = m/√3.
    const R = rb[kind].range || null; const mag = Math.max(...s.y.map(Math.abs));
    const dec = R && mag > 0 ? Math.floor(Math.log10(mag)) - (Math.floor(Math.log10(R * 0.999)) ) : 0;
    rbf = (rb[kind].maxAbsErr / Math.sqrt(3)) * 10 ** Math.min(0, Math.max(-6, dec)) * (R && mag > R ? 10 ** Math.ceil(Math.log10(mag / R)) : 1);
    source = `readbackFloor ${kind} (σ = max/√3 at the decade of |y| ${mag.toPrecision(3)}, planted range ${R})`;
  }
  else if (kind) { rbf = 5e-7 * Math.max(1, ...s.y.map(Math.abs)); source = 'float32 relative (no readback for this kind)'; }
  const q = extra.quantum ?? detectQuantum(s.y);
  let sigma = Math.max(rbf, q ? q / Math.sqrt(12) : 0, 1e-9 * A);
  if (view.lane === 'rt' && extra.rtBand) sigma = Math.max(sigma, extra.rtBand);
  return { A, sigma, quantum: q, explainBar: Math.max(3 * sigma, 5e-4 * A), source };
}

/** Frame timing of the view: page period, stride, stalls (design §2 time base, U6, U10). */
export function frameTiming(view, T) {
  const dts = []; for (let i = 1; i < T.length; i++) dts.push(T[i] - T[i - 1]);
  const med = median(dts);
  const dtPage = view.dtPage;
  const stride = dtPage ? med / dtPage : null;
  const flags = [];
  if (dtPage && Math.abs(stride - Math.round(stride)) > 0.05) flags.push({ id: 'env_time_mismatch', detail: `median ΔT ${med.toFixed(4)} ms vs declared ${dtPage.toFixed(4)} ms` });
  const stalls = dts.map((d, i) => (d > 2.5 * med ? i + 1 : -1)).filter((i) => i > 0);
  return { medianDt: med, dtPage, stride: stride != null ? Math.round(stride * 1000) / 1000 : null, strideInt: stride != null ? Math.round(stride) : null, stalls, flags };
}

/** Per-frame change that counts as motion: 3σ_floor, but at least 2e-5·A (string-exact channels have σ ≈ 0). */
export const motionThreshold = (nf) => Math.max(nf.sigma * 3, 2e-5 * (nf.A || 0), 1e-12);

/**
 * Moving segments by velocity hysteresis: a frame moves when |Δy| > thr; runs separated by fewer than `gap` still
 * frames merge. Each segment gets a fit window that includes rest context before and the settled tail after.
 */
export function segment(s, nf, { gap = 3, tailMax = 90, cuts = [] } = {}) {
  const thr = motionThreshold(nf); const n = s.y.length; const mv = new Array(n).fill(false);
  for (let i = 1; i < n; i++) if (Math.abs(s.y[i] - s.y[i - 1]) > thr) mv[i] = true;
  const runs = []; let a = -1;
  for (let i = 0; i < n; i++) { if (mv[i] && a < 0) a = i; if (!mv[i] && a >= 0) { runs.push([a, i - 1]); a = -1; } }
  if (a >= 0) runs.push([a, n - 1]);
  const merged0 = [];
  // a quantised channel whose quantum is a visible share of the travel (a counter shown as whole numbers, a readout with
  // one decimal) eases out in single-quantum steps further and further apart: each such step that continues the run's
  // direction, within 2.5x the previous gap (at most 120 frames), is the same motion's tail, not a step of its own
  const q = nf.quantum; const quantTail = q && nf.A > 0 && q >= 1e-3 * nf.A;
  let lastGap = 0;
  for (const r of runs) {
    const last = merged0.at(-1); const g = last ? r[0] - last[1] - 1 : Infinity;
    let tail = false;
    if (quantTail && last && g >= gap && g <= 120 && g <= Math.max(8, 2.5 * lastGap)) {
      const dir = Math.sign(s.y[last[1]] - s.y[Math.max(0, last[0] - 1)]);
      tail = dir !== 0; for (let i = r[0]; i <= r[1] && tail; i++) { const d = s.y[i] - s.y[i - 1]; if (d && (Math.sign(d) !== dir || Math.abs(d) > 1.5 * q)) tail = false; }
    }
    if (last && (g < gap || tail)) { last[1] = r[1]; if (tail) lastGap = g; } else { merged0.push([...r]); lastGap = 0; }
  }
  // split at one-frame jumps (a value set instantly inside a motion: snap, class swap, !important override)
  const merged = [];
  for (const [b, e] of merged0) {
    // rates (per ms), so a stall frame (100 ms, R5) is not mistaken for a jump
    const rate = (i) => (i >= 1 && i < n ? Math.abs(s.y[i] - s.y[i - 1]) / Math.max(1e-9, s.T[i] - s.T[i - 1]) : 0);
    const d = []; for (let i = b; i <= e; i++) d.push(rate(i));
    const dtMed = median(s.T.slice(1).map((t, i) => t - s.T[i]));
    const med = median(d.filter((x) => x * dtMed > thr)) || 0; let start = b;
    for (let i = b; i <= e; i++) {
      const di = rate(i); const nb = Math.max(i > b ? rate(i - 1) : 0, i < e ? rate(i + 1) : 0);
      if (e > b && di > 20 * med && Math.abs(s.y[i] - s.y[i - 1]) > (nf.explainBar || 0) && di > 5 * nb) { if (i - 1 >= start) merged.push([start, i - 1]); merged.push([i, i]); start = i + 1; }
    }
    if (start <= e) merged.push([start, e]);
  }
  // a motion that starts with a jump AWAY and then moves BACK (sign reversal at the second frame) began with an instant
  // set: split the jump off (lab case M18 rAF FLIP at 30 Hz, where the size test above cannot separate it)
  for (let q = 0; q < merged.length; q++) {
    const [b, e] = merged[q]; if (e - b < 3 || b < 1) continue;
    const d0 = s.y[b] - s.y[b - 1], d1 = s.y[b + 1] - s.y[b];
    if (Math.sign(d0) !== Math.sign(d1) && d1 !== 0 && Math.abs(d0) > 1.5 * Math.abs(d1) && Math.abs(d0) > (nf.explainBar || 0)) { merged.splice(q, 1, [b, b], [b + 1, e]); continue; }
    // the same instant set in the middle of a smooth motion (an interrupted FLIP): a one-frame change against the
    // direction of both neighbours; only in an otherwise smooth run (≤ 2 such frames), never in jitter (M16b)
    const spikes = []; for (let i = b + 1; i < e; i++) { const dm = s.y[i - 1] - s.y[i - 2 >= 0 ? i - 2 : i - 1], di = s.y[i] - s.y[i - 1], dp = s.y[i + 1] - s.y[i];
      const big = Math.abs(di) > (nf.explainBar || 0) && Math.abs(di) > 1.5 * Math.max(Math.abs(dm), Math.abs(dp));
      const against = Math.sign(di) !== Math.sign(dm) && Math.sign(di) !== Math.sign(dp) && dm !== 0 && dp !== 0;
      const reverses = Math.sign(dp) !== Math.sign(di) && dp !== 0 && Math.abs(di) > 3 * Math.max(Math.abs(dm), Math.abs(dp));   // jump, then motion back
      if (i - 2 >= 0 && big && (against || reverses)) spikes.push(i); }
    if (spikes.length >= 1 && spikes.length <= 2 && spikes.every((i) => i > b + 2 && i < e - 2)) {
      const parts = []; let st = b; for (const i of spikes) { parts.push([st, i - 1], [i, i]); st = i + 1; } parts.push([st, e]); merged.splice(q, 1, ...parts); q += parts.length - 1;
    }
  }
  // known input boundaries (design §2 segmentation: "known input/retarget boundaries"; lab case M10 release): a motion
  // that continues through a pointer release is two segments, the drag and what the release started
  if (cuts.length) for (let q = 0; q < merged.length; q++) {
    const [b, e] = merged[q]; const c = cuts.find((j) => j > b + 1 && j <= e - 1);
    if (c != null) { merged.splice(q, 1, [b, c - 1], [c, e]); }
  }
  return merged.map(([b, e], j) => {
    const prevEnd = j ? merged[j - 1][1] : -1; const nextStart = j < merged.length - 1 ? merged[j + 1][0] : n;
    // contiguous segments (a jump split or an input cut) share the boundary frame: it is the next segment's start value
    const w0 = prevEnd === b - 1 && b > 0 ? b - 1 : Math.max(prevEnd + 1, b - 1 - Math.min(8, Math.floor((b - prevEnd - 1) / 2)));
    const w1 = Math.min(nextStart - 1, e + tailMax);
    const settled = e < n - 1 && (nextStart - e - 1 >= 2);
    const movingFrames = mv.slice(b, e + 1).filter(Boolean).length;
    return { b, e, w0, w1, settled, movingFrames, restBefore: b - 1 > prevEnd ? s.y[prevEnd + 1] : null,   // the rest value where the still run began (a slow ease-in creeps below the motion threshold before b: lab case M19 timer g3, rest 20 read as 20.0022)
      restAfter: settled ? s.y[Math.min(n - 1, e + 1)] : null };
  });
}

/**
 * Candidate retarget points inside a segment: spikes of the third difference (acceleration step) or second
 * difference (velocity step) well above the local smooth level.
 */
export const irregularFrame = (T, i) => { const dts = T.slice(1).map((t, j) => t - T[j]); const dmed = median(dts); for (let j = i - 3; j <= i + 1; j++) if (j > 0 && j < T.length && Math.abs(T[j] - T[j - 1] - dmed) > 0.25 * dmed) return true; return false; };

export function breakpoints(T, y, b, e, nf) {
  const out = []; if (e - b < 10) return out;
  const d1 = [], d2 = [], d3 = [];
  for (let i = b + 1; i <= e; i++) d1[i] = (y[i] - y[i - 1]) / (T[i] - T[i - 1]);
  for (let i = b + 2; i <= e; i++) d2[i] = d1[i] - d1[i - 1];
  for (let i = b + 3; i <= e; i++) d3[i] = d2[i] - d2[i - 1];
  const A = (i) => (d3[i] == null ? 0 : Math.abs(d3[i]));
  const dtm = (T[e] - T[b]) / (e - b); const floor = (12 * nf.sigma) / (dtm * dtm);   // 3rd difference of noise ~ σ·√20/dt²
  // frames next to an irregular frame period (an R5 stall, an rt hitch) make spikes of their own: never a retarget
  const dts = []; for (let i = b + 1; i <= e; i++) dts.push(T[i] - T[i - 1]); const dmed = median(dts);
  const irregular = (i) => { for (let j = i - 3; j <= i + 1; j++) if (j > 0 && j < T.length && Math.abs(T[j] - T[j - 1] - dmed) > 0.25 * dmed) return true; return false; };
  // a retarget steps the acceleration (spring) or the velocity (tween): an isolated |Δ³x| spike (a doublet for a
  // velocity step) far above the smooth level two to four frames away on both sides
  for (let i = b + 6; i <= e - 7; i++) {
    // pre-context must be smooth (6×); the new motion after a retarget may be vigorous, so post-context only 2×
    const v = A(i); let pre = 0, post = 0; for (const j of [i - 5, i - 4, i - 3, i - 2]) pre = Math.max(pre, A(j)); for (const j of [i + 4, i + 5, i + 6, i + 7]) post = Math.max(post, A(j));
    if (v > floor && v > 6 * pre && v > 2 * post && v >= A(i - 1) && v >= A(i + 1) && !irregular(i)) { if (!out.length || i - out.at(-1) > 3) out.push(i); }
  }
  return out;
}

/**
 * Retarget frames of a second-order (spring-like) motion, model-based: within a constant target the acceleration obeys
 * a = k(g − x) − c·v, so Δa = −k·Δx − c·Δv does not depend on g; (k, c) come from a trimmed regression of Δa on (Δx, Δv),
 * the implied target g_i = x_i + (a_i + c·v_i)/k is then piecewise constant and its steps are the retargets. Derivatives
 * use the actual frame times, so stalls (R5) are handled; frames whose differences straddle a stall are skipped.
 * Lab case M07 p400 at R4/R5: retargets every 400 ms land next to the 100 ms stalls, where the spike detector
 * (`breakpoints`) is blind, and leave a vigorous motion on both sides of each retarget.
 */
export function springRetargets(T, y, b, e, nf) {
  const out = []; if (e - b < 12) return out;
  const v = [], a = [];
  for (let i = b + 1; i <= e; i++) v[i] = (y[i] - y[i - 1]) / (T[i] - T[i - 1]);
  for (let i = b + 1; i < e; i++) { const h1 = T[i] - T[i - 1], h2 = T[i + 1] - T[i]; if (Math.abs(h1 - h2) > 1e-3 * Math.max(h1, h2)) continue; a[i] = (v[i + 1] - v[i]) / h1; }
  const vm = (i) => (v[i] + v[i + 1]) / 2;   // velocity at frame i (central)
  const rows = []; for (let i = b + 2; i < e - 1; i++) if (a[i] != null && a[i - 1] != null) rows.push({ i, da: a[i] - a[i - 1], dx: y[i] - y[i - 1], dv: vm(i) - vm(i - 1) });
  if (rows.length < 8) return out;
  let use = rows; let kc = null;
  for (let it = 0; it < 4; it++) {
    let sxx = 0, sxv = 0, svv = 0, sax = 0, sav = 0; for (const r of use) { sxx += r.dx * r.dx; sxv += r.dx * r.dv; svv += r.dv * r.dv; sax += r.da * r.dx; sav += r.da * r.dv; }
    const det = sxx * svv - sxv * sxv; if (!(Math.abs(det) > 0)) return out;
    const p = (sax * svv - sav * sxv) / det, q = (sav * sxx - sax * sxv) / det; kc = { k: -p, c: -q };
    const res = rows.map((r) => Math.abs(r.da - p * r.dx - q * r.dv)); const sorted = [...res].sort((x, z) => x - z); const cut = 3 * Math.max(sorted[Math.floor(0.5 * (sorted.length - 1))], 1e-12);
    use = rows.filter((_, j) => res[j] <= cut);
  }
  if (!kc || !(kc.k > 0)) return out;
  const g = []; for (let i = b + 1; i < e; i++) if (a[i] != null) g[i] = y[i] + (a[i] + kc.c * vm(i)) / kc.k;
  const idx = []; for (let i = b + 1; i < e; i++) if (g[i] != null) idx.push(i);
  const A = Math.max(...y.slice(b, e + 1)) - Math.min(...y.slice(b, e + 1)) || 1;
  const med = (arr) => { const z = [...arr].sort((p1, p2) => p1 - p2); return z[Math.floor((z.length - 1) / 2)]; };
  const dg = []; for (let j = 1; j < idx.length; j++) dg.push(Math.abs(g[idx[j]] - g[idx[j - 1]]));
  const noise = 1.4826 * med(dg) + 1e-12; const thr = Math.max(8 * noise, 0.05 * A);
  // a step between idx[j-1] and idx[j]: the median of the next 3 implied targets differs from the median of the previous
  // 3 by more than thr; the boundary with the largest jump within ±3 positions is kept (non-maximum suppression)
  const jump = (j) => (j >= 3 && j + 2 < idx.length ? Math.abs(med([g[idx[j]], g[idx[j + 1]], g[idx[j + 2]]]) - med([g[idx[j - 3]], g[idx[j - 2]], g[idx[j - 1]]])) : 0);
  for (let j = 3; j + 2 < idx.length; j++) {
    const J = jump(j); if (!(J > thr)) continue;
    let isMax = true; for (let d = -3; d <= 3; d++) if (d && (jump(j + d) > J || (jump(j + d) === J && d < 0))) isMax = false;
    if (!isMax) continue;
    // the central acceleration at frame i already sees a target switched in frame i+1: a contiguous boundary means the
    // switch is in frame idx[j] + 1; across a skipped (stall) frame the switch lies in the gap, at idx[j] at the latest
    const i = idx[j];
    if (i - b > 2 && i <= e) out.push(i);
  }
  return out;
}

/** Scroll/driver change frames (indices into rows) from the scroll channel and the input log. */
export function inputEvents(view, T, sy) {
  const ev = [];
  for (let i = 1; i < sy.length; i++) if (sy[i] !== sy[i - 1]) ev.push({ i, kind: 'scroll', from: sy[i - 1], to: sy[i] });
  for (const e of view.inputLog) if (e.type && e.type !== 'scrollTo') ev.push({ i: e.k != null ? T.findIndex((t, j) => j && view.rows[j].k > e.k) : -1, kind: e.type, entry: e });
  return ev.sort((a, b) => a.i - b.i);
}
