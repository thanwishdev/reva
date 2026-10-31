// Declared keyframe values stated [exact] (relative units kept), and each element's own birth by element id (pure, synthetic).
// Case: a measured site's split heading, two lines (one descriptor) with Motion WAAPI animations of delay 400 and 500 ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyframeChannelValues } from '../../src/analysis/fit/declvalues.js';
import { checkDeclared } from '../../src/analysis/fit/declared.js';
import { parseEasing, easeAt } from '../../src/analysis/fit/eases.js';
import { keyframeValuesParam } from '../../src/analysis/fit/index.js';
import { describeRecord } from '../../src/look/words.js';
import { exportRecord } from '../../src/export/index.js';

const EASE = 'cubic-bezier(0.25, 0.1, 0.25, 1)';
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test('keyframe values per channel: units, relative units, matrices, filters, implicit and unparsed keyframes', () => {
  const ty = keyframeChannelValues('ren:ty', null, [{ offset: 0, transform: 'translateY(20%)' }, { offset: 1, transform: 'translateY(0%)' }]);
  assert.deepEqual(ty, [{ v: 20, unit: '%', rel: true }, { v: 0, unit: 'px' }]);
  // a transition's computed keyframes are matrices / none
  const m = keyframeChannelValues('ren:ty', null, [{ transform: 'matrix(1, 0, 0, 1, 0, 24.8)' }, { transform: 'none' }]);
  near(m[0].v, 24.8); assert.equal(m[0].unit, 'px'); near(m[1].v, 0);
  const sx = keyframeChannelValues('ren:sx', null, [{ transform: 'translateY(-8px) scale(1.03)' }, { transform: 'none' }]);
  near(sx[0].v, 1.03); near(sx[1].v, 1);
  near(keyframeChannelValues('ren:rz', null, [{ transform: 'rotate(0.5turn)' }, { transform: 'rotate(0deg)' }])[0].v, 180);
  assert.deepEqual(keyframeChannelValues('ren:opacity', null, [{ opacity: '0' }, { opacity: 1 }]).map((x) => x.v), [0, 1]);
  assert.deepEqual(keyframeChannelValues('ren:filter', { fn: 'blur', unit: 'px' }, [{ filter: 'blur(10px)' }, { filter: 'none' }]).map((x) => x.v), [10, 0]);
  assert.deepEqual(keyframeChannelValues('ren:translate.y', null, [{ translate: '0px 20%' }, { translate: 'none' }])[0], { v: 20, unit: '%', rel: true });
  // implicit start (the keyframe does not name the property): undefined; not named anywhere / not parsed: null
  assert.deepEqual(keyframeChannelValues('ren:opacity', null, [{ offset: 0 }, { offset: 1, opacity: '1' }]), [undefined, { v: 1, unit: '' }]);
  assert.equal(keyframeChannelValues('ren:opacity', null, [{ transform: 'none' }, { transform: 'none' }]), null);
  assert.equal(keyframeChannelValues('ren:ty', null, [{ transform: 'translateY(calc(10px + 2%))' }, { transform: 'none' }]), null);
  assert.equal(keyframeChannelValues('ren:ty', null, [{ transform: 'rotate(10deg) translateY(20%)' }, { transform: 'none' }]), null, 'a relative translation after a rotation is not one length');
  assert.equal(keyframeChannelValues('ren:radius', null, [{ borderRadius: '4px' }, { borderRadius: '8px' }]), null);
});

// two siblings with one descriptor; Motion: one WAAPI animation per property, created in one frame, delays 400 / 500
const DESC = 'SPAN.hide-mobile.QI8oKG_titleLine';
const birth = (el, delay, prop, from, to) => ({ type: 'Animation', name: 'waapi', tgt: DESC, el, T: 100, delay, duration: 1000, easing: EASE, iterations: 1, direction: 'normal', fill: 'both', timeline: 'document',
  keyframes: [{ offset: 0, easing: 'linear', [prop]: from }, { offset: 1, easing: 'linear', [prop]: to }] });
const births = (withEl) => [
  birth(withEl ? 1 : undefined, 400, 'transform', 'translateY(20%)', 'translateY(0%)'), birth(withEl ? 2 : undefined, 500, 'transform', 'translateY(20%)', 'translateY(0%)'),
  birth(withEl ? 1 : undefined, 400, 'opacity', '0', '1'), birth(withEl ? 2 : undefined, 500, 'opacity', '0', '1'),
];
const E = parseEasing(EASE);
function series(el, ch, delay, a, b, n = 220) {
  const T = Array.from({ length: n }, (_, i) => 100 + (i * 1000) / 120);
  const y = T.map((t) => a + (b - a) * easeAt(E, (t - 100 - delay) / 1000));
  return { key: `${el}|${ch}`, el, desc: DESC, ch, kind: 'ren', T, y };
}
const NF = { explainBar: 0.05, sigma: 0.005 };

test('each line carries the delay of its own animation (element id, not the shared descriptor); ends [exact], % kept', () => {
  const view = { births: births(true), dtPage: 1000 / 120 };
  for (const [el, delay] of [[1, 400], [2, 500]]) {
    const d = checkDeclared(view, series(el, 'ren:ty', delay, 24.8, 0), NF);
    assert.ok(d && d.explains, `line ${el} explained`);
    assert.equal(d.births[0].delay, delay, `line ${el}: its own delay`);
    assert.equal(d.births.length, 1);
    assert.ok(d.exact && !d.exact.rejected);
    assert.deepEqual(d.exact.declared, [20, 0]); assert.equal(d.exact.unit, '%');
    near(d.exact.values[0], 24.8, 1e-3); near(d.exact.factor, 1.24, 1e-4);
    const kv = keyframeValuesParam(d);
    assert.equal(kv.provenance, 'declared'); assert.equal(kv.declaredUnit, '%'); assert.deepEqual(kv.declaredValues, [20, 0]);
    const o = checkDeclared(view, series(el, 'ren:opacity', delay, 0, 1), NF);
    assert.equal(o.births[0].delay, delay); assert.deepEqual(o.exact.values, [0, 1]); assert.equal(keyframeValuesParam(o).provenance, 'declared');
  }
});

test('births without an element id (older takes) are still matched by descriptor', () => {
  const d = checkDeclared({ births: births(false), dtPage: 1000 / 120 }, series(2, 'ren:ty', 500, 24.8, 0), NF);
  assert.ok(d && d.explains); assert.equal(d.births.at(-1).delay, 500, 'the sibling subset still puts line 2\'s birth last');
});

test('declared values that do not explain the samples stay fitted; an implicit end stays solved and says so', () => {
  const b = { ...birth(1, 0, 'opacity', '0', '1'), keyframes: [{ offset: 0, opacity: '0' }, { offset: 1, opacity: '1' }] };
  // samples run 0.2 -> 1 (another layer under the animation): the declared 0 -> 1 do not explain them
  const d = checkDeclared({ births: [b], dtPage: 1000 / 120 }, series(1, 'ren:opacity', 0, 0.2, 1), NF);
  assert.ok(d.explains); assert.ok(d.exact.rejected);
  const kv = keyframeValuesParam(d); assert.equal(kv.provenance, 'measured'); near(kv.value[0], 0.2, 1e-6);
  // a `to`-only animation: the start is the computed value (implicit)
  const bi = { ...b, keyframes: [{ offset: 0 }, { offset: 1, opacity: '1' }] };
  const di = checkDeclared({ births: [bi], dtPage: 1000 / 120 }, series(1, 'ren:opacity', 0, 0.3, 1), NF);
  assert.deepEqual(di.exact.implicit, [true, false]); near(di.exact.values[0], 0.3, 1e-6); assert.equal(di.exact.values[1], 1);
  const ki = keyframeValuesParam(di); assert.equal(ki.provenance, 'measured'); assert.deepEqual(ki.declaredAt, [false, true]);
  const rec = { tier: 'declared', target: { el: 1, channel: 'ren:opacity', desc: DESC }, model: { family: 'declared:waapi', params: { duration: { value: 1000, provenance: 'declared' }, easing: { value: EASE, provenance: 'declared' }, keyframeValues: ki } }, declared: { births: [bi] } };
  assert.match(describeRecord(rec).text, /opacity 0\.3 \[fitted\] → 1 \[exact\]/);
});

test('CSS transition: before / after computed values (matrix, none) are the exact ends', () => {
  const b = { type: 'CSSTransition', name: 'transform', tgt: 'BUTTON.cta', el: 7, T: 100, delay: 0, duration: 300, easing: 'ease', iterations: 1, fill: 'backwards', timeline: 'document',
    keyframes: [{ offset: 0, transform: 'none' }, { offset: 1, transform: 'matrix(1, 0, 0, 1, 0, -8)' }] };
  const E2 = parseEasing('ease'); const T = Array.from({ length: 60 }, (_, i) => 100 + (i * 1000) / 120);
  const s = { el: 7, desc: 'BUTTON.cta', ch: 'ren:ty', T, y: T.map((t) => -8 * easeAt(E2, (t - 100) / 300)) };
  const d = checkDeclared({ births: [b], dtPage: 1000 / 120 }, s, NF);
  near(d.exact.values[0], 0); near(d.exact.values[1], -8); assert.equal(d.exact.unit, null);
  assert.equal(keyframeValuesParam(d).provenance, 'declared');
});

test('look line and exports: the declared % with its px; css / gsap / motion write %', () => {
  const kv = { value: [24.8, 0], provenance: 'declared', declaredValues: [20, 0], declaredUnit: '%', factorPx: 1.24 };
  const rec = { tier: 'declared', target: { el: 1, channel: 'ren:ty', desc: DESC }, derived: { t0: 500 },
    model: { family: 'declared:waapi', params: { duration: { value: 1000, provenance: 'declared' }, delay: { value: 500, provenance: 'declared' }, easing: { value: EASE, provenance: 'declared' }, keyframeValues: kv } },
    declared: { kind: 'waapi', births: [birth(1, 500, 'transform', 'translateY(20%)', 'translateY(0%)')] } };
  assert.match(describeRecord(rec).text, /y 20 % → 0 % \(24\.8 px\) \[exact\]/);
  const by = Object.fromEntries(exportRecord(rec, { to: ['css', 'gsap', 'motion'] }).exports.map((x) => [x.lib, x.code]));
  assert.match(by.css, /transform: translateY\(20%\)/); assert.match(by.css, /translateY\(0%\)/); assert.match(by.css, /500ms/);
  assert.match(by.gsap, /\{ yPercent: 20 \}, \{ yPercent: 0,/);
  assert.match(by.motion, /y: \["20%", "0%"\]/);
  // opacity: the exact ends
  const op = { ...rec, target: { ...rec.target, channel: 'ren:opacity' }, model: { ...rec.model, params: { ...rec.model.params, keyframeValues: { value: [0, 1], provenance: 'declared' } } } };
  assert.match(describeRecord(op).text, /opacity 0 → 1 \[exact\]/);
  assert.match(Object.fromEntries(exportRecord(op, { to: ['css'] }).exports.map((x) => [x.lib, x.code])).css, /opacity: 0;[^]*opacity: 1;/);
});
