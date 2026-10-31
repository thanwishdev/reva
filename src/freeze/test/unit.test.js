// No-browser tests of the freeze building blocks. Run: node --test src/freeze/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readZip, writeZip } from '../zip.js';
import { sanitizeHar, mergeHars, parseHarZip, packHarZip } from '../sanitize.js';
import { analyseCompletion, resolveHole, extractTemplates } from '../complete.js';
import { urlToPath } from '../build.js';
import { assertFreezable, isLocalHost, normalizeConfig } from '../config.js';
import { freeze } from '../freeze.js';

test('zip: round trip, deflate and store, deterministic bytes', () => {
  const big = Buffer.from('abc'.repeat(500)), small = Buffer.from('hi');
  const z = writeZip([['a/big.txt', big], ['small', small], ['empty', Buffer.alloc(0)]]);
  const r = readZip(z);
  assert.deepEqual([...r.keys()], ['a/big.txt', 'small', 'empty']);
  assert.ok(r.get('a/big.txt').equals(big) && r.get('small').equals(small) && r.get('empty').length === 0);
  assert.ok(z.equals(writeZip([['a/big.txt', big], ['small', small], ['empty', Buffer.alloc(0)]])), 'same input, same bytes');
  assert.ok(z.length < big.length, 'deflate used');
});

function fakeHar() {
  const mk = (method, url, status, body, post, headers = []) => ({
    request: { method, url, headers: [{ name: 'Cookie', value: 'sid=secret' }, { name: 'Accept', value: '*/*' }], cookies: [{ name: 'sid', value: 'secret' }], ...(post ? { postData: { mimeType: 'application/json', text: '', _file: post.file } } : {}) },
    response: { status, headers, content: body ? { _file: body.file, size: body.data.length } : { size: 0 } },
  });
  const files = new Map([['b1', Buffer.from('doc')], ['b2', Buffer.from('{"ok":1}')], ['p1', Buffer.from('{"v":3}')]]);
  const entries = [
    mk('GET', 'https://x.test/', 200, { file: 'b1', data: 'doc' }, null, [{ name: 'Set-Cookie', value: 'fx=1; Path=/' }]),
    mk('GET', 'https://tel.test/c.js', -1, null),
    mk('GET', 'https://x.test/blockedbutok', 200, null),
    mk('POST', 'https://x.test/api', 200, { file: 'b2', data: '{"ok":1}' }, { file: 'p1' }),
    mk('GET', 'https://x.test/', 304, null), // duplicate, worse
    mk('GET', 'https://x.test/lost', 200, { file: 'gone', data: 'x' }),
  ];
  entries[2].request.url = 'https://tel.test/blockedbutok';
  return { har: { log: { version: '1.2', entries } }, files };
}

test('sanitiser: drops status -1 and blocked, keeps body AND post-body files, redacts, dedupes, reports missing files', () => {
  const s = sanitizeHar(fakeHar(), { block: /tel\.test/ });
  assert.deepEqual(s.har.log.entries.map(e => e.request.method + ' ' + e.request.url), ['GET https://x.test/', 'POST https://x.test/api']);
  assert.equal(s.report.dropped['status-1(blocked)'], 1);
  assert.equal(s.report.dropped['blocked-but-recorded'], 1);
  assert.equal(s.report.dropped['body-file-missing'], 1);
  assert.equal(s.report.duplicates, 1);
  assert.ok(s.files.has('p1') && s.files.has('b1') && s.files.has('b2'), 'request-body file kept (trap 3)');
  assert.equal(s.report.postBodies, 1);
  assert.ok(s.har.log.entries.every(e => e.request.headers.find(h => h.name === 'Cookie').value === '[redacted]' && e.request.cookies.length === 0));
  assert.deepEqual(s.report.setCookieNames, ['fx']);
  assert.equal(s.report.problems.length, 1);
  // pack/parse round trip keeps the files
  const back = parseHarZip(packHarZip(s));
  assert.equal(back.har.log.entries.length, 2);
  assert.ok(back.files.has('p1'));
});

test('mergeHars: one entry per method+url+body, files travel along', () => {
  const a = sanitizeHar(fakeHar(), { block: /tel\.test/ }), b = sanitizeHar(fakeHar(), { block: /tel\.test/ });
  const u = mergeHars([a, b]);
  assert.equal(u.har.log.entries.length, 2);
  assert.ok(u.files.has('p1'));
});

test('urlToPath: safe, deterministic, query hashed, html extension, no traversal', () => {
  assert.equal(urlToPath('http://a.test/'), 'files/a.test/index.html');
  assert.equal(urlToPath('http://a.test:81/home', 'text/html'), 'files/a.test_81/home.html');
  assert.match(urlToPath('http://a.test/x.svg?q=1'), /^files\/a\.test\/x\.svg__q_[0-9a-f]{10}$/);
  assert.equal(urlToPath('http://a.test/a/%2e%2e/b.js'), 'files/a.test/b.js');
  assert.ok(urlToPath('http://a.test/a/..%2f..%2fetc/passwd').split('/').every(p => p !== '..' && p !== '.'), 'no path component can climb');
  assert.ok(urlToPath('http://a.test/' + 'x'.repeat(300) + '.png').split('/').pop().length <= 125);
});

test('hole resolution: arrays, loop bindings, ternaries, call-site arguments, and honest failure', () => {
  const code = `const S = ['a','b']; const imgUrl = (s, w) => \`/i/\${s}-\${w}.png\`;
    function render(){ const w = innerWidth > 5 ? 960 : 320; for (const s of S) imgUrl(s, w); }
    const t = k => '/h-' + k + '.svg'; t(dark ? 'n' : 'd');
    function dyn(x){ return \`/q/\${x}.png\`; } dyn(window.foo);`;
  const tpls = extractTemplates(code);
  assert.equal(tpls.length, 3);
  const r = analyseCompletion({ files: [{ url: 'http://h.test/a.js', contentType: 'text/javascript', text: code }], documentOrigin: 'http://h.test', have: new Set() });
  assert.deepEqual(r.candidates.map(c => new URL(c.url).pathname), ['/h-d.svg', '/h-n.svg', '/i/a-320.png', '/i/a-960.png', '/i/b-320.png', '/i/b-960.png']);
  assert.equal(r.unknown.length, 1);
  assert.match(r.unknown[0].reason, /dyn\(window\.foo\)/);
  assert.equal(r.candidates.every(c => c.provenance === 'inferred'), true);
  // a declared domain turns the unknown into candidates tagged declared
  const d = analyseCompletion({ files: [{ url: 'http://h.test/a.js', contentType: 'text/javascript', text: code }], documentOrigin: 'http://h.test', have: new Set(), domains: { x: ['1', '2'] } });
  assert.equal(d.unknown.length, 0);
  assert.deepEqual(d.candidates.filter(c => c.template.includes('/q/')).map(c => [new URL(c.url).pathname, c.provenance]), [['/q/1.png', 'declared'], ['/q/2.png', 'declared']]);
  assert.match(resolveHole('state.id', '', 0).reason, /runtime expression/);
});

test('completion: literals in css/html resolve against the file, blocked and known URLs are not candidates', () => {
  const r = analyseCompletion({
    files: [
      { url: 'http://h.test/css/s.css', contentType: 'text/css', text: 'a{background:url(../img/x.png)} b{background:url("/img/y.svg")} c{background:url(data:image/png;base64,AAA)}' },
      { url: 'http://h.test/', contentType: 'text/html', text: '<img src="/img/z.jpg" srcset="/img/z-2.jpg 2x, /img/z-3.jpg 3x"><script src="http://tel.test/c.js"></script><a href="/about">x</a>' },
    ],
    documentOrigin: 'http://h.test', have: new Set(['http://h.test/img/z.jpg']), block: /tel\.test/,
  });
  assert.deepEqual(r.candidates.map(c => c.url).sort(), ['http://h.test/img/x.png', 'http://h.test/img/y.svg', 'http://h.test/img/z-2.jpg', 'http://h.test/img/z-3.jpg']);
});

test('live guard: only loopback and reserved test hosts are freezable without --allow-live', async () => {
  assert.ok(isLocalHost('site.fixture.test') && isLocalHost('localhost') && isLocalHost('127.0.0.1') && !isLocalHost('example.com') && !isLocalHost('latest.example.org'));
  assert.throws(() => assertFreezable({ startUrl: 'https://example.com/' }), /live site/);
  assert.deepEqual(assertFreezable({ startUrl: 'https://example.com/' }, { allowLive: true }).live, ['example.com']);
  assert.throws(() => assertFreezable({ startUrl: 'http://a.test/', extraUrls: ['https://cdn.example.net/x.js'] }), /live site/);
  await assert.rejects(freeze({ id: 'x', startUrl: 'https://example.com/' }, { outDir: '/tmp/wr-never' }), /live site/);
  await assert.rejects(freeze({ id: 'x', startUrl: 'http://a.test/' }, { outDir: new URL('../../../out-here', import.meta.url).pathname }), /H2/);
  assert.equal(normalizeConfig({ id: 'a', startUrl: 'http://a.test/' }).classes.A.viewport.width, 1280);
});
