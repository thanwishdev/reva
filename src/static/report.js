// Report v2 = report v1 (motion, M3) + the static layer. Report v1 does not exist yet, so this is the static section as a
// STANDALONE module with ONE merge point for M3:
//
//     import { buildStaticSection, mergeStaticSection } from '../static/report.js';
//     const report = mergeStaticSection(reportV1, buildStaticSection(staticRecord));   // -> report v2
//
// `mergeStaticSection` only adds `sections.static` (+ `version: 'v2'`, + the static unknowns appended to the report's own
// `unknowns` list when it has one); it never edits a v1 field. M3 owns how a section is rendered inside the full report
// page: `renderStaticMarkdown(section)` is the default rendering and can be replaced.
//
// Rules carried from the plan: every value shows its provenance; every family left out is listed with a reason; dembrandt
// output is shown as hints, never as findings; a11y is shown per viewport.
import { STATIC_SCHEMA } from './prov.js';

export const SECTION_SCHEMA = 'reva.report-section/0';
const TAG = { measured: 'm', declared: 'd', inferred: 'i', unknown: 'u', fitted: 'f' };
export const FAMILY_IDS = ['typography', 'spacing', 'colors', 'shadows', 'radii', 'layout', 'breakpoints', 'declared', 'states', 'variants', 'fonts', 'assets', 'a11y', 'scripts', 'hints'];

const tag = v => (v && v.provenance ? `{${TAG[v.provenance]}}` : '');
const val = v => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const cell = v => { const x = val(v); return x == null ? '—' : String(typeof x === 'object' ? JSON.stringify(x) : x).replace(/\|/g, '\\|') + (v && v.provenance ? ' ' + tag(v) : ''); };
const sel = s => '`' + String(s).replace(/`/g, "'") + '`';

/** Pure: static record -> report section (JSON). */
export function buildStaticSection(record) {
  const base = record.variants[0];
  const t = base.tokens;
  const families = [];
  const add = (id, title, summary, rows, extra = {}) => families.push({ id, title, summary, rows, ...extra });

  add('typography', 'Typography', `${t.typography.length} distinct text styles at ${base.id}`, t.typography.map(x => ({
    id: x.id, family: x.fontFamily, size: x.fontSize, weight: x.fontWeight, lineHeight: x.lineHeight, lineHeightRatio: x.lineHeightRatio ?? null,
    letterSpacing: x.letterSpacing, letterSpacingEm: x.letterSpacingEm ?? null, textTransform: x.textTransform, count: x.count, notRendered: x.onlyNotRendered, examples: x.examples, declared: x.declared ?? [],
  })));
  add('spacing', 'Spacing', `${t.spacing.scale.length} distinct margin/padding/gap values; base unit ${t.spacing.base.provenance === 'unknown' ? 'unknown' : t.spacing.base.value + 'px'}`,
    t.spacing.scale.map(x => ({ px: x.px, count: x.count, byProperty: x.byProperty, declared: x.declared ?? [] })), { base: t.spacing.base, excludedLargeValues: t.spacing.excludedLargeValues });
  add('colors', 'Colours', `${t.colors.length} distinct colours (text, background, border, outline, svg fill/stroke)`, t.colors.map(x => ({ id: x.id, raw: x.raw, hex: x.hex, alpha: x.alpha ?? null, roles: x.roles, count: x.count, declared: x.declared ?? [] })));
  add('shadows', 'Shadows', `${t.shadows.length} distinct shadows`, t.shadows.map(x => ({ id: x.id, kind: x.kind, raw: x.raw, layers: x.layers, count: x.count, declared: x.declared ?? [] })));
  add('radii', 'Radii', `${t.radii.length} distinct radius sets`, t.radii.map(x => ({ id: x.id, corners: x.corners, uniform: x.uniform, count: x.count, declared: x.declared ?? [] })));
  add('layout', 'Layout boxes', `${t.layout.boxes.length} boxes at ${base.id}; ${t.layout.notRenderedElements} elements not rendered`, t.layout.boxes.map(b => ({ sel: b.sel, tag: b.tag, rect: b.rect, display: b.display, flex: b.flex ?? null, grid: b.grid ?? null })));
  add('breakpoints', 'Breakpoints (declared vs measured)', `${record.breakpoints.edges.length} measured layout edges, ${record.breakpoints.declaredQueries.length} declared/hooked queries`, record.breakpoints.edges.map(e => ({
    lastOld: e.lastOld, firstNew: e.firstNew, explainedBy: e.explainedBy, explanation: e.explanation ?? null, near: e.near,
  })), { declaredQueries: record.breakpoints.declaredQueries, declaredWithoutMeasuredEffect: record.breakpoints.declaredWithoutMeasuredEffect, method: record.breakpoints.method, range: record.breakpoints.range, fluidCells: record.breakpoints.fluidCells });
  add('declared', 'Declared sources and custom properties', `${record.declared.customProperties.length} custom properties; cascade winners with file:line resolved for ${base.declaredLookup?.rowsLooked ?? 0} representative elements`, record.declared.customProperties, { atRules: record.declared.atRules, supports: record.declared.supports, containers: record.declared.containers, keyframes: record.declared.keyframes, mediaConditions: record.declared.mediaConditions });
  add('states', 'Interactive states (forced :hover / :focus)', `${base.states?.length ?? 0} state differences`, base.states ?? []);
  add('variants', 'Variants (viewports, colour scheme, reduced motion, touch)', `${record.variants.length} variants`, record.variants.map(v => ({ id: v.id, requested: v.requested, viewport: v.viewport, media: v.media, document: v.document, elementCount: v.elementCount, textStyles: v.tokens.typography.length, colours: v.tokens.colors.length })), { deltas: record.variantDeltas });
  add('fonts', 'Fonts', `${record.assets.fonts.used.length} faces actually used; ${record.assets.fonts.declaredNotUsed.length} declared but not used`, record.assets.fonts.used, { declaredFaces: record.assets.fonts.declaredFaces, files: record.assets.fonts.files, declaredNotUsed: record.assets.fonts.declaredNotUsed });
  add('assets', 'SVG and images', `${record.assets.svg.inline.length} inline svg, ${record.assets.svg.external.length} external svg, ${record.assets.images.length} img elements`, record.assets.svg.external, { inline: record.assets.svg.inline, images: record.assets.images, backgroundUrls: record.assets.backgroundUrls, stylesheets: record.assets.stylesheets });
  add('a11y', 'Accessibility structure (ariaSnapshot, per viewport)', `${record.a11y.length} viewports`, record.a11y.map(a => ({ variant: a.variant, lines: a.lines, structureSha256: a.structureSha256, snapshot: a.snapshot })));
  add('scripts', 'Scripts handed to bundle analysis', `${record.scripts.files.length} script files saved under ${record.scripts.dir}/ for the bundle-signature step (src/libdetect)`, record.scripts.files, { note: record.scripts.note });
  const h = record.hints?.dembrandt;
  add('hints', 'Hints (dembrandt, not findings)', h ? 'dembrandt output tagged as hints' : 'dembrandt was not run for this record', h ? [h] : [], { reason: 'dembrandt breakpoints/motion/primary colour come from heuristics; compare with the measured families above' });

  const leftOut = [
    { family: 'Motion tokens (transition/animation/easing)', reason: 'behaviour over time is the motion layer (M1/M2); dembrandt motion is shown only as a hint' },
    { family: 'Motion-library detection', reason: 'P4 bundle-signature detection is src/libdetect; this layer only saves the scripts it reads (see the scripts family)' },
    { family: 'Page text content', reason: 'copy is site-derived content and not needed for the tokens; only structure (a11y roles/names) is kept' },
    { family: 'Font file internals (axes, glyph coverage, licences)', reason: 'needs fonttools (optional external step); unk_fonttools' },
    { family: 'SVG optimisation / id rewriting', reason: 'svgo rewrites ids and runs only after motion analysis; unk_svgo' },
    { family: 'Container-query edges', reason: 'depend on the container width, not the viewport; declared queries are listed, edges are not measured' },
    { family: 'Print media and non-emulated media features', reason: 'declared rules are listed in the unknowns ledger; the passes are not run' },
    { family: 'iframe and canvas contents', reason: 'not styles; listed as unknowns with the probe that would resolve them' },
    { family: 'Components (buttons/badges/inputs) as a family', reason: 'dembrandt exposes them as hints; interactive states are measured per element instead' },
  ];
  return {
    schema: SECTION_SCHEMA, id: 'static', title: 'Static layer', recordSchema: STATIC_SCHEMA, recordId: record.id, target: record.target,
    legend: { m: 'measured (read from the browser)', d: 'declared (source text from the engine\'s CSS model / a matchMedia call)', i: 'inferred (our arithmetic or heuristic)', u: 'unknown (reason and probe in the ledger)' },
    environment: record.environment, families, leftOut, unknowns: record.unknowns,
  };
}

/** The M3 merge point. Adds sections.static and bumps the version; never edits a v1 field. */
export function mergeStaticSection(reportV1, section) {
  const r = reportV1 ? { ...reportV1 } : {};
  r.version = 'v2';
  r.sections = { ...(r.sections || {}), static: section };
  if (Array.isArray(r.unknowns)) r.unknowns = [...r.unknowns, ...section.unknowns.map(u => ({ ...u, layer: 'static' }))];
  return r;
}

function table(headers, rows) {
  if (!rows.length) return '_none_\n';
  return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map(r => `| ${r.join(' | ')} |`).join('\n')}\n`;
}
const dl = (arr = []) => arr.length ? arr.map(d => `${d.value} {d} ${d.source}${d.important ? ' !important' : ''}${d.verified === false ? ' (unverified)' : ''}`).join('; ') : '—';

/** Default Markdown rendering of the section. */
export function renderStaticMarkdown(section) {
  const L = [];
  L.push(`## ${section.title}`, '', `Target: ${section.target.url} (record ${section.recordId}). Provenance tags: ${Object.entries(section.legend).map(([k, v]) => `{${k}} ${v}`).join('; ')}.`, '');
  for (const f of section.families) {
    L.push(`### ${f.title}`, '', f.summary, '');
    if (f.id === 'typography') L.push(table(['id', 'family', 'size', 'weight', 'line-height', 'ratio', 'letter-spacing', 'em', 'transform', 'count', 'declared'], f.rows.map(r => [r.id, cell(r.family), cell(r.size), cell(r.weight), cell(r.lineHeight), cell(r.lineHeightRatio), cell(r.letterSpacing), cell(r.letterSpacingEm), cell(r.textTransform), r.count, dl(r.declared)])));
    else if (f.id === 'spacing') L.push(`Base unit: ${cell(f.base)}${f.base.provenance === 'unknown' ? ' — ' + f.base.reason : ''}`, '', table(['px', 'count', 'by property', 'declared'], f.rows.map(r => [cell(r.px), r.count, JSON.stringify(r.byProperty), dl(r.declared)])));
    else if (f.id === 'colors') L.push(table(['id', 'raw', 'hex', 'roles', 'count', 'declared'], f.rows.map(r => [r.id, cell(r.raw), cell(r.hex), JSON.stringify(r.roles), r.count, dl(r.declared)])));
    else if (f.id === 'shadows') L.push(table(['id', 'kind', 'raw', 'layers', 'count'], f.rows.map(r => [r.id, r.kind, cell(r.raw), cell(r.layers), r.count])));
    else if (f.id === 'radii') L.push(table(['id', 'corners', 'count', 'declared'], f.rows.map(r => [r.id, cell(r.corners), r.count, dl(r.declared)])));
    else if (f.id === 'layout') L.push(table(['element', 'rect', 'display', 'flex / grid'], f.rows.map(r => [sel(r.sel), cell(r.rect), cell(r.display), r.flex ? cell(r.flex) : r.grid ? cell(r.grid) : '—'])));
    else if (f.id === 'breakpoints') {
      L.push(`Method: ${f.method.value}. Sweep ${f.range.from}-${f.range.to} px; ${f.fluidCells} fluid cells masked.`, '',
        table(['last old px', 'first new px', 'explained by', 'otherwise'], f.rows.map(r => [cell(r.lastOld), cell(r.firstNew), r.explainedBy.length ? r.explainedBy.map(b => `${b.value} {d} ${b.source}`).join('; ') : '—', r.explanation ? (r.explanation.provenance === 'unknown' ? `{u} ${r.explanation.reason}` : `{i} ${r.explanation.value}: ${r.explanation.from}`) : ''])), '',
        'Declared / hooked queries and their width edges (engine-evaluated):', '', table(['query', 'edges (last old, first new)'], f.declaredQueries.map(q => [cell(q.query), q.widthEdges.length ? q.widthEdges.map(e => `${e.lastOld}|${e.firstNew}`).join(', ') : 'not a width edge'])));
      if (f.declaredWithoutMeasuredEffect.length) L.push('', 'Declared edges with no measured layout change: ' + f.declaredWithoutMeasuredEffect.map(q => `${q.query} @${q.edge.firstNew}`).join('; '));
    }
    else if (f.id === 'declared') L.push(table(['custom property', 'declared value', 'source'], f.rows.map(r => [sel(r.name), cell({ ...r.value, provenance: undefined }), r.value.source])), '', `At-rules: ${JSON.stringify(f.atRules.value)} {d}`);
    else if (f.id === 'states') L.push(table(['element', 'state', 'property', 'rest', 'in state'], f.rows.map(r => [sel(r.sel), r.state, r.prop, cell(r.rest), cell(r.value)])));
    else if (f.id === 'variants') L.push(table(['variant', 'requested', 'viewport', 'document', 'text styles', 'colours'], f.rows.map(r => [r.id, JSON.stringify(r.requested), cell(r.viewport), cell(r.document), r.textStyles, r.colours])), '', 'Deltas against the base variant: ' + f.deltas.map(d => `${d.variant}: height ${d.differsInHeight ? 'differs' : 'same'}, a11y structure ${d.a11yStructureSame ? 'same' : 'differs'}`).join('; '));
    else if (f.id === 'fonts') L.push(table(['family', 'postscript', 'custom', 'glyphs'], f.rows.map(r => [cell(r.familyName), cell(r.postScriptName), cell(r.isCustomFont), cell(r.glyphCount)])), '', 'Font files (bytes from this session\'s responses): ' + (f.files.map(x => `${x.url} ${cell(x.bytes)} B`).join('; ') || 'none'), '', 'Declared but not used: ' + (f.declaredNotUsed.join(', ') || 'none'));
    else if (f.id === 'assets') L.push(table(['external svg', 'bytes', 'referenced by'], f.rows.map(r => [r.url, cell(r.bytes), r.referencedBy])), '', `Inline svg: ${f.inline.length}; img elements: ${f.images.length}; css background urls: ${f.backgroundUrls.length}.`);
    else if (f.id === 'a11y') for (const r of f.rows) L.push(`**${r.variant}** (${r.lines} lines, structure sha256 ${String(r.structureSha256).slice(0, 12)})`, '', '```', typeof r.snapshot === 'string' ? r.snapshot : JSON.stringify(r.snapshot), '```', '');
    else if (f.id === 'scripts') L.push(table(['script', 'bytes', 'file'], f.rows.map(r => [r.name, r.bytes, r.file])), '', f.note);
    else if (f.id === 'hints') L.push(f.rows.length ? `${f.reason}. {i} hint: ${Object.keys(f.rows[0]).filter(k => !['tool', 'provenance', 'hint', 'raw', 'exit', 'keys'].includes(k)).join(', ')}.` : f.reason);
    L.push('');
  }
  L.push('### Left out of the static layer', '', table(['family', 'reason'], section.leftOut.map(x => [x.family, x.reason])), '');
  L.push('### Unknowns ledger (static)', '', table(['id', 'scope', 'reason', 'probe'], section.unknowns.map(u => [u.id, u.scope ?? '', String(u.reason).replace(/\|/g, '\\|'), String(u.probe).replace(/\|/g, '\\|')])));
  return L.join('\n');
}
