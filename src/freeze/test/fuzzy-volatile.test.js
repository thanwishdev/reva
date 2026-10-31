// Criterion 3 (26 Oct): two narrow volatile rules, both logged in net.fuzzy. (a) JSONP: a generated callback name is
// volatile and the recorded body's leading call is renamed to the replayed one; (b) Stripe's third-party iframe documents
// carry a fresh uuid `id` per load (b.stripecdn.com/stripethirdparty-srv/ only, uuid values only). `?id=A` vs `?id=B`
// anywhere else stays a miss. The route handler is driven with a fake context: no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { volatileKey, jsonpRewrite, installFuzzyFallback } from '../fuzzy.js';
import { packHarZip } from '../sanitize.js';

function harEntry(url, body, type = 'text/html') {
  return {
    startedDateTime: '2026-10-26T00:00:00.000Z', time: 1, cache: {}, timings: { send: 0, wait: 1, receive: 0 },
    request: { method: 'GET', url, httpVersion: 'HTTP/1.1', headers: [], cookies: [], queryString: [], headersSize: -1, bodySize: 0 },
    response: { status: 200, statusText: '', httpVersion: 'HTTP/1.1', headers: [{ name: 'content-type', value: type }], cookies: [], redirectURL: '', headersSize: -1, bodySize: body.length, content: { size: body.length, mimeType: type, text: body } },
  };
}
const JQ_REC = 'https://go.example.com/index.php/form/getForm?munchkinId=000-AAA-000&form=2089&callback=jQuery37105755703556351364_1792951606941&_=1792951606942';
const JQ_REPLAY = 'https://go.example.com/index.php/form/getForm?munchkinId=000-AAA-000&form=2089&callback=jQuery37105755703556351364_1792951807592&_=1792951807593';
const SC = id => `https://b.stripecdn.com/stripethirdparty-srv/assets/v33.1/PrivacyCompliance.html?id=${id}&origin=https%3A%2F%2Fstripe.com`;
const U1 = '806a0cad-f135-49d7-8ea1-19fdcce72a7d', U2 = 'bd660b28-0c05-4314-9f17-a79c89dfe23e';

test('volatileKey: JSONP callback names and the scoped stripecdn uuid id are volatile; other ids are not', () => {
  assert.equal(volatileKey(JQ_REC), volatileKey(JQ_REPLAY));
  assert.equal(volatileKey('https://x.test/j?callback=__jp3'), volatileKey('https://x.test/j?callback=__jp7'));
  assert.equal(volatileKey('https://x.test/j?jsonp=jsonp12'), volatileKey('https://x.test/j?jsonp=jsonp99'));
  assert.notEqual(volatileKey('https://x.test/j?callback=renderList'), volatileKey('https://x.test/j?callback=renderGrid'), 'a named callback is part of the resource');
  assert.equal(volatileKey(SC(U1)), volatileKey(SC(U2)));
  assert.notEqual(volatileKey(SC('A')), volatileKey(SC('B')), 'not a uuid: stays identity');
  assert.notEqual(volatileKey(`https://b.stripecdn.com/other/x.html?id=${U1}`), volatileKey(`https://b.stripecdn.com/other/x.html?id=${U2}`), 'other path on the host');
  assert.notEqual(volatileKey(`https://shop.example.com/p?id=${U1}`), volatileKey(`https://shop.example.com/p?id=${U2}`), 'other host');
  assert.notEqual(volatileKey('https://shop.example.com/p?id=A'), volatileKey('https://shop.example.com/p?id=B'));
});

test('jsonpRewrite: the leading recorded call is renamed; anything else is not answered', () => {
  const body = Buffer.from('jQuery37105755703556351364_1792951606941({"Id":2089});');
  assert.equal(jsonpRewrite(JQ_REC, JQ_REPLAY, body).toString(), 'jQuery37105755703556351364_1792951807592({"Id":2089});');
  assert.equal(jsonpRewrite(JQ_REC, JQ_REPLAY, Buffer.from('/**/ typeof x === "function" && x({});')), null, 'body does not start with the recorded call');
  const plain = Buffer.from('<html>');
  assert.equal(jsonpRewrite(SC(U1), SC(U2), plain), plain, 'not JSONP: body unchanged');
});

async function fakeRoute(harPath, url) {
  let handler = null;
  const ctx = { route: async (_m, h) => { handler = h; } };
  const log = await installFuzzyFallback(ctx, [harPath]);
  let result = null;
  const route = {
    request: () => ({ url: () => url, method: () => 'GET', postDataBuffer: () => null }),
    fallback: () => { result = { fallback: true }; },
    fulfill: (r) => { result = r; },
  };
  await handler(route);
  return { result, log };
}

test('installFuzzyFallback: JSONP answered with the replayed callback, stripecdn uuid answered, both logged; other ids stay misses', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-fuzzy-'));
  const har = { log: { version: '1.2', creator: { name: 't', version: '1' }, pages: [], entries: [
    harEntry(JQ_REC, 'jQuery37105755703556351364_1792951606941({"Id":2089});', 'application/javascript'),
    harEntry(SC(U1), '<!doctype html><html><body>pc</body></html>'),
    harEntry('https://shop.example.com/p?id=A', 'product A'),
  ] } };
  const harPath = path.join(tmp, 'all.har.zip'); fs.writeFileSync(harPath, packHarZip({ har, files: new Map() }));
  try {
    let { result, log } = await fakeRoute(harPath, JQ_REPLAY);
    assert.equal(result.status, 200);
    assert.equal(Buffer.from(result.body).toString(), 'jQuery37105755703556351364_1792951807592({"Id":2089});');
    assert.deepEqual(log[0].jsonp, { from: 'jQuery37105755703556351364_1792951606941', to: 'jQuery37105755703556351364_1792951807592' });
    ({ result, log } = await fakeRoute(harPath, SC(U2)));
    assert.equal(Buffer.from(result.body).toString(), '<!doctype html><html><body>pc</body></html>');
    assert.equal(log.length, 1); assert.equal(log[0].matched, SC(U1));
    ({ result, log } = await fakeRoute(harPath, 'https://shop.example.com/p?id=B'));
    assert.deepEqual(result, { fallback: true }); assert.equal(log.length, 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
