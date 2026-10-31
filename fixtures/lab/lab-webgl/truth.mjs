// Ground truth for Fixture Lab group D (design §11). Read ONLY by the lab runner/scorer; the lab server refuses it.
//
//   truth(routeId, params, regime, { variant, ctx }) -> { schema: 'reva.labtruth/0', route, params, regime, items,
//                                                         attribution, stagger, negative, metrics }
//
// Closed-form values come from the recurrences in core.js. Regime-dependent values (per-frame alpha of a dt-aware law,
// settle length in frames, overshoot of the discrete spring) come from refsim on `ctx` (the actual take) or, without
// one, on the PLANNED trace (go at k = 0, frames at the regime's grid). Class names follow DECISIONS A1.6(a).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseParams, springConsts, CAM, VIEWPORT } from './core.js';
import { simulate } from './refsim.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const ROUTES = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes.json'), 'utf8'));
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const SCHEMA = 'reva.labtruth/0';

export const REGIME_DT = { R2: 1000 / 60, R3: 1000 / 120, R4: 1000 / 30, R5: 1000 / 60, R6: 1000 / 60 };
/** Virtual frame time of frame k (design §12 X1: R5 adds 100 - dt ms after every 30 frames). */
export function frameT(k, regime) {
  const dt = REGIME_DT[regime];
  return r6(k * dt + (regime === 'R5' ? Math.floor(k / 30) * (100 - dt) : 0));
}

/** Frames, inputs and marks the recorder would produce for a trace, with the start signal at k = 0. */
export function planCtx(routeId, variant, regime) {
  const route = ROUTES.find((r) => r.id === routeId);
  const trace = JSON.parse(fs.readFileSync(path.join(ROOT, route.traces[variant]), 'utf8'));
  const dt = REGIME_DT[regime];
  const maxScroll = route.docHeight ? route.docHeight - VIEWPORT.height : 0;
  const frames = [{ k: 0, T: 0, sy: 0, sx: 0 }], inputs = [], marks = [];
  let k = 0, sy = 0;
  for (const a of trace.actions) {
    if ('hold' in a) for (let i = Math.round(a.hold / dt); i > 0; i--) { k++; frames.push({ k, T: frameT(k, regime), sy, sx: 0 }); }
    else if ('scrollTo' in a) { sy = Math.min(a.scrollTo, maxScroll); inputs.push({ type: 'scrollTo', k, T: frameT(k, regime), got: sy }); }
    else if ('mark' in a) marks.push({ name: a.mark, k, T: frameT(k, regime) });
  }
  return { frames, inputs, marks, dateEpoch: Date.UTC(2026, 9, 14, 9, 0, 0), regime };
}

const firstWhere = (arr, f) => { for (let i = 0; i < arr.length; i++) if (f(arr[i], i)) return i; return -1; };
/** Frames from an input (landed after frame afterK) until a series first equals its target exactly (the page snaps there). */
function settleFrames(ctx, series, afterK, target) {
  for (let i = 0; i < series.length; i++) if (ctx.frames[i].k > afterK && series[i] === target) return ctx.frames[i].k - afterK;
  return null;
}

function m13(P, ctx, regime) {
  const dt = REGIME_DT[regime];
  const perFrame = P.law === 'frame';
  const alpha = perFrame ? P.alpha : 1 - Math.exp((-P.lambda * dt) / 1000);
  const tau = perFrame ? -dt / Math.log(1 - P.alpha) : 1000 / P.lambda;
  const sim = simulate('m13', P, ctx).channels['.b0|drv:--x'];
  const firstPtr = ctx.marks.find((m) => m.name.startsWith('ptr:'));
  const firstX = firstPtr ? +/^ptr:(-?[\d.]+),/.exec(firstPtr.name)[1] : null;
  const item = (axis) => ({
    target: `.b0|ren:t${axis}`, driver: `.b0|drv:--${axis}`, class: 'first-order smoothing', family: 'lerp',
    law: perFrame ? 'per-frame' : 'dt-aware',
    params: { alpha_per_frame: alpha, lambda_per_s: perFrame ? null : P.lambda, tau_ms: tau, snap_px: P.snap, write: P.write },
    derived: { alpha_per_frame_at_T: alpha, tau_ms_at_T: tau, settle_frames_first_input: firstPtr ? settleFrames(ctx, sim, firstPtr.k, firstX) : null },
  });
  return { items: [item('x'), item('y')], attribution: { '.b0|ren:tx': 'pointer', '.b0|ren:ty': 'pointer' } };
}

function camera(routeId, P, ctx, regime) {
  const dom = { target: 'dom', class: 'not_applicable', note: 'content is drawn into a canvas; no DOM channel moves' };
  const pix = Object.keys(CAM.markers).map((key) => ({
    target: `pix:${key}`, class: 'not_scored', metric: 'pixel_nrmse', latent: 'gl:u_a', diag_px: Math.hypot(VIEWPORT.width, VIEWPORT.height),
    projection: { canvas: { left: CAM.left, top: CAM.top, w: CAM.W, h: CAM.H }, camera: { dist: CAM.dist, height: CAM.height, look: CAM.look, fovY_deg: 45 }, world: CAM.markers[key].pos },
  }));
  const orbit = P.mode === 'orbit';
  const sp = springConsts(P.zeta, P.lag);
  const angle = simulate(routeId, P, ctx).channels['gl:u_a'];
  let item = null;
  if (routeId === 'm14') {
    if (orbit) item = { target: 'gl:u_a', class: 'ramp', family: 'wall-clock', params: { rate_rad_per_s: P.orbitRate * 1000 }, derived: {} };
    else {
      const a0 = firstWhere(ctx.frames, (f) => f.sy > 0);
      const goal = ctx.frames[a0] ? ctx.frames[a0].sy * P.gain : 0;
      let peak = 0, tPeak = null;
      for (let i = a0; i < ctx.frames.length && ctx.inputs.length; i++) { if (ctx.inputs[1] && ctx.frames[i].k > ctx.inputs[1].k) break; if (angle[i] > peak) { peak = angle[i]; tPeak = ctx.frames[i].T - ctx.frames[a0 - 1].T; } }
      item = {
        target: 'gl:u_a', class: 'spring', family: 'discrete-spring', integrator: { id: 'I7', description: 'semi-implicit Euler, one step of min(dt, cap) per frame', cap_ms: P.capMs },
        params: { k_over_m: sp.k, c_over_m: sp.c, omega0: sp.omega, zeta: sp.zeta, lag_s: P.lag, gain_rad_per_px: P.gain, snap_v: P.snapV, snap_x: P.snapX },
        derived: { overshoot_frac: goal ? peak / goal - 1 : null, time_to_peak_ms: tPeak, analytic_overshoot_frac: P.zeta < 1 ? Math.exp((-Math.PI * P.zeta) / Math.sqrt(1 - P.zeta * P.zeta)) : 0 },
      };
    }
  }
  const items = item ? [item, dom, ...pix] : [dom, ...pix];
  const attribution = routeId === 'm14' ? { 'gl:u_a': orbit ? 'time-driven' : 'scroll-linked' } : {};
  return { items, attribution };
}

function neg(routeId, P, route) {
  const cls = route.truthClass;
  const mk = (target, extra = {}) => ({ target, class: cls, params: {}, derived: {}, ...extra });
  let items;
  if (routeId === 'm16a') items = [mk('.b0|ren:tx'), mk('.b0|ren:ty'), mk('.b0|ren:opacity'), mk('.b1|ren:tx')];
  else if (routeId === 'm16b') items = [mk('.b0|ren:tx', { params: { generator: 'mulberry32', seed: P.seed, base: P.base, amp: P.amp }, note: 'one pseudo-random value per page frame; no model other than noise is correct' })];
  else if (routeId === 'm16c') items = [mk('.b0|ren:tx', { family: 'slew-limited chase', params: { speed_px_per_s: P.speed }, derived: { note: 'ramp segments at constant speed, then rest' } })];
  else items = [mk('.b0|ren:tx', { family: 'delayed two-level map', params: { amp_px: P.amp, threshold_px: P.threshold, delay_frames: 1 } })];
  return { items, attribution: {}, negative: route.negative };
}

function m20(P, variant) {
  const al = P.alpha;
  const idle = variant === 'idle';
  const k = P.k, c = P.c;
  const items = [
    idle
      ? { target: '.e0|ren:tx', driver: '.e0|drv:--q', class: 'static', params: {}, derived: {} }
      : { target: '.e0|ren:tx', driver: '.e0|drv:--q', class: 'first-order smoothing', family: 'lerp', law: 'per-frame', params: { alpha_per_frame: al, snap_px: P.snap, target_gain: P.scrollGain, target_max_px: P.scrollMax * P.scrollGain }, derived: { tau_ms_at_T_60hz: -(1000 / 60) / Math.log(1 - al) } },
    { target: '.e1|ren:tx', driver: '.e1|drv:--s', class: 'spring', family: 'discrete-spring', integrator: { id: 'I1', h_ms: P.hMs, description: 'semi-implicit Euler, fixed substeps with remainder' }, params: { k_over_m: k, c_over_m: c, omega0: Math.sqrt(k), zeta: c / (2 * Math.sqrt(k)), retarget_every_ms: 1000, amp_px: P.amp1 }, derived: {} },
    { target: '.e2|ren:opacity', driver: '.e2|drv:--w', class: 'periodic', family: 'tick', params: { period_ms: 1000, first_ms_after_start: P.tickOffsetMs + 1000, levels: [0.35, 1] }, derived: {} },
    idle
      ? { target: '.e3|ren:tx', driver: '.e3|drv:--z', class: 'static', params: {}, derived: {} }
      : { target: '.e3|ren:tx', driver: '.e3|drv:--z', class: 'tween', family: 'time-based', params: { dur_ms: P.tweenMs, ease: 'easeOutQuart', amp_px: P.tweenAmp, trigger: 'observer enters/leaves a block at document y 1500..1700', retarget: 'from-current' }, derived: {} },
  ];
  const attribution = {
    '.e0|ren:tx': idle ? 'static' : 'scroll-linked', '.e1|ren:tx': 'time-driven', '.e2|ren:opacity': 'time-driven',
    '.e3|ren:tx': idle ? 'static' : 'scroll-triggered time-based',
  };
  return { items, attribution };
}

function m21(P) {
  const t = (x) => (-Math.log2(1 - x) / 10) * P.durMs;
  return {
    items: [{
      target: '.b0|ren:tx', driver: '.b0|drv:--v', class: 'restarted tween', family: 'time-based, non-LTI', law: 'time-based, non-LTI',
      params: { dur_ms: P.durMs, ease: 'expo.out', ease_formula: '1 - 2^(-10 p), 1 at p = 1', restart: 'from-current, at every change of the target', target_gain: P.gain, target_max_px: P.max * P.gain, write: P.write },
      derived: { step_response_duration_ms: P.durMs, t10_ms: t(0.1), t50_ms: t(0.5), t90_ms: t(0.9), t99_ms: t(0.99), final_jump_frac: 2 ** -10 },
    }],
    attribution: { '.b0|ren:tx': 'scroll-triggered time-based' },
  };
}

function m22(P, regime) {
  const dt = REGIME_DT[regime];
  return {
    items: [{
      target: '.b0|ren:tx', driver: '.b0|drv:--d', class: 'composite', family: 'smoothing driver -> declared CSS transition',
      stages: [
        { stage: 'driver', channel: '.b0|drv:--d', class: 'first-order smoothing', law: 'per-frame', params: { alpha_per_frame: P.alpha, snap_px: P.snap, tau_ms_at_T: -dt / Math.log(1 - P.alpha), target_gain: P.gain, write: P.write } },
        { stage: 'rendered', class: 'declared', kind: 'css-transition', params: { property: 'transform', duration_ms: P.durMs, easing: `cubic-bezier(${P.ease.join(', ')})`, restart: 'new transition from the current value at every driver change' } },
      ],
      params: { alpha_per_frame: P.alpha, duration_ms: P.durMs, easing: P.ease }, derived: { driver_alpha_per_frame: P.alpha },
    }],
    attribution: { '.b0|ren:tx': 'scroll-linked' },
  };
}

export function truth(routeId, params, regime = 'R3', { variant, ctx } = {}) {
  const route = ROUTES.find((r) => r.id === routeId);
  if (!route) throw new Error(`truth: unknown route ${routeId}`);
  const P = parseParams(routeId, params);
  variant = variant || Object.keys(route.traces)[0];
  const c = ctx || planCtx(routeId, variant, regime);
  let body;
  if (routeId === 'm13') body = m13(P, c, regime);
  else if (routeId === 'm14' || routeId === 'm14b') body = camera(routeId, P, c, regime);
  else if (routeId === 'm20') body = m20(P, variant);
  else if (routeId === 'm21') body = m21(P);
  else if (routeId === 'm22') body = m22(P, regime);
  else body = neg(routeId, P, route);
  return { schema: SCHEMA, route: routeId, params: P, regime, variant, metrics: route.metrics, stagger: null, negative: null, ...body };
}
