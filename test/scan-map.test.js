// Phase 3 (2 Nov): site map. Every URL listed, shapes and structure clusters, robots-disallowed listed but never fetched.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mapSite, pagesToRecord, pathShape, structureOf } from '../src/scan/map.js';

const layoutA = (t) => `<html><body><header><nav><ul><li>x</li></ul></nav></header><main><section><div><article><h1>${t}</h1></article></div></section></main><footer><div></div></footer></body></html>`;
const layoutB = (t) => `<html><body><div><form><fieldset><table><tbody><tr><td>${t}</td></tr></tbody></table></fieldset></form></div><aside><dl><dt>a</dt></dl></aside></body></html>`;

async function serve() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    const o = `http://127.0.0.1:${srv.address().port}`;
    if (req.url === '/robots.txt') return send(200, 'text/plain', `User-agent: *\nDisallow: /private\nSitemap: ${o}/sitemap.xml\n`);
    if (req.url === '/sitemap.xml') {
      const u = ['/', '/about', '/private/secret', ...Array.from({ length: 30 }, (_, i) => `/posts/p${i}`), ...Array.from({ length: 6 }, (_, i) => `/shop/s${i}`)];
      return send(200, 'application/xml', `<urlset>${u.map((p) => `<url><loc>${o}${p}</loc></url>`).join('')}</urlset>`);
    }
    if (req.url.startsWith('/shop/')) return send(200, 'text/html', layoutB(req.url));
    return send(200, 'text/html', layoutA(req.url) + '<a href="/linked-only">l</a><a href="/file.pdf">f</a>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, hits, origin: `http://127.0.0.1:${srv.address().port}` };
}

test('pathShape and structureOf', () => {
  assert.equal(pathShape('https://a.com/blog/x/y'), '/blog/*/*');
  assert.equal(pathShape('https://a.com/'), '/');
  assert.ok(structureOf(layoutA('x')).size > 3);
});

test('mapSite lists everything, clusters by structure, never fetches a disallowed page', async () => {
  const { srv, hits, origin } = await serve();
  try {
    const m = await mapSite(origin + '/', { gapMs: 0, maxFetch: 20, perShape: 2 });
    const urls = new Set(m.pages.map((p) => p.url));
    assert.ok(urls.has(origin + '/private/secret'), 'disallowed page is listed');
    assert.equal(m.pages.find((p) => p.url.endsWith('/private/secret')).status, 'blocked');
    assert.ok(!hits.some((h) => h.startsWith('/private')), 'disallowed page never requested');
    assert.ok(urls.has(origin + '/linked-only'), 'link-only page is found');
    assert.ok(![...urls].some((u) => u.endsWith('.pdf')), 'files are not pages');
    assert.equal(m.pages.filter((p) => p.url.includes('/posts/')).length, 30);
    assert.equal(m.counts.blocked, 1);
    assert.equal(m.clusters.length, 2, 'article layout and table layout');
    const shop = m.templates.find((t) => t.shape === '/shop/*'); const posts = m.templates.find((t) => t.shape === '/posts/*');
    assert.notEqual(shop.cluster, posts.cluster);
    assert.ok(m.pages.every((p) => p.status === 'blocked' || p.cluster != null), 'unsampled pages follow their shape');
    assert.ok(m.counts.sampled <= 20);
    const rec = pagesToRecord(m); assert.equal(rec.length, 2 + (rec.length > 2 ? rec.length - 2 : 0));
    assert.ok(rec.length <= m.counts.shapes + 1, "at most one page per path shape on a small site");
  } finally { srv.close(); }
});

test('unreadable robots stops the map', async () => {
  const fake = async () => ({ status: 503, text: async () => '', headers: new Headers(), url: 'x' });
  const m = await mapSite('https://example.invalid/', { gapMs: 0, fetchImpl: fake });
  assert.equal(m.robots.unreadable, true); assert.equal(m.pages.length, 0);
});
