// Stage D2b (measured on a real site): markup the gate replays into an off-screen `content-visibility: auto` subtree must get
// its layout boxes at the current viewport (Chrome skips layout there, and getBoundingClientRect does not lay out the
// inserted nodes), without the section's remembered intrinsic size changing. Small browser test (~3 s).
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '../../src/browser/launch.js';
import { injectOwned } from '../../src/gate/scriptowned.js';

const PAGE = `<!doctype html><html><head><style>
body { margin: 0 } .spacer { height: 2000px }
section { content-visibility: auto; contain-intrinsic-size: auto 500px; position: relative }
.card { position: absolute; left: 10%; top: 20px; width: 120px; height: 80px }
</style></head><body><div class="spacer"></div><section><div class="box"><div class="card">old</div></div></section></body></html>`;

test('injectOwned lays out replayed nodes inside a skipped content-visibility subtree', { timeout: 60000 }, async () => {
  const h = await launchBrowser({ engine: 'chs', context: { viewport: { width: 600, height: 400 } } });
  try {
    await h.page.setContent(PAGE);
    await h.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const K = 'html/body[1]/section[1]/div[1]';
    const res = await h.page.evaluate(injectOwned, [{ k: K, html: '<div class="card">new</div><div class="card" style="top:120px">two</div>' }]);
    const boxes = await h.page.evaluate(() => [...document.querySelectorAll('.card')].map(c => { const r = c.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), r.width, r.height]; }));
    assert.deepEqual(boxes, [[60, 2020, 120, 80], [60, 2120, 120, 80]]);
    assert.equal(res.cvLaidOut, 1);
    // the override was put back in the same task: no inline style left, section still skipped and at its intrinsic size
    const sec = await h.page.evaluate(() => { const s = document.querySelector('section'); return { style: s.getAttribute('style'), h: s.getBoundingClientRect().height, skipped: !s.firstElementChild.checkVisibility({ contentVisibilityAuto: true }) }; });
    assert.deepEqual(sec, { style: null, h: 500, skipped: true });
  } finally { await h.close(); }
});
