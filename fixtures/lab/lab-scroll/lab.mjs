// Lab-runner adapter for group C (contract reva.labgroup/0, src/lab/groups.js). Written by the integrator from
// this group's own plan.mjs and parity.mjs. The blind server refuses this file.
import { scenarioSpec, pageHash, routesFile } from './plan.mjs';
import { compareTake } from './parity.mjs';
import { ctxFromTake } from './refsim.mjs';
import { truth as truthOf } from './truth.mjs';

export const name = 'lab-scroll';
const FILE = routesFile();

export function routes() {
  return FILE.routes.map((r) => ({ id: r.id, driver: r.driver, engine: r.engine || 'chs', traces: Object.keys(r.traces),
    codeVariants: [{ id: '-', default: r.params.default, grid: r.params.grid }], draw: true, truthClass: r.truthClass }));
}

/** A1.4 cells: grid × traces, plus M02's write q3/q2 variants on its write-variant trace. */
export function cells() {
  const out = [];
  for (const r of FILE.routes) {
    r.params.grid.forEach((p, gi) => { for (const v of Object.keys(r.traces)) out.push({ route: r.id, params: p, variant: v, gridIndex: gi, cv: '-' }); });
    (r.params.writeVariants || []).forEach((p, wi) => out.push({ route: r.id, params: p, variant: r.params.writeVariantTrace, gridIndex: `w${wi}`, cv: '-' }));
  }
  return out;
}

/** Confirmation draw: uniform in the grid's numeric box (no box was registered by the group). */
export function draw(routeId, cvId, rng) {
  const r = FILE.routes.find((x) => x.id === routeId); const p = { ...r.params.default };
  for (const k of Object.keys(p)) {
    const vals = r.params.grid.map((g) => g[k]).filter((v) => typeof v === 'number'); if (vals.length < 2) continue;
    const lo = Math.min(...vals), hi = Math.max(...vals); const x = lo + (hi - lo) * rng();
    p[k] = vals.every(Number.isInteger) && hi - lo >= 50 ? Math.round(x) : +x.toFixed(4);   // ms/px-scale integers stay integers
  }
  return p;
}

export function sessionSpec(cell) {
  const r = FILE.routes.find((x) => x.id === cell.route); const s = scenarioSpec(cell.route, cell.variant, r);
  return { page: `${name}/${r.page}`, hash: pageHash(cell.params), engine: r.engine || 'chs', args: [], viewport: s.viewport, seed: s.seed,
    scene: {}, selectors: s.scene.selectors, boot: s.boot, actions: s.actions };
}

export function parity(take, cell) {
  const c = compareTake(take, cell.route, cell.params);
  return { pass: c.ok, worstRatio: c.worstRatio, bad: Object.entries(c.channels).filter(([, x]) => !x.pass).map(([k, x]) => `${k}:${x.max}/${x.tol}/miss${x.missing}`).concat(c.events.ok ? [] : ['events:' + JSON.stringify(c.events.diffs.slice(0, 2))]).slice(0, 6) };
}

export function truth(cell, regime, take) {
  const ctx = ctxFromTake({ take, data: { rows: take.data.rows, inputLog: take.inputLog, wheel: take.data.wheel } });
  return truthOf(cell.route, cell.params, regime, cell.variant, ctx);
}
