// M4 wiring: static layer + freeze + libdetect assembled into report v2 (the standalone assembler; M3's report v1 plugs in as `v1`).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveStaticFixture } from '../fixtures/static/server.js';
import { startServer } from '../fixtures/freeze-site/server.js';
import { fixtureConfig } from '../fixtures/freeze-site/config.js';
import { extractStatic } from '../src/static/extract.js';
import { buildStaticSection } from '../src/static/report.js';
import { freeze } from '../src/freeze/freeze.js';
import { unsealArchive } from '../src/freeze/build.js';
import { buildReportV2, renderReportV2Markdown } from '../src/report/v2.js';
import { main as cliMain } from '../src/cli.js';

let tmp, sSrv, section, scriptsDir, archive;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-rv2-'));
  sSrv = await serveStaticFixture();
  const r = await extractStatic({ url: sSrv.origin + '/', outDir: path.join(tmp, 'static'), engine: 'chs', variants: [{ id: 'desktop', width: 1440, height: 900 }], sweep: { from: 400, to: 1000, step: 200 } });
  section = buildStaticSection(r.record);
  scriptsDir = path.join(r.outDir, 'scripts');
  await sSrv.close();
  const fSrv = await startServer();
  const cfg = fixtureConfig(fSrv.port); cfg.classes = { A: cfg.classes.A }; cfg.verifySteps = [];
  const fr = await freeze(cfg, { outDir: path.join(tmp, 'freeze'), engine: 'chs' });
  archive = fr.outDir;
  await fSrv.close();
});
after(() => {
  try { if (archive && fs.existsSync(path.join(archive, 'ARCHIVE.SHA256SUMS'))) unsealArchive(archive); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('report v2 assembles static + freeze + libraries; v1 fields are untouched; nothing is silently dropped', async () => {
  const v1 = { version: 'v1', sections: { motion: { id: 'motion', data: [1] } }, unknowns: [{ id: 'u1' }] };
  const frozenV1 = JSON.stringify(v1);
  const rep = await buildReportV2({ v1, staticSection: section, freezeDir: archive, libdetectInputs: [scriptsDir] });
  assert.equal(JSON.stringify(v1), frozenV1, 'input v1 not mutated');
  assert.equal(rep.version, 'v2');
  assert.deepEqual(rep.sections.motion, v1.sections.motion);
  assert.ok(rep.sections.static && rep.sections.freeze && rep.sections['static.motion-libraries']);
  assert.deepEqual(rep.m4.missing, []);
  assert.ok(rep.unknowns.length > 1 && rep.unknowns[0].id === 'u1', 'static unknowns appended after the v1 ones');
  const md = renderReportV2Markdown(rep);
  assert.match(md, /Static layer/); assert.match(md, /Frozen copy/); assert.match(md, /Motion libraries/);
  const libs = rep.sections['static.motion-libraries'];
  assert.ok(libs.coverage.modules > 0, 'libdetect scanned the scripts the static run saved');
});

test('missing sections are listed with a reason, not dropped', async () => {
  const rep = await buildReportV2({});
  assert.equal(rep.version, 'v2');
  assert.deepEqual(rep.m4.missing.map(m => m.section).sort(), ['freeze', 'static', 'static.motion-libraries']);
  for (const m of rep.m4.missing) assert.ok(m.reason.length > 10);
});

// `report v2` is a research command (src/ext, not in the public build): the CLI part runs only where it exists.
const HAS_EXT = fs.existsSync(new URL('../src/ext/index.js', import.meta.url));
test('CLI: report v2 refuses an --out inside the repo (H2) and prints with --out outside', { skip: !HAS_EXT && 'research commands (src/ext) are not in this build' }, async () => {
  const sec = path.join(tmp, 'sec.json'); fs.writeFileSync(sec, JSON.stringify(section));
  const out = path.join(tmp, 'r.json');
  assert.equal(await cliMain(['report', 'v2', '--static', sec, '--out', out]), 0);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).version, 'v2');
  await assert.rejects(() => cliMain(['report', 'v2', '--static', sec, '--out', path.resolve('docs/x-report.json')]), /repo|inside/i);
});
