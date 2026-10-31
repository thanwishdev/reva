// Group B: refsim against truth. Every cell of the route table, every recorded regime (R2-R5; R6 reuses R2's grid):
// the planned run is finite and settled inside the trace, refsim agrees with the independent closed forms in truth.mjs,
// and the truth block has the contract fields. Pure Node (no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { truth, SCHEMA } from '../truth.mjs';
import { simulate, plannedFrames, REGIME_DT } from '../refsim.mjs';
import { loadRoutes, loadTrace, cellParams, traceDurationMs } from '../cell.mjs';

const REGIMES = ['R2', 'R3', 'R4', 'R5'];
const cells = [];
for (const r of loadRoutes()) for (const [tn] of Object.entries(r.traces)) for (const p of r.params.grid) cells.push({ r, tn, p, trace: loadTrace(r, tn) });

test('every cell, every regime: finite, bounded, settled before the trace ends', () => {
  assert.equal(cells.length, 76);
  for (const { r, tn, p, trace } of cells) for (const R of REGIMES) {
    const frames = plannedFrames(R, traceDurationMs(trace) + 200);
    const xs = simulate(r.id, cellParams(p, trace), { frames, trace }).channels['.b0|drv:--x'];
    const tag = `${r.id}/${tn}/${R}/${JSON.stringify(p)}`;
    assert.ok(xs.every(x => Number.isFinite(x) && Math.abs(x) < 5000), 'finite ' + tag);
    // still for the last 300 ms (discrete variants snap exactly; the analytic form is checked against its tail instead)
    const tEnd = frames[frames.length - 1].T;
    const tail = xs.filter((_, i) => frames[i].T >= tEnd - 300);
    const spread = Math.max(...tail) - Math.min(...tail);
    assert.ok(spread < (p.integrator === 'i6' || r.id === 'm08' ? 0.2 : 1e-9), `not settled ${tag}: spread ${spread}`);
  }
});

test('truth blocks carry the contract fields and are JSON-clean', () => {
  for (const { r, tn, p } of cells.filter((_, i) => i % 5 === 0)) for (const R of ['R2', 'R5']) {
    const t = truth(r.id, p, R, { trace: tn });
    assert.equal(t.schema, SCHEMA); assert.equal(t.route, r.id); assert.equal(t.regime, R);
    assert.ok(Array.isArray(t.items) && t.items.length >= 1 && t.attribution && 'stagger' in t && Array.isArray(t.metrics));
    assert.deepEqual(JSON.parse(JSON.stringify(t)), t);
    for (const it of t.items) assert.ok(it.target && (it.class || it.family));
  }
});

test('M08 analytic: refsim overshoot and settle time match the closed form at every rate', () => {
  const r = loadRoutes().find(x => x.id === 'm08');
  for (const p of r.params.grid) for (const R of REGIMES) {
    const t = truth('m08', p, R, { trace: 'rest' }), it = t.items[0], A = p.A;
    const dt = REGIME_DT[R];
    // overshoot: sampled peak is at most the continuous peak and within 0.5 % A of it
    const os = it.derived.first_segment_overshoot_px / A, cf = it.closed_form.overshoot_frac_from_rest;
    assert.ok(os <= cf + 1e-9 && cf - os < 0.006, `${R} zeta ${p.zeta}: ${os} vs ${cf}`);
    // settle (2 % band, "last frame outside the band"): within the longest frame gap of the continuous value (R5: the 100 ms stall)
    assert.ok(Math.abs(it.derived.settle_2pct_after_last_event_ms - it.closed_form.settle_2pct_after_last_event_ms) <= (R === 'R5' ? 100 : dt) + 1.5, `${R} zeta ${p.zeta}: settle ${it.derived.settle_2pct_after_last_event_ms} vs ${it.closed_form.settle_2pct_after_last_event_ms}`);
    assert.ok(Math.abs(it.params.omega0 - p.omega0) < 1e-5 && Math.abs(it.params.zeta - p.zeta) < 1e-5);
    assert.ok(Math.abs(it.params.k_over_m - p.omega0 ** 2) < 1e-4);
  }
});

test('M08 retarget / v0 traces: refsim equals the continuous chain at the frame times (i6 is frame invariant)', () => {
  const r = loadRoutes().find(x => x.id === 'm08');
  for (const tn of ['retarget', 'v0']) for (const p of r.params.grid) {
    const a = truth('m08', p, 'R2', { trace: tn }).items[0], b = truth('m08', p, 'R3', { trace: tn }).items[0], c = truth('m08', p, 'R4', { trace: tn }).items[0];
    for (const x of [b, c]) {
      assert.ok(Math.abs(x.derived.final_px - a.derived.final_px) < 0.2, `final ${x.derived.final_px} vs ${a.derived.final_px}`);
      assert.equal(x.retargets.length, a.retargets.length);
    }
    // closed-form 2 % settle after the last event vs refsim
    assert.ok(Math.abs(a.derived.settle_2pct_after_last_event_ms - a.closed_form.settle_2pct_after_last_event_ms) <= 1000 / 60 + 1.5, `${tn} ${JSON.stringify(p)}`);
  }
});

test('M10: refsim stopping distance equals the independent recurrence at constant frame rate; zero release velocity yields no momentum item', () => {
  const r = loadRoutes().find(x => x.id === 'm10');
  for (const tn of ['fast', 'slow']) for (const p of r.params.grid) for (const R of ['R2', 'R3', 'R4']) {
    const it = truth('m10', p, R, { trace: tn }).items.find(i => i.class === 'friction');
    assert.ok(it, 'friction item'); assert.equal(it.law, p.law === 'dt' ? 'dt-aware' : 'per-frame');
    assert.ok(Math.abs(it.derived.stopping_distance_px - it.closed_form.stopping_distance_px) < 1e-3, `${tn} ${R} ${JSON.stringify(p)}: ${it.derived.stopping_distance_px} vs ${it.closed_form.stopping_distance_px}`);
    assert.ok(Math.abs(it.params.release_velocity_px_ms - (tn === 'fast' ? 0.6 : 0.25)) < 1e-9);
  }
  for (const p of r.params.grid) {
    const items = truth('m10', p, 'R3', { trace: 'still' }).items;
    assert.ok(!items.some(i => i.class === 'friction'));
    assert.equal(items.find(i => i.segment === 'post-release').family, 'no-momentum');
  }
});

test('M10: the per-frame law stops in a time proportional to the frame period, the dt-aware law does not (the two-rate signature)', () => {
  const r = loadRoutes().find(x => x.id === 'm10');
  const f = (p, R) => truth('m10', p, R, { trace: 'fast' }).items.find(i => i.class === 'friction').derived;
  const pf = r.codeVariants.find(v => v.id === 'frame').default, pd = r.codeVariants.find(v => v.id === 'dt').default;
  assert.ok(Math.abs(f(pf, 'R3').stop_ms_after_release / f(pf, 'R2').stop_ms_after_release - 0.5) < 0.03, 'per-frame: duration halves at 2x the rate');
  assert.ok(Math.abs(f(pf, 'R3').stopping_distance_px / f(pf, 'R2').stopping_distance_px - 1) < 0.01, 'per-frame: distance unchanged (release velocity is converted at a nominal 60 Hz)');
  assert.ok(Math.abs(f(pd, 'R3').stop_ms_after_release / f(pd, 'R2').stop_ms_after_release - 1) < 0.03, 'dt-aware: duration in ms is rate independent');
});

test('M07: integrators are distinguishable from the closed form by the planned curve', () => {
  const r = loadRoutes().find(x => x.id === 'm07');
  const frames = plannedFrames('R2', 6400), trace = loadTrace(r, 'p1000');
  const curve = (v) => simulate('m07', cellParams(v.default, trace), { frames, trace }).channels['.b0|drv:--x'];
  const ref = curve(r.codeVariants.find(v => v.id === 'i6'));
  const diff = Object.fromEntries(r.codeVariants.filter(v => v.id !== 'i4' && v.id !== 'i6').map(v => [v.id, Math.max(...curve(v).map((x, i) => Math.abs(x - ref[i])))]));
  console.log('M07 default set vs analytic at 60 Hz, max px:', JSON.stringify(Object.fromEntries(Object.entries(diff).map(([k, d]) => [k, +d.toFixed(3)]))));
  assert.ok(diff.i1h16 > 2, 'i1h16 differs from the analytic curve');
  assert.ok(diff.i1h1 < diff.i1h16);
});
