// Pure aggregation: element rows (inpage.extractElements) -> static tokens, every value tagged (H6).
//   measured  = a computed value / layout rect read from the browser
//   inferred  = our arithmetic on measured values (em from px, hex from an oklch string, a scale base ...)
//   declared  = the winning declaration's source text (from cdpcss.pickDeclared, already consistency-checked)
import { PROPS, IDX, SIDES, CORNERS } from './props.js';
import { measured, declared as decl, inferred, Ledger } from './prov.js';
import { parseColor, toHex } from './color.js';
import { parseShadowList } from './shadow.js';

const px = v => (typeof v === 'string' && /^-?[\d.]+px$/.test(v) ? parseFloat(v) : null);
const EX = 5; // examples kept per token

export function styleObject(styles, row) {
  const vals = styles[row.s]; const o = {};
  PROPS.forEach((p, i) => { o[p] = vals[i]; });
  return o;
}

function bump(map, key, init, row, extra) {
  let e = map.get(key); if (!e) { e = { ...init, count: 0, renderedCount: 0, examples: [], declared: new Map() }; map.set(key, e); }
  e.count++; if (row.rendered) e.renderedCount++;
  if (e.examples.length < EX) e.examples.push(row.sel);
  if (extra) extra(e);
  return e;
}
function addDeclared(e, row, props) {
  for (const p of props) {
    const d = row.decl?.[p]; if (!d) continue;
    const k = [p, d.text, d.file, d.line].join('|');
    const cur = e.declared.get(k) || { prop: p, text: d.text, file: d.file, line: d.line, important: d.important, via: d.via, verified: d.verified, count: 0 };
    cur.count++; e.declared.set(k, cur);
  }
}
const finishDeclared = e => {
  // one entry per distinct (text, file, line, importance); the properties it was found for are listed together
  const merged = new Map();
  for (const d of e.declared.values()) {
    const k = [d.text, d.file, d.line, d.important].join('|');
    const m = merged.get(k) || { ...d, props: [], rows: 0, verified: true };
    if (!m.props.includes(d.prop)) m.props.push(d.prop);
    m.rows = Math.max(m.rows, d.count); m.verified = m.verified && d.verified;
    merged.set(k, m);
  }
  return [...merged.values()].map(d => decl(d.text, `${d.file ?? '?'}:${d.line ?? '?'}`, { prop: d.props.join(','), props: d.props, important: d.important, via: d.via, verified: d.verified, rows: d.rows }));
};

const hasText = r => r.text && !(r.tag === 'html' || r.tag === 'body' && false);

export function buildTokens({ rows, styles }, { ledger = new Ledger(), maxBoxes = 400, variant = 'base' } = {}) {
  const S = r => styles[r.s];
  const get = (r, p) => S(r)[IDX[p]];

  // ---- typography
  const typo = new Map();
  for (const r of rows) {
    if (!hasText(r)) continue;
    const fam = get(r, 'font-family'), size = get(r, 'font-size'), weight = get(r, 'font-weight'), fstyle = get(r, 'font-style');
    const lh = get(r, 'line-height'), ls = get(r, 'letter-spacing'), tt = get(r, 'text-transform');
    const key = [fam, size, weight, fstyle, lh, ls, tt].join('|');
    const e = bump(typo, key, { fam, size, weight, fstyle, lh, ls, tt, lhUsed: new Set() }, r, e2 => { if (r.lhUsed != null) e2.lhUsed.add(r.lhUsed); });
    addDeclared(e, r, ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform']);
  }
  const typography = [...typo.values()].sort((a, b) => b.renderedCount - a.renderedCount || b.count - a.count).map((e, i) => {
    const sizePx = px(e.size); const lhPx = px(e.lh); const lsPx = px(e.ls);
    const t = {
      id: `type_${i + 1}`, count: e.count, renderedCount: e.renderedCount, onlyNotRendered: e.renderedCount === 0, examples: e.examples,
      fontFamily: measured(e.fam), fontSize: measured(e.size), fontWeight: measured(e.weight), fontStyle: measured(e.fstyle),
      lineHeight: measured(e.lh), letterSpacing: measured(e.ls), textTransform: measured(e.tt),
    };
    if (sizePx && lhPx != null) t.lineHeightRatio = inferred(+(lhPx / sizePx).toFixed(4), 'computed line-height px / computed font-size px');
    else if (e.lh === 'normal') {
      const used = [...e.lhUsed];
      t.lineHeightRatio = used.length === 1 && sizePx ? inferred(+(used[0] / sizePx).toFixed(4), 'content height / line count of a text-only block, / font-size', { usedPx: used[0] })
        : ledger.add('unk_line_height_normal', 'line-height is "normal": the used value comes from font metrics and no text-only block was available to isolate it', 'measure a single-line text-only block of this style (Range rects)', t.id);
    }
    if (e.ls === 'normal') t.letterSpacingEm = inferred(0, 'letter-spacing: normal means no extra spacing (CSS Text 3); value kept as the string "normal" above');
    else if (lsPx != null && sizePx) t.letterSpacingEm = inferred(+(lsPx / sizePx).toFixed(4), 'computed letter-spacing px / computed font-size px');
    const dd = finishDeclared(e); if (dd.length) t.declared = dd;
    return t;
  });

  // ---- spacing
  const spacing = new Map(); let excludedLarge = 0, autoish = 0;
  for (const r of rows) {
    if (!r.rendered || r.pseudo) continue;
    const props = [...SIDES.map(s => `margin-${s}`), ...SIDES.map(s => `padding-${s}`), 'row-gap', 'column-gap'];
    for (const p of props) {
      const v = px(get(r, p)); if (v == null || v === 0) continue;
      if (Math.abs(v) > 256) { excludedLarge++; continue; }
      const fam = p.split('-')[0] === 'row' || p.split('-')[0] === 'column' ? 'gap' : p.split('-')[0];
      const e = bump(spacing, v, { px: v, byProp: {} }, r, e2 => { e2.byProp[fam] = (e2.byProp[fam] || 0) + 1; });
      addDeclared(e, r, [p]);
    }
  }
  const spacingScale = [...spacing.values()].sort((a, b) => a.px - b.px).map(e => ({
    px: measured(e.px), count: e.count, byProperty: e.byProp, examples: e.examples, ...(e.declared.size ? { declared: finishDeclared(e) } : {}),
  }));
  let spacingBase;
  { // inferred base unit: the largest of 8/4/2 that divides >= 85 % of distinct absolute values
    const vals = spacingScale.map(s => Math.abs(s.px.value)).filter(v => Number.isInteger(v));
    spacingBase = ledger.add('unk_spacing_base', 'no base unit divides at least 85 % of the distinct spacing values', 'inspect the scale by hand; the page may use a non-grid rhythm', variant);
    if (vals.length >= 3) for (const b of [8, 4, 2]) { const cov = vals.filter(v => v % b === 0).length / vals.length; if (cov >= 0.85) { spacingBase = inferred(b, 'distinct spacing values divisible by this base', { coverage: +cov.toFixed(3), distinct: vals.length }); break; } }
  }

  // ---- colours
  const colors = new Map();
  const addColor = (raw, role, r, declProps) => {
    if (!raw || raw === 'none' || raw === 'currentcolor') return;
    const pc = parseColor(raw); if (pc && pc.a === 0) return;
    const e = bump(colors, raw, { raw, roles: {} }, r, e2 => { e2.roles[role] = (e2.roles[role] || 0) + 1; });
    addDeclared(e, r, declProps);
  };
  for (const r of rows) {
    if (hasText(r)) addColor(get(r, 'color'), 'text', r, ['color']);
    addColor(get(r, 'background-color'), 'background', r, ['background-color']);
    for (const s of SIDES) if ((px(get(r, `border-${s}-width`)) || 0) > 0 && get(r, `border-${s}-style`) !== 'none') addColor(get(r, `border-${s}-color`), 'border', r, [`border-${s}-color`]);
    if ((px(get(r, 'outline-width')) || 0) > 0 && get(r, 'outline-style') !== 'none') addColor(get(r, 'outline-color'), 'outline', r, []);
    if (/^(path|circle|rect|ellipse|line|polyline|polygon|text)$/.test(r.tag)) { addColor(get(r, 'fill'), 'fill', r, []); addColor(get(r, 'stroke'), 'stroke', r, []); }
  }
  const colourList = [...colors.values()].sort((a, b) => b.count - a.count).map((e, i) => {
    const pc = parseColor(e.raw);
    const t = { id: `color_${i + 1}`, raw: measured(e.raw), roles: e.roles, count: e.count, renderedCount: e.renderedCount, examples: e.examples };
    if (pc) { t.hex = inferred(toHex(pc), pc.exact ? 'computed rgb()/rgba() string' : `converted from ${pc.space}() (rounded, gamut-clipped)`, { exact: pc.exact }); t.alpha = measured(pc.a); }
    else t.hex = ledger.add('unk_color_space', `colour "${e.raw}" is in a space this tool does not convert to sRGB`, 'convert with a colour library (lab/lch/hwb/display-p3)', e.raw);
    const dd = finishDeclared(e); if (dd.length) t.declared = dd;
    return t;
  });

  // ---- shadows
  const shadows = new Map();
  for (const r of rows) for (const [p, kind] of [['box-shadow', 'box'], ['text-shadow', 'text']]) {
    const v = get(r, p); if (!v || v === 'none') continue;
    const e = bump(shadows, kind + '|' + v, { kind, raw: v }, r); addDeclared(e, r, [p]);
  }
  const shadowList = [...shadows.values()].sort((a, b) => b.count - a.count).map((e, i) => {
    const layers = parseShadowList(e.raw, { text: e.kind === 'text' });
    const t = { id: `shadow_${i + 1}`, kind: e.kind, raw: measured(e.raw), count: e.count, renderedCount: e.renderedCount, examples: e.examples, layers: inferred(layers, 'computed string split at top-level commas') };
    const dd = finishDeclared(e); if (dd.length) t.declared = dd;
    return t;
  });

  // ---- radii
  const radii = new Map();
  for (const r of rows) {
    const c = CORNERS.map(k => get(r, `border-${k}-radius`));
    if (c.every(v => v === '0px' || !v)) continue;
    const e = bump(radii, c.join('|'), { c }, r); addDeclared(e, r, CORNERS.map(k => `border-${k}-radius`));
  }
  const radiusList = [...radii.values()].sort((a, b) => b.count - a.count).map((e, i) => {
    const t = { id: `radius_${i + 1}`, corners: measured({ 'top-left': e.c[0], 'top-right': e.c[1], 'bottom-right': e.c[2], 'bottom-left': e.c[3] }), uniform: new Set(e.c).size === 1, count: e.count, renderedCount: e.renderedCount, examples: e.examples };
    const dd = finishDeclared(e); if (dd.length) t.declared = dd;
    return t;
  });

  // ---- layout boxes
  const LANDMARK = /^(header|nav|main|section|article|aside|footer|form|h[1-6]|button|a|img|svg|canvas|video|iframe|table|ul|ol|li|input|select|textarea|figure|dialog)$/;
  const boxRows = rows.filter(r => r.rendered && r.rect && !r.pseudo && (r.elId || LANDMARK.test(r.tag) || r.depth <= 2 || /flex|grid/.test(get(r, 'display'))));
  const layoutBoxes = boxRows.slice(0, maxBoxes).map(r => {
    const [x, y, w, h] = r.rect; const d = get(r, 'display');
    const b = { sel: r.sel, tag: r.tag, rect: measured({ x, y, w, h }), display: measured(d), position: measured(get(r, 'position')) };
    if (/flex/.test(d)) b.flex = measured({ direction: get(r, 'flex-direction'), wrap: get(r, 'flex-wrap'), alignItems: get(r, 'align-items'), justifyContent: get(r, 'justify-content'), rowGap: get(r, 'row-gap'), columnGap: get(r, 'column-gap') });
    if (/grid/.test(d)) b.grid = measured({ columns: get(r, 'grid-template-columns'), rows: get(r, 'grid-template-rows'), rowGap: get(r, 'row-gap'), columnGap: get(r, 'column-gap') });
    const z = get(r, 'z-index'); if (z && z !== 'auto') b.zIndex = measured(z);
    if (r.shadow) b.shadowDom = true;
    return b;
  });
  if (boxRows.length > maxBoxes) ledger.add('unk_layout_boxes_truncated', `${boxRows.length - maxBoxes} further layout boxes were not listed (cap ${maxBoxes})`, 'raise maxBoxes', variant);
  const hidden = rows.filter(r => !r.rendered && !r.pseudo).length;

  return {
    typography, spacing: { scale: spacingScale, base: spacingBase, excludedLargeValues: excludedLarge },
    colors: colourList, shadows: shadowList, radii: radiusList, layout: { boxes: layoutBoxes, notRenderedElements: hidden },
  };
}
