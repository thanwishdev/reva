// The robots check on every main-frame navigation after the first load (src/safety/gate.js navigationGuard): a page that
// sends the browser on with a meta refresh or a script setting location cannot take REVA to a URL its robots.txt
// disallows, in reva look, in the design pass (its second page load) and in reva design. Own loopback servers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { navigationGuard } from '../../src/safety/gate.js';
import { runLook } from '../../src/look/index.js';
import { runDesignPass } from '../../src/design/pass.js';
import { resolveSource } from '../../src/look/source.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'safety');
const ROBOTS = 'User-agent: *\nDisallow: /private/\n';
const robotsFetch = (text, calls = []) => async (u) => { calls.push(String(u)); return { status: 200, text: async () => text }; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-navguard-'));

/** Serves fixtures/safety/<name>.html at /, robots.txt that disallows /private/, and records every request path. */
async function serve() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(ROBOTS); }
    if (req.url === '/hop') { res.writeHead(302, { location: '/private/hop.html' }); return res.end(); }
    const m = /^\/(meta-refresh|js-location|popup|blank-link|popup-hop|js-hop|form-hop)\.html$/.exec(req.url);
    if (m) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(FIX, `${m[1]}.html`))); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>x</title><p>private</p>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { origin: `http://localhost:${srv.address().port}`, hits, close: () => { srv.closeAllConnections?.(); return new Promise((r) => srv.close(r)); } };
}

test('navigationGuard.check: disallowed, allowed, non-http, and the gate\'s overrides (own domains; --ignore-robots for the typed site only, never on the MCP)', async () => {
  const calls = [];
  const g = navigationGuard('https://a.example/', { fetchImpl: robotsFetch(ROBOTS, calls), ownDomains: [] });
  const b = await g.check('https://a.example/private/x#frag');
  assert.deepEqual(b, { url: 'https://a.example/private/x', origin: 'https://a.example', agent: '*', rule: 'robots:star' });
  assert.equal(await g.check('https://a.example/public'), null);
  assert.equal(await g.check('about:blank'), null); assert.equal(await g.check('data:text/html,x'), null);
  assert.deepEqual(calls, ['https://a.example/robots.txt'], 'one robots.txt fetch per origin');
  // seeded with the texts the gate already read: no fetch at all
  const seeded = []; const s = navigationGuard('https://a.example/', { fetchImpl: robotsFetch('', seeded), seed: new Map([['https://a.example', ROBOTS]]), ownDomains: [] });
  assert.ok(await s.check('https://a.example/private/y')); assert.deepEqual(seeded, []);
  // --ignore-robots (CLI) lifts the typed site, not another host; the MCP has no such override
  const cli = navigationGuard('https://a.example/', { ignoreRobots: true, fetchImpl: robotsFetch(ROBOTS), ownDomains: [] });
  assert.equal(await cli.check('https://www.a.example/private/x'), null);
  assert.ok(await cli.check('https://b.example/private/x'));
  const mcp = navigationGuard('https://a.example/', { ignoreRobots: true, who: 'mcp', fetchImpl: robotsFetch(ROBOTS), ownDomains: [] });
  assert.ok(await mcp.check('https://a.example/private/x'));
  const own = navigationGuard('https://a.example/', { who: 'mcp', fetchImpl: robotsFetch(ROBOTS), ownDomains: ['b.example'] });
  assert.equal(await own.check('https://b.example/private/x'), null);
  // the error is the gate's code, says what sent the browser there, and names the override the reader has
  assert.equal(g.error(), null);
  await g.attach({ route: async () => {}, on: () => {}, mainFrame: () => null, context: () => ({ route: async () => {}, on: () => {}, pages: () => [], newCDPSession: async () => ({ send: async () => ({}), on: () => {} }) }) });
  assert.equal(await g.settle(), b);
  const e = g.error(); assert.equal(e.code, 'blocked_robots');
  assert.match(e.message, /robots\.txt disallows https:\/\/a\.example\/private\/x \(https:\/\/a\.example\/ sent the browser there after it loaded\)/);
  assert.match(e.message, /--ignore-robots/);
  await mcp.check('https://a.example/private/z'); await mcp.settle();
  assert.match(mcp.error().message, /an agent cannot lift/); assert.doesNotMatch(mcp.error().message, /--ignore-robots/);
});

test('look: a meta refresh to a robots-disallowed URL stops the look with blocked_robots; the disallowed URL is never requested', async () => {
  const s = await serve(); const out = tmp();
  try {
    await assert.rejects(runLook({ input: `${s.origin}/meta-refresh.html`, safety: true, design: false, engine: 'chs', outDir: out }),
      (e) => e.code === 'blocked_robots' && e.message.includes(`${s.origin}/private/target.html`));
    assert.ok(s.hits.includes('/meta-refresh.html'), s.hits.join(' '));
    assert.ok(!s.hits.some((h) => h.startsWith('/private/')), `never requested: ${s.hits.join(' ')}`);
  } finally { await s.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('look: a script setting location mid-take stops the look the same way', async () => {
  const s = await serve(); const out = tmp();
  try {
    await assert.rejects(runLook({ input: `${s.origin}/js-location.html`, safety: true, design: false, engine: 'chs', outDir: out }),
      (e) => e.code === 'blocked_robots' && e.message.includes(`${s.origin}/private/js.html`));
    assert.ok(!s.hits.some((h) => h.startsWith('/private/')), `never requested: ${s.hits.join(' ')}`);
  } finally { await s.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('look: a popup (window.open) to a robots-disallowed URL is never requested; the look of the page itself goes on', async () => {
  const s = await serve(); const out = tmp(); const logs = [];
  try {
    const r = await runLook({ input: `${s.origin}/popup.html`, safety: true, design: false, engine: 'chs', outDir: out, log: (m) => logs.push(m) });
    assert.ok(r && r.dir, 'the look of the first page completes');
    assert.ok(s.hits.includes('/popup.html'), s.hits.join(' '));
    assert.ok(!s.hits.some((h) => h.startsWith('/private/')), `never requested: ${s.hits.join(' ')}`);
    assert.ok(logs.some((m) => /opened a popup to .*\/private\/.*REVA analyses one page and did not load it/.test(m)), logs.join('\n'));
  } finally { await s.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('look --do click on a target=_blank link to a robots-disallowed URL: the new page\'s request is never sent', async () => {
  const s = await serve(); const out = tmp(); const logs = [];
  try {
    const r = await runLook({ input: `${s.origin}/blank-link.html`, el: '#go', action: 'click', safety: true, design: false, engine: 'chs', outDir: out, log: (m) => logs.push(m) }).catch((e) => e);
    assert.ok(logs.some((m) => /opened a popup to .*\/private\/.*REVA analyses one page and did not load it/.test(m)), `the click opened the new page and the guard refused it:\n${logs.join('\n')}`);
    assert.ok(!(r instanceof Error), `the look of the page itself goes on: ${r && r.message}`);
    assert.ok(r.action && r.action.do === 'click');
    assert.ok(s.hits.includes('/blank-link.html'), s.hits.join(' '));
    assert.ok(!s.hits.some((h) => h.startsWith('/private/')), `never requested: ${s.hits.join(' ')}`);
  } finally { await s.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('look: a popup to an allowed URL that redirects (302) to a disallowed one: no popup loads, neither URL is requested; the look goes on', async () => {
  const s = await serve(); const out = tmp(); const logs = [];
  try {
    const r = await runLook({ input: `${s.origin}/popup-hop.html`, safety: true, design: false, engine: 'chs', outDir: out, log: (m) => logs.push(m) });
    assert.ok(r && r.dir, 'the look of the first page completes');
    assert.ok(s.hits.includes('/popup-hop.html'), s.hits.join(' '));
    assert.ok(!s.hits.some((h) => h === '/hop' || h.startsWith('/private/')), `never requested: ${s.hits.join(' ')}`);
    assert.ok(logs.some((m) => /opened a popup to .*\/hop; REVA analyses one page and did not load it/.test(m)), logs.join('\n'));
  } finally { await s.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

for (const [name, how] of [['js-hop', 'a script setting location'], ['form-hop', 'a form post']]) {
  test(`look: ${how} to an allowed URL that redirects (302) to a disallowed one: blocked_robots, the disallowed hop is never sent`, async () => {
    const s = await serve(); const out = tmp();
    try {
      await assert.rejects(runLook({ input: `${s.origin}/${name}.html`, safety: true, design: false, engine: 'chs', outDir: out }),
        (e) => e.code === 'blocked_robots' && e.message.includes(`${s.origin}/private/hop.html`));
      assert.ok(s.hits.includes('/hop'), `the allowed first hop is sent: ${s.hits.join(' ')}`);
      assert.ok(!s.hits.some((h) => h.startsWith('/private/')), `never requested: ${s.hits.join(' ')}`);
    } finally { await s.close(); fs.rmSync(out, { recursive: true, force: true }); }
  });
}

test('design pass: the guard covers its own page load; a refusal is {ok:false, code:blocked_robots} and nothing it wrote is kept', async () => {
  const s = await serve(); const out = path.join(tmp(), 'design');
  try {
    const src = resolveSource(`${s.origin}/meta-refresh.html`, { cls: 'A' });
    const navGuard = navigationGuard(src.url, { ownDomains: [] });
    const d = await runDesignPass({ src, outDir: out, engine: 'chs', navGuard });
    assert.equal(d.ok, false); assert.equal(d.code, 'blocked_robots');
    assert.match(d.error, /robots\.txt disallows .*\/private\/target\.html/);
    assert.ok(!fs.existsSync(out), 'the static record is removed');
    assert.ok(!s.hits.some((h) => h.startsWith('/private/')), `never requested: ${s.hits.join(' ')}`);
  } finally { await s.close(); fs.rmSync(path.dirname(out), { recursive: true, force: true }); }
});

test('reva design on a live URL passes the safety gate first: robots.txt "Disallow: /" stops it before any browser starts', async () => {
  const { designCommand, DESIGN_HELP } = await import('../../src/design/cli.js');
  assert.match(DESIGN_HELP, /--ignore-robots/); assert.match(DESIGN_HELP, /--engine/);
  const real = globalThis.fetch; const calls = [];
  globalThis.fetch = async (u) => { calls.push(String(u)); return new Response('User-agent: *\nDisallow: /\n', { status: 200 }); };
  const t0 = Date.now();
  try {
    await assert.rejects(designCommand({ _: ['design', 'https://reva-design-gate.invalid/'] }),
      (e) => e.code === 'blocked_robots' && /REVA respects robots\.txt and did not open the page/.test(e.message) && /--ignore-robots/.test(e.message));
  } finally { globalThis.fetch = real; }
  assert.deepEqual(calls, ['https://reva-design-gate.invalid/robots.txt']);
  assert.ok(Date.now() - t0 < 2000, `no browser launch (${Date.now() - t0} ms)`);
});
