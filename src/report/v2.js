// Report v2 assembly (M4). Report v2 = report v1 + the static layer. Report v1 (M3) does not exist yet, so this module is
// the standalone assembler with ONE merge point for M3: pass M3's report object as `v1` and it comes back with
// `version: 'v2'` and the M4 sections added under `sections`; no v1 field is edited or removed.
//   sections.static                  static layer (src/static/report.js, mergeStaticSection)
//   sections.freeze                  frozen-copy section (src/freeze/report.js, freezeSection)
//   sections['static.motion-libraries']  bundle-signature detection (src/libdetect/section.js, P4)
// Sections that were not supplied are listed in `missing` with a reason, never silently dropped (PLAN H6).
import { mergeStaticSection, renderStaticMarkdown } from '../static/report.js';
import { freezeSection } from '../freeze/report.js';
import { loadModules } from '../libdetect/modules.js';
import { detectLibraries } from '../libdetect/detect.js';
import { librariesSection, SECTION_ID as LIBS_ID } from '../libdetect/section.js';
import { renderMarkdown as renderReportV1Markdown } from './render-md.js';
import { REPORT_SCHEMA as V1_SCHEMA } from './model.js';
import { isSchema } from '../util/schema.js';

export const REPORT_SCHEMA = 'reva.report/2';

export async function buildReportV2({ v1 = null, staticSection = null, freezeDir = null, libdetectInputs = [], libdetectResult = null, behaviour, dom } = {}) {
  let report = v1 ? { ...v1 } : {};
  report.schema = report.schema || REPORT_SCHEMA;
  report.version = 'v2';
  report.sections = { ...(report.sections || {}) };
  const missing = [];
  if (staticSection) report = mergeStaticSection(report, staticSection);
  else missing.push({ section: 'static', reason: 'no static section supplied (run `reva static <url>` and pass static-section.json)' });
  if (freezeDir) report.sections.freeze = freezeSection(freezeDir);
  else missing.push({ section: 'freeze', reason: 'no archive directory supplied (run `reva freeze run` first)' });
  let libs = libdetectResult;
  if (!libs && (libdetectInputs.length || behaviour || dom)) {
    const { modules, skipped } = loadModules(libdetectInputs);
    libs = detectLibraries({ modules, skipped, dom, behaviour });
  }
  if (libs) report.sections[LIBS_ID] = librariesSection(libs);
  else missing.push({ section: LIBS_ID, reason: 'no script inputs supplied (static run saves them under <outDir>/scripts/; pass them with --libs)' });
  report.m4 = { missing, merge: report.m4?.merge || 'standalone: report v1 (M3) was not present at build time unless `v1` was passed' };
  if (!v1) report.m4.v1 = 'absent';
  return report;
}

export function renderReportV2Markdown(report) {
  // Merge point (M3 + M4): when `v1` was M3's report (schema reva.report/0), render the whole report with M3's renderer,
  // which prints the motion + scores sections and every foreign section (static, freeze, libraries), so no v1 content is lost.
  if (isSchema(report.schema, V1_SCHEMA) && report.mechanisms) {
    const L = [renderReportV1Markdown(report).replace(/\n+$/, ''), ''];
    for (const m of report.m4?.missing || []) L.push(`> Left out: ${m.section} - ${m.reason}`, '');
    return L.join('\n') + '\n';
  }
  const L = [`# Report ${report.version}`, ''];
  const s = report.sections || {};
  if (s.static) L.push(renderStaticMarkdown(s.static));
  if (s.freeze) L.push(s.freeze.markdown);
  if (s[LIBS_ID]) L.push(s[LIBS_ID].markdown);
  for (const m of report.m4?.missing || []) L.push(`> Left out: ${m.section} - ${m.reason}`, '');
  return L.join('\n') + '\n';
}
