// Attempt-4 fitter pieces (D-M2-13): a snap-direction asymmetric rate pinned at its bound on a dense sweep (M03), and
// a smoother's dynamics interval on a map whose corners are not identified (M21). Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothingCandidates, simulateSmoother, driverOf } from '../../src/analysis/fit/smoothing.js';
import { NAMED } from '../../src/analysis/fit/eases.js';

const smooth = (u) => { const v = Math.max(0, Math.min(1, u)); return v * v * (3 - 2 * v); };

test('asymmetric smoothing with snap on rise on a dense sweep: α_up pinned at 1, the snap variant fits exactly', () => {
  // M03 form on the `speed` trace: one frame per offset, up through the range and back, then a hold
  const sy = []; for (let i = 0; i < 12; i++) sy.push(2050); for (let s = 2050; s <= 2470; s += 10) sy.push(s);
  for (let i = 0; i < 4; i++) sy.push(2470); for (let s = 2460; s >= 2050; s -= 10) sy.push(s); for (let i = 0; i < 40; i++) sy.push(2050);
  const T = sy.map((_, k) => k * (1000 / 60)); const g = sy.map((s) => smooth((s - 2100) / 320));
  const y = []; let x = 0;
  for (let k = 0; k < g.length; k++) { if (k > 0) { const d = g[k] - x; x = g[k] > x ? g[k] : Math.abs(d) < 1e-3 ? g[k] : x + 0.3312 * d; } y.push(x); }
  const nf = { sigma: 1e-9, A: 1, explainBar: 5e-4, quantum: 0 };
  const { out } = smoothingCandidates({ y, T }, sy, nf, {});
  const best = out.filter((c) => c.law === 'asym').sort((a, b) => a.rms - b.rms)[0];
  assert.ok(best && best.rms < 1e-8, `best asym rms ${best && best.rms}`);
  assert.equal(best.prm.alphaUp, 1); assert.ok(Math.abs(best.prm.alphaDown - 0.3312) < 1e-6, String(best.prm.alphaDown));
  // the pinned one-rate law (and its snap variant) is among the candidates and reproduces the series
  const pin = out.filter((c) => c.pinned && c.pinned.alphaUp === 1 && c.prm.eps).sort((a, b) => a.rms - b.rms)[0];
  assert.ok(pin && pin.rms < 1e-8 && pin.k === best.k - 1 + (best.pinned ? 1 : 0), `pinned ${pin && pin.rms} k ${pin && pin.k} vs ${best.k}`);
});

test('smoother dynamics keep an interval on a parametric map whose corners three offsets cannot place', () => {
  // (the targets-as-nuisance fallback itself is exercised by the lab case M21 g1 steps at R5; here the property only)
  // M21 form: two steps of different amplitude (0 → 600 → 500 px offsets), a restarted expo.out of 300 ms; three offsets
  // cannot place a map's corners, but the response duration is measured by both completed steps
  const T = Array.from({ length: 420 }, (_, k) => k * (1000 / 120)); const sy = T.map((t) => (t < 400 ? 0 : t < 1900 ? 600 : 500));
  const g = driverOf((s) => 0.5 * s, sy, 0);
  const y = simulateSmoother('restarted', { L: 300, delay: 0, E: NAMED['expo.out'].fn }, g, T, 0);
  const nf = { sigma: 1e-6, A: 300, explainBar: 0.3, quantum: 0 };
  const { out } = smoothingCandidates({ y, T }, sy, nf, {});
  // the parametric-map candidates (joint fit of the dynamics with the map's a, b, s0, s1), not the held-target ones
  const r = out.filter((c) => c.law === 'restarted' && c.ease === 'expo.out' && c.rms <= nf.explainBar && !/targets/.test(c.family)).sort((a, b) => a.bic - b.bic)[0];
  assert.ok(r, 'a restarted expo.out candidate explains');
  assert.ok(Math.abs(r.prm.L - 300) / 300 < 0.01, `L ${r.prm.L}`);
  const ci = r.params.L.ci95; assert.ok(Array.isArray(ci) && ci.every(Number.isFinite), `L interval ${JSON.stringify(r.params.L)}`);
  assert.ok(ci[0] <= 300 + 1e-6 && 300 - 1e-6 <= ci[1], JSON.stringify(ci));
});
