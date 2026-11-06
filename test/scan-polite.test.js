// The live visit's rules (owner go 3 Nov, item 1 + phone user agent), proven on local HTTP servers only: no live site.
// The servers log every request they get (path, user agent, arrival time), so the tests read what the site saw.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sitePolicy, SiteStopped, NAV_GAP_MS, OWN_GAP_MS } from '../src/scan/polite.js';
import { stopVerdict, retryAfterMs } from '../src/scan/stoprule.js';
import { UA, PROJECT_URL, PRODUCT_TOKEN, browserUserAgent, robotsVerdict } from '../src/safety/robots.js';
import { CLASSES } from '../src/scan/capture.js';
import { mapSite } from '../src/scan/map.js';
import { recordClass } from '../src/freeze/record.js';
import { normalizeConfig } from '../src/freeze/config.js';
import { parseHarZip } from '../src/freeze/sanitize.js';
import { freeze } from '../src/freeze/freeze.js';
import { scanPage, liveRows } from '../src/scan/index.js';
import { Ledger } from '../src/scan/ledger.js';

const html = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const CHALLENGE = html('<div id="cf-chl-widget">Checking your browser. cloudflare</div>', '<title>Just a moment...</title>');

/** A server on 127.0.0.1 or localhost; `routes(path, n)` answers [status, type, body, headers]; every request is logged. */
async function serve(routes, host = '127.0.0.1') {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const at = performance.now();
    const [status, type, body, headers = {}] = routes(p, req.url) || [404, 'text/plain', 'no'];
    hits.push({ path: req.url, ua: req.headers['user-agent'] || '', at, status });
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body);
  });
  await new Promise((r) => srv.listen(0, host, r));
  return { srv, hits, origin: `http://${host}:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}
const gaps = (list) => list.slice(1).map((h, i) => h.at - list[i].at);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-polite-'));

test('stop rule: 429 and 503 with Retry-After stop on any answer; a challenge page stops; a login wall skips an inner page and stops at the start', () => {
  assert.equal(stopVerdict({ status: 429 }).verdict, 'stop');
  assert.match(stopVerdict({ status: 429, headers: { 'Retry-After': '120' } }).why, /429.*120 s/);
  assert.equal(stopVerdict({ status: 503, headers: { 'retry-after': '30' } }).verdict, 'stop');
  assert.equal(stopVerdict({ status: 503 }).verdict, 'ok', 'a 503 without Retry-After is a failure, not a request to stop');
  assert.equal(stopVerdict({ status: 403, document: true, body: html('Forbidden'), headers: { 'content-type': 'text/html' } }).verdict, 'ok', 'a bare 403 (S3 for a missing file) is not a wall');
  assert.equal(stopVerdict({ status: 200, document: true, body: CHALLENGE, headers: { 'content-type': 'text/html' } }).verdict, 'stop');
  assert.equal(stopVerdict({ status: 200, document: false, body: CHALLENGE }).verdict, 'ok', 'only a page is read for markers');
  const login = html('<form><input type="password" name="p"></form>');
  assert.equal(stopVerdict({ status: 200, document: true, body: login, headers: { 'content-type': 'text/html' } }).verdict, 'wall');
  assert.equal(stopVerdict({ status: 200, document: true, body: login, headers: { 'content-type': 'text/html' }, start: true }).verdict, 'stop');
  assert.equal(stopVerdict({ status: 200, document: true, body: 'x', url: 'https://a.test/login', headers: { 'content-type': 'text/html' } }).verdict, 'wall');
  assert.equal(retryAfterMs('7'), 7000);
  assert.equal(retryAfterMs(new Date(Date.now() + 60000).toUTCString()) > 50000, true);
  assert.equal(retryAfterMs('soon'), null);
});

test('user agent: names REVA and the project on plain fetches, desktop and phone; the token is the one robots.txt matches; the phone is a phone', () => {
  for (const ua of [UA, CLASSES.A.userAgent, CLASSES.E.userAgent]) {
    assert.ok(ua.includes(`${PRODUCT_TOKEN}/0.1`), ua);
    assert.ok(ua.includes(PROJECT_URL), ua);
    assert.ok(!/HeadlessChrome/.test(ua), ua);
  }
  assert.match(CLASSES.E.userAgent, /Android .*Mobile Safari/);
  assert.doesNotMatch(CLASSES.A.userAgent, /Mobile/);
  assert.deepEqual([CLASSES.E.isMobile, CLASSES.E.hasTouch, CLASSES.E.deviceScaleFactor], [true, true, 2]);
  assert.match(browserUserAgent('phone', '155.0.8059.79'), /Chrome\/155\.0\.0\.0 Mobile/);
  assert.equal(robotsVerdict('User-agent: REVA\nDisallow: /', ['https://a.test/']).blocked, true, 'the name in the user agent is the name that opts out');
  assert.equal(NAV_GAP_MS, 10000); assert.equal(OWN_GAP_MS, 500);
});

test('map through the policy: one paced queue (Crawl-delay above 500 ms wins), REVA user agent, robots before every URL, a 429 on the third page ends all traffic', async () => {
  let pagesSeen = 0;
  const pageHtml = (p) => html(`<h1>${p}</h1><ul>${['/a', '/b', '/c', '/d', '/no/x'].map((h) => `<li><a href="${h}">${h}</a></li>`).join('')}</ul>`);
  const site = await serve((p) => {
    if (p === '/robots.txt') return [200, 'text/plain', 'User-agent: *\nCrawl-delay: 0.7\nDisallow: /no\n'];
    if (p === '/sitemap.xml') return [404, 'text/plain', 'none'];
    if (++pagesSeen === 3) return [429, 'text/html', 'slow down', { 'retry-after': '120' }];
    return [200, 'text/html', pageHtml(p)];
  });
  try {
    const policy = sitePolicy(site.origin + '/');
    const m = await mapSite(site.origin + '/', { fetchImpl: policy.fetch, gapMs: 0, halted: () => !!policy.stopped });
    assert.ok(policy.stopped, 'stopped');
    assert.match(policy.stopped.why, /429.*120 s/);
    const i429 = site.hits.findIndex((h) => h.status === 429);
    assert.ok(i429 > 0);
    assert.equal(site.hits.length, i429 + 1, `nothing after the 429: ${site.hits.map((h) => h.path).join(' ')}`);
    assert.ok(!site.hits.some((h) => h.path.startsWith('/no')), 'robots-disallowed URL never requested');
    assert.ok(site.hits.every((h) => h.ua === UA), 'every request carries the REVA user agent');
    const g = gaps(site.hits);
    assert.ok(Math.min(...g) >= 700, `Crawl-delay 0.7 s kept: smallest gap ${Math.min(...g).toFixed(0)} ms`);
    assert.ok(m.pages.length >= 1);
    await assert.rejects(policy.fetch(site.origin + '/d'), SiteStopped, 'after a stop nothing is sent');
    assert.equal(site.hits.length, i429 + 1);
  } finally { await site.close(); }
});

test('live visit (desktop): 500 ms between requests to the site during page loads, pages 2 s apart in the test (10 s by default), 100 ms for another host, robots and the navigation guard on every URL, a 429 on the third page stops and keeps what was loaded', async () => {
  let other;
  const site = await serve((p) => {
    if (p === '/robots.txt') return [200, 'text/plain', 'User-agent: *\nDisallow: /private\n'];
    if (p === '/hop.png') return [302, 'text/plain', '', { location: '/hop-2.png' }];
    if (p === '/hop-2.png') return [302, 'text/plain', '', { location: '/private/hop-3.png' }];
    if (p.endsWith('.png')) return [200, 'image/png', PNG];
    if (p.endsWith('.css')) return [200, 'text/css', 'body{margin:0}'];
    const imgs = (n, tag) => Array.from({ length: n }, (_, i) => `<img src="/${tag}-${i}.png">`).join('');
    const far = (n) => Array.from({ length: n }, (_, i) => `<img src="${other.origin}/f-${i}.png">`).join('');
    if (p === '/') return [200, 'text/html', html(imgs(6, 'home') + far(4) + '<img src="/private/x.png">', '<link rel="stylesheet" href="/s.css">')];
    // a script tries to leave for a disallowed path, and for another site: the guard refuses both, the visit goes on
    if (p === '/p1') return [200, 'text/html', html(imgs(3, 'p1') + '<img src="/hop.png">' + `<script>addEventListener('load', () => setTimeout(() => { location.href = '/private/secret'; }, 50))</script>`)];
    if (p === '/p2') return [200, 'text/html', html(imgs(3, 'p2') + `<script>addEventListener('load', () => setTimeout(() => { location.href = '${other.origin}/away'; }, 50))</script>`)];
    if (p === '/p3') return [429, 'text/html', html('Too many requests'), { 'retry-after': '60' }];
    if (p === '/p4') return [200, 'text/html', html('never')];
    return [404, 'text/plain', 'no'];
  });
  other = await serve((p) => (p.endsWith('.png') ? [200, 'image/png', PNG] : [200, 'text/html', html('elsewhere')]), 'localhost');
  const dir = tmp();
  try {
    const policy = sitePolicy(site.origin + '/', { navGapMs: 2000 });
    const cfg = normalizeConfig({ id: 'polite', startUrl: site.origin + '/', classes: { A: CLASSES.A }, pages: ['/p1', '/p2', '/p3', '/p4'].map((p) => site.origin + p), sweep: false, settleMs: 400, preloaderWait: false, extraGapMs: 500 });
    const harPath = path.join(dir, 'A.har.zip');
    const log = await recordClass(cfg, 'A', { harPath, policy });
    // the stop: the third page answered 429, nothing was sent after it, the fourth page was never asked for
    assert.ok(log.stopped, 'stopped'); assert.match(log.stopped.why, /429.*60 s/);
    const at429 = site.hits.find((h) => h.path === '/p3');
    assert.ok(at429, 'p3 was asked for');
    assert.deepEqual(site.hits.filter((h) => h.at > at429.at).map((h) => h.path), [], 'no request after the 429');
    assert.ok(!site.hits.some((h) => h.path === '/p4'));
    assert.match(log.pages.find((x) => x[0].endsWith('/p4'))[1], /not visited/);
    // pacing: every request to the site at least 500 ms after the one before (the server's own clock), page loads included
    const own = gaps(site.hits);
    assert.ok(site.hits.length >= 15, `${site.hits.length} requests: ${site.hits.map((h) => `${h.path} ${h.status} ${h.at.toFixed(0)}`).join(' | ')}; log ${JSON.stringify(log.pages)}`);
    assert.ok(Math.min(...own) >= 500, `smallest gap between requests to the site: ${Math.min(...own).toFixed(0)} ms`);
    const docs = site.hits.filter((h) => /^\/(p\d)?$/.test(h.path));
    assert.ok(Math.min(...gaps(docs)) >= 2000, `pages: ${gaps(docs).map((x) => x.toFixed(0)).join(', ')} ms`);
    const far = other.hits.filter((h) => h.path.endsWith('.png'));
    assert.equal(far.length, 4);
    assert.ok(Math.min(...gaps(far)) >= 100, `another site's host: ${gaps(far).map((x) => x.toFixed(0)).join(', ')} ms`);
    // robots.txt for a page's own file, the guard for script navigations
    assert.ok(!site.hits.some((h) => h.path.startsWith('/private')), 'nothing robots.txt disallows reached the site');
    assert.ok(policy.robotsBlocked.has(site.origin + '/private/x.png'));
    // a redirect hop is paced and checked too: /hop.png -> /hop-2.png (sent, 500 ms later at least) -> /private/hop-3.png (refused)
    const h1 = site.hits.find((h) => h.path === '/hop.png'), h2 = site.hits.find((h) => h.path === '/hop-2.png');
    assert.ok(h1 && h2 && h2.at - h1.at >= 500, `redirect hop ${h2 && h1 ? (h2.at - h1.at).toFixed(0) : '?'} ms after its first request`);
    assert.ok(policy.robotsBlocked.has(site.origin + '/private/hop-3.png'));
    assert.ok(!other.hits.some((h) => h.path === '/away'), 'the page could not take the browser to another site');
    assert.deepEqual([...policy.refused.values()].map((b) => b.agent).sort(), ['*', 'scope']);
    assert.ok(site.hits.some((h) => h.path === '/p2'), 'a refused navigation did not stop the visit');
    // identity: the browser named REVA on every request, to the site and to the other host
    for (const h of [...site.hits, ...other.hits]) assert.equal(h.ua, h.path === '/robots.txt' ? UA : CLASSES.A.userAgent, h.path);
    // kept: the HAR holds what was loaded before the stop
    const har = parseHarZip(fs.readFileSync(harPath));
    const got = new Set(har.har.log.entries.map((e) => new URL(e.request.url).pathname));
    for (const p of ['/', '/p1', '/p2', '/home-0.png', '/p1-2.png', '/p2-2.png']) assert.ok(got.has(p), `HAR keeps ${p}`);
    const sum = policy.summary();
    assert.ok(sum.hosts.find((x) => x.own).minGapMs >= 500);
    console.log(`# measured: ${site.hits.length} requests to the site, smallest gap ${Math.min(...own).toFixed(0)} ms; pages ${gaps(docs).map((x) => x.toFixed(0)).join(', ')} ms; other host smallest ${Math.min(...gaps(far)).toFixed(0)} ms`);
  } finally { await site.close(); await other.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('live visit (phone): a phone to the site (Android Chrome with REVA, touch, DPR 2), and a challenge on the second page stops the visit', async () => {
  const site = await serve((p, url) => {
    if (p === '/robots.txt') return [404, 'text/plain', 'none'];
    if (p === '/beacon') return [204, 'text/plain', ''];
    if (p.endsWith('.png')) return [200, 'image/png', PNG];
    if (p === '/') return [200, 'text/html', html('<img src="/a.png"><img src="/b.png"><script>addEventListener("load", () => { new Image().src = "/beacon?dpr=" + devicePixelRatio + "&touch=" + navigator.maxTouchPoints + "&w=" + innerWidth; })</script>', '<meta name="viewport" content="width=device-width">')];
    if (p === '/p1') return [200, 'text/html', CHALLENGE];
    if (p === '/p2') return [200, 'text/html', html('never')];
    return [404, 'text/plain', String(url)];
  });
  const dir = tmp();
  try {
    const policy = sitePolicy(site.origin + '/', { navGapMs: 1000 });
    const cfg = normalizeConfig({ id: 'polite-phone', startUrl: site.origin + '/', classes: { E: CLASSES.E }, pages: [site.origin + '/p1', site.origin + '/p2'], sweep: false, settleMs: 600, preloaderWait: false });
    const log = await recordClass(cfg, 'E', { harPath: path.join(dir, 'E.har.zip'), policy });
    assert.ok(log.stopped); assert.match(log.stopped.why, /challenge/);
    assert.ok(!site.hits.some((h) => h.path === '/p2'), 'nothing after the challenge');
    const b = site.hits.find((h) => h.path.startsWith('/beacon'));
    assert.ok(b, 'the page reported its device');
    const q = new URL(b.path, site.origin).searchParams;
    assert.equal(q.get('dpr'), '2'); assert.ok(+q.get('touch') > 0, `touch: ${b.path}`); assert.equal(q.get('w'), '390');
    for (const h of site.hits.filter((x) => x.path !== '/robots.txt')) { assert.equal(h.ua, CLASSES.E.userAgent, h.path); assert.match(h.ua, /Android.*Mobile.*REVA\/0\.1/); }
    assert.equal(site.hits.find((x) => x.path === '/robots.txt').ua, UA, 'robots.txt is read by REVA\'s plain fetch');
  } finally { await site.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('freeze with the policy: a 429 during the desktop pages stops the freeze; the phone is not visited, desktop is sealed and kept', async () => {
  const site = await serve((p) => {
    if (p === '/robots.txt') return [404, 'text/plain', 'none'];
    if (p.endsWith('.png')) return [200, 'image/png', PNG];
    if (p === '/') return [200, 'text/html', html('<h1>home</h1><p>' + 'words '.repeat(60) + '</p><img src="/a.png">')];
    if (p === '/p1') return [200, 'text/html', html('<h1>one</h1><img src="/b.png">')];
    if (p === '/p2') return [429, 'text/html', html('slow down')];
    return [404, 'text/plain', 'no'];
  });
  const dir = tmp(), out = path.join(dir, 'archive');
  try {
    const policy = sitePolicy(site.origin + '/', { navGapMs: 1000 });
    const cfg = { id: 'polite-freeze', startUrl: site.origin + '/', classes: { A: CLASSES.A, E: CLASSES.E }, pages: [site.origin + '/p1', site.origin + '/p2'], sweep: false, settleMs: 300, preloaderWait: false, extraGapMs: 500 };
    const r = await freeze(cfg, { outDir: out, bounded: { maxUrls: 10, budgetMs: 20000, concurrency: 1 }, shareBrowser: true, policy });
    assert.ok(r.stopped, 'the freeze reports the stop'); assert.match(r.stopped.why, /429/);
    const phone = site.hits.filter((h) => /Android/.test(h.ua));
    assert.deepEqual(phone.map((h) => h.path), [], 'the phone never visited after the stop');
    const target = JSON.parse(fs.readFileSync(path.join(out, 'target.json'), 'utf8'));
    assert.deepEqual(Object.keys(target.classes), ['A'], 'the archive holds the desktop recording');
    assert.ok(fs.existsSync(path.join(out, 'freeze-report.json')));
    assert.ok(Math.min(...gaps(site.hits)) >= 500);
  } finally { await site.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scanPage: a stop during the map ends the scan with the reason in the ledger (exit 1, no map kept); liveRows says what the rules did', async () => {
  const sent = [];
  const fake = async (u) => {
    sent.push(new URL(u).pathname);
    if (u.endsWith('/robots.txt')) return new Response('', { status: 404 });
    return new Response('slow', { status: 429, headers: { 'retry-after': '90', 'content-type': 'text/html' } });
  };
  const policy = sitePolicy('https://a.test/', { fetchImpl: fake, ownGapMs: 0 });
  const out = path.join(tmp(), 'o');
  const safety = { verdict: 'ok', http: 200, robots: { found: false }, consent: { cmp: null, clicks: [] } };
  const mapImpl = async (u, opts) => { for (const x of ['/', '/a', '/b']) await opts.fetchImpl('https://a.test' + x).catch(() => {}); return { pages: [], templates: [], clusters: [], counts: {} }; };
  const r = await scanPage('https://a.test/', { out, safetyGateImpl: async () => safety, mapImpl, policy, floors: { freeGb: 0, ramGb: 0, cores: 0 } });
  assert.equal(r.exit, 1);
  const stop = r.ledger.get('request', null, null, 'stop');
  assert.equal(stop.status, 'blocked'); assert.match(stop.reason, /429.*90 s.*nothing more/);
  assert.equal(r.ledger.get('page', 'https://a.test/', null, 'https://a.test/').status, 'not-reached');
  assert.deepEqual(sent, ['/robots.txt', '/'], 'nothing after the 429');
  assert.ok(!fs.existsSync(path.join(out, 'map.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'scan.json'), 'utf8')).live.stopped.status, 429);
  const l = new Ledger({ version: 2 });
  liveRows(l, { stopped: null, robotsBlocked: new Map([['https://a.test/x', { url: 'https://a.test/x', agent: '*' }]]), hostsBlocked: new Map([['cdn.b.test', 'the site answered 429 Too Many Requests']]), refused: new Map([['https://c.test/', { url: 'https://c.test/', agent: 'scope' }]]) });
  assert.deepEqual(l.rows.map((x) => x.status), ['blocked', 'blocked', 'blocked']);
  assert.match(l.rows[2].reason, /another site/);
  assert.equal(l.check([]).ok, true);
});
