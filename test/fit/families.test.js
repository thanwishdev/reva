// Fitter families on synthetic curves with known truth (own code, no site data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitTakeSet } from '../../src/analysis/fit/index.js';
import { cubicBezier } from '../../src/analysis/oracles.js';
import { NAMED } from '../../src/analysis/fit/eases.js';
import { simulate, HYPOTHESES } from '../../src/analysis/fit/integrators.js';
import { springEval } from '../../src/analysis/fit/spring.js';
import { simulateSmoother, MAP_SHAPES } from '../../src/analysis/fit/smoothing.js';
import { synthTake, frameTimes, scrollSteps } from './helpers.js';

const rel = (a, b) => Math.abs(a / b - 1);
const tweenCh = (E, t0, D, from, to) => (k, T) => from + (to - from) * (T <= t0 ? 0 : T >= t0 + D ? 1 : E((T - t0) / D));
const main = (res, ch = 'ren:tx') => res.records.filter((r) => r.target.channel === ch);

test('free cubic-bezier: sub-frame onset, duration, control points, CI covers truth', () => {
  const E = cubicBezier(0.3, 0.1, 0.2, 1);
  const res = fitTakeSet({ primary: synthTake({ dur: 1600, els: [{ desc: 'DIV.b0', ch: { 'ren:tx': tweenCh(E, 403.7, 620, 100, 400) } }] }) });
  const [r] = main(res);
  assert.equal(r.tier, 'fitted'); assert.equal(r.class, 'tween'); assert.equal(r.model.family, 'bezier');
  const p = r.model.params;
  assert.ok(Math.abs(p.t0.value - 403.7) < 0.05, `t0 ${p.t0.value}`); assert.ok(rel(p.D.value, 620) < 1e-3, `D ${p.D.value}`);
  assert.ok(p.t0.ci95[0] <= 403.7 && 403.7 <= p.t0.ci95[1], 't0 CI covers truth');
  for (const [i, v] of [0.3, 0.1, 0.2, 1].entries()) assert.ok(Math.abs(r.model.bezier[i] - v) < 5e-3, `bezier ${r.model.bezier}`);
  assert.ok(r.runnerUp && r.runnerUp.family, 'runner-up stored');
  assert.ok(r.derived.t90 > r.derived.t50 && r.derived.t50 > r.derived.t10);
});

test('named ease snaps (easeOutCubic) and the free fit stays in the record', () => {
  const res = fitTakeSet({ primary: synthTake({ dur: 1500, els: [{ desc: 'DIV.b0', ch: { 'ren:ty': tweenCh(NAMED.easeOutCubic.fn, 250, 680, 0, -240) } }] }) });
  const [r] = main(res, 'ren:ty');
  assert.equal(r.class, 'tween'); assert.equal(r.model.ease, 'easeOutCubic');
  assert.ok(rel(r.model.params.D.value, 680) < 1e-3);
  assert.ok(r.freeFit && r.freeFit.family === 'bezier');
});

test('back-out bezier (≈10 % overshoot) is a tween, never a confident spring (understudy trap, S3 §2.4)', () => {
  const E = cubicBezier(0.34, 1.56, 0.64, 1);
  const res = fitTakeSet({ primary: synthTake({ dur: 1600, els: [{ desc: 'DIV.b0', ch: { 'ren:tx': tweenCh(E, 300, 800, 0, 300) } }] }) });
  const [r] = main(res);
  assert.notEqual(r.class, 'spring'); assert.ok(r.class === 'tween' || r.class === 'unknown', r.class);
});

for (const [z, w] of [[0.25, 22], [1.0, 18], [1.5, 25]]) {
  test(`analytic spring ζ=${z}: ω, ζ within 1 %, overshoot within 0.02·A`, () => {
    const m = { t0: 412.5, x0: 0, v0: 0, w, z, targets: [250], tr: [] };
    const res = fitTakeSet({ primary: synthTake({ dur: 2600, els: [{ desc: 'DIV.s', ch: { 'ren:tx': (k, T) => springEval(m, [T])[0] } }] }) }, { integrators: false });
    const r = main(res).find((x) => x.class === 'spring' || x.class === 'unknown');
    assert.ok(r, JSON.stringify(main(res).map((x) => [x.class, x.model.family])));
    const om = r.derived.omega, ze = r.derived.zeta;
    assert.ok(rel(om, w) < 0.01, `ω ${om}`); assert.ok(rel(ze, z) < 0.01, `ζ ${ze}`);
    const ovTruth = z < 1 ? 250 * Math.exp((-z * Math.PI) / Math.sqrt(1 - z * z)) : 0;
    assert.ok(Math.abs(r.derived.overshoot - ovTruth) <= 0.02 * 250, `overshoot ${r.derived.overshoot} vs ${ovTruth}`);
  });
}

// timer retarget mid-flight (the lab's M07 traces retarget every 400 / 1000 ms)
const springTake = (hid, rate, prm, dur = 2000) => {
  const h = HYPOTHESES.find((x) => x.id === hid); const T = frameTimes(rate, dur);
  const y = simulate(h, { ...prm, t0: 400, x0: 0, v0: 0, targets: [300, 100], tr: [800] }, T);
  return synthTake({ rate, T, els: [{ desc: 'DIV.s', ch: { 'ren:tx': y } }] });
};
for (const [hid, prm] of [['I1(16)', { k: 200, c: 12 }], ['I6', { k: 240 / 0.35, c: 16 / 0.35 }], ['I4', { k: 0.10, c: 0.75 }], ['I7', { k: 100, c: 30 }]]) {
  test(`integrator ${hid} identified from a 120 Hz + 60 Hz take set, k/c within 5 %, retarget handled`, () => {
    const res = fitTakeSet({ primary: springTake(hid, 120, prm), probe: springTake(hid, 60, prm) });
    const r = main(res).find((x) => x.class === 'spring');
    assert.ok(r, JSON.stringify(main(res).map((x) => [x.class, x.model.family, x.fit.rms])));
    assert.equal(r.model.integrator.identified, true, JSON.stringify(r.model.integrator.table && r.model.integrator.table.map((t) => [t.hyp, t.admissible, t.L | 0])));
    assert.ok(r.model.integrator.set.includes(hid), `set ${r.model.integrator.set}`);
    const h = HYPOTHESES.find((x) => x.id === hid); const kc = h.native ? { k: prm.k * 3600, c: prm.c * 60 } : prm;
    assert.equal(r.model.params.k.provenance, 'fitted');
    assert.ok(rel(r.model.params.k.value, kc.k) < 0.05 && rel(r.model.params.c.value, kc.c) < 0.05, `k ${r.model.params.k.value} c ${r.model.params.c.value}`);
  });
}

test('out-of-set integrator (I1(5)), one take: k, c are withheld or within 5 % — never confidently wrong (M07x rule)', () => {
  const T = frameTimes(120, 2000); const y = simulate({ id: 'I1(5)', kind: 'sie-substep', h: 5 }, { k: 200, c: 12, t0: 400, x0: 0, v0: 0, targets: [300, 100], tr: [800] }, T);
  const res = fitTakeSet({ primary: synthTake({ rate: 120, T, els: [{ desc: 'DIV.s', ch: { 'ren:tx': y } }] }) });
  const r = main(res).find((x) => x.class === 'spring'); assert.ok(r);
  if (r.model.params.k.provenance === 'fitted') assert.ok(rel(r.model.params.k.value, 200) < 0.05 && rel(r.model.params.c.value, 12) < 0.05, `k ${r.model.params.k.value}`);
  else { assert.equal(r.model.params.k.value, null); assert.equal(r.model.valid_for_reproduction_only, true); assert.ok(r.unknowns.some((u) => u.id === 'unk_spring_integrator' && u.probe)); }
});

const emaTake = (rate, law, prm, stall) => {
  const T = frameTimes(rate, 5000, { stall }); const { sy, inputLog } = scrollSteps(T, [[500, 100], [1400, 300], [2300, 150], [3200, 450], [4100, 0]]);
  const map = (s) => 20 + 400 * MAP_SHAPES.smoothstep(Math.max(0, Math.min(1, (s - 80) / 300)));
  const g = sy.map((_, k) => map(sy[Math.max(0, k - 1)]));
  const y = simulateSmoother(law, prm, g, T, g[0]);
  return synthTake({ rate, T, sy, inputLog, els: [{ desc: 'DIV.c', ch: { 'drv:--p': y } }] });
};
test('scroll EMA: smoothstep map, α per frame, per-frame law from two rates (G1-4 §8.4)', () => {
  const res = fitTakeSet({ primary: emaTake(120, 'ema', { alpha: 0.12 }), probe: emaTake(60, 'ema', { alpha: 0.12 }) });
  const [r] = main(res, 'drv:--p');
  assert.equal(r.class, 'first-order smoothing'); assert.equal(r.model.law, 'per-frame');
  assert.ok(rel(r.model.params.alpha_per_frame.value, 0.12) < 0.01);
  assert.equal(r.model.map.shape, 'smoothstep'); assert.ok(Math.abs(r.model.map.s0_px - 80) <= 2 && Math.abs(r.model.map.s1_px - 380) <= 2, JSON.stringify(r.model.map));
  assert.equal(r.attribution.label, 'scroll-linked');
});
test('scroll dt-damp: law dt-aware from two rates; τ invariant', () => {
  const res = fitTakeSet({ primary: emaTake(120, 'dtdamp', { lambda: 10 }), probe: emaTake(60, 'dtdamp', { lambda: 10 }) });
  const [r] = main(res, 'drv:--p');
  assert.equal(r.class, 'first-order smoothing'); assert.equal(r.model.law, 'dt-aware');
  assert.ok(rel(r.model.params.tau_ms.value, 100) < 0.02, `tau ${r.model.params.tau_ms.value}`);
});
test('scroll EMA, one take: α and τ fitted, law unknown with a probe (U5)', () => {
  const res = fitTakeSet({ primary: emaTake(120, 'ema', { alpha: 0.2 }) });
  const [r] = main(res, 'drv:--p');
  assert.equal(r.model.law, 'unknown'); assert.ok(r.unknowns.some((u) => u.id === 'unk_smoothing_law'));
});
test('R5 stall decides the smoothing law in one take', () => {
  const res = fitTakeSet({ primary: emaTake(60, 'ema', { alpha: 0.15 }, { every: 30, ms: 100 }) });
  const [r] = main(res, 'drv:--p');
  assert.equal(r.model.law, 'per-frame', JSON.stringify(r.model.lawEvidence));
});
test('R6 (every 2nd row dropped, env unchanged): α corrected to the page frame within 10 %', () => {
  const t = emaTake(120, 'ema', { alpha: 0.12 }); t.data.rows = t.data.rows.filter((_, i) => i % 2 === 0);
  const res = fitTakeSet({ primary: t });
  const [r] = main(res, 'drv:--p');
  assert.ok(r.model.strideCorrection && r.model.strideCorrection.stride === 2);
  assert.ok(rel(r.model.params.alpha_per_frame.value, 0.12) < 0.1, `α ${r.model.params.alpha_per_frame.value}`);
});

test('asymmetric smoothing: instant on increase, eased on decrease (M03 form) → asymmetric, snap-on-rise', () => {
  const res = fitTakeSet({ primary: emaTake(120, 'asym', { alphaUp: 1, alphaDown: 0.1 }) });
  const [r] = main(res, 'drv:--p');
  assert.equal(r.class, 'asymmetric smoothing', JSON.stringify(r.ambiguity));
  assert.equal(r.smoothing.asymmetric.snap_on_rise, true); assert.ok(rel(r.model.params.alphaDown.value, 0.1) < 0.01);
});

test('restarted expo.out tween on scroll (M21 form) → restarted tween, time-based non-LTI, step-response duration within 5 %', () => {
  const res = fitTakeSet({ primary: emaTake(120, 'restarted', { L: 450, delay: 8.333333, E: NAMED['expo.out'].fn }) });
  const [r] = main(res, 'drv:--p');
  assert.equal(r.class, 'restarted tween'); assert.equal(r.model.law, 'time-based, non-LTI');
  assert.ok(rel(r.derived.stepResponseMs, 450) < 0.05, `L ${r.derived.stepResponseMs}`);
});

test('attribution with an idle-control take: timer-driven element → time-driven (measured); scroll EMA → scroll-linked', () => {
  const T = frameTimes(120, 5000); const { sy, inputLog } = scrollSteps(T, [[500, 100], [1400, 300], [2300, 150], [3200, 450], [4100, 0]]);
  const map = (s) => 400 * MAP_SHAPES.linear(Math.max(0, Math.min(1, s / 450)));
  const ema = simulateSmoother('ema', { alpha: 0.15 }, sy.map((_, k) => map(sy[Math.max(0, k - 1)])), T, 0);
  const tick = (k, t) => 20 * (1 - Math.cos((2 * Math.PI * t) / 1500));
  const prim = synthTake({ rate: 120, T, sy, inputLog, els: [{ desc: 'DIV.e', ch: { 'drv:--p': ema } }, { desc: 'DIV.t', ch: { 'ren:ty': tick } }] });
  const idle = synthTake({ rate: 120, T, els: [{ desc: 'DIV.e', ch: { 'drv:--p': () => 0 } }, { desc: 'DIV.t', ch: { 'ren:ty': tick } }] });
  const res = fitTakeSet({ primary: prim, idle });
  const lab = (d) => res.records.find((r) => r.target.desc === d).attribution;
  assert.equal(lab('DIV.e').label, 'scroll-linked');
  assert.deepEqual([lab('DIV.t').label, lab('DIV.t').provenance], ['time-driven', 'measured']);
});
