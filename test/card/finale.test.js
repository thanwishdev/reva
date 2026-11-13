// T4 part E: the card's finale in a headless browser. It plays once as it comes into view: the move pictures of the card fly into one
// box at the centre of the screen and fold into a pile, then the box says what matters and hands over the one file (from disk).
// With reduced motion the finished box is simply there. Part E2: the card above steps back while the pictures fly and comes back
// after; the count of moves counts up to the real number; the site's ease is drawn in the box, and only when the site has one.
// Data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cardIndex, injectMoves } from '../../src/card/moves.js';
import { scriptJson, trimLook } from '../../src/card/build.js';
import { motionSpec } from '../../src/export/spec.js';
import { resolveEngine, MANDATORY_ARGS } from '../../src/browser/engines.js';

const require = createRequire(import.meta.url);
const PAGE = new URL('../../src/card/page/', import.meta.url);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const CSS = ':root {\n  --motion-ease: cubic-bezier(0.6, 0, 0.05, 1);\n  --motion-duration-arrive: 600ms;\n  --motion-stagger: 50ms;\n  --motion-rise: 50px;\n}';

function cardDir({ ease = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-finale-'));
  const ids = Array.from({ length: 14 }, (_, i) => `m-${String(i).padStart(2, '0')}`);
  const move = (id) => ({ id, kind: 'scroll', group: 'scrolling', name: `"Word ${id}" items rise in on scroll`, sentence: 'As you scroll, 4 elements rise 50 px and fade in, 0.6 s.', trigger: { kind: 'scroll-triggered', word: 'As it scrolls into view', parts: [], scroll: { start: 'top 90%' } }, frame: { shape: 'box', w: 1600, h: 1000, poster: `clips/${id}.jpg`, clip: null, ms: 600, play: 'scrub' }, curve: { kind: 'tween', name: 'cubic-bezier(0.6, 0, 0.05, 1)' }, proof: { source: 'declared', word: "From the site's CSS" }, time: { ms: 600 }, n: 1, variants: 0, phone: { status: 'none' }, gap: null, subject: { plural: true, noun: { one: 'element', many: 'elements' } }, instances: [{ page: 'home', viewport: 'desktop', take: 'arrive', box: [0, 600, 1440, 300] }] });
  const index = {
    site: { host: 'example.com', url: 'https://example.com/', pages: [{ id: 'home', label: 'Home', url: 'https://example.com/', hero: null }], viewports: ['desktop'], built: [],
      system: { sentences: ['Arrivals ease on cubic-bezier(0.6, 0, 0.05, 1).'], tokens: { css: ease ? CSS : CSS.replace(/ *--motion-ease:[^\n]*\n/, '') } } },
    scan: { date: '2026-11-11' }, top: ids.slice(0, 6), groups: [{ id: 'scrolling', title: 'Scrolling', moves: ids }], moves: ids.map(move),
  };
  const docOf = (id) => ({ timing: '600 ms, cubic-bezier(0.6, 0, 0.05, 1), on scroll', groups: [{ role: 'lead', name: 'Block', count: 4, law: { class: 'tween', ms: 600 }, recipe: '4 elements, each one rises 50 px and fades in, over 0.6 s.', changes: [] }], code: { css: '.your-block { }' }, id });
  const data = { look: trimLook({ schema: 'reva.look/0', status: 'ok', source: { kind: 'scan', url: 'https://example.com/' }, action: { do: 'load' }, take: {}, motions: [], others: [] }, null), scan: { looks: {}, host: 'example.com', url: 'https://example.com/', dirName: 'x', pages: [], site: {} },
    moves: cardIndex(index, { prompt: 'Give my site the motion of example.com.', finale: motionSpec(index, docOf, { date: '2026-11-11' }) }) };
  const tpl = fs.readFileSync(new URL('template.html', PAGE), 'utf8').replace('/*__DATA__*/null', () => scriptJson(data));
  fs.writeFileSync(path.join(dir, 'card.html'), injectMoves(tpl));
  fs.mkdirSync(path.join(dir, 'clips'));
  for (const id of ids) fs.writeFileSync(path.join(dir, 'clips', `${id}.jpg`), PNG);
  return dir;
}

const finState = (page) => page.evaluate(() => {
  const sec = document.querySelector('#mv-fin'), box = document.querySelector('#mv-finbox').getBoundingClientRect(), say = [...document.querySelectorAll('.fin-say > *')];
  return { settled: sec.classList.contains('settled'), run: sec.classList.contains('run'), flying: document.querySelectorAll('.fin-piece').length, cards: document.querySelectorAll('.fin-card').length,
    box: getComputedStyle(document.querySelector('#mv-finbox')).opacity, words: say.map((el) => getComputedStyle(el).opacity), dx: (() => { const f = sec.getBoundingClientRect(); return Math.round(box.left + box.width / 2 - (f.left + f.width / 2)); })(),
    hidden: [...document.querySelectorAll('#mv-lists .mv-f')].filter((f) => f.style.opacity !== '').length, count: document.querySelector('#mv-finn')?.textContent ?? null,
    svg: !!document.querySelector('.fin-box svg.fin-curve'), drawn: document.querySelector('.fin-curve path') ? getComputedStyle(document.querySelector('.fin-curve path')).strokeDashoffset : null,
    wrap: (() => { const w = document.querySelector('#mv-home > .mv-wrap'), cs = getComputedStyle(w); return { opacity: cs.opacity, transform: cs.transform }; })(), w: document.documentElement.scrollWidth, finFits: document.querySelector('#mv-fin').getBoundingClientRect().right <= innerWidth, ...window.__finale.state() };
});
const toEnd = (page) => page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
// as a reader comes to it: the box top a fifth up the screen, the last pictures of the card above it
const toBox = (page) => page.evaluate(() => { const b = document.querySelector('#mv-finbox').getBoundingClientRect(); scrollTo(0, scrollY + b.top - innerHeight * 0.8); });

test('scan card finale: plays once, the move pictures fly into one centred box, one file to download, still with reduced motion', { timeout: 120000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine: ' + e.message); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  const dir = cardDir(), url = pathToFileURL(path.join(dir, 'card.html')).href;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url + '#moves'); await page.waitForTimeout(700);
    // before it is in view: nothing has played, the box is not there yet
    const before = await finState(page);
    assert.equal(before.played, false); assert.equal(before.run, true); assert.equal(before.box, '0');
    // in view: it plays; in the middle of it pictures are in flight and the frames they left are empty
    await toBox(page); await page.waitForTimeout(450);
    const mid = await finState(page);
    assert.equal(mid.played, true); assert.ok(mid.pieces >= 1 && mid.pieces <= 16, `pieces ${mid.pieces}`); assert.ok(mid.flying >= 1); assert.ok(mid.hidden >= 1, 'a picture on screen left its frame');
    // meanwhile the card above has stepped back (opacity and scale, never a blur), and the count has not reached its number yet
    assert.equal(mid.receded, true); assert.ok(+mid.wrap.opacity < 0.9, `wrap opacity ${mid.wrap.opacity}`); assert.notEqual(mid.wrap.transform, 'none');
    assert.ok(+mid.count < 14, `count ${mid.count}`); assert.equal(mid.curve, true); assert.equal(mid.svg, true);
    await toEnd(page);
    // the end: every picture in the pile, the box in the middle of the screen, the words there, the frames above whole again
    await page.waitForTimeout(4500);
    const end = await finState(page);
    assert.deepEqual({ settled: end.settled, run: end.run, flying: end.flying, box: end.box, words: end.words, hidden: end.hidden, done: end.done, landed: end.landed, finFits: end.finFits },
      { settled: true, run: false, flying: 0, box: '1', words: ['1', '1', '1', '1'], hidden: 0, done: true, landed: mid.pieces, finFits: true });
    // the card above back as it was, the count at the real number, the curve drawn whole
    assert.deepEqual({ receded: end.receded, wrap: end.wrap, count: end.count, drawn: end.drawn }, { receded: false, wrap: { opacity: '1', transform: 'none' }, count: null, drawn: '0px' });
    assert.equal(end.cards, mid.pieces); assert.ok(Math.abs(end.dx) <= 1, `box off centre by ${end.dx}px`);
    const text = await page.evaluate(() => document.querySelector('.fin-box').innerText);
    // owner 12 Nov: the box only says what the button gives, no counts or curve numbers
    assert.match(text, /example\.com/); assert.match(text, /Its motion system, in one file\./); assert.doesNotMatch(text, /\d+ moves|cubic-bezier|\d s\b/);
    // once: away and back, it does not play again
    await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(200); await toEnd(page); await page.waitForTimeout(200);
    assert.equal((await finState(page)).flying, 0);
    // the one file, made from the card's own text: no server, no page words in its prose
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mv-findl')]);
    assert.equal(dl.suggestedFilename(), 'example.com-motion.md');
    const md = fs.readFileSync(await dl.path(), 'utf8');
    assert.ok(md.startsWith('# The motion of example.com'));
    assert.equal((md.match(/^### /gm) || []).length, 10);
    assert.doesNotMatch(md.split('```json')[0], /Word m-/);
    assert.deepEqual(errors, []);
    await ctx.close();

    // reduced motion: no flight, the finished box at once, centred, no sideways scroll
    const ctx3 = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
    const p3 = await ctx3.newPage();
    await p3.goto(url + '#moves'); await p3.waitForTimeout(600); await toEnd(p3); await p3.waitForTimeout(200);
    const r = await finState(p3);
    assert.deepEqual({ run: r.run, played: r.played, flying: r.flying, box: r.box, words: r.words, w: r.w, count: r.count, svg: r.svg, drawn: r.drawn, sweep: await p3.evaluate(() => !!document.querySelector('.fin-sweep')) },
      { run: false, played: false, flying: 0, box: '1', words: ['1', '1', '1', '1'], w: 375, count: null, svg: true, drawn: '0px', sweep: false });
    assert.ok(r.cards >= 1); assert.ok(Math.abs(r.dx) <= 1);
    await ctx3.close();

    // a site with no measured ease: no curve and no space kept for one; the count still reaches its number
    const dir2 = cardDir({ ease: false });
    try {
      const ctx4 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p4 = await ctx4.newPage(); const errors4 = []; p4.on('pageerror', (e) => errors4.push(e.message));
      await p4.goto(pathToFileURL(path.join(dir2, 'card.html')).href + '#moves'); await p4.waitForTimeout(700);
      await toBox(p4); await p4.waitForTimeout(300); await toEnd(p4); await p4.waitForTimeout(4500);
      const e4 = await finState(p4);
      assert.deepEqual({ settled: e4.settled, curve: e4.curve, svg: e4.svg, words: e4.words, count: e4.count, receded: e4.receded }, { settled: true, curve: false, svg: false, words: ['1', '1', '1'], count: null, receded: false });
      assert.doesNotMatch(await p4.evaluate(() => document.querySelector('.fin-box').innerText), /arrive on/);
      assert.ok(Math.abs(e4.dx) <= 1); assert.deepEqual(errors4, []);
      await ctx4.close();
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  } finally { await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// Part SS: a light smooth wheel on the scan card. A mouse wheel's notch glides the window over several frames; a trackpad's fine
// steps, reduced motion and anything that scrolls on its own stay native; a jump inside the card stops under the bar; the keys win
// over a glide; the finale still plays (and gives the card back when the reader scrolls up) under the wheel.
test('scan card smooth wheel: glides on a mouse wheel only, native elsewhere, the finale still plays', { timeout: 120000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine: ' + e.message); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  const dir = cardDir(), url = pathToFileURL(path.join(dir, 'card.html')).href;
  // every frame's scrollY for a while after a wheel
  const track = (page, ms) => page.evaluate((ms) => new Promise((ok) => { const ys = [scrollY], t0 = performance.now(); const f = (now) => { ys.push(scrollY); if (now - t0 < ms) requestAnimationFrame(f); else ok(ys); }; requestAnimationFrame(f); }), ms);
  const ss = (page) => page.evaluate(() => window.__smooth.state());
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url + '#moves'); await page.waitForTimeout(700);
    await page.mouse.move(720, 450);
    // a wheel notch: several frames between the start and the target, then exactly the target
    const [ys] = await Promise.all([track(page, 700), page.mouse.wheel(0, 120)]);
    const steps = [...new Set(ys.map((y) => Math.round(y)))].filter((y) => y > 0 && y < 120);
    assert.equal((await ss(page)).kind, 'wheel');
    assert.ok(steps.length >= 5, `in-between frames ${steps.length}: ${ys.join(',')}`);
    await page.waitForTimeout(300); assert.equal(Math.round(await page.evaluate(() => scrollY)), 120); assert.equal((await ss(page)).on, false);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1] - 0.5, 'never backwards');
    // Part PF: the bar's frosted glass rests while the page moves (no backdrop blur drawn per scrolled frame) and is back once still
    const glass = () => page.evaluate(() => { const c = getComputedStyle(document.querySelector('.side'), '::before'); return { moving: document.documentElement.classList.contains('mv-moving'), vis: c.visibility, blur: c.backdropFilter }; });
    const atRest = await glass(); assert.equal(atRest.moving, false); assert.equal(atRest.vis, 'visible'); assert.match(atRest.blur, /blur/);
    await page.evaluate(() => scrollBy(0, 40)); await page.waitForTimeout(40);
    const moving = await glass(); assert.equal(moving.moving, true); assert.equal(moving.vis, 'hidden');
    // PF regression: while the glass steps aside the bar is fully opaque, page text never shows through it
    assert.equal(await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.side')).backgroundColor; const m = c.match(/[\d.]+/g).map(Number); return m.length > 3 ? m[3] : 1; }), 1);
    await page.waitForTimeout(400); assert.equal((await glass()).moving, false);
    await page.evaluate(() => scrollTo(0, 120)); await page.waitForTimeout(400);
    // a script's own wheel event moves nothing (headless Chrome sends every wheel as a mouse notch, -120, so a trackpad is checked on
    // the classifier below)
    const f0 = (await ss(page)).frames;
    await page.evaluate(() => document.querySelector('#mv-lists').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, wheelDeltaY: -120, bubbles: true, cancelable: true })));
    await page.waitForTimeout(250); assert.equal((await ss(page)).frames, f0); assert.equal(Math.round(await page.evaluate(() => scrollY)), 120);
    // a classifier check on what Chrome and Safari give a trackpad (-3 x) and a wheel (120s), Firefox's lines
    assert.deepEqual(await page.evaluate(() => { const k = window.__smooth.kind; return [k({ deltaMode: 0, deltaY: 4, wheelDeltaY: -12 }), k({ deltaMode: 0, deltaY: 100, wheelDeltaY: -120 }), k({ deltaMode: 1, deltaY: 3 }), k({ deltaMode: 0, deltaY: 2.5 }), k({ deltaMode: 0, deltaY: 100 })]; }),
      ['pad', 'wheel', 'wheel', 'pad', 'wheel']);
    // something that scrolls on its own keeps the wheel: the list moves, the window does not
    await page.evaluate(() => { const d = document.createElement('div'); d.id = 'ss-inner'; d.style.cssText = 'height:200px;overflow:auto;width:600px'; d.innerHTML = '<div style="height:2000px"></div>'; document.querySelector('#mv-lists').prepend(d); d.scrollIntoView({ block: 'center' }); });
    await page.waitForTimeout(200);
    const y0 = await page.evaluate(() => scrollY), f1 = (await ss(page)).frames;
    const box = await page.evaluate(() => { const r = document.querySelector('#ss-inner').getBoundingClientRect(); return { x: r.left + 100, y: r.top + 100 }; });
    await page.mouse.move(box.x, box.y); await page.mouse.wheel(0, 120); await page.waitForTimeout(400);
    assert.ok((await page.evaluate(() => document.querySelector('#ss-inner').scrollTop)) > 0, 'inner scrolled');
    assert.equal(await page.evaluate(() => scrollY), y0); assert.equal((await ss(page)).frames, f1);
    await page.evaluate(() => document.querySelector('#ss-inner').remove());
    // the keys win: a PageDown during a glide stops it where it is and the page does not jump back to the glide's target
    await page.evaluate(() => scrollTo(0, 0)); await page.mouse.move(720, 450); await page.waitForTimeout(100);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 120);
    await page.keyboard.press('PageDown'); await page.waitForTimeout(600);
    const k1 = await page.evaluate(() => scrollY); assert.equal((await ss(page)).on, false); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => scrollY), k1, 'no jump back after the keys');
    // a jump inside the card: glides, and the element's top lands just under the sticky bar
    await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(100);
    const fa = (await ss(page)).frames;
    await page.evaluate(() => window.__smooth.into(document.querySelector('#mv-lists')));
    await page.waitForTimeout(1600);
    const land = await page.evaluate(() => ({ top: document.querySelector('#mv-lists').getBoundingClientRect().top, bar: document.querySelector('.side').getBoundingClientRect().bottom }));
    assert.ok(Math.abs(land.top - land.bar) <= 2, `landed ${land.top} vs bar ${land.bar}`); assert.ok((await ss(page)).frames - fa >= 5);
    // the finale under the wheel: it plays, the card steps back, a scroll up gives it back, and it ends whole
    await page.evaluate(() => scrollTo(0, 0)); await page.mouse.move(720, 450);
    for (let i = 0; i < 80 && !(await page.evaluate(() => window.__finale.state().played)); i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(40); }
    assert.equal((await page.evaluate(() => window.__finale.state())).played, true);
    await page.waitForTimeout(250);
    assert.ok(+(await page.evaluate(() => getComputedStyle(document.querySelector('#mv-home > .mv-wrap')).opacity)) < 0.95, 'card receded');
    await page.mouse.wheel(0, -120); await page.mouse.wheel(0, -120); await page.waitForTimeout(700);
    assert.ok(+(await page.evaluate(() => getComputedStyle(document.querySelector('#mv-home > .mv-wrap')).opacity)) > 0.95, 'card back after scrolling up');
    await page.waitForTimeout(4000);
    const fin = await page.evaluate(() => window.__finale.state());
    assert.equal(fin.done, true); assert.equal(fin.landed, fin.pieces);
    assert.deepEqual(errors, []);
    await ctx.close();
    // reduced motion: the wheel is native, no glide at all
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const p2 = await ctx2.newPage(); await p2.goto(url + '#moves'); await p2.waitForTimeout(600); await p2.mouse.move(720, 450);
    await p2.mouse.wheel(0, 120); await p2.waitForTimeout(300);
    assert.equal(await p2.evaluate(() => scrollY), 120); assert.deepEqual(await ss(p2), { on: false, to: 0, frames: 0, kind: null });
    await ctx2.close();
  } finally { await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
