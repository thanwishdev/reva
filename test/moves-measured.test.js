// ZD (11 Nov): the card states travel numbers and a move's time only from measured parts (fitted, or declared and confirmed by a fit).
// A part recorded frame by frame keeps its numbers in the details; the headline says what changes; a stretched window gives no time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeMove } from '../src/scan/moves/close.js';
import { isMeasured, sentenceOf, spanOf, travels } from '../src/scan/moves/intent.js';

const slide = (px) => ({ property: 'x', channel: 'ren:bx', family: 'move', unit: 'px', from: 0, to: px, follows: false });
const drop = (px) => ({ property: 'y', channel: 'ren:ty', family: 'move', unit: 'px', from: 0, to: px, follows: true });
const sampled = (o = {}) => ({ name: 'Div block', elements: ['DIV'], count: 10, role: 'lead', changes: [slide(934.4)], provenance: 'sampled', law: { class: 'keyframes', ms: 600, delayMs: 0, points: [[0, 0], [600, 1]], errorPct: 0 }, pts: [], ...o });
const fitted = (o = {}) => ({ name: 'Heading', elements: ['H2'], count: 1, role: 'part', changes: [drop(40)], provenance: 'fitted', law: { class: 'tween', ms: 800, delayMs: 0, declared: 'cubic-bezier(0.6, 0, 0.05, 1)' }, pts: [], ...o });
const spec = (groups) => ({ kind: 'touch', trigger: { kind: 'hover' }, scroll: null, groups, name: 'Div block' });

test('a sampled 934 px part never reaches the headline or the duration', () => {
  const g = sampled({ law: { ...sampled().law, stretched: true } });
  assert.equal(isMeasured(g), false);
  const s = sentenceOf(spec([g]), [g]);
  assert.ok(!/934|\d px|\d s\b/.test(s), s);
  assert.match(s, /slide right/);
  const entry = { id: 'm-1', sentence: s, time: { ms: 600 } };
  const out = closeMove(entry, spec([g]));
  assert.equal(entry.time.ms, undefined);
  assert.equal(entry.time.windowMs, 600);
  assert.ok(!/\d+ ms\b(?! stagger)/.test(out.timing), out.timing);
  // the details keep the recorded number
  assert.match(g.recipe, /934\.4 px/);
});

test('a sampled part whose window is not stretched gives its window as the time, still with no travel number', () => {
  const g = sampled();
  const s = sentenceOf(spec([g]), [g]);
  assert.ok(!/934/.test(s), s);
  assert.match(s, /0\.6 s\.$/);
  const entry = { id: 'm-2', sentence: s, time: {} };
  closeMove(entry, spec([g]));
  assert.equal(entry.time.ms, 600);
});

test('a measured part still states its travel and its time, ahead of a sampled lead', () => {
  const lead = sampled({ law: { ...sampled().law, stretched: true } }), part = fitted();
  assert.equal(isMeasured(part), true);
  const s = sentenceOf(spec([lead, part]), [lead, part]);
  assert.match(s, /drops 40 px/);
  assert.ok(!/934/.test(s), s);
  assert.match(s, /0\.8 s\.$/);
  const entry = { id: 'm-3', sentence: s, time: {} };
  const out = closeMove(entry, spec([lead, part]));
  assert.equal(entry.time.ms, 800);
  assert.match(out.timing, /^800 ms, cubic-bezier/);
  assert.deepEqual(spanOf([lead, part]).g, part);
});

test('travels: a smooth drift moves, a one-frame step does not, a FLIP glides back', () => {
  const T = [0, 17, 33, 50, 67, 83, 100];
  assert.equal(travels(T, [0, 10, 25, 45, 70, 90, 100]), true);
  assert.equal(travels(T, [0, 931, 932, 933, 934, 934, 934]), false);
  assert.equal(travels(T, [0, 138, 100, 60, 25, 5, 0]), true);
});
