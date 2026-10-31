// FITFIX (corpus): the deterministic evaluation budget covers every optimiser path (numeric.js meter), and a spring fit
// that ends on its ζ bound is not reported as a confident spring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitTakeSet } from '../../src/analysis/fit/index.js';
import { meter } from '../../src/analysis/fit/numeric.js';
import { springEval } from '../../src/analysis/fit/spring.js';
import { synthTake } from './helpers.js';

const els = Array.from({ length: 4 }, (_, i) => ({ desc: `DIV.c${i}`, ch: { 'ren:tx': (k, T) => { const t0 = 100 + 110 * i, d = 300 + 60 * i, u = Math.min(1, Math.max(0, (T - t0) / d)); return 40 * (i + 1) * u * u * (3 - 2 * u); } } }));
const take = () => synthTake({ dur: 1400, els });

test('evalBudget / channelEvalBudget: unset or roomy changes nothing (same bytes), and the meter is disarmed afterwards', () => {
  const free = fitTakeSet({ primary: take() });
  assert.ok(free.meterStats.evalUnits > 0 && free.meterStats.maxChannel > 0, 'evaluations counted');
  assert.ok(!('meterStats' in JSON.parse(JSON.stringify(free))), 'diagnostics are not serialised');
  const roomy = fitTakeSet({ primary: take() }, { evalBudget: free.meterStats.evalUnits + 1, channelEvalBudget: free.meterStats.maxChannel + 1 });
  assert.equal(JSON.stringify(roomy), JSON.stringify(free));
  assert.equal(meter.limit, Infinity); assert.equal(meter.hit, null);
});

test('channelEvalBudget: a channel past it is cut mid-fit as unknown with the reason, the others are untouched, deterministic, no clock', () => {
  const free = fitTakeSet({ primary: take() });
  const cap = Math.floor(free.meterStats.maxChannel / 2);
  const now = Date.now; let reads = 0; Date.now = () => { reads++; return now(); };
  let a, b; try { a = fitTakeSet({ primary: take() }, { channelEvalBudget: cap }); b = fitTakeSet({ primary: take() }, { channelEvalBudget: cap }); } finally { Date.now = now; }
  assert.equal(reads, 0, 'the budget never reads the wall clock');
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const cut = a.records.filter((r) => r.unknowns.some((u) => u.id === 'unk_fit_budget'));
  assert.ok(cut.length >= 1);
  for (const r of cut) { assert.equal(r.tier, 'unknown'); assert.ok(r.flags.some((f) => f.id === 'fit_budget' && /channel evaluation budget/.test(f.detail))); }
  assert.ok(a.flags.some((f) => f.id === 'fit_eval_budget')); assert.equal(a.partial, true);
  assert.equal(a.capped.cutMidFit.length, cut.length); assert.equal(a.capped.evalBudgetHit, false);
  // channels under the cap fit exactly as without it
  const key = (r) => `${r.target.desc}|${r.target.channel}`; const cutKeys = new Set(cut.map(key));
  const same = (res) => JSON.stringify(res.records.filter((r) => !cutKeys.has(key(r))));
  assert.equal(same(a), same(free));
});

test('evalBudget spent: the running channel is cut, later ones ledgered unfitted, flag fit_budget', () => {
  const a = fitTakeSet({ primary: take() }, { evalBudget: 1 });
  assert.equal(a.capped.evalBudgetHit, true);
  assert.ok(a.records.some((r) => r.unknowns.some((u) => u.id === 'unk_fit_budget' && /take evaluation budget 1/.test(u.reason))));
  const left = a.unknowns.filter((u) => u.id === 'unk_fit_budget' && /channel not fitted: take evaluation budget 1/.test(u.reason));
  assert.ok(left.length >= 1);
  assert.ok(a.flags.some((f) => f.id === 'fit_budget'));
});

test('a spring fit ending on the ζ bound (true ζ 0.002 < 0.005) is not reported as a confident spring', () => {
  const ch = { 'ren:tx': (k, T) => springEval({ t0: 200, x0: 0, v0: 0, w: 20, z: 0.002, targets: [100], tr: [] }, [T])[0] };
  const res = fitTakeSet({ primary: synthTake({ dur: 2500, els: [{ desc: 'DIV.s', ch }] }) });
  assert.ok(res.records.length >= 1);
  for (const r of res.records) {
    assert.notEqual(r.tier === 'fitted' && r.class, 'spring');
    assert.ok(r.flags.some((f) => f.id === 'spring_zeta_bound'), JSON.stringify(r.flags));
  }
});

// look (FITBUDGET, 20 Oct 2026): a real two-phase opacity ramp spent its whole channel budget in the integrator identification
// (9 hypotheses, ~225 M evaluations) and got no model. The identification is a stage with its own budget; the curve keeps
// the model the analytic spring gave, and the unknown says what was not reached.
const springTake = () => synthTake({ dur: 2500, els: [{ desc: 'DIV.sp', ch: { 'ren:tx': (k, T) => springEval({ t0: 200, x0: 0, v0: 0, w: 14, z: 0.55, targets: [120], tr: [] }, [T])[0] } }] });

test('withStage: a stage hit is cleared for the caller, a channel hit passes through, limits restore', async () => {
  const { withStage, charge, FitBudgetError } = await import('../../src/analysis/fit/numeric.js');
  Object.assign(meter, { units: 0, chan: 0, limit: Infinity, chanLimit: 1000, hit: null, stage: 0, stageLimit: Infinity });
  try {
    let cutSeen = null;
    const used = withStage(100, (cut) => { try { for (let i = 0; i < 50; i++) charge(10); } catch (e) { assert.ok(e instanceof FitBudgetError && e.budget === 'stage'); } cutSeen = cut(); });
    assert.equal(cutSeen, true); assert.equal(meter.hit, null, 'cleared after the stage'); assert.ok(used > 100 && used <= 110);
    assert.equal(meter.stageLimit, Infinity, 'restored');
    charge(10); // the channel meter went on counting, and still works
    withStage(1e9, () => { try { for (let i = 0; i < 200; i++) charge(10); } catch (e) { assert.equal(e.budget, 'channel'); } });
    assert.equal(meter.hit, 'channel', 'a channel hit is not the stage\'s to clear');
  } finally { Object.assign(meter, { units: 0, chan: 0, limit: Infinity, chanLimit: Infinity, hit: null, stage: 0, stageLimit: Infinity, where: null, hitAt: null }); }
});

test('identifyBudget: roomy changes nothing; a small one keeps the fitted spring and says the identification stopped; deterministic', () => {
  const free = fitTakeSet({ primary: springTake() }, { earlyExit: true });
  const spr = free.records.find((r) => r.target.channel === 'ren:tx'); assert.ok(spr && spr.tier === 'fitted' && spr.class === 'spring', JSON.stringify(spr && [spr.tier, spr.class]));
  const roomy = fitTakeSet({ primary: springTake() }, { earlyExit: true, identifyBudget: 1e12 });
  assert.equal(JSON.stringify(roomy.records), JSON.stringify(free.records), 'a budget that is not reached changes no byte');
  const a = fitTakeSet({ primary: springTake() }, { earlyExit: true, identifyBudget: 3e5 }), b = fitTakeSet({ primary: springTake() }, { earlyExit: true, identifyBudget: 3e5 });
  assert.equal(JSON.stringify(a.records), JSON.stringify(b.records));
  const r = a.records.find((x) => x.target.channel === 'ren:tx');
  assert.equal(r.tier, 'fitted'); assert.equal(r.class, 'spring'); assert.ok(!r.unknowns.some((u) => u.id === 'unk_fit_budget'), 'not cut as a whole');
  const u = r.unknowns.find((x) => x.id === 'unk_spring_integrator');
  assert.ok(u && /integrator identification stopped at its evaluation budget \(300000\): \d of 9 hypotheses fitted/.test(u.reason) && /not reached: /.test(u.reason), u && u.reason);
  assert.equal(r.model.integrator.identified, false, 'a partial table is never an identification');
  assert.equal(a.partial, false, 'the fit itself is complete');
});

test('a channel cut by the channel budget names the stage it was in and reports what was measured', () => {
  const a = fitTakeSet({ primary: springTake() }, { channelEvalBudget: 20000 });
  const r = a.records.find((x) => x.target.channel === 'ren:tx'); const u = r.unknowns.find((x) => x.id === 'unk_fit_budget');
  assert.ok(u, JSON.stringify(r.unknowns));
  assert.match(u.reason, /channel evaluation budget 20000 reached during [a-z ,]+ \(\d+ frame evaluations\); no model is reported\. Measured: 0 to 1[\d.]+ between \d+ and \d+ ms\./, u.reason);
  assert.ok(r.derived.measured && r.derived.measured.provenance === 'measured');
  assert.ok(a.capped.cutMidFit.every((c) => typeof c.stage === 'string'));
});
