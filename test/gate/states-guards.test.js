// States/capture guards: a node the page replaced while a state is forced, and a screenshot clip that is empty or
// outside the page, are skipped with a recorded reason instead of failing the step. Synthetic only.
// Run: node --test --test-concurrency=1 test/gate/states-guards.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { launchBrowser } from '../../src/browser/launch.js';
import { takeSnapshot } from '../../src/gate/snapshot.js';
import { forceStates } from '../../src/gate/states.js';
import { clipProblem, pageSize, isClipError, markNoShot, compareRuns } from '../../src/gate/run.js';

const GONE = () => new Error('cdpSession.send: Protocol error (CSS.forcePseudoState): Could not find node with given id');
function fakeCss({ goneTimes = 0, found = true }) {
  const calls = []; let forces = 0;
  return {
    calls, docFetched: true,
    cdp: {
      send: async (m, p) => {
        calls.push(m);
        if (m === 'Runtime.evaluate') return { result: found ? { objectId: 'o' } : {} };
        if (m === 'DOM.requestNode') return { nodeId: 100 + calls.length };
        if (m === 'CSS.forcePseudoState') { if (p.forcedPseudoClasses.length && forces++ < goneTimes) throw GONE(); return {}; }
        throw new Error('unexpected ' + m);
      },
    },
  };
}

test('forceStates: a node replaced once is looked up again and forced', async () => {
  const css = fakeCss({ goneTimes: 1 }); const skipped = [];
  const clear = await forceStates(css, null, [{ k: 'a', pc: ['hover'] }], skipped);
  assert.deepEqual(skipped, []);
  assert.equal(css.calls.filter(c => c === 'DOM.requestNode').length, 2, 're-resolved once');
  await clear();
});

test('forceStates: a node that stays gone is skipped with a reason, the step does not throw', async () => {
  const css = fakeCss({ goneTimes: 99 }); const skipped = [];
  const clear = await forceStates(css, null, [{ k: 'a', pc: ['hover'] }, { k: 'b', pc: ['focus'] }], skipped);
  assert.deepEqual(skipped.map(x => x.k), ['a', 'b']);
  assert.match(skipped[0].reason, /replaced by the page/);
  await clear(); // reset of nothing forced: no throw
});

test('forceStates: a target the page removed (not found) is skipped with a reason', async () => {
  const css = fakeCss({ found: false }); const skipped = [];
  await forceStates(css, null, [{ k: 'gone', pc: ['hover'] }], skipped);
  assert.equal(skipped.length, 1); assert.match(skipped[0].reason, /not found/);
});

test('forceStates: any other CDP error still fails loudly', async () => {
  const css = fakeCss({}); css.cdp.send = async () => { throw new Error('boom'); };
  await assert.rejects(forceStates(css, null, [{ k: 'a', pc: ['hover'] }], []), /boom/);
});

test('clipProblem: empty and outside clips are reported, partly outside is allowed', () => {
  const size = { w: 800, h: 600 };
  assert.equal(clipProblem(undefined, size), null);
  assert.equal(clipProblem({ x: 0, y: 100, width: 800, height: 50 }, size), null);
  assert.equal(clipProblem({ x: 0, y: 550, width: 800, height: 400 }, size), null, 'partly outside is clipped by Playwright');
  assert.match(clipProblem({ x: 0, y: 100, width: 800, height: 0 }, size), /empty/);
  assert.match(clipProblem({ x: 0, y: 700, width: 800, height: 50 }, size), /outside/);
  assert.match(clipProblem({ x: 0, y: NaN, width: 800, height: 50 }, size), /non-finite/);
});

test('real page: an outside clip throws the Playwright error isClipError knows, clipProblem predicts it, compareRuns skips the point', { timeout: 60000 }, async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-sg-a-')), dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-sg-b-'));
  const h = await launchBrowser({ args: [], context: { viewport: { width: 400, height: 300 } } });
  try {
    await h.page.setContent('<!doctype html><body style="margin:0"><div style="height:500px;background:#ccc">x</div></body>');
    const size = await h.page.evaluate(pageSize);
    const clip = { x: 0, y: size.h + 400, width: 400, height: 80 };
    assert.ok(clipProblem(clip, size), 'predicted');
    await assert.rejects(h.page.screenshot({ fullPage: true, clip }), e => isClipError(e));
    const sn = await takeSnapshot(h.page, {});
    for (const d of [dirA, dirB]) fs.writeFileSync(path.join(d, 'p1.json.gz'), zlib.gzipSync(JSON.stringify(sn)));
    fs.writeFileSync(path.join(dirA, 'p1.png'), await h.page.screenshot());
    markNoShot(dirB, 'p1', clipProblem(clip, size)); // B could not take its shot
    const r = compareRuns(dirA, dirB, [{ id: 'p1', kind: 'captured', cls: 'A' }], { p1: 0 });
    assert.equal(r.p1.pass, false, 'a skipped pixel check never counts as pass');
    assert.equal(r.p1.oracle.pass, true);
    assert.equal(r.p1.pixel.pass, false);
    assert.match(r.p1.shotSkipped, /outside/);
    assert.equal(r.p1.pixel.skipped, r.p1.shotSkipped);
  } finally { await h.close(); fs.rmSync(dirA, { recursive: true, force: true }); fs.rmSync(dirB, { recursive: true, force: true }); }
});

test('writeDump: a dump too large for a JS string is skipped with a reason, other errors still fail', async () => {
  const { writeDump } = await import('../../src/gate/run.js');
  const f = path.join(os.tmpdir(), `wr-dump-${process.pid}.json`);
  assert.equal(await writeDump(null, f, async () => ({ html: 'x' })), null);
  assert.ok(fs.existsSync(f));
  const why = await writeDump(null, f, async () => { throw new RangeError('page.evaluate: RangeError: Invalid string length'); });
  assert.match(why, /T6 dump too large/);
  assert.ok(!fs.existsSync(f), 'no partial file');
  await assert.rejects(writeDump(null, f, async () => { throw new Error('boom'); }), /boom/);
});

test('writeJsonFile: same bytes as JSON.stringify, long strings sliced without splitting surrogate pairs (Node 26 stringify abort)', async () => {
  const { jsonPieces, writeJsonFile } = await import('../../src/util/jsonfile.js');
  const long = 'a"b\\c\n\u0001' + '\u{1F600}x'.repeat(40) + '\ud800' + 'é'.repeat(7) + '\udc00z' + '<p style="x">'.repeat(9);
  const values = [
    { html: long, frames: { 'https://a/': long.slice(3), 'https://b/': '' } },
    [long, undefined, () => 1, null, 1.5, true, { toJSON: () => 'tj' }, new Date(0)],
    { a: undefined, b: Symbol('s'), c: [], d: {}, e: Object.assign(Object.create(null), { k: long }) },
    long, 'short', 42, null,
  ];
  for (const v of values) for (const slice of [1, 2, 3, 5, 7, 64]) {
    let out = ''; jsonPieces(v, s => { out += s; }, { slice });
    assert.equal(out, JSON.stringify(v), `slice ${slice}`);
  }
  // a surrogate pair at every possible slice boundary
  for (let pad = 0; pad < 6; pad++) { const s = 'q'.repeat(pad) + '\u{1F600}'.repeat(5); let out = ''; jsonPieces(s, x => { out += x; }, { slice: 3 }); assert.equal(out, JSON.stringify(s)); }
  const f = path.join(os.tmpdir(), `wr-jsonfile-${process.pid}.json`);
  try { writeJsonFile(f, values[0], { slice: 4 }); assert.equal(fs.readFileSync(f, 'utf8'), JSON.stringify(values[0])); } finally { fs.rmSync(f, { force: true }); }
});

test('statusOf: stalled clock is indeterminate, any skipped check is partial, never pass', async () => {
  const { statusOf } = await import('../../src/gate/stability.js');
  const { skippedOf } = await import('../../src/gate/capture.js');
  assert.equal(statusOf({ identityPass: true, acceptance: true, clockStalled: true }).status, 'indeterminate');
  assert.equal(statusOf({ identityPass: true, acceptance: true, skipped: ['T6 dump'] }).status, 'partial');
  assert.equal(statusOf({ identityPass: true, acceptance: true }).status, 'pass');
  assert.equal(statusOf({ identityPass: false, acceptance: true, skipped: ['x'] }).status, 'indeterminate');
  assert.deepEqual(skippedOf({ shotSkipped: 2, dumpSkipped: ['a'], unreadableSheets: ['u'] }), ['2 screenshot(s)', 'T6 dump', '1 unreadable sheet(s)']);
  assert.deepEqual(skippedOf({ shotSkipped: 0, dumpSkipped: [], unreadableSheets: [] }), []);
});

test('identityJudged: a deterministic skipped shot is not an identity failure, a real oracle difference still is', async () => {
  const { identityJudged } = await import('../../src/gate/capture.js');
  const { summarize, statusOf } = { ...(await import('../../src/gate/run.js')), ...(await import('../../src/gate/stability.js')) };
  const mk = (pass, oraclePass, shotSkipped) => ({ kind: 'captured', pass, oracle: { pass: oraclePass }, pixel: { pass: oraclePass && !shotSkipped }, ...(shotSkipped ? { shotSkipped: 'clip outside' } : {}) });
  const j = identityJudged({ a: mk(false, true, true), b: mk(true, true), c: mk(false, false, true), d: mk(false, false) });
  assert.equal(j.a.pass, true); assert.equal(j.b.pass, true); assert.equal(j.c.pass, false); assert.equal(j.d.pass, false);
  const ok = summarize({ a: j.a, b: j.b }).all;
  assert.equal(ok.pass, ok.points);
  const st = statusOf({ identityPass: ok.pass === ok.points, acceptance: false, skipped: ['1 screenshot(s)'] });
  assert.equal(st.status, 'partial');
});
