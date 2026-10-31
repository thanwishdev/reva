// Mutation test (review F3 layer 3): corrupt N captured values in a rebuild artifact; the gate must fail on each.
// Operators target values the capture holds: inline declarations (alter a colour channel, a length, a keyword, or
// reset a non-initial value to its initial value), generated pseudo-element rules, and @font-face families.
// Every mutant is a real change (no equivalent mutants by construction: the new text always differs).

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

// prop -> how to mutate. 'init' writes the initial value where the captured value differs from it (a plain delete
// can be equivalent: the UA sheet may supply the same value, e.g. dialog{position:absolute}).
const OPS = [
  { p: 'color', op: 'rgb' }, { p: 'background-color', op: 'rgb' }, { p: 'border-top-color', op: 'rgb' },
  { p: 'width', op: 'px' }, { p: 'height', op: 'px' }, { p: 'margin-top', op: 'px' }, { p: 'padding-left', op: 'px' },
  { p: 'font-size', op: 'px' }, { p: 'line-height', op: 'px' }, { p: 'letter-spacing', op: 'px' }, { p: 'border-top-left-radius', op: 'px' },
  { p: 'font-weight', op: 'kw', alt: ['400', '700', '500'] }, { p: 'text-align', op: 'kw', alt: ['start', 'center', 'right'] },
  { p: 'opacity', op: 'num' }, { p: 'z-index', op: 'kw', alt: ['auto', '1', '2'] },
  { p: 'display', op: 'init', initial: 'inline' }, { p: 'position', op: 'init', initial: 'static' }, { p: 'box-sizing', op: 'init', initial: 'content-box' },
];

// ::marker accepts only a few properties (font, colour, content, white-space ...): others would be equivalent mutants.
const MARKER_OK = new Set(['color', 'font-size', 'font-weight', 'line-height']);

function mutateValue(op, v, r) {
  if (op.op === 'init') return op.initial;
  if (op.op === 'rgb') {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(.*)\)$/.exec(v); if (!m) return null;
    const c = Number(m[1]); const n = c >= 250 ? c - 3 : c + 3;
    return v.replace(/^(rgba?\()(\d+)/, `$1${n}`);
  }
  if (op.op === 'px') { const m = /^(-?[\d.]+)px$/.exec(v); if (!m) return null; return `${+(Number(m[1]) + 2).toFixed(3)}px`; }
  if (op.op === 'num') { const n = Number(v); if (!Number.isFinite(n)) return null; return String(n > 0.5 ? +(n - 0.2).toFixed(3) : +(n + 0.2).toFixed(3)); }
  if (op.op === 'kw') { const alt = op.alt.filter(a => a !== v); return alt[Math.floor(r() * alt.length)]; }
  return null;
}

/** All mutable sites in an artifact HTML: [{start, end, prop, value, op, where}] (start/end = value span). */
export function mutationSites(html) {
  const sites = [];
  const decl = (text, base, where) => {
    for (const m of text.matchAll(/(^|;)([a-z-]+):([^;]*)/g)) {
      const op = OPS.find(o => o.p === m[2]); if (!op) continue;
      const vs = base + m.index + m[1].length + m[2].length + 1;
      const val = m[3].replace(/&quot;/g, '"');
      if (op.op === 'init' && val === op.initial) continue;
      if (where === '::marker' && !MARKER_OK.has(m[2])) continue;
      sites.push({ start: vs, end: vs + m[3].length, prop: m[2], value: val, op, where });
    }
  };
  for (const m of html.matchAll(/\sstyle="([^"]*)"/g)) decl(m[1], m.index + 8, 'inline');
  for (const m of html.matchAll(/<style data-wr-gen>([\s\S]*?)<\/style>/g)) {
    const base = m.index + '<style data-wr-gen>'.length;
    for (const r of m[1].matchAll(/::(before|after|marker)\{([^}]*)\}/g)) decl(r[2], base + r.index + r[1].length + 3, `::${r[1]}`);
    for (const f of m[1].matchAll(/@font-face \{[^}]*?font-family: ("?)([^";]+)\1;/g)) sites.push({ prop: 'font-family', value: f[2], op: { op: 'family' }, where: '@font-face' });
  }
  return sites;
}

/**
 * Make n mutants of one artifact HTML. Mix: up to 2 @font-face, up to 3 pseudo rules, the rest inline declarations.
 * @returns {{id:number, html:string, desc:string}[]}
 */
export function makeMutants(html, n = 20, seed = 20261016, { usedFamilies = null } = {}) {
  const r = rng(seed);
  const all = mutationSites(html).filter(s => s.op.op === 'family' || s.op.op === 'kw' || mutateValue(s.op, s.value, () => 0) !== null);
  // font families: one site per family, only families some element actually uses (else the mutant is equivalent)
  const fam = new Map(); for (const s of all) if (s.op.op === 'family' && (!usedFamilies || usedFamilies.some(u => u.includes(s.value)))) fam.set(s.value, s);
  const pick = (list, k) => { const out = [], used = new Set(); for (let t = 0; out.length < k && t < k * 50 && list.length; t++) { const i = Math.floor(r() * list.length); if (!used.has(i)) { used.add(i); out.push(list[i]); } } return out; };
  const fonts = [...fam.values()], pseudo = all.filter(s => s.where.startsWith('::')), inline = all.filter(s => s.where === 'inline');
  const chosen = [...pick(fonts, Math.min(2, n)), ...pick(pseudo, 3)];
  // spread inline picks across operator kinds so the set is not 20 colour tweaks
  const byProp = new Map(); for (const s of inline) { if (!byProp.has(s.prop)) byProp.set(s.prop, []); byProp.get(s.prop).push(s); }
  const props = [...byProp.keys()];
  for (let t = 0; chosen.length < n && t < n * 50; t++) { const p = props[Math.floor(r() * props.length)]; const [s] = pick(byProp.get(p), 1); if (s && !chosen.includes(s)) chosen.push(s); }
  const out = [];
  for (const s of chosen.slice(0, n)) {
    if (s.op.op === 'family') {
      // rename the family in every @font-face rule of it: elements using it must fall back to another font
      const re = new RegExp(`(@font-face \\{[^}]*?font-family: "?)${s.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}("?;)`, 'g');
      out.push({ id: out.length + 1, html: html.replace(re, `$1${s.value}-wrmut$2`), desc: `@font-face family "${s.value}" renamed` });
      continue;
    }
    const nv = mutateValue(s.op, s.value, r);
    if (nv === null || nv === undefined) continue;
    const enc = nv.replace(/"/g, '&quot;');
    out.push({ id: out.length + 1, html: html.slice(0, s.start) + enc + html.slice(s.end), desc: `${s.where} ${s.prop}: ${s.value.slice(0, 60)} -> ${nv.slice(0, 60)}` });
  }
  return out;
}
