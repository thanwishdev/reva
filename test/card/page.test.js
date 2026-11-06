// The card page: every plot kind renders with the right plot, no console errors, 390 px has no sideways scroll,
// reduced motion and print behave. Uses REVA's own pinned headless engine (chs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildCardHtml } from '../../src/card/build.js';
import { resolveEngine, MANDATORY_ARGS } from '../../src/browser/engines.js';
import { KINDS } from './looks.js';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-card-page-'));
const cardOf = (name) => { const f = path.join(tmp, name + '.html'); fs.writeFileSync(f, buildCardHtml(KINDS[name])); return f; };

// what the first motion row's panel should show: [data-plot or 'plot', text that its axis carries]
const EXPECT = {
  tween: ['plot', 'ms since the motion began'], declared: ['plot', 'ms after it is triggered'], ramp: ['plot', 'ms since the motion began'],
  spring: ['plot', 'ms since the motion began'], step: ['plot', 'ms around the change'], smoothing: ['plot', 'ms after the target jumps'],
  scrollMap: ['plot', 'page scroll position, px'], pointerMap: ['plot', 'pointer position, px'], wheelMapNegative: ['plot', 'wheel input summed, px'], pin: ['plot', 'page scroll position, px'],
  tweenNamed: ['plot', 'ms since the motion began'], tweenOvershoot: ['plot', 'ms since the motion began'], piecewiseRamp: ['plot', 'ms since the motion began'], tweenUnknownEase: ['plot', 'ms since the motion began'], scrollMapUnknownEdge: ['plot', 'wheel input summed, px'],
  periodic: ['know', null], stagger: ['stagger', 'ms since the first member began'], unknown: ['know', null],
};

test('card page: no local paths, no site strings that could break out of the script', () => {
  for (const name of Object.keys(KINDS)) {
    const html = buildCardHtml(KINDS[name]);
    assert.ok(!html.includes('/nonexistent/take'), name);
    assert.ok(!/(?:src|href)=["']https?:/i.test(html), name + ': the card fetches nothing');
  }
  const html = buildCardHtml({ ...KINDS.tween, warnings: ['</script><script>alert(1)</script>'] });
  assert.equal((html.match(/<\/script>/g) || []).length, (buildCardHtml(KINDS.tween).match(/<\/script>/g) || []).length);
});

test('card page: the file names the page in its <title>, escaped, before any script runs', () => {
  const t = (look) => (buildCardHtml(look).match(/<title>([^<]*)<\/title>/) || [])[1];
  assert.equal(t({ ...KINDS.tween, source: { kind: 'url', startUrl: 'https://example.com/a/b' } }), 'REVA card: example.com/a/b');
  assert.equal(t({ ...KINDS.tween, source: { kind: 'url', startUrl: 'https://example.com/<x>&y' } }).includes('<'), false);
  assert.equal(t({ ...KINDS.tween, source: { kind: 'url', startUrl: 'http://localhost:5173/' } }), 'REVA card: local page');
});

test('card page renders each plot kind in a headless browser', { timeout: 120000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine: ' + e.message); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    for (const name of Object.keys(KINDS)) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage(); const errs = [];
      page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errs.push(m.text()); });
      page.on('pageerror', (e) => errs.push(e.message));
      await page.goto('file://' + cardOf(name)); await page.waitForTimeout(150);
      if (EXPECT[name]) {
        const [plot, ax] = EXPECT[name];
        const r = await page.evaluate(() => { select(0, false); const p = document.querySelector('#mp-0'); const pl = p.querySelector('[data-plot]') || p.querySelector('svg.plot');
          return { plot: pl ? (pl.getAttribute('data-plot') || 'plot') : null, texts: [...p.querySelectorAll('svg.plot text')].map((x) => x.textContent), html: p.innerHTML }; });
        assert.equal(r.plot, plot, name);
        if (ax) assert.ok(r.texts.includes(ax), `${name}: axis "${ax}" in ${JSON.stringify(r.texts.slice(-4))}`);
        assert.ok(!/NaN|undefined|Infinity/.test(r.html), name + ': no NaN in the panel');
        if (plot === 'know') assert.ok(/No curve for this one/.test(r.html) && !/svg class="plot"/.test(r.html), name + ': a reason, not an empty plot');
      }
      if (name === 'empty') assert.ok(/No motion was found/.test(await page.textContent('#overview')));
      if (name === 'declaredOnly') {
        assert.equal(await page.locator('svg[data-plot="declared"]').count(), 1);
        assert.equal(await page.locator('.swc').count(), 2, 'only values that are real colours get a swatch');
        assert.ok(!(await page.evaluate(() => getComputedStyle(document.body).display)).includes('none'), 'site string stayed out of CSS');
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const o = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.equal(o[0], o[1], `${name}: no sideways scroll at 390 px`);
      assert.deepEqual(errs, [], name + ' console');
      await ctx.close();
    }
  } finally { await browser.close(); }
});

test('card page: reduced motion turns replay off; print opens the folds', { timeout: 60000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine'); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage(); await page.goto('file://' + cardOf('spring')); await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => document.querySelector('#mp-0 .pp').disabled), 'Play is off');
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('details')].every((d) => d.open)), true);
    await ctx.close();
  } finally { await browser.close(); }
});

test('card page: a named ease is drawn as that ease; an ease REVA cannot draw is not drawn as a straight line', { timeout: 60000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine'); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    const grab = async (name) => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); await page.goto('file://' + cardOf(name)); await page.waitForTimeout(150);
      const r = await page.evaluate(() => { select(0, false); const p = document.querySelector('#mp-0'); return { html: p.innerHTML, text: p.textContent, pts: (p.querySelector('polyline.curve-line') || { getAttribute: () => null }).getAttribute('points') }; });
      await ctx.close(); return r; };
    // easeOutCubic reaches half-way at 1 - 0.5^(1/3) = 20.6 % of the time: 124 ms of 600, not the 300 ms of a straight line
    const named = await grab('tweenNamed');
    assert.ok(named.pts, 'curve is drawn');
    const xy = named.pts.split(' ').map((q) => q.split(',').map(Number)), x0 = xy[0][0], x1 = xy[xy.length - 1][0], y0 = xy[0][1], y1 = xy[xy.length - 1][1];
    const mid = xy[Math.round(xy.length * 0.25)]; const prog = (y0 - mid[1]) / (y0 - y1);
    assert.ok(Math.abs(prog - (1 - Math.pow(0.75, 3))) < 0.04, `quarter-time progress ${prog.toFixed(3)} follows easeOutCubic (0.578), not 0.25`);
    assert.ok(x1 > x0 && /124/.test(named.text) && !/even pace/.test(named.text), 'half-way tile and sentence follow the ease');
    const unk = await grab('tweenUnknownEase');
    assert.equal(unk.pts, null, 'no curve line for an ease that cannot be drawn');
    assert.ok(/curve not drawn/.test(unk.text) && !/even pace/.test(unk.text), 'says the curve is not drawn');
  } finally { await browser.close(); }
});

test('card page: a scroll or wheel range edge marked unknown is not shown as a plain number', { timeout: 60000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine'); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); await page.goto('file://' + cardOf('scrollMapUnknownEdge')); await page.waitForTimeout(150);
    const r = await page.evaluate(() => { select(0, false); const p = document.querySelector('#mp-0'); return { nums: [...p.querySelectorAll('.num')].map((n) => n.textContent), svg: [...p.querySelectorAll('svg.plot text')].map((x) => x.textContent), all: p.textContent }; });
    const tiles = r.nums.join(' | ');
    assert.ok(/Range[^|]*Not identified/.test(tiles) && /Starts at[^|]*Not identified/.test(tiles), 'tiles say not identified: ' + tiles);
    assert.ok(!/409/.test(tiles) && !/409350/.test(r.svg.join(' ')), 'the unknown number is not stated on the tiles or the plot');
    assert.ok(/where it starts was not identified/.test(r.all), 'sentence does not state the start as a fact');
    assert.ok(r.svg.includes('start not identified'), 'plot labels the edge');
    await ctx.close();
  } finally { await browser.close(); }
});

test('card page: piecewise bezier + ramp + bezier draws finite points, straight ramp, honest wording; minors', { timeout: 90000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine'); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    const open = async (name, w) => { const ctx = await browser.newContext({ viewport: { width: w, height: 900 } }); const page = await ctx.newPage(); const errs = [];
      page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errs.push(m.text()); }); page.on('pageerror', (e) => errs.push(e.message));
      await page.goto('file://' + cardOf(name)); await page.waitForTimeout(150); return { ctx, page, errs }; };
    const pw = await open('piecewiseRamp', 1440);
    const r = await pw.page.evaluate(() => { select(0, false); const p = document.querySelector('#mp-0'); const pts = p.querySelector('polyline.curve-line').getAttribute('points').split(' ').map((q) => q.split(',').map(Number));
      return { pts, html: [...document.querySelectorAll('svg')].map((x) => x.outerHTML).join('') + document.querySelector('#overview').innerHTML + p.innerHTML, text: p.textContent, circles: [...p.querySelectorAll('circle')].map((c) => [c.getAttribute('cx'), c.getAttribute('cy')]), thumbs: [...document.querySelectorAll('.curve svg polyline')].map((x) => x.getAttribute('points')) }; });
    assert.ok(r.pts.length > 100 && r.pts.every((q) => q.every(Number.isFinite)), 'every plotted point is finite');
    assert.ok(!/NaN|Infinity|undefined/.test(r.html), 'no NaN in any svg, the overview or the panel: ' + (/.{60}(NaN|Infinity|undefined).{40}/.exec(r.html) || [''])[0]);
    assert.ok(r.circles.every((c) => c.every((n) => Number.isFinite(+n))), 'marks are finite');
    // the ramp is the middle third: straight (constant slope) between 1/3 and 2/3 of the rise
    const ys = r.pts.map((q) => q[1]), yMax = Math.max(...ys), yMin = Math.min(...ys);
    assert.ok(/straight ramp/.test(r.text) && /2 cubic Bézier curves and 1 straight ramp/.test(r.text), 'names the pieces: ' + r.text.slice(0, 400));
    assert.ok(!/Each is a cubic Bézier;/.test(r.text), 'no longer claims every piece is a cubic Bézier');
    assert.ok(/Counted from the start of the scroll recording/.test(r.text), 'clock is the scroll recording, not the load');
    assert.ok(!/Affects (ty|tx)|\bty\b/.test(r.text), 'channel codes are words');
    assert.ok(yMax > yMin);
    assert.deepEqual(pw.errs, [], 'piecewise console'); await pw.ctx.close();
    // overshooting easing says so
    const ov = await open('tweenOvershoot', 1440);
    assert.ok(/overshoots its end value by \d+ %/.test(await ov.page.evaluate(() => { select(0, false); return document.querySelector('#mp-0 .mhead').textContent; })), 'overshoot is mentioned'); await ov.ctx.close();
    // scroll-only look: no first-screen box, no scrubber, no time ticks; touch targets >= 44 px at 390
    const sc = await open('scrollMap', 390);
    const o = await sc.page.evaluate(() => { select(0, false); const hs = [...document.querySelectorAll('#mp-0 details>summary')].map((s) => s.getBoundingClientRect().height);
      return { mini: !!document.querySelector('#mini'), scrub: !!document.querySelector('#scrub'), ticks: !!document.querySelector('.caxis'), hs, cap: document.querySelector('#overview').textContent }; });
    assert.ok(!o.mini && !o.scrub && !o.ticks, 'scroll-only look hides the clock UI: ' + JSON.stringify([o.mini, o.scrub, o.ticks]));
    assert.ok(o.hs.length === 1 && o.hs.every((h) => h >= 44), 'the Details toggle >= 44 px: ' + o.hs);
    assert.ok(!/page load only/.test(await sc.page.evaluate(() => document.body.innerText)), 'does not say the look recorded the page load'); await sc.ctx.close();
    // a load look keeps the clock UI and says "load"
    const tw = await open('tween', 390);
    // what each number means moved from under the tile to the panel's Details fold
    const o2 = await tw.page.evaluate(() => { select(0, false); return { mini: !!document.querySelector('#mini'), cap: document.querySelector('#mp-0 details.vd').textContent }; });
    assert.ok(o2.mini && /first frame of the page load/.test(o2.cap), 'load look: ' + o2.cap); await tw.ctx.close();
    // the unknown-start label does not run into the "start" axis label
    const un = await open('scrollMapUnknownEdge', 1440);
    const bb = await un.page.evaluate(() => { select(0, false); const ts = [...document.querySelectorAll('#mp-0 svg.plot text')]; const a = ts.find((x) => x.textContent === 'start').getBoundingClientRect(), b = ts.find((x) => x.textContent === 'start not identified').getBoundingClientRect();
      return { aR: a.right, bL: b.left, aT: a.top, aB: a.bottom, bT: b.top, bB: b.bottom }; });
    assert.ok(bb.bL >= bb.aR - 0.5 || bb.bT >= bb.aB || bb.bB <= bb.aT, 'labels do not overlap: ' + JSON.stringify(bb)); await un.ctx.close();
  } finally { await browser.close(); }
});

// look.json "screens" (end screen, whole page) and a kind "gl" motion: the newer look's data paths
test('card page: screens are inlined; the end screen sits under the replay; a gl motion is a normal motion; a scroll look shows the whole page', { timeout: 60000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine'); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    // two small JPEGs made by the engine itself
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-card-screens-'));
    { const ctx = await browser.newContext({ viewport: { width: 32, height: 20 } }); const p = await ctx.newPage(); await p.setContent('<body style="margin:0;background:#4a6"></body>');
      await p.screenshot({ path: path.join(dir, 'screen-end.jpg'), type: 'jpeg', quality: 50 }); await p.screenshot({ path: path.join(dir, 'page.jpg'), type: 'jpeg', quality: 50 }); await ctx.close(); }
    const gl = { rank: { score: 0.1, why: ['a canvas that changes'] }, kind: 'gl', desc: 'canvas.webgl', selector: 'canvas.webgl', box: { x: 800, y: 400, w: 400, h: 300 }, count: 1, weightShare: 0.1, channels: ['gl:uTime'],
      lines: [{ kind: 'periodic', label: 'measured', text: 'WebGL uniform uTime repeats [measured]', channels: ['gl:uTime'], values: [{ name: 'period', value: 1000, unit: 'ms', label: 'measured' }] }, { kind: 'unknown', label: 'unknown', text: 'values inside the canvas not measured [unknown]', channels: [] }], records: [], exports: [] };
    const screens = { viewport: { file: 'screen-end.jpg', w: 1440, h: 900, scrollY: 1200, dpr: 1 }, before: null, page: { file: 'page.jpg', w: 1440, h: 4000, scale: 1 } };
    const load = { ...KINDS.tween, dir, motions: [...KINDS.tween.motions, gl], screens: { ...screens, page: null } };
    const scroll = { ...KINDS.scrollMap, dir, screens };
    const html = buildCardHtml(load);
    assert.ok(html.includes('data:image/jpeg;base64,'), 'end screen inlined');
    assert.ok(!html.includes(dir), 'no local paths');
    for (const [name, look] of [['load', load], ['scroll', scroll]]) for (const w of [1440, 390]) {
      const f = path.join(tmp, 'screens-' + name + '.html'); fs.writeFileSync(f, buildCardHtml(look));
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 } }); const page = await ctx.newPage(); const errs = [];
      page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errs.push(m.text()); }); page.on('pageerror', (e) => errs.push(e.message));
      await page.goto('file://' + f); await page.waitForTimeout(150);
      const r = await page.evaluate(() => ({ mini: (document.querySelector('#mini') || { getAttribute: () => '' }).getAttribute('style'), pv: !!document.querySelector('#pageview .pvin'),
        secs: [...document.querySelectorAll('main > section.block')].map((s) => s.id), nav: [...document.querySelectorAll('#secnav a:not(.sub)')].map((a) => a.textContent),
        gl: [...document.querySelectorAll('.mi')].map((b) => ({ n: b.textContent.trim(), thumb: !!b.querySelector('.tc'), title: b.title })).find((x) => /WebGL/.test(x.n)),
        sw: [document.documentElement.scrollWidth, document.documentElement.clientWidth] }));
      assert.deepEqual(r.secs, ['overview', 'motion', 'timeline', 'design', 'libraries', 'recording']);
      assert.deepEqual(r.nav, ['Overview', 'Motion', 'Timeline', 'Design', 'Libraries', 'Recording']);
      if (name === 'load') {
        assert.ok(/url\(/.test(r.mini), 'the end screen is the replay background');
        assert.ok(r.gl && r.gl.thumb && /Ranked here: a canvas that changes/.test(r.gl.title), 'gl motion in the picker with a canvas thumbnail, rank on hover: ' + JSON.stringify(r.gl));
      } else assert.ok(r.pv, 'a scroll look with a page picture shows the whole page');
      assert.equal(r.sw[0], r.sw[1], `${name} ${w}: no sideways scroll`);
      assert.deepEqual(errs, [], name + ' console');
      await ctx.close();
    }
  } finally { await browser.close(); }
});

// one page on screen at a time, a hash per page: deep links, back / forward, the search box, print shows every page
test('card page: separate pages with a hash each; deep link, back and forward, search, print', { timeout: 60000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine'); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    const look = { ...KINDS.tween, motions: [...KINDS.tween.motions, ...KINDS.spring.motions] };
    const f = path.join(tmp, 'routes.html'); fs.writeFileSync(f, buildCardHtml(look));
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    const shown = () => page.evaluate(() => [...document.querySelectorAll('main > section.view')].filter((s) => !s.hasAttribute('hidden')).map((s) => s.id));
    const cur = () => page.evaluate(() => document.querySelector('#secnav a[aria-current="page"]:not(.sub)').dataset.s);
    await page.goto('file://' + f + '#motion/1'); await page.waitForTimeout(150);
    assert.deepEqual(await shown(), ['motion'], 'deep link opens only the Motion page');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.mpanel')].filter((p) => !p.hasAttribute('hidden')).map((p) => p.dataset.i).join()), '1', 'motion 1 on screen');
    assert.equal(await cur(), 'motion');
    await page.click('#secnav a[data-s="timeline"]'); await page.waitForTimeout(100);
    assert.deepEqual(await shown(), ['timeline']); assert.equal(await cur(), 'timeline');
    await page.goBack(); await page.waitForTimeout(100);
    assert.deepEqual(await shown(), ['motion'], 'back returns to Motion');
    await page.goForward(); await page.waitForTimeout(100);
    assert.deepEqual(await shown(), ['timeline'], 'forward returns to Timeline');
    await page.evaluate(() => { location.hash = 'design-colour'; }); await page.waitForTimeout(100);
    assert.deepEqual(await shown(), ['design'], 'an older in-page anchor lands on its page');
    // the search box finds text on a page that is not on screen and opens it
    await page.keyboard.press('/'); await page.fill('#findq', 'Curves and durations');
    assert.ok(await page.locator('#findres button').count() >= 1, 'search finds the Timeline text');
    await page.keyboard.press('Enter'); await page.waitForTimeout(100);
    assert.deepEqual(await shown(), ['timeline'], 'search result opens its page');
    assert.equal(await page.evaluate(() => location.hash), '#timeline');
    // print: every page, in order
    await page.emulateMedia({ media: 'print' });
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('main > section.view')].filter((s) => getComputedStyle(s).display !== 'none' && s.getBoundingClientRect().height > 0).map((s) => s.id)), ['overview', 'motion', 'timeline', 'design', 'libraries', 'recording']);
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally { await browser.close(); }
});

// the Overview replay moves each element's own pixels by its measured model: a press that sinks to 0.92 and springs back
// to 1 (two declared lines, the crop is the button at rest) shrinks and returns; a group with member boxes moves each
// member on its own measured offset
test('card page: the Overview replay moves the crop by every timed line, relative to the crop; group members on their own offsets', { timeout: 60000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine'); }
  const { PNG } = require('pngjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-card-replay-'));
  fs.mkdirSync(path.join(dir, 'crops'));
  const png = (w, h) => { const p = new PNG({ width: w, height: h }); p.data.fill(80); return PNG.sync.write(p); };
  fs.writeFileSync(path.join(dir, 'crops', 'm1.png'), png(18, 7)); fs.writeFileSync(path.join(dir, 'crops', 'm2.png'), png(60, 30));
  const css = (a, b) => `.el { transform: ${a}; transition: transform 120ms cubic-bezier(0.25, 1, 0.5, 1); }\n.el.to { transform: ${b}; }`;
  const box = { x: 600, y: 500, w: 180, h: 72 };
  const press = { rank: 1, kind: 'element', desc: 'BUTTON.press', selector: 'button.press', box, count: 1, weightShare: 0.2, channels: ['ren:sx', 'ren:sy'],
    lines: [{ text: 'CSS transition: 120 ms [exact], cubic-bezier(0.25, 1, 0.5, 1) [exact], scale 1 → 0.92 [exact]', kind: 'declared', family: 'declared:css', label: 'exact', channels: ['ren:sx', 'ren:sy'], t0: 1000, times: 1, values: [{ name: 'duration', value: 120, unit: 'ms', label: 'exact' }] },
      { text: 'CSS transition: 900 ms [exact], linear(0, 1.16 35%, 0.97 70%, 1) [exact], scale 0.92 → 1 [exact]', kind: 'declared', family: 'declared:css', label: 'exact', channels: ['ren:sx', 'ren:sy'], t0: 1300, times: 1, values: [{ name: 'duration', value: 900, unit: 'ms', label: 'exact' }] }],
    records: [], exports: ['ren:sx', 'ren:sy'].map((c) => ({ channel: c, family: 'declared:css', kind: 'tween', model: { duration_ms: 120 }, exports: [{ lib: 'css', code: css('none', 'scale(0.92)') }] })),
    position: { viewport: { width: 1440, height: 900 }, start: { ...box, t: 990, scroll: { x: 0, y: 0 } }, end: { ...box, t: 2200, scroll: { x: 0, y: 0 } }, image: { path: 'crops/m1.png', box, visible: 'full', matchesEnd: true } } };
  const lines = [0, 1, 2].map((k) => ({ x: 100, y: 200 + k * 40, w: 300, h: 40 }));
  const ty = { channel: 'ren:ty', family: 'declared:css', kind: 'tween', model: {}, exports: [{ lib: 'css', code: '.el { transform: translateY(36px); }\n.el.to { transform: translateY(0px); }' }] };
  const group = { rank: 2, kind: 'group', desc: 'SPAN.ln', selector: 'span.ln', box: lines[0], count: 3, weightShare: 0.1, channels: ['ren:ty'],
    lines: [{ text: 'CSS animation: 600 ms [exact], ease-out [exact], y 36 → 0 [exact]', kind: 'declared', family: 'declared:css', label: 'exact', channels: ['ren:ty'], t0: 100, times: 1, values: [{ name: 'duration', value: 600, unit: 'ms', label: 'exact' }, { name: 'easing', value: 'ease-out', label: 'exact' }] }],
    records: [], exports: [ty],
    position: { viewport: { width: 1440, height: 900 }, start: { ...lines[0], y: 236, t: 90 }, end: { ...lines[0], t: 900 },
      group: { members: 3, withBox: 3, start: { x: 100, y: 236, w: 300, h: 120, t: 90 }, end: { x: 100, y: 200, w: 300, h: 120, t: 900 },
        boxes: lines.map((b, k) => ({ start: { ...b, y: b.y + 36 }, last: b, dt: k * 90 })) },
      image: { path: 'crops/m2.png', box: { x: 100, y: 200, w: 300, h: 120 }, visible: 'full', matchesEnd: true } } };
  const look = { ...KINDS.tween, action: { do: 'click', el: '.press' }, dir, motions: [press, group] };
  const f = path.join(tmp, 'replay.html'); fs.writeFileSync(f, buildCardHtml(look));
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('file://' + f); await page.waitForTimeout(150);
    const at = (T) => page.evaluate((T) => { stopPlay(); setT(T); const px = document.querySelector('#mini .mb[data-i="0"] .px');
      return { press: px && px.style.transform, members: [...document.querySelectorAll('#mini .mb[data-i="1"] .gm')].map((g) => g.style.transform) }; }, T);
    const sc = (tr) => { const m = /scale\(([\d.]+)/.exec(tr || ''); return m ? +m[1] : 1; };
    assert.equal(sc((await at(900)).press), 1, 'at rest before the press');
    assert.ok(Math.abs(sc((await at(1250)).press) - 0.92) < 0.002, 'sunk to 0.92 after the press');
    assert.ok(sc((await at(1300 + 900 * 0.35)).press) > 1.005, 'springs past 1 on the release');
    assert.equal(sc((await at(2400)).press), 1, 'back at rest: the crop shows the button at rest');
    const mid = await at(100 + 45);   // the first member has started, the third has not
    assert.equal(mid.members.length, 3, 'one slice per member');
    const dy = (tr) => { const m = /translate\([^,]+,\s*(-?[\d.]+)%/.exec(tr || ''); return m ? +m[1] : 0; };
    assert.ok(dy(mid.members[0]) < dy(mid.members[2]) && dy(mid.members[2]) === 90, 'members start one after another: ' + mid.members.join(' | '));
    assert.ok((await at(2400)).members.every((tr) => !tr), 'members end where the crop shows them');
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally { await browser.close(); }
});

test('card page: a multi-channel CSS export is one rule, and pasted into a real page both channels animate', { timeout: 60000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine: ' + e.message); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + cardOf('declaredTwo')); await page.waitForTimeout(150);
    const css = await page.evaluate(() => { select(0, false); return [...document.querySelectorAll('#mp-0 .codepane[data-lib=css] pre')].map((x) => x.textContent); });
    assert.equal(css.length, 1, 'one snippet for the two channels');
    assert.equal((css[0].match(/transition:/g) || []).length, 1, 'transition is set once');
    const how = await page.evaluate(() => document.querySelector('#mp-0 .codepane[data-lib=css]').textContent);
    assert.ok(/add \.to to start it/.test(how), 'says how to start it');
    // the pasted CSS in a real page: halfway through, both the transform and the opacity are between start and end
    const q = await browser.newPage();
    await q.setContent(`<style>${css[0]}</style><div class="el" style="width:50px;height:50px">x</div>`);
    await q.evaluate(() => document.querySelector('.el').getBoundingClientRect());
    await q.evaluate(() => document.querySelector('.el').classList.add('to'));
    await q.waitForTimeout(450);   // 150 ms delay + 300 ms into the 900 ms move
    const mid = await q.evaluate(() => { const c = getComputedStyle(document.querySelector('.el')); return { ty: new DOMMatrix(c.transform).m42, op: +c.opacity, tp: c.transitionProperty }; });
    assert.ok(mid.ty > 0.5 && mid.ty < 31.5, `translateY is mid-flight: ${mid.ty}`);
    assert.ok(mid.op > 0.05 && mid.op < 0.95, `opacity is mid-flight: ${mid.op}`);
    assert.ok(/opacity/.test(mid.tp) && /transform/.test(mid.tp), mid.tp);
  } finally { await browser.close(); }
});

test('card page: one clock - Delay is the declared wait, hover and click cards say what started the motion, exact travel is not called fitted', { timeout: 60000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine: ' + e.message); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  const tiles = (page) => page.evaluate(() => { select(0, false); const e = document.querySelector('#mp-0'); return { nums: [...e.querySelectorAll('.num')].map((x) => x.textContent), say: e.querySelector('.mhead').textContent, text: e.textContent }; });
  try {
    // load: the tile is the declared wait (150 ms), not the recording-clock start (158.3 ms)
    const decl = { ...KINDS.declaredTwo, motions: [{ ...KINDS.declaredTwo.motions[0], lines: [{ ...KINDS.declaredTwo.motions[0].lines[0], text: 'CSS animation: 900 ms [exact], delay 150 ms [exact], y 32 → 0 [exact], opacity 0 → 1 [exact]', rel: 158.3 }] }] };
    const f1 = path.join(tmp, 'one-clock-load.html'); fs.writeFileSync(f1, buildCardHtml(decl));
    const page = await browser.newPage(); await page.goto('file://' + f1); await page.waitForTimeout(150);
    let r = await tiles(page);
    assert.ok(r.nums.some((x) => /^150msDelay/.test(x)), 'Delay 150 ms: ' + JSON.stringify(r.nums));
    assert.ok(!r.nums.some((x) => /Starts at/.test(x)), 'no second clock in the tiles');
    assert.ok(/Starts at, on the page clock/.test(r.text), 'the page-clock start is named in Details');
    assert.ok(/Start and end values are read from the keyframes/.test(r.text) && !/Start and end values are fitted/.test(r.text), 'exact travel is not called fitted');
    // hover: the lag after the hover, from line.rel
    const hov = { ...decl, action: { do: 'hover', el: '#c', on: null }, motions: [{ ...decl.motions[0], lines: [{ ...decl.motions[0].lines[0], rel: 8.3, trigger: 'reacts to the pointer', t0: 941.7 }] }] };
    const f2 = path.join(tmp, 'one-clock-hover.html'); fs.writeFileSync(f2, buildCardHtml(hov));
    await page.goto('file://' + f2); await page.waitForTimeout(150);
    r = await tiles(page);
    assert.ok(/Starts 8 ms after the hover/.test(r.say), r.say);
    assert.ok(/Starts at, on the recording clock/.test(r.text) && /941/.test(r.text), 'recording clock named');
    // click: the phase, not a bare number
    const clk = { ...hov, action: { do: 'click', el: '.k', on: '#t' }, motions: [{ ...hov.motions[0], lines: [{ ...hov.motions[0].lines[0], rel: 625, trigger: 'starts on release (the click)' }] }] };
    const f3 = path.join(tmp, 'one-clock-click.html'); fs.writeFileSync(f3, buildCardHtml(clk));
    await page.goto('file://' + f3); await page.waitForTimeout(150);
    r = await tiles(page);
    assert.ok(/Starts when the button is released/.test(r.say), r.say);
  } finally { await browser.close(); }
});

test('card page: honest wording - count what was measured, who recorded it, libraries lead, timeline order, extrapolated values, plurals', { timeout: 60000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine: ' + e.message); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  const open = async (look, name, hash = '') => { const f = path.join(tmp, name + '.html'); fs.writeFileSync(f, buildCardHtml(look)); const page = await browser.newPage(); await page.goto('file://' + f + hash); await page.waitForTimeout(150); return page; };
  const other = (i) => ({ rank: 10 + i, desc: `SPAN.s${i}`, selector: `span.s${i}`, box: { x: 0, y: 0, w: 20, h: 20 }, weightShare: 0.01 });
  try {
    // 3 smaller movers beside 2 measured rows: the headline says what was measured and how many more moved
    const two = KINDS.tween.motions[0];
    const look = { ...KINDS.tween, motions: [two, { ...two, rank: 2, desc: 'P.lede', selector: 'p.lede' }], others: [other(1), other(2), other(3)], source: { kind: 'url', url: 'https://example.com/', live: true },
      libraries: { ok: true, list: [], scanned: { scripts: 3, inline: 0, bytes: 10, dom: 1, skipped: [{ reason: 'too large' }] } }, read: null };
    let page = await open(look, 'honest-a');
    const sum = await page.textContent('.sum');
    assert.ok(/measured the 2 largest of 5 moving things/.test(sum) && !/^On load, 2 elements move/.test(sum), sum);
    assert.ok(/The live site/.test(await page.textContent('.facts')) && !/A local page/.test(await page.textContent('.facts')), 'a live URL is not "a local page"');
    assert.ok(/1 script was not read/.test(await page.evaluate(() => { renderRecording(); return document.querySelector('#recording').textContent; })), 'one script, not "1 scripts"');
    const lead = await page.evaluate(() => { renderLibraries(); return document.querySelector('#libraries .lead').textContent; });
    assert.ok(/found no motion library/.test(lead) && !/None of them/.test(lead), lead);
    assert.equal(await page.evaluate(() => [plu(1, 'element'), plu(2, 'element'), plu(1, 'script was', 'scripts were')].join('|')), '1 element|2 elements|1 script was');
    // a page on this computer and the bundled demo say so
    page = await open({ ...look, source: { kind: 'url', url: 'http://localhost:5000/x', live: false } }, 'honest-b');
    assert.ok(/A page on this computer/.test(await page.textContent('.facts')));
    page = await open({ ...look, source: { kind: 'url', url: 'http://localhost:5000/x', live: false, demo: true } }, 'honest-c');
    assert.ok(/REVA.s own demo page/.test(await page.textContent('.facts')));
    // hover: settled time counts from the hover, not from the recording start
    const hov = { ...KINDS.tween, action: { do: 'hover', el: '#c', on: null }, motions: [{ ...two, lines: [{ ...two.lines[0], t0: 940, rel: 8 }] }] };
    page = await open(hov, 'honest-d');
    const hs = await page.textContent('.sum');
    assert.ok(/settled 0\.6 s after the pointer arrives/.test(hs), hs);   // 600 ms duration + 8 ms lag, not 1.5 s
    // the timeline sentence names the row that is first in the rows (a no-curve row placed by when its pixels changed)
    const early = { ...KINDS.unknown.motions[0], rank: 2, desc: 'P.lede', selector: 'p.lede', position: { viewport: { w: 1440, h: 900 }, start: { x: 0, y: 0, w: 10, h: 10, t: 100 }, end: { x: 0, y: 0, w: 10, h: 10, t: 300 }, group: null, image: null } };
    page = await open({ ...KINDS.tween, motions: [{ ...two, desc: 'H1', lines: [{ ...two.lines[0], t0: 400 }] }, early] }, 'honest-e');
    const ch = await page.evaluate(() => choreoSentence());
    assert.ok(/^Lede paragraph starts first/.test(ch), ch);
    // values past anything real are not stated: opacity stays in 0..1, a million px is not "rises 1559484 px"
    const far = (ch1, from, to) => ({ ...KINDS.unknown, motions: [{ ...KINDS.unknown.motions[0], channels: [ch1], exports: [{ channel: ch1, family: 'x', kind: 'tween', model: { from, to }, exports: [] }] }] });
    page = await open(far('ren:opacity', 0, -0.36), 'honest-f');
    let say = await page.evaluate(() => M[0].sentence + ' ' + M[0].say);
    assert.ok(!/-0\.36/.test(say), say);
    page = await open(far('ren:ty', 0, -1559484), 'honest-g');
    say = await page.evaluate(() => M[0].sentence + ' ' + M[0].say);
    assert.ok(!/1559484/.test(say) && /[Rr]ises/.test(say), say);
    // a raw fitter reason is put in plain words
    page = await open({ ...KINDS.unknown, motions: [{ ...KINDS.unknown.motions[0], lines: [{ ...KINDS.unknown.motions[0].lines[0], text: 'moves, but no model explains it [unknown]: 7 moving frames (< 8) (to resolve: record longer)' }] }] }, 'honest-h');
    const rec = await page.evaluate(() => { renderRecording(); return document.querySelector('#recording').textContent; });
    assert.ok(/moved in only 7 recorded frames, and REVA needs at least 8/.test(rec) && !/to resolve/.test(rec), 'plain reason');
  } finally { await browser.close(); }
});

// one replay: the Motion stage is a camera on the Overview's engine. A press shows its release, a group plays member by member,
// a fade-out is never an empty box, and the first screen holds the replay, the curve and the numbers.
test('card page: the Motion stage plays the Overview engine: phases, members, stand-ins; never above real size', { timeout: 60000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine: ' + e.message); }
  const { PNG } = require('pngjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-card-cam-'));
  fs.mkdirSync(path.join(dir, 'crops'));
  const png = (w, h) => { const p = new PNG({ width: w, height: h }); p.data.fill(80); return PNG.sync.write(p); };
  fs.writeFileSync(path.join(dir, 'crops', 'a.png'), png(18, 7)); fs.writeFileSync(path.join(dir, 'crops', 'b.png'), png(60, 30));
  const css = (a, b) => `.el { transform: ${a}; transition: transform 120ms cubic-bezier(0.25, 1, 0.5, 1); }\n.el.to { transform: ${b}; }`;
  const box = { x: 600, y: 500, w: 180, h: 72 };
  const press = { rank: 1, kind: 'element', desc: 'BUTTON.press', selector: 'button.press', box, count: 1, weightShare: 0.2, channels: ['ren:sx', 'ren:sy'],
    lines: [{ text: 'CSS transition: 120 ms [exact], cubic-bezier(0.25, 1, 0.5, 1) [exact], scale 1 → 0.92 [exact]', kind: 'declared', family: 'declared:css', label: 'exact', channels: ['ren:sx', 'ren:sy'], trigger: 'starts on press (button held down)', t0: 1000, times: 1, values: [{ name: 'duration', value: 120, unit: 'ms', label: 'exact' }] },
      { text: 'CSS transition: 900 ms [exact], linear(0, 1.16 35%, 0.97 70%, 1) [exact], scale 0.92 → 1 [exact]', kind: 'declared', family: 'declared:css', label: 'exact', channels: ['ren:sx', 'ren:sy'], trigger: 'starts on release (the click)', t0: 1300, times: 1, values: [{ name: 'duration', value: 900, unit: 'ms', label: 'exact' }] }],
    records: [], exports: ['ren:sx', 'ren:sy'].map((c) => ({ channel: c, family: 'declared:css', kind: 'tween', model: { duration_ms: 120 }, exports: [{ lib: 'css', code: css('none', 'scale(0.92)') }] })),
    position: { viewport: { width: 1440, height: 900 }, start: { ...box, t: 990, scroll: { x: 0, y: 0 } }, end: { ...box, t: 2200, scroll: { x: 0, y: 0 } }, image: { path: 'crops/a.png', box, visible: 'full', matchesEnd: true } } };
  const rows = [0, 1, 2].map((k) => ({ x: 100, y: 200 + k * 40, w: 300, h: 40 }));
  const ty = { channel: 'ren:ty', family: 'declared:css', kind: 'tween', model: {}, exports: [{ lib: 'css', code: '.el { transform: translateY(36px); }\n.el.to { transform: translateY(0px); }' }] };
  const group = { rank: 2, kind: 'group', desc: 'SPAN.ln', selector: 'span.ln', box: rows[0], count: 3, weightShare: 0.1, channels: ['ren:ty'], stagger: { n: 3, values: [{ name: 'interval', value: 90, unit: 'ms' }] },
    lines: [{ text: 'CSS animation: 600 ms [exact], cubic-bezier(0.22, 1, 0.36, 1) [exact], y 36 → 0 [exact]', kind: 'declared', family: 'declared:css', label: 'exact', channels: ['ren:ty'], t0: 190, times: 1, values: [{ name: 'duration', value: 600, unit: 'ms', label: 'exact' }, { name: 'easing', value: 'cubic-bezier(0.22, 1, 0.36, 1)', label: 'exact' }] }],
    records: [], exports: [ty],
    position: { viewport: { width: 1440, height: 900 }, start: { ...rows[0], y: 236, t: 90 }, end: { ...rows[0], t: 900 },
      group: { members: 3, withBox: 3, start: { x: 100, y: 236, w: 300, h: 120, t: 90 }, end: { x: 100, y: 200, w: 300, h: 120, t: 900 }, boxes: rows.map((b, k) => ({ start: { ...b, y: b.y + 36 }, last: b, dt: (k - 1) * 90 })) },
      image: { path: 'crops/b.png', box: { x: 100, y: 200, w: 300, h: 120 }, visible: 'full', matchesEnd: true } } };
  const fade = { rank: 3, kind: 'element', desc: 'DIV.step', selector: 'div.step', box: { x: 200, y: 600, w: 300, h: 80 }, count: 1, weightShare: 0.1, channels: ['ren:opacity'],
    lines: [{ text: 'CSS transition: 300 ms [exact], ease [exact], opacity 1 → 0 [exact]', kind: 'declared', family: 'declared:css', label: 'exact', channels: ['ren:opacity'], t0: 100, times: 1, values: [{ name: 'duration', value: 300, unit: 'ms', label: 'exact' }, { name: 'easing', value: 'ease', label: 'exact' }] }],
    records: [], exports: [{ channel: 'ren:opacity', family: 'declared:css', kind: 'tween', model: {}, exports: [{ lib: 'css', code: '.el { opacity: 1; transition: opacity 300ms ease; }\n.el.to { opacity: 0; }' }] }],
    position: { viewport: { width: 1440, height: 900 }, start: { x: 200, y: 600, w: 300, h: 80, t: 100 }, end: { x: 200, y: 600, w: 300, h: 80, t: 400 }, image: { path: null, box: { x: 200, y: 600, w: 300, h: 80 }, reason: 'hidden' } } };
  const f = path.join(tmp, 'camera.html'); fs.writeFileSync(f, buildCardHtml({ ...KINDS.tween, action: { do: 'click', el: '.press' }, dir, motions: [press, group, fade] }));
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('file://' + f + '#motion/0'); await page.waitForTimeout(200);
    const sc = (tr) => { const m = /scale\(([\d.]+)/.exec(tr || ''); return m ? +m[1] : 1; };
    const at = (i, tl) => page.evaluate(([i, tl]) => { panelPlayers[i].scrubTo(tl); const c = document.querySelector(`#mp-${i} .cam`); return { px: (c.querySelector('.px') || {}).style?.transform, op: (c.querySelector('.px') || {}).style?.opacity, gm: [...c.querySelectorAll('.gm')].map((g) => g.style.transform), cam: c.style.transform, head: document.querySelector(`#ph-${i}`)?.getAttribute('x1') }; }, [i, tl]);
    assert.equal(await page.locator('.stage .se').count(), 0, 'no sticker');
    assert.ok(Math.abs(sc((await at(0, 250)).px) - 0.92) < 0.002, 'sunk after the press');
    assert.ok(sc((await at(0, 300 + 900 * 0.35)).px) > 1.005, 'the release is on the stage: it springs past 1');
    const tx = await page.evaluate(() => [...document.querySelectorAll('#mp-0 .num')].map((n) => n.textContent).join('|'));
    assert.ok(/120msPress/.test(tx) && /900msRelease/.test(tx), 'both phases on the tiles: ' + tx);
    assert.ok(/Press/.test(await page.evaluate(() => [...document.querySelectorAll('#mp-0 svg.plot text')].map((x) => x.textContent).join(' '))), 'phases named on the curve');
    await page.evaluate(() => { location.hash = 'motion/1'; }); await page.waitForTimeout(120);
    const dy = (tr) => { const m = /translate\([^,]+,\s*(-?[\d.]+)%/.exec(tr || ''); return m ? +m[1] : 0; };
    const mid = await at(1, 60);   // the first member is moving; the last has not started
    assert.equal(mid.gm.length, 3); assert.ok(dy(mid.gm[0]) < dy(mid.gm[2]) && dy(mid.gm[2]) === 90, 'members play one after another: ' + mid.gm.join(' | '));
    assert.ok(+/scale\(([\d.]+)/.exec(mid.cam)[1] <= 1, 'the camera never scales above real size: ' + mid.cam);
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('#mp-1 .bp text')].some((x) => x.textContent === '36 px')), 'the measured line carries the real distance');
    assert.ok(/easeOutQuint/.test(await page.textContent('#mp-1 .nums')), 'a known bezier is named');
    await page.evaluate(() => { location.hash = 'motion/2'; }); await page.waitForTimeout(120);
    const fd = await at(2, 40);
    assert.ok(+fd.op > 0.5, 'a fade-out starts visible: ' + fd.op); assert.ok(await page.locator('#mp-2 .stage .px.block').count() === 1, 'a stand-in block, not an empty box');
    assert.ok(/stand-in/.test(await page.textContent('#mp-2 .stage')), 'and it says so');
    assert.equal(await page.evaluate(() => !!document.querySelector('#mp-2 .bp rect')), false, 'a fade has no line');
    assert.deepEqual(errs, []); await ctx.close();
  } finally { await browser.close(); }
});

test('card page: first screen at 1440 × 900; curve drag, keys, chosen speed and library, click to copy', { timeout: 60000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine: ' + e.message); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    const f = path.join(tmp, 'first.html'); const m0 = { ...KINDS.declaredTwo.motions[0], exports: KINDS.declaredTwo.motions[0].exports.map((e) => ({ ...e, exports: [...e.exports, { lib: 'gsap', code: 'gsap.to(el, { y: 0 });' }] })) };
    fs.writeFileSync(f, buildCardHtml({ ...KINDS.declaredTwo, motions: [m0, { ...m0, rank: 2, desc: 'P.lede', selector: 'p.lede' }] }));
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] }); const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('file://' + f + '#motion/0'); await page.waitForTimeout(200);
    const g = await page.evaluate(() => { panelPlayers[0].pause(); const r = (s) => { const b = document.querySelector('#mp-0 ' + s).getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height, b: b.bottom, r: b.right }; }; return { stage: r('.stage'), curve: r('.curvebox'), plot: r('svg.plot'), nums: r('.nums'), side: [...document.querySelectorAll('#secnav a.msub')].length, mlist: getComputedStyle(document.querySelector('.mlist')).display }; });
    assert.ok(g.curve.l >= g.stage.r && Math.abs(g.curve.t - g.stage.t) < 2, 'replay beside the curve'); assert.ok(g.plot.h / g.plot.w > 0.7, 'the curve is near square: ' + JSON.stringify(g.plot));
    assert.ok(g.nums.b <= 900, 'numbers on the first screen: ' + g.nums.b); assert.equal(g.side, 2); assert.equal(g.mlist, 'none');
    const tl = () => page.evaluate(() => +document.querySelector('#mp-0 .ps').value);
    await page.mouse.move(g.plot.l + g.plot.w * .5, g.plot.t + g.plot.h * .5); await page.mouse.down(); await page.mouse.move(g.plot.l + g.plot.w * .7, g.plot.t + g.plot.h * .5); await page.mouse.up();
    const a = await tl(); assert.ok(a > 300, 'dragging on the curve scrubs: ' + a);
    await page.keyboard.press('ArrowRight'); const b = await tl(); assert.ok(b > a && b - a < 20, 'one frame: ' + (b - a));
    await page.keyboard.press(']'); await page.waitForTimeout(100); assert.equal(await page.evaluate(() => location.hash), '#motion/1');
    await page.click('#mp-1 .slow'); await page.click('#mp-1 [data-lib=gsap]');
    await page.keyboard.press('['); await page.waitForTimeout(100);
    assert.equal(await page.getAttribute('#mp-0 .slow', 'aria-pressed'), 'true', '¼× stays chosen');
    assert.equal(await page.getAttribute('#mp-0 [data-lib=gsap]', 'aria-selected'), 'true', 'the library stays chosen');
    await page.click('#mp-0 .num[data-copy]'); assert.ok(/ms$/.test(await page.evaluate(() => navigator.clipboard.readText())), 'a number copies');
    await page.evaluate(() => document.activeElement.blur());
    const was = await page.textContent('#mp-0 .pp'); await page.keyboard.press(' '); assert.notEqual(await page.textContent('#mp-0 .pp'), was, 'Space plays and pauses');
    assert.deepEqual(errs, []); await ctx.close();
  } finally { await browser.close(); }
});

test('card page: a pinned stage shows the pictures taken on the way down; what was left out is said in plain words', { timeout: 60000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine: ' + e.message); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-card-mid-'));
    { const ctx = await browser.newContext({ viewport: { width: 32, height: 20 } }); const p = await ctx.newPage(); await p.setContent('<body style="margin:0;background:#4a6"></body>');
      for (const n of ['screen-end.jpg', 'page.jpg', 'm0.jpg', 'm1.jpg']) await p.screenshot({ path: path.join(dir, n), type: 'jpeg', quality: 50 }); await ctx.close(); }
    const pin = KINDS.pin;
    const look = { ...pin, dir, screens: { viewport: { file: 'screen-end.jpg', w: 1440, h: 900, scrollY: 3000, dpr: 1 }, before: null, page: { file: 'page.jpg', w: 1440, h: 4000, scale: 1 }, mid: [{ file: 'm0.jpg', w: 1440, h: 900, scrollY: 300 }, { file: 'm1.jpg', w: 1440, h: 900, scrollY: pin.motions[0].lines[0].values.find((v) => v.name === 'pinEnd').value - 50 }] },
      unknowns: [{ el: 1, desc: 'DIV.hero', channel: 'ren:sx', kind: 'below noise', reason: 'changes only below the read-back noise floor' }, { el: 2, desc: 'DIV.card', channel: 'ren:rz', kind: 'no model', reason: 'no family explains it' }],
      alreadyMoving: [{ desc: 'DIV.ticker', selector: 'div.ticker' }], pointerDriven: [] };
    const f = path.join(tmp, 'pin.html'); fs.writeFileSync(f, buildCardHtml(look));
    const page = await browser.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('file://' + f + '#motion/0'); await page.waitForTimeout(200);
    assert.ok(/--g-m1/.test(await page.evaluate(() => document.querySelector('#mp-0 .stage .cam').innerHTML)), 'the pinned stage stands on a picture taken while it held');
    const rec = await page.evaluate(() => { renderRecording(); return document.querySelector('#recording').textContent; });
    assert.ok(/1 change REVA saw but could not fit/.test(rec) && !/noise/.test(rec), 'no model is said, below noise is not: ' + rec.slice(0, 300));
    assert.ok(/1 element left out/.test(rec) && /Record the page load/.test(rec), 'the next step is said');
    assert.deepEqual(errs, []);
  } finally { await browser.close(); }
});
