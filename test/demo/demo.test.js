// The first-run path: REVA's own demo page ships in the package (src/demo/page), `reva demo` looks at it, and the MCP's
// look {fixture: "demo"} serves it. The repo's fixtures/ folder is not in the package, so nothing here may need it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixturePath, serveFixtureDir } from '../../src/mcp/fixture.js';
import { DEMO_ROOT, DEMO_HELP } from '../../src/demo/cli.js';
import { runLook } from '../../src/look/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the demo page ships in the package and needs no network', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('src/'), 'src/ (with src/demo/page) is in the package');
  assert.ok(!pkg.files.some((f) => f.startsWith('fixtures')), 'fixtures/ is not shipped');
  const html = fs.readFileSync(path.join(DEMO_ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /(src|href)=["']?(https?:)?\/\//i, 'no external resource');
  assert.doesNotMatch(html, /fetch\(|XMLHttpRequest|WebSocket/);
  assert.match(DEMO_HELP, /--do load\|hover\|click\|scroll/);
});

test('MCP fixture "demo" resolves to the shipped page, also where fixtures/ does not exist (an npm install)', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-nofixtures-'));
  try {
    const fx = fixturePath('demo', empty);
    assert.equal(fx.root, DEMO_ROOT); assert.equal(fx.page, 'index.html');
    assert.throws(() => fixturePath('look', empty), (e) => e.code === 'not_found' && /"demo" is the page the package ships/.test(e.message));
    assert.throws(() => fixturePath('../etc', empty), (e) => e.code === 'bad_arguments' && /"demo"/.test(e.message));
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('a load look on the demo page finds its motion (the first run a new user sees)', async () => {
  const srv = await serveFixtureDir(fixturePath('demo'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-demo-'));
  try {
    const r = await runLook({ input: srv.url, action: 'load', design: false, engine: 'chs', outDir: out });
    assert.equal(r.ok, true, (r.errors || []).join('; '));
    assert.ok(r.motions.length >= 2, `motions: ${r.motions.map((m) => m.desc).join(', ')}`);
  } finally { await srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('a hover look on a demo card: the scroll progress bar is not called pointer-linked (its scroll-into-view jump is the scroll\'s), and no pointer code is exported for it', async () => {
  const srv = await serveFixtureDir(fixturePath('demo'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-demo-'));
  try {
    const r = await runLook({ input: srv.url, action: 'hover', on: '#card-1', design: false, engine: 'chs', outDir: out });
    assert.equal(r.ok, true, (r.errors || []).join('; '));
    const card = r.motions.find((m) => m.selector === '#card-1');
    assert.ok(card, `the hovered card moves: ${r.motions.map((m) => m.desc).join(', ')}`);
    assert.equal(card.records[0].attribution.label, 'pointer');
    for (const m of r.motions.filter((x) => x.selector !== '#card-1')) {
      for (const rec of m.records) {
        assert.notEqual(rec.model && rec.model.driver && rec.model.driver.kind, 'pointer', `${m.desc} ${rec.target.channel}: ${m.lines.map((l) => l.text).join(' | ')}`);
        assert.notEqual(rec.attribution && rec.attribution.label, 'pointer', `${m.desc} ${rec.target.channel} attributed to the pointer: ${m.lines.map((l) => l.text).join(' | ')}`);
      }
      assert.ok(!m.lines.some((l) => /Pointer-linked/.test(l.text)), m.lines.map((l) => l.text).join(' | '));
      assert.ok(!(m.exports || []).some((e) => /pointer|clientX/.test(JSON.stringify(e))), `${m.desc}: no pointer export`);
    }
  } finally { await srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
