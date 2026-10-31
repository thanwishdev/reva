// Named eases as exact functions (design §4.1): CSS keywords (bezier), Penner families, expo.out = 1 − 2^(−10p).
// Bezier evaluation uses our own A3-verified `cubicBezier` (D-M2-1 "Bezier source").
import { cubicBezier } from '../oracles.js';

const c1 = 1.70158, c2 = c1 * 1.525, c3 = c1 + 1;
const pow = (n) => ({ in: (p) => p ** n, out: (p) => 1 - (1 - p) ** n, inOut: (p) => (p < 0.5 ? 2 ** (n - 1) * p ** n : 1 - (-2 * p + 2) ** n / 2) });
const P = {
  sine: { in: (p) => 1 - Math.cos((p * Math.PI) / 2), out: (p) => Math.sin((p * Math.PI) / 2), inOut: (p) => -(Math.cos(Math.PI * p) - 1) / 2 },
  quad: pow(2), cubic: pow(3), quart: pow(4), quint: pow(5),
  expo: { in: (p) => (p <= 0 ? 0 : 2 ** (10 * p - 10)), out: (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
    inOut: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? 2 ** (20 * p - 10) / 2 : (2 - 2 ** (-20 * p + 10)) / 2) },
  circ: { in: (p) => 1 - Math.sqrt(1 - p * p), out: (p) => Math.sqrt(1 - (p - 1) ** 2),
    inOut: (p) => (p < 0.5 ? (1 - Math.sqrt(1 - (2 * p) ** 2)) / 2 : (Math.sqrt(1 - (-2 * p + 2) ** 2) + 1) / 2) },
  back: { in: (p) => c3 * p ** 3 - c1 * p * p, out: (p) => 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2,
    inOut: (p) => (p < 0.5 ? ((2 * p) ** 2 * ((c2 + 1) * 2 * p - c2)) / 2 : ((2 * p - 2) ** 2 * ((c2 + 1) * (p * 2 - 2) + c2) + 2) / 2) },
};
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** CSS keyword beziers. */
export const CSS_BEZIERS = { linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] };

/** name -> {fn(p) on [0,1] clamped, kind, bezier?} */
export const NAMED = {};
for (const [k, b] of Object.entries(CSS_BEZIERS)) NAMED[k] = { fn: k === 'linear' ? (p) => p : cubicBezier(...b), kind: 'css', bezier: b };
for (const [fam, o] of Object.entries(P)) for (const dir of ['in', 'out', 'inOut']) NAMED[`ease${cap(dir)}${cap(fam)}`] = { fn: o[dir], kind: 'penner', family: fam, dir };
NAMED['expo.out'] = NAMED.easeOutExpo;   // alias: GSAP name, same function

/** Evaluate an ease with clamping of p. */
export const easeAt = (fn, p) => (p <= 0 ? 0 : p >= 1 ? 1 : fn(p));

/** Parse a CSS/WAAPI easing string (keyword, cubic-bezier(), steps(), linear()) into a function, or null. */
export function parseEasing(s) {
  if (!s) return (p) => p; s = String(s).trim();
  if (CSS_BEZIERS[s]) return NAMED[s].fn;
  let m = /^cubic-bezier\(([^)]+)\)$/.exec(s);
  if (m) { const v = m[1].split(',').map(Number); if (v.length === 4 && v.every(Number.isFinite)) return cubicBezier(...v); return null; }
  m = /^steps\((\d+)\s*(?:,\s*([a-z-]+))?\)$/.exec(s);
  if (m) { const n = +m[1], pos = m[2] || 'end'; return (p) => { const jumpStart = pos === 'start' || pos === 'jump-start' || pos === 'jump-both'; const jumps = pos === 'jump-both' ? n + 1 : pos === 'jump-none' ? n - 1 : n;
    let c = Math.floor(p * n); if (jumpStart) c++; if (p >= 1) c = jumps; return Math.min(1, c / jumps); }; }
  if (s === 'step-start') return (p) => (p > 0 ? 1 : 0);
  if (s === 'step-end') return (p) => (p >= 1 ? 1 : 0);
  m = /^linear\((.+)\)$/.exec(s);
  if (m) {
    const stops = []; for (const part of m[1].split(',')) { const t = part.trim().split(/\s+/); const v = +t[0]; const ps = t.slice(1).map((x) => parseFloat(x) / 100); if (!ps.length) stops.push({ y: v, x: null }); else for (const x of ps) stops.push({ y: v, x }); }
    if (stops[0].x == null) stops[0].x = 0; if (stops[stops.length - 1].x == null) stops[stops.length - 1].x = 1;
    for (let i = 1; i < stops.length - 1; i++) if (stops[i].x == null) { let j = i; while (stops[j].x == null) j++; const a = stops[i - 1].x, b = stops[j].x; for (let q = i; q < j; q++) stops[q].x = a + ((b - a) * (q - i + 1)) / (j - i + 1); }
    return (p) => { if (p <= stops[0].x) return stops[0].y; for (let i = 1; i < stops.length; i++) if (p <= stops[i].x) { const a = stops[i - 1], b = stops[i]; return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (p - a.x)) / (b.x - a.x); } return stops[stops.length - 1].y; };
  }
  return null;
}

const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const PCT = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?%$/i;
const STEP_POS = new Set(['jump-start', 'jump-end', 'jump-none', 'jump-both', 'start', 'end']);
const KEYWORDS = new Set([...Object.keys(CSS_BEZIERS), 'step-start', 'step-end']);
const num = (s) => (NUM.test(s) ? +s : NaN);
const fmtN = (x) => String(+x.toPrecision(6));
/**
 * The CSS easing grammar, strictly: a keyword, cubic-bezier(4 numbers, x in 0..1), steps(n[, position]) or linear(number
 * [percent [percent]], ...). Returns the easing rebuilt from the parsed numbers (so no text of the page survives), or null
 * when the string is anything else. Easing strings are read in the page's main world, which page script can hook: only
 * this canonical form may reach generated code or tool text.
 */
export function canonicalEasing(s) {
  if (typeof s !== 'string') return null; const t = s.trim().toLowerCase(); if (t.length > 4000) return null;
  if (KEYWORDS.has(t)) return t;
  let m = /^cubic-bezier\(([^()]*)\)$/.exec(t);
  if (m) { const v = m[1].split(',').map((x) => num(x.trim())); return v.length === 4 && v.every(Number.isFinite) && v[0] >= 0 && v[0] <= 1 && v[2] >= 0 && v[2] <= 1 ? `cubic-bezier(${v.map(fmtN).join(', ')})` : null; }
  m = /^steps\(([^()]*)\)$/.exec(t);
  if (m) {
    const [a, b, ...more] = m[1].split(',').map((x) => x.trim()); const n = /^\d{1,6}$/.test(a || '') ? +a : NaN;
    if (more.length || !(n >= 1) || (b != null && !STEP_POS.has(b)) || (b === 'jump-none' && n < 2)) return null;
    return b == null ? `steps(${n})` : `steps(${n}, ${b})`;
  }
  m = /^linear\(([^()]*)\)$/.exec(t);
  if (m) {
    const parts = m[1].split(',').map((x) => x.trim().split(/\s+/)); if (parts.length < 2 || parts.length > 400) return null;
    const out = [];
    for (const p of parts) {
      if (!p.length || p.length > 3 || !Number.isFinite(num(p[0])) || !p.slice(1).every((x) => PCT.test(x))) return null;
      out.push([fmtN(num(p[0])), ...p.slice(1).map((x) => `${fmtN(parseFloat(x))}%`)].join(' '));
    }
    return `linear(${out.join(', ')})`;
  }
  return null;
}

/**
 * The easing a declared animation actually runs, from its effect easing and its keyframes' easings (a CSS animation's
 * animation-timing-function sits on every keyframe; getTiming().easing is then `linear`). Returns
 * {easing, source, segments?, why?}: easing is one canonical string when one curve describes the whole iteration, else
 * null with `segments` (one canonical easing per keyframe segment) and why. Strings outside the CSS grammar give null.
 */
export function effectiveEasing(effect, keyframes) {
  const eff = effect == null || effect === '' ? 'linear' : canonicalEasing(effect);
  if (eff == null) return { easing: null, source: 'effect', why: 'the declared easing is not a CSS easing' };
  const kfs = Array.isArray(keyframes) ? keyframes : [];
  const segs = kfs.slice(0, -1).map((k) => (k && k.easing != null && k.easing !== '' ? canonicalEasing(String(k.easing)) : 'linear'));
  if (segs.some((x) => x == null)) return { easing: null, source: 'keyframes', why: 'a keyframe easing is not a CSS easing' };
  const kfLinear = segs.every((x) => x === 'linear');
  if (kfLinear) return { easing: eff, source: 'effect' };
  const same = segs.every((x) => x === segs[0]);
  if (eff === 'linear' && same && segs.length === 1) return { easing: segs[0], source: 'keyframes' };
  if (eff === 'linear' && same) return { easing: null, source: 'keyframes', segments: segs, why: `each of the ${segs.length} keyframe segments runs ${segs[0]} on its own; no single curve over the iteration` };
  return { easing: null, source: 'effect+keyframes', segments: segs, effect: eff, why: eff === 'linear' ? 'the keyframe segments have different easings' : 'the effect easing and the keyframe easings compose; no single curve' };
}
