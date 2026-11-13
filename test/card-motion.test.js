// What users came for (T4 part 2, 6 Nov review of a site's scan card): the site's motion system, repeated moves as one pattern,
// names that say what a move does, a recipe line per group, code per group. Each with the smallest proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveCode } from '../src/export/move.js';
import { recipeOf } from '../src/scan/moves/close.js';
import { sentenceOf } from '../src/scan/moves/intent.js';
import { doingName, groupNoun, nameOf, splitOf, subjectOfGroup } from '../src/scan/moves/name.js';
import { apart, motionKey, siteMoves } from '../src/scan/moves/same.js';
import { systemOf } from '../src/scan/moves/system.js';
import { clauseOf } from '../src/scan/moves/intent.js';
import { cardIndex } from '../src/card/moves.js';

const SITE_EASE = 'cubic-bezier(0.6, 0, 0.05, 1)';
const rise = (px = 50) => ({ property: 'y', channel: 'ren:ty', family: 'move', unit: 'px', from: px, to: 0, follows: true });
const fade = { property: 'opacity', channel: 'ren:opacity', family: 'fade', unit: '', from: 0, to: 1, follows: true };
const blur = { property: 'filter', channel: 'ren:filter', family: 'filter', unit: '', from: 'blur(10px)', to: 'blur(0px)', follows: true };
const law = (ms = 600, declared = SITE_EASE) => ({ class: 'tween', ms, delayMs: 0, declared });
const said = (changes) => changes.map((c) => clauseOf(c, {})).filter(Boolean);

test('split text: one-letter spans under a heading are letters, a row of links is no split', () => {
  const table = { rows: [['h1', 'h1.t', 0, 0, 900, 200, 0, '', 1], ...'Create'.split('').map((ch, i) => ['span', `h1.t > span:nth-of-type(1) > span:nth-of-type(${i + 1})`, i * 50, 0, 50, 100, 0, ch, 2])] };
  const runs = 'Create'.split('').map((_, i) => ({ key: `h1.t > span:nth-of-type(1) > span:nth-of-type(${i + 1})`, desc: 'SPAN' }));
  assert.deepEqual(splitOf(runs, table, 6), { unit: 'letter', n: 6, in: 'heading' });
  const links = { rows: [['a', 'nav > a:nth-of-type(1)', 0, 0, 80, 20, 0, 'About us', 1], ['a', 'nav > a:nth-of-type(2)', 90, 0, 80, 20, 0, 'Work with us', 1]] };
  assert.equal(splitOf([{ key: 'nav > a:nth-of-type(1)', desc: 'A' }, { key: 'nav > a:nth-of-type(2)', desc: 'A' }], links, 2), null);
});

test('a sentence counts its plural and never guesses one ("the block, bottom lefts" in the review)', () => {
  assert.equal(subjectOfGroup({ name: 'Block, bottom left', elements: ['DIV.framer-x'], count: 3 }), '3 elements');
  assert.equal(subjectOfGroup({ name: 'Text', elements: ['SPAN'], count: 20, split: { unit: 'letter', n: 20, in: 'heading' } }), '20 letters of the heading');
  assert.equal(subjectOfGroup({ name: 'Read more link', elements: ['A.more'], count: 2 }), '2 read more links');
  assert.deepEqual(groupNoun({ name: 'Div block', elements: ['DIV'] }), { one: 'element', many: 'elements' });
  const s = sentenceOf({ kind: 'load', trigger: { kind: 'load' } }, [
    { name: 'Text', elements: ['SPAN'], count: 20, split: { unit: 'letter', n: 20, in: 'heading' }, changes: [blur, rise(10), fade], law: law() },
    { name: 'Block, bottom left', elements: ['DIV'], count: 19, changes: [fade], law: law() },
  ]);
  assert.equal(s, 'On load, 20 letters of the heading blur and rise 10 px and 19 elements fade in, 0.6 s.');
  assert.doesNotMatch(s, /lefts|bottoms|texts/);
});

test('a recipe line per group: the split first, the same numbers as the code', () => {
  const head = { name: 'Text', elements: ['SPAN'], count: 20, split: { unit: 'letter', n: 20, in: 'heading' }, stagger: { ms: 50, from: 'first' }, changes: [blur, rise(10), fade], law: law() };
  assert.equal(recipeOf(head), 'Split the heading into 20 letter spans. Each letter sharpens from a 10 px blur, rises 10 px and fades in, over 0.6 s on cubic-bezier(0.6, 0, 0.05, 1), 50 ms apart.');
  assert.equal(recipeOf({ name: 'Block, bottom', elements: ['DIV'], count: 7, changes: [rise(), fade], law: law(), delayMs: 120 }), '7 elements, each one rises 50 px and fades in, over 0.6 s on cubic-bezier(0.6, 0, 0.05, 1), 120 ms after the first part.');
  assert.equal(recipeOf({ name: 'Image', elements: ['IMG'], count: 1, part: 'out', changes: [{ ...fade, from: 1, to: 0 }], law: law(200, 'ease-in-out') }), 'On leave: the image fades out, over 0.2 s on ease-in-out.');
  assert.equal(recipeOf({ name: 'Canvas', layer: 'gl', gl: {}, changes: [fade], law: law() }), null);
});

test('code per group, the lead first, each part whole on its own; every CustomEase has its own name', () => {
  const lead = { name: 'Text', count: 20, changes: [rise(10), fade], law: { class: 'tween', ms: 600, delayMs: 0, bezier: [0.6, 0, 0.05, 1] }, stagger: { ms: 50, from: 'first' } };
  const part = { name: 'Glow', count: 1, changes: [fade], law: { class: 'tween', ms: 1200, delayMs: 0, bezier: [0.3, 0.7, 0, 1] } };
  const code = moveCode({ kind: 'load', trigger: { kind: 'load' }, groups: [lead, part] });
  assert.equal(code.parts.length, 2);
  assert.deepEqual(code.parts.map((p) => p.name), ['Text', 'Glow']);
  assert.match(code.parts[0].css, /\.your-text/); assert.doesNotMatch(code.parts[0].css, /your-glow/);
  assert.match(code.parts[0].motion, /^import \{ animate, stagger \} from "motion";/);
  assert.match(code.parts[1].gsap, /^gsap\.from\("\.your-glow-2", \{ opacity: 0, duration: 1\.2/);
  const names = [...code.gsap.matchAll(/CustomEase\.create\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['reva-0.6_0_0.05_1', 'reva-0.3_0.7_0_1']);
  assert.equal(moveCode({ kind: 'load', trigger: { kind: 'load' }, groups: [lead] }).parts, undefined, 'one group needs no part list');
});

// a tiny site: three scroll moves of one motion on two pages, a hero, two hovers
function site() {
  const doc = (id, groups, where) => ({ id, groups, where });
  const g = (o) => ({ role: 'lead', provenance: 'declared', said: said(o.changes), ...o });
  const reveal = (id, page, sub, rank, n = 1) => ({ m: { id, kind: 'scroll', group: 'scrolling', name: `${sub.text}, on scroll`, subject: sub, trigger: { kind: 'scroll-triggered', scroll: { start: 'top 90%' } }, rank: { score: rank, base: rank, top: true }, instances: [{ page, viewport: 'desktop' }], proof: { source: 'declared' } }, d: doc(id, [g({ name: 'Block, bottom', elements: ['DIV'], count: 4, changes: [rise(), fade], law: law(), stagger: { ms: 50, from: 'first' } })], [{ page, viewport: 'desktop', count: n }]) });
  const list = [
    reveal('m-a', 'home', { text: '"OUR WORK" items', plural: true, noun: { one: 'element', many: 'elements' } }, 90, 2),
    reveal('m-b', 'home', { text: '"Brand library" section', plural: false, noun: { one: 'element', many: 'elements' } }, 80),
    reveal('m-c', 'p2', { text: 'Block, bottom', plural: false, noun: { one: 'element', many: 'elements' } }, 70),
    { m: { id: 'm-h', kind: 'load', group: 'arriving', name: 'Hero headline, on load', subject: { text: 'Hero headline', plural: false, noun: { one: 'letter', many: 'letters' } }, trigger: { kind: 'load' }, rank: { score: 100, base: 100, top: true }, instances: [{ page: 'home', viewport: 'desktop' }] },
      d: doc('m-h', [g({ name: 'Text', elements: ['SPAN'], count: 20, split: { unit: 'letter', n: 20, in: 'heading' }, changes: [blur, rise(10), fade], law: law(), stagger: { ms: 50, from: 'first' } })], [{ page: 'home', viewport: 'desktop', count: 1 }]) },
    ...['Product', 'Pricing'].map((t, i) => ({ m: { id: `m-t${i}`, kind: 'touch', group: 'hover', name: `"${t}", hover`, subject: { text: `"${t}"`, plural: false, quoted: true, noun: { one: 'link', many: 'links' } }, trigger: { kind: 'hover', parts: [{ kind: 'hover', lagMs: 0 }] }, rank: { score: 50 - i, base: 50 - i, top: true }, instances: [{ page: 'home', viewport: 'desktop' }] },
      d: doc(`m-t${i}`, [g({ name: 'Menu', elements: ['DIV'], count: 1, changes: [fade], law: law(200, 'ease-in-out') })], [{ page: 'home', viewport: 'desktop', count: 1 }]) })),
  ];
  const index = { site: { host: 'example.com', pages: [{ id: 'home', label: 'Home' }, { id: 'p2', label: '/work' }], viewports: ['desktop'] }, groups: [{ id: 'arriving', moves: ['m-h'] }, { id: 'scrolling', moves: ['m-a', 'm-b', 'm-c'] }, { id: 'hover', moves: ['m-t0', 'm-t1'] }], top: [], moves: list.map((x) => x.m) };
  return { index, docs: new Map(list.map((x) => [x.m.id, x.d])) };
}

test('repeated moves fold into one pattern: used in N places on N pages, the others point to it, names say what it does', () => {
  const { index, docs } = site();
  assert.equal(motionKey(index.moves[0], docs.get('m-a')), motionKey(index.moves[2], docs.get('m-c')));
  const r = siteMoves(index, docs);
  assert.deepEqual(r, { patterns: 2, folded: 3 });
  const a = index.moves.find((m) => m.id === 'm-a');
  assert.deepEqual(a.uses, { n: 4, pages: 2, moves: ['m-a', 'm-b', 'm-c'] });
  assert.equal(a.name, 'Content rises in on scroll'); assert.equal(a.own, '"OUR WORK" items rise in on scroll');
  assert.equal(index.moves.find((m) => m.id === 'm-b').same, 'm-a');
  assert.equal(index.moves.find((m) => m.id === 'm-h').name, 'Hero headline rises in on load');
  assert.equal(index.moves.find((m) => m.id === 'm-t0').name, '"Product" and "Pricing", hover');
  assert.ok(a.rank.score > 90, 'a pattern used in three places weighs more');
  // run twice (after the fit, again after the GSAP join): the same names, no "near" or number added twice
  const names = index.moves.map((m) => m.name).join('|');
  siteMoves(index, docs);
  assert.equal(index.moves.map((m) => m.name).join('|'), names);
  const card = cardIndex({ ...index, site: { ...index.site, system: { sentences: ['x'], tokens: { css: ':root {}' }, tempo: {} } } });
  assert.deepEqual(card.moves.find((m) => m.id === 'm-a').uses, { n: 4, pages: 2, moves: ['m-a', 'm-b', 'm-c'] });
  assert.equal(card.moves.find((m) => m.id === 'm-c').same, 'm-a');
  assert.deepEqual(card.site.system, { sentences: ['x'], tokens: { css: ':root {}' } });
});

test('two moves named alike are told apart by their heading, idempotently, and a page never goes into a name', () => {
  const l = [{ name: 'Card, hover', near: 'Work', instances: [{ page: 'home' }] }, { name: 'Card, hover', near: 'Team', instances: [{ page: 'p2' }] }, { name: 'Card, hover', instances: [{ page: 'home' }] }];
  apart(l);
  assert.deepEqual(l.map((m) => m.name), ['Card, hover', 'Card, hover near "Team"', 'Card, hover 2']);
  assert.ok(l.every((m) => !/, on \//.test(m.name)));
  assert.equal(nameOf({ kind: 'change', changeTo: '/work' }), 'Page change to /work');
  assert.equal(doingName({ kind: 'scroll', subject: { text: '"Work" items', plural: true }, trigger: { kind: 'scroll-linked' } }, { law: { class: 'map' }, changes: [rise(80)] }, clauseOf), '"Work" items rise in with the scroll');
});

test('the motion system: tempo, the declared ease and its time, the usual arrival, stagger, scroll; tokens in three forms', () => {
  const { index, docs } = site();
  siteMoves(index, docs);
  const s = systemOf(index, docs, null);
  assert.deepEqual(s.sentences, [
    'Most motion takes 0.2 to 0.6 s: things arrive in 0.6 s, and hovers and clicks answer in 0.2 s.',
    "Arrivals ease on cubic-bezier(0.6, 0, 0.05, 1), declared in the site's CSS (4 of 4); hovers and clicks on ease-in-out (2 of 2).",
    'Most arrivals rise 50 px and fade in.',
    'Items in a group arrive one by one, 50 ms apart, and text is split into letters first.',
    'On scroll, each move plays once as its top reaches 90 % of the screen.',
  ]);
  assert.match(s.tokens.css, /--motion-ease: cubic-bezier\(0\.6, 0, 0\.05, 1\);/);
  // one literal per duration: a time equal to one above it is that token (11 Nov: slow = arrive = 600 ms written twice)
  assert.match(s.tokens.css, /--motion-duration-pointer: var\(--motion-duration-fast\);/); assert.match(s.tokens.css, /--motion-rise: 50px;/); assert.match(s.tokens.css, /--motion-stagger: 50ms;/);
  const lits = [...s.tokens.css.matchAll(/--motion-duration[\w-]*: (\d+)ms;/g)].map((m) => +m[1]);
  assert.equal(new Set(lits).size, lits.length, 'no two duration tokens share a literal');
  assert.ok(lits.every((x) => x % 10 === 0));
  assert.match(s.tokens.gsap, /gsap\.defaults\(\{ duration: 0\.6, ease \}\);/);
  assert.match(s.tokens.motion, /export const transition = \{ duration: 0\.6, ease: \[0\.6, 0, 0\.05, 1\] \};/);
  assert.match(s.tokens.motion, /export const pointer = \{ duration: 0\.2, ease: "easeInOut" \};/);
  for (const k of ['css', 'gsap', 'motion']) assert.doesNotMatch(s.tokens[k], /undefined|NaN|null/);
  assert.equal(s.ease.law, undefined, 'moves.json keeps no law object in the system');
  assert.equal(systemOf({ site: {}, moves: index.moves.slice(0, 2) }, docs), null, 'two moves are no system');
});
