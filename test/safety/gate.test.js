// The safety gate of the public commands (src/safety/gate.js): robots.txt and walls stop `reva look` / MCP look
// BEFORE a browser starts, on the typed URL and on every redirect hop; --ignore-robots (typed site only) and the person's
// ownDomains list lift only the robots stop, and the MCP has no override an agent could set; a recognised cookie banner is
// rejected in the page. Own loopback servers only, no internet.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { safetyGate } from '../../src/safety/gate.js';
import { preflight } from '../../src/safety/preflight.js';
import { runLook } from '../../src/look/index.js';
import { sandbox } from '../mcp/helpers.js';

/** Serve {path: {status?, body, type?, location?}} on 127.0.0.1. */
async function serve(routes) {
  const srv = http.createServer((req, res) => {
    const r = routes[new URL(req.url, 'http://x').pathname];
    if (!r) { res.writeHead(404); return res.end('not found'); }
    if (r.location) { res.writeHead(r.status || 302, { location: typeof r.location === 'function' ? r.location() : r.location }); return res.end(); }
    res.writeHead(r.status || 200, { 'content-type': r.type || 'text/html' }); res.end(r.body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}
const PAGE = '<!doctype html><title>t</title><h1>hello</h1><p>' + 'plain page text. '.repeat(40) + '</p>';
const ROBOTS_ALL = { body: 'User-agent: *\nDisallow: /private\n', type: 'text/plain' };
const ROBOTS_CLAUDE = { body: 'User-agent: ClaudeBot\nDisallow: /\n', type: 'text/plain' };

test('robots.txt that disallows the page stops the gate (all robots, and the Anthropic agents); the message names --ignore-robots', async () => {
  const a = await serve({ '/robots.txt': ROBOTS_ALL, '/private/x': { body: PAGE } });
  const b = await serve({ '/robots.txt': ROBOTS_CLAUDE, '/': { body: PAGE } });
  try {
    await assert.rejects(safetyGate(`${a.origin}/private/x`, { ownDomains: [] }), (e) => e.code === 'blocked_robots' && /disallows .* for all robots/.test(e.message) && /--ignore-robots/.test(e.message) && /ownDomains/.test(e.message));
    await assert.rejects(safetyGate(`${b.origin}/`, { ownDomains: [] }), (e) => e.code === 'blocked_robots' && /for ClaudeBot/.test(e.message));
  } finally { await a.close(); await b.close(); }
});

test('--ignore-robots lifts only the robots stop: the page is still fetched, a wall still stops it', async () => {
  const s = await serve({ '/robots.txt': ROBOTS_ALL, '/private/ok': { body: PAGE }, '/private/wall': { body: '<html><script src="/cdn-cgi/challenge-platform/x.js"></script>Just a moment...</html>' } });
  const logs = [];
  try {
    const ok = await safetyGate(`${s.origin}/private/ok`, { ignoreRobots: true, log: (m) => logs.push(m) });
    assert.equal(ok.verdict, 'ok'); assert.equal(ok.robots.blocked, true); assert.equal(ok.robots.ignored, true); assert.equal(ok.http, 200);
    assert.ok(logs.some((m) => /opening it anyway because of --ignore-robots/.test(m)), logs.join(' | '));
    await assert.rejects(safetyGate(`${s.origin}/private/wall`, { ignoreRobots: true }), (e) => e.code === 'blocked_wall' && /bot wall \(cloudflare\)/.test(e.message));
  } finally { await s.close(); }
});

test('walls stop the gate: bot wall (403 / challenge), login wall, region block', async () => {
  const s = await serve({
    '/forbidden': { status: 403, body: 'no' },
    '/login': { body: '<form><input type="password" name="p"></form>' },
    '/geo': { status: 451, body: 'unavailable' },
  });
  try {
    await assert.rejects(safetyGate(`${s.origin}/forbidden`), (e) => e.code === 'blocked_wall' && /bot wall \(status:403\)/.test(e.message));
    await assert.rejects(safetyGate(`${s.origin}/login`), (e) => e.code === 'blocked_wall' && /login wall/.test(e.message));
    await assert.rejects(safetyGate(`${s.origin}/geo`), (e) => e.code === 'blocked_wall' && /region block/.test(e.message));
  } finally { await s.close(); }
});

test('an open page passes; a missing robots.txt allows; the cookie banner reject buttons are carried to the look', async () => {
  const s = await serve({ '/': { body: '<html><div id="cookie-banner">We use cookies. <button>Accept</button><button>Reject all</button></div>' + PAGE + '</html>' } });
  try {
    const g = await safetyGate(`${s.origin}/`);
    assert.equal(g.verdict, 'ok'); assert.equal(g.robots.found, false); assert.equal(g.robots.blocked, false);
    assert.deepEqual(g.consent.clicks, ['text="Reject all"']); assert.deepEqual(g.consent.clicked, []);
  } finally { await s.close(); }
});

test('preflight: ignoreRobots keeps the robots verdict in out.robots and goes on to the page', async () => {
  const s = await serve({ '/robots.txt': ROBOTS_ALL, '/private/ok': { body: PAGE } });
  try {
    assert.equal((await preflight(`${s.origin}/private/ok`)).verdict, 'blocked:robots');
    const p = await preflight(`${s.origin}/private/ok`, { ignoreRobots: true });
    assert.equal(p.verdict, 'ok'); assert.equal(p.robots.blocked, true); assert.equal(p.http, 200);
  } finally { await s.close(); }
});

test('look on a live URL: a robots or wall stop happens before any browser starts (the error is the gate\'s, in user words)', async () => {
  let opened = 0; const blocked = (verdict, extra = {}) => async (url, o) => { opened++; return { url, verdict, reason: 'x', robots: { blocked: verdict === 'blocked:robots', star: 'disallow', reason: 'robots:star' }, robotsText: 'x', consent: { cmp: null, clicks: [] }, ...extra, ignore: o }; };
  const t0 = Date.now();
  await assert.rejects(runLook({ input: 'https://reva-gate-test.invalid/a', preflight: blocked('blocked:robots'), engine: 'chs' }), (e) => e.code === 'blocked_robots');
  await assert.rejects(runLook({ input: 'https://reva-gate-test.invalid/b', preflight: blocked('blocked:wall', { wall: { kind: 'wall', marker: 'cloudflare' } }), engine: 'chs' }), (e) => e.code === 'blocked_wall' && /cloudflare/.test(e.message));
  assert.equal(opened, 2);
  assert.ok(Date.now() - t0 < 2000, `no browser launch (${Date.now() - t0} ms)`);
  // a local / fixture URL is not gated unless asked (the tool's own pages and the tests)
  let asked = 0; const spy = async () => { asked++; throw Object.assign(new Error('gate ran'), { code: 'spy' }); };
  await assert.rejects(runLook({ input: 'http://127.0.0.1:9/x', preflight: spy, safety: true, engine: 'chs' }), (e) => e.code === 'spy');
  assert.equal(asked, 1);
});

test('MCP look: a robots stop is a tool error with code blocked_robots that names ownDomains; there is no ignore_robots an agent could set', async () => {
  sandbox('gate');
  const { runTool } = await import('../../src/mcp/index.js');
  const lookup = async () => [{ address: '93.184.215.14', family: 4 }];
  const robotsStop = async (url) => ({ url, verdict: 'blocked:robots', reason: 'robots:star', robots: { blocked: true, star: 'disallow', reason: 'robots:star' }, robotsText: 'User-agent: *\nDisallow: /', consent: { cmp: null, clicks: [] } });
  const r = await runTool('look', { url: 'https://example.com/' }, { lookup, runLook: (o) => runLook({ ...o, preflight: robotsStop }) });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'blocked_robots');
  assert.match(r.error.message, /ownDomains/); assert.match(r.error.message, /an agent cannot lift/); assert.doesNotMatch(r.error.message, /--ignore-robots|ignore_robots/);
  // the argument is gone from the schema: an agent (or a prompt injection in page text) cannot ask for it
  let ran = false;
  const bad = await runTool('look', { url: 'https://example.com/', ignore_robots: true }, { lookup, runLook: async () => { ran = true; throw new Error('must not run'); } });
  assert.equal(bad.ok, false); assert.match(JSON.stringify(bad.error), /ignore_robots: unknown argument/); assert.equal(ran, false);
  let seen = null;
  await runTool('look', { url: 'https://example.com/' }, { lookup, runLook: async (o) => { seen = o; throw new Error('stop here'); } });
  assert.equal(seen.ignoreRobots, undefined); assert.equal(seen.safetyWho, 'mcp');
});

test('a redirect cannot get around robots.txt: host A allows, 302 to host B whose robots.txt disallows -> blocked_robots', async () => {
  const b = await serve({ '/robots.txt': ROBOTS_CLAUDE, '/page': { body: PAGE } });
  // A is 127.0.0.1, B is reached as localhost: two different origins (and host names)
  const bUrl = b.origin.replace('127.0.0.1', 'localhost') + '/page';
  const a = await serve({ '/robots.txt': { body: 'User-agent: *\nAllow: /\n', type: 'text/plain' }, '/go': { location: bUrl }, '/chain': { location: '/go' } });
  try {
    for (const start of [`${a.origin}/go`, `${a.origin}/chain`]) {
      await assert.rejects(safetyGate(start, { ownDomains: [] }), (e) => e.code === 'blocked_robots' && e.message.includes(`${bUrl.replace('/page', '')}/robots.txt disallows ${bUrl}`) && /redirects there/.test(e.message) && /for ClaudeBot/.test(e.message), start);
    }
    const p = await preflight(`${a.origin}/chain`);
    assert.equal(p.verdict, 'blocked:robots'); assert.equal(p.robots.url, bUrl);
    assert.deepEqual(p.hops.map((h) => [h.url, h.blocked]), [[`${a.origin}/chain`, false], [`${a.origin}/go`, false], [bUrl, true]]);
    // --ignore-robots covers the typed site only, not the host a redirect leads to
    await assert.rejects(safetyGate(`${a.origin}/go`, { ignoreRobots: true, ownDomains: [] }), (e) => e.code === 'blocked_robots' && /--ignore-robots covers only 127\.0\.0\.1/.test(e.message));
    // the person lists B as their own: the robots stop is lifted and the page is fetched
    const logs = [];
    const ok = await safetyGate(`${a.origin}/go`, { ownDomains: ['localhost'], log: (m) => logs.push(m) });
    assert.equal(ok.verdict, 'ok'); assert.equal(ok.http, 200); assert.equal(ok.robots.ignored, true); assert.equal(ok.robots.url, bUrl);
    assert.ok(logs.some((m) => /"ownDomains"/.test(m)), logs.join(' | '));
    // the MCP side: own domains lift it, a plain agent call does not
    await assert.rejects(safetyGate(`${a.origin}/go`, { who: 'mcp', ignoreRobots: true, ownDomains: [] }), (e) => e.code === 'blocked_robots' && /an agent cannot lift/.test(e.message));
    assert.equal((await safetyGate(`${a.origin}/go`, { who: 'mcp', ownDomains: ['localhost'] })).verdict, 'ok');
  } finally { await a.close(); await b.close(); }
});

test('the MCP preflight: every hop goes through the address check AND the robots check (hopCheckedFetch, redirect manual)', async () => {
  const { hopCheckedFetch } = await import('../../src/safety/gate.js');
  const b = await serve({ '/robots.txt': ROBOTS_ALL, '/private/p': { body: PAGE } });
  const bUrl = b.origin.replace('127.0.0.1', 'localhost') + '/private/p';
  const a = await serve({ '/go': { location: bUrl } });
  const checked = [];
  try {
    const f = hopCheckedFetch(async (u) => { checked.push(new URL(u).host); });
    const p = await preflight(`${a.origin}/go`, { fetchImpl: f });
    assert.equal(p.verdict, 'blocked:robots'); assert.equal(p.robots.url, bUrl);
    assert.ok(checked.includes(new URL(bUrl).host), checked.join(','));
    assert.ok(!p.html, 'the blocked page itself was never fetched');
  } finally { await a.close(); await b.close(); }
});

test('ownDomains: read from <data root>/config.json; a bare TLD or junk is dropped; subdomains count', async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const { readOwnDomains, isOwnDomain } = await import('../../src/safety/own-domains.js');
  const root = sandbox('own');
  assert.deepEqual(readOwnDomains(), []);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ownDomains: ['Example.com', 'com', '*.mysite.dev', 'bad host', 42, 'localhost'] }));
  const list = readOwnDomains();
  assert.deepEqual(list, ['example.com', 'mysite.dev', 'localhost']);
  assert.equal(isOwnDomain('https://www.example.com/x', list), true);
  assert.equal(isOwnDomain('https://notexample.com/', list), false);
  assert.equal(isOwnDomain('https://evil.com/?u=example.com', list), false);
  fs.writeFileSync(path.join(root, 'config.json'), '{not json');
  assert.deepEqual(readOwnDomains(), []);
});

test('hopCheckedFetch: every redirect hop is checked before it is requested; a hop to a private address is never fetched', async () => {
  const { hopCheckedFetch } = await import('../../src/safety/gate.js');
  const inner = await serve({ '/secret': { body: 'internal' } });
  const outer = http.createServer((req, res) => { res.writeHead(302, { location: `${inner.origin}/secret` }); res.end(); });
  await new Promise((r) => outer.listen(0, '127.0.0.1', r));
  const outerUrl = `http://localhost:${outer.address().port}/start`;
  const checked = [];
  const f = hopCheckedFetch(async (u) => { checked.push(u); if (u.startsWith(inner.origin)) throw new Error('blocked: private address'); });
  try {
    await assert.rejects(f(outerUrl), /blocked: private address/);
    assert.deepEqual(checked, [outerUrl, `${inner.origin}/secret`]);
    const ok = hopCheckedFetch(async () => {});
    assert.equal(await (await ok(outerUrl)).text(), 'internal', 'with an allowing check the redirect is followed');
    // MCP: the look run hands look a checked fetch for a public URL
    sandbox('gate2');
    const { runTool } = await import('../../src/mcp/index.js');
    let seen = null;
    await runTool('look', { url: 'https://example.com/' }, { lookup: async () => [{ address: '93.184.215.14', family: 4 }], runLook: async (o) => { seen = o; throw new Error('stop here'); } });
    assert.equal(typeof seen.preflightFetch, 'function');
  } finally { outer.closeAllConnections?.(); await new Promise((r) => outer.close(r)); await inner.close(); }
});
