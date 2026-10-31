// Fixture Lab, group C: trace planning (no browser).
//   - regimes and the hx frame grid exactly as the recorder produces it (T_k = round6(k * dt [+ stall])),
//   - scenario specs (what recordScenario / openSession run) built from routes.json + traces/,
//   - planned frames: the frames a trace produces, used by truth.mjs when no take exists yet.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './core.js';

export const GROUP_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(GROUP_ROOT, rel), 'utf8'));
export const routesFile = () => readJson('routes.json');

const r6 = (x) => Math.round(x * 1e6) / 1e6;
/** Amendment 1, A1.1. R5 follows design X1: T_k = round6(T0 + k*dt + floor(k/30)*(100 - dt)). */
export const REGIMES = {
  R2: { id: 'R2', hz: 60, dt: 1000 / 60, stall: null, stride: 1 },
  R3: { id: 'R3', hz: 120, dt: 1000 / 120, stall: null, stride: 1 },
  R4: { id: 'R4', hz: 30, dt: 1000 / 30, stall: null, stride: 1 },
  R5: { id: 'R5', hz: 60, dt: 1000 / 60, stall: { every: 30, ms: 100 }, stride: 1 },
  R6: { id: 'R6', hz: 60, dt: 1000 / 60, stall: null, stride: 2 },
};
export function frameTime(regime, k) {
  const g = typeof regime === 'string' ? REGIMES[regime] : regime;
  const stall = g.stall ? Math.floor(k / g.stall.every) * (g.stall.ms - g.dt) : 0;
  return r6(k * g.dt + stall);
}

export const DOC_HEIGHT = { m01: 2400, m02: 3000, m03: 3400, m04: 4000, m05: 4400, m09: C.M09.DOC_H, m09b: C.M09B.DOC_H };
export const maxScroll = (routeId) => DOC_HEIGHT[routeId] - C.VH;

/** Scenario spec for the recorder (src/record/scenario.js runActions + session options). */
export function scenarioSpec(routeId, variant, route = routesFile().routes.find(r => r.id === routeId)) {
  const trace = readJson(route.traces[variant]);
  return {
    viewport: routesFile().viewport,
    seed: 20261015,
    boot: { until: route.boot.until },
    scene: { selectors: route.watch.selectors },
    actions: trace.actions,
  };
}

/** URL hash carrying the parameters (blind pages read nothing else). */
export function pageHash(params) { return '#p=' + C.encodeParams(params); }

/**
 * Frames produced by an action list under a regime. Mirrors src/record/session.js: hold(ms) = round(ms/dt) frames,
 * scrollTo takes effect for the next frame, a wheel event costs one frame, denseSweep = scrollTo + step per position.
 * `sy` follows scrollTo only (the effect of an un-prevented wheel is not planned). `k0` = frames before the first action.
 */
export function planFrames(actions, regimeId, { routeId, k0 = 8 } = {}) {
  const g = REGIMES[regimeId];
  const max = routeId ? maxScroll(routeId) : Infinity;
  const frames = []; const inputs = [];
  let k = 0, sy = 0;
  const step = (n) => { for (let i = 0; i < n; i++) { k++; frames.push({ k, T: frameTime(g, k), sy, sx: 0 }); } };
  const scrollTo = (y) => { sy = Math.min(Math.max(0, y), max); inputs.push({ type: 'scrollTo', want: y, got: sy, k, T: frameTime(g, k) }); };
  step(k0);
  for (const a of actions) {
    if ('hold' in a) step(Math.round(a.hold / g.dt));
    else if ('step' in a) step(a.step);
    else if ('scrollTo' in a) scrollTo(a.scrollTo);
    else if ('mark' in a || 'eval' in a || 'watch' in a || 'snapshot' in a || 'sampling' in a) continue;
    else if ('wheel' in a) { const n = a.wheel.n ?? 100; for (let i = 0; i < n; i++) { inputs.push({ type: 'wheel', i, dy: a.wheel.dy ?? 10, k, T: frameTime(g, k) }); step(1); } }
    else if ('denseSweep' in a) {
      const { from = 0, to, px = 10, framesPerPos = 1 } = a.denseSweep; const ys = []; for (let y = from; y <= to; y += px) ys.push(y);
      for (const y of [...ys, ...ys.slice(0, -1).reverse()]) { scrollTo(y); step(framesPerPos); }
    } else if ('sweep' in a) {
      const { from = 0, to, step: sp = 300, holdMs = 350, both = false } = a.sweep; const ys = []; for (let y = from; y <= to; y += sp) ys.push(y);
      if (ys[ys.length - 1] !== to) ys.push(to);
      for (const y of (both ? [...ys, ...ys.slice(0, -1).reverse()] : ys)) { scrollTo(y); step(Math.round(holdMs / g.dt)); }
    } else throw new Error('plan: unknown action ' + JSON.stringify(a));
  }
  return { frames, inputs, k0, regime: g };
}
