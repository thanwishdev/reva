// Declared keyframe values per channel: the number a CSS transition / CSS animation / Web Animation keyframe gives one
// sampled channel ('translateY(20%)' on ren:ty -> {v: 20, unit: '%', rel: true}; 'blur(10px)' on ren:filter -> {v: 10}).
// declared.js checks the samples against these values (a relative unit's px factor is solved) and, when they explain the
// samples, the record states them [exact]. Pure; no CSS engine: anything not parsed here stays fitted.

const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?';
const ABS_LEN = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16 };
const ANGLE = { deg: 1, rad: 180 / Math.PI, turn: 360, grad: 0.9 };
/** '20%' -> {v: 20, unit: '%'}; '0' -> {v: 0, unit: ''}; null for anything else. */
function dim(t) { const m = new RegExp(`^(${NUM})([a-z%]*)$`, 'i').exec(String(t).trim()); return m ? { v: +m[1], unit: m[2].toLowerCase() } : null; }
/** A length: absolute units in px ({v, unit: 'px'}), relative ones kept ({v, unit: '%', rel: true}); a bare 0 is unit-free. */
function length(t) {
  const d = dim(t); if (!d) return null;
  if (d.unit === '') return d.v === 0 ? { v: 0, unit: '' } : null;
  if (ABS_LEN[d.unit]) return { v: d.v * ABS_LEN[d.unit], unit: 'px' };
  return /^(%|r?em|ex|ch|r?lh|cap|ic|[sld]?v(w|h|i|b|min|max)|cq(w|h|i|b|min|max))$/.test(d.unit) ? { v: d.v, unit: d.unit, rel: true } : null;
}
function angle(t) { const d = dim(t); if (!d) return null; if (d.unit === '') return d.v === 0 ? 0 : null; return ANGLE[d.unit] ? d.v * ANGLE[d.unit] : null; }
function number(t) { const d = dim(t); if (!d) return null; return d.unit === '' ? d.v : d.unit === '%' ? d.v / 100 : null; }

/** 'translateY(20%) scale(1.2)' -> [{fn, args: [string]}]; 'none' -> []; null when not a plain function list. */
export function transformList(str) {
  const t = String(str == null ? '' : str).trim(); if (t === 'none') return [];
  const out = []; const re = /\s*([a-z][a-z0-9]*)\(([^()]*)\)\s*/giy; let m, at = 0;
  while ((m = re.exec(t))) { out.push({ fn: m[1], args: m[2].split(',').map((x) => x.trim()).filter((x) => x !== '') }); at = re.lastIndex; }
  return at === t.length && out.length ? out : null;
}

// 4x4 matrices as DOMMatrix fields (m11..m44, column-major as in CSS): only what a transform list needs
const I = () => ({ m11: 1, m12: 0, m13: 0, m14: 0, m21: 0, m22: 1, m23: 0, m24: 0, m31: 0, m32: 0, m33: 1, m34: 0, m41: 0, m42: 0, m43: 0, m44: 1 });
function mul(A, B) { // A · B (B applied first to a point, as a CSS list left to right)
  const r = {}; for (let i = 1; i <= 4; i++) for (let j = 1; j <= 4; j++) { let s = 0; for (let k = 1; k <= 4; k++) s += A[`m${k}${j}`] * B[`m${i}${k}`]; r[`m${i}${j}`] = s; }
  return r;
}
/**
 * One transform function as a matrix, its translation lengths in px. A relative translation (`translateY(20%)`) is not
 * a matrix here: `rel` carries it ({x, y} lengths), the matrix part is identity. null for a function not handled.
 */
function fnMatrix(f) {
  const M = I(); const a = f.args; const n = a.length; const L = (i) => (i < n ? length(a[i]) : { v: 0, unit: '' });
  const tr = (x, y, z) => { if (!x || !y || !z) return null; const rel = [x, y, z].some((q) => q.rel && q.v !== 0); if (rel) return { M, rel: { x, y, z } }; M.m41 = x.v; M.m42 = y.v; M.m43 = z.v; return { M }; };
  switch (f.fn.toLowerCase()) {
    case 'matrix': { if (n !== 6) return null; const v = a.map(Number); if (v.some((x) => !Number.isFinite(x))) return null; Object.assign(M, { m11: v[0], m12: v[1], m21: v[2], m22: v[3], m41: v[4], m42: v[5] }); return { M }; }
    case 'matrix3d': { if (n !== 16) return null; const v = a.map(Number); if (v.some((x) => !Number.isFinite(x))) return null; let q = 0; for (let i = 1; i <= 4; i++) for (let j = 1; j <= 4; j++) M[`m${i}${j}`] = v[q++]; return { M }; }
    case 'translate': return n >= 1 && n <= 2 ? tr(L(0), L(1), { v: 0, unit: '' }) : null;
    case 'translatex': return n === 1 ? tr(L(0), { v: 0, unit: '' }, { v: 0, unit: '' }) : null;
    case 'translatey': return n === 1 ? tr({ v: 0, unit: '' }, L(0), { v: 0, unit: '' }) : null;
    case 'translatez': { const z = L(0); return n === 1 && z && !z.rel ? tr({ v: 0, unit: '' }, { v: 0, unit: '' }, z) : null; }
    case 'translate3d': { const z = L(2); return n === 3 && z && !z.rel ? tr(L(0), L(1), z) : null; }
    case 'scale': case 'scalex': case 'scaley': case 'scalez': case 'scale3d': {
      const v = a.map(number); if (!n || v.some((x) => x == null)) return null; const fn = f.fn.toLowerCase();
      if (fn === 'scale') { if (n > 2) return null; M.m11 = v[0]; M.m22 = n > 1 ? v[1] : v[0]; }
      else if (fn === 'scalex') M.m11 = v[0]; else if (fn === 'scaley') M.m22 = v[0]; else if (fn === 'scalez') M.m33 = v[0];
      else { if (n !== 3) return null; M.m11 = v[0]; M.m22 = v[1]; M.m33 = v[2]; }
      return { M };
    }
    case 'rotate': case 'rotatez': { const g = n === 1 ? angle(a[0]) : null; if (g == null) return null; const r = (g * Math.PI) / 180; M.m11 = Math.cos(r); M.m12 = Math.sin(r); M.m21 = -Math.sin(r); M.m22 = Math.cos(r); return { M }; }
    case 'skew': case 'skewx': case 'skewy': {
      const fn = f.fn.toLowerCase(); const ax = angle(a[0]), ay = fn === 'skew' && n > 1 ? angle(a[1]) : 0; if (ax == null || ay == null || n < 1 || n > 2) return null;
      if (fn === 'skewy') M.m12 = Math.tan((ax * Math.PI) / 180); else { M.m21 = Math.tan((ax * Math.PI) / 180); M.m12 = Math.tan((ay * Math.PI) / 180); }
      return { M };
    }
    default: return null;
  }
}
/** The recorder's decomposition (src/record/inpage.js decompose), on a matrix: [tx, ty, tz, sx, sy, rz, skx]. */
export function decomposeMatrix(m) {
  const a = m.m11, b = m.m12, c = m.m21, d = m.m22; const det = a * d - b * c; let sx = Math.hypot(a, b);
  const flipX = det < 0 && a < 0; const skew = sx ? (Math.atan2(a * c + b * d, sx * sx) * 180) / Math.PI : 0; if (flipX) sx = -sx;
  const rot = (Math.atan2(flipX ? -b : b, flipX ? -a : a) * 180) / Math.PI;
  const sy = sx ? det / sx : Math.hypot(c, d);
  return [m.m41, m.m42, m.m43, sx, sy, rot, skew];
}
const TF = ['tx', 'ty', 'tz', 'sx', 'sy', 'rz', 'skx'];

/**
 * One matrix channel (tx .. skx) of a transform value: {v, unit, rel?}. A relative translation counts only at the head of
 * the list (translateY(20%) rotate(...): the translation of the whole is the head's); a relative one later is not one length.
 */
function transformChannel(str, c) {
  const list = transformList(str); if (!list) return null;
  const parts = list.map(fnMatrix); if (parts.some((p) => !p)) return null;
  const i = TF.indexOf(c);
  if (i >= 3) { let M = I(); for (const p of parts) M = mul(M, p.M); return { v: decomposeMatrix(M)[i], unit: '' }; }
  // translation: relative head terms, then the matrix of the rest (absolute)
  const ax = ['x', 'y', 'z'][i]; let k = 0; const head = [];
  while (k < parts.length && parts[k].rel) head.push(parts[k++].rel[ax]);
  if (parts.slice(k).some((p) => p.rel)) return null;
  let M = I(); for (const p of parts.slice(k)) M = mul(M, p.M);
  // the head's own absolute translations (translate(10px, 20%)) sit in rel too
  const terms = [...head.filter((q) => q.v !== 0)]; const restV = M[`m4${i + 1}`];
  const units = [...new Set(terms.map((q) => (q.rel ? q.unit : 'px')))];
  if (units.length > 1) return null;
  if (!units.length) return { v: restV, unit: 'px' };
  if (units[0] === 'px') return { v: terms.reduce((s, q) => s + q.v, 0) + restV, unit: 'px' };
  if (Math.abs(restV) > 1e-9) return null;   // a relative head plus a px translation later: not one length
  return { v: terms.reduce((s, q) => s + q.v, 0), unit: units[0], rel: true };
}

// the identity value of a filter function (`filter: none` in a keyframe of a blur animation is blur(0))
const FILTER_ID = { blur: 0, brightness: 1, contrast: 1, grayscale: 0, 'hue-rotate': 0, invert: 0, opacity: 1, saturate: 1, sepia: 0 };
function filterValue(str, form) {
  if (!form || !form.fn) return null; const t = String(str).trim();
  if (t === 'none') { const id = FILTER_ID[form.fn]; return id == null ? null : { v: form.unit === '%' && id === 1 ? 100 : id, unit: '' }; }
  const m = new RegExp(`^([a-z-]+)\\(\\s*(${NUM})([a-z%]*)\\s*\\)$`, 'i').exec(t); if (!m || m[1].toLowerCase() !== form.fn) return null;
  const unit = m[3].toLowerCase(); let v = +m[2];
  if (unit === form.unit) return { v, unit: '' };
  // the computed form may read another unit than the keyframe ('50%' vs 0.5, 'turn' vs 'deg')
  if (form.unit === '' && unit === '%') return { v: v / 100, unit: '' }; if (form.unit === '%' && unit === '') return { v: v * 100, unit: '' };
  if (ANGLE[form.unit] && ANGLE[unit]) { v = (v * ANGLE[unit]) / ANGLE[form.unit]; return { v, unit: '' }; }
  if (form.unit === 'px' && ABS_LEN[unit]) return { v: v * ABS_LEN[unit], unit: '' };
  return null;
}
/** Individual transform properties by axis: translate '0px 20%' / scale '1 1.2' / rotate '45deg' | 'z 45deg'. */
function individual(prop, str, axis) {
  const t = String(str).trim(); if (t === 'none') return { v: prop === 'scale' ? 1 : 0, unit: '' };
  const p = t.split(/\s+/);
  if (prop === 'rotate') { const g = p.length === 1 ? angle(p[0]) : p.length === 2 && /^z$/i.test(p[0]) ? angle(p[1]) : null; return g == null ? null : { v: g, unit: '' }; }
  const i = { x: 0, y: 1, z: 2 }[axis || 'x']; if (p.length > 3) return null;
  if (prop === 'scale') { const v = p.map(number); if (v.some((x) => x == null)) return null; const s = [v[0], p.length > 1 ? v[1] : v[0], p.length > 2 ? v[2] : 1][i]; return { v: s, unit: '' }; }
  const L = p.map(length); if (L.some((x) => !x)) return null; const q = i < L.length ? L[i] : { v: 0, unit: '' };
  return q.rel && q.v !== 0 ? { v: q.v, unit: q.unit, rel: true } : { v: q.v, unit: 'px' };
}

/**
 * The declared value of a channel at each keyframe: [{v, unit, rel?} | undefined (the keyframe does not name the property:
 * an implicit end, the computed value)], or null when the channel is not handled or any named value does not parse.
 * @param {string} ch      channel ('ren:ty', 'ren:opacity', 'ren:filter', 'ren:translate.y', 'drv:opacity')
 * @param {object|null} form  the series' value form (filter: {fn: 'blur', unit: 'px'})
 * @param {object[]} kfs   getKeyframes() of the birth
 */
export function keyframeChannelValues(ch, form, kfs) {
  if (!Array.isArray(kfs) || !kfs.length) return null;
  const c0 = String(ch || '').replace(/^(ren|drv):/, ''); const [c, axis] = c0.split('.');
  let prop, read;
  if (c === 'opacity') { prop = 'opacity'; read = (v) => { const n = number(v); return n == null ? null : { v: n, unit: '' }; }; }
  else if (c === 'filter') { prop = 'filter'; read = (v) => filterValue(v, form); }
  else if (TF.includes(c) && !axis) { prop = 'transform'; read = (v) => transformChannel(v, c); }
  else if (['translate', 'scale', 'rotate'].includes(c)) { prop = c; read = (v) => individual(c, v, axis); }
  else return null;
  const out = kfs.map((k) => { const raw = k ? k[prop] : undefined; return raw == null || raw === '' ? undefined : read(typeof raw === 'number' ? String(raw) : raw); });
  if (out.some((x) => x === null) || out.every((x) => x === undefined)) return null;
  return out;
}
