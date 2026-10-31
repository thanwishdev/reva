// MERGE POINT for M4 (report v2 = report v1 + static layer), aligned with what build/m4 ships:
//   - `report.sections` is an OBJECT keyed by section id (motion, scores, static, freeze, 'static.motion-libraries', ...).
//   - report v1 carries `sections.static = {status: 'not_included', reason, merge}`; M4 replaces it:
//         import { buildStaticSection, mergeStaticSection } from '../static/report.js';
//         const v2 = mergeStaticSection(reportV1, buildStaticSection(staticRecord));   // or buildReportV2({ v1 }) in src/report/v2.js
//     which sets `version: 'v2'`, `sections.static = section` and appends `section.unknowns` (tagged `layer: 'static'`) to `report.unknowns`.
//   - buildReport({ sections: { static, freeze, ... } }) does the same attach for callers that have the sections up front.
// Rendering: a section is printed by a registered renderer (registerSectionRenderer), else by its own `markdown` string, else a one-line
// pointer to the JSON. `static` gets M4's renderStaticMarkdown automatically when src/static/report.js exists in the tree.
// A foreign section is NOT walked by validateReport: its producer owns its checks (M4 DONE WHEN); what this report guarantees is that
// it is listed, never dropped, and that a section left out says why.
import { cleanText } from './untrusted.js';

export const OWN_SECTIONS = ['motion', 'scores'];
export const STATIC_PLACEHOLDER = {
  id: 'static', title: 'Static layer', order: 20, status: 'not_included',
  reason: 'report v1 is motion only; the static layer (M4) is merged in to make report v2',
  merge: "mergeStaticSection(report, buildStaticSection(record)) from src/static/report.js, or buildReportV2({ v1: report }) in src/report/v2.js",
};

const renderers = new Map();
/** fn(section) -> markdown string. */
export function registerSectionRenderer(id, fn) { renderers.set(id, fn); }

// Auto-register M4's renderer when the module is in the tree (it is not in build/m3 alone).
try { const m = await import('../static/report.js'); if (typeof m.renderStaticMarkdown === 'function') renderers.set('static', m.renderStaticMarkdown); }
catch (e) { if (!(e && e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('static/report.js'))) throw e; }

/** Attach foreign sections like M4's mergeStaticSection does; never edits a v1 field except `version` and appending to `unknowns`. */
export function attachSections(report, sections) {
  const ids = Object.keys(sections || {}).filter((k) => sections[k]);
  if (!ids.length) return report;
  report.version = 'v2'; report.kind = 'motion+static';
  for (const id of ids) {
    const s = sections[id];
    report.sections[id] = s;
    if (Array.isArray(s.unknowns)) report.unknowns.push(...s.unknowns.map((u) => ({ ...u, layer: id })));
  }
  return report;
}

/** Markdown for one foreign section. */
export function renderForeignSection(id, s) {
  if (!s || s.status === 'not_included') return `## ${s?.title || id}\n\n_Not included: ${cleanText(s?.reason || 'no reason given', 300)}._${s?.merge ? ` Merge point: ${cleanText(s.merge, 300)}.` : ''}\n`;
  const fn = renderers.get(id);
  if (fn) return fn(s);
  if (typeof s.markdown === 'string') return s.markdown;
  return `## ${s.title || id}\n\n_Section \`${cleanText(id, 60)}\` is attached as data (see report.json); no renderer is registered for it._\n`;
}
