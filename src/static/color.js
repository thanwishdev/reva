// CSS colour strings as returned by getComputedStyle -> sRGB. Computed values are rgb()/rgba() for legacy colours and
// keep their own function for modern spaces (oklch(), oklab(), color(srgb ...), lab(), ...). We convert what we can and
// say so when we cannot: the caller tags the hex `inferred` (a conversion) and never invents one for an unsupported space.

const clamp01 = x => Math.min(1, Math.max(0, x));
const to8 = x => Math.round(clamp01(x) * 255);
const num = s => { s = String(s).trim(); return s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s); };
const hex2 = n => n.toString(16).padStart(2, '0');

function srgbEncode(c) { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

export function oklabToSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [srgbEncode(r), srgbEncode(g), srgbEncode(bl)];
}

/**
 * @returns {{r:number,g:number,b:number,a:number,space:string,exact:boolean}|null}
 *   r,g,b in 0..255 (rounded), a in 0..1. exact=false when the colour was converted from another space (rounded, gamut-clipped).
 */
export function parseColor(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0, space: 'srgb', exact: true };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    if (h.length === 6 || h.length === 8) return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? +(parseInt(h.slice(6, 8), 16) / 255).toFixed(4) : 1, space: 'srgb', exact: true };
    return null;
  }
  m = /^(rgba?|oklab|oklch|color)\((.*)\)$/.exec(s);
  if (!m) return null;
  const fn = m[1];
  const [body, alphaStr] = m[2].split('/').map(x => x.trim());
  const parts = body.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  let a = 1;
  if (fn === 'rgb' || fn === 'rgba') {
    if (parts.length === 4) a = num(parts[3]);
    else if (alphaStr != null) a = num(alphaStr);
    const ch = parts.slice(0, 3).map(p => p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p));
    if (ch.some(Number.isNaN)) return null;
    return { r: Math.round(ch[0]), g: Math.round(ch[1]), b: Math.round(ch[2]), a: +a.toFixed(4), space: 'srgb', exact: true };
  }
  if (alphaStr != null) a = num(alphaStr);
  if (fn === 'color') {
    if (parts[0] !== 'srgb' || parts.length < 4) return null; // display-p3 etc.: not converted here
    const ch = parts.slice(1, 4).map(num);
    return { r: to8(ch[0]), g: to8(ch[1]), b: to8(ch[2]), a: +a.toFixed(4), space: 'srgb', exact: false };
  }
  if (fn === 'oklab' || fn === 'oklch') {
    let L = num(parts[0]);
    if (parts[0].endsWith('%')) L = parseFloat(parts[0]) / 100;
    let c1 = parts[1].endsWith('%') ? parseFloat(parts[1]) / 100 * 0.4 : parseFloat(parts[1]);
    let c2 = parseFloat(parts[2]);
    if ([L, c1, c2].some(Number.isNaN)) return null;
    let A = c1, B = c2;
    if (fn === 'oklch') {
      const h = c2 * Math.PI / 180; // parseFloat drops a trailing 'deg'; turn/rad hues are not converted (computed values use deg)
      A = c1 * Math.cos(h); B = c1 * Math.sin(h);
    }
    const [r, g, b] = oklabToSrgb(L, A, B);
    return { r: to8(r), g: to8(g), b: to8(b), a: +a.toFixed(4), space: fn, exact: false };
  }
  return null;
}

export function toHex(c) {
  if (!c) return null;
  const base = '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
  return c.a < 1 ? base + hex2(Math.round(c.a * 255)) : base;
}
