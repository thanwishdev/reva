// The closing batch of the card (11 Nov, FINAL-PLAN WP-A): own numbers per group, the rise vote, stray groups, flips, names in
// prompts, rounded tokens, the shader line and the leak words. Pure: no take, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ownEnds, strayGroups } from '../src/scan/moves/fit.js';
import { clauseOf, NOT_A_MOVE } from '../src/scan/moves/intent.js';
import { arrivalShape, sentencesOf, tokensOf } from '../src/scan/moves/system.js';
import { renamePrompts } from '../src/scan/moves/same.js';
import { agentPrompt, promptWithName } from '../src/export/move.js';
import { glLayerClause } from '../src/scan/moves/glmove.js';
import { groupEnds } from '../src/scan/moves/index.js';

const rise = (from) => ({ property: 'y', channel: 'ren:ty', family: 'move', unit: 'px', from, to: 0, raw: { from, to: 0 }, follows: true });
const fade = () => ({ property: 'opacity', channel: 'ren:opacity', family: 'fade', unit: '', from: 0, to: 1, raw: { from: 0, to: 1 }, follows: true });

test('A1: a fade-led rise says its own y, not the exemplar\'s (one class, a 20 px group and a 50 px group)', () => {
  const exemplar = [rise(20), fade()], res = { leadChannel: 'ren:opacity', provenance: 'fitted' };
  const g50 = { lead: { channel: 'ren:opacity', part: null, from: 0, to: 1, ends: { 'ren:opacity': [0, 1], 'ren:ty': [50, 0] } } };
  const g20 = { lead: { channel: 'ren:opacity', part: null, from: 0, to: 1, ends: { 'ren:opacity': [0, 1], 'ren:ty': [20, 0] } } };
  const a = ownEnds(exemplar, g50, res), b = ownEnds(exemplar, g20, res);
  assert.deepEqual([a[0].from, a[0].to, a[0].fromExemplar], [50, 0, undefined]);
  assert.deepEqual([b[0].from, b[0].to, b[0].fromExemplar], [20, 0, undefined]);
  assert.equal(clauseOf(a[0], { many: true }), 'rise 50 px');
  assert.equal(clauseOf(b[0], { many: true }), 'rise 20 px');
  // keys the exemplar recorded scale onto the group's own ends
  const keyed = ownEnds([{ ...rise(20), follows: false, keys: [[0, 20], [300, 10], [600, 0]] }, fade()], g50, res);
  assert.deepEqual(keyed[0].keys, [[0, 50], [300, 25], [600, 0]]);
  // a declared law: the group's own ends, tidied as the site wrote them
  const dec = ownEnds([{ ...rise(20), raw: { from: 19.93, to: 0 } }, fade()], { lead: { ...g50.lead, ends: { 'ren:ty': [49.83, 0] } } }, { leadChannel: 'ren:opacity', provenance: 'declared' });
  assert.equal(dec[0].to, 0); assert.ok(Math.abs(dec[0].from - 50) <= 0.5, `declared own rise ${dec[0].from}`);
  // out and back: its own ends, the exemplar's furthest point moved with them, and says where the peak came from
  const still = { lead: { ...g50.lead, ends: { 'ren:ty': [0, 0] } } };
  const back = ownEnds([{ ...rise(0), peak: 12 }, fade()], still, res);
  assert.deepEqual([back[0].from, back[0].to, back[0].peak, back[0].peakFromExemplar, back[0].fromExemplar], [0, 0, 12, true, undefined]);
  // a plain change the group did not make: its own ends are equal, so it says no travel; a channel none of its runs changed goes
  assert.deepEqual([ownEnds([{ ...rise(-63) }, fade()], still, res)[0].from, ownEnds([{ ...rise(-63) }, fade()], still, res)[0].to], [0, 0]);
  assert.deepEqual(ownEnds(exemplar, { lead: { ...g50.lead, ends: { 'ren:opacity': [1, 0] } } }, res).map((c) => c.property), ['opacity']);
  // no own ends at all (an old scan): the exemplar's, marked
  assert.equal(ownEnds(exemplar, { lead: { channel: 'ren:opacity', from: 0, to: 1 } }, res)[0].fromExemplar, true);
  // a group's ends are what most of its runs did, the lead run's on a tie: one link of seven rose 20 px, six rose 50 px
  const runs = [{ ends: { 'ren:ty': [19.98, 0] } }, ...Array(6).fill(0).map(() => ({ ends: { 'ren:ty': [50.01, 0] } }))];
  assert.deepEqual(groupEnds(runs, runs[0])['ren:ty'], [50.01, 0]);
  assert.deepEqual(groupEnds(runs.slice(0, 2), runs[0])['ren:ty'], [19.98, 0]);
  // a box-led group (no lead values) still takes its own ends on its other channels
  assert.equal(ownEnds(exemplar, { lead: { channel: 'box', from: null, to: null, ends: { 'ren:ty': [50, 0] } } }, { leadChannel: 'box', provenance: 'fitted' })[0].from, 50);
});

test('A2: the rise is a vote of own y per arrival; a runner-up with half the votes is said with both counts and noted on the token', () => {
  const lead = (px) => ({ changes: [rise(px), fade()] });
  const s = arrivalShape([...Array(14).fill(0).map(() => lead(20)), ...Array(9).fill(0).map(() => lead(50)), { changes: [fade()] }]);
  assert.deepEqual([s.rise, s.riseN, s.riseAlt], [20, 14, { px: 50, n: 9 }]);
  assert.deepEqual(s.said, ['rise', 'fade in']);
  const sys = { shape: s };
  assert.deepEqual(sentencesOf(sys), ['Most arrivals rise and fade in: 14 rise 20 px, 9 rise 50 px.']);
  assert.match(tokensOf(sys).css, /--motion-rise: 20px; \/\* 9 of 24 arrivals rise 50 px \*\//);
  assert.match(tokensOf(sys).gsap, /rise: 20 \/\* 9 of 24 arrivals rise 50 px \*\//);
  assert.match(tokensOf(sys).motion, /export const rise = 20;   \/\/ y: \[20, 0\]; 9 of 24 arrivals rise 50 px/);
  // a clear winner: one number, no note
  const one = arrivalShape([...Array(10).fill(0).map(() => lead(50)), lead(20), lead(20)]);
  assert.deepEqual([one.rise, one.riseAlt, one.said], [50, undefined, ['rise 50 px', 'fade in']]);
  assert.doesNotMatch(tokensOf({ shape: one }).css, /\/\*.*rise/);
});

test('A3: a wrap at once across half the screen, and the always-running drift in another move, are no part of it', () => {
  const steps = { class: 'steps', ms: 0 }, at = (x) => ({ property: 'x', channel: 'ren:tx', family: 'move', from: 0, to: x });
  const wrap = { name: 'Ticker item', selector: 'ul > li', law: steps, changes: [at(3360)] };
  const small = { name: 'Dot', selector: 'i', law: steps, changes: [at(40)] };
  const drift = { name: 'Block', selector: 'div.tick', selectors: ['div.tick'], law: { class: 'keyframes', ms: 16116 }, changes: [at(-0.75)] };
  const button = { name: 'Button', selector: 'button', law: { class: 'tween', ms: 150 }, changes: [fade()] };
  const out = strayGroups({ kind: 'open' }, [drift, button, wrap, small], { width: 1440, ambient: new Set(['div.tick']) });
  assert.deepEqual([...out].map(([g, why]) => [g.name, why]), [['Block', 'drift'], ['Ticker item', 'wrap']]);
  // the always-running move keeps its own drift; no width, no wrap rule; a short recorded group stays
  assert.deepEqual([...strayGroups({ kind: 'ambient' }, [drift], { width: 1440, ambient: new Set(['div.tick']) })], []);
  assert.deepEqual([...strayGroups({ kind: 'open' }, [wrap], {})], []);
  assert.deepEqual([...strayGroups({ kind: 'open' }, [{ ...drift, law: { class: 'keyframes', ms: 1500 } }], { ambient: new Set(['div.tick']) })], []);
  assert.match(NOT_A_MOVE.placement, /no motion of its own/);
});

test('A4: a scale that changes sign flips, never "scales down 200 %"', () => {
  const sc = (from, to, peak) => ({ property: 'scaleY', channel: 'ren:sy', family: 'scale', from, to, ...(peak != null ? { peak } : {}) });
  assert.equal(clauseOf(sc(1, -1)), 'flips');
  assert.equal(clauseOf(sc(1, 1, -1)), 'flips and back');
  assert.equal(clauseOf(sc(-1, 1), { many: true }), 'flip');
  assert.equal(clauseOf(sc(1, 0.5)), 'scales down 50 %');
});

test('A5: each prompt says the name the list shows, a phone file the name of its move', () => {
  const p = (name) => agentPrompt({ name, sentence: 'x', trigger: { kind: 'hover' }, groups: [] });
  const docs = new Map([['m-1', { id: 'm-1', prompt: p('Block, hover') }], ['m-1p', { id: 'm-1p', prompt: p('Block 2, hover') }], ['m-2', { id: 'm-2', prompt: p('Logo, hover') }]]);
  const index = { moves: [{ id: 'm-1', name: 'Card lifts, hover', phone: { id: 'm-1p' } }, { id: 'm-2', name: 'Logo, hover', phone: { id: null } }] };
  const saved = [];
  assert.equal(renamePrompts(index, docs, (d) => saved.push(d.id)), 2);
  assert.deepEqual(saved, ['m-1', 'm-1p']);
  for (const id of ['m-1', 'm-1p']) assert.match(docs.get(id).prompt, /^Name: Card lifts, hover$/m);
  assert.equal(promptWithName('no name line', 'X'), 'no name line');
});

test('A6: durations in steps of 10 ms, one literal each, the scroll range and its middle in the sentence and the tokens', () => {
  const sys = { tempo: { fast: 150, typical: 400, slow: 620, n: 9, arrive: 620, pointer: 344 }, scroll: { triggered: 19, linked: 3, startPct: 76, startShare: 0.25, startRange: [64, 90] } };
  const t = tokensOf(sys), lits = [...t.css.matchAll(/--motion-duration[\w-]*: (\d+)ms;/g)].map((m) => +m[1]);
  assert.ok(lits.every((x) => x % 10 === 0), lits.join());
  assert.equal(new Set(lits).size, lits.length);
  assert.match(t.css, /--motion-duration-arrive: var\(--motion-duration-slow\);/);
  assert.match(t.css, /--motion-duration-pointer: 340ms;/);
  assert.doesNotMatch(`${t.gsap}\n${t.motion}`, /\d\.\d{3,}/);
  const scroll = sentencesOf(sys).find((x) => /On scroll/.test(x));
  assert.match(scroll, /64 to 90 % of the screen, 76 % in the middle/);
  assert.match(t.gsap, /scrollStart: "top 76%" \};   \/\/ starts run 64-90 %/);
  assert.match(t.motion, /starts at 76 % of the screen; starts run 64-90 %/);
});

test('A8, A9: the WebGL layer sentence leaves program switches to the spec; the shader line is one calm sentence', () => {
  assert.equal(glLayerClause({ cover: 1, engine: 'three.js', switchAtMs: 20 }), 'a full-screen WebGL layer (three.js) keeps drawing');
  const p = agentPrompt({ name: 'Hero', sentence: 'x', trigger: { kind: 'load' }, groups: [], shaders: [{ programs: ['p1'], hash: 'ab', vs: 'void main(){}', fs: 'void main(){}' }] }, { file: 'moves/m-1.json' });
  const line = p.split('\n').find((l) => l.startsWith('Shader sources'));
  assert.equal(line, "Shader sources (not in this text): moves/m-1.json keeps them on this machine (each shaders entry's vs and fs JSON path) as reference for how the effect is built; it is the site's own code, so write your own shader for this motion.");
  assert.doesNotMatch(line, /do not copy|reference only/i);
  assert.doesNotMatch(p, /void main/);
});

test('A10: the scan-side comments name no site', () => {
  for (const f of ['same.js', 'name.js']) assert.doesNotMatch(fs.readFileSync(new URL(`../src/scan/moves/${f}`, import.meta.url), 'utf8'), /\b[a-z0-9-]+\.(?:com|io|co|net|org|app|dev)\b/, "no site hostname in comments");
});
