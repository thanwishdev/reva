// Plain-language text of a design summary (src/design/summary.js): `reva design` prints it, `reva look` prints its
// first lines. Every value carries its label: [exact] read from the page CSS, [measured] computed by the browser,
// [derived] our arithmetic. Units are always written.
import { CONTROL_CHARS } from '../report/untrusted.js';
import { designGaps } from './summary.js';

const n = (x) => (typeof x === 'number' ? String(Math.round(x * 100) / 100) : String(x));
const em = (x) => String(Math.round(x * 1e4) / 1e4);
/** "20.8 px [exact: 1.3rem]" */
export function say(v, { css = true } = {}) {
  if (v == null) return '?';
  if (typeof v === 'object' && v.value == null) return `withheld [${v.label}]`;
  if (typeof v !== 'object') return String(v);
  const unit = v.unit ? (v.unit === ':1' ? ':1' : v.unit === '%' ? ' %' : ` ${v.unit}`) : '';
  return `${n(v.value)}${unit} [${v.label}${css && v.css && v.css !== String(v.value) ? `: ${v.css}` : ''}]`;
}
const tags = (o) => Object.entries(o || {}).map(([t, c]) => `${t} ×${c}`).join(', ');
/** The width queries that flip at one edge, as a list: any of them can be the cause (never joined with "and"). */
export const queryList = (e, max = 3) => { const qs = [...new Set(e.queries || (e.query ? [e.query] : []))]; return qs.slice(0, max).join(' | ') + (qs.length > max ? ` | +${qs.length - max} more` : ''); };
const clean = (t) => String(t).replace(CONTROL_CHARS, '');
const same = (list) => (list.length && list.every((x) => x.label === list[0].label) ? list[0].label : null);

/** One-line headline of a design summary (look prints it under the motion). */
export function designHeadline(d) {
  if (!d) return null;
  if (d.ok === false) return clean(`Design: not recorded (${d.error})`);
  const fams = d.fonts.families.map((f) => f.family).slice(0, 3);
  return `Design: ${fams.length ? fams.join(', ') : 'no text'} · ${d.type.styles.length + d.type.more} text style(s) · ${d.palette.colours.length + d.palette.more} colour(s)`
    + ` · ${d.breakpoints.layoutChanges.length} layout breakpoint(s) · ${d.states.changes.length + d.states.more} hover/focus change(s) · ${(d.timing.ms / 1000).toFixed(1)} s`;
}

export function formatDesign(d, { source = null, all = false } = {}) {
  const L = [];
  if (!d) return 'no design data';
  if (d.ok === false) return clean(`REVA design${source ? ` · ${source}` : ''}\n! ${d.error}${d.errorLog ? `\n  (the raw message is in ${d.errorLog})` : ''}`);
  L.push(`REVA design${source ? ` · ${source}` : ''} · ${d.viewport.width}×${d.viewport.height} px${d.scheme && d.scheme.colorScheme ? ` · ${d.scheme.colorScheme} scheme` : ''}${d.timing ? ` · ${(d.timing.ms / 1000).toFixed(1)} s` : ''}`);

  L.push('', 'Fonts');
  for (const f of d.fonts.families) {
    const src = f.loaded === false ? `! declared webfont did not load; drawn as ${f.drawnAs && f.drawnAs.length ? f.drawnAs.join(', ') : 'a fallback face'} [measured]` : `${f.source.value} [${f.source.label}]`;
    L.push(`  ${f.family}${f.fallbacks.length ? ` (then ${f.fallbacks.join(', ')})` : ''} · ${src} · weights ${f.weights.join(', ') || '?'}${f.styles.includes('italic') ? ' + italic' : ''} · on ${tags(f.roles)} [measured]`);
  }
  if (d.fonts.notLoaded) L.push(`  ! ${d.fonts.notLoaded} declared webfont(s) did not load: the type metrics below were measured with the fallback face`);
  if (d.fonts.rendered && d.fonts.rendered.length) L.push(`  drawn with: ${[...new Set(d.fonts.rendered.map((r) => `${r.name}${r.custom ? ' (webfont)' : ' (system)'}`))].join(', ')} [measured]`);
  if (d.fonts.withheld) L.push(`  (${d.fonts.withheld} family name(s) left out: characters outside the plain name set)`);

  const T = d.type;
  const byCount = T.order !== 'largest size first';
  L.push('', `Type (${byCount ? 'most used first' : 'largest first'}${T.bodySize ? `; body size ${say(T.bodySize)}` : ''})`);
  if (d.settle && d.settle.textStable === false) L.push('  ! text sizes were still changing when the page was read (script-sized text): sizes may be from mid-change');
  // the first 10, plus the body style when it falls below them
  let shown = all ? T.styles : T.styles.slice(0, 10);
  if (!all && T.bodySize) { const body = T.styles.find((s) => s.size.value === T.bodySize.value && s.role !== 'heading'); if (body && !shown.includes(body)) shown = [...shown, body]; }
  for (const s of shown) {
    const lh = s.lineHeight.value === 'normal' ? `line-height normal${s.lineHeight.used ? ` (${say(s.lineHeight.used)})` : ''}` : `line-height ${say(s.lineHeight)}${s.lineHeight.ratio ? ` = ${n(s.lineHeight.ratio.value)}×` : ''}`;
    const ls = s.letterSpacing.value === 'normal' ? 'tracking normal' : `tracking ${say(s.letterSpacing)}${s.letterSpacing.em ? ` = ${em(s.letterSpacing.em.value)} em` : ''}`;
    L.push(`  ${s.id} ${s.role.padEnd(11)} ${say(s.size)} · weight ${say(s.weight)} · ${lh} · ${ls}${s.transform ? ` · ${s.transform.value ?? 'transform withheld'}` : ''}${s.style ? ` · ${s.style.value ?? 'style withheld'}` : ''} · ${s.family || '?'} · ${tags(s.usedOn)}`);
  }
  if (!all && T.styles.length > shown.length) L.push(`  … ${T.styles.length - shown.length} more listed in the JSON`);
  if (T.more) L.push(`  (${T.more} rarer style(s) not listed)`);
  L.push(`  sizes: ${T.scale.slice(0, 16).map((x) => n(x.size.value)).join(' / ')} px [measured]`);
  if (d.mobile) L.push(`  at ${d.mobile.viewport.width} px wide: ${d.mobile.typeSizes.map((x) => n(x.size.value)).join(' / ')} px [measured]`);

  L.push('', 'Colours (role [derived], most used first)');
  for (const c of d.palette.colours) L.push(`  ${c.id.padEnd(4)} ${say(c.hex)}${c.alpha < 1 ? ` alpha ${c.alpha}` : ''} · ${c.role} · ${tags(c.uses)}`);
  if (d.palette.more) L.push(`  (${d.palette.more} more colour(s) not listed)`);
  const PL = d.palette;
  if (PL.pageBackground) L.push(`  page background ${say(PL.pageBackground.hex)} (${PL.pageBackground.from === 'browser default canvas' ? 'html and body transparent: the default canvas' : `from ${PL.pageBackground.from}`}${PL.pageBackground.image ? ', under a CSS image' : ''})`);
  L.push(`  main background (most visible area) ${PL.mainBackground || '?'} · most used background ${PL.mostUsedBackground || '?'} · main text ${PL.mainText || '?'} [derived]`);
  const C = d.contrast;
  const notGraded = [C.overImage ? `${C.overImage} over a CSS image or gradient` : '', C.overMedia ? `${C.overMedia} over an image, video or canvas` : '', C.overlapped ? `${C.overlapped} over another element's background` : '', C.noBackground ? `${C.noBackground} with no background colour set` : '', C.hidden ? `${C.hidden} hidden (${C.faded == null ? 'opacity 0 or visibility hidden' : 'visibility hidden'})` : ''].filter(Boolean);
  L.push('', `Contrast (WCAG 2, text on its background colour) [derived]: ${C.textElements} text element(s) graded, ${C.failingPairs} pair(s) under AA (${C.failingElements} element(s))${notGraded.length ? `; not graded: ${notGraded.join(', ')}` : ''}`);
  if (C.failingPairs) L.push('  (graded against the background colours of the text\'s own ancestors; text over a positioned image or video that is not one of them can still read as failing)');
  for (const p of C.pairs) L.push(`  ${p.text} on ${p.background}: ${n(p.ratio.value)}:1 ${p.grade} · ×${p.count}, smallest ${n(p.smallestSize.value)} px`);

  const S = d.spacing;
  L.push('', `Spacing${S.base ? ` (base ${say(S.base)})` : ''}`);
  if (S.values.length) L.push(`  ${S.values.map((v) => `${n(v.value)}${v.label === 'exact' ? '*' : ''}`).join(' · ')} px  (* = exact, from the page CSS; others measured)`);
  if (S.negative) L.push(`  ${S.negative} negative margin(s)`);
  if (d.radii.values.length) L.push('', `Radii: ${d.radii.values.map((r) => (r.corners ? `${Object.values(r.corners).map((x) => x ?? 'withheld').join(' ')} [${r.label}]` : say(r, { css: false }))).map((x, i) => `${x} ×${d.radii.values[i].count}`).join(' · ')}`);
  if (d.shadows.values.length) {
    L.push('', 'Shadows');
    for (const s of all ? d.shadows.values : d.shadows.values.slice(0, 4)) L.push(`  ${s.kind} [${s.label}] ×${s.count}: ${s.layers.map((y) => `${y.inset ? 'inset ' : ''}${n(y.x)} ${n(y.y)} ${n(y.blur)}${y.spread != null ? ` ${n(y.spread)}` : ''} px ${y.color}`).join(', ')}`);
  }

  const Y = d.layout;
  L.push('', `Layout [measured] · page ${n(Y.documentHeight.value)} px tall at ${Y.viewport.width} px`);
  if (Y.containers.length) L.push(`  content widths (centred): ${Y.containers.map((c) => `${n(c.width.value)} px ×${c.count}`).join(', ')}`);
  if (Y.grids.length) L.push(`  grids: ${Y.grids.map((g) => `${g.columns} columns (${g.tracks.map(n).join(' ')} px${g.gap ? `, gap ${n(g.gap)} px` : ''}) ×${g.count}`).join('; ')}`);
  if (Y.flexRows.length) L.push(`  rows of items: ${Y.flexRows.map((f) => `${f.items} items${f.gap ? ` gap ${n(f.gap)} px` : ''} ×${f.count}`).join('; ')}`);
  if (Y.sections) L.push(`  ${Y.sections.count} full-width sections in ${Y.sections.in}: heights ${Y.sections.heights.map(n).join(' / ')} px${Y.sections.padding ? `; padding ${n(Y.sections.padding.top)} / ${n(Y.sections.padding.bottom)} px on ${Y.sections.padding.sections}` : ''}`);

  const B = d.breakpoints;
  L.push('', `Breakpoints (sweep ${B.range.from}-${B.range.to} px)`);
  for (const e of B.layoutChanges) L.push(`  ${n(e.at)} px [measured]${e.query ? ` ← ${(e.queries || [e.query]).length > 1 ? 'any of: ' : ''}${queryList(e)} [exact]` : ' (no media query explains it; script-driven or fluid, may move between runs)'}`);
  if (!B.layoutChanges.length) L.push('  no layout change found across the sweep');
  const unused = B.declared.filter((q) => !q.dependsOnHeight && !B.layoutChanges.some((e) => (e.queries || [e.query]).includes(q.query)));
  if (unused.length) L.push(`  declared with no layout change seen [exact]: ${unused.slice(0, 8).map((q) => `${q.query} (${q.edges.join(', ')} px)`).join(' | ')}${unused.length > 8 ? ` | +${unused.length - 8} more` : ''}`);
  const tall = B.declared.filter((q) => q.dependsOnHeight);
  if (tall.length) L.push(`  also test the viewport height (edge depends on it; not measured): ${tall.slice(0, 4).map((q) => q.query).join(' | ')}${tall.length > 4 ? ` | +${tall.length - 4} more` : ''}`);
  if (B.reflowOnly || B.continuous) L.push(`  ${B.reflowOnly != null ? `${B.reflowOnly} text-wrap-only edge(s), ` : ''}${B.continuous} inside fluid sizing (not breakpoints)`);

  L.push('', `Hover / focus [measured] (${d.states.elements} element(s) forced)`);
  for (const g of d.states.changes) L.push(`  ${g.on || '?'} ${g.state} ×${g.count}: ${g.changes.map((c) => `${c.property} ${c.from ?? '?'} → ${c.to ?? '?'}`).join('; ')}${transitionText(g)}`);
  if (!d.states.changes.length) L.push('  nothing changes');
  if (d.states.more) L.push(`  (${d.states.more} more group(s) in the JSON)`);

  const P = d.customProperties;
  L.push('', `Custom properties: ${P.count}${P.count ? ` (${Object.entries(P.byKind).map(([k, c]) => `${c} ${k}`).join(', ')})` : ''} [${P.label || 'exact'}${P.unreadableSheets ? `: ${P.unreadableSheets} stylesheet(s) from another origin could not be read, so this is a floor` : ''}]`);

  const G = d.gaps || designGaps(d);
  L.push('', 'Not measured');
  for (const g of G) L.push(`  ${g.count} × ${g.what}${g.probe ? ` (to resolve: ${g.probe})` : ''}`);
  if (!G.length) L.push('  nothing recorded as unknown');
  L.push('', 'values: exact = read from the page CSS (its own declaration) · measured = computed by the browser · derived = our arithmetic (ratio, contrast, role, base)');
  return L.map((l) => String(l).replace(CONTROL_CHARS, '')).join('\n');
}

/** ' · transition: all 200 ms ease-out, delay 50 ms [measured]' (declared on the control, computed style), or an instant change. */
export function transitionText(g) {
  if (!Array.isArray(g.transition)) return '';
  if (!g.transition.length) return ' · no transition on these properties: instant';
  return ` · transition: ${g.transition.map((t) => `${t.property} ${t.duration} ms ${t.easing}${t.delay ? `, delay ${t.delay} ms` : ''}`).join('; ')} [measured]`;
}
