// Corpus fix lane B: busy-wait guard on the paused clock (F8/F19), volatile-URL fallback and tracker block in the replay (F10/F21/F32),
// tolerant CDP sheet/node reads (F9/F25). Own synthetic fixtures only; no live site.
// Run: node --test --test-concurrency=1 src/freeze/test/robustness.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../../browser/launch.js';
import { makeSpinGuard, spinGuardSource } from '../../util/spinguard.js';
import { gotoLoad, trackNetwork } from '../../gate/run.js';
import { isTrackerUrl, isTrackerFailure } from '../trackers.js';
import { volatileKey, bodyKey } from '../fuzzy.js';
import { packHarZip } from '../sanitize.js';
import { installMissLogger } from '../misslog.js';
import { rankCandidates } from '../policy.js';
import { sheetText, isGoneError } from '../../static/cdpcss.js';
import { OFFLINE_ARGS } from '../../replay/target.js';

const SPIN_PAGE = '<!doctype html><title>spin</title><h1>spin</h1><script>var t=Date.now();while(Date.now()-t<40){}document.title="done"</script>';
function spinServer() {
  return new Promise(r => { const s = http.createServer((q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(SPIN_PAGE); }); s.listen(0, '127.0.0.1', () => r(s)); });
}

test('spin guard: a reading that does not move creeps forward, stays monotonic, deterministic', () => {
  const run = () => { const g = makeSpinGuard(10); const out = []; for (let i = 0; i < 35; i++) out.push(g(1000)); out.push(g(1010)); out.push(g(1010)); return out; };
  const a = run();
  assert.deepEqual(a, run(), 'count based, so identical on every run');
  assert.equal(a[0], 1000); assert.ok(a[34] >= 1003, 'time crept while stuck');
  for (let i = 1; i < a.length; i++) assert.ok(a[i] >= a[i - 1], 'monotonic at ' + i);
  const g = makeSpinGuard(10); for (let i = 0; i < 25; i++) g(1000);
  assert.equal(g(1005), 1005, 'creep is absorbed when the real clock moves on');
});

test('paused fake clock + busy-wait page: load fires with the guard (F8/F19)', { timeout: 60000 }, async () => {
  const s = await spinServer(); let h;
  try {
    h = await launchBrowser({ args: [], context: { viewport: { width: 800, height: 600 } } });
    await h.page.clock.install({ time: Date.parse('2026-01-01T00:00:00Z') - 1000 });
    await h.page.clock.pauseAt(Date.parse('2026-01-01T00:00:00Z'));
    await h.context.addInitScript(spinGuardSource());
    await h.page.goto(`http://127.0.0.1:${s.address().port}/`, { waitUntil: 'load', timeout: 30000 });
    assert.equal(await h.page.title(), 'done');
    assert.ok((await h.page.evaluate(() => window.__wrSpinGuard.ticks)) > 0, 'the guard did tick');
  } finally { if (h) await h.close(); s.close(); }
});

test('gotoLoad: a page that spins forever fails fast with the reason, not after the step cap (F8)', { timeout: 60000 }, async () => {
  const s = await spinServer(); let h; // no guard here: Date is frozen
  try {
    h = await launchBrowser({ args: [], context: { viewport: { width: 800, height: 600 } } });
    await h.page.clock.install({ time: Date.parse('2026-01-01T00:00:00Z') - 1000 });
    await h.page.clock.pauseAt(Date.parse('2026-01-01T00:00:00Z'));
    const t0 = Date.now();
    await assert.rejects(gotoLoad(h.page, `http://127.0.0.1:${s.address().port}/`, trackNetwork(h.page), { timeoutMs: 3000, probeMs: 2000 }), /does not answer.*not retried/);
    assert.ok(Date.now() - t0 < 15000);
  } finally { if (h) await h.close(); s.close(); }
});

test('trackers: collectors are blocked; vendor sites, tag managers, consent and own paths are not (review must-fix 1/2)', () => {
  for (const u of ['https://region1.google-analytics.com/g/collect?v=2', 'https://stats.g.doubleclick.net/g/collect', 'https://r.stripe.com/0', 'https://events.mapbox.com/events/v2?x=1',
    'https://logx.optimizely.com/v1/events', 'https://x.test/cdn-cgi/rum?', 'https://www.facebook.com/tr?id=1', 'https://www.facebook.com/tr/', 'https://api.segment.io/v1/t',
    'https://api.mixpanel.com/track', 'https://o123.ingest.sentry.io/api/1/envelope/', 'https://plausible.io/api/event', 'https://c.clarity.ms/collect']) assert.equal(isTrackerUrl(u), true, u);
  for (const u of ['https://www.googletagmanager.com/gtm.js?id=GTM-1', 'https://cdn.cookielaw.org/consent/x.json', 'https://api.mapbox.com/v4/a/1/1/1.pbf', 'https://www.example.com/', 'https://x.test/cdn-cgi/image/w=1/a.png', 'data:text/plain,hi',
    'https://www.segment.com/', 'https://amplitude.com/', 'https://sentry.io/welcome/', 'https://www.mixpanel.com/pricing', 'https://www.hotjar.com/', 'https://www.fullstory.com/', 'https://plausible.io/',
    'https://www.criteo.com/', 'https://www.taboola.com/', 'https://www.outbrain.com/', 'https://clarity.ms/',
    'https://tr.example.com/tr', 'https://www.example.com/tr/', 'https://www.example.com/tr']) assert.equal(isTrackerUrl(u), false, u);
  // the page being reversed is a vendor: its own site (and first-party collector) is never blocked, its beacons on a third-party page still are
  assert.equal(isTrackerUrl('https://www.segment.com/', 'https://www.segment.com/'), false);
  assert.equal(isTrackerUrl('https://api.segment.io/v1/t', 'https://www.segment.io/'), false, 'same registrable domain as the page');
  assert.equal(isTrackerUrl('https://api.segment.io/v1/t', 'https://shop.example.com/'), true);
  assert.equal(isTrackerUrl('https://api.amplitude.com/2/httpapi', 'https://amplitude.com/'), false);
  assert.equal(isTrackerFailure('POST https://r.stripe.com/0 :: net::ERR_BLOCKED_BY_CLIENT'), true);
  assert.equal(isTrackerFailure('GET https://www.example.com/a.js :: net::ERR_FAILED'), false);
});

test('volatileKey: by parameter name only, never by value shape (review tighten 3)', () => {
  assert.equal(volatileKey('https://a.test/x?_=1792670327729&q=1'), volatileKey('https://a.test/x?q=1&_=1792670999999'));
  assert.equal(volatileKey('https://a.test/x?ts=1&q=1'), volatileKey('https://a.test/x?q=1'));
  assert.equal(volatileKey('https://a.test/x?cb=abc&nonce=z&q=1'), volatileKey('https://a.test/x?q=1'));
  assert.equal(volatileKey('https://a.test/x?v=1792670327729'), volatileKey('https://a.test/x'), 'v as a timestamp');
  assert.notEqual(volatileKey('https://a.test/x?v=3'), volatileKey('https://a.test/x?v=4'), 'v as a version is kept');
  assert.notEqual(volatileKey('https://a.test/x?sku=A'), volatileKey('https://a.test/x?sku=B'));
  assert.notEqual(volatileKey('https://a.test/x?sku=1013rkMkUdSjQ'), volatileKey('https://a.test/x?sku=101SSebPdyUJg'));
  assert.notEqual(volatileKey('https://a.test/x?id=1792670327729'), volatileKey('https://a.test/x?id=1792670327730'), 'a 13-digit id is not a timestamp');
  assert.notEqual(volatileKey('https://a.test/t?id=04ea5e7c-e855-4826-a8a2-16d9406b99f0'), volatileKey('https://a.test/t?id=9f3d2b1c-0000-4000-8000-123456789abc'));
  assert.notEqual(volatileKey('https://a.test/x?q=1'), volatileKey('https://a.test/y?q=1'));
});

test('bodyKey: volatile fields are blanked, other differences are kept (review tighten 4)', () => {
  const k = s => bodyKey(Buffer.from(s));
  assert.equal(k('{"ts":1700000000000,"q":"a"}'), k('{"q":"a","ts":1799999999999}'));
  assert.equal(k('{"op":"x","at":1700000000000}'), k('{"op":"x","at":1700000000099}'), 'a timestamp-sized number under any key');
  assert.notEqual(k('{"query":"{ user(id:1) { name } }"}'), k('{"query":"{ cart { items } }"}'));
  assert.equal(k('a=1&nonce=zz'), k('nonce=yy&a=1'));
  assert.notEqual(k('a=1'), k('a=2'));
});

function harEntry(method, url, status, body, type = 'application/json', postText) {
  return {
    startedDateTime: '2026-10-22T00:00:00.000Z', time: 1, cache: {}, timings: { send: 0, wait: 1, receive: 0 },
    request: { method, url, httpVersion: 'HTTP/1.1', headers: [], cookies: [], queryString: [], headersSize: -1, bodySize: postText ? postText.length : 0, ...(postText ? { postData: { mimeType: 'application/json', text: postText } } : {}) },
    response: { status, statusText: '', httpVersion: 'HTTP/1.1', headers: [{ name: 'content-type', value: type }, { name: 'access-control-allow-origin', value: '*' }], cookies: [], redirectURL: '', headersSize: -1, bodySize: body.length, content: { size: body.length, mimeType: type, text: body } },
  };
}

test('replay: volatile URLs and volatile-only POST bodies are answered from the archive and logged; trackers blocked; a real hole is still a miss', { timeout: 90000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-rob-'));
  const page0 = '<!doctype html><title>t</title><h1>hi</h1><script>' +
    'const r=[];' +
    'Promise.all([fetch("/api/list?_="+Date.now()).then(x=>x.text()),fetch("/api/sync",{method:"POST",body:JSON.stringify({ts:Date.now(),q:"a"})}).then(x=>x.text()),fetch("/api/sync",{method:"POST",body:JSON.stringify({ts:Date.now(),q:"b"})}).then(x=>x.text()).catch(()=>"bodymiss"),' +
    'fetch("https://region1.google-analytics.com/g/collect?v=2",{method:"POST",body:"x"}).catch(()=>"blocked"),fetch("/missing/file.json").catch(()=>"miss")]).then(a=>{document.title=a.join("|")});</script>';
  const har = { log: { version: '1.2', creator: { name: 't', version: '1' }, pages: [], entries: [
    harEntry('GET', 'https://fixture.test/', 200, page0, 'text/html'),
    harEntry('GET', 'https://fixture.test/api/list?_=1700000000000', 200, 'LIST'),
    harEntry('POST', 'https://fixture.test/api/sync', 200, 'SYNC', 'application/json', '{"ts":1700000000000,"q":"a"}'),
  ] } };
  const harPath = path.join(tmp, 'all.har.zip'); fs.writeFileSync(harPath, packHarZip({ har, files: new Map() }));
  let h;
  try {
    h = await launchBrowser({ args: OFFLINE_ARGS, context: { viewport: { width: 800, height: 600 } } });
    const net = await installMissLogger(h.context, { hars: [harPath] });
    await h.page.goto('https://fixture.test/', { waitUntil: 'load', timeout: 30000 });
    await h.page.waitForFunction(() => document.title.includes('|'), null, { timeout: 15000 });
    assert.equal(await h.page.title(), 'LIST|SYNC|bodymiss|blocked|miss', 'fuzzy answers reach the page; a different body and the tracker fetch fail');
    assert.equal(net.fuzzy.length, 2, 'volatile GET and POST body variant');
    assert.equal(net.trackers.length, 1);
    assert.deepEqual(net.misses.map(m => new URL(m.url).pathname).sort(), ['/api/sync', '/missing/file.json'], 'a different POST body and the real hole are misses');
  } finally { if (h) await h.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('rankCandidates: the site\'s own literals come before third-party ones when the cap cuts (F10)', () => {
  const lits = [...Array.from({ length: 5 }, (_, i) => ({ url: `https://cdn.other.test/i${i}.svg` })), { url: 'https://site.test/fonts/a.woff' }];
  const r = rankCandidates({ literals: lits, maxUrls: 2, origin: 'https://site.test' });
  assert.equal(r.picked[0].url, 'https://site.test/fonts/a.woff');
  assert.equal(rankCandidates({ literals: lits, maxUrls: 2 }).picked[0].url, 'https://cdn.other.test/i0.svg', 'no origin: unchanged order');
});

test('sheetText: a removed sheet is null, not a throw (F9); other errors still throw', async () => {
  const gone = { cdp: { send: async () => { throw new Error('Protocol error (CSS.getStyleSheetText): No style sheet with given id found'); } } };
  assert.equal(await sheetText(gone, '1'), null);
  const other = { cdp: { send: async () => { throw new Error('Target closed'); } } };
  assert.equal(isGoneError(new Error('Could not find node with given id')), true);
  await assert.rejects(sheetText({ cdp: { send: async () => { throw new Error('boom'); } } }, '1'), /boom/);
  assert.equal(await sheetText({ cdp: { send: async () => ({ text: 'a{}' }) } }, '1'), 'a{}');
  void other;
});
