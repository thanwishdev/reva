// REVA design summary: the static layer's record (src/static, one browser session) -> a short, structured, content-free
// description of how the page is designed: fonts and their roles, type scale, palette with roles and contrast, spacing,
// radii, shadows, layout (content widths, columns, section rhythm), breakpoints and hover / focus changes.
// Used by `reva look` (look.json "design"), `reva design`, the MCP design tool, the token export and the card.
//
// Every value is {value, unit?, label}: label "exact" = the page's own CSS declaration (the winning declaration, checked
// against the computed value by src/static/cdpcss.js), "measured" = what the browser computed / laid out at this viewport,
// "derived" = our arithmetic on measured values (a ratio, a contrast, a role). Content-free: no page text (text nodes,
// pseudo-element content, alt text, aria names), no images, no font files, no URLs, no selectors. Element tags (h1, a, p)
// say where a style is used. The page's own names (font families, custom properties, CSS declarations) pass a strict
// character check first; whatever fails it is left out and counted.
import { parseColor, toHex } from '../static/color.js';
import { parseShadowList } from '../static/shadow.js';
import { transitionsFor } from '../static/transition.js';

export const DESIGN_SCHEMA = 'reva.design/0';
export const LABELS = {
  exact: 'read from the page CSS: the winning declaration, checked against the computed value',
  measured: 'computed by the browser at this viewport (computed styles and layout boxes)',
  derived: 'our arithmetic on measured values (a ratio, a contrast, a role, a base unit)',
};

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const pxOf = (s) => (typeof s === 'string' && /^-?[\d.]+(e[+-]?\d+)?px$/.test(s) ? parseFloat(s) : null);
/** A value with its unit and label (unit omitted for unitless values). */
export const q = (value, unit, label, extra = {}) => ({ value, ...(unit ? { unit } : {}), label, ...extra });
const tally = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const topObj = (m, n = 6) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, n));

// ---------- strict checks on the page's own names ----------
const SAFE_CSS = /^[a-zA-Z0-9#.,%()+\-*/ _]+$/;
/** A CSS value or declaration text the summary may carry: plain value grammar only (no quotes, url(), escapes). */
export function safeCss(t, max = 80) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s && s.length <= max && SAFE_CSS.test(s) && !/url\(|image\(|attr\(|expression\(|element\(/i.test(s) ? s : null;
}
/** A font family name: letters, digits, space, dot, dash, underscore; quotes stripped. */
export function safeFamily(t) {
  const s = String(t ?? '').trim().replace(/^["']|["']$/g, '').trim();
  return /^[\p{L}\p{N} _.-]{1,60}$/u.test(s) ? s : null;
}
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont']);
export const isGeneric = (f) => GENERIC.has(String(f).toLowerCase());
// A media query: the media query grammar only, with known feature names and value keywords (the query text is the page's
// own CSS, so free words inside parentheses must not pass as a "feature").
const MQ_FEATURES = new Set(('width height aspect-ratio orientation resolution hover pointer any-hover any-pointer prefers-color-scheme prefers-reduced-motion '
  + 'prefers-contrast prefers-reduced-transparency prefers-reduced-data forced-colors color color-gamut color-index monochrome display-mode scan grid update '
  + 'overflow-block overflow-inline dynamic-range video-dynamic-range inverted-colors scripting device-width device-height device-aspect-ratio '
  + '-webkit-device-pixel-ratio -webkit-transform-3d -moz-touch-enabled -ms-high-contrast').split(' '));
const MQ_WORDS = new Set(('portrait landscape dark light reduce no-preference fine coarse none hover more less custom high standard p3 srgb rec2020 '
  + 'standalone fullscreen minimal-ui browser picture-in-picture window-controls-overlay enabled initial-only progressive interlace slow fast paged '
  + 'optional-paged scroll inverted active black-on-white white-on-black').split(' '));
const MQ_OUTSIDE = new Set(['only', 'not', 'and', 'or', 'all', 'screen', 'print', 'speech', ',', 'x']);
const MQ_VALUE = /^(-?[\d.]+(e-?\d+)?(px|em|rem|dpi|dpcm|dppx|x|vw|vh)?|\d+ ?\/ ?\d+)$/;
const mqFeature = (f) => MQ_FEATURES.has(f.replace(/^(min|max)-/, '').replace(/^-webkit-(min|max)-/, '-webkit-'));
function mqGroup(g) {
  const s = g.trim(); if (!s) return false;
  if (/^[a-z-]+$/.test(s)) return mqFeature(s) || s === 'x';
  let m = /^([a-z-]+)\s*:\s*(.+)$/.exec(s);
  if (m) return mqFeature(m[1]) && (MQ_VALUE.test(m[2].trim()) || MQ_WORDS.has(m[2].trim()));
  // range syntax: (width >= 600px), (400px <= width < 700px)
  const parts = s.split(/\s*(<=|>=|<|>|=)\s*/).filter((x) => x !== '');
  if (parts.length < 3) return false;
  return parts.every((x, i) => (i % 2 ? /^(<=|>=|<|>|=)$/.test(x) : mqFeature(x) || MQ_VALUE.test(x))) && parts.some((x, i) => i % 2 === 0 && mqFeature(x));
}
export const safeQuery = (t) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 160 || !/^[a-zA-Z0-9 ():,.\-<>=/]+$/.test(s)) return null;
  let rest = s.toLowerCase(); let prev;
  do { prev = rest; rest = rest.replace(/\(([^()]*)\)/g, (all, g) => (mqGroup(g) ? ' x ' : ' \u0000 ')); } while (rest !== prev && !rest.includes('\u0000'));
  if (rest.includes('\u0000') || /[()]/.test(rest)) return null;
  return rest.replace(/,/g, ' , ').split(/\s+/).filter(Boolean).every((w) => MQ_OUTSIDE.has(w)) ? s : null;
};
// The element vocabulary a tag may be reported by: HTML and SVG names (lowercased, as the in-page reader writes them).
// A custom element's name is the page's own word (it can say anything): it reads "custom-element"; anything else "element".
const KNOWN_TAGS = new Set(('html head body main header footer nav section article aside div span p a h1 h2 h3 h4 h5 h6 hgroup ul ol li dl dt dd '
  + 'figure figcaption blockquote q cite pre code kbd samp var small strong em b i u s mark sub sup time abbr address br hr wbr '
  + 'img picture source video audio track canvas iframe embed object map area svg math table caption thead tbody tfoot tr th td col colgroup '
  + 'form fieldset legend label input button select option optgroup textarea output progress meter datalist details summary dialog menu search '
  + 'slot template noscript bdi bdo data del ins ruby rt rp center font marquee '
  + 'g path circle rect ellipse line polyline polygon text tspan textpath use defs symbol lineargradient radialgradient stop clippath mask pattern '
  + 'filter foreignobject image marker title desc switch view').split(/\s+/));
/** An element tag: a known HTML / SVG name; a custom element (any hyphenated name) reads "custom-element", anything else "element". */
export const safeTag = (t) => { const s = String(t ?? '').toLowerCase(); return KNOWN_TAGS.has(s) ? s : /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(s) ? 'custom-element' : 'element'; };

// ---------- strict grammars for measured values ----------
// Measured values are read in the page's own world (getComputedStyle), which a hostile page can patch: each one must match
// the grammar of its property, or it is withheld and counted (never passed on as words).
const W = { n: 0 };
/** font-weight: a number from 1 to 1000. */
export const safeWeight = (v) => { const x = Number(v); return Number.isFinite(x) && x >= 1 && x <= 1000 && /^\s*[\d.]+\s*$/.test(String(v)) ? x : (W.n++, null); };
/** text-transform keywords (and the two that combine). */
export const safeTransform = (v) => (/^(none|capitalize|uppercase|lowercase|full-width|full-size-kana|math-auto)( (full-width|full-size-kana))*$/.test(String(v ?? '').trim()) ? String(v).trim() : (W.n++, null));
/** font-style: normal, italic or oblique (with an angle). */
export const safeFontStyle = (v) => (/^(normal|italic|oblique( -?[\d.]+deg)?)$/.test(String(v ?? '').trim()) ? String(v).trim() : (W.n++, null));
/** One corner radius: one or two lengths in px or %. */
export const safeRadius = (v) => (/^-?[\d.]+(e[+-]?\d+)?(px|%)( -?[\d.]+(e[+-]?\d+)?(px|%))?$/.test(String(v ?? '').trim()) ? String(v).trim() : (W.n++, null));
const safeVar = (n) => (/^--[A-Za-z0-9_-]{1,60}$/.test(String(n)) ? n : null);

function splitFamilies(stack) {
  const out = []; let cur = ''; let qch = null;
  for (const c of String(stack || '')) {
    if (qch) { if (c === qch) qch = null; else cur += c; continue; }
    if (c === '"' || c === "'") { qch = c; continue; }
    if (c === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---------- colour ----------
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
export const contrastRatio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (top, under) => {
  const a = top.a + under.a * (1 - top.a); if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (k) => Math.round((top[k] * top.a + under[k] * under.a * (1 - top.a)) / a);
  return { r: mix('r'), g: mix('g'), b: mix('b'), a };
};
const hexOf = (c) => toHex({ ...c, a: c.a == null ? 1 : c.a });
function hsl(c) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const l = (mx + mn) / 2;
  const s = mx === mn ? 0 : l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
  return { s, l };
}
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

// ---------- the declared (exact) layer of a static token ----------
/** The one declaration text a token's property was set by, when every row agrees and it was checked; else null. */
function exactCss(token, prop) {
  const re = prop instanceof RegExp ? prop : new RegExp(`^${prop}$`);
  const ds = (token && token.declared || []).filter((d) => (d.props || String(d.prop || '').split(',')).some((p) => re.test(p)));
  if (!ds.length || ds.some((d) => d.verified === false)) return null;
  const texts = [...new Set(ds.map((d) => String(d.value).replace(/\s+/g, ' ').trim()))];
  return texts.length === 1 ? safeCss(texts[0]) : null;
}
/** label + css for a property of a token: exact when the page's declaration is known and plain, else measured. */
const lab = (token, prop) => { const css = exactCss(token, prop); return css ? { label: 'exact', css } : { label: 'measured' }; };
/** q() labelled from a token's declared layer. */
const ql = (value, unit, token, prop, extra = {}) => { const l = lab(token, prop); return q(value, unit, l.label, { ...(l.css ? { css: l.css } : {}), ...extra }); };

// ---------- element rows ----------
function rowsView(data) {
  const ix = Object.fromEntries((data.props || []).map((p, i) => [p, i]));
  const get = (r, p) => (ix[p] == null ? undefined : data.styles[r.s][ix[p]]);
  const byId = new Map(data.rows.map((r) => [r.id, r]));
  const kids = new Map(); for (const r of data.rows) if (r.parent != null && !r.pseudo) { const k = kids.get(r.parent) || []; k.push(r); kids.set(r.parent, k); }
  return { rows: data.rows, get, byId, kids };
}
const roleOfTag = (t) => (/^h[1-6]$/.test(t) ? 'heading' : t === 'a' ? 'link' : /^(button|input|select|textarea|label|summary|option)$/.test(t) ? 'control'
  : /^(li|dt|dd)$/.test(t) ? 'list' : /^(small|figcaption|caption|sup|sub|time|code|pre|kbd|cite)$/.test(t) ? 'small print' : 'text');

// ---------- sections of the summary ----------
function typography(V, tokens, maxStyles) {
  const groups = new Map();
  for (const r of V.rows) {
    if (!r.rendered || r.pseudo || !r.text) continue;
    const k = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform'].map((p) => V.get(r, p)).join('|');
    const g = groups.get(k) || { k, rows: 0, tags: new Map(), lhUsed: new Set() }; g.rows++; tally(g.tags, safeTag(r.tag)); if (r.lhUsed != null) g.lhUsed.add(r.lhUsed); groups.set(k, g);
  }
  const tokOf = new Map((tokens.typography || []).map((t) => [[t.fontFamily, t.fontSize, t.fontWeight, t.fontStyle, t.lineHeight, t.letterSpacing, t.textTransform].map((x) => x && x.value).join('|'), t]));
  const list = [...groups.values()].sort((a, b) => b.rows - a.rows);
  // body size: the size most text elements use (headings and controls aside)
  // (paragraphs and list items first: a page of display spans has no body copy in them)
  const sizeBy = (re, below = Infinity) => { const m = new Map(); for (const g of list) { if (!(pxOf(g.k.split('|')[1]) < below)) continue; const n = [...g.tags].filter(([t]) => re.test(t)).reduce((x, [, c]) => x + c, 0); if (n) tally(m, pxOf(g.k.split('|')[1]), n); } return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };
  // (a giant display line set in a <p> is not reading text: sizes of 40 px and up count only when nothing smaller exists)
  const bodyPx = sizeBy(/^(p|li|dd|blockquote)$/, 40) ?? sizeBy(/^(p|li|dd|blockquote)$/) ?? sizeBy(/^(?!h[1-6]$|a$|button$|input$|select$|textarea$|label$|summary$|option$)/);
  // which styles are kept: the display end of the scale and the h1-h3 styles first (one hero h1 is the most telling style
  // of a page and the rarest), then the most used; listed largest first (ids t1, t2 ... in that order)
  const sizeOf = (g) => pxOf(g.k.split('|')[1]) ?? -1;
  const keep = new Set(); const reserve = Math.ceil(maxStyles / 2);
  const bySize = [...list].sort((a, b) => sizeOf(b) - sizeOf(a) || b.rows - a.rows); const seenSize = new Set();
  for (const g of bySize) { if (seenSize.size >= 4 || keep.size >= reserve) break; if (sizeOf(g) < 0 || seenSize.has(sizeOf(g))) continue; seenSize.add(sizeOf(g)); keep.add(g); }
  for (const t of ['h1', 'h2', 'h3']) { const g = list.find((x) => x.tags.has(t)); if (g && keep.size < reserve) keep.add(g); }
  for (const g of list) { if (keep.size >= maxStyles) break; keep.add(g); }
  const kept = [...keep].sort((a, b) => sizeOf(b) - sizeOf(a) || b.rows - a.rows);
  const styles = kept.map((g, i) => {
    const [fam, size, weight, fstyle, lh, ls, tt] = g.k.split('|'); const tok = tokOf.get(g.k);
    const sizePx = pxOf(size), lhPx = pxOf(lh), lsPx = pxOf(ls);
    const roles = new Map(); for (const [t, c] of g.tags) tally(roles, roleOfTag(t), c);
    let role = [...roles].sort((a, b) => b[1] - a[1])[0][0];
    if (role === 'text' && bodyPx && sizePx >= 1.6 * bodyPx) role = 'display';
    const fams = splitFamilies(fam); const family = safeFamily(fams[0]);
    // the used value behind line-height: normal, from text-only boxes; a box shorter than ~0.8 of the font size (clipped,
    // collapsed or zero-height) gives nonsense and is dropped; several different values mean no single used value
    const lhUsed = [...g.lhUsed].filter((x) => sizePx && x >= 0.8 * sizePx && x <= 4 * sizePx);
    const s = {
      id: `t${i + 1}`, family: family || null, ...(family ? {} : { familyWithheld: true }),
      size: sizePx != null ? ql(r2(sizePx), 'px', tok, 'font-size') : (W.n++, q(null, null, 'measured', { withheld: true })),
      weight: ql(safeWeight(weight), null, tok, 'font-weight'),
      lineHeight: lhPx != null ? ql(r2(lhPx), 'px', tok, 'line-height', sizePx ? { ratio: q(r4(lhPx / sizePx), null, 'derived') } : {})
        : q('normal', null, 'measured', new Set(lhUsed).size === 1 ? { used: q(lhUsed[0], 'px', 'measured'), ratio: q(r4(lhUsed[0] / sizePx), null, 'derived') } : {}),
      letterSpacing: lsPx != null ? ql(r4(lsPx), 'px', tok, 'letter-spacing', sizePx ? { em: q(r4(lsPx / sizePx), 'em', 'derived') } : {})
        : q('normal', null, 'measured', { em: q(0, 'em', 'derived') }),
      ...(tt && tt !== 'none' ? { transform: q(safeTransform(tt), null, 'measured') } : {}),
      ...(fstyle && fstyle !== 'normal' ? { style: q(safeFontStyle(fstyle), null, 'measured') } : {}),
      count: g.rows, usedOn: topObj(g.tags), role,
    };
    return s;
  });
  const sizes = new Map(); for (const g of list) { const p = pxOf(g.k.split('|')[1]); if (p != null) tally(sizes, r2(p), g.rows); }
  return {
    styles, more: Math.max(0, list.length - styles.length), order: 'largest size first', bodySize: bodyPx != null ? q(r2(bodyPx), 'px', 'derived') : null,
    scale: [...sizes].sort((a, b) => b[0] - a[0]).map(([v, c]) => ({ size: q(v, 'px', 'measured'), count: c })),
  };
}

function fonts(V, record, styles) {
  const fam = new Map();
  for (const r of V.rows) {
    if (!r.rendered || r.pseudo || !r.text) continue;
    const stack = splitFamilies(V.get(r, 'font-family')); const first = stack[0]; if (!first) continue;
    const e = fam.get(first) || { stack, weights: new Set(), styles: new Set(), roles: new Map(), count: 0 };
    e.count++; e.weights.add(safeWeight(V.get(r, 'font-weight'))); e.styles.add(V.get(r, 'font-style')); tally(e.roles, roleOfTag(safeTag(r.tag))); fam.set(first, e);
  }
  const declared = (record.assets && record.assets.fonts && record.assets.fonts.declaredFaces) || [];
  const faces = new Set(declared.map((f) => String(f.family && f.family.value || '').toLowerCase()));
  // FontFace.status of each declared face, by family: 'loaded' on any face means the webfont drew text
  const status = new Map(); for (const f of declared) { const k = String(f.family && f.family.value || '').toLowerCase(); const st = f.status && f.status.value; if (!status.has(k)) status.set(k, new Set()); if (/^(unloaded|loading|loaded|error)$/.test(String(st))) status.get(k).add(String(st)); }
  const used = (record.variants[0].fontsUsed || []);
  // the faces the browser drew each family's elements with: CDP platform fonts name example elements by selector
  const bySel = new Map(); for (const r of V.rows) if (r.sel && !r.pseudo) bySel.set(r.sel, r);
  const drawn = new Map(); // family (lower case) -> Map(face -> {custom, glyphs})
  for (const f of used) {
    // a webfont face with no usable name (CDP reports '.') still proves a custom face drew the element
    const named = safeFamily(f.familyName); const face = named && named !== '.' ? named : f.isCustomFont ? '' : null; if (face == null) continue;
    for (const ex of f.examples || []) {
      const r = bySel.get(ex); if (!r) continue;
      const first = String(splitFamilies(V.get(r, 'font-family'))[0] || '').toLowerCase(); if (!first) continue;
      const m = drawn.get(first) || new Map(); const e = m.get(face) || { custom: false, glyphs: 0 };
      e.custom = e.custom || !!f.isCustomFont; e.glyphs = Math.max(e.glyphs, f.glyphCount || 0); m.set(face, e); drawn.set(first, m);
    }
  }
  let withheld = 0;
  const families = [...fam].sort((a, b) => b[1].count - a[1].count).map(([first, e]) => {
    const family = safeFamily(first); if (!family) { withheld++; return null; }
    const generic = isGeneric(family);
    const key = family.toLowerCase(); const webfont = faces.has(key);
    const st = status.get(key) || new Set(); const dm = drawn.get(key) || new Map();
    const faceList = [...dm].sort((a, b) => b[1].glyphs - a[1].glyphs);
    // a declared webfont did not draw: no face of it loaded (error / unloaded) and no custom face drew its elements,
    // or every face that drew its elements is a platform (non-custom) font
    const anyCustom = faceList.some(([, x]) => x.custom);
    const loadedState = !webfont ? null : anyCustom || st.has('loaded') ? true : faceList.length || st.has('error') || st.has('unloaded') ? false : null;
    const failed = loadedState === false;
    const drawnAs = failed ? faceList.filter(([n, x]) => !x.custom && n).map(([n]) => n).slice(0, 4) : null;
    return {
      family, fallbacks: e.stack.slice(1).map(safeFamily).filter(Boolean).slice(0, 6),
      source: failed ? q('declared webfont that did not load (text drawn with a fallback face)', null, 'measured')
        : q(webfont ? 'webfont' : generic ? 'generic family (the system picks the face)' : 'system or local font (no @font-face for it)', null, webfont ? 'exact' : 'measured'),
      ...(webfont ? { loaded: loadedState, faceStatus: [...st].sort() } : {}),
      ...(failed ? { drawnAs } : {}),
      weights: [...e.weights].filter((w) => w != null).sort((a, b) => a - b), styles: [...e.styles].map((s) => safeFontStyle(s)).filter(Boolean),
      roles: topObj(e.roles), elements: e.count, label: 'measured',
    };
  }).filter(Boolean);
  const rendered = used.map((f) => ({ name: safeFamily(f.familyName), custom: !!f.isCustomFont })).filter((f) => f.name && f.name !== '.');
  const notLoaded = families.filter((f) => f.loaded === false).length;
  return { families, rendered: rendered.slice(0, 12), ...(notLoaded ? { notLoaded } : {}), ...(withheld ? { withheld } : {}),
    note: 'rendered = the faces the browser actually drew text with (CDP platform fonts); a webfont that failed to load shows up as its fallback here. loaded false: the declared webfont did not draw, so every text metric (line-height normal, wrapping, widths, breakpoint edges) was measured with the fallback face in drawnAs' };
}

/** seen(row): opacity above 0 and visibility not hidden, up the ancestor chain. */
function seenOf(V) {
  const memo = new Map();
  const seen = (r) => {
    if (!r) return true; if (memo.has(r.id)) return memo.get(r.id);
    const v = !(parseFloat(V.get(r, 'opacity')) === 0) && V.get(r, 'visibility') !== 'hidden' && seen(r.parent != null ? V.byId.get(r.parent) : null);
    memo.set(r.id, v); return v;
  };
  return seen;
}


/**
 * The page background: the root canvas colour (CSS propagates html's background, else body's, to the canvas).
 * Transparent html and body: the browser's default canvas, white in the light scheme the design pass pins.
 */
function pageBackground(V) {
  const html = V.rows.find((r) => r.tag === 'html' && !r.pseudo); const body = V.rows.find((r) => r.tag === 'body' && !r.pseudo);
  const read = (r) => { const c = r && parseColor(V.get(r, 'background-color')); return c && c.a > 0 ? c : null; };
  const img = (r) => { const b = r && V.get(r, 'background-image'); return !!(b && b !== 'none'); };
  const from = read(html) || img(html) ? 'html' : read(body) || img(body) ? 'body' : null;
  const c = from === 'html' ? read(html) : from === 'body' ? read(body) : null;
  if (!c) return { hex: q('#ffffff', null, 'derived'), from: 'browser default canvas', ...(from ? { image: true } : {}), note: from ? `the ${from} element has a CSS image or gradient and no background colour; the canvas under it is white` : 'html and body are transparent: the browser default canvas (white in the light scheme)' };
  const opaque = c.a >= 1 ? c : over(c, WHITE);
  return { hex: q(hexOf(opaque), null, c.a >= 1 ? 'measured' : 'derived'), from, ...(img(from === 'html' ? html : body) ? { image: true } : {}), ...(c.a < 1 ? { note: `translucent (alpha ${r2(c.a)}) over the white canvas` } : {}) };
}

/**
 * Visible background area per opaque colour, rasterised onto a coarse grid of the page in (simplified) paint order
 * (see paintContext). Each cell takes the colour of the last opaque box whose (overflow-clipped) rect holds the cell centre; cells no box covers show the
 * canvas. So a box hides exactly what it covers, nothing is counted twice and the shares add up to 1.
 */
function paintedArea(V, seen, pw, ph, rootBox) {
  if (!(pw > 0 && ph > 0)) return { share: new Map(), canvas: 0, cell: null };
  const cell = Math.max(4, Math.ceil(Math.sqrt((pw * ph) / 200000)));
  const cols = Math.max(1, Math.ceil(pw / cell)), rowsN = Math.max(1, Math.ceil(ph / cell));
  const grid = new Int32Array(cols * rowsN).fill(-1); // -1 = canvas
  const clipMemo = new Map(); const ALL = [-Infinity, -Infinity, Infinity, Infinity];
  const inter = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  // the clip a box's descendants get: its own clip, narrowed to its box when overflow is not visible
  const clipFor = (r) => {
    if (!r) return ALL; if (clipMemo.has(r.id)) return clipMemo.get(r.id);
    const p = r.parent != null ? V.byId.get(r.parent) : null;
    let c = V.get(r, 'position') === 'fixed' ? ALL : clipFor(p);
    const clips = (o) => o && o !== 'visible';
    if (r.rect && (clips(V.get(r, 'overflow-x')) || clips(V.get(r, 'overflow-y')))) c = inter(c, [r.rect[0], r.rect[1], r.rect[0] + r.rect[2], r.rect[1] + r.rect[3]]);
    clipMemo.set(r.id, c); return c;
  };
  // paint order (CSS 2 appendix E, simplified): within a stacking context its own background, then layers with a
  // negative z-index, then normal-flow boxes in DOM order, then layers with z-index auto or 0 in DOM order, then
  // positive z-index. A layer (positioned, or with a z-index) paints its whole subtree in its own turn.
  const zOf = (r) => { const z = parseInt(V.get(r, 'z-index'), 10); return Number.isFinite(z) ? z : null; };
  const isLayer = (r) => { const pos = V.get(r, 'position'); return (pos && pos !== 'static') || zOf(r) != null; };
  const order = [];
  const paintContext = (root) => {
    const flow = [], layers = [];
    const collect = (r) => { for (const k of V.kids.get(r.id) || []) { if (isLayer(k)) layers.push(k); else { flow.push(k); collect(k); } } };
    order.push(root); collect(root);
    const z = (r) => zOf(r) || 0; const dom = (a, b) => domIx.get(a) - domIx.get(b);
    for (const l of layers.filter((r) => z(r) < 0).sort((a, b) => z(a) - z(b) || dom(a, b))) paintContext(l);
    for (const f of flow) order.push(f);
    for (const l of layers.filter((r) => z(r) >= 0).sort((a, b) => z(a) - z(b) || dom(a, b))) paintContext(l);
  };
  const domIx = new Map(V.rows.map((r, i) => [r, i]));
  for (const r of V.rows) if (!r.pseudo && (r.parent == null || !V.byId.has(r.parent))) paintContext(r);
  const boxes = [];
  for (const r of order) {
    if (!r.rendered || r.pseudo || !r.rect || r === rootBox || !seen(r)) continue;
    const c = parseColor(V.get(r, 'background-color')); if (!(c && c.a >= 1)) continue;
    const p = r.parent != null ? V.byId.get(r.parent) : null; const cl = V.get(r, 'position') === 'fixed' ? ALL : clipFor(p);
    const b = inter([r.rect[0], r.rect[1], r.rect[0] + r.rect[2], r.rect[1] + r.rect[3]], inter(cl, [0, 0, pw, ph]));
    if (b[2] > b[0] && b[3] > b[1]) boxes.push({ raw: V.get(r, 'background-color'), b });
  }
  const raws = []; const idx = new Map();
  for (const x of boxes) {
    let k = idx.get(x.raw); if (k == null) { k = raws.length; raws.push(x.raw); idx.set(x.raw, k); }
    // cells whose centre (col + 0.5) * cell lies in [b0, b2)
    const c0 = Math.max(0, Math.ceil(x.b[0] / cell - 0.5)), c1 = Math.min(cols, Math.ceil(x.b[2] / cell - 0.5));
    const r0 = Math.max(0, Math.ceil(x.b[1] / cell - 0.5)), r1 = Math.min(rowsN, Math.ceil(x.b[3] / cell - 0.5));
    if (c1 <= c0) continue;
    for (let y = r0; y < r1; y++) grid.fill(k, y * cols + c0, y * cols + c1);
  }
  const cells = new Float64Array(raws.length + 1); for (let j = 0; j < grid.length; j++) cells[grid[j] + 1]++;
  const share = new Map(raws.map((raw, k) => [raw, cells[k + 1] / grid.length]));
  return { share, canvas: cells[0] / grid.length, cell };
}

function palette(V, tokens, maxColours, page) {
  const seen = seenOf(V);
  const pw = page.width || 0, ph = page.height || 0;
  const C = new Map(); // raw -> {uses, count, share}
  const add = (raw, use) => {
    if (!raw || raw === 'none' || raw === 'currentcolor') return null; const pc = parseColor(raw); if (!pc || pc.a === 0) return null;
    const e = C.get(raw) || { raw, pc, uses: new Map(), count: 0, share: 0 }; e.count++; tally(e.uses, use); C.set(raw, e); return e;
  };
  const pageBg = pageBackground(V);
  let skipped = 0;
  for (const r of V.rows) {
    if (!r.rendered || r.pseudo) continue;
    const b = r.rect; const inPage = b && Math.min(b[0] + b[2], pw) > Math.max(b[0], 0) && Math.min(b[1] + b[3], ph) > Math.max(b[1], 0);
    if (!inPage || !seen(r)) { skipped++; continue; } // zero-size, off the page or not seen: paints nothing
    if (r.text) add(V.get(r, 'color'), 'text');
    add(V.get(r, 'background-color'), 'background');
    for (const s of ['top', 'right', 'bottom', 'left']) if ((pxOf(V.get(r, `border-${s}-width`)) || 0) > 0 && V.get(r, `border-${s}-style`) !== 'none') { add(V.get(r, `border-${s}-color`), 'border'); break; }
    if (/^(path|circle|rect|ellipse|line|polyline|polygon|text|svg|use)$/.test(r.tag)) { add(V.get(r, 'fill'), 'graphic'); if (V.get(r, 'stroke') !== 'none') add(V.get(r, 'stroke'), 'graphic'); }
  }
  // the root element whose background CSS hands to the canvas paints the whole page, not its own (maybe shorter) box
  const rootBox = pageBg.from ? V.rows.find((r) => r.tag === pageBg.from && !r.pseudo) : null;
  const area = paintedArea(V, seen, pw, ph, rootBox);
  for (const [raw, sh] of area.share) { const e = C.get(raw); if (e) e.share += sh; }
  // the canvas paints the page background wherever no opaque box covers it
  const pageHex = pageBg.hex.value; let canvasE = [...C.values()].find((e) => e.pc.a >= 1 && hexOf(e.pc) === pageHex);
  if (!canvasE && area.canvas > 0) { canvasE = { raw: pageHex, pc: parseColor(pageHex), uses: new Map(), count: 0, share: 0 }; C.set(pageHex, canvasE); }
  if (canvasE) canvasE.share += area.canvas;
  const tokOf = new Map((tokens.colors || []).map((t) => [t.raw && t.raw.value, t]));
  const all = [...C.values()].filter((e) => e.count > 0 || e.share > 0).sort((a, b) => b.count - a.count);
  const topOf = (use) => all.filter((e) => e.uses.has(use)).sort((a, b) => b.uses.get(use) - a.uses.get(use))[0];
  const mainText = topOf('text'), mostUsedBg = topOf('background');
  // main background: the opaque colour that paints the most visible area (translucent overlays never count)
  const byArea = all.filter((e) => e.pc.a >= 1 && e.share > 0).sort((a, b) => b.share - a.share);
  const mainBg = byArea[0] || null;
  // always listed: the main background, the main text and every colour that paints a tenth of the page or more, even
  // when it is used once (one large panel); the lowest-count others make room within the cap
  const must = new Set([mainBg, mainText, ...byArea.filter((e) => e.share >= 0.1)].filter(Boolean));
  const rest = all.filter((e) => !must.has(e)).slice(0, Math.max(0, maxColours - must.size));
  const shown = all.filter((e) => must.has(e) || rest.includes(e));
  const colours = shown.map((e, i) => {
    const main = e.uses.size ? [...e.uses].sort((a, b) => b[1] - a[1])[0][0] : 'background';
    const { s, l } = hsl(e.pc);
    const vivid = s >= 0.4 && l >= 0.2 && l <= 0.85 && e.pc.a >= 0.5;
    const share = e.share;
    // a colour that paints much of the page is a surface even when SVG fills or text outnumber it; only the main
    // background has the role background (other colours used mainly as backgrounds are surfaces)
    const role = e === mainBg ? 'background' : e.pc.a >= 1 && share >= 0.1 ? 'surface' : vivid && e !== mainText ? 'accent' : main === 'background' ? 'surface' : main;
    const l2 = lab(tokOf.get(e.raw), main === 'text' ? 'color' : main === 'background' ? 'background-color' : main === 'border' ? /^border-(top|right|bottom|left)-color$/ : /^(fill|stroke)$/);
    return { id: `c${i + 1}`, hex: q(hexOf(e.pc), null, e.count ? l2.label : 'derived', { ...(e.count && l2.css ? { css: l2.css } : {}), ...(e.pc.exact ? {} : { converted: true }) }), alpha: r2(e.pc.a), role, roleLabel: 'derived',
      uses: topObj(e.uses), count: e.count, ...(share > 0 ? { backgroundShare: q(r2(share), null, 'derived') } : {}) };
  });
  return {
    colours, more: Math.max(0, all.length - shown.length),
    pageBackground: pageBg,
    mainBackground: mainBg ? hexOf(mainBg.pc) : null,
    mostUsedBackground: mostUsedBg ? hexOf(mostUsedBg.pc) : null,
    mainText: mainText ? hexOf(mainText.pc) : null,
    ...(skipped ? { notPainted: skipped } : {}),
    note: `pageBackground: the root canvas colour (html, else body, else the white default). mainBackground: the opaque background colour that paints the most visible page area (the page is rasterised in paint order, so a box hides what it covers and the shares of all opaque colours plus the canvas add up to 1; translucent colours never count). Role background: the main background only; other colours used mainly as backgrounds are surfaces. mostUsedBackground: the background colour on the most elements. mainText: the text colour on the most elements. Zero-size, off-page and unseen elements are not counted (notPainted). backgroundShare: visible background area / page area, read on a grid of ${area.cell || 0} px cells (boxes smaller than a cell may get none)`,
  };
}

const MEDIA_TAGS = /^(img|video|canvas|picture|svg|iframe|embed|object)$/;
/** Text colour against the background it sits on (DOM ancestors' background colours). */
function contrast(V, maxPairs) {
  const pairs = new Map(); let overImage = 0, overMedia = 0, noBackground = 0, overlapped = 0, hidden = 0, checked = 0;
  // seen: opacity above 0 and visibility not hidden, up the ancestor chain (text faded out for a later reveal is not graded)
  const seen = seenOf(V);
  // boxes that can sit under text without being its ancestor (positioned media, a hero block, an overlay): media,
  // CSS background images and opaque background colours of visible, rendered elements
  const under = [];
  for (const r of V.rows) {
    if (!r.rendered || r.pseudo || !r.rect || !(r.rect[2] * r.rect[3] > 0)) continue;
    const bi = V.get(r, 'background-image'); const bg = parseColor(V.get(r, 'background-color'));
    const kind = MEDIA_TAGS.test(r.tag) ? 'media' : bi && bi !== 'none' ? 'image' : bg && bg.a >= 1 ? 'colour' : null;
    if (kind && seen(r)) under.push({ r, kind, bg: kind === 'colour' ? hexOf(bg) : null });
  }
  const isAncestor = (a, r) => { for (let c = r; c; c = c.parent != null ? V.byId.get(c.parent) : null) if (c === a) return true; return false; };
  /** The strongest non-ancestor box under at least half of the text box: media > image > another colour; else null. */
  const covering = (r, ancestorBg) => {
    const b = r.rect; const area = b[2] * b[3]; if (!(area > 0)) return null; let best = null;
    for (const u of under) {
      const m = u.r.rect;
      const w = Math.min(b[0] + b[2], m[0] + m[2]) - Math.max(b[0], m[0]); const h = Math.min(b[1] + b[3], m[1] + m[3]) - Math.max(b[1], m[1]);
      if (!(w > 0 && h > 0 && w * h >= 0.5 * area)) continue;
      if (u.kind === 'colour' && u.bg === ancestorBg) continue;
      if (isAncestor(u.r, r) || isAncestor(r, u.r)) continue;
      if (u.kind === 'media') return 'media'; if (u.kind === 'image') best = 'image'; else if (!best) best = 'colour';
    }
    return best;
  };
  for (const r of V.rows) {
    if (!r.rendered || r.pseudo || !r.text) continue;
    const fg = parseColor(V.get(r, 'color')); if (!fg || fg.a === 0) continue;
    if (!seen(r)) { hidden++; continue; }
    const layers = []; let img = false;
    for (let cur = r; cur; cur = cur.parent != null ? V.byId.get(cur.parent) : null) {
      const bi = V.get(cur, 'background-image'); if (bi && bi !== 'none') { img = true; break; }
      const bg = parseColor(V.get(cur, 'background-color')); if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
    }
    if (img) { overImage++; continue; }
    // no ancestor sets a background colour: the white we would assume is not something the page said (not graded)
    if (!layers.length) { noBackground++; continue; }
    const cov = r.rect ? covering(r, hexOf(layers[layers.length - 1])) : null;
    if (cov === 'media') { overMedia++; continue; }
    if (cov === 'image') { overImage++; continue; }
    if (cov === 'colour') { overlapped++; continue; }
    checked++;
    let bg = WHITE; for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    const text = over(fg, bg); const ratio = contrastRatio(text, bg);
    const size = pxOf(V.get(r, 'font-size')) || 0; const weight = Number(V.get(r, 'font-weight')) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const k = `${hexOf(text)}|${hexOf(bg)}`;
    const e = pairs.get(k) || { text: hexOf(text), background: hexOf(bg), ratio, count: 0, smallest: Infinity, allLarge: true }; e.count++; e.smallest = Math.min(e.smallest, size); e.allLarge = e.allLarge && large; pairs.set(k, e);
  }
  const grade = (e) => (e.ratio >= 7 ? 'AAA' : e.ratio >= 4.5 ? 'AA' : e.ratio >= 3 && e.allLarge ? 'AA (large text only)' : 'fails AA');
  const all = [...pairs.values()].map((e) => ({ text: e.text, background: e.background, ratio: q(r2(e.ratio), ':1', 'derived'), grade: grade(e), count: e.count, smallestSize: q(r2(e.smallest), 'px', 'measured') }));
  const failing = all.filter((p) => p.grade === 'fails AA');
  const top = all.sort((a, b) => b.count - a.count).slice(0, maxPairs);
  for (const f of failing.sort((a, b) => b.count - a.count)) if (!top.includes(f) && top.length < maxPairs + 4) top.push(f);
  return { pairs: top, more: Math.max(0, all.length - top.length), textElements: checked, failingPairs: failing.length, failingElements: failing.reduce((n, p) => n + p.count, 0), overImage, overMedia, overlapped, noBackground, hidden,
    note: 'WCAG 2 contrast of the text colour over the background colours of its DOM ancestors; graded only where an ancestor sets a background colour and nothing else lies under the text. Not graded, only counted: text over a CSS background image or gradient, its own or another box\'s under at least half of the text (overImage); text at least half over an img, video, canvas, svg or iframe box (overMedia); text at least half over another element\'s opaque background of a different colour, e.g. a positioned hero or header (overlapped); text with no background colour on any ancestor (noBackground); text at opacity 0 or visibility hidden (hidden). Not detected: mix-blend-mode, filters, a text shadow that carries the contrast' };
}

function spacing(tokens, maxValues) {
  const sc = (tokens.spacing && tokens.spacing.scale) || [];
  const pos = sc.filter((s) => s.px.value > 0);
  const top = [...pos].sort((a, b) => b.count - a.count).slice(0, maxValues).sort((a, b) => a.px.value - b.px.value);
  const base = tokens.spacing && tokens.spacing.base;
  return {
    values: top.map((s) => { const l = lab(s, /^(margin|padding)-(top|right|bottom|left)$|^(row|column)-gap$/); return { ...q(r2(s.px.value), 'px', l.label, l.css ? { css: l.css } : {}), count: s.count, by: s.byProperty }; }),
    more: Math.max(0, pos.length - top.length), negative: sc.filter((s) => s.px.value < 0).reduce((n, s) => n + s.count, 0),
    base: base && base.provenance === 'inferred' ? q(base.value, 'px', 'derived', { coverage: base.coverage ?? undefined }) : null,
    note: 'margins, paddings and gaps of rendered elements, values over 256 px left out; base = the largest of 8 / 4 / 2 px that divides at least 85 % of the distinct values',
  };
}

function radii(tokens, max) {
  const list = (tokens.radii || []).filter((t) => t.renderedCount > 0).sort((a, b) => b.renderedCount - a.renderedCount);
  return { values: list.slice(0, max).map((t) => {
    const c = t.corners.value; const l = lab(t, /^border-(top|bottom)-(left|right)-radius$/); const v = c['top-left'];
    const one = t.uniform ? (pxOf(v) != null ? q(r2(pxOf(v)), 'px', l.label) : /^[\d.]+%$/.test(v) ? q(parseFloat(v), '%', l.label) : q(safeRadius(v), null, l.label)) : null;
    return { ...(one || { corners: Object.fromEntries(Object.entries(c).map(([k, x]) => [k, safeRadius(x)])), label: l.label }), ...(l.css ? { css: l.css } : {}), count: t.renderedCount };
  }), more: Math.max(0, list.length - max) };
}

function shadows(tokens, max) {
  const list = (tokens.shadows || []).filter((t) => t.renderedCount > 0).sort((a, b) => b.renderedCount - a.renderedCount);
  return { values: list.slice(0, max).map((t) => {
    const layers = parseShadowList(t.raw.value, { text: t.kind === 'text' }) || [];
    const l = lab(t, t.kind === 'text' ? 'text-shadow' : 'box-shadow');
    return { kind: t.kind, label: l.label, ...(l.css ? { css: l.css } : {}), count: t.renderedCount, layers: layers.map((y) => { const pc = parseColor(y.color); return { x: y.x, y: y.y, blur: y.blur, ...(t.kind === 'box' ? { spread: y.spread, inset: !!y.inset } : {}), color: pc ? hexOf(pc) : null, unit: 'px' }; }) };
  }), more: Math.max(0, list.length - max) };
}

function layout(V, variant) {
  const vw = variant.viewport.value.width, vh = variant.viewport.value.height;
  const rect = (r) => (r.rect ? { x: r.rect[0], y: r.rect[1], w: r.rect[2], h: r.rect[3] } : null);
  const blocks = V.rows.filter((r) => r.rendered && !r.pseudo && r.rect && !/^(inline|contents|none)$/.test(V.get(r, 'display')));
  // content widths: blocks narrower than the viewport, centred in it (equal space left and right)
  const widths = new Map();
  for (const r of blocks) { const b = rect(r); if (b.w >= 320 && b.w <= vw - 2 && Math.abs(b.x - (vw - b.x - b.w)) <= 2) tally(widths, Math.round(b.w)); }
  const containers = [...widths].sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, 5).map(([w, c]) => ({ width: q(w, 'px', 'measured'), count: c }));
  // columns: CSS grids (computed track list) and flex rows (rendered children side by side)
  const grids = new Map(); const flexes = new Map();
  for (const r of blocks) {
    const d = V.get(r, 'display'); const kids = (V.kids.get(r.id) || []).filter((k) => k.rendered && k.rect && k.rect[2] > 0);
    const gap = pxOf(V.get(r, 'column-gap'));
    if (/grid/.test(d)) {
      const tracks = String(V.get(r, 'grid-template-columns') || '').split(/\s+/).filter((x) => pxOf(x) != null);
      if (tracks.length < 2) continue;
      const k = `${tracks.length}|${gap ?? ''}|${tracks.map((x) => Math.round(pxOf(x))).join(' ')}`;
      const e = grids.get(k) || { columns: tracks.length, tracks: tracks.map((x) => r2(pxOf(x))), gap, count: 0 }; e.count++; grids.set(k, e);
    } else if (/flex/.test(d) && /^row/.test(V.get(r, 'flex-direction') || 'row') && kids.length >= 2) {
      const ys = new Set(kids.map((k) => Math.round(k.rect[1]))); if (ys.size !== 1) continue; // one line of items
      const k = `${kids.length}|${gap ?? ''}`; const e = flexes.get(k) || { items: kids.length, gap, count: 0 }; e.count++; flexes.set(k, e);
    }
  }
  // sections: the element whose children stack the most full-width blocks (>= 90 % of the viewport, >= 120 px tall)
  let best = null;
  for (const [pid, ks] of V.kids) {
    const full = ks.filter((k) => k.rendered && k.rect && k.rect[2] >= 0.9 * vw && k.rect[3] >= 120);
    if (full.length >= 2 && (!best || full.length > best.list.length)) best = { pid, list: full };
  }
  let sections = null;
  if (best) {
    const list = best.list.sort((a, b) => a.rect[1] - b.rect[1]);
    const pads = new Map(); for (const s of list) { const t = pxOf(V.get(s, 'padding-top')), b = pxOf(V.get(s, 'padding-bottom')); if (t) tally(pads, `${r2(t)}|${r2(b || 0)}`); }
    const gaps = list.slice(1).map((s, i) => r2(s.rect[1] - (list[i].rect[1] + list[i].rect[3])));
    const [pad] = [...pads].sort((a, b) => b[1] - a[1]);
    sections = {
      count: list.length, in: V.byId.get(best.pid) ? safeTag(V.byId.get(best.pid).tag) : null, label: 'measured', unit: 'px',
      heights: list.map((s) => r2(s.rect[3])), gapsBetween: gaps,
      padding: pad ? { top: Number(pad[0].split('|')[0]), bottom: Number(pad[0].split('|')[1]), sections: pad[1] } : null,
      tags: topObj((() => { const m = new Map(); for (const s of list) tally(m, safeTag(s.tag)); return m; })()),
    };
  }
  return {
    viewport: { width: vw, height: vh, unit: 'px' }, documentHeight: q(variant.document.value.scrollHeight, 'px', 'measured'),
    containers, grids: [...grids.values()].sort((a, b) => b.count - a.count).slice(0, 8).map((g) => ({ columns: g.columns, tracks: g.tracks, gap: g.gap, unit: 'px', count: g.count, label: 'measured' })),
    flexRows: [...flexes.values()].sort((a, b) => b.count - a.count).slice(0, 8).map((f) => ({ items: f.items, gap: f.gap, unit: 'px', count: f.count, label: 'measured' })),
    sections,
  };
}

// A query's width edges are found in a small test frame of its own (src/static/breakpoints.js queryEdges): right for
// width features, wrong for height, orientation and aspect-ratio, whose edge depends on the real viewport height.
const WIDTH_TERM = /(^|[^-\w])((min|max)-)?width\b|\bwidth\s*[<>=]|[<>=]\s*width\b/i;
const HEIGHT_TERM = /\b(height|orientation|aspect-ratio)\b/i;
export const queryKind = (t) => (HEIGHT_TERM.test(t) ? (WIDTH_TERM.test(t) ? 'width and height' : 'not width') : WIDTH_TERM.test(t) ? 'width' : 'not width');

export function breakpoints(record) {
  const bp = record.breakpoints || {}; const range = bp.range || {};
  let withheld = 0; const val = (x) => (x && typeof x === 'object' ? x.value : x);
  const declared = (bp.declaredQueries || []).filter((d) => (d.widthEdges || []).length).map((d) => {
    const query = safeQuery(val(d.query)); if (!query) { withheld++; return null; }
    const kind = queryKind(query); if (kind === 'not width') return null; // no width edge: an orientation / height query
    const from = d.query.kind === 'css' ? 'css' : 'js matchMedia';
    if (kind === 'width and height') return { query, from, edges: [], dependsOnHeight: true, unit: 'px', label: 'measured' };
    return { query, from, edges: d.widthEdges.map((e) => val(e.firstNew) ?? val(e.lastOld)).filter((x) => x != null), unit: 'px', label: 'exact' };
  }).filter(Boolean);
  const edges = bp.edges || [];
  const reflow = edges.filter((e) => e.explanation && e.explanation.value === 'reflow').length;
  let continuous = edges.filter((e) => e.explanation && e.explanation.unknown === 'unk_breakpoint_continuous').length;
  const raw = edges.filter((e) => !(e.explanation && (e.explanation.value === 'reflow' || e.explanation.unknown === 'unk_breakpoint_continuous'))).map((e) => {
    // only width queries explain a width edge (an orientation / aspect-ratio "edge" comes from the test frame's height)
    const by = [...new Set((e.explainedBy || []).map((b) => safeQuery(val(b))).filter((x) => x && queryKind(x) === 'width'))];
    return { at: val(e.firstNew), unit: 'px', label: 'measured', ...(by.length ? { query: by[0], queries: by, queryLabel: 'exact' } : { query: null }) };
  }).filter((e) => e.at != null).sort((a, b) => a.at - b.at);
  // the sweep probes t-1, t, t+1 around every query edge: inside fluid sizing each of those differs from the next, which
  // reads as a run of 1 px "edges". A run of edges no more than 2 px apart is one change: the explained edge if the run
  // has one, else fluid sizing (counted with continuous, not a breakpoint)
  const runs = []; for (const e of raw) { const last = runs[runs.length - 1]; if (last && e.at - last[last.length - 1].at <= 2) last.push(e); else runs.push([e]); }
  const layoutEdges = []; let merged = 0;
  for (const run of runs) {
    if (run.length === 1) { layoutEdges.push(run[0]); continue; }
    const ex = run.filter((e) => e.query);
    if (ex.length) { layoutEdges.push(...ex); merged += run.length - ex.length; } else continuous += run.length;
  }
  return { layoutChanges: layoutEdges, declared, reflowOnly: range.reflowEdgesSearched === false ? null : reflow, continuous, merged, range: { from: range.from ?? null, to: range.to ?? null, step: range.step ?? null, unit: 'px' }, ...(withheld ? { withheld } : {}),
    note: 'layoutChanges = widths where the layout changes (width sweep + binary search, measured), with the width media queries that flip there (exact; several when several flip at once, any of them); merged = 1 px neighbours of an explained edge folded into it; reflowOnly = edges where only text wrapping changed (null: not searched, the quick sweep ignores wrapping); continuous = edges inside fluid (viewport-unit) sizing, including runs of 1 px edges; declared queries that also test height, orientation or aspect ratio depend on the viewport height and have no edge here (dependsOnHeight)' };
}

/** How the group's change animates (declared transition covering the changed properties, ms), or absent when its control was not timed. */
function transitionOf(g) {
  if (!g.transition) return {};
  const t = transitionsFor(g.transition, g.changes.map((c) => c.property));
  return { transition: t.map((x) => ({ property: safeCss(x.property, 60), duration: x.duration, easing: safeCss(x.easing, 80), delay: x.delay })), transitionLabel: 'measured' };
}
function states(V, variant, max) {
  const tagOf = new Map(V.rows.map((r) => [r.sel, safeTag(r.tag)]));
  const per = new Map();
  for (const s of variant.states || []) {
    const k = `${s.sel}|${s.state}`; const e = per.get(k) || { state: s.state, tag: tagOf.get(s.sel) || null, changes: [], transition: null };
    if (Array.isArray(s.transition)) e.transition = s.transition;   // read for the first controls only (src/static/extract.js)
    const fmt = (v) => { const pc = parseColor(v); return pc && /color|fill|stroke/.test(s.prop) ? hexOf(pc) : safeCss(v, 160); };
    const from = fmt(s.rest && s.rest.value), to = fmt(s.value && s.value.value);
    if (from !== to) e.changes.push({ property: s.prop, from, to });
    per.set(k, e);
  }
  // four sides / corners that change alike read as one property (border-color, border-radius)
  const fold = (changes) => {
    let out = changes;
    for (const [re, name] of [[/^border-(top|right|bottom|left)-color$/, 'border-color'], [/^border-(top|bottom)-(left|right)-radius$/, 'border-radius']]) {
      const side = out.filter((c) => re.test(c.property));
      if (side.length === 4 && side.every((c) => c.from === side[0].from && c.to === side[0].to)) out = [...out.filter((c) => !re.test(c.property)), { property: name, from: side[0].from, to: side[0].to }];
    }
    return out;
  };
  const groups = new Map();
  for (const e of per.values()) {
    if (!e.changes.length) continue;
    const changes = fold(e.changes);
    const k = `${e.state}|${e.tag}|${JSON.stringify(changes)}`; const g = groups.get(k) || { ...e, changes, count: 0, label: 'measured' }; g.count++; groups.set(k, g);
    if (!g.transition && e.transition) g.transition = e.transition;
  }
  // :hover and :focus that change the same elements the same way: one row, "hover + focus"
  for (const g of [...groups.values()]) {
    if (g.state !== 'hover') continue;
    const k = `focus|${g.tag}|${JSON.stringify(g.changes)}`; const f = groups.get(k);
    if (f && f.count === g.count) { g.state = 'hover + focus'; groups.delete(k); }
  }
  const list = [...groups.values()].sort((a, b) => b.count - a.count);
  return { changes: list.slice(0, max).map((g) => ({ state: g.state, on: g.tag, count: g.count, changes: g.changes, label: g.label, ...transitionOf(g) })), more: Math.max(0, list.length - max), elements: per.size,
    note: 'forced :hover / :focus on up to the first interactive elements (CDP), properties re-read: what changes, from and to; a transition\'s timing is motion (look --do hover)' };
}

// What the design pass could not read, in our words (the record's unknowns ledger, counted by id). Ids of the motion
// layer or of the corpus never reach here; an id with no sentence here reads as itself.
const GAP_WORDS = {
  unk_xorigin_cssom: ['stylesheet(s) from another origin could not be read through the CSSOM: custom properties, @container, @supports and @property rules in them are missing, so counts read from the CSS are partial', 'read the stylesheet files themselves'],
  unk_elements_truncated: ['the page has more elements than were read: the rest are not in the summary', 'raise the element cap'],
  unk_declared_rows_capped: ['the page\'s own declarations were looked up on part of the elements only: the other values are labelled measured, not exact', 'raise the declared-row cap'],
  unk_declared_inconsistent: ['some declarations did not match the computed value: those values are labelled measured', null],
  unk_declared_inconsistent_more: ['more declarations did not match the computed value (not listed)', null],
  unk_states_capped: [':hover / :focus were forced on the first interactive elements only', 'raise the state cap'],
  unk_canvas_pixels: ['canvas element(s): colours drawn into a canvas are pixels, not styles, and are not in the palette', 'sample the pixels'],
  unk_iframe_content: ['iframe(s): their content is not read', 'run the design pass on the iframe page'],
  unk_container_query: ['container queries: not evaluated by the width sweep', null],
  unk_breakpoint_unexplained: ['layout change(s) with no media query that explains them (script-driven or fluid)', null],
  unk_breakpoint_continuous: ['width interval(s) of fluid sizing (viewport units): the layout changes at many widths, not at a breakpoint', null],
  unk_breakpoint_navigation: ['width(s) where the page reloaded or navigated on resize: measured on the new document', null],
  unk_page_navigated: ['the page reloaded or navigated after load: that part was read again on the new document', null],
  unk_bp_flicker: ['width(s) where the layout did not read the same twice (animation or late script)', null],
  unk_query_rejected: ['media quer(y/ies) the browser rejected', null],
  unk_line_height_normal: ['line-height: normal resolves from font metrics: the used value is measured from boxes where one could be', null],
  unk_color_space: ['colour(s) in a wide-gamut space converted to sRGB hex', null],
  unk_bp_fluid_masked: ['fluid size(s) left out of the breakpoint signature: a breakpoint that changes only a fluid size is not seen', null],
  unk_declared_edge_no_effect: ['width quer(y/ies) whose edge changed nothing in the layout signature (listed under declared)', null],
  unk_spacing_base: ['no base spacing unit: no 8 / 4 / 2 px unit divides 85 % of the spacing values', null],
  unk_reduced_motion: ['a prefers-reduced-motion query is declared; only the default motion setting was read', 'read again with reduced motion'],
  unk_print_media: ['print styles are declared; print was not emulated', null],
  unk_pointer_media: ['pointer / hover queries are declared; only a mouse (desktop) and a touch phone were read', null],
  unk_color_scheme: ['a colour-scheme query is declared; only the default (light) scheme was read', 'read again with --color-scheme dark'],
  unk_other_media_feature: ['media queries on other features were not emulated', null],
  unk_layout_boxes_truncated: ['the breakpoint sweep tracked part of the elements only', null],
};
const GAP_SKIP = new Set(['unk_aria_snapshot', 'unk_svgo', 'unk_svg_bytes', 'unk_img_bytes', 'unk_font_bytes', 'unk_fonttools', 'unk_font_file_family']);
/** [{id, count, what, probe}] from the counts of unknowns ids (the summary's `unknowns`) and the withheld values. */
export function designGaps(d) {
  const out = [];
  for (const [id, count] of Object.entries((d && d.unknowns) || {})) {
    if (GAP_SKIP.has(id) || !/^unk_[a-z0-9_]{1,60}$/.test(id)) continue;
    let w = GAP_WORDS[id];
    if (id === 'unk_color_scheme' && d.scheme && d.scheme.colorScheme === 'dark') w = ['a colour-scheme query is declared; only the dark scheme was read', 'read again without --color-scheme (light)'];
    out.push({ id, count, what: w ? w[0] : `${id.replace(/^unk_/, '').replace(/_/g, ' ')}: not measured (the raw static record has the details)`, ...(w && w[1] ? { probe: w[1] } : {}) });
  }
  if (d && d.withheldValues) out.push({ id: 'withheld_values', count: d.withheldValues, what: 'measured value(s) that did not match the grammar of their property (a page can patch what the browser reports): left out' });
  const nl = d && d.fonts && (d.fonts.families || []).filter((f) => f.loaded === false);
  if (nl && nl.length) out.push({ id: 'webfont_not_loaded', count: nl.length, what: 'declared webfont(s) did not load: the text was drawn with a fallback face, so line-height normal, wrapping, widths and breakpoint edges were measured with the fallback, not the designed font', probe: 'read again where the font files load (the archive may lack them)' });
  if (d && d.scheme && d.scheme.colorScheme === 'dark') out.push({ id: 'read_in_dark', count: 1, what: 'the page was read in the dark colour scheme: the palette is the dark one' });
  if (d && d.settle && d.settle.textStable === false) out.push({ id: 'type_not_settled', count: 1, what: 'text sizes were still changing when the page was read (script-sized text): the type sizes may be from mid-change', probe: 'run the design pass again' });
  return out;
}

function customProperties(record, max) {
  const cps = (record.declared && record.declared.customProperties) || [];
  const kind = (v) => (parseColor(v) ? 'color' : /^-?[\d.]+(px|rem|em|vw|vh|%)$/.test(v) ? 'length' : /^-?[\d.]+m?s$/.test(v) ? 'duration' : /^cubic-bezier\(/.test(v) ? 'easing' : /^-?[\d.]+$/.test(v) ? 'number' : 'other');
  const counts = {}; const list = []; let withheld = 0; const seen = new Set();
  for (const c of cps) {
    const v = String(c.value && c.value.value || '').trim(); const k = kind(v); counts[k] = (counts[k] || 0) + 1;
    if (c.value && c.value.condition) continue; // base definitions only in the list
    const name = safeVar(c.name), value = safeCss(v);
    if (!name || !value) { withheld++; continue; }
    if (seen.has(name)) continue; seen.add(name);
    if (k !== 'other' && list.length < max) list.push({ name, value, kind: k, label: 'exact' });
  }
  const xorigin = (record.unknowns || []).filter((u) => u.id === 'unk_xorigin_cssom').length;
  return { count: cps.length, byKind: counts, list, ...(withheld ? { withheld } : {}), label: xorigin ? 'partial' : 'exact', ...(xorigin ? { unreadableSheets: xorigin } : {}),
    note: 'the page\'s own CSS custom properties (definitions without a condition); names and values as authored. label partial: some stylesheets came from another origin and could not be read, so the count is a floor' };
}

/** The colour scheme and motion preference the page was read in (requested, and what matchMedia answered). */
function schemeOf(v0) {
  const m = (v0.media && v0.media.value) || {}; const rq = v0.requested || {};
  const read = m.prefersDark === true ? 'dark' : m.prefersDark === false ? 'light' : null;
  return { colorScheme: read, requested: rq.colorScheme === 'light' || rq.colorScheme === 'dark' ? rq.colorScheme : null, reducedMotion: m.prefersReducedMotion === true ? 'reduce' : m.prefersReducedMotion === false ? 'no-preference' : null, label: 'measured',
    note: 'colorScheme: what prefers-color-scheme matched during the read (matchMedia); requested: what the pass pinned, light unless --color-scheme dark (absent on records from before it was pinned, which followed the OS appearance)' };
}

function mobile(record) {
  const v = record.variants.find((x) => x.requested && x.requested.touch) || record.variants[1];
  if (!v) return null;
  const sizes = new Map(); for (const t of v.tokens.typography || []) { const p = pxOf(t.fontSize.value); if (p != null && t.renderedCount) tally(sizes, r2(p), t.renderedCount); }
  return { viewport: { width: v.viewport.value.width, height: v.viewport.value.height, unit: 'px' }, documentHeight: q(v.document.value.scrollHeight, 'px', 'measured'),
    typeSizes: [...sizes].sort((a, b) => b[0] - a[0]).slice(0, 12).map(([s, c]) => ({ size: q(s, 'px', 'measured'), count: c })) };
}

/**
 * @param {object} record  static record (src/static extractStatic)
 * @param {object} base    elements of the record's first variant ({rows, styles, props}: loadElements)
 */
export function summarizeDesign(record, base, { maxStyles = 16, maxColours = 16, maxPairs = 12, maxSpacing = 20 } = {}) {
  const v0 = record.variants[0]; const V = rowsView(base); const tk = v0.tokens; W.n = 0;
  const typo = typography(V, tk, maxStyles);
  const counts = {}; for (const u of record.unknowns || []) counts[u.id] = (counts[u.id] || 0) + 1;
  const ts = v0.textSettle && v0.textSettle.value;
  const out = {
    schema: DESIGN_SCHEMA, ok: true, labels: LABELS,
    viewport: { width: v0.viewport.value.width, height: v0.viewport.value.height, unit: 'px' },
    ...(ts ? { settle: { textStable: ts.stable, samples: ts.samples, ms: ts.ms, ...(ts.noText ? { noText: true } : {}), label: 'measured', note: 'text sizes sampled until three reads in a row agreed, then read once more after the extract; textStable false: they were still changing (script-sized text)' } } : {}),
    scheme: schemeOf(v0),
    fonts: fonts(V, record, typo.styles),
    type: typo,
    palette: palette(V, tk, maxColours, { width: (v0.document.value && v0.document.value.scrollWidth) || v0.viewport.value.width, height: (v0.document.value && v0.document.value.scrollHeight) || v0.viewport.value.height }),
    contrast: contrast(V, maxPairs),
    spacing: spacing(tk, maxSpacing),
    radii: radii(tk, 10),
    shadows: shadows(tk, 8),
    layout: layout(V, v0),
    breakpoints: breakpoints(record),
    states: states(V, v0, 16),
    customProperties: customProperties(record, 40),
    mobile: mobile(record),
    unknowns: counts,
  };
  if (W.n) out.withheldValues = W.n;
  out.gaps = designGaps(out);
  return out;
}
