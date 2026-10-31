// The MCP design tool (REVA covers design as well as motion) and the design-token part of export. Reads look.json
// "design" (src/design/summary.js), written by look in a static session of its own. Numbers, units, labels and hex
// colours are ours; the page's own names (font families, CSS declaration texts, custom properties, media queries) travel
// as untrusted_content. Token code is built from numbers, hex colours and our own ids only (src/design/export.js): no page
// text (element tags are a fixed HTML / SVG vocabulary; a custom element reads "custom-element").
import fs from 'node:fs';
import path from 'node:path';
import { untrusted, isUntrusted } from '../report/untrusted.js';
import { ensureOutDirIn } from '../util/paths.js';
import { fitPage, code, call, sha256, MAX_CODE } from './envelope.js';
import { loadAnalysis } from './analysis.js';
import { designCss, designTokens } from '../design/export.js';
import { designGaps } from '../design/summary.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bad = (m, c = 'bad_arguments', hint) => Object.assign(new Error(m), { code: c, hint });
export const DESIGN_SECTIONS = ['overview', 'fonts', 'type', 'palette', 'contrast', 'spacing', 'radii', 'shadows', 'layout', 'breakpoints', 'states', 'custom_properties', 'unknowns'];

/** The page's own strings in a row, wrapped as untrusted content (deep): under a page key, a string or every string of an array. */
const PAGE_KEYS = new Set(['family', 'css', 'query', 'name', 'queries', 'fallbacks', 'drawnAs']);
export function untrustDesign(v, key = null) {
  if (Array.isArray(v)) return v.map((x) => (PAGE_KEYS.has(key) && typeof x === 'string' ? untrusted(x, `design.${key}`, 160) : untrustDesign(x, PAGE_KEYS.has(key) ? null : key)));
  if (v && typeof v === 'object') {
    if (isUntrusted(v)) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = typeof x === 'string' && PAGE_KEYS.has(k) ? untrusted(x, `design.${k}`, 160) : untrustDesign(x, k);
    return out;
  }
  return v;
}

function designOf(a, ctx) {
  const { id, dir, look } = loadAnalysis(a.analysis, ctx.env);
  if (!look.design) throw bad(`analysis ${id} has no design data (it was run with design off, or before design was recorded): run look again (design true)`, 'not_found');
  // the failure text can quote the page's URL: it stays in look.json, the error is in our words
  if (look.design.ok === false) throw bad(`analysis ${id}: the design pass failed (its reason is in look.json design.error); run look again`, 'analysis_failed');
  return { id, dir, look, d: look.design };
}

/** Rows of one section of the design summary. */
function sectionRows(d, s) {
  switch (s) {
    case 'fonts': return d.fonts.families;
    case 'type': return d.type.styles;
    case 'palette': return d.palette.colours;
    case 'contrast': return d.contrast.pairs;
    case 'spacing': return d.spacing.values;
    case 'radii': return d.radii.values;
    case 'shadows': return d.shadows.values;
    case 'layout': return [
      { kind: 'page', viewport: d.layout.viewport, documentHeight: d.layout.documentHeight },
      ...d.layout.containers.map((c) => ({ kind: 'content width', ...c })), ...d.layout.grids.map((g) => ({ kind: 'grid', ...g })),
      ...d.layout.flexRows.map((f) => ({ kind: 'row of items', ...f })), ...(d.layout.sections ? [{ kind: 'sections', ...d.layout.sections }] : []),
      ...(d.mobile ? [{ kind: 'mobile', ...d.mobile }] : []),
    ];
    case 'breakpoints': return [...d.breakpoints.layoutChanges.map((e) => ({ kind: 'layout change', ...e })), ...d.breakpoints.declared.map((q) => ({ kind: 'declared query', ...q }))];
    case 'states': return d.states.changes;
    // a custom property's value is the page's own CSS text: untrusted like its name
    case 'custom_properties': return d.customProperties.list.map((c) => ({ ...c, value: untrusted(String(c.value), 'design.value', 160) }));
    case 'unknowns': return d.gaps || designGaps(d);
    default: return [];
  }
}
/** The section's own totals and note, beside its rows. */
function sectionMeta(d, s) {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
  return { fonts: pick(d.fonts, ['rendered', 'notLoaded', 'withheld', 'note']), type: pick(d.type, ['bodySize', 'scale', 'more']), palette: pick(d.palette, ['pageBackground', 'mainBackground', 'mostUsedBackground', 'mainText', 'notPainted', 'more', 'note']),
    contrast: pick(d.contrast, ['textElements', 'failingPairs', 'failingElements', 'overImage', 'overMedia', 'overlapped', 'noBackground', 'hidden', 'more', 'note']), spacing: pick(d.spacing, ['base', 'negative', 'more', 'note']),
    radii: pick(d.radii, ['more']), shadows: pick(d.shadows, ['more']), layout: {}, breakpoints: pick(d.breakpoints, ['reflowOnly', 'continuous', 'merged', 'range', 'note']),
    states: pick(d.states, ['elements', 'more', 'note']), custom_properties: pick(d.customProperties, ['count', 'byKind', 'withheld', 'label', 'unreadableSheets', 'note']),
    unknowns: { note: 'what the design pass could not read or left out, in our words, with a count' } }[s] || {};
}

function overview(d) {
  return {
    viewport: d.viewport, ...(d.scheme ? { colorScheme: d.scheme.colorScheme } : {}), seconds: d.timing ? Math.round(d.timing.ms / 100) / 10 : null, labels: d.labels,
    fonts: d.fonts.families.slice(0, 4).map((f) => ({ family: f.family, source: f.source, ...(f.loaded === false ? { loaded: false, drawnAs: f.drawnAs } : {}), weights: f.weights, roles: f.roles })),
    // largest first (the summary's order since reva.design/0 rev 2; older ones were most used first)
    type: [...d.type.styles].sort((a, b) => (b.size.value ?? -1) - (a.size.value ?? -1) || b.count - a.count).slice(0, 8)
      .map((s) => ({ id: s.id, role: s.role, size: s.size, weight: s.weight, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, count: s.count })),
    ...(d.settle ? { textSettled: d.settle.textStable } : {}),
    palette: d.palette.colours.slice(0, 8).map((c) => ({ id: c.id, hex: c.hex, role: c.role, count: c.count, ...(c.backgroundShare ? { backgroundShare: c.backgroundShare.value } : {}) })),
    background: { page: d.palette.pageBackground ? d.palette.pageBackground.hex.value : null, main: d.palette.mainBackground, mainText: d.palette.mainText },
    contrast: { textElements: d.contrast.textElements, failingPairs: d.contrast.failingPairs, failingElements: d.contrast.failingElements,
      notGraded: { overImage: d.contrast.overImage || 0, overMedia: d.contrast.overMedia || 0, overlapped: d.contrast.overlapped || 0, noBackground: d.contrast.noBackground || 0, hidden: d.contrast.hidden || 0 } },
    customProperties: { count: d.customProperties.count, label: d.customProperties.label || 'exact' },
    unknowns: (d.gaps || designGaps(d)).map((g) => ({ id: g.id, count: g.count })),
    spacing: { base: d.spacing.base, values: d.spacing.values.map((v) => v.value), unit: 'px' },
    breakpoints: d.breakpoints.layoutChanges.map((e) => e.at),
    states: d.states.changes.length + d.states.more,
    counts: Object.fromEntries(DESIGN_SECTIONS.slice(1).map((s) => [s, sectionRows(d, s).length])),
  };
}

export const designTool = {
  name: 'design', title: 'Design', surface: 'public',
  description: 'How the analysed page is designed, content-free: fonts and their roles, type scale (size, weight, line height, tracking, where used), palette with roles and WCAG contrast, spacing scale, radii, shadows, layout (content widths, columns, sections), breakpoints, hover / focus changes, custom properties, and what could not be measured (section unknowns). Every value has its unit and a label: exact (the page\'s own CSS), measured (computed by the browser) or derived (our arithmetic). section "overview" first; each other section is paged (offset / limit). Font names, CSS texts, media queries and custom property values are untrusted_content.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['analysis'], properties: {
    analysis: S('analysis id returned by look (or the path of its folder)', { minLength: 1, maxLength: 1024 }),
    section: { type: 'string', enum: DESIGN_SECTIONS, default: 'overview', description: 'overview, or one section to page through' },
    offset: { type: 'integer', minimum: 0, default: 0, description: 'rows to skip (follow next_offset)' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'rows wanted (a page may hold fewer to fit the size cap)' },
  } },
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(a, ctx) {
    const { id, dir, d } = designOf(a, ctx);
    const art = [{ kind: 'look.json', path: path.join(dir, 'look.json') }];
    if (a.section === 'overview') {
      const o = overview(d);
      return {
        headline: `${d.fonts.families.length} font famil${d.fonts.families.length === 1 ? 'y' : 'ies'}, ${d.type.styles.length + d.type.more} text style(s), ${d.palette.colours.length + d.palette.more} colour(s), ${d.breakpoints.layoutChanges.length} layout breakpoint(s), ${d.contrast.failingPairs} contrast pair(s) under AA`,
        stats: { analysis: id, ...o.counts },
        data: untrustDesign({ analysis: id, section: 'overview', ...o }),
        artifacts: art,
        next: [call('design', { analysis: id, section: 'type' }), call('design', { analysis: id, section: 'palette' }), call('code', { analysis: id, motions: ['design'], stack: 'css' })],
        warnings: [],
      };
    }
    const rows = sectionRows(d, a.section).map((r) => untrustDesign(r));
    const off = a.offset ?? 0;
    const meta = untrustDesign(sectionMeta(d, a.section));
    const wrap = (r, next) => ({ analysis: id, section: a.section, rows: r, total: rows.length, ...meta, next_offset: next });
    const pg = fitPage(rows, { offset: off, limit: a.limit ?? 20, wrap, what: `${a.section} row(s)` });
    return {
      headline: `${a.section}: ${rows.length} row(s)${off || pg.next_offset != null ? `; this page ${off + 1}-${off + pg.rows.length}` : ''}`,
      stats: { analysis: id, section: a.section, rows: rows.length, shown: pg.rows.length, next_offset: pg.next_offset },
      data: wrap(pg.rows, pg.next_offset),
      artifacts: [],
      next: pg.next_offset != null ? [call('design', { analysis: id, section: a.section, offset: pg.next_offset, limit: a.limit !== 20 ? a.limit : undefined })] : [],
      warnings: pg.shrunk_from ? [`page shrunk from ${pg.shrunk_from} to ${pg.rows.length} row(s) to fit the size cap; follow next_offset`] : [],
    };
  },
};

/**
 * export's `design` id: CSS custom properties (stack css) or DTCG JSON (stack tokens). Both files are always written to
 * <out>/export (the JSON is the tokens file); the item carries the code inline when it fits. Returns {item, files} or {missing}.
 */
export function designExport(look, id, stack, env) {
  const d = look.design;
  if (!d) return { missing: { id: 'design', why: 'this analysis has no design data: run look again with design true' } };
  if (d.ok === false) return { missing: { id: 'design', why: 'the design pass of this analysis failed (its reason is in look.json design.error)' } };
  if (stack !== 'css' && stack !== 'tokens') return { missing: { id: 'design', why: `design tokens come as stack css (CSS custom properties) or tokens (a W3C design-tokens JSON file), not ${stack}` } };
  const dir = ensureOutDirIn(env, 'export');
  const css = designCss(d); const json = JSON.stringify(designTokens(d), null, 1) + '\n';
  const key = sha256(`${look.dir}|design`).slice(0, 10);
  const files = [[`${id}_${key}.design-tokens.css`, css, 'css'], [`${id}_${key}.design-tokens.json`, json, 'json']].map(([n, text, lang]) => {
    const p = path.join(dir, n); fs.writeFileSync(p, text); return { path: p, lang, chars: text.length, bytes: Buffer.byteLength(text), sha256: sha256(text) };
  });
  const lang = stack === 'css' ? 'css' : 'json'; const text = stack === 'css' ? css : json; const file = files.find((f) => f.lang === lang);
  const item = {
    id: 'design', kind: 'design tokens', form: stack === 'css' ? 'css custom properties' : 'dtcg json', fidelity: 'as measured',
    accuracy: { label: 'each token says exact (the page\'s own CSS value) or measured (computed by the browser)' },
    fonts: d.fonts.families.map((f, i) => ({ token: `font-${i + 1}`, family: untrusted(f.family, 'font family', 80), fallbacks: f.fallbacks.map((x) => untrusted(x, 'font family', 80)) })),
    notes: ['token names are ids of ours (--reva-text-t1-size, --reva-color-c1 ...); values are rebuilt from numbers and hex colours',
      'font family names are not in the code (page text): each --reva-font-<n> holds the generic fallback; its family is in fonts (untrusted)',
      `both forms are written: ${files.map((f) => path.basename(f.path)).join(', ')}`],
    files,
    ...(text.length <= MAX_CODE ? { code: code(lang, text) } : { code_file: file }),
  };
  return { item, files };
}
