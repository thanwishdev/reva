// Lab-runner adapter for group D (contract reva.labgroup/0, src/lab/groups.js). Written by the integrator from
// this group's own tools/harness.mjs. The blind server refuses this file.
import { encodeParams, VIEWPORT } from './core.js';
import { routesJson, loadTrace, sceneFor, parity as parityOf, ctxFromTake, observed } from './tools/harness.mjs';
import { simulate } from './refsim.mjs';
import { truth as truthOf } from './truth.mjs';

export const name = 'lab-webgl';
const ROUTES = routesJson();
/** Code variants (A1.5/A1.6 i): m13 smoothing law (per-frame vs dt-aware), m14 camera mode (spring vs orbit). */
const CV_KEY = { m13: 'law', m14: 'mode' };
const NO_DRAW = new Set(['m16a', 'm16b', 'm16c', 'm16d', 'm20']);

export function routes() {
  return ROUTES.map((r) => {
    const key = CV_KEY[r.id];
    const ids = key ? [...new Set(r.params.grid.map((g) => g[key]))] : ['-'];
    const codeVariants = ids.map((id) => {
      const grid = key ? r.params.grid.filter((g) => g[key] === id) : r.params.grid;
      return { id, default: key ? (r.params.default[key] === id ? r.params.default : grid[0]) : r.params.default, grid };
    });
    return { id: r.id, driver: r.driver, engine: r.engine || 'chs', traces: Object.keys(r.traces), codeVariants, draw: !NO_DRAW.has(r.id), truthClass: r.truthClass,
      idleVariant: r.id === 'm20' ? 'idle' : null };
  });
}

export function cells() {
  const out = [];
  for (const r of ROUTES) r.params.grid.forEach((p, gi) => { for (const v of Object.keys(r.traces)) out.push({ route: r.id, params: p, variant: v, gridIndex: gi, cv: CV_KEY[r.id] ? p[CV_KEY[r.id]] : '-' }); });
  return out;
}

/** Confirmation draw: uniform in the code variant's numeric grid box (a one-value grid keeps its value). */
export function draw(routeId, cvId, rng) {
  const r = routes().find((x) => x.id === routeId); const cv = r.codeVariants.find((c) => c.id === cvId); const p = { ...cv.default };
  for (const k of Object.keys(p)) {
    const vals = cv.grid.map((g) => g[k]).filter((v) => typeof v === 'number'); if (vals.length < 1) continue;
    const lo = Math.min(...vals), hi = Math.max(...vals); const x = lo + (hi - lo) * rng();
    p[k] = lo === hi ? lo : vals.every(Number.isInteger) && hi - lo >= 50 ? Math.round(x) : +x.toFixed(4);   // ms/px-scale integers stay integers
  }
  return p;
}

export function sessionSpec(cell) {
  const r = ROUTES.find((x) => x.id === cell.route); const t = loadTrace(r.id, cell.variant);
  return { page: `${name}/${r.page}`, hash: '#p=' + encodeParams(cell.params || {}), engine: r.engine || 'chs', args: r.launchArgs || [],
    viewport: t.viewport || VIEWPORT, seed: 1, scene: sceneFor(r), selectors: (r.watch && r.watch.selectors) || [], boot: t.boot || {}, actions: t.actions };
}

export function parity(take, cell) {
  const p = parityOf(take, cell.route, cell.params);
  const ch = Object.entries(p.channels);
  const worst = Math.max(0, ...ch.map(([, c]) => (c.limit ? c.maxAbs / c.limit : 0)));
  // M14 gate row: marker trajectory NRMSE (recorded pixel centroid vs the analytic projection) over the screen diagonal
  let pixel = null;
  const keys = [...new Set(Object.keys(p.channels).filter((k) => /^pix:[^:]+:x$/.test(k)).map((k) => k.split(':')[1]))];
  if (keys.length) {
    const sim = simulate(cell.route, cell.params, ctxFromTake(take)); const go = take.marks.find((m) => m.name === 'go');
    const diag = Math.hypot(VIEWPORT.width, VIEWPORT.height); pixel = {};
    for (const key of keys) {
      const ox = observed(take, `pix:${key}:x`), oy = observed(take, `pix:${key}:y`), sx = sim.channels[`pix:${key}:x`], sy = sim.channels[`pix:${key}:y`];
      let se = 0, n = 0;
      for (let i = 0; i < ox.length; i++) { if (go && take.data.rows[i].k <= go.k) continue; if ([ox[i], oy[i], sx[i], sy[i]].some((v) => v == null || !Number.isFinite(v))) continue; se += (ox[i] - sx[i]) ** 2 + (oy[i] - sy[i]) ** 2; n++; }
      pixel[key] = { n, rmsPx: n ? Math.sqrt(se / n) : null, nrmseDiag: n ? Math.sqrt(se / n) / diag : null, diagPx: diag };
    }
  }
  return { pass: p.pass, worstRatio: worst, pixel, bad: ch.filter(([, c]) => !c.pass).map(([k, c]) => `${k}:${c.maxAbs}/${c.limit}/miss${c.missing}`).slice(0, 6) };
}

export function truth(cell, regime, take) {
  return truthOf(cell.route, cell.params, regime, { variant: cell.variant, ctx: ctxFromTake(take) });
}
