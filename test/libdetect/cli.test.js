import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/libdetect/cli.js';
import { loadModules } from '../../src/libdetect/index.js';
import { REPO_ROOT } from '../../src/util/paths.js';
import { synthetic as S, htmlWithCdn, sourceMap } from './fixtures.js';

const cap = () => { const o = { out: '', err: '' }; return { o, io: { out: (s) => { o.out += s; }, err: (s) => { o.err += s; } } }; };
const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-libdetect-'));
  fs.mkdirSync(path.join(dir, 'chunks'));
  fs.writeFileSync(path.join(dir, 'chunks', 'a.js'), S.lenis);
  fs.writeFileSync(path.join(dir, 'index.html'), htmlWithCdn);
  fs.writeFileSync(path.join(dir, 'app.js.map'), sourceMap);
  fs.writeFileSync(path.join(dir, 'broken.js.map'), '{nope');
  fs.writeFileSync(path.join(dir, 'font.woff2'), 'x');
  return dir;
};

test('loadModules: directory walk, source map expansion, and every skipped file is listed with a reason', () => {
  const dir = mk();
  try {
    const { modules, skipped } = loadModules([dir]);
    assert.ok(modules.some(m => m.id === path.join('chunks', 'a.js') && m.kind === 'js'));
    assert.ok(modules.some(m => m.kind === 'path' && m.id.includes('three.module.js')));
    assert.equal(skipped.length, 2);
    assert.ok(skipped.some(s => /broken\.js\.map/.test(s.path) && /not JSON/.test(s.reason)));
    assert.ok(skipped.some(s => /woff2/.test(s.path) && /unsupported/.test(s.reason)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cli: markdown and json output, skipped files reach the coverage section', () => {
  const dir = mk();
  try {
    const a = cap(); assert.equal(main([dir], a.io), 0);
    assert.match(a.o.out, /## Motion libraries/); assert.match(a.o.out, /Lenis/); assert.match(a.o.out, /Skipped 2 file/);
    const b = cap(); assert.equal(main([dir, '--json'], b.io), 0);
    const j = JSON.parse(b.o.out);
    assert.equal(j.result.schema, 'reva.libdetect/1');
    assert.ok(j.result.libraries.some(l => l.id === 'three'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cli: refuses an --out inside the repo (H2), accepts one outside, rejects unknown options', () => {
  const dir = mk();
  try {
    const a = cap();
    assert.equal(main([dir, '--out', path.join(REPO_ROOT, 'libdetect-out.md')], a.io), 2);
    assert.match(a.o.err, /refusing to write inside the repo/);
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'libdetect-out.md')));
    const out = path.join(dir, 'out', 'r.md');
    const b = cap(); assert.equal(main([dir, '--out', out], b.io), 0); assert.ok(fs.readFileSync(out, 'utf8').includes('Lenis'));
    assert.equal(main(['--bogus'], cap().io), 2);
    assert.equal(main([], cap().io), 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
