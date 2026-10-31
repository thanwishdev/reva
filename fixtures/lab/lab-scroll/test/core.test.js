import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core.js';
import { simulate } from '../refsim.mjs';
import { REGIMES, frameTime, planFrames } from '../plan.mjs';

const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const frames = (n, dt, sy = 0, k0 = 1) => Array.from({ length: n }, (_, i) => ({ k: k0 + i, T: (k0 + i) * dt, sy, sx: 0 }));

test('params round trip through the URL hash', () => {
  const p = { alpha: 0.18, write: 'q3', list: [1, 2.5], s: 'ü' };
  assert.deepEqual(C.decodeParams('#p=' + C.encodeParams(p)), p);
  assert.deepEqual(C.decodeParams(''), {});
  assert.match(C.encodeParams(p), /^[A-Za-z0-9_-]+$/);
});

test('written text and quantisation', () => {
  assert.equal(C.fmt(0.123456, 'q3'), '0.123');
  assert.equal(C.fmt(0.123456, 'q2'), '0.12');
  assert.equal(C.written(0.1 + 0.2, 'full'), 0.1 + 0.2);
  assert.equal(C.written(0.0006, 'q3'), 0.001);
});

test('EMA step response is geometric until the snap', () => {
  let cur = 0; const a = 0.18;
  for (let n = 1; n <= 20; n++) { cur = C.emaStep(cur, 1, a, 1e-3); close(cur, 1 - Math.pow(1 - a, n), 1e-12); }
  for (let n = 0; n < 60; n++) cur = C.emaStep(cur, 1, a, 1e-3);
  assert.equal(cur, 1);
});

test('asymmetric step: instant up, eased down', () => {
  assert.equal(C.asymStep(0.2, 0.9, 0.25, 1e-3), 0.9);
  close(C.asymStep(0.9, 0.5, 0.25, 1e-3), 0.9 - 0.25 * 0.4);
});

test('M02 refsim: one scroll jump gives the geometric recurrence of the smoothstep target', () => {
  const dt = 1000 / 120, a = 0.12;
  const fr = [...frames(5, dt, 0), ...frames(60, dt, 1100, 6)];
  const sim = simulate('m02', { alpha: a }, { frames: fr, inputs: [] });
  const tgt = C.smoothstep((0.85 - (1500 - 1100) / 800) / 0.6);
  const e = sim.channels['#c|drv:--e'];
  for (let n = 1; n <= 20; n++) close(e[4 + n], tgt * (1 - Math.pow(1 - a, n)), 1e-12);
  assert.equal(e[e.length - 1], tgt);
});

test('M02 refsim: q3 and q2 write the quantised value, the state stays unquantised', () => {
  const fr = [...frames(2, 10, 0), ...frames(30, 10, 1100, 3)];
  const full = simulate('m02', { alpha: 0.18 }, { frames: fr, inputs: [] }).channels['#c|drv:--e'];
  const q3 = simulate('m02', { alpha: 0.18, write: 'q3' }, { frames: fr, inputs: [] }).channels['#c|drv:--e'];
  full.forEach((v, i) => close(q3[i], Math.round(v * 1000) / 1000, 1.0000001e-3 / 2));
});

test('M03 refsim: snap on rise, ease on fall (enter), symmetric EMA (exit)', () => {
  const dt = 1000 / 60;
  const fr = [...frames(3, dt, 0), ...frames(20, dt, 2400, 4), ...frames(40, dt, 2000, 24)];
  const sim = simulate('m03', { aDown: 0.25, aExit: 0.18 }, { frames: fr, inputs: [] });
  const a = sim.channels['#c|drv:--a'];
  assert.equal(a[3], sim.aux.ta[3]);                       // rising: instant
  assert.ok(a[24] > sim.aux.ta[24]);                       // falling: lags the target
  close(a[24], a[23] + 0.25 * (sim.aux.ta[24] - a[23]), 1e-12);
});

test('M04 refsim: hysteresis edges up at i+0.8, down at i+0.2', () => {
  const dt = 1000 / 60, g = C.M04.geom(C.M04.defaults);
  const at = (tu) => g.pinStart + g.S + g.tabUnit * tu;
  const ys = [0.75, 0.85, 1.75, 1.85, 1.3, 1.1, 1.25, 0.95];
  const fr = ys.map((tu, i) => ({ k: i + 1, T: (i + 1) * dt, sy: Math.round(at(tu)), sx: 0 }));
  const idx = simulate('m04', {}, { frames: fr, inputs: [] }).channels['#c|drv:--i'];
  assert.deepEqual(idx, [0, 1, 1, 2, 2, 1, 1, 1]);
});

test('M05 core: latch geometry, retarget from current, pass-through at rest', () => {
  assert.equal(C.M05.latched(3100), true);
  assert.equal(C.M05.latched(500), false);
  const st = C.M05.init(), p = { dur: 540 };
  let r = C.M05.wheel(st, p, { dy: 120, now: 1000, sy: 3100, armed: true });
  assert.deepEqual([r.prevent, r.action], [true, 'start']);
  r = C.M05.wheel(st, p, { dy: 120, now: 1100, sy: 3100, armed: true });
  assert.deepEqual([r.prevent, r.action], [true, 'swallowed']);
  const mid = C.M05.value(st, p, 1200);
  r = C.M05.wheel(st, p, { dy: -120, now: 1200, sy: 3100, armed: true });
  assert.deepEqual([r.prevent, r.action], [true, 'retarget']);
  assert.equal(st.tw.from, mid);
  C.M05.frame(st, p, 1200 + 540);
  assert.equal(st.p, 0);
  r = C.M05.wheel(st, p, { dy: -120, now: 3000, sy: 3100, armed: true });
  assert.deepEqual([r.prevent, r.action], [false, 'at-rest']);
  r = C.M05.wheel(st, p, { dy: 120, now: 3000, sy: 100, armed: true });
  assert.equal(r.prevent, false);
});

test('M09 refsim: damp with dt from the rAF timestamps, done when the rounded values agree', () => {
  const dt = 1000 / 60, lerp = 0.1;
  const fr = frames(80, dt);
  const wheel = { type: 'wheel', k: 3, dy: 120 };
  const sim = simulate('m09', { lerp }, { frames: fr, inputs: [wheel] });
  const y = sim.channels['#c|drv:--y'];
  close(y[3], 120 * (1 - Math.exp(-lerp * 60 * dt / 1000)), 1e-9);          // first frame after the wheel (index 3 = frame 4)
  close(y[8], 120 * (1 - Math.exp(-lerp * 60 * 6 * dt / 1000)), 1e-9);   // six frames after the wheel
  assert.equal(y[y.length - 1], 120);
  assert.throws(() => simulate('m09', { lerp }, { frames: fr, inputs: [{ type: 'wheel', k: null, dy: 1 }] }), /frame index/);
});

test('M09 refsim: the same wheel at 120 Hz and 60 Hz gives the same curve in ms (dt-aware)', () => {
  const lerp = 0.1;
  const f60 = frames(60, 1000 / 60), f120 = frames(120, 1000 / 120);
  const a = simulate('m09', { lerp }, { frames: f60, inputs: [{ type: 'wheel', k: 2, dy: 100 }] }).channels['#c|drv:--y'];
  const b = simulate('m09', { lerp }, { frames: f120, inputs: [{ type: 'wheel', k: 4, dy: 100 }] }).channels['#c|drv:--y'];
  for (let n = 1; n <= 30; n++) close(a[2 + n - 1], b[4 + 2 * n - 1], 1e-9);   // frame 2+n at 60 Hz is the same instant as frame 4+2n at 120 Hz
});

test('M09b refsim: per-frame lerp, so the same wheel is twice as fast in ms at 120 Hz', () => {
  const a = simulate('m09b', { lerp: 0.1 }, { frames: frames(60, 1000 / 60), inputs: [{ type: 'wheel', k: 2, dy: 100 }] }).channels['#c|drv:--y'];
  const b = simulate('m09b', { lerp: 0.1 }, { frames: frames(120, 1000 / 120), inputs: [{ type: 'wheel', k: 4, dy: 100 }] }).channels['#c|drv:--y'];
  close(a[2], 10, 1e-12); close(b[4], 10, 1e-12);                           // one frame after the wheel: 0.1 of 100 at either rate
  assert.ok(b[4 + 5] < a[2 + 5] || Math.abs(b[4 + 5] - a[2 + 5]) < 1e-9);
});

test('refsim refuses non-contiguous frames (R6 rows must be passed before dropping)', () => {
  const fr = frames(10, 10).filter((_, i) => i % 2 === 0);
  assert.throws(() => simulate('m01', {}, { frames: fr, inputs: [] }), /contiguous/);
});

test('refsim is deterministic', () => {
  const fr = [...frames(5, 10, 0), ...frames(50, 10, 1000, 6)];
  const a = JSON.stringify(simulate('m02', { alpha: 0.25 }, { frames: fr, inputs: [] }));
  const b = JSON.stringify(simulate('m02', { alpha: 0.25 }, { frames: fr, inputs: [] }));
  assert.equal(a, b);
});

test('hx frame grid per regime, R5 stall (design X1)', () => {
  assert.equal(frameTime('R3', 12), 100);
  assert.equal(frameTime('R2', 6), 100);
  assert.equal(frameTime('R4', 3), 100);
  assert.equal(frameTime('R5', 29), Math.round(29 * 1000 / 60 * 1e6) / 1e6);
  const dt = 1000 / 60;
  assert.ok(Math.abs(frameTime('R5', 30) - frameTime('R5', 29) - 100) < 1e-5, 'frame 30 follows a 100 ms stall');
  assert.ok(Math.abs(frameTime('R5', 31) - frameTime('R5', 30) - dt) < 1e-5);
  assert.equal(REGIMES.R6.stride, 2);
});

test('planned frames: hold, scrollTo, wheel and dense sweep accounting', () => {
  const plan = planFrames([{ hold: 500 }, { scrollTo: 700 }, { hold: 100 }, { wheel: { dy: 5, n: 2 } }, { denseSweep: { from: 0, to: 20, px: 10, framesPerPos: 2 } }], 'R3', { routeId: 'm02', k0: 4 });
  assert.equal(plan.frames.length, 4 + 60 + 12 + 2 + 5 * 2);
  assert.equal(plan.frames[4 + 60 - 1].sy, 0);
  assert.equal(plan.frames[4 + 60].sy, 700);
  assert.deepEqual(plan.inputs.filter(i => i.type === 'wheel').map(i => i.k), [76, 77]);
});
