// Bounded freeze policy (corpus S1): seal early, one typed + capped completion pass fetched once, a kill keeps the
// sealed archive, live evidence at freeze, salvage of a killed freeze's HARs. Own local server only (no live site).
// Run: node --test --test-concurrency=1 src/freeze/test/bounded.test.js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { freeze } from '../freeze.js';
import { recordClass } from '../record.js';
import { normalizeConfig } from '../config.js';
import { salvageArchive } from '../salvage.js';
import { kindOf, rankCandidates, completenessOf } from '../policy.js';
import { verifyArchive } from '../../archive.js';

const N_LIT = 600;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
let tmp, srv, port, hits;

function server({ assetDelayMs = 30 } = {}) {
  hits = { lit: 0, api: 0, beacon: 0 };
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    if (u.pathname === '/') return send(200, 'text/html', '<!doctype html><title>bounded fixture</title><link rel=stylesheet href="/main.css"><h1>Hello bounded</h1><p>Some text for the live digest.</p><img src="/hero.png" width=80 height=80><script src="/app.js"></script>');
    if (u.pathname === '/main.css') return send(200, 'text/css', 'h1{color:#123}');
    if (u.pathname === '/hero.png') return send(200, 'image/png', PNG);
    if (u.pathname === '/app.js') {
      // 600 asset literals the page never requests (only code analysis finds them), API routes and a beacon: typed
      // completion must take the assets (capped), never the API or the beacon.
      const lits = Array.from({ length: N_LIT }, (_, i) => `"/assets/p${i}.png"`).join(',');
      return send(200, 'application/javascript', `const ASSETS=[${lits}];const API=["/api/user/list","/api/cart/items"];const B="/collect?v=1";window.__n=ASSETS.length;`);
    }
    if (/^\/assets\/p\d+\.png$/.test(u.pathname)) { hits.lit++; return setTimeout(() => send(200, 'image/png', PNG), assetDelayMs); }
    if (u.pathname.startsWith('/api/')) { hits.api++; return send(200, 'application/json', '{}'); }
    if (u.pathname === '/collect') { hits.beacon++; return send(204, 'text/plain', ''); }
    send(404, 'text/plain', 'nope');
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)));
}
const cfgFor = (p, extra = {}) => ({ id: 'fx-bounded', startUrl: `http://localhost:${p}/`, classes: { A: { viewport: { width: 1280, height: 800 } }, E: { viewport: { width: 390, height: 844 } } }, settleMs: 400, sweep: { down: { n: 8, dy: 300, gapMs: 20 }, up: { n: 4, dy: -600, gapMs: 20 } }, ...extra });

before(async () => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-bounded-')); srv = await server(); port = srv.address().port; });
after(() => { srv?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('policy: telemetry, API and non-GET are never candidates; render misses first; cap -> not-fetched:budget', () => {
  assert.equal(kindOf({ url: 'https://www.google-analytics.com/g/collect?v=2' }), 'telemetry');
  assert.equal(kindOf({ url: 'https://x.com/api/user', resourceType: 'fetch' }), 'api');
  assert.equal(kindOf({ url: 'https://x.com/events/hero.jpg' }), 'render');
  assert.equal(kindOf({ url: 'https://x.com/a.js', method: 'POST' }), 'non-GET');
  assert.equal(kindOf({ url: 'https://x.com/font', resourceType: 'font' }), 'render');
  const r = rankCandidates({ misses: [{ url: 'https://x.com/m.css', method: 'GET', resourceType: 'stylesheet' }, { url: 'https://px.ads.linkedin.com/p', method: 'GET' }],
    literals: [{ url: 'https://x.com/a.png' }, { url: 'https://x.com/b.png' }, { url: 'https://x.com/route/page' }], maxUrls: 2 });
  assert.deepEqual(r.picked.map(c => c.url), ['https://x.com/m.css', 'https://x.com/a.png']);
  assert.deepEqual(r.notFetched.map(c => [c.url, c.reason]), [['https://x.com/b.png', 'not-fetched:budget']]);
  assert.deepEqual(r.dropped, { telemetry: 1, api: 1 });
  const c = completenessOf({ A: { requests: 10, misses: [{ method: 'GET', url: 'https://x.com/a.png', resourceType: 'image' }, { method: 'POST', url: 'https://x.com/b' }] } });
  assert.equal(c.pct, 90); assert.equal(c.renderMisses, 1); assert.equal(c.missLog.length, 2);
});

test('bounded freeze: 600 literal URLs -> v1 sealed first, <=200 typed URLs fetched ONCE, < 200 s, live evidence kept', async () => {
  const out = path.join(tmp, 'b1');
  const sealedAt = [];
  const t0 = Date.now();
  const r = await freeze(cfgFor(port), { outDir: out, engine: 'chs', bounded: { maxUrls: 200, budgetMs: 60000, concurrency: 4 }, onSealed: (d, rep) => sealedAt.push([rep.version, Date.now() - t0, verifyArchive(d).ok]) });
  const s = (Date.now() - t0) / 1000;
  assert.ok(s < 200, `took ${s} s`);
  assert.equal(sealedAt[0][0], 1); assert.ok(sealedAt[0][2], 'v1 sums ok when announced');
  assert.ok(hits.lit > 0 && hits.lit <= 200, `asset fetches ${hits.lit} (cap 200, once, not per class)`);
  assert.equal(hits.api, 0, 'API routes never chased'); assert.equal(hits.beacon, 0, 'beacon never chased');
  const rep = JSON.parse(fs.readFileSync(path.join(out, 'freeze-report.json'), 'utf8'));
  assert.equal(rep.policy, 'bounded');
  assert.ok(rep.completion.notFetched.length >= N_LIT - 200, 'the rest is logged as not-fetched:budget');
  assert.ok(rep.completion.notFetched.every(x => x.reason === 'not-fetched:budget'));
  assert.equal(typeof rep.completeness.pct, 'number');
  const live = JSON.parse(fs.readFileSync(path.join(out, 'live.json'), 'utf8'));
  for (const cls of ['A', 'E']) {
    assert.equal(live.classes[cls].docStatus, 200);
    assert.ok(live.classes[cls].elements > 3 && live.classes[cls].textChars > 10, JSON.stringify(live.classes[cls]));
    assert.ok(fs.statSync(path.join(out, 'live', `${cls}.jpg`)).size > 500);
  }
  assert.ok(fs.existsSync(path.join(out, 'misses.json')));
  assert.ok(r.sums.ok && verifyArchive(out).ok);
  console.log(`bounded freeze ${s.toFixed(1)} s, v1 sealed at ${(sealedAt[0][1] / 1000).toFixed(1)} s, versions ${sealedAt.map(x => x[0]).join(',')}, fetched ${hits.lit}, completeness ${rep.completeness.pct} %`);
});

test('a kill during the completion pass leaves the sealed v1 archive', async () => {
  srv.close(); srv = await server({ assetDelayMs: 1500 }); port = srv.address().port; // slow assets: completion runs for a while
  const out = path.join(tmp, 'killed');
  const code = `import('${path.resolve('src/freeze/freeze.js')}').then(m => m.freeze(${JSON.stringify(cfgFor(port))}, { outDir: ${JSON.stringify(out)}, engine: 'chs', bounded: { maxUrls: 200, budgetMs: 120000, concurrency: 1 } }))`;
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      if (hits.lit >= 2) { clearInterval(iv); try { process.kill(-child.pid, 'SIGKILL'); } catch {} setTimeout(resolve, 500); } // completion is running: kill the whole group
      else if (Date.now() - t0 > 150000) { clearInterval(iv); try { process.kill(-child.pid, 'SIGKILL'); } catch {} reject(new Error('completion never started')); }
    }, 200);
  });
  const v = verifyArchive(out);
  assert.ok(v.ok, 'sealed v1 survives the kill');
  const rep = JSON.parse(fs.readFileSync(path.join(out, 'freeze-report.json'), 'utf8'));
  assert.equal(rep.version, 1);
  assert.ok(fs.existsSync(path.join(out, 'live.json')));
  console.log(`killed at ${((Date.now() - t0) / 1000).toFixed(1)} s with ${hits.lit} completion fetches: v1 kept, sums ok`);
});

test('salvage: round-1 HARs of a killed freeze become a sealed archive offline; a truncated round-2 HAR is skipped', async () => {
  const work = path.join(tmp, 'salv.work');
  const cfg = normalizeConfig(cfgFor(port));
  for (const cls of ['A', 'E']) await recordClass(cfg, cls, { harPath: path.join(work, 'round1', 'raw', `${cls}.har.zip`), engine: 'chs' });
  const full = fs.readFileSync(path.join(work, 'round1', 'raw', 'A.har.zip'));
  fs.mkdirSync(path.join(work, 'round2', 'raw'), { recursive: true });
  fs.writeFileSync(path.join(work, 'round2', 'raw', 'A.har.zip'), full.subarray(0, full.length >> 1)); // killed mid-write
  srv.close(); srv = null; // offline from here
  const out = path.join(tmp, 'salv');
  const r = await salvageArchive({ workDir: work, outDir: out, cfg: cfgFor(port), engine: 'chs' });
  assert.ok(r.sums.ok && verifyArchive(out).ok);
  assert.equal(r.report.policy, 'salvage');
  assert.equal(r.sources.A.round1, 'raw'); assert.match(r.sources.A.round2, /^unusable/);
  assert.equal(r.report.recording.A.docStatus, 200);
  assert.equal(r.report.finalReplay.A.pass, true, JSON.stringify(r.report.finalReplay.A.misses?.slice(0, 3)));
});
