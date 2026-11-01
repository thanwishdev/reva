// PU-1 (31 Oct) PR-07 / PR-19: an unreachable robots.txt (5xx, 429, timeout, network error) means REVA cannot tell what is
// allowed, so it does not open the page (blocked:robots-unreachable, transient); a 4xx means "no robots.txt" and allows; a name
// that does not resolve is failed:network with the cause code in the reason. Stub fetch, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../../src/safety/index.js';
import { fetchRobots, unreachableWhy } from '../../src/safety/robots.js';
import { safetyGate } from '../../src/safety/gate.js';

const PAGE = '<html><head><title>x</title></head><body><main><h1>Hello</h1><p>content</p></main></body></html>';
/** robots: Response | Error | (() => never); the page itself is always a 200. */
const stub = (robots) => async (u) => {
  if (u.endsWith('/robots.txt')) { if (robots instanceof Error) throw robots; return robots instanceof Response ? robots.clone() : robots(); }
  return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
};

test('robots 503 -> blocked:robots-unreachable, the page is never requested, the status is recorded', async () => {
  const asked = [];
  const f = async (u, o) => { asked.push(u); return stub(new Response('down', { status: 503 }))(u, o); };
  const p = await preflight('https://example.com/', { fetchImpl: f });
  assert.equal(p.verdict, 'blocked:robots-unreachable');
  assert.match(p.reason, /unreachable \(http 503\)/);
  assert.deepEqual(p.robotsFetch, { status: 503, error: 'http 503' });
  assert.deepEqual(asked, ['https://example.com/robots.txt'], 'REVA did not open the page');
});

test('robots 404 -> allow (no robots.txt); the page opens and the status is recorded', async () => {
  const p = await preflight('https://example.com/', { fetchImpl: stub(new Response('nope', { status: 404 })) });
  assert.equal(p.verdict, 'ok');
  assert.deepEqual(p.robotsFetch, { status: 404 });
  assert.equal(p.http, 200);
});

test('robots 200 still decides: a disallow blocks, an allow opens; the status is recorded', async () => {
  const b = await preflight('https://example.com/', { fetchImpl: stub(new Response('User-agent: *\nDisallow: /\n', { status: 200 })) });
  assert.equal(b.verdict, 'blocked:robots'); assert.equal(b.robotsFetch.status, 200);
  const a = await preflight('https://example.com/', { fetchImpl: stub(new Response('User-agent: *\nDisallow: /private\n', { status: 200 })) });
  assert.equal(a.verdict, 'ok');
});

test('robots 429, timeout and a network error are unreachable too; 403 is a plain "no robots.txt"', async () => {
  assert.equal((await preflight('https://example.com/', { fetchImpl: stub(new Response('slow down', { status: 429 })) })).verdict, 'blocked:robots-unreachable');
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const t = await preflight('https://example.com/', { fetchImpl: stub(timeout) });
  assert.equal(t.verdict, 'blocked:robots-unreachable'); assert.equal(t.robotsFetch.error, 'timeout');
  const reset = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
  const n = await preflight('https://example.com/', { fetchImpl: stub(reset) });
  assert.equal(n.verdict, 'blocked:robots-unreachable'); assert.equal(n.robotsFetch.error, 'network ECONNRESET');
  assert.equal((await preflight('https://example.com/', { fetchImpl: stub(new Response('no', { status: 403 })) })).verdict, 'ok');
});

test('--ignore-robots (the person owns the site) is not stopped by an unreachable robots.txt', async () => {
  const p = await preflight('https://example.com/', { fetchImpl: stub(new Response('down', { status: 503 })), ignoreRobots: true });
  assert.equal(p.verdict, 'ok');
});

test('a redirect hop whose robots.txt is unreachable stops before that hop is requested', async () => {
  const asked = [];
  const f = async (u) => {
    asked.push(u);
    if (u === 'https://short.test/robots.txt') return new Response('', { status: 404 });
    if (u === 'https://short.test/a') return new Response('', { status: 301, headers: { location: 'https://target.test/page' } });
    if (u === 'https://target.test/robots.txt') return new Response('down', { status: 500 });
    return new Response(PAGE, { status: 200 });
  };
  const p = await preflight('https://short.test/a', { fetchImpl: f });
  assert.equal(p.verdict, 'blocked:robots-unreachable');
  assert.equal(p.finalUrl, 'https://target.test/page');
  assert.ok(!asked.includes('https://target.test/page'));
});

test('PR-19: "fetch failed" with an ENOTFOUND cause carries ENOTFOUND (failed:network, not an unreachable robots.txt)', async () => {
  const dns = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), { code: 'ENOTFOUND' }) });
  const p = await preflight('https://nope.invalid/', { fetchImpl: async () => { throw dns; } });
  assert.equal(p.verdict, 'failed:network');
  assert.match(p.reason, /fetch failed \(ENOTFOUND\)/);
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const q = await preflight('https://example.com/', { fetchImpl: async (u) => { if (u.endsWith('/robots.txt')) return new Response('', { status: 404 }); throw refused; } });
  assert.equal(q.verdict, 'failed:network'); assert.match(q.reason, /\(ECONNREFUSED\)/);
});

test('fetchRobots: the classification used by preflight and the completion fetch', async () => {
  const r = (res) => fetchRobots('https://x.test', { fetchImpl: async () => res });
  assert.deepEqual(await r(new Response('User-agent: *\n', { status: 200 })), { status: 200, text: 'User-agent: *\n', unreachable: false });
  assert.equal((await r(new Response('', { status: 404 }))).unreachable, false);
  assert.equal((await r(new Response('', { status: 503 }))).unreachable, true);
  assert.equal((await r(new Response('', { status: 429 }))).unreachable, true);
  assert.equal((await fetchRobots('https://x.test', { fetchImpl: async () => { throw new Error('boom'); } })).unreachable, true);
});

test('PU-1: the gate says robots.txt could not be read and to try again later (never "behind a robots-unreachable wall")', async () => {
  const gate = (res) => safetyGate('https://example.com/', { ownDomains: [], fetchImpl: stub(res) });
  await assert.rejects(gate(new Response('down', { status: 503 })), (e) => {
    assert.equal(e.code, 'robots_unreachable');
    assert.equal(e.message, 'robots.txt of https://example.com could not be read (HTTP 503); REVA does not open a page whose robots.txt it cannot read. Try again later.');
    return true;
  });
  await assert.rejects(gate(new Response('slow down', { status: 429 })), (e) => e.code === 'robots_unreachable' && /\(HTTP 429, too many requests\)/.test(e.message) && !/behind a|walls|robots-unreachable/.test(e.message));
  await assert.rejects(gate(new Error('boom')), (e) => e.code === 'robots_unreachable' && /could not be read \(network error\)/.test(e.message));
  assert.equal(unreachableWhy('timeout'), 'no answer within 10 s'); assert.equal(unreachableWhy('network ECONNRESET'), 'network error ECONNRESET');
});
