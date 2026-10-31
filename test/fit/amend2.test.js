// Attempt-3 fitter/scorer pieces (D-M2-12): Amendment 2 B certificates, map ridges, state-derived hysteresis edges,
// the critically damped spring step, and the numerical-resolution floor of covariance intervals. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapRidge, hysteresis } from '../../src/analysis/fit/scrollextras.js';
import { certifyMap } from '../../src/analysis/fit/lab/metrics.js';
import { springStep } from '../../src/analysis/fit/spring.js';
import { ciHalfWidths } from '../../src/analysis/fit/numeric.js';

const lin = (u) => u;
const mapAt = (a, b, s0, s1, x) => a + b * Math.max(0, Math.min(1, (x - s0) / (s1 - s0)));

test('mapRidge: one inner offset gives the exact ridge; the truth corners lie inside it', () => {
  const tm = { a: 1, b: -1, s0: 330, s1: 650 }; const X = [0, 240, 450, 800, 1000];
  const r = mapRidge({ a: 1, b: -1, S: lin, linear: true, pairs: X.map((s) => ({ s, y: mapAt(tm.a, tm.b, tm.s0, tm.s1, s) })), tolv: 1e-6 });
  assert.equal(r.case, 'one inner offset');
  assert.ok(r.s0[0] <= 330 && 330 <= r.s0[1] && r.s1[0] <= 650 && 650 <= r.s1[1], JSON.stringify(r));
  // every point of the ridge reproduces the samples: the scorer certificate agrees
  const c = certifyMap({ shape: 'linear', ...tm }, 'map_s0', r.s0, X, 1e-9, 2, 330);
  assert.equal(c.ok, true, c.why);
});

test('certifyMap refuses an interval that reaches outside the ridge', () => {
  const tm = { shape: 'linear', a: 1, b: -1, s0: 330, s1: 650 }; const X = [0, 240, 450, 800, 1000];
  const c = certifyMap(tm, 'map_s0', [200, 449], X, 1e-9, 2, 330);   // 200 < 240: the 240 px sample would sit on the ramp
  assert.equal(c.ok, false);
});

test('mapRidge: a linear corner at the scroll minimum is anywhere at or below it', () => {
  const X = [0, 100, 200, 400, 900]; const pairs = X.map((s) => ({ s, y: mapAt(1, -1, 0, 800, s) }));
  const r = mapRidge({ a: 1, b: -1, S: lin, linear: true, pairs, tolv: 1e-6, s0: 0, s1: 800 });
  assert.deepEqual(r.s0, [-Infinity, 0]); assert.equal(r.s1, null);
});

test('hysteresis: state-derived edge intervals contain the true edges and exclude every held offset', () => {
  const up = [150, 350], down = [90, 290];
  const path = [0, 100, 200, 120, 80, 200, 300, 400, 320, 260, 100];
  let i = 0; const y = path.map((x) => { while (i < 2 && x >= up[i]) i++; while (i > 0 && x <= down[i - 1]) i--; return i; });
  const h = hysteresis({ y }, path, null);
  const b0 = h.bands.find((b) => b.between[0] === 0); const b1 = h.bands.find((b) => b.between[0] === 1);
  const inside = (iv, v) => (iv[0] ?? -Infinity) <= v && v <= (iv[1] ?? Infinity);
  assert.ok(inside(b0.downEdge_interval, 150) && inside(b0.upEdge_interval, 90) && inside(b1.downEdge_interval, 350) && inside(b1.upEdge_interval, 290), JSON.stringify(h.bands));
});

test('springStep is continuous across critical damping', () => {
  const a = springStep(12, 1 - 1e-7, 1, 3, 0.05), b = springStep(12, 1 + 1e-7, 1, 3, 0.05), c = springStep(12, 1, 1, 3, 0.05);
  // smooth (no branch kink): the change from ζ = 1 is antisymmetric to first order and tiny
  assert.ok(Math.abs(a[0] - c[0]) < 1e-6 && Math.abs((a[0] - c[0]) + (b[0] - c[0])) < 1e-12 && Math.abs((a[1] - c[1]) + (b[1] - c[1])) < 1e-10);
});

test('covariance half-widths never fall below the solver resolution (2e-7 relative)', () => {
  const T = Array.from({ length: 50 }, (_, i) => i); const rf = (p) => T.map((t) => p[0] * t - 3 * t);
  const h = ciHalfWidths(rf, [3], 0, T.length, 1e-15, [1]);
  assert.ok(h[0] >= 2e-7 * 3 * 0.999, String(h[0]));
});
