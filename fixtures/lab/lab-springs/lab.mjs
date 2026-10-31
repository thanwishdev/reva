// Lab-runner adapter for group B (contract reva.labgroup/0, src/lab/groups.js). Written by the integrator from
// this group's own cell.mjs and test/harness.mjs. The blind server refuses this file.
import { encodeParams } from './core.js';
import { loadRoutes, loadTrace, cellParams, drawParams } from './cell.mjs';
import { parity as parityOf } from './test/harness.mjs';
import { truth as truthOf } from './truth.mjs';

export const name = 'lab-springs';
const ROUTES = loadRoutes();

export function routes() {
  return ROUTES.map((r) => ({ id: r.id, driver: r.driver, engine: r.engine || 'chs', traces: Object.keys(r.traces),
    codeVariants: r.codeVariants.map((c) => ({ id: c.id, default: c.default, grid: c.grid })), draw: r.id !== 'm07x', truthClass: r.truthClass }));
}

export function cells() {
  const out = [];
  for (const r of ROUTES) for (const c of r.codeVariants) c.grid.forEach((p, gi) => { for (const v of Object.keys(r.traces)) out.push({ route: r.id, params: p, variant: v, gridIndex: gi, cv: c.id }); });
  return out;
}

/** Confirmation draw: the builder's drawParams (uniform over the valid part of the box, 3 uniforms per attempt). */
export function draw(routeId, cvId, rng) {
  const r = ROUTES.find((x) => x.id === routeId);
  return drawParams(r, cvId, rng, loadTrace(r, Object.keys(r.traces)[0]));
}

export function sessionSpec(cell) {
  const r = ROUTES.find((x) => x.id === cell.route); const t = loadTrace(r, cell.variant);
  return {
    page: `${name}/routes/${r.page}`, hash: '#p=' + encodeParams(cellParams(cell.params, t)), engine: r.engine || 'chs', args: [],
    viewport: t.viewport || { width: 1280, height: 800 }, seed: t.seed ?? 1, scene: t.scene || {},
    selectors: (t.scene && t.scene.selectors) || [], boot: t.boot || {}, actions: t.actions,
  };
}

export function parity(take, cell) {
  const r = ROUTES.find((x) => x.id === cell.route); const t = loadTrace(r, cell.variant);
  const p = parityOf(r, cellParams(cell.params, t), take);
  const ch = Object.entries(p.channels);
  const worst = Math.max(0, ...ch.map(([, c]) => (c.limit ? c.maxAbs / c.limit : 0)));
  return { pass: p.pass, worstRatio: worst, anchorIndex: p.anchorIndex, bad: ch.filter(([, c]) => !c.pass).map(([k, c]) => `${k}:${c.maxAbs}/${c.limit}`) };
}

/** Truth on the regime's planned grid (anchor-relative times, truth.timeBase); the trace selects the schedule. */
export function truth(cell, regime) {
  const r = ROUTES.find((x) => x.id === cell.route);
  return truthOf(cell.route, cell.params, regime, { trace: loadTrace(r, cell.variant) });
}
