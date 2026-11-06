// Read-through (DESIGN 3.7): stays off, and when a caller turns it on the rules hold. No site and no browser: fake answers and a fake context.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, pacer } from '../src/scan/stoprule.js';
import { readThrough, simulatedFetcher } from '../src/scan/readthrough.js';
import { wireReplay } from '../src/replay/replay.js';
import { packHarZip } from '../src/freeze/sanitize.js';
import { Ledger } from '../src/scan/ledger.js';

const HOME = 'https://a.test/';
const get = (url, method = 'GET') => ({ url: () => url, method: () => method });
const quick = (f, o = {}) => readThrough({ fetcher: f, home: HOME, gapMs: 0, ...o });

test('the stop rule: 403, 429, 503 and a challenge stop, a plain failure does not', () => {
  for (const status of [403, 429, 503]) assert.equal(classify({ status }).verdict, 'stop');
  assert.equal(classify({ status: 200, headers: { 'content-type': 'text/html' }, body: '<script src="/cdn-cgi/challenge-platform/x"></script>' }).verdict, 'stop');
  assert.equal(classify({ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('challenge-platform') }).verdict, 'ok', 'a picture is not read as a page');
  assert.equal(classify({ status: 404 }).verdict, 'failed');
  assert.equal(classify({ status: 200 }).verdict, 'ok');
});

test('pacing: one at a time, the gap between starts', async () => {
  let t = 0; const waits = [], starts = [];
  const pace = pacer(500, { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  let running = 0, most = 0;
  const job = async () => { starts.push(t); running++; most = Math.max(most, running); await Promise.resolve(); t += 100; running--; };
  await Promise.all([pace(job), pace(job), pace(job)]);
  assert.deepEqual(starts, [0, 500, 1000]); assert.deepEqual(waits, [400, 400]); assert.equal(most, 1);
});

test('only a GET of the site itself is fetched, once, and the answer fits route.fulfill', async () => {
  const asked = [];
  const r = quick(async (u) => { asked.push(u); return { status: 200, headers: { 'content-type': 'image/png', 'content-encoding': 'br', 'content-length': '9' }, body: Buffer.from('x') }; });
  const a = await r.onMiss(get('https://a.test/x.png')), b = await r.onMiss(get('https://a.test/x.png'));
  assert.equal(a, b); assert.deepEqual(asked, ['https://a.test/x.png']);
  assert.deepEqual(a.headers, { 'content-type': 'image/png' }, 'the body is plain, so the headers must not say otherwise');
  assert.equal(await r.onMiss(get('https://a.test/form', 'POST')), null);
  assert.equal(await r.onMiss(get('https://other.test/y.js')), null);
  assert.equal(await r.onMiss(get('data:text/plain,x')), null);
  assert.equal(asked.length, 1); assert.equal(r.stats.asked, 2);
});

test('one 429 stops every later fetch of the scan and writes a blocked row the ledger accepts', async () => {
  const asked = [];
  const r = quick(async (u) => { asked.push(u); return u.includes('bad') ? { status: 429 } : { status: 200, body: 'ok' }; });
  assert.ok(await r.onMiss(get('https://a.test/1.js')));
  assert.equal(await r.onMiss(get('https://a.test/bad.js')), null);
  assert.equal(await r.onMiss(get('https://a.test/2.js')), null);
  assert.deepEqual(asked, ['https://a.test/1.js', 'https://a.test/bad.js']);
  const rows = r.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'blocked');
  const l = new Ledger({ version: 2 }); for (const x of rows) l.add(x);
});

test('robots, the file limit and a failed fetch stay misses, each with a row', async () => {
  const r = quick(async (u) => { if (u.includes('boom')) throw new Error('no route'); return u.includes('gone') ? null : u.includes('404') ? { status: 404 } : { status: 200, body: '' }; }, { allowed: (u) => !u.includes('private'), maxFiles: 1 });
  assert.equal(await r.onMiss(get('https://a.test/private.js')), null);
  assert.equal(await r.onMiss(get('https://a.test/boom.js')), null);
  assert.equal(await r.onMiss(get('https://a.test/gone.js')), null);
  assert.equal(await r.onMiss(get('https://a.test/404.js')), null);
  assert.ok(await r.onMiss(get('https://a.test/ok.js')));
  assert.equal(await r.onMiss(get('https://a.test/late.js')), null);
  assert.deepEqual(r.rows().map((x) => x.status).sort(), ['limit', 'not-reached', 'not-reached', 'not-reached', 'refused']);
  const l = new Ledger({ version: 2 }); for (const x of r.rows()) l.add(x);
});

test('the simulator answers from the hidden HAR after its delay, and knows nothing else', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  try {
    const entry = (url, content) => ({ request: { method: 'GET', url }, response: { status: 200, headers: [{ name: 'Content-Type', value: 'text/css' }], content } });
    const zip = packHarZip({ har: { log: { entries: [entry('https://a.test/a.css', { _file: 'a.body' }), entry('https://a.test/b.css', { text: 'YQ==', encoding: 'base64' })] } }, files: new Map([['a.body', Buffer.from('body{}')]]) });
    const file = path.join(dir, 'extra-1.har.zip'); fs.writeFileSync(file, zip);
    const f = simulatedFetcher([file], { delayMs: 5 }), a = await f('https://a.test/a.css');
    assert.equal(a.status, 200); assert.equal(a.headers['content-type'], 'text/css'); assert.equal(a.body.toString(), 'body{}');
    assert.equal((await f('https://a.test/b.css')).body.toString(), 'a');
    assert.equal(await f('https://a.test/none'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** The catch-all route of wireReplay, with no browser. */
async function catchAllOf(opts) {
  const routes = [];
  const ctx = { route: async (m, fn) => { routes.push(fn); }, routeFromHAR: async () => {} };
  const net = await wireReplay(ctx, [], { trackers: false, fuzzy: false, ...opts });
  return { net, route: routes[0] };
}
const fakeRoute = (url) => { const c = { fulfilled: null, aborted: null }; return { c, r: { request: () => ({ ...get(url), isNavigationRequest: () => false }), fulfill: async (x) => { c.fulfilled = x; }, abort: async (w) => { c.aborted = w; } } }; };

test('with no onMiss a miss is logged and aborted, as it always was', async () => {
  const { net, route } = await catchAllOf({}), { c, r } = fakeRoute('https://a.test/x.png');
  await route(r);
  assert.deepEqual(net.misses, ['GET https://a.test/x.png']); assert.equal(c.aborted, 'internetdisconnected'); assert.equal(c.fulfilled, null);
});

test('with onMiss an answer is no miss, net.own holds the gate while it is out, and no answer stays a miss', async () => {
  let open; const wait = new Promise((ok) => { open = ok; });
  const { net, route } = await catchAllOf({ onMiss: async (q) => { await wait; return q.url().includes('x') ? { status: 200, body: 'a' } : null; } });
  const a = fakeRoute('https://a.test/x.png'), b = fakeRoute('https://a.test/y.png');
  const pa = route(a.r), pb = route(b.r);
  await Promise.resolve();
  assert.equal(net.own, 2, 'both are out');
  open(); await pa; await pb;
  assert.equal(net.own, 0);
  assert.deepEqual(a.c.fulfilled, { status: 200, body: 'a' }); assert.deepEqual(net.answered, ['https://a.test/x.png']);
  assert.deepEqual(net.misses, ['GET https://a.test/y.png']); assert.equal(b.c.aborted, 'internetdisconnected');
});

test('a failing onMiss cannot hold the gate', async () => {
  const { net, route } = await catchAllOf({ onMiss: async () => { throw new Error('x'); } }), { c, r } = fakeRoute('https://a.test/x.png');
  await route(r);
  assert.equal(net.own, 0); assert.equal(c.aborted, 'internetdisconnected');
});

test('the live fetcher of an experience: robots.txt first, the host\'s turn, the bytes as sent; a 429 stops read-through', async () => {
  const { liveFetcher, readThrough } = await import('../src/scan/readthrough.js');
  const asked = [];
  const policy = { robotsBlock: async (u) => (u.includes('/private/') ? { url: u, rule: 'Disallow: /private/' } : null),
    pacedFetch: async (u) => { asked.push(u); if (u.endsWith('busy.ktx')) return new Response('', { status: 429 }); return new Response(new Uint8Array([0xab, 0x4b, 0x54, 0x58]), { status: 200, headers: { 'content-type': 'image/ktx' } }); } };
  const rt = readThrough({ fetcher: liveFetcher(policy), home: 'https://x.test/', allowed: async (u) => !(await policy.robotsBlock(u)), gapMs: 0 });
  const q = (url) => ({ method: () => 'GET', url: () => url });
  const a = await rt.onMiss(q('https://x.test/assets/a.ktx'));
  assert.deepEqual([a.status, [...a.body]], [200, [0xab, 0x4b, 0x54, 0x58]], 'binary bytes, untouched');
  assert.equal(await rt.onMiss(q('https://x.test/private/b.ktx')), null);
  assert.equal(await rt.onMiss(q('https://other.test/c.ktx')), null, 'another site: never');
  assert.equal(await rt.onMiss(q('https://x.test/busy.ktx')), null);
  assert.ok(rt.stats.stopped, 'a 429 stops it');
  assert.equal(await rt.onMiss(q('https://x.test/assets/d.ktx')), null, 'nothing after the stop');
  assert.deepEqual(asked, ['https://x.test/assets/a.ktx', 'https://x.test/busy.ktx']);
});

test('an experience is a click that starts files loading on a page with a canvas that has not drawn; a loader label alone is not one', async () => {
  const { isExperience } = await import('../src/scan/opens.js');
  assert.equal(isExperience({ contexts: 1, cover: 1, misses: 19, inflight: 0, loader: false, drawnFrames: 0 }), true, 'a WebGL gallery: 19 files, no draw');
  assert.equal(isExperience({ contexts: 3, cover: 0, misses: 0, inflight: 0, loader: true, drawnFrames: 0 }), false, 'a page-change loader label, nothing loading');
  assert.equal(isExperience({ contexts: 1, cover: 1, misses: 5, inflight: 0, loader: false, drawnFrames: 90 }), false, 'it draws already');
  assert.equal(isExperience({ contexts: 0, cover: 0, misses: 9, inflight: 0, loader: true, drawnFrames: 0 }), false, 'no canvas at all');
});

test('an experience\'s files are new GETs on a canvas in view: beacons, the arrival\'s own misses and a context off screen are not', async () => {
  const { isExperience, fileMisses } = await import('../src/scan/opens.js');
  // a large marketing site, 6 Nov sealed: the arrival misses the editor bar and two beacons; a click then sends beacons and reloads the editor bar
  const arrival = ['GET https://p.test/edit?id=1&loadStart=1', 'POST https://api.p.test/v1/p', 'POST https://events.p.test/anonymous'];
  const click = ['POST https://api.p.test/v1/p', 'POST https://api.p.test/v1/p', 'GET https://p.test/edit?id=1&loadStart=2', 'POST https://events.p.test/anonymous'];
  assert.equal(fileMisses([...arrival, ...click], arrival.length), 0, 'beacons and the arrival\'s own GET');
  assert.equal(isExperience({ contexts: 1, cover: 1, misses: fileMisses([...arrival, ...click], arrival.length), inflight: 0, loader: false, drawnFrames: 0 }), false, 'a logo click: no files');
  // a tab that shows images the copy lacks, while a WebGL scene elsewhere on the page is off screen
  assert.equal(isExperience({ contexts: 1, cover: 0, misses: 12, inflight: 0, loader: false, drawnFrames: 0 }), false, 'a tab: canvas not in view');
  // a WebGL gallery site: textures for a full-screen canvas, one asked twice
  const tex = ['GET https://m.test/assets/webgl/art_050.ktx', 'GET https://m.test/assets/webgl/art_052.ktx', 'GET https://m.test/assets/webgl/skybox.ktx', 'GET https://m.test/assets/webgl/art_050.ktx'];
  assert.equal(fileMisses([...arrival, ...tex], arrival.length), 3);
  assert.equal(isExperience({ contexts: 1, cover: 1, misses: fileMisses([...arrival, ...tex], arrival.length), inflight: 0, loader: false, drawnFrames: 0 }), true, 'a WebGL gallery');
});
