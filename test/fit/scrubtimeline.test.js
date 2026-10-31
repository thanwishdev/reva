// timelineScrub (D-SCROLLBUDGET-1): GSAP smooths the progress of the whole scrubbed timeline, then a child tween maps it.
// Synthetic, known by construction: a native wheel sweep of 100 px per frame at 120 Hz, a 800 ms scrub on the trigger
// range 1000 → 5000 px, a child filling the first 87.5 % of it (corners 1000 → 4500 px of smoothed scroll), x 0 → -3000.
import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineScrub, simulateSmoother } from '../../src/analysis/fit/smoothing.js';
import { NAMED } from '../../src/analysis/fit/eases.js';

const dt = 1000 / 120; const N = 260;
const T = Array.from({ length: N }, (_, k) => k * dt);
const sy = T.map((_, k) => Math.min(8000, Math.max(0, (k - 20) * 100)));
const g = sy.map((v) => Math.min(5000, Math.max(1000, v)));
const v = simulateSmoother('restarted', { L: 800, delay: 0, E: NAMED['expo.out'].fn }, g, T, g[0]);
const y = v.map((q) => -3000 * Math.min(1, Math.max(0, (q - 1000) / 3500)));
const s = { T, y }; const nf = { sigma: 1e-3, explainBar: 1.5, A: 3000 };

test('recovers the scrub length, the child corners and the end of the trigger range', () => {
  // seeded as the probe would: a smoother of the child's own map, corners and scrub roughly right
  const [r] = timelineScrub(s, sy, nf, { lag: 0, L: 700, map: { shape: 'linear', a: 0, b: -3000, s0: 1100, s1: 4400 } });
  assert.ok(r && r.rms <= nf.explainBar, `rms ${r && r.rms}`);
  assert.ok(Math.abs(r.prm.L - 800) < 5, `L ${r.prm.L}`);
  assert.ok(Math.abs(r.map.s0 - 1000) < 5 && Math.abs(r.map.s1 - 4500) < 5 && Math.abs(r.map.b + 3000) < 2, JSON.stringify(r.map));
  assert.ok(Math.abs(r.progress.c1 - 5000) < 10, JSON.stringify(r.progress));
  // a uniform sweep trades one frame of lag for one step of both corners: the reported interval covers it
  if (r.lagTrade) assert.ok(r.params.mapS0.ci95[0] <= 900 + 5, JSON.stringify(r.params.mapS0));
});

test('reusing the identified progress fits a sibling channel by its map alone', () => {
  const [r0] = timelineScrub(s, sy, nf, { lag: 0, L: 700, map: { shape: 'linear', a: 0, b: -3000, s0: 1100, s1: 4400 } });
  const y2 = v.map((q) => 0.2 + 0.8 * Math.min(1, Math.max(0, (q - 3000) / 1000)));
  const [r] = timelineScrub({ T, y: y2 }, sy, { sigma: 1e-4, explainBar: 4e-4, A: 0.8 }, { lag: 0, map: { shape: 'linear', a: 0.2, b: 0.8, s0: 2900, s1: 4100 } }, { fixed: r0.progress });
  assert.ok(r && r.rms <= 4e-4, `rms ${r && r.rms}`);
  assert.ok(Math.abs(r.map.s0 - 3000) < 5 && Math.abs(r.map.s1 - 4000) < 5, JSON.stringify(r.map));
  assert.equal(r.progress.shared, true);
});
