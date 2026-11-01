// The card title (src/card/title.js): host + path, short and readable; the bundled demo page and local pages by name.
// Pure, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cardTitle, middleEllipsis, readablePath, TITLE_MAX } from '../../src/card/title.js';

test('host + path: no scheme, trailing slash, index.html, query or hash', () => {
  assert.equal(cardTitle({ kind: 'url', url: 'https://reva-cli.pages.dev/examples/spring-press/' }), 'reva-cli.pages.dev/examples/spring-press');
  assert.equal(cardTitle({ kind: 'url', url: 'https://reva-cli.pages.dev/examples/spring-press/index.html?x=1#top' }), 'reva-cli.pages.dev/examples/spring-press');
  assert.equal(cardTitle({ kind: 'url', url: 'https://reva-cli.pages.dev/' }), 'reva-cli.pages.dev');
  assert.equal(cardTitle({ kind: 'url', url: 'https://reva-cli.pages.dev/index.htm' }), 'reva-cli.pages.dev');
  assert.equal(cardTitle({ kind: 'url', url: 'http://example.com:8080/a/b' }), 'example.com:8080/a/b', 'a non-default port stays');
  assert.equal(cardTitle('https://Example.COM/Work'), 'example.com/Work', 'a URL string works too; the host is lower case');
  assert.equal(cardTitle({ kind: 'url', url: 'https://example.com/caf%C3%A9/' }), 'example.com/café', 'decoded');
  assert.equal(cardTitle({ kind: 'archive', startUrl: 'https://studio.example/work/' }), 'studio.example/work', 'an archive by its start URL');
});

test('five example cards on one site are told apart', () => {
  const names = ['spring-press', 'scroll-reveal', 'hover-lift', 'stagger-list', 'page-smooth'];
  const t = names.map((n) => cardTitle({ kind: 'url', url: `https://reva-cli.pages.dev/examples/${n}/` }));
  assert.equal(new Set(t).size, 5);
});

test('long paths are shortened in the middle to about 48 characters', () => {
  const u = 'https://reva-cli.pages.dev/examples/a-very-long-folder-name/and-another-one/final-page-name/';
  const t = cardTitle({ kind: 'url', url: u });
  assert.ok(t.length <= TITLE_MAX, `${t} (${t.length})`);
  assert.ok(t.startsWith('reva-cli.pages.dev/examples/'), t); assert.ok(t.endsWith('final-page-name'), t); assert.equal((t.match(/…/g) || []).length, 1);
  const longHost = cardTitle({ kind: 'url', url: 'https://a-really-long-subdomain-name.some-very-long-company-name.example/x/y' });
  assert.ok(longHost.length <= TITLE_MAX && longHost.endsWith('/x/y'), longHost);
  assert.equal(middleEllipsis('abcdefghij', 5), 'a…hij'); assert.equal(middleEllipsis('short', 48), 'short');
});

test('the bundled demo page is "REVA demo page"; other local pages are "local page" + path', () => {
  assert.equal(cardTitle({ kind: 'url', url: 'http://localhost:51234/index.html', live: false, demo: true }), 'REVA demo page');
  assert.equal(cardTitle({ kind: 'url', url: 'http://127.0.0.1:51234/index.html', demo: true }), 'REVA demo page');
  assert.equal(cardTitle({ kind: 'url', url: 'http://localhost:5173/', live: false }), 'local page');
  assert.equal(cardTitle({ kind: 'url', url: 'http://127.0.0.1:5173/about/?q=1' }), 'local page /about');
  assert.equal(cardTitle({ kind: 'url', url: 'http://[::1]:3000/shop/item' }), 'local page /shop/item');
  assert.equal(cardTitle({ kind: 'url', url: 'http://app.localhost:3000/x' }), 'local page /x');
  assert.equal(cardTitle({ kind: 'url', url: 'file:///home/someone/site/about.html' }), 'local page about.html', 'a file: URL never shows the folder');
  assert.equal(cardTitle({}), 'a local page'); assert.equal(cardTitle(null), 'a local page');
});

test('control and bidi characters never reach the title', () => {
  assert.equal(readablePath('/a%E2%80%AEb/%0Ac'), '/ab/c');
});

test('the card page and the MCP card renderer use the one formatter', async () => {
  const { trimLook } = await import('../../src/card/build.js');
  const L = trimLook({ source: { kind: 'url', url: 'https://reva-cli.pages.dev/examples/spring-press/', live: true }, action: { do: 'load' }, motions: [] }, null);
  assert.equal(L.title, 'reva-cli.pages.dev/examples/spring-press');
  assert.equal(trimLook({ source: { kind: 'url', url: 'http://localhost:4000/index.html', live: false, demo: true }, action: { do: 'load' }, motions: [] }, null).title, 'REVA demo page');
  const tpl = fs.readFileSync(new URL('../../src/card/page/template.html', import.meta.url), 'utf8');
  assert.match(tpl, /function titleOf\(L\) \{[\s\S]{0,200}if \(L\.title\) return L\.title;/);
  const render = fs.readFileSync(new URL('../../src/card/render.js', import.meta.url), 'utf8');
  assert.match(render, /const where = cardTitle\(d\.source\);/);
});
