// The move contract (src/scan/moves/contract.js) and the synthetic take builder the other move tests stand on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTake } from '../src/record/take.js';
import {
  BUCKETS, GAPS, GROUPS, KIND, KINDS, MODEL, MOVE_ID, RANK, SCHEMA, STOP, emptyTally, familyOf, framesOf, groupOf, identity, indexProblems, isBoxChannel, lawSignature,
  moveFileProblems, moveId, moveProblems, parseMark, playOf, pxEquivalent, rankScore, sameLaw, selectorGroup, STATUS, tallyProblems, moveStatus,
} from '../src/scan/moves/contract.js';
import { SYNTH_TRUTH, easeOut, synthSite, synthTake, writeUnit } from './helpers/synthtake.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-moves-'));
const run = (o = {}) => ({ fams: ['fade'], lead: 'ren:opacity', k0: 10, k1: 40, amp: 0.5, shape: Array.from({ length: 13 }, (_, i) => Math.round((i / 12) * 20) / 20), ...o });

test('constants: frames from milliseconds at the rate of the rows', () => {
  assert.equal(framesOf(MODEL.quietMs), 12); assert.equal(framesOf(MODEL.burstGapMs), 18); assert.equal(framesOf(MODEL.lagSpreadMs), 18);
  assert.equal(STOP.quiet.hover, 18); assert.equal(STOP.quiet.focus, 12); assert.equal(STOP.lateQuiet, framesOf(2000));
});

test('kinds: all twelve have a group, a weight and a way to play; a scene follows its driver', () => {
  assert.equal(KINDS.length, 12);
  for (const k of KINDS) { assert.ok(GROUPS.some((g) => g.id === KIND[k].group), k); assert.ok(KIND[k].weight > 0, k); }
  assert.equal(groupOf('scene', 'scroll'), 'scrolling'); assert.equal(playOf('scene', 'scroll'), 'scrub');
  assert.equal(groupOf('scene', 'time'), 'always'); assert.equal(playOf('scene'), 'loop');
  assert.equal(playOf('scroll'), 'scrub'); assert.equal(playOf('touch'), 'hover'); assert.equal(playOf('change'), 'once');
});

test('own motion: every family, and what is not motion', () => {
  const want = { 'ren:tx': 'move', 'ren:ty': 'move', 'ren:sx': 'scale', 'ren:rz': 'rotate', 'ren:skx': 'rotate', 'ren:opacity': 'fade', 'ren:color': 'colour', 'ren:bg': 'colour', 'ren:fill': 'colour', 'ren:stroke': 'colour', 'ren:clipPath': 'clip', 'ren:maskPos': 'clip', 'ren:filter': 'filter', 'ren:wght': 'font', 'ren:fvar.GRAD': 'font', 'ren:radius': 'radius', 'ren:dash': 'dash', 'ren:--p': 'var' };
  for (const [c, f] of Object.entries(want)) assert.equal(familyOf(c), f, c);
  for (const c of ['drv:transform', 'drv:--p', 'ren:transform', 'ren:tz', 'ren:z', 'ren:bx', 'ren:bh']) assert.equal(familyOf(c), null, c);
  assert.ok(isBoxChannel('ren:by')); assert.ok(!isBoxChannel('ren:ty'));
});

test('own motion: background position is its own family, not colour (the prototype read ren:bgPos as ren:bg)', () => {
  assert.equal(familyOf('ren:bgPos'), 'bgpos'); assert.equal(familyOf('ren:bg'), 'colour');
});

test('own motion: the individual transform properties count, computed transform does not hold them', () => {
  assert.equal(familyOf('ren:translate'), 'move'); assert.equal(familyOf('ren:scale'), 'scale'); assert.equal(familyOf('ren:rotate'), 'rotate');
});

test('own motion: a count-up and the discovery text channel make runs', () => {
  assert.equal(familyOf('ren:text'), 'text'); assert.equal(familyOf('ren:chars'), 'text');
});

test('px-equivalents: opacity and scale × 300, degrees × 3, the rest as they are', () => {
  assert.equal(pxEquivalent('ren:opacity', 0.5), 150); assert.equal(pxEquivalent('ren:scale', 0.02), 6); assert.equal(pxEquivalent('ren:rz', 2), 6); assert.equal(pxEquivalent('ren:ty', 7), 7);
});

test('law class: same families, lead, length within 15 % (2 frames at least), shape within 0.1', () => {
  assert.ok(sameLaw(run(), run({ k1: 44 })), 'length within 15 %');
  assert.ok(!sameLaw(run(), run({ k1: 60 })), 'too long');
  assert.ok(sameLaw(run({ k0: 0, k1: 6 }), run({ k0: 0, k1: 8 })), 'two frames always pass');
  assert.ok(!sameLaw(run(), run({ lead: 'ren:ty' }))); assert.ok(!sameLaw(run(), run({ fams: ['fade', 'move'] })));
  assert.ok(sameLaw(run({ fams: ['move', 'fade'] }), run({ fams: ['fade', 'move'] })), 'order of families does not count');
  assert.ok(sameLaw(run({ shape: null, lead: null }), run({ shape: null, lead: null }))); assert.ok(!sameLaw(run(), run({ shape: null })));
});

test('law class: a shape exactly 0.1 away passes wherever it lies on the 0.05 grid', () => {
  const at = (x) => Array(13).fill(x);
  for (const [a, b] of [[0.7, 0.8], [0.2, 0.3], [0.35, 0.45], [0.55, 0.65]]) assert.ok(sameLaw(run({ shape: at(a) }), run({ shape: at(b) })), `${a} ${b}`);
  assert.ok(!sameLaw(run({ shape: at(0.7) }), run({ shape: at(0.85) })));
});

test('identity: amplitude to 2 digits, order of families ignored, length exact', () => {
  assert.equal(identity(run({ amp: 12.34 })), identity(run({ amp: 12.31, fams: ['fade'] })));
  assert.notEqual(identity(run()), identity(run({ k1: 41 })));
  assert.equal(identity(run({ fams: ['b', 'a'] })), identity(run({ fams: ['a', 'b'] })));
});

test('move id: stable, 8 hex, members of a list share it, a frame or two does not change it', () => {
  const a = moveId('touch', 'ul > li:nth-of-type(1) a', 'sig');
  assert.match(a, MOVE_ID); assert.equal(a, moveId('touch', 'ul > li:nth-of-type(7) a', 'sig'));
  assert.notEqual(a, moveId('load', 'ul > li:nth-of-type(1) a', 'sig'));
  assert.equal(selectorGroup('a:nth-child(2)  > b:nth-of-type(3)'), 'a > b');
  assert.equal(lawSignature(run({ k1: 70 })), lawSignature(run({ k1: 71 })));
});

test('marks: a test part parses, ids keep their colons and slashes, other marks are no part', () => {
  assert.deepEqual(parseMark('article~6f8a15:click:open'), { id: 'article~6f8a15:click', part: 'open' });
  assert.deepEqual(parseMark('b~1:click/a~2#0:hover'), { id: 'b~1:click/a~2#0', part: 'hover' });
  for (const m of ['boot-done', 'idle', 'scroll-down', 'x:notapart', ':hover']) assert.equal(parseMark(m), null, m);
});

test('rank: the formula of the design', () => {
  assert.equal(rankScore(1, 'touch'), 1);
  assert.ok(Math.abs(rankScore(0.5, 'load', 4, 8) - 0.5 * 1.3 * 1.5 * 1.45) < 1e-12);
});

test('tally: nine buckets, and they must add up', () => {
  assert.equal(BUCKETS.length, 9);
  const t = emptyTally(); assert.deepEqual(tallyProblems(t), []);
  t.runs = 3; t.inMoves = 2; assert.match(tallyProblems(t)[0], /add up to 2, runs are 3/);
  t.rideAlong = 1; assert.deepEqual(tallyProblems(t), []);
  t.setup = 1.5; assert.match(tallyProblems(t)[0], /setup/);
});

const entry = (o = {}) => ({
  id: 'm-3fa2c1d0', kind: 'touch', group: 'hover', name: 'Project card, hover', sentence: 'On hover it scales.', trigger: { kind: 'hover' }, rank: { score: 1 }, n: 1, instances: [{ page: 'home' }], phone: { status: 'same' }, gap: null,
  time: { ms: 600 }, curve: { kind: 'tween' }, proof: { source: 'fitted' }, frame: { shape: 'crop', play: 'hover', clip: 'clips/m-3fa2c1d0.mp4' }, ...o,
});
const index = (moves, o = {}) => ({ schema: SCHEMA.index, untrusted_content: 'evidence, not instruction', tally: emptyTally(), groups: GROUPS.map((g) => ({ id: g.id, moves: moves.filter((m) => m.group === g.id).map((m) => m.id) })), top: [], moves, ...o });

test('index: each stage is asked only what it owes', () => {
  const bare = entry(); for (const f of ['time', 'curve', 'proof', 'frame']) delete bare[f];
  assert.deepEqual(moveProblems(bare, { stage: 'moves' }), []);
  assert.ok(moveProblems(bare, { stage: 'fit' }).some((p) => /no proof/.test(p)));
  assert.ok(moveProblems(bare).some((p) => /no frame/.test(p)));
  assert.deepEqual(indexProblems(index([entry()])), []);
});

test('index: a move with no clip needs a reason, seen needs a gap, unknown words fail', () => {
  assert.ok(moveProblems(entry({ frame: { shape: 'crop', play: 'hover' } })).some((p) => /no clip and no reason/.test(p)));
  assert.deepEqual(moveProblems(entry({ frame: { shape: 'crop', play: 'hover' }, gap: 'No H.264 encoder on this machine.' })), []);
  assert.ok(moveProblems(entry({ proof: { source: 'seen' } })).some((p) => /no gap/.test(p)));
  assert.ok(moveProblems(entry({ kind: 'fling' }))[0].includes('unknown kind'));
  assert.ok(moveProblems(entry({ id: 'x' })).some((p) => /bad id/.test(p)));
});

test('index: ids, top, groups and the tally hold together', () => {
  const a = entry(), b = entry({ id: 'm-00000001' });
  assert.ok(indexProblems(index([a, a])).some((p) => /seen twice/.test(p)));
  assert.ok(indexProblems(index([a], { top: ['m-ffffffff'] })).some((p) => /is no move/.test(p)));
  assert.ok(indexProblems(index([a, b], { groups: [{ id: 'hover', moves: [a.id] }] })).some((p) => /m-00000001: in 0 groups/.test(p)));
  assert.ok(indexProblems(index([a], { top: Array(RANK.topMin - 1).fill(a.id) })).some((p) => /wanted 6-12/.test(p)));
  assert.ok(indexProblems(index([a], { tally: { ...emptyTally(), runs: 1 } })).some((p) => /add up/.test(p)));
  assert.match(indexProblems({ schema: 'reva.moves/0' })[0], /schema/);
});

test('move file: limits, provenance, law and code', () => {
  const g = { name: 'Image', elements: [], provenance: 'fitted', law: { class: 'tween' }, dots: [], curve: [] };
  const doc = { schema: SCHEMA.move, id: 'm-3fa2c1d0', groups: [g], code: { css: '' } };
  assert.deepEqual(moveFileProblems(doc), []);
  assert.ok(moveFileProblems({ ...doc, groups: [{ ...g, dots: Array(91).fill([0, 0]) }] }).some((p) => /dots/.test(p)));
  assert.ok(moveFileProblems({ ...doc, groups: [{ ...g, law: null }] }).some((p) => /no law/.test(p)));
  assert.ok(moveFileProblems({ ...doc, code: null }).some((p) => /no code/.test(p)));
  assert.deepEqual(moveFileProblems({ ...doc, code: null, groups: [{ ...g, law: null, provenance: 'seen' }] }), []);
  assert.deepEqual(moveFileProblems({ ...doc, groups: [{ name: 'x' }] }, { stage: 'moves' }), []);
});

test('synth: a take reads back through loadTake as a recorded one does', () => {
  const root = tmp();
  const t = synthTake({ name: 'load', frames: 60 });
  const a = t.el('DIV.a', { selector: 'div.a', box: [10, 20, 100, 50] }); const b = t.el('DIV.b', { gone: true });
  t.ramp(a, 'ren:ty', { k0: 10, k1: 40, from: 30, to: 0, ease: easeOut }).styleWrite(a, 10).birth(a, { k: 10, duration: 500 }).pointer('mouseMoved', 5, 6, 12).mark('idle', 20).phase('load', 1, 60);
  const { take: dir } = t.write(root);
  const L = loadTake(dir, ['rows', 'births', 'mutations', 'elements', 'inputLog']);
  assert.equal(L.take.schema, 'reva.take/0'); assert.equal(L.take.validation.ok, true, L.take.validation.problems.join()); assert.equal(L.take.series.rows.encoding, 'delta/1');
  assert.equal(L.data.rows.length, 60); assert.deepEqual(L.data.elements, ['DIV.a', 'DIV.b']);
  const r25 = L.data.rows[24]; assert.equal(r25.k, 25); assert.ok(Math.abs(r25.T - (25 * 1000) / 60) < 1e-5);
  assert.ok(r25.v[a]['ren:ty'] > 0 && r25.v[a]['ren:ty'] < 30); assert.equal(L.data.rows[59].v[a]['ren:ty'], 0);
  assert.equal(r25.v[a]['ren:by'], 20 + r25.v[a]['ren:ty'], 'the box follows the transform'); assert.match(r25.v[a]['ren:transform'], /^matrix/);
  assert.equal(L.data.rows[1].v[b], L.data.rows[0].v[b], 'a still element shares its object: readers skip it by identity');
  assert.deepEqual(L.data.mutations, [[10, 0, a, 0]]); assert.equal(L.data.births[0].el, a); assert.equal(L.data.inputLog.length, 2);
  assert.deepEqual(L.take.marks.map((m) => [m.name, m.k]), [['idle', 20]]);
  assert.deepEqual(L.take.selectors, [[a, 'div.a', 1, 0], [b, null, 1, 1]]);
  assert.equal(L.take.env.viewport.value.width, 1440);
});

test('synth: scrolling moves the box of what scrolls, a fixed element stays, a child rides its parent', () => {
  const t = synthTake({ frames: 40 });
  const a = t.el('DIV.a', { box: [0, 100, 10, 10] }), f = t.el('DIV.f', { box: [0, 100, 10, 10], fixed: true }), p = t.el('DIV.p', { box: [0, 0, 10, 10] }), c = t.el('DIV.c', { box: [0, 50, 20, 20], parent: p });
  t.scroll(10, 20, 0, 200).ramp(p, 'ren:ty', { k0: 25, k1: 35, from: 0, to: 40 }).ramp(p, 'ren:sx', { k0: 25, k1: 35, from: 1, to: 2 });
  const rows = t.rows(), end = rows.at(-1);
  assert.equal(end.sy, 200); assert.equal(end.v[a]['ren:by'], -100); assert.equal(end.v[f]['ren:by'], 100);
  assert.equal(end.v[c]['ren:by'], 50 + 40 - 200, 'the child moved'); assert.equal(end.v[c]['ren:bw'], 40); assert.equal(end.v[c]['ren:ty'], 0, 'with no channel of its own');
});

test('synth: a string channel, a shared uniform, an escape', () => {
  const root = tmp();
  const t = synthTake({ name: 'x', frames: 20 }); const a = t.el('CANVAS.c', { why: 'canvas' });
  t.ramp(a, 'ren:bg', { k0: 2, k1: 10, fn: (p) => `rgb(${Math.round(p * 255)}, 0, 0)` }).uniform('p1|uTime', (k) => k / 60).canvas(a, { programs: [{ id: 1, uniforms: [] }] }).escape('media-element', 'on the media clock');
  const { take: dir } = t.write(root);
  const L = loadTake(dir, ['rows']);
  assert.equal(L.data.rows[9].v[a]['ren:bg'], 'rgb(255, 0, 0)'); assert.equal(L.data.rows[19].gl['p1|uTime'], 20 / 60);
  assert.equal(L.take.gl.contexts[0].el, a); assert.equal(L.take.escapes['media-element'].count, 1);
});

test('synth: a new document restarts k and T; a stored take lost what came before, a drained one keeps both segments', () => {
  const build = (lost) => { const t = synthTake({ name: 'change-0', frames: 30 }); t.el('DIV.a'); t.mark('change', 12).mark('later', 25).newDocument(21, { lost }); return t; };
  const drained = loadTake(build(false).write(tmp()).take, ['rows']);
  assert.equal(drained.data.rows.length, 30); assert.equal(drained.data.rows[20].k, 1); assert.equal(drained.data.rows[19].k, 20);
  assert.deepEqual(drained.take.marks.map((m) => [m.name, m.k]), [['change', 12], ['later', 5]]);
  const stored = loadTake(build(true).write(tmp()).take, ['rows']);
  assert.equal(stored.data.rows.length, 10); assert.equal(stored.data.rows[0].k, 1);
  assert.deepEqual(stored.take.marks.map((m) => m.name), ['later'], 'the mark before the change died with the document');
});

test('synth: frames.json holds phases in its own rows; a gated phase keeps the floor', () => {
  const t = synthTake({ name: 'p', frames: 100 }); t.el('DIV.a');
  t.phase('whole', 1, 40).phase('gated', 41, 100, { gated: true });
  const { frames } = t.write(tmp());
  const j = JSON.parse(fs.readFileSync(path.join(frames, 'frames.json'), 'utf8'));
  assert.deepEqual(j.cols, ['k', 'T', 'sy', 'f']); assert.deepEqual(j.phases, [{ name: 'whole', from: 0, to: 40 }, { name: 'gated', from: 40, to: 44 }]);
  assert.equal(j.rows[40][0], 41); assert.equal(j.rows[41][0], 56, 'every 15 frames');
});

test('synth: unit records sit beside the takes', () => {
  const root = tmp(); writeUnit(root, 'phone', 'patterns', { tests: [] });
  assert.ok(fs.existsSync(path.join(root, 'takes', 'phone', 'patterns.unit.json')));
});

test('synth site: stored and arrive forms hold the takes a real scan holds, every take valid', () => {
  const stored = tmp(), arrive = tmp();
  assert.deepEqual(synthSite(stored), ['load', 'idle', 'scroll', 'patterns', 'opens-0', 'opens-1', 'change-0']);
  assert.deepEqual(synthSite(arrive, { form: 'arrive' }), ['arrive', 'patterns', 'opens-0', 'opens-1', 'change-0']);
  for (const root of [stored, arrive]) for (const n of fs.readdirSync(path.join(root, 'takes', 'desktop'))) {
    if (n.endsWith('.unit.json')) continue;
    const L = loadTake(path.join(root, 'takes', 'desktop', n)); assert.equal(L.take.validation.ok, true, n);
    assert.ok(fs.existsSync(path.join(root, 'frames', 'desktop', n, 'frames.json')), n);
  }
  const fr = JSON.parse(fs.readFileSync(path.join(arrive, 'frames', 'desktop', 'arrive', 'frames.json'), 'utf8'));
  assert.deepEqual(fr.phases.map((p) => p.name), ['load', 'idle', 'scroll-down', 'scroll-up', 'pointer-sweep']);
});

test('synth site: everything the truth names is on the page, in invented names only', () => {
  const root = tmp(); synthSite(root);
  const seen = new Set();
  for (const n of fs.readdirSync(path.join(root, 'takes', 'desktop'))) { if (n.endsWith('.unit.json')) continue; for (const d of loadTake(path.join(root, 'takes', 'desktop', n), ['elements']).data.elements) seen.add(d); }
  for (const [what, list] of Object.entries(SYNTH_TRUTH)) for (const d of list) assert.ok(seen.has(d), `${what}: ${d}`);
  const units = fs.readFileSync(path.join(root, 'takes', 'desktop', 'opens.unit.json'), 'utf8');
  assert.match(units, /synth\.test/); assert.doesNotMatch(units, /https?:\/\/(?!synth\.test)/);
});

test('one status per move, from its proof: Exact, Measured, Recorded, Pictures only; declared always wins', () => {
  const clip = { clip: 'clips/m.mp4' };
  const exact = moveStatus({ proof: { source: 'declared', via: 'gsap' }, gap: GAPS.noLaw, frame: clip });
  assert.deepEqual([exact.key, exact.word, exact.line, exact.note, exact.reason, exact.clip], ['exact', STATUS.exact, "Read from the site's own GSAP code.", null, null, null], 'a stale no-law gap says nothing');
  assert.equal(moveStatus({ proof: { source: 'declared' } }).line, "Read from the site's own CSS.");
  assert.equal(moveStatus({ proof: { source: 'declared', via: 'lottie' }, gap: GAPS.noRows }).reason, null, 'declared: never a reason values are missing');

  const measured = moveStatus({ proof: { source: 'fitted', errorPct: 1.41, frames: 62 }, gap: null });
  assert.deepEqual([measured.key, measured.word, measured.line, measured.note], ['measured', 'Measured', 'Fitted to all 62 recorded frames, within 1.4 %.', null]);
  assert.equal(moveStatus({ proof: { source: 'fitted', errorPct: null } }).line, 'Fitted to the recorded frames.');
  assert.equal(moveStatus({ proof: { source: 'fitted', errorPct: 0.25 } }).line, 'Fitted to the recorded frames, within 0.25 %.');

  const rec = moveStatus({ proof: { source: 'sampled', errorPct: 1 }, gap: GAPS.noLaw, frame: clip });
  assert.deepEqual([rec.key, rec.word, rec.note, rec.reason, rec.clip], ['recorded', 'Recorded', 'Copy replays the recorded path frame by frame.', null, null], 'the no-law gap is the status, not a gap');

  const pics = moveStatus({ proof: { source: 'seen' }, gap: `${GAPS.canvas} One thing drives its values.`, frame: clip });
  assert.deepEqual([pics.key, pics.word, pics.reason, pics.line], ['pictures', 'Pictures only', `${GAPS.canvas} One thing drives its values.`, 'The clip shows it as it ran.']);
  assert.equal(moveStatus({ proof: { source: 'seen' } }).reason, GAPS.noRows, 'no gap sentence: the plain one');
  assert.equal(moveStatus({ proof: { source: 'seen' }, frame: { clip: null } }).line, null, 'no clip: nothing claimed about one');
  assert.equal(moveStatus({}).key, 'pictures', 'no proof: pictures only');

  const morph = moveStatus({ proof: { source: 'fitted', errorPct: 2 }, gap: GAPS.morph });
  assert.equal(morph.key, 'measured'); assert.match(morph.note, /^Copy gives the timing/); assert.equal(morph.clip, null);
  const noEncoder = moveStatus({ proof: { source: 'sampled' }, gap: 'No H.264 encoder on this machine.' });
  assert.equal(noEncoder.clip, 'No H.264 encoder on this machine.', 'a gap about the clip goes where the clip would be');
});

test('the contract: a declared or fitted move never carries "no simple curve fits"', () => {
  const m = { id: 'm-3fa2c1d0', kind: 'touch', group: 'hover', name: 'x', sentence: 'x', trigger: { kind: 'hover' }, rank: { score: 1 }, n: 1, instances: [{ page: 'home' }], phone: { status: 'same' }, time: { ms: 1 }, curve: { kind: 'tween' } };
  assert.match(moveProblems({ ...m, proof: { source: 'declared' }, gap: GAPS.noLaw }, { stage: 'fit' }).join(), /no curve fits/);
  assert.deepEqual(moveProblems({ ...m, proof: { source: 'sampled' }, gap: GAPS.noLaw }, { stage: 'fit' }), []);
});
