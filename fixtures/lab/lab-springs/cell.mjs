// Cell helpers for the lab runner (group B). A cell = (route, parameter vector, trace variant); regime is separate.
// Not served to pages (the lab server refuses it); never imported by the fitter.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeParams } from './core.js';
import { simulate, plannedFrames } from './refsim.mjs';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const loadRoutes = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'routes.json'), 'utf8'));
export const loadTrace = (route, variant) => JSON.parse(fs.readFileSync(path.join(ROOT, route.traces[variant]), 'utf8'));

/** The parameter object the page and refsim both receive: the vector plus the trace's page-side fields (sched / path). */
export const cellParams = (params, trace) => ({ ...params, ...(trace.page || {}) });
/** Page URL for a cell, relative to the lab server origin. */
export const cellUrl = (origin, route, params, trace) => `${origin}/routes/${route.page}#p=${encodeParams(cellParams(params, trace))}`;
/** Virtual time the recorder covers for a trace (the sum of its holds), measured from boot-done. */
export const traceDurationMs = (trace) => trace.actions.reduce((a, x) => a + (x.hold || 0), 0);

/**
 * refsim context from a take's rows. `rows` = take rows ({k, T, sy, sx, v}), `els` = element descriptors (take.els or the
 * `elements` series). The anchor is the first row in which the watched element has the driver channel: the page writes
 * `--x` when its script runs, the element is then discovered at the next sample, and that sample is the page's first
 * animation-frame callback. Returns {anchorIndex, elId, ctx}.
 */
export function ctxFromRows(rows, els, selectorDesc = 'DIV.b0') {
  const elId = els.findIndex(d => d === selectorDesc);
  if (elId < 0) throw new Error(`no ${selectorDesc} element in the take`);
  const anchorIndex = rows.findIndex(r => r.v && r.v[elId] && r.v[elId]['drv:--x'] != null);
  if (anchorIndex < 0) throw new Error('the page never wrote --x');
  return { elId, anchorIndex, ctx: { frames: rows.map(r => ({ k: r.k, T: r.T, sy: r.sy, sx: r.sx })), viewport: { width: 1280, height: 800 }, anchorIndex } };
}

// ------------------------------------------------------------------------------------------------ confirmation draws
/** A vector is valid when its planned simulation stays finite and within 5000 px at R3, R4 and R5 (a diverging integrator is a fixture bug). */
export function isValid(routeId, params, trace) {
  const p = cellParams(params, trace);
  for (const R of ['R3', 'R4', 'R5']) {
    const frames = plannedFrames(R, 3500);
    const xs = simulate(routeId, p, { frames }).channels['.b0|drv:--x'];
    if (!xs.every(x => x == null || (Number.isFinite(x) && Math.abs(x) <= 5000))) return false;
  }
  return true;
}

const lerp = (r, u) => r[0] + u * (r[1] - r[0]);
function nativeFromPoles(zeta, w) {
  let c, k;
  if (zeta < 1) { const wd = w * Math.sqrt(1 - zeta * zeta); c = 1 - Math.exp(-2 * zeta * w); k = 2 - c - 2 * Math.exp(-zeta * w) * Math.cos(wd); }
  else { const r = Math.sqrt(zeta * zeta - 1), z1 = Math.exp(-w * (zeta - r)), z2 = Math.exp(-w * (zeta + r)); c = 1 - z1 * z2; k = 2 - c - (z1 + z2); }
  return { kf: +k.toFixed(3), cf: +c.toFixed(3) };
}
/**
 * One parameter vector drawn uniformly inside a code variant's box (PLAN A1.6 i). `rng()` returns uniforms in [0, 1); it is
 * consumed 3 values per attempt, in the order of the draw spec. Attempts whose vector is not valid (isValid) are redrawn
 * from the next 3 values, so the result is uniform over the valid part of the box. `trace` is the cell's trace (default trace).
 */
export function drawParams(route, variantId, rng, trace) {
  const v = route.codeVariants.find(c => c.id === variantId); if (!v) throw new Error('unknown variant ' + variantId);
  trace = trace || loadTrace(route, Object.keys(route.traces)[0]);
  const d = v.draw;
  for (let attempt = 0; attempt < 200; attempt++) {
    const u = [rng(), rng(), rng()];
    let p;
    if (d.kind === 'omega-zeta-m') {
      const omega0 = lerp(d.omega0, u[0]), zeta = lerp(d.zeta, u[1]), m = lerp(d.m, u[2]);
      p = { ...v.default, k: +(m * omega0 * omega0).toFixed(3), c: +(2 * zeta * m * omega0).toFixed(4), m: +m.toFixed(4) };
    } else if (d.kind === 'native-pole') {
      p = { ...v.default, ...nativeFromPoles(lerp(d.zeta, u[1]), lerp(d.omega_per_frame, u[0])) };
    } else if (d.kind === 'omega-zeta') {
      p = { ...v.default, omega0: +lerp(d.omega0, u[0]).toFixed(4), zeta: +lerp(d.zeta, u[1]).toFixed(4) };
    } else if (d.kind === 'range') {
      p = { ...v.default, friction: +lerp(d.friction, u[0]).toFixed(5) };
    } else throw new Error('unknown draw kind ' + d.kind);
    if (isValid(route.id, p, trace)) return p;
  }
  throw new Error('no valid draw in 200 attempts for ' + variantId);
}
