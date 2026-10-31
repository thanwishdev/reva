import test from 'node:test';
import assert from 'node:assert/strict';
import { isSwitchSeries } from '../../src/analysis/fit/index.js';

const hold = (v, n) => Array(n).fill(v);

test('a hover jump (A to B in one frame) is a switch, also across three levels', () => {
  assert.equal(isSwitchSeries([...hold(0, 20), ...hold(1, 30)]), true);
  assert.equal(isSwitchSeries([...hold(0, 20), ...hold(1, 15), ...hold(0, 15)]), true);
  assert.equal(isSwitchSeries([...hold(0, 10), ...hold(0.5, 10), ...hold(1, 10)]), true);
});

test('a linear tween or a pointer sweep is not a switch', () => {
  assert.equal(isSwitchSeries([...hold(0, 10), 0.2, 0.4, 0.6, 0.8, ...hold(1, 10)]), false);
  assert.equal(isSwitchSeries(Array.from({ length: 40 }, (_, i) => i * 7)), false);
  assert.equal(isSwitchSeries(hold(3, 30)), false);
});
