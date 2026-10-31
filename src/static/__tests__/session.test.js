// Report v2 section, determinism, and the live-load / isolation guards. One fixture server, two extractions.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { serveStaticFixture } from '../../../fixtures/static/server.js';
import { extractStatic, assertLocalTarget } from '../extract.js';
import { buildStaticSection, renderStaticMarkdown, mergeStaticSection, FAMILY_IDS } from '../report.js';
import { walkTagged } from '../prov.js';

let srv, a, b, dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-static-')); dirs.push(d); return d; };
const strip = r => JSON.stringify({ variants: r.variants.map(v => ({ id: v.id, tokens: v.tokens, states: v.states, fontsUsed: v.fontsUsed, elements: v.elements?.sha256 })), breakpoints: r.breakpoints, unknowns: r.unknowns, assets: r.assets, a11y: r.a11y, declared: r.declared });

before(async () => {
  srv = await serveStaticFixture();
  a = (await extractStatic({ url: srv.origin + '/', outDir: tmp(), engine: 'chs' })).record;
  b = (await extractStatic({ url: srv.origin + '/', outDir: tmp(), engine: 'chs' })).record;
});
after(async () => { await srv?.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('determinism: two runs on the same origin give the same tokens, edges, unknowns, assets and element series', () => {
  assert.equal(strip(a), strip(b));
});

test('report section: every static family is shown with provenance; every family left out has a reason', () => {
  const s = buildStaticSection(a);
  assert.deepEqual(s.families.map(f => f.id), FAMILY_IDS);
  for (const f of s.families) assert.ok(f.title && f.summary, f.id);
  assert.ok(s.leftOut.length >= 5 && s.leftOut.every(x => x.family && x.reason.length > 10));
  const md = renderStaticMarkdown(s);
  for (const f of s.families) assert.ok(md.includes('### ' + f.title), `markdown lacks ${f.title}`);
  assert.ok(md.includes('### Left out of the static layer') && md.includes('### Unknowns ledger (static)'));
  for (const t of ['{m}', '{d}', '{i}', '{u}']) assert.ok(md.includes(t), `markdown never shows ${t}`);
  assert.ok(md.includes('(max-width: 860px)') && md.includes('1500') , 'breakpoint table lists the declared query and the unexplained edge');
  assert.ok(/unk_breakpoint_unexplained/.test(md));
  const hints = s.families.find(f => f.id === 'hints'); assert.equal(hints.rows.length, 0); // dembrandt not run in this record
  let untagged = 0; for (const f of s.families.filter(x => ['typography', 'colors', 'shadows', 'radii'].includes(x.id))) for (const r of f.rows) walkTagged(r, () => {}), untagged += (JSON.stringify(r).includes('provenance') ? 0 : 1);
  assert.equal(untagged, 0);
});

test('merge point for M3: adds sections.static and v2, never edits a v1 field', () => {
  const v1 = { version: 'v1', title: 'motion report', motion: { scenes: [1, 2] }, unknowns: [{ id: 'unk_motion_x', reason: 'r', probe: 'p' }] };
  const frozen = JSON.stringify(v1);
  const v2 = mergeStaticSection(v1, buildStaticSection(a));
  assert.equal(JSON.stringify(v1), frozen, 'input must not be mutated');
  assert.equal(v2.version, 'v2'); assert.deepEqual(v2.motion, v1.motion); assert.equal(v2.title, v1.title);
  assert.ok(v2.sections.static.families.length === FAMILY_IDS.length);
  assert.ok(v2.unknowns.length > v1.unknowns.length && v2.unknowns[0].id === 'unk_motion_x' && v2.unknowns.at(-1).layer === 'static');
  assert.equal(mergeStaticSection(null, buildStaticSection(a)).version, 'v2');
});

test('live loads are refused without --allow-live; localhost and file: pass', async () => {
  assert.throws(() => assertLocalTarget('https://example.com/'), /--allow-live/);
  assert.throws(() => assertLocalTarget('http://192.168.1.5/'), /--allow-live/);
  assert.doesNotThrow(() => assertLocalTarget('http://localhost:3000/')); assert.doesNotThrow(() => assertLocalTarget('http://127.0.0.1:1/')); assert.doesNotThrow(() => assertLocalTarget('file:///tmp/x.html'));
  assert.doesNotThrow(() => assertLocalTarget('https://example.com/', true));
  await assert.rejects(() => extractStatic({ url: 'https://example.com/', outDir: tmp() }), /--allow-live/);
});

test('a local page that references an external host: the request is blocked and counted, never sent', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>x</title><link rel=stylesheet href="https://static-layer-test.invalid/a.css"><img src="https://static-layer-test.invalid/p.png"><p style="color:#123456">hi</p>'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const { record } = await extractStatic({ url: `http://localhost:${server.address().port}/`, outDir: tmp(), engine: 'chs', variants: [{ id: 'one', width: 800, height: 600 }], sweep: { from: 400, to: 800, step: 200 } });
    assert.ok(record.environment.blockedExternalRequests >= 2, `blocked ${record.environment.blockedExternalRequests}`);
    assert.ok(record.environment.blockedExternalSample.every(u => u.includes('static-layer-test.invalid')));
    assert.equal(record.variants[0].tokens.colors.find(c => c.raw.value === 'rgb(18, 52, 86)').hex.value, '#123456');
  } finally { await new Promise(r => server.close(r)); }
});

test('output must be outside the repo (H2)', async () => {
  await assert.rejects(() => extractStatic({ url: srv.origin + '/', outDir: path.join(process.cwd(), 'out-should-not-exist') }), /refusing to write inside the repo/);
});

test('offlineReplay: routes installed by prepare() serve the page; everything the archive does not fulfil is aborted and counted as a miss', async () => {
  const html = '<!doctype html><title>replayed</title><link rel=stylesheet href="https://archive.invalid/served.css"><link rel=stylesheet href="https://archive.invalid/missing.css"><p id=p>x</p>';
  const prepare = async context => {
    await context.route('https://archive.invalid/', r => r.fulfill({ contentType: 'text/html', body: html }));
    await context.route('https://archive.invalid/served.css', r => r.fulfill({ contentType: 'text/css', body: '#p{color:#abcdef;font-size:21px}' }));
  };
  const { record } = await extractStatic({ url: 'https://archive.invalid/', offlineReplay: true, prepare, outDir: tmp(), engine: 'chs', variants: [{ id: 'one', width: 800, height: 600 }], sweep: { from: 400, to: 800, step: 200 } });
  assert.deepEqual([...new Set(record.environment.blockedExternalSample)], ['https://archive.invalid/missing.css']);
  assert.ok(record.environment.blockedExternalRequests >= 1);
  const tk = record.variants[0].tokens;
  assert.ok(tk.colors.some(c => c.hex.value === '#abcdef') && tk.typography.some(t => t.fontSize.value === '21px'));
  await assert.rejects(() => extractStatic({ url: 'https://archive.invalid/', offlineReplay: true, outDir: tmp() }), /needs a prepare/);
});
