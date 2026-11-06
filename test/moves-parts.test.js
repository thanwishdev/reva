// The parts of the move model, each on the smallest input that shows its rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { easeOut, rgb, synthTake } from './helpers/synthtake.js';
import { readRuns, partsOf, walker } from '../src/scan/moves/runs.js';
import { partOf, windowsOf } from '../src/scan/moves/takeview.js';
import { ambientSet, isNoise, isOwn } from '../src/scan/moves/ambient.js';
import { clockKey, controlSets, lagClocked, onsetClocked } from '../src/scan/moves/clocked.js';
import { outsideTests, pointerAt, pointerFollowers, sharedKeys, sweepFollows } from '../src/scan/moves/shared.js';
import { scrollKindOf } from '../src/scan/moves/scrollkind.js';
import { keysOverlap, foldViewport } from '../src/scan/moves/fold.js';
import { lawClasses, staggerOf, summarise } from '../src/scan/moves/group.js';
import { topOf } from '../src/scan/moves/rank.js';
import { humanName, nameOf, pageWords, plainSentence, visibleWords } from '../src/scan/moves/name.js';
import { finishPage, mergeBands, scrollBands } from '../src/scan/moves/trigger.js';
import { scrollLaw } from '../src/scan/moves/pagelevel.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-parts-'));
const viewport = { width: 1440, height: 900 };
const run = (o = {}) => ({ id: '1', key: 'a', desc: 'DIV.a', k0: 10, k1: 40, fams: ['move'], lead: 'ren:ty', amp: 30, shape: Array(13).fill(0), channels: ['ren:ty'], box: [0, 0, 100, 100], ...o });

test('runs: one element, split at 200 ms of quiet, with its box at both ends', () => {
  const t = synthTake({ frames: 200 }), root = tmp();
  const el = t.el('DIV.a', { selector: 'div.a', box: [10, 20, 100, 50], base: { 'ren:ty': 40 } });
  t.ramp(el, 'ren:ty', { k0: 10, k1: 40, from: 40, to: 0, ease: easeOut }).ramp(el, 'ren:ty', { k0: 60, k1: 90, from: 0, to: 40, ease: easeOut });
  t.ramp(el, 'ren:ty', { k0: 96, k1: 120, from: 40, to: 0, ease: easeOut });
  const { take } = t.write(root);
  const { runs, nRows } = readRuns(take);
  assert.equal(nRows, 200);
  const own = runs.filter((r) => !r.boxOnly).sort((a, b) => a.k0 - b.k0);
  assert.equal(own.length, 2, 'a gap over 12 frames splits, a gap under it does not');
  assert.equal(own[0].lead, 'ren:ty');
  assert.equal(own[0].from, 40);
  assert.equal(own[0].to, 0);
  assert.ok(Math.abs(own[0].box[1] - 58) < 3);
  assert.equal(own[0].boxEnd[1], 20);
  assert.equal(own[0].shape.length, 13);
  assert.equal(own[0].shape[12], 1);
  assert.equal(own[0].spans['ren:ty'], own[0].k1 - own[0].k0 + 1);
});

test('runs: a colour step reads as numbers, so it has a lead, a shape and a law class', () => {
  const t = synthTake({ frames: 80 }), root = tmp();
  t.ramp(t.el('A.c', { selector: 'a.c' }), 'ren:color', { k0: 10, k1: 40, fn: rgb([0, 0, 0], [200, 100, 0]) });
  const [r] = readRuns(t.write(root).take).runs.filter((x) => !x.boxOnly);
  assert.equal(r.lead, 'ren:color');
  assert.equal(r.leadPart, 'r');
  assert.ok(r.amp > 190);
  assert.equal(r.fams[0], 'colour');
  assert.equal(r.shape[12], 1);
});

test('partsOf reads each string channel its own way', () => {
  assert.deepEqual(partsOf('ren:color', 'rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 127.5 });
  assert.deepEqual(partsOf('ren:clipPath', 'inset(10px 0px 0px 5px)'), { top: 10, right: 0, bottom: 0, left: 5 });
  assert.deepEqual(partsOf('ren:translate', 'none'), { x: 0, y: 0, z: 0 });
  assert.deepEqual(partsOf('ren:scale', '1.2'), { x: 1.2, y: 1.2, z: 1 });
  assert.deepEqual(partsOf('ren:rotate', '45deg'), { '': 45 });
  assert.deepEqual(partsOf('ren:--x', '43.66px'), { '': 43.66 });
  assert.equal(partsOf('ren:filter', 'none'), null);
});

test('runs: K keeps rising across a new document, and marks follow it', () => {
  const offsets = [0, 150];
  const w = walker(offsets);
  assert.deepEqual([100, 140, 5, 20].map(w), [100, 140, 155, 170]);
});

test('take view: stored and arrive answer in the same words', () => {
  const load = { role: 'load', sections: {} };
  assert.equal(partOf(load, run()), 'load');
  const idle = { role: 'idle', sections: { idle: 100, gate: [40, 60] } };
  assert.equal(partOf(idle, run({ k0: 10, k1: 40 })), 'setup');
  assert.equal(partOf(idle, run({ k0: 45, k1: 58 })), 'gate');
  assert.equal(partOf(idle, run({ k0: 60, k1: 130 })), 'idle');
  const scroll = { role: 'scroll', sections: { down: 100, up: 300 } };
  assert.equal(partOf(scroll, run({ k0: 50 })), 'setup');
  assert.equal(partOf(scroll, run({ k0: 120 })), 'down');
  assert.equal(partOf(scroll, run({ k0: 320 })), 'up');
  const arrive = { role: 'arrive', sections: { idle: 300, down: 540, up: 960, sweep: 1400, sweepEnd: 1640, gate: [200, 240] } };
  assert.equal(partOf(arrive, run({ k0: 10, k1: 40 })), 'load');
  assert.equal(partOf(arrive, run({ k0: 205, k1: 230 })), 'gate');
  assert.equal(partOf(arrive, run({ k0: 250, k1: 280 })), 'setup');
  assert.equal(partOf(arrive, run({ k0: 10, k1: 400 })), 'idle', 'a load run reaching the idle window is the tail of the load');
  assert.equal(partOf(arrive, run({ k0: 600, k1: 640 })), 'down');
  assert.equal(partOf(arrive, run({ k0: 1000, k1: 1040 })), 'up');
  assert.equal(partOf(arrive, run({ k0: 1500, k1: 1540 })), 'sweep');
  assert.equal(partOf(arrive, run({ k0: 1700, k1: 1740 })), 'between');
});

test('windows: each part reaches to the next, end and opened open none, a close can come from the phases', () => {
  const view = { kLast: 500, marks: [{ name: 'a#0:control', K: 10, doc: 0 }, { name: 'a#0:hover', K: 34, doc: 0 }, { name: 'a#0:out', K: 80, doc: 0 }, { name: 'a#0:end', K: 100, doc: 0 }, { name: 'b:click:open', K: 120, doc: 0 }, { name: 'b:click:opened', K: 210, doc: 0 }, { name: 'boot-done', K: 4, doc: 0 }], phases: [{ name: 'b:click:close', from: 300, to: 360 }] };
  const { wins, closes } = windowsOf(view);
  assert.deepEqual(wins.map((w) => `${w.id}:${w.part}:${w.from}-${w.to}`), ['a#0:control:10-34', 'a#0:hover:34-80', 'a#0:out:80-100', 'b:click:open:120-210']);
  assert.deepEqual(closes.map((w) => `${w.id}:${w.from}-${w.to}`), ['b:click:300-361']);
});

test('own motion: a box-only run counts only when the element was touched', () => {
  assert.ok(isOwn(run()));
  assert.ok(!isOwn(run({ boxOnly: true })));
  assert.ok(isOwn(run({ boxOnly: true, wrote: true })));
  assert.ok(isOwn(run({ boxOnly: true, born: true })));
  assert.ok(isNoise(run({ amp: 0.4 })));
  assert.ok(!isNoise(run({ boxOnly: true, lead: 'box', amp: 0 })));
  assert.ok(!isNoise(run({ lead: null, amp: -1 })), 'a string with no number has no amplitude to judge');
});

test('control sets are per test: a leave bleeding into the next window stays out of the other tests', () => {
  const runs = [run({ key: 'leave', k0: 90, k1: 110 }), run({ key: 'steady', k0: 0, k1: 500 })];
  const wins = [{ id: 'a', part: 'control', from: 10, to: 34 }, { id: 'b', part: 'control', from: 100, to: 124 }];
  const c = controlSets(runs, wins);
  assert.deepEqual([...c.get('a')], ['steady']);
  assert.deepEqual([...c.get('b')].sort(), ['leave', 'steady']);
});

test('clocked: a run that starts in a control window names its law group a timer', () => {
  const on = run({ k0: 20, k1: 60 }), off = run({ k0: 200, k1: 240 }), other = run({ k0: 200, k1: 230, lead: 'ren:tx' });
  const s = onsetClocked([on, other], [{ part: 'control', from: 10, to: 34 }], () => true);
  assert.ok(s.has(clockKey(off)));
  assert.ok(!s.has(clockKey(other)));
});

test('clocked: a fixed lag is a reaction, a spread over 300 ms is a timer', () => {
  const m = (key, rel) => ({ kind: 'touch', runs: [run({ key, rel })] });
  const out = lagClocked([m('li:nth-of-type(1)', 2), m('li:nth-of-type(2)', 40), m('li:nth-of-type(3)', 12), m('nav', 2), m('nav', 2), m('nav', 3), m('two', 0), m('two', 90)]);
  assert.deepEqual([...out], ['li']);
});

test('shared: 25 % of the windows, at least 4', () => {
  const w = (keys) => ({ runs: keys.map((key) => run({ key })) });
  assert.deepEqual([...sharedKeys([w(['a']), w(['a']), w(['a']), w(['b'])])], []);
  assert.deepEqual([...sharedKeys([w(['a']), w(['a']), w(['a']), w(['a', 'b']), w(['b'])])], ['a']);
  const many = Array.from({ length: 40 }, (_, i) => w(i < 8 ? ['a'] : ['b']));
  assert.deepEqual([...sharedKeys(many)], ['b']);
});

test('pointer test: a cursor follows, a tooltip beside the target does not lead, a carousel is far', () => {
  const view = { input: [{ k: 10, kind: 'mouseMoved', x: 100, y: 100 }, { k: 100, kind: 'mouseMoved', x: 700, y: 400 }, { k: 200, kind: 'mouseMoved', x: 200, y: 700 }] };
  assert.equal(pointerAt(view, 150).x, 700);
  const at = (x, y, k1, fams = ['move']) => run({ view, k1, fams, boxEnd: [x - 8, y - 8, 16, 16] });
  const cursor = [at(100, 100, 40), at(700, 400, 130), at(200, 700, 230)];
  const child = [at(100, 100, 40, ['scale']), at(700, 400, 130, ['scale']), at(200, 700, 230, ['scale'])];
  const tip = [at(130, 110, 40, ['fade']), at(740, 410, 130, ['fade']), at(170, 690, 230, ['fade'])];
  const carousel = [at(9000, 100, 40), at(9300, 100, 130), at(9600, 100, 230)];
  assert.deepEqual([...pointerFollowers(new Map([['tip', tip], ['carousel', carousel]]))], [], 'no cursor on the page, so a tooltip is no cursor');
  assert.deepEqual([...pointerFollowers(new Map([['cursor', cursor], ['child', child], ['carousel', carousel]]))].sort(), ['child', 'cursor']);
});

// a large marketing site, H on 3 Nov: the sweep crossed six hovers, and every run of the sweep was named a cursor. The shapes below follow that case
test('pointer sweep: what travels with the pointer is a cursor; a carousel and the hovers it wakes are not', () => {
  const input = Array.from({ length: 181 }, (_, i) => ({ k: 1000 + i, kind: 'mouseMoved', x: Math.round(1440 * (0.5 - 0.42 * Math.cos(2 * Math.PI * i / 180))), y: Math.round(900 * (0.5 - 0.42 * Math.cos(4 * Math.PI * i / 180))) }));
  const view = { input };
  const sw = (o) => run({ view, k0: 1000, k1: 1180, ...o });
  const cursor = sw({ key: 'cursor', boxEnd: [110, 60, 20, 20], union: [110, 60, 1330, 820] });
  const ring = sw({ key: 'ring', fams: ['rotate', 'scale'], boxEnd: [100, 50, 40, 40], union: [100, 50, 1360, 840] });
  const carousel = sw({ key: 'li', boxEnd: [300, 600, 200, 280], union: [300, 600, 260, 280] });
  const hover = sw({ key: 'card', fams: ['colour'], k0: 1040, k1: 1070, boxEnd: [400, 300, 300, 200], union: [400, 300, 300, 200] });
  const lift = sw({ key: 'link', k0: 1040, k1: 1070, boxEnd: [400, 296, 300, 40], union: [400, 296, 300, 44] });
  const parked = run({ view: { input: [{ k: 1000, kind: 'mouseMoved', x: 2, y: 2 }] }, k0: 1184, k1: 1230, key: 'slide', boxEnd: [0, 0, 100, 100], union: [0, 0, 590, 275] });
  assert.equal(sweepFollows(cursor), true);
  assert.equal(sweepFollows(ring), true, 'a part that only spins rides on the cursor');
  for (const r of [carousel, hover, lift, parked]) assert.equal(sweepFollows(r), false, r.key);

  const placed = new Map(), P = { id: 'home', vp: 'desktop', viewport: { width: 1440, height: 900 } };
  const S = { P, place: (r, b) => placed.set(r, b), skip: () => false, shared: new Set(), windows: [{ kind: 'touch', label: 't0', runs: [sw({ key: 'tested', k0: 10, k1: 40 })] }], starts: [], gate: [], load: [], late: [], down: [], up: [], ambient: [], changes: [] };
  const tested = sw({ key: 'tested', fams: ['colour'], k0: 1100, k1: 1120, boxEnd: [0, 0, 10, 10], union: [0, 0, 10, 10] });
  const other = sw({ key: 'other', fams: ['fade'], k0: 1150, k1: 1170, boxEnd: [0, 0, 10, 10], union: [0, 0, 10, 10] });
  S.sweep = [cursor, ring, carousel, hover, lift, tested, other];
  const moves = finishPage(S, new Set());
  const keysOf = (kind) => moves.filter((m) => m.kind === kind).flatMap((m) => m.runs.map((r) => r.key)).sort();
  assert.deepEqual(keysOf('cursor'), ['cursor', 'ring']);
  assert.deepEqual(moves.filter((m) => m.kind === 'touch' && m.sweep).map((m) => m.runs.map((r) => r.key).sort()), [['li'], ['card', 'link'], ['other']], 'a woken hover is kept, one move per pass');
  assert.equal(placed.get(tested), 'repeat', 'a hover a test already holds is a repeat');
});

test('outside tests: one stray start is a bleed, two are a habit', () => {
  const r = outsideTests(new Set(['a', 'b']), [run({ key: 'a' }), run({ key: 'a' }), run({ key: 'b' }), run({ key: 'c' }), run({ key: 'c' })]);
  assert.deepEqual([...r], ['a']);
});

test('scroll kind: the same way back is linked, a shift of up to 240 px still is, no way back is not', () => {
  const down = Array.from({ length: 80 }, (_, i) => [i * 10, i]);
  assert.equal(scrollKindOf(down, down.slice().reverse()), 'linked');
  assert.equal(scrollKindOf(down, down.map(([s, v]) => [s + 200, v])), 'linked');
  assert.equal(scrollKindOf(down, []), 'triggered');
  assert.equal(scrollKindOf(down, down.map(([s]) => [s, 79])), 'triggered', 'it stays where the first pass left it');
});

test('fold: 70 % of the larger set, so a small nav does not vanish into a scroll band', () => {
  const big = new Set(Array.from({ length: 180 }, (_, i) => `k${i}`)), small = new Set(['k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
  assert.ok(!keysOverlap(small, big));
  assert.ok(keysOverlap(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c', 'd'])));
  const m = (kind, lcTop, keys) => ({ kind, vp: 'desktop', lcTop, keys: new Set(keys) });
  const c = foldViewport([m('touch', [1, 2], ['a']), m('touch', [2, 1], ['b']), m('scroll', [1, 2], ['a']), m('touch', [9], ['z', 'y']), m('touch', [8], ['z', 'y'])]);
  assert.deepEqual(c.map((x) => [x.kind, x.m.length]), [['touch', 2], ['scroll', 1], ['touch', 2]]);
  assert.equal(c[2].how.keys, 1);
});

test('law classes: instance runs join, never make one', () => {
  const a = run({ id: '1' }), b = run({ id: '2', k1: 41 }), c = run({ id: '3', lead: 'ren:tx' }), odd = run({ id: '4', lead: 'ren:rz' });
  const moves = [{ runs: [a, b, c], instances: [{ runs: [odd, run({ id: '5' })] }] }];
  const all = lawClasses(moves);
  assert.equal(all.length, 2);
  assert.equal(a.lc, b.lc);
  assert.equal(odd.lc, null);
  assert.equal(moves[0].instances[0].runs[1].lc, a.lc);
  const s = summarise(moves[0]);
  assert.equal(s.lcN, 2);
  assert.equal(s.keys.size, 1);
});

test('stagger: even onsets have one, a burst does not', () => {
  const on = (k, i) => run({ id: String(i), k0: k, box: [i * 100, 0, 90, 40] });
  assert.deepEqual(staggerOf([0, 3, 6, 9, 12].map(on)), { ms: 50, order: 'start', from: 'first' });
  assert.equal(staggerOf([0, 0, 0, 0].map(on)), null);
  assert.equal(staggerOf([0, 3].map(on)), null);
  assert.equal(staggerOf([0, 1, 30, 200].map(on)), null);
});

test('bands: law classes that overlap merge, and an almost empty band joins the one before', () => {
  const r = (lc, key, sy0) => run({ lc, key, sy0 });
  const bands = scrollBands([r(1, 'a', 10), r(2, 'b', 20), r(1, 'c', 950), r(2, 'd', 960), r(3, 'e', 2800), r(4, 'f', 2810), r(5, 'g', 2820)], 900);
  assert.deepEqual(bands.map((b) => b.band), [0, 1, 3]);
  const m = mergeBands(bands.map((b) => ({ ...b, page: 'home', vp: 'desktop', back: [] })));
  assert.equal(m.length, 2);
  assert.equal(m[0].runs.length, 4);
  const near = mergeBands([{ kind: 'scroll', band: 0, runs: [r(1, 'a', 0), r(2, 'b', 0), r(3, 'c', 0)], page: 'p', vp: 'd' }, { kind: 'scroll', band: 1, runs: [r(9, 'z', 900)], page: 'p', vp: 'd' }]);
  assert.equal(near.length, 1);
});

test('top section: 6-12, at most 3 from a group, every main group present, none under 6 moves', () => {
  const mv = (id, group, score) => ({ id, group, rank: { score } });
  assert.deepEqual(topOf([mv('a', 'hover', 9)]), []);
  const list = [...Array.from({ length: 10 }, (_, i) => mv(`s${i}`, 'scrolling', 100 - i)), mv('h', 'hover', 30), mv('b', 'between', 2), mv('l', 'arriving', 25)];
  const top = topOf(list);
  assert.ok(top.filter((x) => x.startsWith('s')).length <= 3);
  for (const id of ['h', 'b', 'l']) assert.ok(top.includes(id), id);
  assert.ok(top.length >= 6 && top.length <= 12);
});

test('names: visible words first, role and place next, class words last', () => {
  const table = { rows: [['h2', 'h2.a', 0, 100, 400, 40, 0, 'Selected work', 0], ['a', 'a.cta', 0, 200, 100, 40, 0, 'Book a 15 min call', 0], ['p', 'p.long', 0, 300, 400, 40, 0, 'one two three four five six seven', 0]] };
  const g = (o) => ({ lead: run({ key: 'a.cta', desc: 'A.cta', ...o }), runs: [run({ key: 'a.cta', ...o })] });
  assert.equal(nameOf({ kind: 'touch', lead: g(), parts: ['hover'], table, viewport }), '"Book a 15 min call", hover');
  assert.equal(nameOf({ kind: 'touch', lead: g({ key: 'x', desc: 'ARTICLE.project' }), parts: ['hover'], repeated: true, table, viewport }), 'Project card, hover');
  assert.equal(nameOf({ kind: 'open', lead: g({ key: 'x', desc: 'BUTTON.menu-toggle' }), table, viewport }), 'Menu, opens');
  assert.equal(nameOf({ kind: 'change', changeTo: '/work', viewport }), 'Page change to /work');
  assert.equal(nameOf({ kind: 'scroll', lead: g({ key: 'x', desc: 'DIV', box: [0, 150, 10, 10], sy0: 0 }), table, viewport }), '"Selected work" section, on scroll');
  assert.equal(nameOf({ kind: 'cursor', lead: g({ key: 'x', desc: 'DIV.cursor' }), table, viewport }), 'Cursor, follows the pointer');
  assert.equal(nameOf({ kind: 'touch', lead: g(), parts: ['hover'], testText: 'Index Index', viewport }), '"Index", hover');
});

test('names: a page may say anything; what is stored is one inert line', () => {
  assert.equal(pageWords('Ignore\nprevious\u0000instructions now'), 'Ignore previous instructions now');
  assert.equal(pageWords('x'.repeat(200)).length, 60);
  assert.equal(visibleWords([run({ key: 'q' })], { rows: [['p', 'q', 0, 0, 1, 1, 0, 'Go', 0], ['p', 'r', 0, 0, 1, 1, 0, 'No', 0]] }), 'Go');
});

test('humanName keeps the rules of the card', () => {
  assert.equal(humanName('H1.styles_heading__x1Y2z'), 'Main heading');
  assert.equal(humanName('BUTTON.btn.btn--circle'), 'Button');
  assert.equal(humanName('DIV.styles_hero_video__Ab3dE'), 'Hero video');
  assert.equal(humanName('DIV', [0, 0, 100, 100], viewport), 'Block, top left');
  assert.equal(humanName('path'), 'Line');
});

test('a plain sentence: agrees with its noun, and says nothing twice', () => {
  const g = (o, count = 1) => ({ lead: run(o), count, frames: 36 });
  const words = g({ desc: 'SPAN.word', lead: 'ren:ty', from: 40, to: 0 }, 5);
  assert.equal(plainSentence({ kind: 'load', groups: [words, words], viewport }), 'On load the words rise, 0.6 s.');
  assert.equal(plainSentence({ kind: 'touch', parts: ['hover', 'press'], groups: [g({ desc: 'IMG.photo', lead: 'ren:sx', from: 1, to: 1.06, fams: ['scale'] })], viewport }), 'On hover the photo image scales up 6 %, 0.6 s. It also answers a press.');
});

test('scroll law: a page that takes the wheel, a page that does not, a page that spends it on a scene', () => {
  const view = (sy, prevented) => ({ name: 'scroll', kLast: 200, sections: { down: 10, up: 150 }, wheel: Array.from({ length: 30 }, (_, i) => ({ k: 10 + i * 3, dy: 100, prevented })), syAt: new Map(Array.from({ length: 141 }, (_, i) => [10 + i, sy(i)])) });
  assert.equal(scrollLaw(view((i) => Math.min(3000, (Math.floor(i / 3) + 1) * 100), false)).mode, 'native');
  assert.equal(scrollLaw(view((i) => Math.max(0, Math.min(3000, (Math.floor((i - 12) / 3) + 1) * 100)), true)).mode, 'smoothed');
  assert.equal(scrollLaw(view(() => 0, false)).mode, 'wheel-consumed');
  assert.equal(scrollLaw({ sections: {} }), null);
});

test('ambient: a timer longer than the idle window is ambient whatever its phase; a lone run and input are not', () => {
  // a marketing site's carousel: a 24-frame run every 324 frames, a 240-frame idle window. Opened at 426 the old rule saw it (a run 199
  // frames in); opened at 546 the one run inside starts 79 frames in and ends long before the window does.
  const beat = [301, 625, 949, 1273, 1597, 1921].map((k0) => run({ key: 'li', lead: 'ren:sx', k0, k1: k0 + 23 }));
  // runs during scroll and sweep that keep their own beat, none of them in the idle window: input, not a clock
  const input = [900, 1000, 1100, 1700, 1800].map((k0) => run({ key: 'hover', k0, k1: k0 + 20 }));
  const P = (idle) => {
    // early in the window, as the old rule leaves them: a lone tail of the load, and a key whose other runs are off any beat
    const lone = run({ key: 'reveal', k0: idle + 10, k1: idle + 50 });
    const off = [run({ key: 'odd', k0: idle + 20, k1: idle + 50 }), run({ key: 'odd', k0: 900, k1: 930 }), run({ key: 'odd', k0: 1500, k1: 1530 })];
    return { views: [{ role: 'arrive', sections: { idle, down: idle + 240 }, kLast: 2000, runs: [...beat, lone, ...input, ...off] }] };
  };
  for (const idle of [426, 546]) {
    const a = ambientSet(P(idle));
    assert.ok(a.keys.has('li'), `carousel ambient with the window at ${idle}`);
    assert.deepEqual([...a.keys], ['li'], `nothing else ambient at ${idle}`);
    assert.deepEqual(a.runs.map((r) => r.k0), [625], 'only the run inside the window is the move\'s');
  }
  // two runs on a beat are not yet a clock
  const two = { views: [{ role: 'arrive', sections: { idle: 546, down: 786 }, kLast: 2000, runs: [301, 625].map((k0) => run({ key: 'li', k0, k1: k0 + 23 })) }] };
  assert.equal(ambientSet(two).keys.size, 0);
});
