// Probe + behaviour in a real (headless, isolated) browser on pages authored in this file.
// Browser rules (PLAN H1): only through src/browser/launch.js, closed in finally via withBrowser.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { withBrowser } from '../../src/browser/launch.js';
import { runProbe, buildProbeSource, detectLibraries, classifyScrollResponse, librariesSection } from '../../src/libdetect/index.js';

const PAGES = {
  // stand-ins that leave the same run-time traces a library leaves; they are page-authored, not the libraries
  '/traces': `<!doctype html><html class="lenis lenis-smooth"><head><meta charset="utf-8"><title>t</title>
<script src="/vendor/gsap.min.js"></script></head><body>
<div id="a" data-aos="fade-up">a</div><div id="b" data-lenis-prevent>b</div><canvas id="c" width="10" height="10"></canvas>
<lottie-player id="lp"></lottie-player>
<script>
window.lenisVersion = '1.3.26'; window.gsap = { version: '3.12.5' }; window.__THREE__ = '165';
document.getElementById('a')._gsap = { x: 0 }; document.getElementById('b')._gsap = { x: 1 };
document.getElementById('c').setAttribute('data-engine', 'three.js r165');
</script></body></html>`,
  '/plain': `<!doctype html><html><head><meta charset="utf-8"><title>p</title></head><body><div class="card pin-spacer">x</div><script>window.myGlobal = 1;</script></body></html>`,
  // an own exponential-smoothing scroller with a KNOWN time constant (tau = 150 ms), frame-rate independent
  '/lerp': `<!doctype html><html><head><meta charset="utf-8"><title>l</title><style>body{margin:0}#t{height:6000px}</style></head><body><div id="t"></div>
<script>
const TAU = 150; let target = 0, y = 0, last = null; window.__trace = []; window.__lastWheel = null;
addEventListener('wheel', (e) => { e.preventDefault(); target = Math.max(0, Math.min(5000, target + e.deltaY)); window.__lastWheel = performance.now(); }, { passive: false });
function frame(ts) {
  if (last !== null) { const dt = ts - last; y += (target - y) * (1 - Math.exp(-dt / TAU)); scrollTo(0, Math.round(y)); }
  last = ts; window.__trace.push({ t: ts, y: scrollY }); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script></body></html>`,
};

function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (PAGES[u.pathname]) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGES[u.pathname]); }
    else if (u.pathname.startsWith('/vendor/')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('/* empty */'); }
    else { res.writeHead(404); res.end('nf'); }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ origin: `http://localhost:${server.address().port}`, close: () => new Promise(c => server.close(c)) })));
}

test('probe is read-only and allow-listed: source holds no write, no getContext, no eval of page text', () => {
  const src = buildProbeSource();
  assert.doesNotMatch(src, /getContext|setAttribute\(|innerHTML|\.appendChild|eval\(|new Function|addEventListener|\.remove\(/);
  assert.match(src, /libdetect-probe-1/);
});

test('probe finds run-time traces; detection turns them into measured firing + measured versions', async () => {
  const srv = await serve();
  try {
    await withBrowser({ engine: 'chs', context: { viewport: { width: 800, height: 600 } } }, async ({ page }) => {
      await page.goto(srv.origin + '/traces');
      const dom = await runProbe(page);
      assert.ok(dom.classes.includes('lenis') && dom.classes.includes('lenis-smooth'));
      assert.ok(dom.globals.includes('lenisVersion') && dom.globals.includes('gsap') && dom.globals.includes('__THREE__'));
      assert.equal(dom.expandos._gsap, 2);
      assert.deepEqual(dom.engines, ['three.js r165']);
      assert.ok(dom.tags.includes('lottie-player'));
      assert.ok(dom.attrs.includes('data-aos') && dom.attrs.includes('data-lenis-prevent'));
      assert.deepEqual(dom.scripts, [srv.origin + '/vendor/gsap.min.js']);
      assert.deepEqual(dom.versions, { gsap: '3.12.5', lenis: '1.3.26', three: '165' });
      assert.deepEqual(dom.untrusted, ['scripts']);
      // the probe did not mutate the page
      assert.equal(await page.evaluate(() => document.documentElement.className), 'lenis lenis-smooth');

      const r = detectLibraries({ dom });
      const by = Object.fromEntries(r.libraries.map(l => [l.id, l]));
      for (const id of ['lenis', 'gsap', 'three']) { assert.equal(by[id].status, 'detected', id); assert.equal(by[id].firing.state, 'observed', id); assert.equal(by[id].version.provenance, 'measured', id); }
      assert.equal(by.three.version.value, 'r165');
      assert.equal(by.lottie.status, 'probable'); // custom element alone: tag (4) = probable, global/code absent
      assert.ok(librariesSection(r).markdown.includes('observed'));
    });
  } finally { await srv.close(); }
});

test('probe on a plain page: nothing detected beyond a hint; firing for nothing; generic .pin-spacer is not ScrollTrigger', async () => {
  const srv = await serve();
  try {
    await withBrowser({ engine: 'chs', context: { viewport: { width: 800, height: 600 } } }, async ({ page }) => {
      await page.goto(srv.origin + '/plain');
      const dom = await runProbe(page);
      assert.deepEqual(dom.expandos, {}); assert.deepEqual(dom.globals, []);
      const r = detectLibraries({ dom });
      assert.deepEqual(r.libraries.filter(l => l.status !== 'hint').map(l => l.id), []);
    });
  } finally { await srv.close(); }
});

test('behaviour on a real recording: an own exponential scroller with tau = 150 ms is recovered within 20 %, family only', async () => {
  const srv = await serve();
  try {
    await withBrowser({ engine: 'chs', context: { viewport: { width: 800, height: 600 } } }, async ({ page }) => {
      await page.goto(srv.origin + '/lerp');
      await page.mouse.move(200, 200);
      await page.waitForTimeout(300);
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(2200);
      const { trace, lastWheel } = await page.evaluate(() => ({ trace: window.__trace, lastWheel: window.__lastWheel }));
      assert.ok(lastWheel > 0, 'wheel event reached the page');
      const after = trace.filter(s => s.t >= lastWheel);
      assert.ok(after.length > 40, `${after.length} frames after the wheel`);
      const dts = after.slice(1).map((s, i) => s.t - after[i].t).sort((a, b) => a - b);
      const frameMs = dts[Math.floor(dts.length / 2)];
      const c = classifyScrollResponse({ samples: after, inputEndT: lastWheel, frameMs });
      console.log('lerp-fixture', JSON.stringify({ frames: after.length, frameMs: +frameMs.toFixed(2), model: c.model, tauMs: +c.tauMs?.toFixed(1), r2: +c.r2?.toFixed(4) }));
      assert.equal(c.model, 'exp-approach');
      assert.ok(Math.abs(c.tauMs - 150) / 150 < 0.2, `tau ${c.tauMs}`);
      const r = detectLibraries({ modules: [{ id: 'page.html', source: await page.content() }], behaviour: { scrollResponse: { samples: after, inputEndT: lastWheel, frameMs } } });
      assert.deepEqual(r.libraries.filter(l => l.status !== 'hint'), []);
      assert.equal(r.families.find(f => f.family === 'smooth-scroll').state, 'behaviour_only');
    });
  } finally { await srv.close(); }
});
