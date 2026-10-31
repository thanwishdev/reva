// Pure-core tests: every expectation has an independent oracle written in the test (closed forms), not the core's own functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cubicBezier, easeFn, easeKey, EASE_NAMES, emaStep, dampStep, asymStep, fmt, written, Engine, Replayer, frameAt, framesUpTo, rectOf, flipDelta, flipInverse, vtGroupAt, round6 } from '../core.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (tol ${tol})`);

test('cubic-bezier: CSS keyword values and symmetry', () => {
  near(cubicBezier(0.25, 0.1, 0.25, 1)(0.5), 0.8024036, 1e-6, 'ease at 0.5');   // value of the CSS `ease` curve
  near(cubicBezier(0.42, 0, 0.58, 1)(0.5), 0.5, 1e-12, 'ease-in-out symmetric');
  near(cubicBezier(0, 0, 1, 1)(0.3), 0.3, 1e-15, 'linear');
  const f = cubicBezier(0.2, 0.9, 0.1, 1);
  for (let i = 1; i < 100; i++) assert.ok(f(i / 100) >= f((i - 1) / 100), 'monotone');
});

test('named eases: endpoints, monotone in/out, ease names resolve', () => {
  for (const n of EASE_NAMES) {
    const f = easeFn(n);
    near(f(0), 0, 1e-12, n); near(f(1), 1, 1e-9, n);
  }
  assert.equal(easeKey('named:easeOutCubic'), 'easeoutcubic');
  assert.equal(easeKey('expo.out'), 'easeoutexpo');
  assert.equal(easeKey('power2.out'), 'easeoutcubic');
  assert.throws(() => easeFn('nope'));
  near(easeFn('easeInOutCubic')(0.25), 4 * 0.25 ** 3, 1e-15);
  near(easeFn('smoothstep')(0.5), 0.5, 1e-15);
});

test('fmt / written: quantised write modes', () => {
  assert.equal(fmt(0.123456, 'q3'), '0.123'); assert.equal(fmt(0.126, 'q2'), '0.13'); assert.equal(written(2.6, 'int'), 3);
  assert.equal(written(0.1 + 0.2, 'full'), 0.1 + 0.2);
});

test('EMA step response equals 1 - (1 - alpha)^n; snap lands exactly', () => {
  let cur = 0; const a = 0.18;
  for (let n = 1; n <= 40; n++) { cur = emaStep(cur, 1, a, 0); near(cur, 1 - (1 - a) ** n, 1e-14, `n=${n}`); }
  let c = 0; for (let n = 0; n < 60; n++) c = emaStep(c, 1, a, 1e-3);
  assert.equal(c, 1, 'snap');
});

test('dt-aware damp = EMA at the calibrated rate, a different curve at another', () => {
  const alpha = 0.2, lambda = -Math.log(1 - alpha) / (1000 / 60 / 1000);
  let e = 0, d = 0; for (let n = 0; n < 30; n++) { e = emaStep(e, 1, alpha, 0); d = dampStep(d, 1, lambda, 1000 / 60, 0); }
  near(e, d, 1e-12, 'same rate');
  let d2 = 0; for (let n = 0; n < 30; n++) d2 = dampStep(d2, 1, lambda, 1000 / 120, 0);
  assert.ok(Math.abs(d2 - e) > 0.02, 'half the elapsed time, less progress');
  let d3 = 0; for (let n = 0; n < 60; n++) d3 = dampStep(d3, 1, lambda, 1000 / 120, 0);
  near(d3, e, 1e-12, 'same elapsed time, same value (frame-rate independent)');
});

test('asymmetric: snap on rise, ease on fall', () => {
  assert.equal(asymStep(0.2, 0.9, 1, 0.3, 1e-3), 0.9);
  near(asymStep(0.9, 0.2, 1, 0.3, 1e-3), 0.9 + 0.3 * (0.2 - 0.9), 1e-15);
});

const spec = (mechanisms, extra = {}) => ({ viewport: { width: 1280, height: 800 }, frameMs: 1000 / 60, mechanisms: mechanisms.map((m, i) => ({ id: 'm' + i, subject: 'b0', ...m })), subjects: [], pins: [], ...extra });
const drv = (of = 'x', k0 = 0, k1 = 1) => [{ name: 'drv:--v0', kind: 'var', prop: '--v0', of, k0, k1, write: 'full' }];

test('scroll-driven map: clamps outside the range, interior follows the shape, flip mirrors it', () => {
  const m = { kind: 'scroll-driven', map: { shape: 'linear', s0: 100, s1: 300, flip: false }, smoothing: { law: 'none' }, channels: drv() };
  const sy = [0, 100, 150, 200, 300, 500];
  const input = { frames: sy.map((v, i) => ({ k: i + 1, T: round6((i + 1) * 1000 / 60), sy: v })) };
  const out = new Replayer(spec([m]), input).to(sy.length, true).map((f) => f.channels['b0|drv:--v0']);
  [0, 0, 0.25, 0.5, 1, 1].forEach((e, i) => near(out[i], e, 1e-15, `sy=${sy[i]}`));
  const mf = { ...m, map: { ...m.map, flip: true }, channels: drv('x', 0, 1) };
  const outf = new Replayer(spec([mf]), input).to(sy.length, true).map((f) => f.channels['b0|drv:--v0']);
  outf.forEach((v, i) => near(v, 1 - out[i], 1e-15));
});

test('scroll-driven + EMA over a scroll step: the exact recurrence on the frame grid', () => {
  const m = { kind: 'scroll-driven', map: { shape: 'linear', s0: 0, s1: 100, flip: false }, smoothing: { law: 'ema', alpha: 0.25, snap: 0 }, init: 'target', channels: drv() };
  const n = 30; const input = { frames: Array.from({ length: n }, (_, i) => ({ k: i + 1, T: round6((i + 1) * 1000 / 60), sy: i < 5 ? 0 : 100 })) };
  const out = new Replayer(spec([m]), input).to(n, true).map((f) => f.channels['b0|drv:--v0']);
  out.slice(0, 5).forEach((v) => assert.equal(v, 0));
  for (let i = 5; i < n; i++) near(out[i], 1 - 0.75 ** (i - 4), 1e-14, `frame ${i + 1}`);
});

test('affine channels and the written (quantised) value feeding a rendered channel', () => {
  const m = { kind: 'scroll-driven', map: { shape: 'linear', s0: 0, s1: 100, flip: false }, smoothing: { law: 'none' },
    channels: [{ name: 'drv:--v0', kind: 'var', prop: '--v0', of: 'x', k0: 1, k1: 2, write: 'q2' }, { name: 'ren:tx', kind: 'ren', prop: 'tx', via: 0, k0: 0, k1: 10 }] };
  const f = new Replayer(spec([m]), { frames: [{ k: 1, T: 16.7, sy: 33.333 }] }).to(1, true)[0];
  assert.equal(f.channels['b0|drv:--v0'], 1.67);   // 1 + 2 * 0.33333 = 1.66666 -> '1.67'
  near(f.channels['b0|ren:tx'], 16.7, 1e-12, 'rendered follows the WRITTEN value');
});

test('restarted tween: restarts at each driver change, duration L', () => {
  const m = { kind: 'scroll-driven', map: { shape: 'linear', s0: 0, s1: 100, flip: false }, smoothing: { law: 'restarted', L: 100, ease: 'linear', snap: 0 }, channels: drv() };
  const dt = 1000 / 60, n = 20; const input = { frames: Array.from({ length: n }, (_, i) => ({ k: i + 1, T: round6((i + 1) * dt), sy: i < 2 ? 0 : 100 })) };
  const out = new Replayer(spec([m]), input).to(n, true).map((f) => f.channels['b0|drv:--v0']);
  near(out[2], 0, 1e-12, 'restart frame has progress 0');
  near(out[3], dt / 100, 1e-7); near(out[4], 2 * dt / 100, 1e-7); near(out[2 + 6], 1, 1e-7, 'done after L');
});

test('hysteresis: different edges up and down, no flicker inside the band', () => {
  const m = { kind: 'hysteresis', up: [100, 200], down: [80, 180], levels: 3, init: 0, channels: drv('i') };
  const path = [0, 90, 100, 90, 85, 79, 150, 200, 190, 181, 180, 100, 79];
  const out = new Replayer(spec([m]), { frames: path.map((v, i) => ({ k: i + 1, T: round6((i + 1) * 16.6667), sy: v })) }).to(path.length, true).map((f) => f.channels['b0|drv:--v0']);
  assert.deepEqual(out, [0, 0, 1, 1, 1, 0, 1, 2, 2, 2, 1, 1, 0]);
});

test('wheel-smooth: swallows the wheel, accumulates a clamped target, rounds to done', () => {
  const m = { kind: 'wheel-smooth', law: 'ema', lerp: 0.5, mult: 1, limit: 100, channels: drv('y') };
  const dt = 1000 / 60; const n = 40;
  const input = { frames: Array.from({ length: n }, (_, i) => ({ k: i + 1, T: round6((i + 1) * dt), sy: 0 })), wheel: [{ T: round6(2 * dt), dy: 60 }, { T: round6(2 * dt), dy: 60 }] };
  const rep = new Replayer(spec([m]), input);
  const out = rep.to(n, true).map((f) => f.channels['b0|drv:--v0']);
  assert.equal(out[0], 0); assert.equal(out[2], 50, 'first frame after the wheel moves half way to the clamped target 100');
  assert.equal(out[n - 1], 100); assert.equal(rep.eventLog.length, 2);
  assert.equal(rep.eventLog[0].res[0].prevent, true);
});

test('inertia: stopping distance = v0 f/(1-f) (minus the sub-threshold step), law "dt" is frame-rate independent', () => {
  const mk = (law) => ({ kind: 'inertia', friction: 0.9, law, stopEps: 0.05, velWindowMs: 100, nominalHz: 60, x0: 100, channels: drv('x') });
  const events = [{ T: 0, type: 'down', x: 0 }, ...Array.from({ length: 40 }, (_, i) => ({ T: (i + 1) * 10, type: 'move', x: (i + 1) * 6 })), { T: 405, type: 'up', x: 240 }];
  const run = (hz, law) => {
    const dt = 1000 / hz; const n = Math.round(2500 / dt);
    const out = new Replayer(spec([mk(law)], { frameMs: dt }), { pointer: events }).to(n, true).map((f) => f.channels['b0|drv:--v0']);
    // the last drag frame is the one at T = 400 (the move at 400 and the release at 405 both land before the next frame)
    return out[out.length - 1] - out[Math.round(400 / dt) - 1];
  };
  // release velocity: 0.6 px/ms * 1000/60 = 10 px/frame; closed form sum_{n>=1, 10 f^n >= 0.05} 10 f^n
  let want = 0, v = 10; while (true) { v *= 0.9; if (Math.abs(v) < 0.05) break; want += v; }
  near(run(60, 'frame'), want, 1e-9, 'per-frame at 60 Hz');
  near(run(120, 'frame'), want, 1e-9, 'per-frame law: the distance does not depend on the frame rate either');
  // dt law at 60 and 120 Hz: same elapsed time, same decay -> distances agree to the step threshold
  near(run(60, 'dt'), run(120, 'dt'), 3.0, 'dt law: the same decay in time; the rest is the Euler step error (< 3 % of 90 px)');
});

test('flip: the inverse puts the new layout exactly on the old rect (origin top-left)', () => {
  const A = { x: 100, y: 120, w: 160, h: 100 }, B = { x: 540, y: 300, w: 320, h: 180 };
  const d = flipDelta(A, B); const t = flipInverse(d, 1); const r = rectOf(B, t);
  near(r.x, A.x, 1e-12); near(r.y, A.y, 1e-12); near(r.w, A.w, 1e-12); near(r.h, A.h, 1e-12);
  const half = rectOf(B, flipInverse(d, 0.5)); near(half.x, (A.x + B.x) / 2, 1e-12);
  assert.deepEqual(rectOf(B, flipInverse(d, 0)), B);
});

test('flip mechanism: starts on the frame after the trigger, restarts from the current rect, rests on the layout', () => {
  const m = { kind: 'flip', D: 100, ease: 'linear', A: { x: 0, y: 0, w: 100, h: 100 }, B: { x: 200, y: 0, w: 200, h: 100 }, channels: ['tx', 'ty', 'sx', 'sy'].map((p) => ({ name: 'ren:' + p, kind: 'ren', prop: p, of: p, k0: 0, k1: 1 })) };
  const dt = 10, n = 40;
  const out = new Replayer(spec([m], { frameMs: dt }), { triggers: [{ T: 50 }, { T: 200 }] }).to(n, true);
  const tx = out.map((f) => f.channels['b0|ren:tx']), sx = out.map((f) => f.channels['b0|ren:sx']);
  assert.equal(tx[4], 0, 'frame at T=50: not yet'); near(tx[5], -200, 1e-9, 'T=60: inverted'); near(tx[6], -180, 1e-9); near(tx[14], -20, 1e-9, '90 ms in: linear'); near(tx[15], 0, 1e-9, 'done 100 ms after the start');
  near(sx[5], 0.5, 1e-9);
  assert.ok(tx[20] !== 0, 'second trigger at T=200: restarted');
  // second flip goes back to layout A from the current rect (at rest on B): inverse is (+200, ..., sx 2)
  near(tx[20], 200, 1e-9); near(sx[20], 2, 1e-9);
});

test('view-transition group box: eased interpolation between the old and new boxes, delay respected', () => {
  const g = { d: 100, ease: 'linear', delay: 20, A: { x: 0, y: 0, w: 10, h: 10 }, B: { x: 100, y: 50, w: 30, h: 10 } };
  assert.equal(vtGroupAt(g, 0).x, 0); near(vtGroupAt(g, 70).x, 50, 1e-12); near(vtGroupAt(g, 70).w, 20, 1e-12); assert.equal(vtGroupAt(g, 500).x, 100);
});

test('Replayer: an event at T == T_k is handled before frame k + 1; seek-style rewinding is deterministic', () => {
  const m = { kind: 'wheel-smooth', law: 'ema', lerp: 1, mult: 1, limit: 1000, channels: drv('y') };
  const dt = 10; const input = { wheel: [{ T: 30, dy: 7 }] };
  const sp = spec([m], { frameMs: dt });
  const a = new Replayer(sp, input).to(6, true).map((f) => f.channels['b0|drv:--v0']);
  assert.deepEqual(a, [0, 0, 0, 7, 7, 7], 'frame 3 is at T=30: the wheel lands after it');
  const r = new Replayer(sp, input); r.to(6); r.rewind(); assert.deepEqual(r.to(6, true).map((f) => f.channels['b0|drv:--v0']), a);
  assert.equal(framesUpTo(input, dt, 35), 3); assert.equal(framesUpTo(input, dt, 30), 3); assert.equal(frameAt(input, dt, 4).T, 40);
});

test('Engine: unknown mechanism kinds are refused at construction', () => {
  assert.throws(() => new Engine(spec([{ kind: 'nope', channels: [] }])));
});
