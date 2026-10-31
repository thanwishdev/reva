// Lab runner (design §13): recordCell → fitCell → scoreCell → report. Reads a lab group's routes.json, refsim.mjs and
// truth.mjs (design §11 contract); the fitter core (../index.js) is called on a BLIND take set and never sees truth.
// Browser use goes only through the repo's recorder (src/record/session.js → src/browser/launch.js, PLAN H1).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fitTakeSet } from '../index.js';
import { scoreCell } from './metrics.js';
import { mulberry32 } from '../numeric.js';

/** Regimes (D-M2-2 Amendment 1, A1.1). R6 is derived from the R2 take; R1 is retired. */
export const REGIMES = {
  R2: { rate: 60 }, R3: { rate: 120 }, R4: { rate: 30 }, R5: { rate: 60, stall: { every: 30, ms: 100 } }, R6: { derivedFrom: 'R2', stride: 2 },
};
/** Probe regime per primary (A1.2): R3 ↔ R2, R4/R5 → R3; R6 single-take. */
export const PROBE_OF = { R2: 'R3', R3: 'R2', R4: 'R3', R5: 'R3', R6: null };

export const encodeParams = (params) => Buffer.from(JSON.stringify(params)).toString('base64url');

/** Load a lab group: routes + refsim + truth modules (lab files are trusted own code). */
export async function loadGroup(groupDir) {
  const routes = JSON.parse(fs.readFileSync(path.join(groupDir, 'routes.json'), 'utf8'));
  const refsim = await import(pathToFileURL(path.join(groupDir, 'refsim.mjs')).href);
  const truth = await import(pathToFileURL(path.join(groupDir, 'truth.mjs')).href);
  const trace = (route, variant) => JSON.parse(fs.readFileSync(path.join(groupDir, route.traces[variant]), 'utf8'));
  return { dir: groupDir, name: path.basename(groupDir), routes, refsim, truth, trace };
}

/** Recorder scenario for one cell (blind URL: params only in the hash, design §11). */
export function scenarioFor(group, route, params, variant, { baseUrl }) {
  const actions = group.trace(route, variant);
  return {
    url: `${baseUrl}/${group.name}/routes/${route.page || route.id + '.html'}#p=${encodeParams(params)}`,
    viewport: { width: 1280, height: 800 },
    scene: { selectors: (route.watch && route.watch.selectors) || [], computedVars: (route.watch && route.watch.computedVars) || [], glUniforms: (route.watch && route.watch.glUniforms) || [], pixelKeys: (route.watch && route.watch.pixelKeys) || [] },
    boot: { until: 'document.readyState === "complete"', thenMs: 400 },
    actions: Array.isArray(actions) ? actions : actions.actions,
  };
}

/**
 * Record one cell in `hx` through the repo recorder and write the take under `outRoot`. `recorder` is injectable
 * (tests use a synthetic recorder; the integrator's X1 adds rate 30 and the stall schedule to openSession).
 * @returns {Promise<string>} take directory
 */
export async function recordCell({ group, route, params, variant, regime, baseUrl, outRoot, recorder, runIndex = 0 }) {
  const R = REGIMES[regime]; if (!R || R.derivedFrom) throw new Error(`regime ${regime} is not recorded (derived or retired)`);
  const spec = scenarioFor(group, route, params, variant, { baseUrl });
  const dir = path.join(outRoot, group.name, route.id, cellKey(params), variant, `${regime}-${runIndex}`);
  fs.mkdirSync(dir, { recursive: true });
  const rec = recorder || defaultRecorder;
  await rec({ spec, lane: 'hx', rate: R.rate, stall: R.stall || null, engine: route.engine || 'chs', root: dir });
  return dir;
}
export const cellKey = (params) => encodeParams(params).slice(0, 48);

async function defaultRecorder({ spec, lane, rate, stall, engine, root }) {
  const { openSession } = await import('../../../record/session.js');
  const { runActions } = await import('../../../record/scenario.js');
  const { writeTake } = await import('../../../record/take.js');
  const s = await openSession({ lane, rate, stall, url: spec.url, engine, viewport: spec.viewport, scene: spec.scene });
  try {
    await s.goto(spec.url); await s.boot(spec.boot);
    if (spec.scene.selectors.length) await s.watch(spec.scene.selectors);
    await runActions(s, spec.actions || []);
    const { take } = await s.finish({ scenario: 'lab-cell', write: false });
    writeTake(take, { root });
  } finally { await s.close(); }
}

/** Load a take for fitting (all series the fitter reads). */
export async function loadForFit(dir) {
  const { loadTake } = await import('../../../record/take.js');
  return loadTake(dir, ['rows', 'births', 'declared', 'mutations', 'wheel', 'inputLog', 'elements']);
}

/** R6: the R2 take with every 2nd row dropped after recording; env unchanged (undeclared stride). */
export function deriveR6(take) { return { ...take, data: { ...take.data, rows: take.data.rows.filter((_, i) => i % 2 === 0) } }; }

/**
 * Fit one cell under the registered take-set protocol (A1.2).
 * @param {{[regime:string]: object}} takes  loaded takes of this cell by regime (R2..R5), plus `idle` when present
 */
export function fitCell(takes, regime, opts = {}) {
  const primary = regime === 'R6' ? deriveR6(takes.R2) : takes[regime];
  if (!primary) throw new Error(`no ${regime} take`);
  const probeReg = PROBE_OF[regime]; const probe = probeReg ? takes[probeReg] : null;
  const t0 = Date.now(); const fit = fitTakeSet({ primary, probe: probe || undefined, idle: takes.idle || undefined }, opts);
  return { fit, ms: Date.now() - t0, regime, probe: probeReg && probe ? probeReg : null, single: !probe };
}

/** Refsim parity on a recorded take (design §11): max |rendered − refsim| per channel vs 2 × read-back floor. */
export function parity(group, route, params, take, floorOf) {
  const rows = take.data.rows; const frames = rows.map((r) => ({ k: r.k, T: r.T, sy: r.sy, sx: r.sx }));
  const sim = group.refsim.simulate(route.id, params, { frames, inputs: take.data.inputLog || [], viewport: { width: 1280, height: 800 } });
  const els = take.data.elements || []; const out = [];
  for (const [key, vals] of Object.entries(sim.channels || {})) {
    const [sel, ch] = key.split('|'); const ids = els.map((d, i) => [d, i]).filter(([d]) => selectorMatchesLoose(sel, d)).map(([, i]) => i);
    let mx = 0, n = 0; for (let i = 0; i < rows.length; i++) { const v = ids.length ? rows[i].v[ids[0]] && rows[i].v[ids[0]][ch] : undefined; const x = typeof v === 'number' ? v : parseFloat(v); if (!Number.isFinite(x) || !Number.isFinite(vals[i])) continue; mx = Math.max(mx, Math.abs(x - vals[i])); n++; }
    const floor = floorOf(ch); out.push({ key, n, maxAbs: mx, floor, pass: n > 0 && mx <= 2 * floor });
  }
  return { ok: out.every((c) => c.pass), channels: out };
}
const selectorMatchesLoose = (sel, d) => !!d && (sel.startsWith('.') ? d.split('.').slice(1).includes(sel.slice(1)) : sel.startsWith('#') ? d.includes('#' + sel.slice(1)) : d.toLowerCase().startsWith(sel.toLowerCase()));

/** Score one fitted cell against truth (runner only). */
export function scoreFitted(group, route, params, regime, fitted, take, variant) {
  const truth = group.truth.truth(route.id, params, regime === 'R6' ? 'R2' : regime, { trace: variant });
  const dtMs = (regime === 'R6' ? 1000 / 60 : 1000 / (REGIMES[regime].rate || 60));
  const res = scoreCell({ fit: fitted.fit, truth, ctx: { dtMs, write: params.write || 'full', regime } });
  return { route: route.id, regime, params, truthClass: route.truthClass, ...res, fitMs: fitted.ms, single: fitted.single, takeDigest: take && take.take && take.take.series && take.take.series.rows && take.take.series.rows.digest };
}

/**
 * Confirmation draws (A1.6 i): one parameter vector per route with a continuous grid, uniform inside the grid's box,
 * mulberry32 seed 20261015 + index in A1.4 order.
 */
export function confirmationDraw(route, index) {
  const rnd = mulberry32(20261015 + index); const grid = route.params.grid || []; const out = { ...route.params.default };
  for (const k of Object.keys(out)) {
    const vals = grid.map((g) => g[k]).filter((v) => typeof v === 'number'); if (vals.length < 2) continue;
    const lo = Math.min(...vals), hi = Math.max(...vals); out[k] = lo + (hi - lo) * rnd();
  }
  return out;
}

/** Digest of a take's rows (determinism protocol §8.5: bit-identical series across K runs). */
export const rowsDigest = (take) => take.take && take.take.series && take.take.series.rows ? take.take.series.rows.digest : null;
