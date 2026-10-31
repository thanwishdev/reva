// Lab-runner adapter for group A (contract reva.labgroup/0, src/lab/groups.js). Written by the integrator from
// this group's own harness (tools/harness.mjs, tools/parity.mjs) so the shared runner records, checks parity and builds
// truth exactly as the builder proved it. The blind server refuses this file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeParams } from './core.js';
import { simulate } from './refsim.mjs';
import { truth as truthOf } from './truth.mjs';
import { compareToTake } from './tools/harness.mjs';
import { ctxOf, compareBirths } from './tools/parity.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const name = 'lab-easing';
const FILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes.json'), 'utf8'));
const trace = (r, v) => JSON.parse(fs.readFileSync(path.join(ROOT, r.traces[v]), 'utf8'));
/** Code variants (A1.5/A1.6 i): m18 has two implementations (WAAPI, rAF); every other route is one code path. */
const CV_KEY = { m18: 'impl' };

/** Routes in A1.4 order with code variants, traces, draw boxes. */
export function routes() {
  return FILE.routes.map((r) => {
    const key = CV_KEY[r.id];
    const ids = key ? [...new Set(r.params.grid.map((g) => g[key]))] : ['-'];
    const codeVariants = ids.map((id) => {
      const grid = key ? r.params.grid.filter((g) => g[key] === id) : r.params.grid;
      const def = key ? (r.params.default[key] === id ? r.params.default : grid[0]) : r.params.default;
      return { id, default: def, grid };
    });
    return { id: r.id, driver: r.driver, engine: r.engine || 'chs', traces: Object.keys(r.traces), codeVariants, box: r.box, draw: !!r.box, truthClass: r.truthClass };
  });
}

/** A1.4 cells: route × grid vector × trace. */
export function cells() {
  const out = [];
  for (const r of FILE.routes) r.params.grid.forEach((p, gi) => { for (const v of Object.keys(r.traces)) out.push({ route: r.id, params: p, variant: v, gridIndex: gi, cv: CV_KEY[r.id] ? p[CV_KEY[r.id]] : '-' }); });
  return out;
}

/** Confirmation draw inside the route's registered box (keys outside the box keep the code variant's default). */
export function draw(routeId, cvId, rng) {
  const r = routes().find((x) => x.id === routeId); const cv = r.codeVariants.find((c) => c.id === cvId);
  const p = JSON.parse(JSON.stringify(cv.default));
  for (const [k, [lo, hi]] of Object.entries(r.box)) { const x = lo + (hi - lo) * rng(); p[k] = Number.isInteger(lo) && Number.isInteger(hi) && Number.isInteger(cv.default[k]) ? Math.round(x) : +x.toFixed(4); }
  return p;
}

/** Recorder session spec for a cell. */
export function sessionSpec(cell) {
  const r = FILE.routes.find((x) => x.id === cell.route); const t = trace(r, cell.variant);
  return {
    page: `${name}/${r.page}`, hash: '#p=' + encodeParams(cell.params), engine: r.engine || 'chs', args: [],
    viewport: t.viewport || FILE.viewport, seed: t.seed ?? 1, scene: { computedVars: r.watch.computedVars || [] },
    selectors: r.watch.selectors, boot: t.boot || {}, actions: t.actions,
  };
}

/** Parity of a raw take against refsim (channels within 2× floor and declared births equal). */
export function parity(take, cell) {
  const sim = simulate(cell.route, cell.params, ctxOf(take, cell.variant));
  const cmp = compareToTake(take, sim); const births = compareBirths(take, sim.events);
  const worst = Math.max(0, ...cmp.channels.map((c) => (c.tol ? c.maxAbs / c.tol : 0)).filter(Number.isFinite));
  return { pass: cmp.ok && births.mismatches.length === 0, worstRatio: worst, bad: cmp.channels.filter((c) => !c.ok).map((c) => `${c.key}:${c.maxAbs}/${c.tol}${c.error ? ' ' + c.error : ''}`).concat(births.mismatches.map((m) => 'birth:' + m.why)).slice(0, 6) };
}

/** Truth for a cell from the actual take (regime R6 = the R2 take's truth with the R6 regime label). */
export function truth(cell, regime, take) {
  return truthOf(cell.route, cell.params, regime, { ctx: ctxOf(take, cell.variant), variant: cell.variant });
}
