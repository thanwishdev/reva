// Ledger v2 (DESIGN 4.5): the v1 reader, the proof each status carries, the check, the tally, the exit code, the freeze losses.
// Unit tests on synthetic data only: no browser, no real site.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, LEDGER_SCHEMA, LEDGER_SCHEMA_V2, promisedUnits, tallyCheck, exitFor, TALLY_BUCKETS } from '../src/scan/ledger.js';
import { addRows, moveRow, mediaRow, canvasRow, frameRow, workerRow, fitRow, freezeLossRows } from '../src/scan/rows.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-ledger-test-'));
const P = 'https://a.test/';

test('a v1 file with moving-element rows still reads, and writes back as v1', () => {
  const f = path.join(tmp(), 'coverage.json');
  fs.writeFileSync(f, JSON.stringify({ schema: LEDGER_SCHEMA, rows: [
    { unit: 'page', id: P, page: P, status: 'captured', evidence: {} },
    { unit: 'moving-element', id: '.a', page: P, viewport: 'desktop', status: 'captured' },
  ] }));
  const l = Ledger.read(f);
  assert.equal(l.version, 1);
  assert.equal(l.rows.length, 2);
  assert.equal(l.toJSON().schema, LEDGER_SCHEMA);
  assert.equal(l.check([]).ok, true);
});

test('a v2 ledger writes reva.coverage/2, round-trips with its proof fields, and takes no moving-element', () => {
  const l = new Ledger({ version: 2 });
  assert.throws(() => l.add({ unit: 'moving-element', id: 'x', status: 'captured' }), /unknown unit/);
  l.add({ unit: 'asset', id: 'x', status: 'partial', read: 'pictures', notRead: [{ what: 'values', why: 'a canvas\u0007' }] });
  const f = path.join(tmp(), 'coverage.json');
  l.write(f);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).schema, LEDGER_SCHEMA_V2);
  const back = Ledger.read(f);
  assert.equal(back.version, 2);
  assert.equal(back.rows[0].notRead[0].why, 'a canvas');   // page text loses control characters inside nested fields too
  assert.deepEqual(back.check([]).problems, []);
});

test('every status must carry its proof, and a bare row names what is missing', () => {
  const l = new Ledger({ version: 2 });
  const bare = (status) => l.add({ unit: 'asset', id: status, status });
  for (const s of ['captured', 'partial', 'opaque', 'duplicate-of', 'predicted-same', 'blocked', 'refused', 'limit', 'none', 'failed', 'not-reached', 'varies']) bare(s);
  const c = l.check([]);
  assert.equal(c.ok, false);
  assert.equal(c.problems.length, 14);   // partial and duplicate-of each miss two things
  assert.match(c.problems.find((p) => p.includes('opaque')), /without what was tried/);
  // the same rows, each with its proof
  const g = new Ledger({ version: 2 });
  g.add({ unit: 'asset', id: 'a', status: 'captured', evidence: { take: 't' } });
  g.add({ unit: 'asset', id: 'b', status: 'partial', read: 'x', notRead: [{ what: 'y', why: 'z' }] });
  g.add({ unit: 'asset', id: 'c', status: 'opaque', tried: 'looked' });
  g.add({ unit: 'asset', id: 'd', status: 'duplicate-of', duplicateOf: 'a', proof: 'signature' });
  g.add({ unit: 'asset', id: 'e', status: 'predicted-same', basis: 'same template' });
  g.add({ unit: 'asset', id: 'f', status: 'blocked', reason: 'robots' });
  g.add({ unit: 'asset', id: 'g', status: 'refused', rule: 'no POST' });
  g.add({ unit: 'asset', id: 'h', status: 'limit', name: 'budget', value: 0 });   // 0 is a value
  g.add({ unit: 'asset', id: 'i', status: 'none', reason: 'plain load' });
  g.add({ unit: 'asset', id: 'j', status: 'failed', error: 'timeout' });
  g.add({ unit: 'asset', id: 'k', status: 'not-reached', stoodInTheWay: 'a modal' });
  g.add({ unit: 'asset', id: 'l', status: 'varies', runs: 2, diff: [1] });
  assert.deepEqual(g.check([]).problems, []);
  assert.throws(() => g.add({ unit: 'asset', id: 'm', status: 'maybe' }), /unknown status/);
});

test('duplicate-of needs a proof kind of recorded or signature', () => {
  const l = new Ledger({ version: 2 });
  l.add({ unit: 'pattern', id: 'p', status: 'duplicate-of', duplicateOf: 'q', proof: 'guess' });
  assert.match(l.check([]).problems[0], /proof kind/);
});

test('check: escapes, canvases, savings, a move without a clip, a page whose screens all failed', () => {
  const l = new Ledger({ version: 2 });
  l.add({ unit: 'page', id: P, page: P, status: 'captured', evidence: {} });
  for (const v of ['desktop', 'phone']) l.add({ unit: 'viewport', id: v, page: P, viewport: v, status: 'failed', error: 'crash' });
  l.add({ unit: 'move', id: 'm-1', page: P, viewport: 'desktop', status: 'captured', evidence: { clip: null } });
  const c = l.check([], {
    escapes: [{ unit: 'media', page: P, viewport: 'desktop', id: 'v1' }, { unit: 'worker', page: P, viewport: 'desktop', id: 'w1' }],
    canvases: [{ page: P, viewport: 'desktop', id: 'c1' }],
    savings: ['shot gate'],
  });
  const text = c.problems.join('\n');
  assert.match(text, /media v1 .*no row/);
  assert.match(text, /worker w1 .*no row/);
  assert.match(text, /canvas c1/);
  assert.match(text, /saving "shot gate"/);
  assert.match(text, /no clip and no reason/);
  assert.match(text, /captured while every screen failed/);
  // fixing each one clears it
  l.add(mediaRow({ id: 'v1', page: P, viewport: 'desktop' }));
  l.add(workerRow({ id: 'w1', page: P, viewport: 'desktop' }));
  l.add(canvasRow({ id: 'c1', page: P, viewport: 'desktop', context: '2d', evidence: { draws: 3 } }));
  l.add({ unit: 'asset', id: 'gate', status: 'limit', name: 'shot gate', value: 12 });
  l.add(moveRow({ id: 'm-1' }, { page: P, viewport: 'desktop', clip: 'clips/m-1.mp4' }));
  l.add({ unit: 'viewport', id: 'phone', page: P, viewport: 'phone', status: 'captured', evidence: {} });
  assert.deepEqual(l.check([], { escapes: [{ unit: 'media', page: P, viewport: 'desktop', id: 'v1' }], canvases: [{ page: P, viewport: 'desktop', id: 'c1' }], savings: ['shot gate'] }).problems, []);
});

test('a move with no clip is fine when it says why', () => {
  const l = new Ledger({ version: 2 });
  l.add(moveRow({ id: 'm-2', kind: 'touch', runs: [1, 2, 3] }, { page: P, viewport: 'phone', noClipReason: 'seen at 4 frames a second', fps: 4 }));
  assert.deepEqual(l.check([]).problems, []);
  assert.equal(l.rows[0].fps, 4);
  assert.equal(l.rows[0].evidence.runs, 3);
});

test('tally: nine buckets add up to runs, each a whole number', () => {
  const t = { runs: 100, inMoves: 40, rideAlong: 30, setup: 10, between: 5, control: 5, clocked: 4, repeat: 3, belowNoise: 2, newDocument: 1 };
  assert.equal(TALLY_BUCKETS.length, 9);
  assert.deepEqual(tallyCheck(t), { ok: true, runs: 100, sum: 100, problems: [] });
  assert.match(tallyCheck({ ...t, runs: 99 }).problems[0], /99 runs but the buckets add up to 100/);
  assert.match(tallyCheck({ ...t, repeat: 2.5 }).problems[0], /repeat is not a whole number/);
  assert.match(tallyCheck({ ...t, setup: -1 }).problems[0], /setup/);
  assert.equal(tallyCheck({}).ok, false);
  const l = new Ledger({ version: 2 });
  assert.equal(l.check([], { tally: t }).ok, true);
  assert.equal(l.check([], { tally: { ...t, runs: 7 } }).ok, false);
});

test('promisedUnits gains moves, media, canvases and a fit summary per viewport, and keeps its old shape', () => {
  const old = promisedUnits({ pages: ['p'], viewports: ['desktop', 'phone'], moments: ['load'] });
  assert.equal(old.some((x) => ['move', 'media', 'canvas', 'fit'].includes(x.unit)), false);
  const u = promisedUnits({ pages: ['p'], viewports: ['desktop', 'phone'], moments: ['load'], moves: [{ page: 'p', viewport: 'desktop', id: 'm-1' }], media: [{ page: 'p', viewport: 'desktop', id: 'v' }], canvases: [{ page: 'p', viewport: 'desktop', id: 'c' }], fit: true });
  assert.deepEqual(['move', 'media', 'canvas'].map((k) => u.filter((x) => x.unit === k).length), [1, 1, 1]);
  assert.equal(u.filter((x) => x.unit === 'fit').length, 2);
  const l = new Ledger({ version: 2 });
  assert.equal(l.check(u).missing.filter((x) => x.unit === 'fit').length, 2);
  l.add(fitRow({ viewport: 'desktop', fitted: 5, sampled: 1, split: 0, cut: 0 }));
  assert.equal(l.check(u).missing.filter((x) => x.unit === 'fit').length, 1);
});

test('row builders: every unit a scan sees can be added and passes the check', () => {
  const l = new Ledger({ version: 2 });
  addRows(l, [
    mediaRow({ id: 'v1', page: P, viewport: 'desktop' }),
    mediaRow({ id: 'v2', page: P, viewport: 'desktop', encrypted: true }),
    mediaRow({ id: 'v3', page: P, viewport: 'desktop', stored: false }),
    canvasRow({ id: 'c1', page: P, viewport: 'desktop', context: 'webgl', uniformsRead: true }),
    canvasRow({ id: 'c2', page: P, viewport: 'desktop', context: 'webgl', evidence: { frames: 90 } }),
    canvasRow({ id: 'c3', page: P, viewport: 'desktop', context: 'none' }),
    canvasRow({ id: 'c4', page: P, viewport: 'desktop', context: '2d' }),
    frameRow({ id: 'f1', page: P, viewport: 'desktop', crossOrigin: true }),
    frameRow({ id: 'f2', page: P, viewport: 'desktop' }),
    workerRow({ id: 'w1', page: P, viewport: 'desktop' }),
    fitRow({ viewport: 'desktop', fitted: 3 }),
    moveRow({ id: 'm-3' }, { page: P, viewport: 'desktop', clip: 'c.mp4', partial: [{ what: 'shader', why: 'raw GL' }] }),
  ]);
  assert.equal(l.rows.length, 12);
  assert.deepEqual(l.check([]).problems, []);
  assert.equal(l.get('media', P, 'desktop', 'v3').status, 'failed');
  assert.equal(l.get('canvas', P, 'desktop', 'c4').status, 'opaque');
});

test('exit: 0 only when the check is clean and no page, screen or moment failed', () => {
  const l = new Ledger({ version: 2 });
  l.add({ unit: 'page', id: P, page: P, status: 'captured', evidence: {} });
  const ok = l.check([]);
  assert.equal(exitFor(l, ok), 0);
  assert.equal(exitFor(l, ok, { homeCaptured: false }), 1);
  assert.equal(exitFor(l, { ok: false }), 1);
  l.add({ unit: 'asset', id: 'x', status: 'failed', error: 'a file broke' });   // an asset failing is told, not fatal
  assert.equal(exitFor(l, l.check([])), 0);
  l.add({ unit: 'moment', id: 'load', page: P, viewport: 'desktop', status: 'failed', error: 'crashed' });
  assert.equal(exitFor(l, l.check([])), 1);
});

// ---- freeze losses, from a synthetic archive
function archive(files) {
  const dir = tmp();
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  return dir;
}

test('freeze losses become limit, failed, partial, refused and media rows before the archive is deleted', () => {
  const dir = archive({
    'freeze-report.json': {
      recording: { A: { docStatus: 200, trackersBlocked: 4 }, E: { docStatus: 403, trackersBlocked: 0 } },
      finalReplay: { A: { pass: false, checks: { noError: true, noRenderMisses: false, noInflight: false } }, E: { pass: true, checks: {} } },
      completeness: { pct: 96, requests: 298, misses: { render: 2, 'site-data': 10, telemetry: 2, 'non-GET': 3, api: 0, other: 0 } },
    },
    'misses.json': { completeness: { pct: 96, requests: 298, misses: { render: 2, 'site-data': 10, telemetry: 2, 'non-GET': 3, api: 0, other: 0 } }, notFetched: [] },
    'completion.json': {
      notFetched: [{ url: 'https://x.test/a.woff2', reason: 'not-fetched:budget' }, { url: 'https://x.test/b.woff2', reason: 'not-fetched:budget' }],
      unknown: [{ reason: 'ua() is called without argument 4' }, { reason: 'ua() is called without argument 4' }, { reason: 'other hole' }],
      dropped: { telemetry: 2 },
    },
    'manifest.json': { entries: [
      { url: 'https://cdn.test/v/a.mp4?sig=SECRET', status: 206, bytes: 0, contentType: 'video/mp4' },
      { url: 'https://cdn.test/v/seg.ts', status: 200, bytes: 0, contentType: '' },
      { url: 'https://t.test/ping', status: 200, bytes: 0, contentType: 'application/json' },
      { url: 'https://t.test/pixel', status: 204, bytes: 0, contentType: '' },
      { url: 'https://cdn.test/v/ok.mp4', status: 200, bytes: 9, contentType: 'video/mp4' },
    ] },
  });
  const rows = freezeLossRows(dir);
  const l = addRows(new Ledger({ version: 2 }), rows);
  assert.deepEqual(l.check([]).problems, []);
  const by = (u, id) => l.get(u, null, null, id);
  assert.equal(by('asset', 'replay-A').status, 'failed');
  assert.match(by('asset', 'replay-A').error, /noRenderMisses, noInflight/);
  assert.equal(l.has('asset', null, null, 'replay-E'), false);
  assert.equal(by('asset', 'document-E').status, 'blocked');
  assert.equal(by('request', 'trackers-A').count, 4);
  assert.equal(by('asset', 'misses').status, 'partial');
  assert.deepEqual(by('asset', 'misses').notRead.map((x) => x.what), ['2 render requests', '10 site-data requests']);
  assert.equal(by('request', 'non-GET').status, 'refused');
  assert.equal(by('asset', 'not-fetched:budget').value, 2);
  assert.equal(by('asset', 'unknown-url:ua() is called without argument 4').count, 2);
  assert.equal(by('request', 'dropped-telemetry').count, 2);
  // zero-byte media only: no query string kept in the id, no 204, no non-media
  const media = l.rows.filter((r) => r.unit === 'media');
  assert.deepEqual(media.map((r) => r.id).sort(), ['https://cdn.test/v/a.mp4', 'https://cdn.test/v/seg.ts']);
  assert.ok(media.every((r) => r.status === 'failed' && /not stored/.test(r.error)));
});

test('freeze losses: a missing file is skipped, a broken one is a failed row, a clean archive adds nothing', () => {
  assert.deepEqual(freezeLossRows(archive({})), []);
  const rows = freezeLossRows(archive({ 'completion.json': '{not json' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  const clean = archive({
    'freeze-report.json': { recording: { A: { docStatus: 200, trackersBlocked: 0 } }, finalReplay: { A: { pass: true } }, completeness: { pct: 100, requests: 10, misses: { render: 0 } } },
    'completion.json': { notFetched: [], unknown: [], dropped: {} },
  });
  assert.deepEqual(freezeLossRows(clean), []);
});
