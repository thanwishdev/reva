// Truth and refsim checks that need no browser: planned traces, truth for every route x regime, closed-form agreement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { truth, planCtx, REGIMES, frameT, curveDerived, SCHEMA } from '../truth.mjs';
import { simulate, holdValue, m11Range, makeSim } from '../refsim.mjs';
import { easeFn, cubicBezier, DEFAULTS, M11_GEO, VIEW } from '../core.js';
import { loadRoutes, loadTrace } from '../tools/harness.mjs';

const routes = loadRoutes().routes;

test('frame grid per regime: integer-frame T_k, R5 stall every 30 frames', () => {
  assert.equal(frameT(REGIMES.R3, 120), 1000);
  assert.equal(frameT(REGIMES.R2, 60), 1000);
  assert.equal(frameT(REGIMES.R4, 30), 1000);
  const r5 = REGIMES.R5;
  assert.equal(frameT(r5, 29), Math.round(29 * (1000 / 60) * 1e6) / 1e6);       // no stall before frame 30
  assert.equal(frameT(r5, 30), Math.round((30 * (1000 / 60) + 100 - 1000 / 60) * 1e6) / 1e6);
  assert.ok(frameT(r5, 31) - frameT(r5, 30) < 17);                    // only one long frame per 30
  assert.ok(Math.abs(frameT(r5, 30) - frameT(r5, 29) - 100) < 1e-5);   // that frame is 100 ms
});

test('truth() builds for every route x variant x regime from the planned trace', () => {
  for (const r of routes) for (const variant of Object.keys(r.traces)) for (const reg of ['R2', 'R3', 'R4', 'R5', 'R6']) {
    const t = truth(r.id, r.params.default, reg, { trace: loadTrace(r.id, variant) });
    assert.equal(t.schema, SCHEMA);
    assert.equal(t.route, r.id);
    assert.ok(t.items.length > 0, `${r.id}.${variant}@${reg}`);
    for (const it of t.items) {
      assert.ok(it.target && it.class, `${r.id} item`);
      const sel = it.target.split('|')[0];
      // every rendered/driver target is a watched selector (view-transition pseudo targets are declared-only)
      if (!sel.startsWith('html::')) assert.ok(r.watch.selectors.includes(sel), `${r.id}: ${it.target} not watched`);
    }
    assert.equal(Object.keys(t.attribution).length, new Set(t.items.map((i) => i.target)).size);
    assert.ok(JSON.stringify(t).length > 100);
  }
});

test('truth is a pure function of (route, params, regime, trace)', () => {
  const r = routes.find((x) => x.id === 'm19');
  const a = truth('m19', r.params.default, 'R3', { trace: loadTrace('m19', 'retarget') });
  const b = truth('m19', r.params.default, 'R3', { trace: loadTrace('m19', 'retarget') });
  assert.deepEqual(a, b);
});

test('m19 timer: sub-frame onset follows the timer due time, quantised by the regime', () => {
  const P = DEFAULTS.m19;
  for (const reg of ['R2', 'R3', 'R4']) {
    const t = truth('m19', P, reg, { trace: loadTrace('m19', 'timer') });
    const it = t.items.find((x) => x.target === '#b0|drv:--v');
    const ctx = planCtx('m19', loadTrace('m19', 'timer'), reg);
    const go = ctx.marks.find((m) => m.name === 'go');
    assert.ok(Math.abs(it.params.t0_ms - (go.T + P.delay)) < 1e-5, reg);
    const sub = it.params.subframe_onset_ms;
    assert.ok(sub >= 0 && sub < REGIMES[reg].dt + 1e-6, `${reg} sub-frame ${sub}`);
  }
});

test('m19 click: onset is the click instant; retarget starts from the current value', () => {
  const P = DEFAULTS.m19;
  const tc = truth('m19', P, 'R3', { trace: loadTrace('m19', 'click') });
  const ctx = planCtx('m19', loadTrace('m19', 'click'), 'R3');
  assert.equal(tc.items.find((x) => x.target === '#b0|drv:--v').params.t0_ms, ctx.marks.find((m) => m.name === 'go').T);
  const tr = truth('m19', P, 'R3', { trace: loadTrace('m19', 'retarget') });
  const segs = tr.items.filter((x) => x.target === '#b0|drv:--v');
  assert.equal(segs.length, 2);
  const ease = easeFn(P.ease);
  const rtT = planCtx('m19', loadTrace('m19', 'retarget'), 'R3').marks.find((m) => m.name === 'go2').T;
  const goT = planCtx('m19', loadTrace('m19', 'retarget'), 'R3').marks.find((m) => m.name === 'go').T;
  // the current value at the retarget is the value written on the last frame at or before it (frame k2 = the go2 frame)
  const want = P.from + (P.to - P.from) * ease((rtT - goT) / P.D);
  assert.ok(Math.abs(segs[1].params.from - want) < 1e-9, `${segs[1].params.from} vs ${want}`);
  assert.equal(segs[1].params.retarget, 'from-current');
  assert.equal(segs[1].params.to, P.to2);
});

test('m06: visible onset = start + delay + hold * D; control has no hold', () => {
  const P = DEFAULTS.m06;
  const t = truth('m06', P, 'R3', { trace: loadTrace('m06', 'go') });
  const ctx = planCtx('m06', loadTrace('m06', 'go'), 'R3');
  const go = ctx.marks.find((m) => m.name === 'go');
  const start = frameT(REGIMES.R3, go.k + 1);
  assert.equal(t.items[0].params.declared.start_ms, start);
  t.stagger.onsets_ms.forEach((o, i) => assert.ok(Math.abs(o - (start + P.base + i * P.step + P.hold * P.D)) < 1e-6));
  assert.equal(t.stagger.step_ms, 30);
  assert.equal(t.items[0].declared_vs_visible_disagree, true);
  const c = truth('m06', { ...P, hold: 0 }, 'R3', { trace: loadTrace('m06', 'go') });
  assert.equal(c.items[0].hold, false);
  assert.equal(c.items[0].declared_vs_visible_disagree, false);
  assert.ok(Math.abs(c.items[0].params.visible.onset_ms - (start + P.base)) < 1e-6);
});

test('holdValue: flat for the hold, then the segment bezier, then 1', () => {
  const bz = [0.25, 0.8, 0.25, 1], f = cubicBezier(...bz);
  assert.equal(holdValue(-5, 1000, 0.6, bz), 0);
  assert.equal(holdValue(599.9, 1000, 0.6, bz), 0);
  assert.ok(Math.abs(holdValue(800, 1000, 0.6, bz) - f(0.5)) < 1e-12);
  assert.equal(holdValue(1000, 1000, 0.6, bz), 1);
  assert.equal(holdValue(300, 1000, 0, bz), f(0.3));
});

test('m11: measured range follows the contain geometry; twins are identical', () => {
  const P = DEFAULTS.m11;
  const { s0, s1 } = m11Range(P);
  // subject Y=1400 H=200 in an 800 px viewport: contain starts at 800 and has length 600
  assert.equal(s0, 800 + 0.1 * 600);
  assert.equal(s1, 800 + 0.7 * 600);
  const t = truth('m11', P, 'R3', { trace: loadTrace('m11', 'sweep') });
  const a = t.items.filter((x) => x.target.startsWith('#b0')), b = t.items.filter((x) => x.target.startsWith('#b1'));
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((x) => x.params.map), b.map((x) => x.params.map));
  assert.equal(a[0].sub, 'css'); assert.equal(b[0].sub, 'waapi');
  assert.equal(t.metrics['m11.css_waapi_parity'], 0);
});

test('m11 refsim: value is a function of scroll only', () => {
  const P = DEFAULTS.m11, { s0, s1 } = m11Range(P);
  const frames = [0, s0 - 10, s0, (s0 + s1) / 2, s1, s1 + 50].map((sy, i) => ({ k: i + 1, T: (i + 1) * 8.333333, sy, sx: 0 }));
  const sim = simulate('m11', P, { frames, inputs: [], marks: [] });
  const tx = sim.channels['#b0|ren:tx'];
  assert.equal(tx[0], 0); assert.equal(tx[1], 0); assert.equal(tx[2], 0);
  assert.ok(Math.abs(tx[3] - P.amp * easeFn(P.ease)(0.5)) < 1e-12);
  assert.equal(tx[4], P.amp); assert.equal(tx[5], P.amp);
  assert.deepEqual(sim.channels['#b1|ren:tx'], tx);
});

test('curveDerived: linear ramp has t50 at the midpoint, no overshoot, no crossing', () => {
  const d = curveDerived((t) => t / 100, 0, 1, 0, 100);
  assert.ok(Math.abs(d.t50 - 50) < 0.06 && Math.abs(d.t90 - 90) < 0.06);
  assert.equal(d.overshoot, 0); assert.equal(d.crossings, 0);
  assert.ok(Math.abs(d.peakVelocity - 0.01) < 1e-9);
  const o = curveDerived(cubicBezier(0.34, 1.517, 0.64, 1), 0, 1, 0, 1);
  assert.ok(o.overshoot > 0.08 && o.overshoot < 0.09);
});

test('hx scheduler model: timers fire at their due time in the frame that contains it; real tasks land next frame', () => {
  const frames = [1, 2, 3, 4, 5].map((k) => ({ k, T: k * 10, sy: 0, sx: 0 }));
  const S = makeSim(frames);
  const log = [];
  S.after(1, () => { log.push(['task', S.now, S.birth()]); S.setTimeout(() => log.push(['timer', S.now, S.birth()]), 15); S.raf(() => log.push(['raf', S.now])); });
  S.run((j) => log.push(['frame', j]));
  assert.deepEqual(log[1], ['task', 10, 20]);            // created in a real task after frame 1: starts at T_2 = 20
  assert.deepEqual(log.find((l) => l[0] === 'timer'), ['timer', 25, 30]);   // due 25 fires in the frame at T=30; its animations start at 30
  assert.deepEqual(log.find((l) => l[0] === 'raf'), ['raf', 20]);           // rAF registered in the task runs in the next frame
  assert.equal(log.filter((l) => l[0] === 'timer').length, 1);
  const iTimer = log.findIndex((l) => l[0] === 'timer'), iFrame2 = log.findIndex((l) => l[0] === 'frame' && l[1] === 2);
  assert.ok(iTimer < iFrame2 && iTimer > log.findIndex((l) => l[0] === 'frame' && l[1] === 1), 'timer fires inside frame index 2 (T=30), before its rAFs and sample');
});
