// Unit tests of the cue extractor on synthetic, analytically known curves (no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { responseCues, sweepProfile, sweepCues, alignedDiff, nrmseT } from '../../src/score/cues.js';
import { durationDL, unitFor } from '../../src/score/thresholds.js';

const dt = 1000 / 120;
const outCubic = (t) => 1 - Math.pow(1 - t, 3);
/** Sample a curve x(t) (t ms since its own start ts0) on the frame grid k·dt, input at Te. */
function sampled(fn, { ts0, Te, end = 1200, amp = 100 }) {
  const T = [], v = [];
  for (let k = 0; k * dt <= end; k++) { const t = k * dt; T.push(t); v.push(amp * fn(Math.max(0, t - ts0))); }
  return { T, v, Te };
}

test('ease-out from rest: lag, t50, t90 and peak velocity match the analytic curve within a fraction of a frame', () => {
  const D = 320;
  const f = (t) => outCubic(Math.min(1, t / D));
  const tq = (q) => D * (1 - Math.cbrt(1 - q));            // analytic crossing times
  for (let i = 0; i < 24; i++) {
    const off = i * dt / 12;   // the kink at every sub-frame phase over two frames
    const ts0 = 100 + off; const s = sampled(f, { ts0, Te: 100 });
    const c = responseCues(s.T, s.v, s.Te, Infinity, { bar: 1e-6 });
    assert.ok(Math.abs(c.lag - (off + tq(0.01))) < 0.15, `lag off ${off}: ${c.lag}`);
    assert.ok(Math.abs(c.t50 - (off + tq(0.5))) < 0.6, `t50 off ${off}: ${c.t50} vs ${off + tq(0.5)}`);
    assert.ok(Math.abs(c.t90 - (off + tq(0.9))) < 0.6, `t90 off ${off}`);
    const pv = 3 / D;                                        // progress per ms at the start
    assert.ok(Math.abs(c.peakVel / pv - 1) < 0.008, `peak velocity off ${off}: ${c.peakVel} vs ${pv}`);
    assert.equal(c.overshoot, 0); assert.equal(c.crossings, 0);
  }
});

test('spring with overshoot: overshoot and crossing count', () => {
  const k = 170, cc = 13, w0 = Math.sqrt(k), z = cc / (2 * w0), wd = w0 * Math.sqrt(1 - z * z);
  const f = (t) => { const s = t / 1000; return 1 - Math.exp(-z * w0 * s) * (Math.cos(wd * s) + (z * w0 / wd) * Math.sin(wd * s)); };
  const s = sampled(f, { ts0: 100, Te: 100, end: 3000 });
  const c = responseCues(s.T, s.v, 100, Infinity, { bar: 1e-6 });
  const os = Math.exp(-z * Math.PI / Math.sqrt(1 - z * z));
  assert.ok(Math.abs(c.overshoot - os) < 0.005, `overshoot ${c.overshoot} vs ${os}`);
  assert.ok(c.crossings >= 3);
});

test('static and instant windows', () => {
  const T = [0, dt, 2 * dt, 3 * dt, 4 * dt], still = [5, 5, 5, 5, 5];
  assert.equal(responseCues(T, still, dt / 2, Infinity, { bar: 1e-6 }).static, true);
  const step = [0, 0, 10, 10, 10];
  const c = responseCues(T, step, dt, Infinity, { bar: 1e-6 });
  assert.equal(c.instant, true); assert.equal(c.peakVel, null);
});

test('unsettled window: settle times are unknown, not guessed', () => {
  const f = (t) => outCubic(Math.min(1, t / 2000));
  const s = sampled(f, { ts0: 0, Te: 0, end: 500 });
  const c = responseCues(s.T, s.v, 0, Infinity, { bar: 1e-6 });
  assert.equal(c.settledEnd, false); assert.equal(c.t99, null);
});

test('arm 1: a shifted map is reported as a range shift in vh, a different shape as residual', () => {
  const ys = []; for (let y = 0; y <= 1000; y += 10) ys.push(y);
  const ss = (t) => t * t * (3 - 2 * t);
  const map = (y, y0, shape = ss) => shape(Math.max(0, Math.min(1, (y - y0) / 400)));
  const series = (y0, shape) => { const T = [], v = []; const landings = []; let t = 0;
    for (const y of [...ys, ...ys.slice(0, -1).reverse()]) { landings.push({ T: t, y }); t += dt; T.push(t); v.push(map(y, y0, shape)); }
    return { s: { T, v }, landings }; };
  const a = series(300), b = series(340), c = series(300, (x) => x);
  const pa = sweepProfile(a.s, a.landings), pb = sweepProfile(b.s, b.landings), pc = sweepProfile(c.s, c.landings);
  const shifted = sweepCues(pa, pb, { vh: 800, maxShiftPx: 200 });
  assert.equal(shifted.shiftPx, 40); assert.ok(shifted.residualMax < 1e-9); assert.ok(shifted.maxAbs > 0.1);
  const shape = sweepCues(pa, pc, { vh: 800, maxShiftPx: 200 });
  assert.ok(shape.residualMax > 0.05);
  assert.equal(sweepCues(pa, pa, { vh: 800, maxShiftPx: 200 }).maxAbs, 0);
});

test('aligned difference and NRMSE_t use the frame grid, no warping', () => {
  const T = [0, 1, 2, 3, 4].map(k => k * dt);
  const a = { T, v: [0, 1, 2, 3, 4] }, b = { T, v: [0, 1, 2, 3, 5] };
  assert.equal(alignedDiff(a, b, -1, Infinity, 4).maxAbs, 0.25);
  assert.ok(Math.abs(nrmseT(a, b, 4).nrmse - Math.sqrt(1 / 5) / 4) < 1e-12);
});

test('provisional units: Rammsayer DL anchors and no extrapolation outside 50-1000 ms', () => {
  assert.ok(Math.abs(durationDL(50) - 30.1) < 1e-9);
  assert.ok(Math.abs(durationDL(1000) - 206.4) < 1e-9);
  assert.equal(durationDL(10), durationDL(50));
  assert.equal(durationDL(5000), durationDL(1000));
  assert.equal(unitFor('lag', { kind: 'scroll' }).jnd, 55);
  assert.equal(unitFor('peakVel').jnd, 0.07);
  assert.equal(unitFor('t10'), null);
});
