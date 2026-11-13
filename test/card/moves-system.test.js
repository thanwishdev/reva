// The scan card's part-2 screens in a headless browser (T4 part 2): the motion system on top with Copy as tokens, a pattern shown once
// with its places, a recipe line per part, code per part with the lead first. Data is synthetic: nothing from a real site enters the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cardIndex, injectMoves } from '../../src/card/moves.js';
import { scriptJson, trimLook } from '../../src/card/build.js';
import { moveScript } from '../../src/scan/moves/fit.js';
import { resolveEngine, MANDATORY_ARGS } from '../../src/browser/engines.js';

const require = createRequire(import.meta.url);
const PAGE = new URL('../../src/card/page/', import.meta.url);
const rise = { property: 'y', channel: 'ren:ty', family: 'move', unit: 'px', from: 50, to: 0 };
const fade = { property: 'opacity', channel: 'ren:opacity', family: 'fade', unit: '', from: 0, to: 1 };
const move = (id, o) => ({ id, kind: 'scroll', group: 'scrolling', sentence: 'As you scroll, 4 elements rise 50 px and fade in, 0.6 s.', trigger: { kind: 'scroll-triggered', word: 'As it scrolls into view', parts: [], scroll: { start: 'top 90%' } }, frame: null, curve: { kind: 'tween', name: 'cubic-bezier(0.6, 0, 0.05, 1)' }, proof: { source: 'declared', word: "From the site's CSS" }, time: { ms: 600 }, n: 1, variants: 0, phone: { status: 'none' }, gap: null, rank: { score: 10, top: true }, instances: [{ page: 'home', viewport: 'desktop', box: [0, 600, 1440, 300] }], ...o });

function cardDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-moves-system-'));
  const index = {
    site: { host: 'example.com', url: 'https://example.com/', pages: [{ id: 'home', label: 'Home', url: 'https://example.com/', hero: null }, { id: 'p1', label: '/work', url: 'https://example.com/work', hero: null }], viewports: ['desktop'], built: [],
      feel: { sentences: ['Most things take 0.6 s.'] },
      system: { sentences: ['Most motion takes 0.2 to 0.6 s: things arrive in 0.6 s.', "Arrivals ease on cubic-bezier(0.6, 0, 0.05, 1), declared in the site's CSS (3 of 3)."], tokens: { css: ':root {\n  --motion-ease: cubic-bezier(0.6, 0, 0.05, 1);\n}', gsap: 'gsap.defaults({ duration: 0.6 });', motion: 'export const transition = { duration: 0.6 };' } } },
    scan: { date: '2026-11-11' }, coverage: null, tally: { frames: 10 }, top: [],
    groups: [{ id: 'scrolling', title: 'Scrolling', moves: ['m-a', 'm-b', 'm-c'] }],
    moves: [
      move('m-a', { name: 'Content rises in on scroll', own: '"Work" items rise in on scroll', uses: { n: 3, pages: 2, moves: ['m-a', 'm-b'] } }),
      move('m-b', { name: '"Team" items rise in on scroll', same: 'm-a', instances: [{ page: 'p1', viewport: 'desktop', box: [0, 600, 1440, 300] }] }),
      move('m-c', { name: 'Hero headline rises in on load', kind: 'load', group: 'scrolling', trigger: { kind: 'load', word: 'When the page loads', parts: [] } }),
    ],
  };
  const data = { look: trimLook({ schema: 'reva.look/0', status: 'ok', source: { kind: 'scan', url: 'https://example.com/' }, action: { do: 'load' }, take: {}, motions: [], others: [] }, null), scan: { looks: {}, host: 'example.com', url: 'https://example.com/', dirName: 'x', pages: [], site: {} }, moves: cardIndex(index) };
  const tpl = fs.readFileSync(new URL('template.html', PAGE), 'utf8').replace('/*__DATA__*/null', () => scriptJson(data));
  fs.writeFileSync(path.join(dir, 'card.html'), injectMoves(tpl));
  fs.mkdirSync(path.join(dir, 'moves'));
  const recipe = (r) => ({ recipe: r });
  const doc = (id, groups, code) => fs.writeFileSync(path.join(dir, 'moves', `${id}.js`), moveScript(id, { id, groups, where: [{ page: 'home', viewport: 'desktop', count: 2 }], timing: '600 ms', code, notes: [], prompt: 'x' }));
  const lawT = { class: 'tween', ms: 600, declared: 'cubic-bezier(0.6, 0, 0.05, 1)' };
  doc('m-a', [{ name: 'Block', count: 4, law: lawT, changes: [rise, fade], ...recipe('4 elements, each one rises 50 px and fades in, over 0.6 s on cubic-bezier(0.6, 0, 0.05, 1).') }], { css: '.your-block { }', gsap: '', motion: '' });
  doc('m-b', [], null);
  doc('m-c', [
    { name: 'Text', count: 20, law: lawT, changes: [rise], ...recipe('Split the heading into 20 letter spans. Each letter rises 10 px, over 0.6 s on cubic-bezier(0.6, 0, 0.05, 1), 50 ms apart.') },
    { name: 'Glow', count: 1, law: lawT, changes: [fade], ...recipe('The element fades in, over 0.6 s on cubic-bezier(0.6, 0, 0.05, 1).') },
  ], { css: '.your-text { a: 1; }\n.your-glow-2 { b: 2; }', gsap: 'g', motion: 'm', parts: [{ name: 'Text', count: 20, css: '.your-text { a: 1; }', gsap: 'g1', motion: 'm1' }, { name: 'Glow', count: 1, css: '.your-glow-2 { b: 2; }', gsap: 'g2', motion: 'm2' }] });
  return dir;
}

test('scan card: the motion system leads the Moves page, a pattern shows once with its places, recipes and code per part', { timeout: 90000 }, async (t) => {
  let engine; try { engine = resolveEngine('chs'); } catch (e) { return t.skip('no pinned headless engine: ' + e.message); }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: engine.executablePath, headless: true, args: MANDATORY_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(cardDir(), 'card.html')).href + '#moves'); await page.waitForTimeout(800);
    const sys = await page.evaluate(() => ({ h1: document.querySelector('#mv-sys h1')?.textContent, p: [...document.querySelectorAll('#mv-sys p')].map((p) => p.textContent), code: document.getElementById('mv-tokcode')?.textContent, above: document.getElementById('mv-sys').getBoundingClientRect().top < document.getElementById('mv-lists').getBoundingClientRect().top, end: [...document.querySelectorAll('.mv-end p:not(.cov)')].length }));
    assert.equal(sys.h1, 'How example.com moves');
    assert.equal(sys.p.length, 2); assert.match(sys.p[1], /^Arrivals ease on cubic-bezier/);
    assert.match(sys.code, /--motion-ease/); assert.ok(sys.above); assert.equal(sys.end, 0, 'the feel is not said twice at the bottom');
    await page.click('[data-tok="motion"]');
    assert.equal(await page.evaluate(() => document.getElementById('mv-tokcode').textContent), 'export const transition = { duration: 0.6 };');
    await page.click('[data-tokcopy]');
    await page.waitForFunction(() => document.querySelector('[data-tokcopy]').textContent === 'Copied', null, { timeout: 3000 });   // the copy is async
    const tiles = await page.evaluate(() => [...document.querySelectorAll('.mv-t')].map((a) => [a.dataset.id, a.querySelector('.mv-u')?.textContent ?? '']));
    assert.deepEqual(tiles, [['m-a', 'Used in 3 places on 2 pages'], ['m-c', '']], 'the repeat m-b is shown once, as its pattern');
    await page.evaluate(() => { location.hash = 'm/m-a'; }); await page.waitForTimeout(700);
    const rep = await page.evaluate(() => ({ uses: document.querySelector('.mv-uses')?.innerText, link: document.querySelector('.mv-uses a')?.getAttribute('href'), recipe: document.querySelector('.mv-recipe')?.innerText, facts: [...document.querySelectorAll('.mv-facts dt')].map((d) => d.textContent) }));
    assert.match(rep.uses, /^Used in 3 places on 2 pages/); assert.match(rep.uses, /"Work" items rise in on scroll, Home/); assert.equal(rep.link, '#m/m-b');
    assert.match(rep.recipe, /^4 elements, each one rises 50 px/); assert.ok(rep.facts.includes('Recipe') && !rep.facts.includes('Changes'));
    await page.evaluate(() => { location.hash = 'm/m-b'; }); await page.waitForTimeout(600);
    assert.match(await page.evaluate(() => document.querySelector('.mv-rest').innerText), /The same motion as\s+Content rises in on scroll/);
    await page.evaluate(() => { location.hash = 'm/m-c'; }); await page.waitForTimeout(700);
    await page.click('[data-use="code"]'); await page.waitForTimeout(200);   // Code is a tab now (part 3), the one shown first
    const code = await page.evaluate(() => ({ sel: document.querySelector('#mv-part')?.selectedOptions[0]?.textContent, n: document.querySelector('#mv-part')?.options.length, text: document.querySelector('#mv-code pre').textContent }));
    assert.equal(code.sel, 'Text (20), the lead'); assert.equal(code.n, 3); assert.equal(code.text, '.your-text { a: 1; }');
    await page.selectOption('#mv-part', '1'); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.querySelector('#mv-code pre').textContent), '.your-glow-2 { b: 2; }');
    await page.selectOption('#mv-part', 'all'); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.querySelector('#mv-code pre').textContent), '.your-text { a: 1; }\n.your-glow-2 { b: 2; }');
    // Find reaches the repeat through its pattern
    await page.evaluate(() => { location.hash = 'moves'; }); await page.waitForTimeout(400);
    await page.click('#mv-findw'); await page.fill('#mv-q', 'team'); await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.mv-t')].map((a) => a.dataset.id)), ['m-a']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
