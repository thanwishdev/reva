// B2 (corpus): fit caps. maxChannels keeps the highest-energy channels and ledgers the rest; workBudget (S4) makes a
// fit partial with a reason per channel left out, deterministically. Without the opts the result has no capped rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitTakeSet } from '../../src/analysis/fit/index.js';
import { synthTake, frameTimes, scrollSteps } from './helpers.js';
import { simulateSmoother } from '../../src/analysis/fit/smoothing.js';

const els = Array.from({ length: 9 }, (_, i) => ({ desc: `DIV.c${i}`, ch: { 'ren:tx': (k, T) => { const t0 = 100 + 110 * i, d = 300 + 60 * i, u = Math.min(1, Math.max(0, (T - t0) / d)); return 40 * (i + 1) * u * u * (3 - 2 * u); } } })); // distinct timing per element (no redundant pairs)

test('maxChannels 5: at most 5 channels fitted, the other moving channels ledgered as unk_fit_capped', () => {
  const full = fitTakeSet({ primary: synthTake({ dur: 1600, els }) });
  assert.ok(!full.partial && !full.unknowns.some(u => u.id === 'unk_fit_capped'));
  const res = fitTakeSet({ primary: synthTake({ dur: 1600, els }) }, { maxChannels: 5 });
  const fitted = new Set(res.records.map(r => `${r.target.desc}|${r.target.channel}`));
  assert.ok(fitted.size <= 5, `fitted ${fitted.size}`);
  const capped = res.unknowns.filter(u => u.id === 'unk_fit_capped');
  assert.ok(capped.length >= 1 && capped.every(u => /maxChannels 5/.test(u.reason)));
  assert.equal(res.partial, true);
  // the largest movers are the ones kept
  assert.ok(fitted.has('DIV.c8|ren:tx'), [...fitted].join(','));
});

// S4: the wall-clock deadline is replaced by a deterministic work budget (samples fed to the driver-smoothing fits)
const scrollEls = () => {
  const T = frameTimes(120, 5000); const { sy, inputLog } = scrollSteps(T, [[500, 100], [1400, 300], [2300, 150], [3200, 450], [4100, 0]]);
  const ch = (alpha, gain) => simulateSmoother('ema', { alpha }, sy.map((_, k) => gain * Math.min(1, sy[Math.max(0, k - 1)] / 450)), T, 0);
  return () => synthTake({ rate: 120, T, sy, inputLog, els: [{ desc: 'DIV.a', ch: { 'drv:--p': ch(0.15, 400) } }, { desc: 'DIV.b', ch: { 'drv:--p': ch(0.3, 300) } }, { desc: 'DIV.c', ch: { 'drv:--p': ch(0.08, 200) } }] });
};
const strip = (r) => { const o = structuredClone(r); delete o.capped; return JSON.stringify(o); };

test('workBudget: unset or large enough changes nothing; the work is counted and reported', () => {
  const take = scrollEls();
  const free = fitTakeSet({ primary: take() });
  assert.ok(free.capped.workUnits > 0, 'driver-smoothing work counted');
  assert.equal(free.capped.budgetHit, false);
  const roomy = fitTakeSet({ primary: take() }, { workBudget: free.capped.workUnits + 1 });
  assert.equal(roomy.capped.budgetHit, false);
  assert.equal(strip(roomy), strip(free));
});

test('workBudget spent: later channels ledgered as unk_fit_budget, flag fit_budget, same result every run, no clock read', () => {
  const take = scrollEls();
  const now = Date.now; let clockReads = 0;
  Date.now = () => { clockReads++; return now(); };
  let a, b;
  try { a = fitTakeSet({ primary: take() }, { workBudget: 1 }); b = fitTakeSet({ primary: take() }, { workBudget: 1 }); } finally { Date.now = now; }
  assert.equal(clockReads, 0, 'the budget never reads the wall clock');
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.capped.budgetHit, true);
  assert.equal(a.partial, true);
  const left = a.unknowns.filter(u => u.id === 'unk_fit_budget');
  assert.equal(left.length, 2, 'one channel fitted, two left');
  assert.ok(left.every(u => /work budget 1 reached/.test(u.reason)));
  assert.ok(a.flags.some(f => f.id === 'fit_budget'));
});
