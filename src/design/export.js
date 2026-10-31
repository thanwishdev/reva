// Design tokens from a design summary (src/design/summary.js): CSS custom properties and a W3C Design Tokens (DTCG
// 2025.10) JSON file. Every token is named by an id of ours (--reva-color-c1, t1, space-1 ...), never by the page's own
// names; every value is rebuilt from numbers and hex colours, so no page text reaches the code. Font family names are the
// one exception a user may want in the file: they are written only when families:true (the CLI), after the strict name
// check; the MCP leaves them out of the code and lists them in its result as untrusted content.
import { parseColor } from '../static/color.js';
import { safeFamily, isGeneric } from './summary.js';

const num = (x) => (Number.isFinite(x) ? String(Math.round(x * 1e4) / 1e4) : null);
const len = (x, unit = 'px') => (num(x) == null ? null : `${num(x)}${unit}`);
const hexOk = (h) => (typeof h === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h) ? h.toLowerCase() : null);
const GENERIC_DEFAULT = 'sans-serif';
const genericOf = (f) => (f.fallbacks || []).map((x) => String(x).toLowerCase()).find(isGeneric) || (isGeneric(f.family) ? f.family.toLowerCase() : GENERIC_DEFAULT);
const familyList = (f, families) => {
  const names = families ? [f.family, ...(f.fallbacks || [])].map(safeFamily).filter(Boolean) : [];
  const out = names.filter((x) => !isGeneric(x)).map((x) => `"${x}"`); out.push(genericOf(f));
  return [...new Set(out)];
};
const radiusCss = (r) => {
  if (r.corners) { const v = Object.values(r.corners).map((x) => (/^-?[\d.]+(px|%)$/.test(String(x)) ? x : null)); return v.every(Boolean) ? v.join(' ') : null; }
  return r.unit === 'px' || r.unit === '%' ? len(r.value, r.unit) : null;
};
const shadowCss = (s) => s.layers.map((y) => {
  const parts = [y.inset ? 'inset' : null, len(y.x), len(y.y), len(y.blur), s.kind === 'box' ? len(y.spread) : null, hexOk(y.color)].filter(Boolean);
  return parts.length >= 4 ? parts.join(' ') : null;
});

/** Token rows shared by both forms: [group, id, css value, comment, dtcg token]. */
function rows(d, { families = false } = {}) {
  const out = []; const famIndex = new Map();
  d.fonts.families.forEach((f, i) => {
    const id = `font-${i + 1}`; famIndex.set(f.family, id);
    const list = familyList(f, families);
    out.push(['font', id, list.join(', '), `${families ? '' : `family ${i + 1}: its name is listed beside this code; `}${Object.keys(f.roles).join(', ')}; ${f.source.value} [${f.source.label}]`,
      { $type: 'fontFamily', $value: list.map((x) => x.replace(/^"|"$/g, '')), $extensions: { 'com.reva': { label: 'measured', elements: f.elements, roles: f.roles, weights: f.weights, ...(families ? {} : { nameWithheld: true }) } } }]);
  });
  for (const s of d.type.styles) {
    const fam = s.family && famIndex.get(s.family);
    const size = s.size.unit === 'px' ? s.size.value : null; const w = typeof s.weight.value === 'number' ? s.weight.value : null;
    const lhRatio = s.lineHeight.ratio ? s.lineHeight.ratio.value : null; const lsEm = s.letterSpacing.em ? s.letterSpacing.em.value : null;
    const base = `--reva-text-${s.id}`; const note = `${s.role}, ${s.count} element(s)`;
    if (size != null) out.push(['type', `${s.id}-size`, len(size), `${note}; ${s.size.label}`, null]);
    if (w != null) out.push(['type', `${s.id}-weight`, num(w), s.weight.label, null]);
    if (lhRatio != null) out.push(['type', `${s.id}-line-height`, num(lhRatio), `${s.lineHeight.label === 'measured' && s.lineHeight.value === 'normal' ? 'used value of normal' : `${len(s.lineHeight.value)} ${s.lineHeight.label}`} / size`, null]);
    if (lsEm != null) out.push(['type', `${s.id}-letter-spacing`, len(lsEm, 'em'), `${s.letterSpacing.value === 'normal' ? 'normal' : `${len(s.letterSpacing.value)} ${s.letterSpacing.label}`} / size`, null]);
    out.push(['typography', s.id, null, base, { $type: 'typography', $value: {
      ...(fam ? { fontFamily: `{font.${fam}}` } : {}), ...(size != null ? { fontSize: { value: size, unit: 'px' } } : {}), ...(w != null ? { fontWeight: w } : {}),
      ...(lhRatio != null ? { lineHeight: lhRatio } : {}), ...(typeof s.letterSpacing.value === 'number' ? { letterSpacing: { value: s.letterSpacing.value, unit: 'px' } } : s.letterSpacing.value === 'normal' ? { letterSpacing: { value: 0, unit: 'px' } } : {}),
    }, $extensions: { 'com.reva': { role: s.role, count: s.count, usedOn: s.usedOn, labels: { fontSize: s.size.label, fontWeight: s.weight.label, lineHeight: s.lineHeight.label, letterSpacing: s.letterSpacing.label } } } }]);
  }
  for (const c of d.palette.colours) {
    const hex = hexOk(c.hex.value); const pc = hex && parseColor(hex); if (!pc) continue;
    const share = c.backgroundShare ? c.backgroundShare.value : null;
    out.push(['color', c.id, hex, `${c.role}; ${c.hex.label}${share != null ? `; background share ${share}` : ''}`, { $type: 'color', $value: { colorSpace: 'srgb', components: [pc.r, pc.g, pc.b].map((x) => Math.round((x / 255) * 1e4) / 1e4), alpha: c.alpha, hex: hex.slice(0, 7) },
      $extensions: { 'com.reva': { label: c.hex.label, role: c.role, uses: c.uses, count: c.count, ...(share != null ? { backgroundShare: share } : {}) } } }]);
  }
  // named aliases for the backgrounds and the main text, pointing at the palette entry with that colour
  const P = d.palette;
  const aliases = [['page-bg', P.pageBackground && P.pageBackground.hex.value, `page background (root canvas, from ${P.pageBackground && P.pageBackground.from})`],
    ['main-bg', P.mainBackground, 'main background: the opaque colour that paints the most visible page area'], ['main-text', P.mainText, 'main text: the text colour on the most elements']];
  for (const [id, raw, what] of aliases) {
    const hex = hexOk(raw); const pc = hex && parseColor(hex); if (!pc) continue;
    const c = P.colours.find((x) => hexOk(x.hex.value) === hex);
    const share = c && c.backgroundShare ? c.backgroundShare.value : null;
    const note = `${what}${share != null && id !== 'main-text' ? `; background share ${share}` : ''}`;
    out.push(['color', id, c ? `var(--reva-color-${c.id})` : hex, note, c
      ? { $type: 'color', $value: `{color.${c.id}}`, $description: note, $extensions: { 'com.reva': { alias: c.id, ...(share != null ? { backgroundShare: share } : {}) } } }
      : { $type: 'color', $value: { colorSpace: 'srgb', components: [pc.r, pc.g, pc.b].map((x) => Math.round((x / 255) * 1e4) / 1e4), alpha: Math.round(pc.a * 1e4) / 1e4, hex: hex.slice(0, 7) }, $description: note, $extensions: { 'com.reva': { label: 'derived' } } }]);
  }
  d.spacing.values.forEach((v, i) => out.push(['space', `space-${i + 1}`, len(v.value), `${v.label}; ×${v.count}`, { $type: 'dimension', $value: { value: v.value, unit: 'px' }, $extensions: { 'com.reva': { label: v.label, count: v.count, by: v.by } } }]));
  d.radii.values.forEach((r, i) => { const css = radiusCss(r); if (css) out.push(['radius', `radius-${i + 1}`, css, `${r.label}; ×${r.count}`, r.corners ? { $value: css, $extensions: { 'com.reva': { label: r.label, count: r.count } } } : { $type: 'dimension', $value: { value: r.value, unit: r.unit }, $extensions: { 'com.reva': { label: r.label, count: r.count } } }]); });
  d.shadows.values.forEach((s, i) => {
    const layers = shadowCss(s); if (layers.some((x) => !x)) return;
    out.push(['shadow', `shadow-${i + 1}`, layers.join(', '), `${s.kind}-shadow; ${s.label}; ×${s.count}`, s.kind === 'box' ? { $type: 'shadow', $value: s.layers.map((y) => { const pc = parseColor(y.color); return {
      color: { colorSpace: 'srgb', components: [pc.r, pc.g, pc.b].map((x) => Math.round((x / 255) * 1e4) / 1e4), alpha: Math.round(pc.a * 1e4) / 1e4, hex: hexOk(y.color).slice(0, 7) },
      offsetX: { value: y.x, unit: 'px' }, offsetY: { value: y.y, unit: 'px' }, blur: { value: y.blur, unit: 'px' }, spread: { value: y.spread, unit: 'px' }, inset: !!y.inset }; }), $extensions: { 'com.reva': { label: s.label, count: s.count } } } : { $value: layers.join(', '), $extensions: { 'com.reva': { kind: 'text-shadow', label: s.label, count: s.count } } }]);
  });
  d.layout.containers.forEach((c, i) => out.push(['layout', `content-width-${i + 1}`, len(c.width.value), `centred block width; measured; ×${c.count}`, { $type: 'dimension', $value: { value: c.width.value, unit: 'px' }, $extensions: { 'com.reva': { label: 'measured', count: c.count } } }]));
  const bps = [...new Set(d.breakpoints.layoutChanges.map((e) => e.at))].sort((a, b) => a - b);
  bps.forEach((at, i) => out.push(['breakpoint', `bp-${i + 1}`, len(at), 'the layout changes at this width (measured)', { $type: 'dimension', $value: { value: at, unit: 'px' }, $extensions: { 'com.reva': { label: 'measured' } } }]));
  return out;
}

const CSS_NAME = { font: 'font', type: 'text', color: 'color', space: 'space', radius: 'radius', shadow: 'shadow', layout: '', breakpoint: 'breakpoint' };
/** :root { --reva-...: value; } with a comment per token (our words: role, label, count). */
export function designCss(d, { families = false } = {}) {
  const L = [`/* REVA design tokens · measured at ${d.viewport.width}×${d.viewport.height} px · labels: exact = the page's own CSS value, measured = computed by the browser, derived = our arithmetic */`, ':root {'];
  let group = null;
  for (const [g, id, css, note] of rows(d, { families })) {
    if (css == null) continue;
    if (g !== group) { L.push(`  /* ${g} */`); group = g; }
    const name = g === 'layout' ? `--reva-${id}` : `--reva-${CSS_NAME[g]}-${id.replace(/^(font|space|radius|shadow|bp)-/, '')}`;
    L.push(`  ${name}: ${css}; /* ${String(note).replace(/\*\//g, '')} */`);
  }
  L.push('}');
  return L.join('\n') + '\n';
}

/** DTCG JSON object: groups font, typography, color, space, radius, shadow, layout, breakpoint. */
export function designTokens(d, { families = false } = {}) {
  const out = { $description: `REVA design tokens, measured at ${d.viewport.width}x${d.viewport.height} px; $extensions.com.reva.label says exact (the page's own CSS value) or measured (computed by the browser)` };
  for (const [g, id, , , tok] of rows(d, { families })) {
    if (!tok) continue;
    out[g] = out[g] || {}; out[g][id] = tok;
  }
  return out;
}
