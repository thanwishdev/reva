// Unit tests of the preloader wait (C1): the pure verdict, the screenshot colour count and the poll loop on a fake page.
// No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { LOADER_NAME, classifyPreloader, screenStats, waitForPreloader } from '../../src/browser/preloader.js';

const png = (w, h, fill) => { const p = new PNG({ width: w, height: h }); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; const [r, g, b] = fill(x, y); p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255; } return PNG.sync.write(p); };
const realPage = { loaderEls: [], progress: 0, pct: [], bigCanvas: null, words: 400, scrollable: true, readyState: 'complete' };

test('LOADER_NAME matches loader overlays, not "loaded" states or lazy loading', () => {
  for (const s of ['preloader', 'pre-loader', 'js-preloader', 'loader', 'page_loader is-active', 'loading-screen', 'c-splash', 'intro-overlay', 'app progress']) assert.ok(LOADER_NAME.test(s), s);
  for (const s of ['is-loaded', 'loaded', 'lazyload', 'downloader', 'hero', 'uploading-x', 'progressive']) assert.ok(!LOADER_NAME.test(s), s);
});

test('a real page is not loading; a loader overlay is', () => {
  assert.deepEqual(classifyPreloader(realPage), { loading: false, reasons: [] });
  const v = classifyPreloader({ ...realPage, words: 3, scrollable: false, loaderEls: [{ sel: 'div#preloader', cover: 1 }] });
  assert.equal(v.loading, true); assert.match(v.reasons[0], /div#preloader covers 100 %/);
});

test('a counter or a progress bar only counts on a weak page (a "98%" stat in a long page does not hold the capture)', () => {
  assert.equal(classifyPreloader({ ...realPage, pct: ['98%'] }).loading, false);
  assert.equal(classifyPreloader({ ...realPage, progress: 1 }).loading, false);
  assert.match(classifyPreloader({ ...realPage, words: 2, pct: ['37%'] }).reasons[0], /percentage counter "37%"/);
  assert.equal(classifyPreloader({ ...realPage, scrollable: false, progress: 1 }).loading, true);
});

test('a one-colour screen with no words is loading; one colour with words, or a varied screen, is not', () => {
  const blank = { ...realPage, words: 0, scrollable: false, bigCanvas: 1 };
  const v = classifyPreloader(blank, { dominantShare: 0.995 });
  assert.equal(v.loading, true); assert.match(v.reasons[0], /one-colour screen \(100 %\), 0 words, large canvas/);
  assert.equal(classifyPreloader({ ...blank, words: 40 }, { dominantShare: 0.995 }).loading, false);
  assert.equal(classifyPreloader(blank, { dominantShare: 0.6 }).loading, false);
  assert.equal(classifyPreloader(null).loading, false);
});

test('screenStats: dominant colour share of a PNG', () => {
  assert.equal(screenStats(png(64, 40, () => [10, 10, 12])).dominantShare, 1);
  const half = screenStats(png(64, 40, (x) => (x < 32 ? [0, 0, 0] : [255, 255, 255])));
  assert.equal(half.dominantShare, 0.5); assert.equal(half.colours, 2);
});

// fake page: each evaluate() returns the next probe; screenshot() a black or a two-colour PNG; a fake clock moves 500 ms per sleep
function fakePage(probes, { shots = null, failEval = false } = {}) {
  let i = 0, s = 0;
  return {
    evaluate: async () => { if (failEval) throw new Error('Execution context was destroyed'); return probes[Math.min(i++, probes.length - 1)]; },
    screenshot: async () => { const k = shots ? shots[Math.min(s++, shots.length - 1)] : 'black'; return k === 'black' ? png(32, 20, () => [0, 0, 0]) : png(32, 20, (x) => (x < 16 ? [0, 0, 0] : [200, 120, 40])); },
  };
}
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };
const loader = { ...realPage, words: 1, scrollable: false, loaderEls: [{ sel: 'div.loader', cover: 1 }] };

test('waitForPreloader: no loader at the first read returns at once (state none, one poll)', async () => {
  const r = await waitForPreloader(fakePage([realPage]), clock());
  assert.equal(r.state, 'none'); assert.equal(r.polls, 1); assert.equal(r.waitedMs, 0);
});

test('waitForPreloader: a loader that goes away is waited out, then needs 2 clear reads (state cleared)', async () => {
  const r = await waitForPreloader(fakePage([loader, loader, loader, realPage, realPage]), clock());
  assert.equal(r.state, 'cleared'); assert.equal(r.polls, 5); assert.equal(r.waitedMs, 2000);
  assert.match(r.first[0], /div\.loader/); assert.match(r.last[0], /div\.loader/);
});

test('waitForPreloader: a clear read between loader reads restarts the count', async () => {
  const r = await waitForPreloader(fakePage([loader, realPage, loader, realPage, realPage]), clock());
  assert.equal(r.state, 'cleared'); assert.equal(r.polls, 5);
});

test('waitForPreloader: a loader that never goes stops at the cap (state cap) and the caller goes on', async () => {
  const r = await waitForPreloader(fakePage([loader]), { ...clock(), capMs: 3000 });
  assert.equal(r.state, 'cap'); assert.equal(r.waitedMs, 3000); assert.equal(r.polls, 7);
});

test('waitForPreloader: a black screen with no words is waited out until the scene draws (screenshot signal)', async () => {
  const empty = { ...realPage, words: 0, scrollable: false, bigCanvas: 1 };
  const r = await waitForPreloader(fakePage([empty], { shots: ['black', 'black', 'scene', 'scene'] }), clock());
  assert.equal(r.state, 'cleared'); assert.equal(r.polls, 4); assert.match(r.first[0], /one-colour screen/);
});

test('waitForPreloader: a probe that throws (navigation) counts as not loading, never as an error', async () => {
  const r = await waitForPreloader(fakePage([], { failEval: true }), clock());
  assert.equal(r.state, 'none');
});

test('waitForPreloader: with shot false no screenshot is taken', async () => {
  const page = fakePage([{ ...realPage, words: 0, scrollable: false }]); let shots = 0; const orig = page.screenshot; page.screenshot = async () => { shots++; return orig(); };
  const r = await waitForPreloader(page, { ...clock(), shot: false });
  assert.equal(r.state, 'none'); assert.equal(shots, 0);
});
