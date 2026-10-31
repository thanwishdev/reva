import test from 'node:test';
import assert from 'node:assert/strict';
import { K } from '../kernel.js';
import { labImport, fitterImport, frames, maxAbs } from './helpers.js';

// ---- easing -----------------------------------------------------------------------------------------------------
function bezierRef(x1, y1, x2, y2, u) {            // independent: plain bisection on the parametric curve
  const X = (s) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  const Y = (s) => 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  let lo = 0, hi = 1; for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (X(m) < u) lo = m; else hi = m; }
  return Y((lo + hi) / 2);
}
test('cubic-bezier matches an independent bisection solve (incl. overshooting control points)', () => {
  for (const p of [[0.25, 0.1, 0.25, 1], [0.42, 0, 0.58, 1], [0.34, 1.517, 0.64, 1], [0.2, 0.9, 0.1, 1], [0.6, -0.4, 0.4, 1.4]]) {
    const f = K.easeFn({ kind: 'bezier', p });
    for (let i = 1; i < 200; i++) assert.ok(Math.abs(f(i / 200) - bezierRef(...p, i / 200)) < 1e-9, `${p} at ${i / 200}`);
  }
  assert.ok(Math.abs(K.easeFn({ kind: 'named', name: 'ease' })(0.5) - 0.8024033) < 1e-6, 'CSS ease at 0.5');
});
test('named Penner eases are the closed forms (end points, midpoints, symmetry)', () => {
  const cases = { easeOutCubic: (u) => 1 - (1 - u) ** 3, easeInQuad: (u) => u * u, easeOutExpo: (u) => 1 - 2 ** (-10 * u), 'expo.out': (u) => 1 - 2 ** (-10 * u),
    easeInOutSine: (u) => -(Math.cos(Math.PI * u) - 1) / 2, 'power3.out': (u) => 1 - (1 - u) ** 3, easeOutCirc: (u) => Math.sqrt(1 - (u - 1) ** 2), easeOutQuint: (u) => 1 - (1 - u) ** 5 };
  for (const [n, ref] of Object.entries(cases)) { const f = K.easeFn({ kind: 'named', name: n }); for (let i = 1; i < 100; i++) assert.ok(Math.abs(f(i / 100) - ref(i / 100)) < 1e-12, n); }
  const back = K.easeFn({ kind: 'named', name: 'easeOutBack' }); assert.ok(back(0.7) > 1, 'back overshoots');
  for (const n of ['easeInOutQuad', 'easeInOutCubic', 'easeInOutExpo', 'easeInOutBack']) { const f = K.easeFn({ kind: 'named', name: n }); assert.ok(Math.abs(f(0.5) - 0.5) < 1e-9, n + ' midpoint'); }
});
test('the fitter\'s named eases agree (cross-check, skipped when the fitter is absent)', async (t) => {
  const E = await fitterImport('eases.js'); if (!E) return t.skip('fitter not found');
  for (const n of ['easeOutCubic', 'easeInOutQuart', 'easeOutExpo', 'easeInBack', 'easeOutCirc', 'ease-in-out']) {
    const a = E.NAMED[n].fn, b = K.easeFn({ kind: 'named', name: n });
    for (let i = 1; i < 100; i++) assert.ok(Math.abs(a(i / 100) - b(i / 100)) < 1e-9, n);
  }
});
test('steps and linear() stops', () => {
  const s = K.easeFn({ kind: 'steps', n: 4, pos: 'end' }); assert.deepEqual([0.1, 0.3, 0.6, 0.99, 1].map(s), [0, 0.25, 0.5, 0.75, 1]);
  const l = K.easeFn({ kind: 'stops', stops: [[0, 0], [0.5, 1], [1, 0.5]] }); assert.equal(l(0.25), 0.5); assert.equal(l(0.75), 0.75);
});

// ---- stateless motions ------------------------------------------------------------------------------------------
test('tween: rest before, end value after, quantum lattice', () => {
  const m = { kind: 'tween', from: 10, to: 110, startMs: 100, durationMs: 200, ease: { kind: 'linear' } };
  assert.equal(K.valueAt(m, 0), 10); assert.equal(K.valueAt(m, 200), 60); assert.equal(K.valueAt(m, 400), 110);
  const q = { ...m, from: 0, to: 35, durationMs: 840, startMs: 0, quantum: 1 };
  assert.equal(K.valueAt(q, 23), 0); assert.equal(K.valueAt(q, 25), 1); assert.equal(K.valueAt(q, 840), 35);
});
test('keyframes follow CSS: a hold keyframe pair, per-segment easing, alternate loop, fill', () => {
  const m = { kind: 'keyframes', startMs: 100, durationMs: 1000, iterations: 1, easingScope: 'segment', frames: [{ offset: 0, value: 0, easing: { kind: 'linear' } }, { offset: 0.6, value: 0, easing: { kind: 'bezier', p: [0.25, 0.8, 0.25, 1] } }, { offset: 1, value: 1 }] };
  assert.equal(K.valueAt(m, 50), 0); assert.equal(K.valueAt(m, 100 + 599), 0); assert.equal(K.valueAt(m, 5000), 1);
  const mid = K.valueAt(m, 100 + 800); assert.ok(Math.abs(mid - bezierRef(0.25, 0.8, 0.25, 1, 0.5)) < 1e-9, 'second segment u = 0.5');
  const loop = { kind: 'keyframes', startMs: 0, durationMs: 100, iterations: Infinity, direction: 'alternate', easingScope: 'segment', frames: [{ offset: 0, value: 0 }, { offset: 1, value: 10 }] };
  assert.equal(K.valueAt(loop, 50), 5); assert.equal(K.valueAt(loop, 150), 5); assert.equal(K.valueAt(loop, 175), 2.5); assert.equal(K.valueAt(loop, 1e6 + 25), 2.5);
  const eff = { kind: 'keyframes', startMs: 0, durationMs: 100, iterations: 1, easingScope: 'effect', easing: { kind: 'steps', n: 2, pos: 'end' }, frames: [{ offset: 0, value: 0 }, { offset: 1, value: 10 }] };
  assert.equal(K.valueAt(eff, 60), 5, 'effect easing applies to the iteration progress');
});
test('chain: the last started part wins; ticks; step', () => {
  const a = { kind: 'tween', from: 0, to: 100, startMs: 0, durationMs: 100, ease: { kind: 'linear' } }, b = { kind: 'tween', from: 50, to: 0, startMs: 50, durationMs: 100, ease: { kind: 'linear' } };
  const c = { kind: 'chain', parts: [a, b] }; assert.equal(K.valueAt(c, 49), 49); assert.equal(K.valueAt(c, 50), 50); assert.equal(K.valueAt(c, 100), 25); assert.equal(K.valueAt(c, 500), 0);
  const tk = { kind: 'ticks', startMs: 0, periodMs: 1000, values: [0, 1] }; assert.deepEqual([0, 999, 1000, 2500].map((t) => K.valueAt(tk, t)), [0, 0, 1, 0]);
  assert.equal(K.valueAt({ kind: 'step', atMs: 10, before: 1, after: 2 }, 9.9), 1);
});

// ---- springs vs the lab's independent implementation ----------------------------------------------------------------
const SCHED = { p1000: [{ t: 500, level: 1 }, { t: 1500, level: 0 }, { t: 2500, level: 1 }], retarget: [{ t: 500, level: 1 }, { t: 1000, level: 0.3 }], v0: [{ t: 500, level: 1, v: -2.5 }] };
const SETS = [{ k: 200, c: 12, m: 1 }, { k: 240, c: 16, m: 0.35 }, { k: 100, c: 30, m: 1 }];
const IDS = ['i1h16', 'i1h2', 'i1h1', 'i1h5', 'i5', 'i6', 'i7', 'verlet'];
function labRun(core, id, P, sched, times, A = 200) {
  const sim = new core.TimedSpring({ integrator: id, ...P, A }, 0); const out = []; let last = null, anchor = times[0];
  const due = sched.map((e) => ({ ...e, due: anchor + e.t })).sort((a, b) => a.due - b.due); let j = 0;
  for (const T of times) {
    while (j < due.length && due[j].due <= T && last != null) { const e = due[j++]; sim.retarget(e.level * A, e.due, e.v != null ? e.v * A : undefined); }
    out.push(last == null ? 0 : sim.frame((T - last) / 1000, T)); last = T;
  }
  return out;
}
function mineRun(id, P, sched, times, A = 200) {
  const anchor = times[0], k = P.k / P.m, c = P.c / P.m;
  const m = { kind: 'spring', integrator: K.integratorOf(id), k, c, start: { t: 0, x: 0, v: 0 }, g0: 0, onsetMs: sched[0].t, snap: id === 'i6' ? undefined : { x: 0.004, v: 0.04 },
    events: sched.map((e) => ({ t: e.t, g: e.level * A, ...(e.v != null ? { v: e.v * A } : {}) })) };
  return K.series(m, times.map((T) => T - anchor));
}
test('spring kernel == lab TimedSpring for every integrator, 3 parameter sets, 3 schedules, regular and stalled frames', async (t) => {
  const core = await labImport('lab-springs', 'core.js'); if (!core) return t.skip('lab not found');
  let worst = 0;
  for (const id of IDS) for (const P of SETS) for (const [sn, sched] of Object.entries(SCHED)) for (const fk of ['r120', 'r60', 'r30', 'stall']) {
    const times = [0, ...frames(fk, 400)];
    const a = labRun(core, id, P, sched, times), b = mineRun(id, P, sched, times);
    assert.ok(Math.max(...a.map(Math.abs)) > 50 && Math.max(...b.map(Math.abs)) > 50, 'non-vacuous: the spring really moved');
    const d = maxAbs(a, b); worst = Math.max(worst, d);
    assert.ok(d < 1e-7, `${id} ${JSON.stringify(P)} ${sn} ${fk}: max diff ${d}`);
  }
  console.log('# spring kernel vs lab TimedSpring: worst max |diff| =', worst);
});
test('i4 (native kf, cf) == lab TimedSpring', async (t) => {
  const core = await labImport('lab-springs', 'core.js'); if (!core) return t.skip('lab not found');
  for (const nat of [{ kf: 0.25, cf: 0.25 }, { kf: 0.1, cf: 0.75 }, { kf: 0.06, cf: 0.95 }, { kf: 0.052, cf: 0.183 }]) for (const fk of ['r120', 'r60', 'stall']) {
    const times = [0, ...frames(fk, 400)], sched = SCHED.p1000;
    const sim = new core.TimedSpring({ integrator: 'i4', ...nat }, 0); const a = []; let last = null; const due = sched.map((e) => ({ ...e, due: e.t })); let j = 0;
    for (const T of times) { while (j < due.length && due[j].due <= T && last != null) { const e = due[j++]; sim.retarget(e.level * 200, e.due); } a.push(last == null ? 0 : sim.frame((T - last) / 1000, T)); last = T; }
    const m = { kind: 'spring', integrator: { id: 'i4' }, kf: nat.kf, cf: nat.cf, start: { t: 0, x: 0, v: 0 }, g0: 0, onsetMs: 500, snap: { x: 0.004, v: 0.04 }, events: sched.map((e) => ({ t: e.t, g: e.level * 200 })) };
    assert.ok(maxAbs(a, K.series(m, times)) < 1e-7, `${JSON.stringify(nat)} ${fk}`);
  }
});
test('spring kernel == the fitter simulate() for I1(h), I4, I5, I6, I7 on stalled frames (cross-check)', async (t) => {
  const F = await fitterImport('integrators.js'); if (!F || !F.simulate) return t.skip('fitter not found');
  const times = frames('stall', 300);
  for (const hyp of F.HYPOTHESES) {
    const base = { k: hyp.native ? 0.1 : 180, c: hyp.native ? 0.4 : 14, t0: 508.333333, x0: 0, v0: 20, targets: [200, 20, 150], tr: [1500.001, 2400.002] };
    const ref = F.simulate(hyp, base, times);
    const id = hyp.kind === 'sie-substep' ? { id: 'i1', h: hyp.h } : { id: { 'frame-unit-euler': 'i4', rk4: 'i5', analytic: 'i6', 'sie-capped': 'i7' }[hyp.kind] };
    const m = { kind: 'spring', integrator: id, start: { t: base.t0, x: 0, v: base.v0 }, g0: base.targets[0], events: base.tr.map((tt, i) => ({ t: tt, g: base.targets[i + 1] })), onsetMs: base.t0 };
    if (hyp.native) { m.kf = base.k; m.cf = base.c; } else { m.k = base.k; m.c = base.c; }
    assert.ok(maxAbs(ref, K.series(m, times)) < 1e-6, `${hyp.id}: ${maxAbs(ref, K.series(m, times))}`);
  }
});
test('seek is a pure function of (motion, t, frameMs): order and repetition do not matter; on-grid seek == series', () => {
  const m = { kind: 'spring', integrator: { id: 'i1', h: 16 }, k: 200, c: 12, start: { t: 0, x: 0, v: 0 }, g0: 0, onsetMs: 500, events: [{ t: 500, g: 200 }, { t: 1500, g: 0 }] };
  const ts = [3000, 100, 1234.5, 2999.9, 500, 0, 1500, 1234.5, 77.7];
  const first = ts.map((t) => K.valueAt(m, t, { frameMs: 1000 / 120 }));
  const second = [...ts].reverse().map((t) => K.valueAt(m, t, { frameMs: 1000 / 120 })).reverse();
  assert.deepEqual(first, second);
  const grid = Array.from({ length: 361 }, (_, k) => (k * 1000) / 120);
  const ser = K.series(m, grid);
  for (let k = 0; k < grid.length; k += 7) assert.ok(Math.abs(K.valueAt(m, grid[k], { frameMs: 1000 / 120 }) - ser[k]) < 1e-9);
});
test('analytic spring: underdamped, critical, overdamped match the ODE solution; retarget keeps velocity', () => {
  for (const [k, c] of [[196, 7], [196, 28], [196, 56]]) {
    const m = { kind: 'spring', integrator: { id: 'i6' }, k, c, start: { t: 0, x: 0, v: 0 }, g0: 200, events: [], onsetMs: 0 };
    const h = 0.0005; let x = 0, v = 0; // tiny-step RK-ish reference
    for (let i = 0; i < 2000; i++) { const a = -k * (x - 200) - c * v; v += a * h; x += v * h; }
    assert.ok(Math.abs(K.valueAt(m, 1000) - x) < 0.02 * 200 * 0.05 + 0.2, `k=${k} c=${c}: ${K.valueAt(m, 1000)} vs ${x}`);
  }
  const m = { kind: 'spring', integrator: { id: 'i6' }, k: 196, c: 7, start: { t: 0, x: 0, v: 0 }, g0: 200, events: [{ t: 300, g: 0 }], onsetMs: 0 };
  const e = 0.01, v1 = (K.valueAt(m, 300 - e) - K.valueAt(m, 300 - 2 * e)) / e, v2 = (K.valueAt(m, 300 + 2 * e) - K.valueAt(m, 300 + e)) / e;
  assert.ok(Math.abs(v1 - v2) < 0.5, `velocity continuous across the retarget: ${v1} vs ${v2}`);
});

// ---- friction vs the lab ----------------------------------------------------------------------------------------
test('friction kernel == lab Inertia coast (per-frame and dt-aware laws, regular and stalled frames)', async (t) => {
  const core = await labImport('lab-springs', 'core.js'); if (!core) return t.skip('lab not found');
  for (const law of ['frame', 'dt']) for (const f of [0.9, 0.94, 0.97]) for (const fk of ['r120', 'r60', 'stall']) {
    const sim = new core.Inertia({ friction: f, law }, 120); sim.down(160, 500); for (let tt = 510; tt <= 900; tt += 10) sim.move(160 + 0.6 * (tt - 500), tt); sim.up(905);
    const times = frames(fk, 400).filter((T) => T > 905);
    // lab: frame(dt) is called per frame with the dt since the previous frame; the first coast frame uses the frame gap too
    let last = times[0] - (fk === 'r120' ? 1000 / 120 : 1000 / 60); const ref = [];
    for (const T of times) { ref.push(sim.frame((T - last) / 1000)); last = T; }
    const m = { kind: 'friction', startMs: times[0] - (fk === 'r120' ? 1000 / 120 : 1000 / 60), x0: sim.release.x, v0: sim.release.vFrame, friction: f, law, stopV: 0.05 };
    assert.ok(ref[ref.length - 1] - ref[0] > 20, 'non-vacuous: the box coasted');
    assert.ok(maxAbs(ref, K.series(m, times)) < 1e-7, `${law} ${f} ${fk}`);
  }
});
test('endOf: spring settles, friction stops, loops preview', () => {
  const sp = { kind: 'spring', integrator: { id: 'i6' }, k: 200, c: 12, start: { t: 0, x: 0, v: 0 }, g0: 0, events: [{ t: 500, g: 200 }], onsetMs: 500 };
  const e = K.endOf(sp, { frameMs: 1000 / 120 }); assert.ok(e > 1000 && e < 3000, String(e));
  assert.ok(Math.abs(K.valueAt(sp, e + 200) - 200) < 0.3);
  assert.equal(K.endOf({ kind: 'keyframes', startMs: 100, durationMs: 50, iterations: Infinity, frames: [{ offset: 0, value: 0 }, { offset: 1, value: 1 }] }, { loopPreview: 3 }), 250);
});
