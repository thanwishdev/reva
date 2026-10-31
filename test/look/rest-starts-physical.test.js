// Pure (no browser): rest pose wording, group start times, declared start vs delay, impossible opacity values, from == to export.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decomposeTransform, restSummary, restText, restNote, attachRest } from '../../src/look/rest.js';
import { groupStarts, startsText, declaredStartText, relStart } from '../../src/look/starts.js';
import { guardPhysical } from '../../src/look/physical.js';
import { describeRecord } from '../../src/look/words.js';
import { exportRecord } from '../../src/export/index.js';

const rad = (d) => d * Math.PI / 180;
const mat = (deg, tx = 0, ty = 0, s = 1) => `matrix(${s * Math.cos(rad(deg))}, ${s * Math.sin(rad(deg))}, ${-s * Math.sin(rad(deg))}, ${s * Math.cos(rad(deg))}, ${tx}, ${ty})`;

test('decomposeTransform: identity, rotate, scale, translate, matrix3d', () => {
  assert.equal(decomposeTransform('none').identity, true);
  assert.equal(decomposeTransform('matrix(1, 0, 0, 1, 0, 0)').identity, true);
  const d = decomposeTransform(mat(25, 10, -4, 1.5));
  assert.equal(d.identity, false); assert.equal(d.rotate, 25); assert.deepEqual(d.scale, [1.5, 1.5]); assert.deepEqual(d.translate, [10, -4]);
  const d3 = decomposeTransform('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1)');
  assert.deepEqual(d3.translate, [5, 6]); assert.equal(d3.is3d, true);
});

// the library site squiggle: the img animates 180 -> 0 and rests untransformed; its parent rests at rotate(25deg), origin 40.84px 69.46px
const raw = { t: 'none', o: '50px 50px', op: 1, w: 100, h: 100, anc: [{ desc: 'DIV#home-hero-squiggle', t: mat(25), o: '40.84px 69.46px', op: 1, w: 200, h: 200 }] };

test('restText: transformed parent, non-default origin, nothing to say', () => {
  const rest = restSummary(raw);
  assert.equal(rest.ancestors.length, 1); assert.equal(rest.ancestors[0].transform.rotate, 25); assert.equal(rest.origin.default, true);
  assert.equal(restText(rest), 'rest: no own transform · inside DIV#home-hero-squiggle (rotate 25°, origin 40.84px 69.46px)');
  const own = restSummary({ t: mat(25), o: '41px 69px', op: 1, w: 200, h: 200, anc: [] });
  assert.equal(restText(own), 'rest: rotate 25°, origin 41px 69px');
  assert.equal(restText(restSummary({ t: 'none', o: '50px 50px', op: 1, w: 100, h: 100, anc: [] })), null);
  assert.equal(restText(restSummary({ t: 'none', o: '50px 50px', op: 0.4, w: 100, h: 100, anc: [] })), 'rest: opacity 0.4');
  assert.equal(restText(null), null);
});

test('attachRest: comment goes into the code after the REVA source line, per language', () => {
  const m = { lead: 7, exports: [{ exports: [{ lib: 'gsap', code: '/* REVA: x */\ngsap.to(el, {})' }, { lib: 'css', code: '/* REVA: x */\n.a{}' }] }] };
  attachRest([m], { 7: raw });
  assert.match(m.exports[0].exports[0].code, /^\/\* REVA: x \*\/\n\/\/ REVA note: values are in the element's own frame; its parent DIV#home-hero-squiggle rests at rotate 25°/);
  assert.match(m.exports[0].exports[1].code.split('\n')[1], /^\/\* REVA note: .* \*\/$/);
  assert.ok(m.rest.note && restNote(m.rest) === m.rest.note);
  const n = { lead: 1, exports: [] }; attachRest([n], null); assert.equal(n.rest, null);
});

test('groupStarts / startsText: offsets from the earliest, capped print, together', () => {
  const rec = (el, t0, channel = 'ren:ty') => ({ target: { el, channel }, derived: { t0 } });
  const recs = Array.from({ length: 13 }, (_, i) => rec(i, 400 + i * 33));
  recs.push(rec(3, 900), rec(99, 1000, 'ren:opacity'));
  const s = groupStarts(recs, 'ren:ty');
  assert.equal(s.n, 13); assert.equal(s.offsetsMs[0], 0); assert.equal(s.offsetsMs[1], 33); assert.equal(s.firstT0, 400);
  assert.equal(startsText(s), 'starts: +0, +33, +66, +99, +132, +165, +198, +231, +264, +297, +330, +363 … ms (13 fitted members)');
  assert.equal(groupStarts([rec(1, 5)], null), null);
  assert.match(startsText(groupStarts([rec(1, 400), rec(2, 405)], null)), /start together/);
});

test('declaredStartText: only when the measured start differs from the delay by more than a frame', () => {
  assert.equal(relStart(900, 400), 500);
  assert.equal(declaredStartText(500, 400), 'measured start +500 ms (declared delay 400 ms)');
  assert.equal(declaredStartText(410, 400), null);
  assert.equal(declaredStartText(null, 400), null);
  assert.equal(declaredStartText(20, undefined), 'measured start +20 ms (declared delay 0 ms)');
});

const P = (value, provenance = 'fitted') => ({ value, provenance });
const op = (model) => ({ target: { el: 1, channel: 'ren:opacity' }, tier: 'fitted', model, unknowns: [] });

test('guardPhysical: opacity noise is clamped, a clear excess makes the model unusable', () => {
  const map = op({ family: 'scroll map (linear)', params: { mapA: P(0.0301), mapB: P(0.9899) }, map: { shape: 'linear', a: 0.0301, b: 0.9899 + 0.0201 } });
  const g = guardPhysical(map);
  assert.equal(g.model.map.a, 0.0301); assert.ok(Math.abs(g.model.map.a + g.model.map.b - 1) < 1e-9); assert.equal(g.physical.clamped, true);
  const spring = op({ family: 'spring', params: { omega: P(30), zeta: P(0.4), x0: P(0), target: P(-0.364) } });
  const u = guardPhysical(spring);
  assert.equal(u.tier, 'unexplained'); assert.equal(u.model.family, null); assert.match(u.unknowns[0].reason, /outside 0\.\.1/);
  assert.match(describeRecord(u).text, /no model explains it \[unknown\].*-0\.364/);
  const tw = guardPhysical(op({ family: 'bezier', params: { D: P(10600), from: P(-0.2), to: P(1) } }));
  assert.equal(tw.tier, 'unexplained');
  const ok = op({ family: 'spring', params: { x0: P(0), target: P(1) } });
  assert.equal(guardPhysical(ok), ok);
  const other = { target: { el: 1, channel: 'ren:ty' }, model: { family: 'spring', params: { target: P(-300) } } };
  assert.equal(guardPhysical(other), other);
  const tween = guardPhysical(op({ family: 'bezier', params: { D: P(300), from: P(0.0301), to: P(1.02) } }));
  assert.equal(tween.model.params.to.value, 1);
});

test('export: a tween with from == to is skipped, a real one is not', () => {
  const rec = (from, to) => ({ target: { el: 1, channel: 'ren:rz' }, tier: 'fitted', class: 'tween', model: { family: 'bezier', params: { D: P(600), x1: P(0.25), y1: P(0.1), x2: P(0.25), y2: P(1), from: P(from, 'recorded'), to: P(to, 'recorded') } }, derived: { t0: 100 } });
  const bad = exportRecord(rec(0, 0), {});
  assert.match(bad.skipped, /from equals to/);
  const good = exportRecord(rec(367.294, 90), {});
  assert.ok(!good.skipped); assert.ok(good.exports.some((e) => /367\.294/.test(e.code || '')));
});
