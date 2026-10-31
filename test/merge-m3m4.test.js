// Merge point M3 + M4 (build/m5): M3's report v1 object goes through M4's buildReportV2 as `v1` and comes back as report v2
// with every v1 field kept, the static/freeze/libraries sections attached or listed as missing, and one markdown page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, renderMarkdown, validateReport } from '../src/report/index.js';
import { buildReportV2, renderReportV2Markdown } from '../src/report/v2.js';
import { synthFit, NOW } from './report/helpers.js';

test('M3 report v1 -> buildReportV2({ v1 }) keeps v1, validates, and renders motion + v2 sections on one page', async () => {
  const v1 = buildReport({ fits: [synthFit()], now: NOW });
  const frozen = JSON.stringify(v1);
  const v2 = await buildReportV2({ v1 });
  assert.equal(JSON.stringify(v1), frozen, 'v1 not mutated');
  assert.equal(v2.version, 'v2');
  assert.equal(v2.schema, v1.schema, 'v1 schema kept');
  assert.deepEqual(v2.mechanisms, v1.mechanisms); assert.deepEqual(v2.sections.motion, v1.sections.motion); assert.deepEqual(v2.sections.scores, v1.sections.scores);
  assert.equal(v2.sections.static.status, 'not_included', 'no static section supplied: the v1 placeholder stays, with its reason');
  assert.deepEqual(v2.m4.missing.map((m) => m.section).sort(), ['freeze', 'static', 'static.motion-libraries']);
  assert.deepEqual(validateReport(v2).errors, []);
  const md = renderReportV2Markdown(v2);
  const md1 = renderMarkdown(v1).replace(/\n+$/, '');
  for (const line of md1.split('\n').filter((l) => /^#+ /.test(l))) assert.ok(md.includes(line), `v1 heading kept: ${line}`);
  assert.match(md, /> Left out: freeze - /);
});

test('libraries section from a precomputed detection is attached, removed from `missing`, and rendered on the same page', async () => {
  const { detectLibraries } = await import('../src/libdetect/detect.js');
  const det = detectLibraries({ modules: [], skipped: [] });
  const v2 = await buildReportV2({ v1: buildReport({ fits: [synthFit()], now: NOW }), libdetectResult: det });
  const sec = v2.sections['static.motion-libraries'];
  assert.ok(sec);
  assert.ok(!v2.m4.missing.some((m) => m.section === 'static.motion-libraries'));
  assert.deepEqual(validateReport(v2).errors, []);
  if (typeof sec.markdown === 'string') assert.ok(renderReportV2Markdown(v2).includes(sec.markdown.trim().split('\n')[0]));
});
