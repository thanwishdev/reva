// Streamed takes on a real browser: no cap, rows on disk, and the decoded rows equal, byte for byte, the rows sent whole
// (o.rowTee) in the same run, across a new document, a cleared take and the real-time lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openSession } from '../src/record/session.js';
import { loadTake } from '../src/record/take.js';
import { readSeriesBytes } from '../src/record/series-io.js';

const N = 350;
const PAGE_A = `<!doctype html><title>a</title><style>i{position:absolute;width:4px;height:4px;background:#333}</style><body><script>
for (let i = 0; i < ${N}; i++) { const e = document.createElement('i'); e.style.left = i + 'px'; document.body.append(e); }
const all = [...document.querySelectorAll('i')]; let f = 0;
requestAnimationFrame(function go() { f++; all.forEach((e, i) => { if (i % 3 === f % 3) e.style.transform = 'translateY(' + (f % 40) + 'px)'; }); if (f === 30) all[7].remove(); requestAnimationFrame(go); });
</script>`;
const PAGE_B = `<!doctype html><title>b</title><body><div id=d style="width:10px;height:10px"></div><script>
let f = 0; requestAnimationFrame(function go() { d.style.opacity = (++f % 10) / 10; requestAnimationFrame(go); });
</script>`;

async function withServer(fn) {
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(q.url === '/b' ? PAGE_B : PAGE_A); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const url = `http://localhost:${srv.address().port}/`;   // (the offline flags resolve only localhost)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-')); const old = process.env.REVA_OUT; process.env.REVA_OUT = home;
  try { await fn(url); } finally { if (old == null) delete process.env.REVA_OUT; else process.env.REVA_OUT = old; fs.rmSync(home, { recursive: true, force: true }); srv.close(); }
}
const hashOf = (rows) => { const h = crypto.createHash('sha256'); for (const r of rows) h.update(JSON.stringify(r) + '\n'); return h.digest('hex'); };
const opts = (url, o = {}) => ({ lane: 'hx', rate: 60, url, viewport: { width: 800, height: 600 }, seed: 1, rowTee: true, ...o });
const session = async (o, fn) => { const s = await openSession(o); try { return await fn(s); } finally { await s.close(); } };

test('streamed, no cap: every element sampled, nothing in the heap, rows on disk equal the rows sent whole', async () => {
  await withServer(async (url) => {
    await session(opts(url, { streamRows: true, maxElements: Infinity }), async (s) => {
      const spoolDir = path.dirname(s.data.spool.rows.file);
      await s.goto(); await s.boot({}); await s.hold(1500);
      await s.drain(); const tee = s.teeResult();
      const { take, dir } = await s.finish({ scenario: 'stream' });
      assert.ok(take.watch.length >= N, `watched ${take.watch.length}`); assert.equal(take.c.watchOverflow ?? 0, 0);
      assert.equal(take.data.rows[0].v, undefined, 'only the frame fields stay in memory'); assert.ok(take.data.rows.length > 80);
      assert.equal(take.data.mut.length, 0); assert.equal(take.data.spool, undefined); assert.equal(fs.existsSync(spoolDir), false, 'temp folder removed');
      const L = loadTake(dir, ['rows', 'mutations']);
      assert.equal(L.take.series.rows.encoding, 'delta/1'); assert.equal(L.take.series.rows.n, take.data.rows.length);
      assert.equal(L.data.rows.length, tee.n); assert.equal(hashOf(L.data.rows), tee.digest);
      assert.deepEqual(L.data.rows.map((r) => [r.k, r.T, r.sy, r.sx]), take.data.rows.map((r) => [r.k, r.T, r.sy, r.sx]));
      assert.ok(Object.keys(L.data.rows.at(-1).v).length >= N - 1); assert.ok(L.data.mutations.length > N); assert.equal(L.data.mutations[0].length, 4);
      assert.ok(L.take.series.rows.bytes * 5 < Buffer.byteLength(L.data.rows.map((r) => JSON.stringify(r)).join('\n')), 'the file is far smaller than the rows');
    });
  });
});

test('not streamed: the rows in memory and the series file are what they always were', async () => {
  await withServer(async (url) => {
    await session(opts(url), async (s) => {
      await s.goto(); await s.boot({}); await s.hold(800);
      await s.drain(); const tee = s.teeResult();
      const { take, dir } = await s.finish({ scenario: 'memory' });
      assert.equal(hashOf(take.data.rows), tee.digest);
      const L = loadTake(dir, []); const file = path.join(dir, L.take.series.rows.file);
      assert.equal(L.take.series.rows.digest, tee.digest); assert.equal(L.take.series.rows.encoding, undefined);
      assert.equal(crypto.createHash('sha256').update(readSeriesBytes(file)).digest('hex'), tee.digest);
    });
  });
});

for (const streamRows of [true, false]) test(`a new document and a cleared take restart the chain (${streamRows ? 'streamed' : 'in memory'})`, async () => {
  await withServer(async (url) => {
    await session(opts(url, { streamRows, maxElements: Infinity }), async (s) => {
      await s.goto(); await s.boot({}); await s.hold(600);
      await s.clearSamples(); await s.hold(600); await s.drain();      // rows of the first document after a clear
      await s.goto(url + 'b'); await s.boot({}); await s.hold(600); await s.drain();
      const tee = s.teeResult();
      const { take, dir } = await s.finish({ scenario: 'chain' });
      const rows = streamRows ? loadTake(dir, ['rows']).data.rows : take.data.rows;
      assert.equal(rows.length, tee.n); assert.equal(hashOf(rows), tee.digest);
      assert.ok(Object.keys(rows.at(-1).v).length < 5, 'the last rows are the small second page');
    });
  });
});

test('the real-time lane streams the same way', async () => {
  await withServer(async (url) => {
    await session(opts(url, { lane: 'rt', streamRows: true, maxElements: Infinity }), async (s) => {
      await s.goto(); await s.boot({}); await s.hold(500);
      await s.drain(); const before = s.teeResult();
      await s.setSampling(false); await s.drain(); const tee = s.teeResult();
      const { dir } = await s.finish({ scenario: 'rt' });
      const rows = loadTake(dir, ['rows']).data.rows;
      assert.ok(tee.n >= before.n && tee.n > 0); assert.equal(rows.length, tee.n); assert.equal(hashOf(rows), tee.digest);
    });
  });
});

test('closing without a finish leaves no temp files; a streamed take cannot be finished unwritten', async () => {
  await withServer(async (url) => {
    let dir;
    await session(opts(url, { streamRows: true }), async (s) => { dir = path.dirname(s.data.spool.rows.file); await s.goto(); await s.boot({}); });
    assert.equal(fs.existsSync(dir), false);
    await session(opts(url, { streamRows: true }), async (s) => {
      dir = path.dirname(s.data.spool.rows.file); await s.goto();
      await assert.rejects(s.finish({ write: false }), /write: true/);
    });
  });
});
