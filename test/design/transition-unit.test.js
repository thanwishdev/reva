// Pure: a control's declared CSS transition from computed style, and its design-text line. No browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTop, declaredTransition, transitionsFor } from '../../src/static/transition.js';
import { transitionText } from '../../src/design/text.js';

test('splitTop keeps commas inside functions', () => {
  assert.deepEqual(splitTop('ease, cubic-bezier(0.2, 0, 0, 1), linear'), ['ease', 'cubic-bezier(0.2, 0, 0, 1)', 'linear']);
});

test('declaredTransition: lists cycle, units to ms, zero-time rows dropped', () => {
  const t = declaredTransition({ 'transition-property': 'color, background-color, opacity', 'transition-duration': '0.2s, 150ms', 'transition-timing-function': 'ease-out, cubic-bezier(0.2, 0, 0, 1)', 'transition-delay': '0s, 0.05s, 0s' });
  assert.deepEqual(t.map((x) => [x.property, x.duration, x.delay]), [['color', 200, 0], ['background-color', 150, 50], ['opacity', 200, 0]]);
  assert.equal(t[1].easing, 'cubic-bezier(0.2, 0, 0, 1)'); assert.equal(t[2].easing, 'ease-out');
  assert.deepEqual(declaredTransition({ 'transition-property': 'all', 'transition-duration': '0s', 'transition-timing-function': 'ease', 'transition-delay': '0s' }), []);
  assert.deepEqual(declaredTransition({ 'transition-property': 'none' }), []);
  assert.deepEqual(declaredTransition(null), []);
});

test('transitionsFor: all / exact / shorthand cover the changed properties', () => {
  const l = [{ property: 'all', duration: 200 }, { property: 'border-color', duration: 100 }, { property: 'width', duration: 50 }];
  assert.deepEqual(transitionsFor(l, ['border-top-color']).map((x) => x.property), ['all', 'border-color']);
  assert.deepEqual(transitionsFor([{ property: 'width', duration: 5 }], ['color']), []);
});

test('transitionText: timing, instant, absent', () => {
  assert.equal(transitionText({}), '');
  assert.match(transitionText({ transition: [{ property: 'all', duration: 200, easing: 'ease-out', delay: 0 }] }), /transition: all 200 ms ease-out \[measured\]/);
  assert.match(transitionText({ transition: [{ property: 'color', duration: 150, easing: 'ease', delay: 50 }] }), /delay 50 ms/);
  assert.match(transitionText({ transition: [] }), /instant/);
});
