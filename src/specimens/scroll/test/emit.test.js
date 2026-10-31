// The emitted page: content-free, self-contained, deterministic; H2 guard of the writer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScrollSpecimen, writeSpecimen } from '../index.js';
import { coreSource } from '../emit.js';
import { REPO_ROOT } from '../../../util/paths.js';
import * as F from './fixtures.js';

const scene = () => buildScrollSpecimen([...F.truthSmooth(), ...F.truthHysteresis(), ...F.truthFlip()], { docHeight: 2400 });

test('the page has no text, no image, no network reference and no source selector', () => {
  const { html, spec } = scene();
  const body = html.slice(html.indexOf('<body>'), html.indexOf('<script id="wr-spec"'));
  const text = body.replace(/<[^>]+>/g, '').trim();
  assert.equal(text, '', 'no text nodes in the body');
  assert.ok(!/<img|<svg|<video|<canvas|<link|<iframe|src=|url\(/i.test(html), 'no media or external reference');
  assert.ok(!/https?:\/\/|fetch\(|XMLHttpRequest|WebSocket|import\(/.test(html), 'no network API');
  assert.ok(!/<title>[^<]*[#.][a-z]/i.test(html), 'title is the specimen id only');
  // source selectors appear only in the JSON spec (channelMap), never as a DOM id / class
  const dom = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  for (const s of ['#t', '#h', '#f']) assert.ok(!dom.includes(`id="${s.slice(1)}"`), s);
  assert.ok(spec.subjects.every((s) => /^b\d+$/.test(s.id)));
});

test('emission is deterministic and carries the spec and the unmodified core', () => {
  const a = scene(), b = scene();
  assert.equal(a.html, b.html); assert.equal(a.spec.id, b.spec.id); assert.match(a.spec.id, /^scroll-[0-9a-f]{10}$/);
  const json = /<script id="wr-spec" type="application\/json">([\s\S]*?)<\/script>/.exec(a.html)[1].replace(/\\u003c/g, '<');
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(a.spec)));
  assert.ok(a.html.includes(coreSource()));
  assert.ok(!/^export /m.test(coreSource()));
});

test('different records give different ids; a changed parameter changes the id', () => {
  const x = buildScrollSpecimen(F.truthSmooth(), { docHeight: 2000 }), y = buildScrollSpecimen(F.truthSmooth({ alpha: { value: 0.3 } }), { docHeight: 2000 });
  assert.notEqual(x.spec.id, y.spec.id);
});

test('writeSpecimen: site-derived output refuses the repo (H2); lab output may go anywhere', () => {
  const built = buildScrollSpecimen(F.truthMap(), { docHeight: 1500 });
  assert.throws(() => writeSpecimen(path.join(REPO_ROOT, 'specimens', 'scroll', 'zz-test-site'), built, { site: true }), /refusing to write inside the repo/);
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'specimens', 'scroll', 'zz-test-site')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-spec-'));
  try {
    const files = writeSpecimen(path.join(dir, 'a'), built, { extra: { 'note.json': { a: 1 } } });
    assert.deepEqual(files.sort(), ['index.html', 'note.json', 'spec.json']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'a', 'spec.json'), 'utf8')).id, built.spec.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('integration entry: scrollSpecimensFromFit claims the records it rebuilt and lists the rest', async () => {
  const { scrollSpecimensFromFit, SPECIMEN_SCHEMA } = await import('../index.js');
  assert.equal(SPECIMEN_SCHEMA, 'reva.specimen.scroll/0');
  const r = scrollSpecimensFromFit({ records: [F.fittedEma(), F.fittedUnexplained()] }, { docHeight: 2000 });
  assert.equal(r.specs.length, 1); assert.deepEqual(r.claimed, ['#hero|drv:--s']); assert.equal(r.skipped.length, 1);
  assert.equal(r.specs[0].spec.schema, SPECIMEN_SCHEMA);
  assert.deepEqual(scrollSpecimensFromFit({ records: [F.fittedUnexplained()] }).specs, []);
});
