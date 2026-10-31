import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mechanismsFromFit, planSpecimens, channelOf, parseEase, unitPeakSlope, casesFromLabTruth, integratorFromHyp } from '../normalize.js';
import { specimensFromFit, specimensFromLabTruth, labSpecimenSet, LAB_TIME_TRUTH } from '../index.js';
import { K } from '../kernel.js';
import { labRoot } from './helpers.js';

// A synthetic reva.motion/0 record (shape per docs/design/M2-fitter.md §10 and the fitter's real output).
const P = (value, provenance = 'fitted') => ({ value, provenance });
const rec = (o) => ({ schema: 'reva.motion/0', target: { el: 0, desc: 'DIV.b0', channel: 'ren:tx', untrusted_content: true }, attribution: null, tier: 'fitted', class: 'tween',
  model: { family: 'named:easeOutCubic', params: {}, integrator: null, law: 'time-based', valid_at: { frame_ms: 1000 / 120, refresh_hz: 120 } }, derived: {}, fit: {}, unknowns: [], flags: [], evidence: {}, ...o });
const withModel = (r, model) => ({ ...r, model: { ...r.model, ...model } });

test('parseEase understands names, CSS strings, arrays and specs', () => {
  assert.deepEqual(parseEase('cubic-bezier(0.2, 0.9, 0.3, 1)'), { kind: 'bezier', p: [0.2, 0.9, 0.3, 1] });
  assert.deepEqual(parseEase([0.1, 0.2, 0.3, 0.4]), { kind: 'bezier', p: [0.1, 0.2, 0.3, 0.4] });
  assert.deepEqual(parseEase('easeOutCubic'), { kind: 'named', name: 'easeOutCubic' });
  assert.deepEqual(parseEase('steps(3, jump-start)'), { kind: 'steps', n: 3, pos: 'jump-start' });
  assert.equal(parseEase('linear-flat').kind, 'linear'); assert.equal(parseEase('nonsense'), null);
  assert.deepEqual(parseEase('linear(0, 0.5 25% 75%, 1)').stops, [[0, 0], [0.25, 0.5], [0.75, 0.5], [1, 1]]);
});
test('channel mapping: transforms, variables (assumed mapping, flagged), bbox (flagged), unsupported', () => {
  assert.equal(channelOf('ren:tx').ch, 'tx'); assert.equal(channelOf('ren:opacity').ch, 'opacity');
  const v = channelOf('drv:--x'); assert.deepEqual([v.ch, v.name, v.mapTo, v.side], ['var', '--x', 'tx', 'drv']); assert.ok(v.assumption);
  assert.equal(channelOf('ren:bx').ch, 'tx'); assert.ok(channelOf('ren:bx').assumption);
  assert.equal(channelOf('ren:filter'), null); assert.equal(channelOf('nonsense'), null);
});
test('tween record: ease, t0, D and a fitted range are used as they are', () => {
  const r = rec({ model: { family: 'named:easeOutCubic', ease: 'easeOutCubic', params: { t0: P(940.4), D: P(600), from: P(10), to: P(110) }, valid_at: { frame_ms: 8.3333 } } });
  const { mechanisms, skipped } = mechanismsFromFit([r]);
  assert.equal(skipped.length, 0); const m = mechanisms[0].motion;
  assert.deepEqual([m.kind, m.from, m.to, m.startMs, m.durationMs, m.ease.name], ['tween', 10, 110, 940.4, 600, 'easeOutCubic']);
  assert.equal(mechanisms[0].provenance.range, 'fitted');
});
test('tween record without from/to: amplitude recovered from the peak velocity (inferred) for every ease family, else 0..1 flagged', () => {
  for (const [ease, A, D] of [[{ kind: 'named', name: 'easeOutExpo' }, 300, 600], [{ kind: 'bezier', p: [0.34, 1.517, 0.64, 1] }, -420, 880], [{ kind: 'named', name: 'easeInOutCubic' }, 90, 450]]) {
    const pk = Math.sign(A) * Math.abs(A) * unitPeakSlope(ease, D);
    const r = rec({ model: { family: 'x', ease: ease.kind === 'named' ? ease.name : undefined, bezier: ease.kind === 'bezier' ? ease.p : undefined, params: { t0: P(100), D: P(D) }, valid_at: {} }, derived: { peakVelocity: pk } });
    const m = mechanisms1(r); assert.ok(Math.abs(m.motion.to - A) < 1e-6 * Math.abs(A), `${ease.name || ease.p}: ${m.motion.to} vs ${A}`); assert.equal(m.provenance.range, 'inferred');
    assert.ok(m.assumptions.some((a) => a.field === 'amplitude'), 'the inference is listed');
  }
  const bare = mechanisms1(rec({ model: { family: 'x', ease: 'easeOutCubic', params: { t0: P(100), D: P(500) }, valid_at: {} } }));
  assert.deepEqual([bare.motion.from, bare.motion.to, bare.provenance.range], [0, 1, 'unknown']); assert.ok(bare.assumptions.some((a) => a.field === 'range'));
  const given = mechanisms1(rec({ model: { family: 'x', ease: 'easeOutCubic', params: { t0: P(100), D: P(500) }, valid_at: {} } }), { ranges: { 'ren:tx': { from: 5, to: 50 } } });
  assert.deepEqual([given.motion.from, given.motion.to, given.provenance.range], [5, 50, 'given']);
});
function mechanisms1(r, opts) { const x = mechanismsFromFit([r], opts); assert.equal(x.mechanisms.length, 1, JSON.stringify(x.skipped)); return x.mechanisms[0]; }

test('spring record: replayModel hypothesis, targets and retarget times -> a spring motion; I4 keeps native units', () => {
  const base = { class: 'spring', target: { el: 0, channel: 'drv:--x' }, model: { family: 'spring', params: {}, integrator: { identified: true, set: ['I1(16)'] }, valid_at: { frame_ms: 8.3333 },
    replayModel: { hyp: 'I1(16)', k: 200, c: 12, t0: 508.333333, x0: 0, v0: 0, targets: [200, 0, 200], tr: [1516.67, 2516.67], units: 'k/m 1/s², c/m 1/s' } } };
  const m = mechanisms1(rec(base)).motion;
  assert.deepEqual([m.kind, m.integrator, m.k, m.c, m.g0, m.events.length, m.onsetMs], ['spring', { id: 'i1', h: 16 }, 200, 12, 200, 2, 508.333333]);
  const i4 = mechanisms1(rec({ ...base, model: { ...base.model, replayModel: { ...base.model.replayModel, hyp: 'I4', k: 0.1, c: 0.4 } } })).motion;
  assert.deepEqual([i4.integrator.id, i4.kf, i4.cf, i4.k], ['i4', 0.1, 0.4, undefined]);
  assert.deepEqual(integratorFromHyp('I1(2)'), { id: 'i1', h: 2 }); assert.equal(integratorFromHyp('I9'), null);
  const un = mechanismsFromFit([rec({ ...base, model: { ...base.model, integrator: { identified: false } } })]).mechanisms[0];
  assert.ok(un.assumptions.some((a) => a.field === 'integrator'), 'an unidentified integrator is flagged, never silent');
});
test('reproduction-only spring (tier unknown, withheld values) is rebuilt analytically and flagged; other unknown records are skipped with a reason', () => {
  const w = (value) => ({ value: null, provenance: 'unknown', withheld_value: value });
  const r = rec({ tier: 'unknown', class: 'unknown', target: { el: 0, channel: 'ren:tx' }, model: { family: 'spring', params: { t0: w(583), omega: w(40), zeta: w(4.5), v0: w(-52), x0: w(-11), target: w(0) }, valid_for_reproduction_only: true, valid_at: { frame_ms: 16.667 } } });
  const m = mechanisms1(r); assert.equal(m.motion.integrator.id, 'i6'); assert.ok(Math.abs(m.motion.k - 1600) < 1e-9); assert.equal(m.provenance.reproductionOnly, true);
  const { mechanisms, skipped } = mechanismsFromFit([rec({ tier: 'unknown', class: 'unknown', model: { family: 'x', params: {}, valid_at: {} } }), rec({ tier: 'fitted', class: 'scroll map', model: { family: 'm', params: {}, valid_at: {} } }),
    rec({ tier: 'fitted', class: 'tween', target: { el: 0, channel: 'ren:filter' }, model: { family: 'x', ease: 'easeOutCubic', params: { t0: P(1), D: P(2) }, valid_at: {} } })]);
  assert.equal(mechanisms.length, 0); assert.equal(skipped.length, 3); assert.ok(skipped.every((s) => s.reason));
});
test('declared CSS record: births keyframes + solved values -> keyframes motion run by the engine (css), WAAPI -> effect easing', () => {
  const births = (type, easing) => [{ type, delay: 12, duration: 1800, easing, iterations: 1, direction: 'normal', fill: 'both', keyframes: [{ offset: 0, easing: 'linear' }, { offset: 0.35, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' }, { offset: 1, easing: 'linear' }] }];
  const mk = (type, easing, kind) => rec({ tier: 'declared', class: 'declared', model: { family: 'declared:' + kind, params: { duration: P(1800, 'declared'), delay: P(12, 'declared'), start: P(441.67, 'declared'), iterations: P(1, 'declared'), keyframeValues: P([0, 0, 240], 'measured') }, valid_at: {} }, declared: { kind, births: births(type, easing) } });
  const css = mechanisms1(mk('CSSAnimation', 'linear', 'css')); assert.equal(css.impl, 'css'); assert.equal(css.motion.easingScope, 'segment'); assert.equal(css.motion.startMs, 453.67);
  assert.deepEqual(css.motion.frames.map((f) => f.value), [0, 0, 240]); assert.equal(css.motion.frames[1].easing.kind, 'bezier');
  const wa = mechanisms1(mk('Animation', 'cubic-bezier(0.45, 0.05, 0.3, 1)', 'waapi')); assert.equal(wa.impl, 'waapi'); assert.equal(wa.motion.easingScope, 'effect'); assert.equal(wa.motion.easing.kind, 'bezier');
  const bad = mechanismsFromFit([rec({ tier: 'declared', class: 'declared', model: { family: 'declared:css', params: { duration: P(1), start: P(1), keyframeValues: P([1, 2], 'measured') }, valid_at: {} }, declared: { kind: 'css', births: births('CSSAnimation', 'linear') } })]);
  assert.equal(bad.mechanisms.length, 0); assert.match(bad.skipped[0].reason, /do not match/);
});
test('a driver channel shadows the render channels that mirror it; a ren variable is shadowed by a real channel', () => {
  const tw = (channel, ren) => rec({ target: { el: 0, channel }, model: { family: 'x', ease: 'easeOutCubic', params: { t0: P(100), D: P(500), from: P(0), to: P(300) }, valid_at: {} } });
  const a = mechanismsFromFit([tw('drv:--v'), tw('ren:--v'), tw('ren:tx')]); assert.equal(a.mechanisms.length, 1); assert.equal(a.mechanisms[0].channel.name, '--v'); assert.equal(a.skipped.length, 2);
  const b = mechanismsFromFit([tw('ren:--e'), tw('ren:tx'), tw('ren:opacity')]); assert.deepEqual(b.mechanisms.map((m) => m.channel.ch).sort(), ['opacity', 'tx']);
});
test('stagger groups become one specimen; other records one per element and kind', () => {
  const tw = (el) => rec({ target: { el, channel: 'ren:tx' }, model: { family: 'x', ease: 'easeOutCubic', params: { t0: P(100 + 45 * el), D: P(500), from: P(0), to: P(100) }, valid_at: {} } });
  const fit = { records: [tw(0), tw(1), tw(2), { ...tw(5), tier: 'fitted' }], stagger: [{ members: ['0|ren:tx|100', '1|ren:tx|145', '2|ren:tx|190'] }] };
  const plan = planSpecimens(mechanismsFromFit(fit).mechanisms); assert.equal(plan.length, 2); assert.equal(plan[0].mechanisms.length, 3);
  const { specs } = specimensFromFit(fit, { origin: 'lab', id: 'x' }); assert.equal(specs.length, 2); assert.equal(specs[0].spec.elements.length, 3);
});

// ---- lab truth (read-only reference) ----------------------------------------------------------------------------------
test('every lab time route yields specimens; unsupported items are skipped WITH a reason', async (t) => {
  const root = labRoot(); if (!root) return t.skip('lab not found');
  const { specs, skipped } = labSpecimenSet(root);
  const routes = new Set(specs.map((s) => s.spec.source.route));
  for (const r of ['m06', 'm07', 'm07x', 'm08', 'm10', 'm12', 'm15', 'm16e', 'm16f', 'm18', 'm19']) assert.ok(routes.has(r), `route ${r} produced a specimen`);
  assert.ok(skipped.every((s) => s.reason), 'every skipped item carries a reason');
  // integrators: one specimen per integrator x trace
  const ints = new Set(specs.filter((s) => s.spec.source.route === 'm07').map((s) => { const i = s.spec.tracks[0].motion.integrator; return i.id + (i.h ? ':' + i.h : ''); }));
  assert.deepEqual([...ints].sort(), ['i1:1', 'i1:16', 'i1:2', 'i4', 'i5', 'i6', 'i7']);
  const ids = specs.map((s) => s.spec.id); assert.equal(new Set(ids).size, ids.length, 'unique ids');
});

test('birth emulation only where the identity is evidenced: FLIP records, or when the caller asks', () => {
  const births = [{ type: 'Animation', delay: 0, duration: 450, easing: 'cubic-bezier(0.45, 0.05, 0.3, 1)', iterations: 1, direction: 'normal', fill: 'both', keyframes: [{ offset: null, easing: 'linear' }, { offset: null, easing: 'linear' }] }];
  const mk = (kind, subclass) => ({ ...rec({ tier: 'declared', class: 'declared', model: { family: 'declared:waapi', params: { duration: P(450, 'declared'), delay: P(0, 'declared'), start: P(441.67, 'declared'), keyframeValues: P([-440, 0], 'measured') }, valid_at: {} }, declared: { kind, births } }), ...(subclass ? { subclass } : {}) });
  const flip = mechanisms1(mk('flip', 'flip')); assert.deepEqual([flip.motion.birthMs, flip.motion.base, flip.impl], [441.67, 0, 'waapi']); assert.deepEqual(flip.motion.frames.map((f) => f.offset), [0, 1], 'null offsets are evenly spaced');
  const plain = mechanisms1(mk('waapi')); assert.equal(plain.motion.birthMs, undefined, 'a plain declared animation fills backwards from t = 0');
  const asked = mechanisms1(mk('waapi'), { birth: 'identity' }); assert.equal(asked.motion.birthMs, 441.67);
  const op = mechanismsFromFit([{ ...mk('flip', 'flip'), target: { el: 0, channel: 'ren:opacity' } }]).mechanisms[0]; assert.equal(op.motion.base, 1, 'opacity identity is 1');
});
test('several fitted tweens on one channel of one element become a chain; their assumptions are all kept', () => {
  const seg = (t0, o) => rec({ model: { family: 'x', ease: 'easeOutCubic', params: { t0: P(t0), D: P(500), ...o }, valid_at: {} } });
  const m = mechanisms1(rec({}) && seg(100, { from: P(0), to: P(300) })); assert.equal(m.motion.kind, 'tween');
  const { mechanisms } = mechanismsFromFit([seg(900, { from: P(290), to: P(90) }), seg(100, { from: P(0), to: P(300) })]);
  assert.equal(mechanisms.length, 1); assert.equal(mechanisms[0].motion.kind, 'chain'); assert.deepEqual(mechanisms[0].motion.parts.map((p) => p.startMs), [100, 900]);
});
