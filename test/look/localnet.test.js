// A local look's network: offline by default with every blocked request reported, and an explicit, validated opt-in.
// Own fixtures only (fixtures/look/cdn.html); the "CDN" host cdn.example.test is mapped to loopback by the test hook, so
// nothing here touches a network (every other name resolves to nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveFixture } from '../helpers.js';
import { runLook } from '../../src/look/index.js';
import { formatLook } from '../../src/look/cli.js';
import { localArgs, normalizeAllowNet, KNOWN_CDNS } from '../../src/look/localnet.js';

let srv;
test.before(async () => { srv = await serveFixture('look'); });
test.after(async () => { await srv.close(); });
const look = (o) => runLook({ input: `${srv.origin}/cdn.html`, write: false, design: false, action: 'load', _testHostMap: { 'cdn.example.test': '127.0.0.1' }, ...o });

test('args: the sinkhole keeps loopback and exactly the allowed names; the proxy bypass matches', () => {
  const a = localArgs(['cdn.jsdelivr.net']);
  assert.match(a[0], /^--host-resolver-rules=MAP \* ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127\.0\.0\.1, EXCLUDE \[::1\], EXCLUDE cdn\.jsdelivr\.net$/);
  assert.equal(a[2], '--proxy-bypass-list=localhost;127.0.0.1;[::1];cdn.jsdelivr.net');
  assert.deepEqual(localArgs(), localArgs([]), 'no allowed host: loopback only');
  assert.ok(!/EXCLUDE (?!localhost|127|\[::1\])/.test(localArgs()[0]));
});

test('allow list: plain host names only', () => {
  assert.deepEqual(normalizeAllowNet(['CDN.JSDelivr.net', 'cdn.jsdelivr.net', 'unpkg.com']), ['cdn.jsdelivr.net', 'unpkg.com']);
  for (const bad of ['*', '*.com', 'https://unpkg.com', 'unpkg.com:8080', 'unpkg.com/x', '10.0.0.5', '192.168.1.1', '[::1]', 'a b', 'localhost.', 'user@unpkg.com', 'nodot'])
    assert.throws(() => normalizeAllowNet([bad]), (e) => e.code === 'bad_arguments', bad);
  assert.deepEqual(normalizeAllowNet(['localhost']), [], 'loopback needs no allowing');
  assert.ok(KNOWN_CDNS.every((h) => normalizeAllowNet([h]).length === 1));
});

test('default: the CDN script is blocked, nothing moves, and the output says which host, how many, and how to allow it', async () => {
  const r = await look({});
  assert.equal(r.status, 'no-motion');
  assert.equal(r.network.mode, 'local'); assert.deepEqual(r.network.allowed, []);
  const hosts = Object.fromEntries(r.network.blocked.hosts.map((h) => [h.host, h]));
  assert.ok(hosts['cdn.example.test'] && hosts['cdn.example.test'].count >= 1 && hosts['cdn.example.test'].types.script, JSON.stringify(r.network));
  assert.ok(hosts['fonts.example.test'] && hosts['fonts.example.test'].types.stylesheet, JSON.stringify(r.network));
  const w = r.warnings.find((x) => /were blocked because this is a local look/.test(x));
  assert.ok(w && /cdn\.example\.test ×1 script/.test(w) && /--allow-net cdn\.example\.test,fonts\.example\.test|--allow-net fonts\.example\.test,cdn\.example\.test/.test(w), w);
  assert.match(formatLook(r), /were blocked because this is a local look/, 'the terminal text carries it too');
});

test('--allow-net: the named host loads (the script runs, the box moves); an unnamed host stays blocked and reported', async () => {
  const r = await look({ allowNet: ['cdn.example.test'] });
  assert.equal(r.status, 'motion', JSON.stringify(r.warnings));
  assert.deepEqual(r.network.allowed, ['cdn.example.test']);
  assert.ok(r.network.blocked.hosts.every((h) => h.host !== 'cdn.example.test'), 'the allowed host is not blocked');
  assert.ok(r.network.blocked.hosts.some((h) => h.host === 'fonts.example.test'), 'everything else is still blocked and reported');
  assert.ok(r.warnings.some((x) => /network access for cdn\.example\.test/.test(x)), 'the opening is said out loud: ' + r.warnings.join(' | '));
  assert.ok(r.motions.some((m) => /cdnbox|DIV/.test(m.desc)), r.motions.map((m) => m.desc).join(','));
});

test('usage: --allow-net with a bad name, or on an archive / live source, is refused before any browser starts', async () => {
  await assert.rejects(look({ allowNet: ['https://x.com'] }), (e) => e.code === 'bad_arguments');
  await assert.rejects(runLook({ input: 'https://example.com/', allowNet: ['unpkg.com'], safety: false, write: false, design: false }), (e) => e.code === 'bad_arguments' && /local page/.test(e.message));
});
