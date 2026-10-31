// Browser tests (headless shell through the repo launcher, H1): the generated page against independent oracles.
//   * hx recording of the page = the Node simulation on the take's own frames and inputs (driver channels exactly);
//   * pins, wheel, pointer, FLIP (WAAPI and rAF), view transitions behave like their closed forms;
//   * seek(t) = simulation = the DOM; the page contract (ready, specimen API, no page errors).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScrollSpecimen, simulate, inputFromTake } from '../index.js';
import { planInput, actionsFromInput } from '../input.js';
import { vtGroupAt } from '../core.js';
import { withBrowser } from '../../../browser/launch.js';
import { servePages, recordSpecimen, column, maxAbsDiff } from './helpers.js';
import * as F from './fixtures.js';

const DT = 1000 / 120;
const rec = async (built, actions, o = {}) => {
  const srv = await servePages({ '/s.html': built.html });
  try { return await recordSpecimen({ url: srv.origin + '/s.html', spec: built.spec, actions, ...o }); } finally { await srv.close(); }
};
const simOf = (built, take) => simulate(built.spec, inputFromTake({ take, data: { rows: take.data.rows, inputLog: take.inputLog || [], wheel: take.data.wheel } }, { spec: built.spec }));

test('scroll maps, EMA, asymmetric smoothing, hysteresis and a sticky pin: hx recording = simulation = closed forms', async () => {
  const built = buildScrollSpecimen([...F.truthSmooth(), ...F.truthAsym(), ...F.truthHysteresis()], { docHeight: 2400, frameMs: DT });
  const actions = [{ hold: 300 }, { scrollTo: 400 }, { hold: 100 }, { denseSweep: { from: 400, to: 1500, px: 10 } }, { hold: 600 }, { scrollTo: 0 }, { hold: 800 }];
  const { take } = await rec(built, actions);
  const sim = simOf(built, take);
  let compared = 0;
  for (const c of built.spec.channelMap) {
    if (!c.compare || /ren:by$/.test(c.specimen)) continue;
    const d = maxAbsDiff(column(take, c.specimen), sim.channels[c.specimen]);
    assert.ok(d.n > 300, `${c.specimen} compared ${d.n}`);
    assert.ok(d.max < 1e-3, `${c.specimen} recorded vs simulated ${d.max}`);   // rendered channels: matrix read-back floor
    if (c.specimen.includes('drv:')) assert.equal(d.max, 0, `${c.specimen} driver channel is exact`);
    compared++;
  }
  assert.ok(compared >= 4);
  // pin: the box top is start - sy before the pin, 0 while held, end - sy after (sticky layout owns it)
  const sy = take.data.rows.map((r) => r.sy), by = column(take, built.spec.pins[0].subject + '|ren:by');
  const pin = built.spec.pins[0];
  let held = 0;
  by.forEach((v, i) => { const e = sy[i] < pin.start ? pin.start - sy[i] : sy[i] <= pin.end ? 0 : pin.end - sy[i]; assert.ok(Math.abs(v - e) < 1e-6, `pin top at sy ${sy[i]}: ${v} vs ${e}`); if (e === 0) held++; });
  assert.ok(held > 100);
  // the planned input equals the recorded frames
  const plan = planInput(actions, { frameMs: DT, maxScroll: 2400 - 800 });
  assert.deepEqual(take.data.rows.map((r) => [r.k, r.T, r.sy]).slice(0, plan.frames.length), plan.frames.map((f) => [f.k, f.T, f.sy]));
});

test('dt-aware wheel smoother: frame-rate independent (closed form), per-frame lerp is not', async () => {
  const dtd = buildScrollSpecimen(F.truthWheel(), { docHeight: 3000, frameMs: DT });
  const lerp = buildScrollSpecimen([{ ...F.truthWheel()[0], family: 'ema', law: 'per-frame', params: { alpha: { value: 0.1 } } }], { docHeight: 3000, frameMs: DT });
  const actions = [{ hold: 200 }, { wheel: { dy: 100, n: 1 } }, { hold: 1500 }];
  const at = async (b, rate) => { const { take } = await rec(b, actions, { rate }); return { take, y: column(take, 'b0|drv:--v0'), sim: simOf(b, take) }; };
  const a120 = await at(dtd, 120), a60 = await at(dtd, 60);
  for (const a of [a120, a60]) assert.equal(maxAbsDiff(a.y, a.sim.channels['b0|drv:--v0']).max, 0, 'recording = simulation');
  const target = 100;
  for (const a of [a120, a60]) {
    const w = a.take.data.wheel[0]; const Tw = a.take.data.rows.find((r) => r.k === w.k).T;   // the wheel lands after frame w.k
    let n = 0;
    a.take.data.rows.forEach((r, i) => {
      if (r.T <= Tw + 1e-3) return;
      const exact = target * (1 - Math.exp(-6 * (r.T - Tw) / 1000));   // lambda = 6 / s: exact at any frame rate (the first step has dt = one frame)
      if (exact > 99.4) return;   // the page snaps once round(y) == round(target)
      assert.ok(Math.abs(a.y[i] - exact) < 1e-3, `closed form at T=${r.T}: ${a.y[i]} vs ${exact}`); n++;
    });
    assert.ok(n > 40, `compared ${n} frames`);
  }
  const b120 = await at(lerp, 120), b60 = await at(lerp, 60);
  const pick = (a) => { const w = a.take.data.wheel[0]; const Tw = a.take.data.rows.find((r) => r.k === w.k).T; return a.y[a.take.data.rows.findIndex((r) => r.T >= Tw + 150)]; };   // 150 ms after the wheel
  assert.ok(Math.abs(pick(b120) - pick(b60)) > 10, `per-frame lerp runs twice as fast at 120 Hz: ${pick(b120)} vs ${pick(b60)}`);
  assert.ok(Math.abs(pick(a120) - pick(a60)) < 2, `dt-aware damp does not: ${pick(a120)} vs ${pick(a60)}`);
});

test('wheel-latched tween: the wheel is swallowed and the scroll held while it runs', async () => {
  const built = buildScrollSpecimen(F.truthLatch(), { docHeight: 3000, frameMs: DT });
  const actions = [{ hold: 100 }, { scrollTo: 1600 }, { hold: 100 }, { wheel: { dy: 120, n: 1 } }, { hold: 700 }, { wheel: { dy: -120, n: 1 } }, { hold: 700 }, { scrollTo: 0 }, { hold: 100 }, { wheel: { dy: 120, n: 1 } }, { hold: 200 }];
  const { take } = await rec(built, actions);
  const m = column(take, 'b0|drv:--v0'); const sim = simOf(built, take);
  assert.equal(maxAbsDiff(m, sim.channels['b0|drv:--v0']).max, 0);
  assert.ok(Math.max(...m) === 1 && m.some((v) => v > 0.4 && v < 0.6), 'ran a 0 -> 1 tween'); assert.equal(m.filter((v) => v === 1).length > 10, true);
  const wl = take.data.wheel; assert.deepEqual(wl.map((e) => e.prevented), [true, true, false], 'latched, latched, not latched at scroll 0');
  assert.equal(sim.eventLog.map((e) => e.res[0].action).join(), 'start,start,not-latched');
});

test('inertia: pointer script from the record, release velocity from the last 100 ms, closed-form stopping distance', async () => {
  const built = buildScrollSpecimen(F.truthInertia(), { frameMs: DT });
  const actions = actionsFromInput(built.spec.input, { frameMs: DT });
  const { take } = await rec(built, actions);
  const x = column(take, 'b0|drv:--v0'); const rows = take.data.rows;
  assert.equal(maxAbsDiff(x, simOf(built, take).channels['b0|drv:--v0']).max, 0);
  // closed form: 0.6 px/ms = 10 px per nominal frame; v *= 0.9 per frame until |v| < 0.05
  let want = 0, v = 10; while (true) { v *= 0.9; if (Math.abs(v) < 0.05) break; want += v; }
  const base = built.spec.input.pointer; const upT = Math.max(...base.map((p) => p.T)) + 33.333333;   // script() base = the boot time (4 frames)
  const last = rows.filter((r) => r.T <= upT).length - 1;
  assert.ok(Math.abs(x[x.length - 1] - x[last] - want) < 1e-6, `stopping distance ${x[x.length - 1] - x[last]} vs ${want}`);
  assert.ok(Math.abs(want - 89.5362) < 1e-3, 'the lab truth value for friction 0.9 at 0.6 px/ms');
});

test('FLIP: WAAPI, rAF tween and the engine agree; second trigger restarts from the current rect', async () => {
  const waapi = buildScrollSpecimen(F.truthFlip(), { frameMs: DT });
  const raf = buildScrollSpecimen(F.truthFlip().map((it) => ({ ...it, params: { ...it.params, impl: 'raf' } })), { frameMs: DT });
  assert.equal(waapi.spec.mechanisms[0].impl, 'waapi'); assert.equal(raf.spec.mechanisms[0].impl, 'raf');
  const actions = actionsFromInput(waapi.spec.input, { frameMs: DT });
  const a = await rec(waapi, actions), b = await rec(raf, actions);
  for (const ch of ['tx', 'ty', 'sx', 'sy']) {
    const ca = column(a.take, 'b0|ren:' + ch), cb = column(b.take, 'b0|ren:' + ch), cs = simOf(waapi, a.take).channels['b0|ren:' + ch];
    assert.ok(maxAbsDiff(ca, cs).max < 1e-3, `waapi vs engine ${ch}`);
    assert.ok(maxAbsDiff(ca, cb).max < 1e-3, `waapi vs rAF tween ${ch}`);
    assert.ok(maxAbsDiff(ca, cs).n > 150);
  }
  const tx = column(a.take, 'b0|ren:tx'); const T = a.take.data.rows.map((r) => r.T);
  assert.ok(Math.abs(tx[T.findIndex((t) => t > 441 && t < 443)] - -440) < 1e-3, 'first frame after the trigger is fully inverted');
  assert.ok(Math.abs(tx[T.findIndex((t) => t > 741 && t < 743)] - 426.407) < 1e-2, 'second trigger inverts the other way from the current rect (the lab truth value 426.407)');
  assert.equal(a.take.pageErrors.length, 0);
});

test('seek(t): replay = simulation = DOM, the page scrolls to the replayed offset, view-transition groups follow the closed form', async () => {
  const sm = buildScrollSpecimen([...F.truthSmooth(), ...F.truthHysteresis()], { docHeight: 2400, frameMs: DT, input: planInput([{ hold: 300 }, { scrollTo: 400 }, { denseSweep: { from: 400, to: 1300, px: 20 } }, { hold: 600 }], { frameMs: DT, maxScroll: 1600 }) });
  const vt = buildScrollSpecimen(F.truthVT(), { frameMs: DT });
  const srv = await servePages({ '/sm.html': sm.html, '/vt.html': vt.html });
  try {
    await withBrowser({ engine: 'chs', context: { viewport: sm.spec.viewport } }, async (h) => {
      const errors = []; h.page.on('pageerror', (e) => errors.push(String(e)));
      await h.page.goto(srv.origin + '/sm.html');
      await h.page.waitForFunction(() => window.specimen && window.specimen.ready === true);
      assert.equal(await h.page.evaluate(() => [typeof window.seek, typeof window.specimen.go, typeof window.specimen.live, window.specimen.mode].join()), 'function,function,function,live');
      const sim = simulate(sm.spec, sm.spec.input);
      for (const t of [0, 120, 500, 900, 1400, 1800, 700, 50]) {   // forward and backward: rewinding replays from the start
        const r = await h.page.evaluate((t) => window.seek(t), t);
        for (const [key, v] of Object.entries(r.channels)) if (r.k > 0) assert.equal(v, sim.channels[key][r.k - 1], `${key} at t=${t}`);
        const dom = await h.page.evaluate(() => window.specimen.readDom());
        for (const [key, v] of Object.entries(dom)) if (Number.isFinite(v) && key in r.channels) assert.ok(Math.abs(v - r.channels[key]) < 1e-3, `${key} dom ${v} vs ${r.channels[key]}`);
        if (r.k > 0) assert.equal(await h.page.evaluate(() => Math.round(scrollY)), sm.spec.input.frames[r.k - 1].sy, 'page scrolled to the replayed offset');
        const top = await h.page.evaluate((id) => Math.round(document.getElementById(id).getBoundingClientRect().top * 100) / 100, sm.spec.pins[0].subject);
        const sy = await h.page.evaluate(() => scrollY), pin = sm.spec.pins[0];
        assert.ok(Math.abs(top - (sy < pin.start ? pin.start - sy : sy <= pin.end ? 0 : pin.end - sy)) < 0.02, `pin top ${top} at sy ${sy}`);
      }
      assert.equal(await h.page.evaluate(() => window.specimen.mode), 'seek');
      await h.page.evaluate(() => window.specimen.live()); assert.equal(await h.page.evaluate(() => window.specimen.mode), 'live');
      await h.page.goto(srv.origin + '/vt.html');
      await h.page.waitForFunction(() => window.specimen && window.specimen.ready === true);
      const m = vt.spec.mechanisms[0]; const trig = vt.spec.input.triggers[0].T;
      for (const t of [trig + 100, trig + 300, trig + 650, trig + 2000]) {
        const r = await h.page.evaluate((t) => window.seek(t), t);
        const start = trig + 2 * DT; assert.ok(Math.abs(r.vt.start - start) < 1e-6);
        const cs = await h.page.evaluate((n) => { const s = getComputedStyle(document.documentElement, `::view-transition-group(${n})`); const mt = /matrix\(([^)]+)\)/.exec(s.transform); return { w: parseFloat(s.width), h: parseFloat(s.height), x: mt ? parseFloat(mt[1].split(',')[4]) : NaN, y: mt ? parseFloat(mt[1].split(',')[5]) : NaN }; }, m.groups[0].name);
        const e = vtGroupAt(m.groups[0], t - start);
        for (const [k, want] of [['x', e.x], ['y', e.y], ['w', e.w], ['h', e.h]]) assert.ok(Math.abs(cs[k] - want) < 0.05, `view-transition group ${k} at t=${t}: ${cs[k]} vs ${want}`);   // 1/64 px layout units
      }
      assert.deepEqual(errors, []);
    });
  } finally { await srv.close(); }
});

test('view transition under hx: the group animations are born where the lab expects them (trigger + 2 frames), with the declared duration', async () => {
  const built = buildScrollSpecimen(F.truthVT(), { frameMs: DT });
  const { take } = await rec(built, actionsFromInput(built.spec.input, { frameMs: DT }), { engine: 'chs' });
  const births = take.data.births.filter((b) => /view-transition-group/.test(b.name || ''));
  assert.equal(births.length, 1);
  assert.ok(Math.abs(births[0].T - 450) < 1e-3, `born at ${births[0].T}`); assert.equal(births[0].duration, 600);
  assert.equal(take.pageErrors.length, 0);
});
