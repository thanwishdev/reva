// The scan's cookie-consent hider (src/safety/banner.js, T4 X5): a consent banner is hidden for the whole recording and never
// accepted; a clear reject button may be pressed; announcement bars, navs and the page itself stay. Local fixtures on an own
// loopback server, one headless browser, closed in finally (withBrowser).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { withBrowser } from '../../src/browser/launch.js';
import { CONSENT_HIDE_INIT, CONSENT_WORDS, consentStateInPage, rejectHiddenInPage, mergeConsent } from '../../src/safety/banner.js';
import { clickRejectInPage } from '../../src/safety/consent.js';
import { takeFacts } from '../../src/scan/index.js';

const page = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px sans-serif;height:3000px}
.bar{position:fixed;left:0;right:0;padding:12px;background:#222;color:#fff}.bottom{bottom:0}.top{top:0}
.in{animation:rise .6s ease-out both}@keyframes rise{from{transform:translateY(100%);opacity:0}}</style>${head}</head><body>${body}</body></html>`;
const CLICKS = `<script>window.clicked=[];addEventListener('click',(e)=>{const b=e.target.closest('button,a');if(b)window.clicked.push(b.textContent.trim())},true)</script>`;
const FIXTURES = {
  // a site's own banner with hashed classes, inserted late and animated in; its only choices are Agree and More options
  '/consent.html': page(`<h1>Hello</h1><p>Body text.</p>${CLICKS}<script>setTimeout(()=>{const d=document.createElement('div');d.className='x9Fq2 bar bottom in';
    d.innerHTML='<p>We use cookies to improve your experience. Read our <a href="#">Cookie policy</a>.</p><button>More options</button><button>Agree</button>';
    document.body.append(d)},300)</script>`),
  // a top announcement bar with a close button, and a fixed nav with privacy links: both stay
  '/announce.html': page(`<div class="bar top" id="promo">Envío gratis en pedidos de más de 50 € <button aria-label="Cerrar banner">×</button></div>
    <nav class="bar bottom" style="position:fixed"><a href="/privacy">Privacy</a> <a href="/cookies">Cookie policy</a> <a href="/shop">Shop</a></nav>
    <div class="bar" style="top:60px" id="bakery">Fresh cookies daily, order before noon <button>Shop now</button></div><h1>Store</h1>${CLICKS}`),
  // a banner with a clear reject: hidden, and only "Reject all" is pressed
  '/reject.html': page(`<h1>Shop</h1>${CLICKS}<div class="bar bottom" role="dialog" aria-label="Privacy">This website uses cookies for analytics.
    <button onclick="window.accepted=true">Accept all</button><button onclick="window.rejected=true">Reject all</button></div>`),
  // a known platform's container (OneTrust): hidden by the sheet from the first frame
  '/onetrust.html': page(`<h1>News</h1><div id="onetrust-consent-sdk"><div id="onetrust-banner-sdk" class="bar bottom">Cookies <button id="onetrust-accept-btn-handler">I Accept</button></div></div>`),
  // a smooth-scroll shell: the whole page sits in a fixed layer, its footer talks about cookies; it must stay
  '/shell.html': page(`<div id="shell" style="position:fixed;inset:0;overflow:hidden"><main><h1>Studio</h1><p>Work.</p></main>
    <footer>We use cookies, see our privacy policy. <button>Accept</button></footer></div>`),
  // a banner that locks scroll on body, makes the page root inert and dims the page with a backdrop beside it: all undone
  '/lock.html': page(`<main><h1>Long page</h1><p>Text.</p></main><script>setTimeout(()=>{const k=document.createElement('div');k.id='dim';
    k.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9';const d=document.createElement('div');d.className='bar bottom';d.style.zIndex=10;
    d.innerHTML='We use cookies for analytics. <button>Agree</button>';document.body.append(k,d);document.body.classList.add('noscroll');
    document.body.style.overflow='hidden';document.querySelector('main').inert=true},300)</script>`),
  // the page locks its own scroll from the start (a fixed shell): a banner later does not unlock the page's own lock
  '/ownlock.html': page(`<main><h1>Shell</h1></main><script>document.body.style.overflow='hidden';setTimeout(()=>{const d=document.createElement('div');d.className='bar bottom';
    d.innerHTML='We use cookies for analytics. <button>Agree</button>';document.body.append(d)},600)</script>`),
  // a banner without a lock, then the site's own full-screen menu locks scroll: that lock is the menu's and stays
  '/menu.html': page(`<main><h1>Site</h1></main><div class="bar bottom">This site uses cookies. <button>Accept all</button></div>
    <div id="menu" style="position:fixed;inset:0;background:#fff;display:none">Menu</div>
    <script>setTimeout(()=>{document.getElementById('menu').style.display='block';document.body.style.overflow='hidden'},600)</script>`),
};

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((q, r) => { const b = FIXTURES[q.url.split('?')[0]]; r.writeHead(b ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }); r.end(b || 'no'); });
    s.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((d) => s.close(d)) }));
  });
}

test('consent words: reject is never an accept, controls are whole labels', () => {
  const rx = (k) => new RegExp(CONSENT_WORDS[k], 'i');
  for (const t of ['reject all', 'decline', 'only necessary', 'use necessary cookies only', 'alle ablehnen', 'tout refuser', 'rechazar todo']) assert.ok(rx('reject').test(t), t);
  for (const t of ['accept all', 'agree', 'i accept', 'allow all', 'ok', 'got it', 'accept necessary and reject optional']) assert.ok(!rx('reject').test(t), t);
  for (const t of ['agree', 'more options', 'cookie settings', 'manage preferences', 'accept all cookies', 'reject all']) assert.ok(rx('control').test(t), t);
  for (const t of ['close', 'ok', 'shop now', 'cerrar banner', 'menu']) assert.ok(!rx('control').test(t), t);
});

test('mergeConsent keeps one entry per layer and the first reject', () => {
  let m = mergeConsent(null, { hidden: [{ sel: 'div.a', text: 'We use cookies' }], rejected: [] });
  m = mergeConsent(m, { hidden: [{ sel: 'div.a', text: 'We use cookies' }, { sel: 'div#b', text: 'x' }], rejected: [{ sel: 'div#b', label: 'reject all' }] });
  assert.equal(m.hidden.length, 2); assert.equal(m.rejected.length, 1);
});

test('takeFacts gathers the hidden banners of every take of a page and viewport', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-consent-'));
  try {
    const put = (n, consent) => { const d = path.join(root, 'takes', 'desktop', n); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'take.json'), JSON.stringify({ extra: { consent } })); };
    put('arrive', { hidden: [{ sel: 'div.x9Fq2', why: 'words', cmp: null, text: 'We use cookies', at: 300, box: [0, 800, 1440, 100] }], rejected: [] });
    put('opens', { hidden: [{ sel: 'div.x9Fq2', why: 'words', cmp: null, text: 'We use cookies', at: 310, box: [0, 800, 1440, 100] }], rejected: [{ sel: 'div.x9Fq2', label: 'reject all', at: 900 }] });
    put('patterns', null);
    const f = takeFacts(root, 'desktop');
    assert.equal(f.consent.size, 1);
    const h = [...f.consent.values()][0];
    assert.deepEqual(h.takes.sort(), ['arrive', 'opens']); assert.equal(h.rejected, 'reject all');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('in a real page: banner hidden and never accepted, reject pressed only when clear, its scroll lock / inert / backdrop lifted, bars, nav, page shell and the page\'s own locks kept', async () => {
  const srv = await serve();
  try {
    await withBrowser({ engine: 'chs', context: { viewport: { width: 1000, height: 700 } } }, async ({ page: p, context }) => {
      await context.addInitScript({ content: CONSENT_HIDE_INIT });
      const shown = (sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; }, sel);

      // 1. a late, animated banner whose only choices are Agree / More options: hidden at insertion, nothing pressed
      await p.goto(`${srv.origin}/consent.html`); await p.waitForTimeout(700);
      assert.equal(await shown('.x9Fq2'), false);
      assert.equal(await p.evaluate(() => document.querySelector('.x9Fq2').getAttribute('data-reva-hidden')), 'consent');
      assert.equal(await p.evaluate(rejectHiddenInPage), null, 'no reject button: nothing is pressed');
      assert.deepEqual(await p.evaluate(() => window.clicked), []);
      // hidden in the insertion's own microtask: its entrance animation never started, and the record keeps where it would have been
      assert.equal(await p.evaluate(() => document.querySelector('.x9Fq2').getAnimations().length), 0);
      let st = await p.evaluate(consentStateInPage);
      assert.equal(st.hidden.length, 1); assert.equal(st.hidden[0].why, 'words'); assert.match(st.hidden[0].text, /We use cookies/);
      assert.equal(st.hidden[0].box[2], 1000); assert.ok(st.hidden[0].box[1] > 500, 'a bottom bar');
      assert.equal(await shown('h1'), true);

      // 2. announcement bar, nav with privacy links, a bakery's "cookies" promo: all stay
      await p.goto(`${srv.origin}/announce.html`); await p.waitForTimeout(400);
      for (const s of ['#promo', 'nav', '#bakery']) assert.equal(await shown(s), true, s);
      st = await p.evaluate(consentStateInPage);
      assert.equal(st.hidden.length, 0, JSON.stringify(st.hidden));

      // 3. a clear reject: hidden, "Reject all" pressed once, "Accept all" never
      await p.goto(`${srv.origin}/reject.html`); await p.waitForTimeout(400);
      assert.equal(await shown('[role=dialog]'), false);
      const r = await p.evaluate(rejectHiddenInPage);
      assert.equal(r.label, 'reject all');
      assert.equal(await p.evaluate(rejectHiddenInPage), null, 'once per document');
      assert.deepEqual(await p.evaluate(() => [window.rejected, window.accepted, window.clicked]), [true, undefined, ['Reject all']]);

      // 4. the safety gate's own reject selectors still reach a banner the hider took out
      await p.goto(`${srv.origin}/reject.html`); await p.waitForTimeout(300);
      assert.deepEqual(await p.evaluate(clickRejectInPage, ['text="Reject all"']), ['text="Reject all"']);
      assert.equal(await p.evaluate(() => window.accepted), undefined);

      // 5. a known platform: hidden by the sheet, recorded with its name
      await p.goto(`${srv.origin}/onetrust.html`); await p.waitForTimeout(400);
      assert.equal(await shown('#onetrust-banner-sdk'), false);
      st = await p.evaluate(consentStateInPage);
      assert.ok(st.hidden.some((h) => h.cmp === 'OneTrust'), JSON.stringify(st.hidden));
      assert.equal(await p.evaluate(() => window.clicked), undefined);

      // 7. scroll lock, inert page root and backdrop the banner put up: lifted, and recorded
      await p.goto(`${srv.origin}/lock.html`); await p.waitForTimeout(900);
      assert.equal(await shown('.bar'), false);
      assert.equal(await shown('#dim'), false, 'the backdrop beside the banner is hidden too');
      assert.deepEqual(await p.evaluate(() => [getComputedStyle(document.body).overflowY, document.querySelector('main').inert]), ['visible', false]);
      assert.equal(await p.evaluate(() => { scrollTo(0, 500); return scrollY; }), 500, 'the page scrolls again');
      st = await p.evaluate(consentStateInPage);
      assert.deepEqual(st.unlocked.map((u) => u.kinds.join(' ')).sort(), ['inert', 'overflow']);
      assert.ok(st.hidden.some((h) => h.why === 'backdrop'));
      assert.deepEqual(await p.evaluate(() => window.clicked), undefined);

      // 8. the page's own lock from the start stays (only the banner is hidden)
      await p.goto(`${srv.origin}/ownlock.html`); await p.waitForTimeout(1100);
      assert.equal(await shown('.bar'), false);
      assert.equal(await p.evaluate(() => getComputedStyle(document.body).overflowY), 'hidden');
      assert.equal((await p.evaluate(consentStateInPage)).unlocked.length, 0);

      // 9. the site's own menu locks scroll after the banner was hidden: covered by the menu, so the lock stays
      await p.goto(`${srv.origin}/menu.html`); await p.waitForTimeout(1100);
      assert.equal(await shown('.bar'), false); assert.equal(await shown('#menu'), true);
      assert.equal(await p.evaluate(() => getComputedStyle(document.body).overflowY), 'hidden');
      assert.equal((await p.evaluate(consentStateInPage)).unlocked.length, 0);

      // 6. a fixed shell that holds the whole page (main, h1) and a cookie line in its footer: the page is never hidden
      await p.goto(`${srv.origin}/shell.html`); await p.waitForTimeout(400);
      assert.equal(await shown('#shell'), true);
      assert.equal((await p.evaluate(consentStateInPage)).hidden.length, 0);
    });
  } finally { await srv.close(); }
});
