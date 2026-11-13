// T4 part D: the card's finale hands over ONE file (the motion system, then the moves that show it best), with no page words in it
// (D-GOAL-1); Study lists the elements of the card's moves first. Data is synthetic: nothing from a real site enters the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { motionSpec, neutralName, neutralText, finaleMotion, tokenValues } from '../src/export/spec.js';
import { cardIndex, studyMoves } from '../src/card/moves.js';

const CSS = '/* example.com motion, read by REVA */\n:root {\n  --motion-ease: cubic-bezier(0.6, 0, 0.05, 1);\n  --motion-ease-pointer: ease-in-out;\n  --motion-duration-slow: 600ms;\n  --motion-duration-arrive: 600ms;\n  --motion-duration-pointer: 200ms;\n  --motion-stagger: 50ms;\n  --motion-rise: 50px;\n}';
const move = (id, o = {}) => ({ id, kind: 'scroll', group: 'scrolling', name: `Move ${id}`, sentence: 'As you scroll, 4 elements rise 50 px and fade in, 0.6 s.', trigger: { kind: 'scroll-triggered', word: 'As it scrolls into view', scroll: { start: 'top 80%' } }, time: { ms: 600 }, curve: { kind: 'tween', name: 'cubic-bezier(0.6, 0, 0.05, 1)' }, proof: { source: 'declared', word: "From the site's CSS" }, frame: { poster: `clips/${id}.jpg` }, instances: [{ page: 'home', viewport: 'desktop', take: 'arrive' }], ...o });
const index = () => ({
  site: { host: 'example.com', pages: [{ id: 'home' }], viewports: ['desktop'], system: { sentences: ['Arrivals ease on cubic-bezier(0.6, 0, 0.05, 1).', 'The "SECRET MENU" items wait 50 ms apart.'], tokens: { css: CSS, gsap: 'gsap.defaults({ duration: 0.6 });' }, arrive: { text: 'cubic-bezier(0.6, 0, 0.05, 1)' }, tempo: { arrive: 600 }, stagger: { ms: 50 }, shape: { rise: 50 } } },
  top: ['m-1', 'm-2', 'm-3'],
  moves: [
    move('m-1', { name: '"WHY ACME" items rise in on scroll', sentence: 'As you scroll, "WHY ACME" items rise 50 px.', subject: { text: '"WHY ACME" items', plural: true, noun: { one: 'element', many: 'elements' } } }),
    move('m-2', { kind: 'touch', name: '"Pricing" and "Docs", hover', time: { ms: 200 }, curve: { name: 'ease-in-out' }, subject: { text: '"Pricing"', plural: false, quoted: true, noun: { one: 'link', many: 'links' } }, instances: [{ page: 'home', viewport: 'desktop', take: 'patterns' }] }),
    move('m-3', { consent: true, name: 'Accept all, hover' }),
    move('m-4', { name: 'Hero rises in on load', kind: 'load' }),
    move('m-5', { name: 'Hero rises in on load, again', same: 'm-4' }),
    move('m-6', { notMove: true }),
  ],
  groups: [{ id: 'scrolling', title: 'Scrolling', moves: ['m-1', 'm-2', 'm-4', 'm-5'] }],
});
const docs = {
  'm-1': { timing: '600 ms, cubic-bezier(0.6, 0, 0.05, 1), on scroll', groups: [{ role: 'lead', name: 'Block', count: 4, selector: 'div.acme-x9 > div', selectors: ['div.acme-x9 > div'], elements: ['DIV.acme-x9'], law: { class: 'tween', ms: 600, declared: 'cubic-bezier(0.6, 0, 0.05, 1)' }, recipe: '4 elements, each one rises 50 px and fades in, over 0.6 s.', changes: [{ property: 'y', from: 50, to: 0, unit: 'px' }] }], code: { css: '.your-block { animation: reva-block 600ms cubic-bezier(0.6, 0, 0.05, 1) both; }' } },
  'm-2': { timing: '200 ms, ease-in-out, on hover', groups: [{ role: 'lead', name: 'Link', count: 2, selector: 'a.nav', elements: ['A.nav'], law: { class: 'tween', ms: 200, declared: 'ease-in-out' }, recipe: 'The "Pricing" link lifts 2 px.', changes: [] }] },
  'm-4': { timing: '600 ms, on load', groups: [{ role: 'lead', name: 'Hero', count: 1, selector: 'h1.hero', elements: ['H1.hero'], law: { class: 'tween', ms: 600 }, recipe: 'The heading rises 10 px.', changes: [] }] },
  'm-5': { timing: '600 ms, on load', groups: [{ role: 'lead', name: 'Hero', count: 1, selector: 'h2.sub', elements: ['H2.sub'], law: { class: 'tween', ms: 600 }, changes: [] }] },
  'm-3': { groups: [{ selector: 'button.cookie' }] },
};
const docOf = (id) => docs[id] || null;

test('page words leave a name or a sentence: what is left reads, or the noun and what sets it off stand in', () => {
  assert.equal(neutralText('As you scroll, "WHY ACME" items rise 50 px.'), 'As you scroll, items rise 50 px.');
  assert.equal(neutralName({ name: '"Pricing" and "Docs", hover', kind: 'touch', subject: { plural: false, noun: { one: 'link', many: 'links' } } }), 'Link, hover');
  assert.equal(neutralName({ name: '"WHY ACME" items rise in on scroll', subject: { plural: true, noun: { one: 'element', many: 'elements' } } }), 'Elements rise in on scroll');
  assert.equal(neutralName({ name: 'Hero headline rises in on load' }), 'Hero headline rises in on load');
  assert.equal(neutralName({ name: 'Page change to /customer-stories/acme' }), 'Page change to another page');
  assert.equal(neutralName({ name: '"Buy", click', kind: 'touch' }), 'Element, click');
});

test('the motion spec is one Markdown file: the system, then the moves that show it best, with no page words and no consent banner', () => {
  const s = motionSpec(index(), docOf, { date: '2026-11-11' });
  assert.equal(s.file, 'example.com-motion.md');
  const prose = s.md.split('```json')[0];
  assert.ok(prose.startsWith('# The motion of example.com'));
  assert.match(prose, /no fonts, images or words of the site/);
  assert.doesNotMatch(prose, /WHY ACME|SECRET MENU|Pricing|Docs|Accept all/, 'page words are said without their text');
  assert.doesNotMatch(prose, /acme-x9|a\.nav|h1\.hero/, 'no site selectors: the code names elements by placeholders');
  assert.match(prose, /--motion-ease: cubic-bezier\(0\.6, 0, 0\.05, 1\);/);
  // a folded repeat is said once, as its pattern; a non-move and a consent banner never
  assert.deepEqual([...prose.matchAll(/^### \d+\. (.*)$/gm)].map((m) => m[1]), ['Elements rise in on scroll', 'Link, hover', 'Hero rises in on load']);
  // a move on the system's ease and time says so by the token's name; a hover by the pointer's tokens
  assert.match(prose, /Timing: 600 ms, cubic-bezier\(0\.6, 0, 0\.05, 1\), on scroll \(the system's --motion-ease and --motion-duration-arrive\)/);
  assert.match(prose, /Timing: 200 ms, ease-in-out, on hover \(the system's --motion-ease-pointer and --motion-duration-pointer\)/);
  const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(s.md)[1]);
  assert.equal(json.schema, 'reva.motion-spec/0');
  assert.equal(json.moves.length, 3);
  assert.deepEqual(json.moves[0].parts[0].changes, [{ property: 'y', from: 50, to: 0, unit: 'px' }]);
  assert.doesNotMatch(JSON.stringify(json), /WHY ACME|SECRET MENU|acme-x9/);
  // fast and slow (ms, steps of 10) are the span the summary's first sentence gives; with no fast token there is no span
  assert.deepEqual(s.motion, { ease: 'cubic-bezier(0.6, 0, 0.05, 1)', pointer: 'ease-in-out', ms: 600, stagger: 50, rise: 50, fast: null, slow: 600, range: null });
  // a token that names another token has its value: arrive = slow is written once (system.js tokensOf)
  const aliased = finaleMotion({ tokens: { css: ':root {\n  --motion-ease: ease;\n  --motion-duration-fast: 150ms;\n  --motion-duration-slow: 620ms;\n  --motion-duration-arrive: var(--motion-duration-slow);\n}' } });
  assert.deepEqual([aliased.fast, aliased.slow, aliased.ms, aliased.range], [150, 620, 620, '0.15 to 0.62 s']);
  // nothing to hand over: no file
  assert.equal(motionSpec({ site: {}, moves: [] }, docOf), null);
});

test('the finale moves on the system numbers, read from its tokens first', () => {
  assert.deepEqual(tokenValues(CSS)['motion-stagger'], '50ms');
  assert.equal(finaleMotion({ tokens: { css: '' }, arrive: { text: 'power2.out' }, tempo: { arrive: 900 } }).ease, 'power2.out');
  assert.equal(finaleMotion(null), null);
});

test('the card carries the finale for the moves it shows, and Study knows which elements are in them', () => {
  const ix = index(), finale = motionSpec(ix, docOf);
  const card = cardIndex(ix, { finale });
  assert.equal(card.finale.file, 'example.com-motion.md');
  assert.deepEqual(card.finale.lines.map((l) => l.id), ['m-1', 'm-2', 'm-4']);
  const on = studyMoves(ix, docOf);
  assert.equal(on['home/desktop'].arrive['div.acme-x9 > div'], 'm-1');
  assert.equal(on['home/desktop'].arrive['DIV.acme-x9'], 'm-1');
  assert.equal(on['home/desktop'].patterns['a.nav'], 'm-2');
  // a folded repeat leads to the pattern the card shows; a consent banner leads nowhere
  assert.equal(on['home/desktop'].arrive['h2.sub'], 'm-4');
  assert.equal(Object.values(on['home/desktop']).some((t) => 'button.cookie' in t), false);
});
