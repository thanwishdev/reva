// Fixture Lab, group C (scroll): ground truth, read only by the lab runner and scorer (never served, never read by a page).
//   truth(routeId, params, regime, variant, ctx?) -> { schema: 'reva.labtruth/0', route, params, regime, items, attribution, stagger, events, metrics }
// Closed-form values (alpha, lambda, map ranges, durations) come from the parameters. Values that depend on the trace and
// the frame regime (settle tails, step lists, hysteresis crossings, latch decisions) come from refsim run on `ctx`
// (the frames and inputs of the actual take) or, without a take, on the frames the trace plans (plan.mjs).
import * as C from './core.js';
import { simulate, defaultsOf } from './refsim.mjs';
import { REGIMES, planFrames, scenarioSpec, routesFile } from './plan.mjs';

export const TRUTH_SCHEMA = 'reva.labtruth/0';

const num = (value, unit, extra = {}) => ({ value, unit, ...extra });
/** time constant (ms) of a per-frame EMA at frame period dt */
export const tauMs = (alpha, dt) => -dt / Math.log(1 - alpha);
/** the per-frame constant that a dt-aware damp with rate lambda (1/s) produces at frame period dt */
export const alphaAt = (lambdaPerS, dtMs) => 1 - Math.exp(-lambdaPerS * dtMs / 1000);

/**
 * Model settle tail: frames after a unit step until the EMA value is within `eps` of the target (the snap rule then jumps
 * to it). Independent of what the take observed, so every trace and regime has a registered value even if its holds are
 * shorter than the tail (a slow alpha at 30 Hz needs about 2.8 s).
 */
export function emaSettleFrames(alpha, eps = 1e-3, amplitude = 1) {
  let d = amplitude, n = 0;
  while (Math.abs(d) >= eps && n < 100000) { d *= 1 - alpha; n++; }
  return n;
}

const mapOf = (shape, s0, s1, a, b, extra = {}) => ({
  shape, a, b, px: { s0, s1 }, vh: { s0: s0 / C.VH, s1: s1 / C.VH }, ...extra,
});

/**
 * Settle tails of jump steps. A jump step is a one-frame change of the target of at least `minJump` (a scrollTo) that is
 * followed by a constant target. Frames are counted from the first frame that shows the response (inclusive) to the first
 * frame with |target - value| < eps; ms from the frame boundary before it. A new jump before settling marks the step
 * interrupted (reported, not countable).
 */
function settleTails(target, value, frames, eps = 1e-3, minJump = 0.02) {
  const out = [];
  for (let i = 1; i < target.length; i++) {
    const jump = Math.abs(target[i] - target[i - 1]) >= minJump && (i + 1 >= target.length || target[i + 1] === target[i]);
    if (!jump) continue;
    let j = i, interrupted = false;
    while (j < target.length && Math.abs(target[j] - value[j]) >= eps) {
      j++;
      if (j < target.length && Math.abs(target[j] - target[j - 1]) > 1e-12) { interrupted = true; break; }
    }
    const open = j >= target.length;
    out.push({ k0: frames[i].k, k1: open || interrupted ? null : frames[j].k, frames: open || interrupted ? null : j - i + 1,
      ms: open || interrupted ? null : frames[j].T - frames[i - 1].T, jump: target[i] - target[i - 1], settled: !open && !interrupted, interrupted, open });
  }
  return out;
}

/** runs of monotone target change, labelled by how the value follows (instant / eased) */
function directionRuns(target, value, frames) {
  const runs = []; let cur = null; let prevDir = 0;
  for (let i = 1; i < target.length; i++) {
    const d = target[i] - target[i - 1];
    const dir = Math.abs(d) < 1e-12 ? 0 : Math.sign(d);
    if (dir !== 0) {
      if (!cur || cur.direction !== (dir > 0 ? 'rise' : 'fall')) {
        cur = { k0: frames[i].k, k1: frames[i].k, direction: dir > 0 ? 'rise' : 'fall', afterReversal: prevDir !== 0 && prevDir !== dir, instant: 0, lagged: 0 };
        runs.push(cur);
      }
      cur.k1 = frames[i].k;
      if (Math.abs(value[i] - target[i]) < 1e-12) cur.instant++; else cur.lagged++;
      prevDir = dir;
    }
  }
  for (const r of runs) r.response = r.lagged === 0 ? 'instant' : r.instant === 0 ? 'eased' : 'mixed';
  return runs;
}

function contextFor(routeId, regimeId, variant, ctx) {
  if (ctx) return ctx;
  const spec = scenarioSpec(routeId, variant);
  const plan = planFrames(spec.actions, regimeId, { routeId });
  return { frames: plan.frames, inputs: plan.inputs, viewport: spec.viewport };
}

const ATTR = { scroll: 'scroll-linked', wheel: 'wheel' };

export function truth(routeId, params = {}, regimeId = 'R3', variant = null, ctx = null) {
  const file = routesFile();
  const route = file.routes.find(r => r.id === routeId);
  if (!route) throw new Error(`unknown route ${routeId}`);
  const reg = REGIMES[regimeId];
  if (!reg) throw new Error(`unknown regime ${regimeId}`);
  const p = { ...defaultsOf(routeId), ...params };
  const v = variant || Object.keys(route.traces)[0];
  const context = contextFor(routeId, regimeId === 'R6' ? 'R2' : regimeId, v, ctx);
  const sim = simulate(routeId, p, context);
  const dt = reg.dt;
  const attr = ATTR[route.driver];
  const items = []; const events = {}; const attribution = {};
  const add = (it) => { items.push({ scored: true, classScored: true, ...it }); attribution[it.target] = it.attribution; return it; };
  const mirror = (target, of, cls, family, extra = {}) => add({ target, role: 'rendered-mirror', mirrorOf: of, scored: false, class: cls, family, attribution: attr, ...extra });

  if (routeId === 'm01') {
    const r = C.M01.range(p); const m = mapOf('linear', r.s0, r.s1, 1, -1);
    add({ target: '#c|drv:--p', role: 'driver', class: 'scroll-map', family: 'linear', smoothing: 'none', attribution: attr,
      params: { map: m, slope: num(-1 / (r.s1 - r.s0), 'per px'), alpha: num(1, 'per frame', { note: 'unsmoothed: the value is final on the first frame' }) },
      derived: { range_px: r.s1 - r.s0 } });
    const rd = C.M01.render;
    mirror('#c|ren:tx', '#c|drv:--p', 'scroll-map', 'linear', { params: { map: mapOf('linear', r.s0, r.s1, rd(1).tx, -rd(1).tx) } });
    mirror('#c|ren:ty', '#c|drv:--p', 'scroll-map', 'linear', { params: { map: mapOf('linear', r.s0, r.s1, rd(1).ty, -rd(1).ty) } });
    mirror('#c|ren:opacity', '#c|drv:--p', 'scroll-map', 'linear', { params: { map: mapOf('linear', r.s0, r.s1, 1, -0.8) } });
  } else if (routeId === 'm02') {
    const r = C.M02.range(p);
    const tails = settleTails(sim.aux.target, sim.aux.cur, context.frames);
    add({ target: '#c|drv:--e', role: 'driver', class: 'first-order smoothing', family: 'ema', law: 'per-frame', attribution: attr,
      params: { alpha: num(p.alpha, 'per frame'), snap_eps: num(p.snap, 'progress'), write: p.write,
        map: mapOf('smoothstep', r.s0, r.s1, 0, 1, { elementRelative: { edge: 'bottom', from: p.b0, to: p.b1, unit: 'vh' } }) },
      derived: { tau_ms: num(tauMs(p.alpha, dt), 'ms', { at_dt_ms: dt }), alpha_per_sample: num(1 - Math.pow(1 - p.alpha, reg.stride), 'per sample', { stride: reg.stride }),
        settle_tails: tails, settle_frames_first_step: tails.length ? tails[0].frames : null,
        settle_frames_unit_step: num(emaSettleFrames(p.alpha), 'frames', { eps: 1e-3, note: 'model value for a step of amplitude 1; the take may end before it' }),
        settle_ms_unit_step: num(emaSettleFrames(p.alpha) * dt, 'ms') } });
    mirror('#c|ren:ty', '#c|drv:--e', 'first-order smoothing', 'ema', { law: 'per-frame', params: { alpha: num(p.alpha, 'per frame') } });
    mirror('#c|ren:sx', '#c|drv:--e', 'first-order smoothing', 'ema', { law: 'per-frame', params: { alpha: num(p.alpha, 'per frame') } });
    mirror('#c|ren:opacity', '#c|drv:--e', 'first-order smoothing', 'ema', { law: 'per-frame', params: { alpha: num(p.alpha, 'per frame') } });
    events.settle_tails = tails;
  } else if (routeId === 'm03') {
    const er = C.M03.enterRange(p), xr = C.M03.exitRange(p);
    const aTails = settleTails(sim.aux.ta, sim.aux.a, context.frames);
    const bTails = settleTails(sim.aux.tb, sim.aux.b, context.frames);
    const runs = directionRuns(sim.aux.ta, sim.aux.a, context.frames);
    add({ target: '#c|drv:--a', role: 'driver', class: 'asymmetric smoothing', family: 'snap-up-ease-down', law: 'per-frame', attribution: attr,
      params: { alpha_down: num(p.aDown, 'per frame'), alpha_up: num(1, 'per frame', { note: 'snap-on-rise' }), snap_eps: num(p.snap, 'progress'),
        map: mapOf('smoothstep', er.s0, er.s1, 0, 1, { elementRelative: { edge: 'bottom', from: p.enter[0], to: p.enter[1], unit: 'vh' } }) },
      derived: { tau_down_ms: num(tauMs(p.aDown, dt), 'ms', { at_dt_ms: dt }), settle_tails: aTails, direction_runs: runs } });
    add({ target: '#c|drv:--b', role: 'driver', class: 'first-order smoothing', family: 'ema', law: 'per-frame', attribution: attr,
      params: { alpha: num(p.aExit, 'per frame'), snap_eps: num(p.snap, 'progress'),
        map: mapOf('smoothstep', xr.s0, xr.s1, 1, -1, { elementRelative: { edge: 'bottom', from: p.exit[0], to: p.exit[1], unit: 'vh' }, note: 'target falls from 1 to 0' }) },
      derived: { tau_ms: num(tauMs(p.aExit, dt), 'ms', { at_dt_ms: dt }), settle_tails: bTails } });
    add({ target: '#c|drv:--p', role: 'derived', scored: false, class: 'unknown', family: 'max(a, b)', attribution: attr,
      params: {}, note: 'p = max of the two smoothed values; scored through its two parts' });
    events.asymmetry = runs;
    events.settle_tails = { a: aTails, b: bTails };
  } else if (routeId === 'm04') {
    const g = C.M04.geom(p);
    const tails = settleTails(sim.aux.e, sim.aux.es, context.frames);
    const m = (a, b) => mapOf('easeInOutCubic', g.pinStart, g.pinStart + g.S, a, b);
    for (const [name, a, b, w] of [['--s', p.h, 1 - p.h, 'q3'], ['--y', p.ty0, -p.ty0, 'q2'], ['--o', p.ox0, 50 - p.ox0, 'q2']]) {
      add({ target: `#k|drv:${name}`, role: 'driver', class: 'first-order smoothing', family: 'ema', law: 'per-frame', attribution: attr,
        params: { alpha: num(p.alpha, 'per frame'), snap_eps: num(p.snap, 'progress'), write: w, map: m(a, b) },
        derived: { tau_ms: num(tauMs(p.alpha, dt), 'ms', { at_dt_ms: dt }), settle_tails: tails } });
    }
    const edges = C.M04.edges(p);
    const crossings = []; const ind = sim.channels['#c|drv:--i'];
    for (let i = 1; i < ind.length; i++) if (ind[i] !== ind[i - 1]) {
      const up = ind[i] > ind[i - 1];
      crossings.push({ k: context.frames[i].k, from: ind[i - 1], to: ind[i], direction: up ? 'up' : 'down', edge: up ? ind[i - 1] + 0.5 + p.hy : ind[i] + 0.5 - p.hy, tp_at_frame: sim.aux.tp[i] });
    }
    const px = (tu) => g.pinStart + g.S + g.tabUnit * tu;
    add({ target: '#c|drv:--i', role: 'driver', class: 'scroll-map', family: 'staircase-hysteresis', attribution: attr,
      params: { levels: num(p.n, 'count'), hysteresis: num(p.hy, 'tab index'), unit_px: num(g.tabUnit, 'px per tab index'),
        edges: { up: edges.up, down: edges.down, unit: 'tab index' }, edges_px: { up: edges.up.map(px), down: edges.down.map(px) } },
      derived: { crossings, observed_up: crossings.filter(c => c.direction === 'up').map(c => c.edge), observed_down: crossings.filter(c => c.direction === 'down').map(c => c.edge) } });
    add({ target: '#c|ren:by', role: 'rendered', class: 'scroll-map', family: 'pin', classScored: false, attribution: attr,
      params: { pin: { start_px: g.pinStart, end_px: g.pinEnd, start_vh: g.pinStart / C.VH, end_vh: g.pinEnd / C.VH, held_value: 0, unit: 'px (bbox top)' } },
      note: 'piecewise (ramp, constant, ramp); scored by the pin range row, not by the class row' });
    mirror('#k|ren:sx', '#k|drv:--s', 'first-order smoothing', 'ema', { law: 'per-frame', params: { alpha: num(p.alpha, 'per frame') } });
    events.settle_tails = tails; events.hysteresis_crossings = crossings;
  } else if (routeId === 'm05') {
    const q = (x) => (1 - Math.pow(1 - x, 1 / 3)) * p.dur;
    const wheels = sim.events.filter(e => e.type === 'wheel');
    add({ target: '#c|drv:--m', role: 'driver', class: 'tween', family: 'named-ease', ease: 'easeOutCubic', attribution: 'wheel',
      params: { duration: num(p.dur, 'ms'), ease: 'easeOutCubic', retarget: 'from-current', target_rule: 'sign(deltaY): 1 on wheel down, 0 on wheel up',
        latch: { visible_height_min_vh: 0.45, bottom_max_vh_plus_px: 8, arming_root_margin: '200% 0px', section_px: { top: C.M05.SECTION_Y, height: C.M05.SECTION_H } },
        blocks_scroll: true, pin: 'scrollTo(instant) to the latch position while a tween runs' },
      derived: { t10: q(0.1), t50: q(0.5), t90: q(0.9), t99: q(0.99), unit: 'ms from the start of a 0 to 1 tween', overshoot: 0 } });
    mirror('#c|drv:--f', '#c|drv:--m', 'tween', 'derived-affine', { params: { note: 'f = 1 - min(1, m / 0.5)' } });
    mirror('#c|ren:tx', '#c|drv:--m', 'tween', 'named-ease', { params: { ease: 'easeOutCubic', duration: num(p.dur, 'ms') } });
    events.wheels = wheels;     // expected defaultPrevented per wheel event: the latch truth
    events.latch = { expected_prevented: wheels.map(w => w.prevented), precision_recall_over: wheels.length };
    events.retargets = wheels.filter(w => w.action === 'retarget').map(w => ({ k: w.k, from: w.tween.from, to: w.tween.to, semantics: 'from-current' }));
  } else if (routeId === 'm09') {
    const lam = p.lerp * 60;
    const wheels = sim.events.filter(e => e.type === 'wheel');
    const tails = [];
    for (const w of wheels) {
      if (!w.changed) continue;
      const i0 = context.frames.findIndex(f => f.k === w.k);
      let j = i0 + 1; while (j < sim.aux.running.length && sim.aux.running[j]) j++;
      tails.push({ k0: w.k, k1: j < sim.aux.running.length ? context.frames[j].k : null, frames: j < sim.aux.running.length ? j - i0 : null });
    }
    add({ target: '#c|drv:--y', role: 'driver', class: 'first-order smoothing', family: 'damp', law: 'dt-aware', attribution: 'wheel',
      params: { lerp: num(p.lerp, 'library option'), lambda: num(lam, '1/s', { note: 'lerp * 60' }), done_rule: 'round(value) == round(target)' },
      derived: { tau_ms: num(1000 / lam, 'ms', { note: '1 / (60 lerp), independent of the frame period' }), alpha_per_frame_at_T: num(alphaAt(lam, dt), 'per frame', { at_dt_ms: dt }),
        alpha_on_stall_frame: reg.stall ? num(alphaAt(lam, reg.stall.ms), 'per frame', { at_dt_ms: reg.stall.ms }) : null, settle_tails: tails } });
    mirror('#c|ren:tx', '#c|drv:--y', 'first-order smoothing', 'damp', { law: 'dt-aware', params: { lerp: num(p.lerp, 'library option') } });
    events.wheels = wheels; events.settle_tails = tails;
  } else if (routeId === 'm09b') {
    const wheels = sim.events.filter(e => e.type === 'wheel');
    add({ target: '#c|drv:--y', role: 'driver', class: 'first-order smoothing', family: 'ema', law: 'per-frame', attribution: 'wheel',
      params: { alpha: num(p.lerp, 'per frame'), done_rule: 'round(value) == round(target)' },
      derived: { tau_ms: num(tauMs(p.lerp, dt), 'ms', { at_dt_ms: dt }), alpha_per_sample: num(1 - Math.pow(1 - p.lerp, reg.stride), 'per sample', { stride: reg.stride }) } });
    mirror('#c|ren:tx', '#c|drv:--y', 'first-order smoothing', 'ema', { law: 'per-frame', params: { alpha: num(p.lerp, 'per frame') } });
    events.wheels = wheels;
  }

  return {
    schema: TRUTH_SCHEMA, group: 'lab-scroll', route: routeId, params: p, regime: { id: reg.id, dt_ms: dt, hz: reg.hz, stall: reg.stall, stride: reg.stride },
    variant: v, source: ctx ? 'take frames' : 'planned frames', items, attribution, stagger: null, events, metrics: route.metrics,
  };
}
