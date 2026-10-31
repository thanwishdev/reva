// Fixture Lab group B truth (design M2-fitter.md 11). Read only by the lab runner/scorer; the lab server refuses this file.
//   truth(routeId, params, regime, {trace}) -> {schema: 'reva.labtruth/0', route, params, regime, items, attribution, ...}
// Parameters are the generator's own (canonical k/m, c/m, alpha, ...); regime-dependent numbers come from refsim on the
// regime's planned frame grid. Times are ms after the ANCHOR (the page's first animation-frame callback, see refsim.mjs).
// The `closed_form` blocks are computed here by independent formulas (no TimedSpring / Inertia), so a test can check
// refsim against them.
import { analyticAt, canonical, INTEGRATORS, SNAP, INERTIA_STOP, BOX_X0, AMPLITUDE, SCHEDULES, POINTER_SCRIPTS } from './core.js';
import { simulate, plannedFrames } from './refsim.mjs';
import { loadRoutes, loadTrace, cellParams, traceDurationMs } from './cell.mjs';

export const SCHEMA = 'reva.labtruth/0';
const TARGET = '.b0|--x';
const CHANNELS = ['drv:--x', 'ren:--x', 'ren:tx'];
const round = (x, n = 4) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(n));

/** Continuous-time equivalent of the per-60-Hz-frame recurrence x' = x + (x-xp)(1-cf) + kf (g-x) (S3 3.1: poles z of z^2 - (2-kf-cf) z + (1-cf)). */
export function nativePoleEquivalent(kf, cf, h = 1 / 60) {
  const a1 = 2 - kf - cf, a2 = -(1 - cf), disc = a1 * a1 + 4 * a2;
  if (disc < 0) {
    const mod = Math.sqrt(-a2), ang = Math.atan2(Math.sqrt(-disc) / 2, a1 / 2), re = Math.log(mod);
    const w = Math.hypot(re, ang);
    return { omega0: w / h, zeta: -re / w, regime: 'underdamped' };
  }
  const s1 = Math.log((a1 + Math.sqrt(disc)) / 2) / h, s2 = Math.log((a1 - Math.sqrt(disc)) / 2) / h;
  const w = Math.sqrt(s1 * s2);
  return { omega0: w, zeta: -(s1 + s2) / (2 * w), regime: 'overdamped' };
}

/** Last time (ms, relative to t0) the series is farther than tol from `fin`; null when it never leaves. */
function settleMs(frames, xs, from, fin, tol, t0) {
  let last = null;
  for (let i = 0; i < frames.length; i++) if (frames[i].T >= from && xs[i] != null && Math.abs(xs[i] - fin) > tol) last = frames[i].T;
  return last == null ? 0 : round(last - t0, 3);
}

/** Segments between retarget events: start/target, overshoot past the target, time of the peak, from the planned frames. */
function springSegments(frames, xs, events, anchorT, A) {
  const segs = [];
  for (let j = 0; j < events.length; j++) {
    const ev = events[j], end = j + 1 < events.length ? events[j + 1].T : Infinity;
    let xStart = 0; for (let i = 0; i < frames.length; i++) { if (frames[i].T <= ev.T && xs[i] != null) xStart = xs[i]; }
    const dir = Math.sign(ev.target - xStart) || 1;
    let os = 0, tp = null;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].T <= ev.T || frames[i].T > end || xs[i] == null) continue;
      const o = (xs[i] - ev.target) * dir; if (o > os) { os = o; tp = frames[i].T; }
    }
    segs.push({ t_ms: round(ev.T - anchorT, 3), target_px: ev.target, v0_px_s: ev.v, x_start_px: round(xStart, 4),
      overshoot_px: round(os, 4), overshoot_frac_of_segment: round(os / Math.max(1e-9, Math.abs(ev.target - xStart)), 5), t_peak_ms: tp == null ? null : round(tp - anchorT, 3) });
  }
  return segs;
}

/** Closed-form chain (independent of TimedSpring): dense 1 ms evaluation of the analytic spring through the schedule. */
function closedFormChain(P, sched, A, endMs) {
  const omega = P.omega0 ?? Math.sqrt(P.k / P.m), zeta = P.zeta ?? P.c / (2 * Math.sqrt(P.k * P.m));
  let seg = { x0: 0, v0: 0, g: 0, omega, zeta }, tSeg = 0;
  const xs = new Float64Array(endMs + 1);
  let ei = 0;
  for (let t = 0; t <= endMs; t++) {
    while (ei < sched.length && sched[ei].t <= t) {
      const e = sched[ei], s = analyticAt(seg, (e.t - tSeg) / 1000);
      seg = { x0: s.x, v0: e.v != null ? e.v * A : s.v, g: e.level * A, omega, zeta }; tSeg = e.t; ei++;
    }
    xs[t] = analyticAt(seg, (t - tSeg) / 1000).x;
  }
  return xs;
}

export function truth(routeId, params, regime = 'R3', opts = {}) {
  const route = loadRoutes().find(r => r.id === routeId);
  if (!route) throw new Error('unknown route ' + routeId);
  const tr = typeof opts.trace === 'string' ? loadTrace(route, opts.trace) : (opts.trace || loadTrace(route, Object.keys(route.traces)[0]));
  const P = cellParams(params, tr);
  const total = traceDurationMs(tr) + 200;
  const frames = plannedFrames(regime, total);
  const sim = simulate(routeId, P, { frames, trace: tr });
  const xs = sim.channels['.b0|drv:--x'];
  const anchorT = frames[0].T;
  const base = { schema: SCHEMA, route: routeId, params: P, trace: tr.id, regime, channels: CHANNELS,
    timeBase: { origin: 'anchor', note: 'ms after the first animation-frame callback of the page; the row of that frame is the first row of the watched element that carries drv:--x' },
    planned: { frames: frames.length, dtMs: round(frames[1].T - frames[0].T, 4), durationMs: total, source: 'refsim on the regime grid' } };

  if (routeId === 'm07' || routeId === 'm07x' || routeId === 'm08') {
    const A = P.A ?? AMPLITUDE, sched = SCHEDULES[P.sched];
    const id = P.integrator || 'i6', I = INTEGRATORS[id];
    const native = P.kf != null;
    const canon = native ? null : canonical(P);
    const eq = native ? nativePoleEquivalent(P.kf, P.cf) : { omega0: Math.sqrt(canon.k / canon.m), zeta: canon.c / (2 * Math.sqrt(canon.k * canon.m)) };
    const last = sched[sched.length - 1], lastEv = sim.events[sim.events.length - 1];
    const fin = last.level * A, tol2 = 0.02 * A, tol1 = 0.01 * A;
    const segs = springSegments(frames, xs, sim.events, anchorT, A);
    const cf = closedFormChain(P, sched, A, Math.min(total, 8000));
    const cfSettle = (tol) => { let l = null; for (let t = 0; t < cf.length; t++) if (Math.abs(cf[t] - fin) > tol) l = t; return l == null ? 0 : l - last.t; };
    const first = sched[0];
    const item = {
      target: TARGET, channels: CHANNELS, class: 'spring', family: I.kind === 'analytic' ? 'spring-analytic' : 'spring-discrete',
      integrator: id, integratorLabel: I.label,
      params: {
        k_over_m: native ? null : round(canon.k / canon.m, 6), c_over_m: native ? null : round(canon.c / canon.m, 6),
        omega0: round(eq.omega0, 6), zeta: round(eq.zeta, 6), native: native ? { kf: P.kf, cf: P.cf, unit: 'per 60 Hz frame' } : null,
        amplitude_px: A, snap: I.kind === 'analytic' ? null : { x_px: SNAP.x, v_px_s: SNAP.v, provenance: 'inferred bounds' },
        substep_ms: I.h != null ? I.h * 1000 : null, dt_cap_ms: I.cap != null ? round(I.cap * 1000, 4) : null,
      },
      retargets: segs,
      derived: {
        first_segment_overshoot_px: segs[0].overshoot_px,
        settle_2pct_after_last_event_ms: settleMs(frames, xs, lastEv.T, fin, tol2, lastEv.T),
        settle_1pct_after_last_event_ms: settleMs(frames, xs, lastEv.T, fin, tol1, lastEv.T),
        final_px: round(xs[xs.length - 1], 6), amplitude_ref_px: A,
      },
      closed_form: {
        note: 'continuous-time chain of the analytic spring with the same (omega0, zeta) and retargets, 1 ms grid; for discrete integrators this is the limit h -> 0, not the page',
        overshoot_frac_from_rest: eq.zeta < 1 ? round(Math.exp(-Math.PI * eq.zeta / Math.sqrt(1 - eq.zeta * eq.zeta)), 6) : 0,
        settle_2pct_after_last_event_ms: cfSettle(tol2), first_event_ms: first.t,
      },
      expect: {
        integratorIdentified: id,
        analyticFlagRequired: I.kind !== 'analytic',   // an analytic (omega, zeta) alone must carry valid_for_reproduction_only unless the page IS analytic
        inFitterSet: routeId !== 'm07x',
        driver: 'time', unitMass: 'm is unobservable; compare k/m and c/m (A1.6 c); i4 compares native (kf, cf)',
      },
    };
    return { ...base, items: [item], attribution: { [TARGET]: 'time-driven' }, stagger: null, metrics: route.metrics };
  }

  if (routeId === 'm10') {
    const script = POINTER_SCRIPTS[P.path];
    const rel = sim.events.find(e => e.type === 'release');
    const law = P.law === 'dt' ? 'dt-aware' : 'per-frame';
    const items = [];
    const driveEnd = script.moveToT;
    const drag = { target: TARGET, segment: 'drag', class: 'ramp', scored: false, note: 'the box follows the pointer; velocity constant, writes quantised by the 10 ms pointer ticks; not a fitted model',
      derived: { from_ms: script.moveFromT, to_ms: driveEnd, speed_px_ms: script.speed } };
    items.push(drag);
    if (rel.vFrame === 0 || Math.abs(rel.vFrame) < INERTIA_STOP) {
      items.push({ target: TARGET, segment: 'post-release', class: 'static', family: 'no-momentum', scored: true,
        derived: { release_ms: round(rel.T - anchorT, 3), release_velocity_px_ms: round(rel.vms, 6) },
        expect: { momentumRecord: false, note: 'a release with zero input velocity must yield no momentum; a decay record here is a fabrication (design 4.4)' } });
    } else {
      let lastMove = rel.T;
      for (let i = 0; i < frames.length; i++) if (frames[i].T > rel.T && xs[i] != null && i > 0 && xs[i] !== xs[i - 1]) lastMove = frames[i].T;
      const endX = xs[xs.length - 1];
      // independent closed form: iterate the recurrence on this regime's frame periods
      let v = rel.vFrame, x = 0, n = 0; const dt0 = (frames[1].T - frames[0].T) / 1000;
      for (;;) {
        const s = law === 'dt-aware' ? 60 * dt0 : 1;
        v *= law === 'dt-aware' ? Math.pow(P.friction, s) : P.friction;
        if (Math.abs(v) < INERTIA_STOP) break; x += v * s; n++;
        if (n > 1e5) break;
      }
      items.push({
        target: TARGET, segment: 'post-release', class: 'friction', family: 'friction', law, scored: true,
        params: { friction: P.friction, law, stop_eps_px_per_frame: INERTIA_STOP, release_velocity_px_per_frame_60hz: round(rel.vFrame, 6),
          release_velocity_px_ms: round(rel.vms, 6), unit: law === 'per-frame' ? 'v *= f per rendered frame: the stopping TIME scales with the frame period, the distance does not (release velocity converted at a nominal 60 Hz)' : 'v *= f^(60 dt): time and distance are frame-rate independent up to the Euler step' },
        derived: {
          release_ms: round(rel.T - anchorT, 3), x_at_release_px: round(rel.x, 4),
          stopping_distance_px: round(endX - rel.x, 4), stop_ms_after_release: round(lastMove - rel.T, 3), frames_with_motion: n + 1,
        },
        closed_form: { note: 'recurrence iterated on a constant frame period (regime dt), independent of Inertia', stopping_distance_px: round(x, 4), moving_frames: n },
        expect: { releaseVelocityFromInputLog: round(rel.vms, 6), law },
      });
    }
    return { ...base, items, attribution: { [TARGET]: 'pointer' }, stagger: null, metrics: route.metrics };
  }
  throw new Error('truth: unknown route ' + routeId);
}
