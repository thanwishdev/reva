// Fixture Lab group B reference simulator (design M2-fitter.md 11). Pure Node, no browser, no import from src/analysis.
//
// simulate(routeId, params, ctx): the values the page writes at every frame of an ACTUAL take, reproducing the `hx`
// semantics of src/record/inpage.js (PLAN A1.6 g):
//   - the page's first animation-frame callback is the ANCHOR (ctx.frames[ctx.anchorIndex ?? 0]); it arms the page timers
//     (due = r6(T_anchor + t)) and integrates nothing;
//   - at every later frame k the timers with due <= T_k fire first, in (due, arming order), each seeing
//     performance.now() = its due time; then the animation-frame callback runs at T_k with dt = T_k - T_(k-1);
//   - a row is sampled after the callback, so channel[k] is the value written at frame k.
// ctx = {frames: [{k, T, ...}], inputs?, viewport?, trace?: <trace JSON or schedule name>, anchorIndex?}
// The glue below is written independently of routes/page.js; only the pure recurrences in core.js are shared.
import { r6, SCHEDULES, AMPLITUDE, BOX_X0, quantise, TimedSpring, Inertia, pointerEvents } from './core.js';

export const CHANNELS = ['drv:--x', 'ren:--x', 'ren:tx'];
const SEL = '.b0';

function scheduleOf(params, ctx) {
  const tr = ctx && ctx.trace;
  const name = params.sched || (tr && typeof tr === 'object' && tr.page && tr.page.sched) || (typeof tr === 'string' ? tr : null);
  const s = SCHEDULES[name];
  if (!s) throw new Error(`refsim: no schedule (params.sched=${params.sched})`);
  return s;
}

/** Generic frame loop. `arm(Tanchor)` returns timers [{due, fn}]; `frame(dtSec, T)` returns the written x (dtSec null at the anchor). */
function runFrames(frames, anchorIndex, arm, frame) {
  const out = new Array(frames.length).fill(null);
  let timers = [], seq = 0;
  for (let i = anchorIndex; i < frames.length; i++) {
    const T = frames[i].T;
    if (i === anchorIndex) { timers = arm(T).map(t => ({ ...t, seq: seq++ })); out[i] = frame(null, T); continue; }
    timers.sort((a, b) => a.due - b.due || a.seq - b.seq);
    while (timers.length && timers[0].due <= T) timers.shift().fn();
    out[i] = frame((T - frames[i - 1].T) / 1000, T);
  }
  return out;
}

export function simulate(routeId, params, ctx) {
  const frames = ctx.frames, a0 = ctx.anchorIndex || 0;
  const events = [];
  let xs;
  if (routeId === 'm07' || routeId === 'm07x' || routeId === 'm08') {
    const A = params.A ?? AMPLITUDE, sched = scheduleOf(params, ctx);
    const sim = new TimedSpring(params, 0);
    xs = runFrames(frames, a0, (Ta) => sched.map(ev => {
      const due = r6(Ta + ev.t), v = ev.v != null ? ev.v * A : undefined;
      return { due, fn: () => { sim.retarget(ev.level * A, due, v); events.push({ T: due, type: 'retarget', target: ev.level * A, v: v ?? null }); } };
    }), (dt, T) => (dt == null ? 0 : sim.frame(dt, T)));
  } else if (routeId === 'm10') {
    const sim = new Inertia(params, BOX_X0);
    xs = runFrames(frames, a0, (Ta) => pointerEvents(params.path).map(ev => {
      const due = r6(Ta + ev.t);
      return { due, fn: () => {
        if (ev.type === 'down') sim.down(ev.x, due);
        else if (ev.type === 'move') sim.move(ev.x, due);
        else { sim.up(due); events.push({ T: due, type: 'release', ...sim.release }); }
      } };
    }), (dt) => (dt == null ? BOX_X0 : sim.frame(dt)));
  } else throw new Error('refsim: unknown route ' + routeId);
  const q = xs.map(x => (x == null ? null : quantise(x, params.write)));
  return { channels: { [`${SEL}|${CHANNELS[0]}`]: q, [`${SEL}|${CHANNELS[1]}`]: q.slice(), [`${SEL}|${CHANNELS[2]}`]: q.slice() }, events, anchorIndex: a0 };
}

// ------------------------------------------------------------------------------------------------- regime frame plans
export const REGIME_DT = { R2: 1000 / 60, R3: 1000 / 120, R4: 1000 / 30, R5: 1000 / 60, R6: 1000 / 60 };
/** Planned frames k = 1..N covering totalMs of virtual time, per regime (design 12 X1 for the R5 stall schedule). */
export function plannedFrames(regime, totalMs) {
  const dt = REGIME_DT[regime]; if (!dt) throw new Error('unknown regime ' + regime);
  const T = (k) => r6(regime === 'R5' ? k * dt + Math.floor(k / 30) * (100 - dt) : k * dt);
  const frames = [];
  for (let k = 1; T(k) <= totalMs + dt; k++) frames.push({ k, T: T(k), sy: 0, sx: 0 });
  return frames;
}
