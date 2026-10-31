// Report v1 (motion) entry point: build -> validate -> write report.json + report.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildReport } from './model.js';
import { renderMarkdown } from './render-md.js';
import { validateReport } from './validate.js';
import { ensureOutDir, assertOutsideRepo } from '../util/paths.js';

export { buildReport, renderMarkdown, validateReport };
export { untrusted, cleanText, isUntrusted, UNTRUSTED, READING_RULE } from './untrusted.js';
export { attachSections, registerSectionRenderer, renderForeignSection, STATIC_PLACEHOLDER } from './sections.js';
export { normaliseScore } from './scores.js';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Build from files. `fits` are reva.fitresult/0 JSON files; `takes` (optional) the primary take directories in the same order;
 * `scores` (optional) a JSON file holding an array of score records (or {scores: [...]}); `static` (optional) an M4 section JSON file.
 */
export function buildReportFromFiles({ fits, takes = [], scores, static: staticFile, title, labels }) {
  const f = fits.map(readJson);
  const t = takes.map((d) => (d ? readJson(path.join(d, 'take.json')) : null));
  let sc = []; if (scores) { const j = readJson(scores); sc = Array.isArray(j) ? j : j.scores || []; }
  return buildReport({ fits: f, takes: t, scores: sc, static: staticFile ? readJson(staticFile) : null, title, labels: labels || fits.map((x) => path.basename(x).replace(/\.json$/, '')) });
}

/** Validate, then write report.json and report.md under `dir` (default: <out root>/reports/<digest>). Refuses a report that breaks H6. */
export function writeReport(report, dir) {
  const v = validateReport(report);
  if (!v.ok) { const e = new Error(`report fails its own checks:\n- ${v.errors.slice(0, 10).join('\n- ')}`); e.errors = v.errors; throw e; }
  const out = dir ? assertOutsideRepo(path.resolve(dir)) : ensureOutDir('reports', report.digest);
  fs.mkdirSync(out, { recursive: true });
  const json = JSON.stringify(report, null, 1); const md = renderMarkdown(report);
  fs.writeFileSync(path.join(out, 'report.json'), json); fs.writeFileSync(path.join(out, 'report.md'), md);
  return { dir: out, files: [{ path: path.join(out, 'report.json'), bytes: Buffer.byteLength(json), sha256: sha(json) }, { path: path.join(out, 'report.md'), bytes: Buffer.byteLength(md), sha256: sha(md) }] };
}
