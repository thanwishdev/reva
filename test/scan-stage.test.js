// Phase 5 (2 Nov): the stage in the card. Unit tests: box runs, moving spans, the MP4 file, picture samples, the ledger as words,
// and what the local server refuses. The stage itself is judged by eye on the three real sites (PLAN §7).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boxRuns, chaptersOf, moveSpans, motionChannels, safeId, uniqueChapter } from '../src/scan/stage.js';
import { chapterRows } from '../src/scan/analyse.js';
import { muxMp4, durationRuns } from '../src/scan/mp4.js';
import { samplesOf, bitrateFor } from '../src/scan/video.js';
import { siteWords } from '../src/scan/words.js';
import { Ledger } from '../src/scan/ledger.js';
import { startServer } from '../src/scan/open.js';
import { fitFile, safeJson, wasCut } from '../src/scan/fitone.js';
import { FitPool } from '../src/scan/fitpool.js';
import { designPass } from '../src/scan/design.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-stage-test-'));

test('an element that rides the page is one run in page coordinates', () => {
  const sy = [0, 100, 200, 300];
  const r = boxRuns(sy.map((s) => [10, 500 - s, 80, 40]), sy);
  assert.equal(r.m, 'p');
  assert.deepEqual(r.t, [0, 10, 500, 80, 40]);
});

test('an element fixed to the screen is one run in viewport coordinates', () => {
  const sy = [0, 100, 200, 300];
  const r = boxRuns(sy.map(() => [10, 20, 80, 40]), sy);
  assert.equal(r.m, 'v');
  assert.deepEqual(r.t, [0, 10, 20, 80, 40]);
});

test('an element that goes away and comes back says so with an empty run', () => {
  const r = boxRuns([[1, 2, 30, 40], null, null, [1, 2, 30, 40]], [0, 0, 0, 0]);
  assert.deepEqual(r.t, [0, 1, 2, 30, 40, 1, 0, 0, 0, 0, 3, 1, 2, 30, 40]);
});

test('moving spans join across a short pause and keep a long one', () => {
  const f = Array(40).fill(false);
  for (const i of [2, 3, 7, 8, 30]) f[i] = true;
  assert.deepEqual(moveSpans(f), [2, 8, 30, 30]);
  assert.deepEqual(moveSpans([false, false]), []);
});

test('layout and text channels are not motion', () => {
  assert.deepEqual(motionChannels({ 'ren:bx': 1, 'ren:by': 2, 'ren:opacity': 0.4, 'ren:ty': 3, 'ren:transform': 'none', 'ren:text': 1 }), ['ren:opacity', 'ren:ty']);
});

test('chapter ids become safe file names', () => {
  assert.equal(safeId('home/desktop/hover .menu'), 'home-desktop-hover-menu');
});

test('an unchanged picture is one sample that lasts', () => {
  const rows = [[0, 0, 0, 0], [1, 0, 0, 0], [2, 0, 0, 1], [3, 0, 0, 1], [4, 0, 0, 1], [5, 0, 0, 2]];
  assert.deepEqual(samplesOf(rows).map((s) => [s.f, s.from, s.frames]), [[0, 0, 2], [1, 2, 3], [2, 5, 1]]);
});

test('sample durations fold into runs', () => {
  assert.deepEqual(durationRuns([100, 100, 300, 100]), [[2, 100], [1, 300], [1, 100]]);
});

test('bitrate stays in its range', () => {
  assert.equal(bitrateFor(100, 100), 2e6);
  assert.equal(bitrateFor(1440, 900), 1440 * 900 * 5);
  assert.equal(bitrateFor(4000, 4000), 14e6);
});

/** Top-level boxes of an MP4 buffer. */
function boxes(b, from = 0, to = b.length) {
  const out = [];
  for (let i = from; i < to;) { const n = b.readUInt32BE(i); out.push({ name: b.toString('latin1', i + 4, i + 8), at: i, n }); i += n; }
  return out;
}

test('the MP4 has its index first and points at the real samples', () => {
  const samples = [{ data: Buffer.from('aaaa'), duration: 100, key: true }, { data: Buffer.from('bbbbbb'), duration: 300, key: false }];
  const f = muxMp4({ width: 640, height: 360, timescale: 6000, avcC: Buffer.from([1, 2, 3]), samples });
  const top = boxes(f);
  assert.deepEqual(top.map((x) => x.name), ['ftyp', 'moov', 'mdat']);
  const stco = f.indexOf(Buffer.from('stco', 'latin1'));
  const offset = f.readUInt32BE(stco + 12);
  assert.equal(f.toString('latin1', offset, offset + 4), 'aaaa');
  assert.equal(f.toString('latin1', offset + 4, offset + 10), 'bbbbbb');
  const stss = f.indexOf(Buffer.from('stss', 'latin1'));
  assert.equal(f.readUInt32BE(stss + 8), 1, 'one keyframe listed');
  const mdhd = f.indexOf(Buffer.from('mdhd', 'latin1'));
  assert.equal(f.readUInt32BE(mdhd + 20), 400, 'the track lasts the sum of its samples');
});

test('script text cannot close its own tag', () => {
  assert.ok(!safeJson({ a: '</script>' }).includes('</script'));
});

test('the ledger reads as sentences', () => {
  const l = new Ledger({ version: 2 });
  l.add({ unit: 'page', id: 'https://a.test/', page: 'https://a.test/', status: 'captured', evidence: {} });
  l.add({ unit: 'viewport', id: 'desktop', page: 'https://a.test/', viewport: 'desktop', status: 'captured', evidence: {} });
  l.add({ unit: 'moment', id: 'load', page: 'https://a.test/', viewport: 'desktop', status: 'captured', evidence: {} });
  l.add({ unit: 'moment', id: 'scroll-rest', page: 'https://a.test/', viewport: 'desktop', status: 'not-reached', reason: 'the page is long' });
  l.add({ unit: 'move', id: 'm-aaaa0000', page: 'https://a.test/', viewport: 'desktop', status: 'captured', evidence: { clip: 'a.mp4' } });
  const w = siteWords({ url: 'https://a.test/', map: { listed: 1028, templates: 7 } }, l);
  assert.match(w.lead[0], /1 of 1,028 pages recorded\. 1,027 pages were not opened\./);
  assert.match(w.lead[1], /1 move recorded frame by frame/);
  assert.equal(w.missing.length, 1);
  assert.match(w.missing[0], /the page is long/);
});

test('the same reason on both screens and two hosts reads as one line', () => {
  const l = new Ledger();
  for (const vp of ['desktop', 'phone']) l.add({ unit: 'pattern', id: 'a', page: 'https://a.test/', viewport: vp, status: 'not-reached', reason: 'something lies over it' });
  for (const [id, n] of [['x.test', 249], ['y.test', 83]]) l.add({ unit: 'request', id, page: 'https://a.test/', status: 'blocked', reason: `${n} requests: a file of another site` });
  const { missing } = siteWords({ url: 'https://a.test/' }, l);
  assert.deepEqual(missing, ['Interactive parts: something lies over it (2 of them)', 'A file the page asked for: 332 requests: a file of another site']);
});

test('two page changes on one page stay two chapters', () => {
  const ids = new Set();
  assert.equal(uniqueChapter(ids, 'home/desktop/change', 'change-0'), 'home/desktop/change');
  assert.equal(uniqueChapter(ids, 'home/desktop/change', 'change-1'), 'home/desktop/change-change-1');
});

test('a load chapter ends with its phase on an arrive take, and reads whole on a stored load take', () => {
  const fr = { rows: [[0, 10, 0, 0], [1, 26, 0, 1], [2, 43, 0, 2], [3, 60, 0, 3]], phases: [{ name: 'load', from: 0, to: 2 }, { name: 'idle', from: 2, to: 4 }] };
  const [load, idle] = chaptersOf({ id: 'home' }, 'desktop', 'arrive', fr);
  assert.equal(load.fromT, null); assert.equal(load.toT, 27);
  assert.equal(idle.fromT, 43); assert.equal(idle.phase, 'idle'); assert.equal(idle.action, 'load');
  assert.equal(chaptersOf({ id: 'home' }, 'desktop', 'load', fr)[0].toT, null);
  const rows = fr.rows.map((r) => ({ T: r[1] }));
  assert.equal(chapterRows(rows, load).length, 2, 'the rows after the load are not the load');
  const sweep = chaptersOf({ id: 'home' }, 'desktop', 'arrive', { rows: fr.rows, phases: [{ name: 'pointer-sweep', from: 0, to: 4 }] })[0];
  assert.equal(sweep.action, 'hover'); assert.equal(sweep.name, 'Pointer across the page');
});

test('one template reads as a word, not a count', () => {
  const ledger = new Ledger();
  ledger.add({ unit: 'page', page: 'https://x.test/', id: 'https://x.test/', status: 'captured' });
  const { lead } = siteWords({ steps: { map: { counts: { listed: 8, clusters: 1 } } } }, ledger);
  assert.match(lead[0], /the other 7 are the same template\./);
});

test('a fit already on disk is not done twice', async () => {
  const out = tmp();
  fs.mkdirSync(path.dirname(fitFile(out, 'home/desktop/load', 5)), { recursive: true });
  fs.writeFileSync(fitFile(out, 'home/desktop/load', 5), '/* a fit */');
  const pool = new FitPool(out, { workers: 1 });
  try { assert.deepEqual(await pool.ask('home/desktop/load', 5), { ms: 0, cut: [], cached: true }); } finally { await pool.close(); }
  fs.rmSync(out, { recursive: true, force: true });
});

test('a fit cut by the quick budget is known from its file, and --all does it again', async () => {
  const out = tmp();
  fs.mkdirSync(path.dirname(fitFile(out, 'home/desktop/load', 5)), { recursive: true });
  fs.writeFileSync(fitFile(out, 'home/desktop/load', 5), 'window.__fit("c",5,{"look":{},"ms":1,"cut":["fit_budget"],"note":null});');
  fs.writeFileSync(fitFile(out, 'home/desktop/load', 6), 'window.__fit("c",6,{"look":{},"ms":1,"cut":[],"note":null});');
  assert.equal(wasCut(out, 'home/desktop/load', 5), true);
  assert.equal(wasCut(out, 'home/desktop/load', 6), false);
  const pool = new FitPool(out, { workers: 1 });
  try {
    assert.equal((await pool.ask('home/desktop/load', 5)).cached, true, 'a click takes what is there');
    assert.equal((await pool.ask('home/desktop/load', 6, { deep: true })).cached, true);
    await assert.rejects(pool.ask('home/desktop/load', 5, { deep: true }), 'the cut one is fitted again (no plan here, so it fails)');
  } finally { await pool.close(); }
});

test('the server gives the card and nothing else, to this machine only', async () => {
  const out = tmp();
  fs.writeFileSync(path.join(out, 'card.html'), '<p>card</p>');
  fs.writeFileSync(path.join(out, 'coverage.json'), '{}');
  fs.mkdirSync(path.join(out, 'takes'));
  fs.writeFileSync(path.join(out, 'takes', 'take.json'), '{}');
  fs.mkdirSync(path.join(out, 'stage'));
  fs.writeFileSync(path.join(out, 'stage', 'a.js'), '1');
  const s = await startServer(out, { workers: 1, prefit: false });
  try {
    const base = s.url;
    assert.equal((await fetch(base)).status, 200);
    assert.equal(await (await fetch(base + 'stage/a.js')).text(), '1');
    assert.equal((await fetch(base + 'coverage.json')).status, 404);
    assert.equal((await fetch(base + 'takes/take.json')).status, 404);
    assert.equal((await fetch(base + 'stage/..%2fcoverage.json')).status, 404);
    assert.equal((await fetch(base + 'fits/x/1.js?c=' + encodeURIComponent('../x'))).status, 400, 'a fit is asked for by its own script path');
    assert.equal((await fetch(base + 'fits/a-b-c/9.js?c=a/b/d')).status, 400, 'the chapter must be the one the path names');
    assert.equal((await fetch(base + 'fits/a-b-c/1.js?c=a/b/c', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'another site cannot start a fit');
    assert.equal((await fetch(base + 'fit', { method: 'POST', body: '{}' })).status, 405, 'nothing posts any more');
    const http = await import('node:http');
    const code = await new Promise((ok) => { const r = http.request(base, { headers: { host: 'evil.test' } }, (x) => { x.resume(); ok(x.statusCode); }); r.end(); });
    assert.equal(code, 403, 'another host name (DNS rebinding) is refused');
  } finally { await s.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('the design pass keeps what the card needs and no motion, and says when it failed', async () => {
  const out = tmp();
  let seen = null;
  const ok = await designPass({ archive: '/x', startUrl: 'https://a.test/', _file: '/x/target.json' }, out, { lookImpl: async (o) => { seen = JSON.parse(fs.readFileSync(o.input, 'utf8')); return { design: { a: 1 }, libraries: { ok: true }, motions: [1], take: { dir: '/x' }, screens: {} }; } });
  assert.equal(ok.ok, true);
  assert.equal(seen.startUrl, 'https://a.test/');
  assert.equal(seen._file, undefined);
  const look = JSON.parse(fs.readFileSync(path.join(out, 'look', 'look.json'), 'utf8'));
  assert.deepEqual(look.motions, []);
  assert.equal(look.take, undefined);
  assert.deepEqual(look.design, { a: 1 });
  assert.equal((await designPass({}, out, { lookImpl: () => { throw new Error('no second run'); } })).resumed, true);
  const bad = await designPass({}, tmp(), { lookImpl: async () => { throw new Error('the page crashed\nstack'); } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'the page crashed');
  assert.equal(fs.readdirSync(out).filter((f) => f.startsWith('.look-')).length, 0);
});
