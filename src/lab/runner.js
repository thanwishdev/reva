// Fixture Lab runner (M2 design §12 X5, §13): plans the registered protocol (D-M2-2 Amendment 1, A1.4–A1.6), records
// every cell through the repo recorder (src/record/session.js → src/browser/launch.js, PLAN H1) from the blind lab server,
// checks refsim parity on every take (A1.6 f), snapshots the truth next to the take (private output root, H2), then fits
// the BLIND take set (src/analysis/fit) and scores it against the truth (src/analysis/fit/lab/metrics.js).
// The group-specific glue lives in each group's adapter `fixtures/lab/<group>/lab.mjs` (contract reva.labgroup/0).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { LAB_ROOT, serveLab } from './server.js';
import { ensureOutDir } from '../util/paths.js';
import { mulberry32 } from '../analysis/fit/numeric.js';

/** Regimes (A1.1); R6 is derived from the R2 take (every 2nd row dropped), R1 retired. */
export const REGIMES = { R2: { rate: 60 }, R3: { rate: 120 }, R4: { rate: 30 }, R5: { rate: 60, stall: { every: 30, ms: 100 } } };
export const RECORDED = ['R2', 'R3', 'R4', 'R5'];
export const GROUPS = ['lab-easing', 'lab-springs', 'lab-scroll', 'lab-webgl'];   // A1.4 order (A, B, C, D)
// A1.6 i registered seed 20261015; Amendment 2 C4 (owner-approved 2026-10-15): the gate run draws a fresh set with
// seed 20261016 + index (the 20261015 draws were re-scored during attempt 2 and are kept as development data).
// Owner decision W10 (2026-10-15): attempt 4 draws a FRESH set, seed 20261017 + index, scored once; the 20261016 set
// (scored in attempt 3's gate pass) is development data from then on.
export const DRAW_SEED_A1 = 20261015;
export const DRAW_SEED_A2 = 20261016;
export const DRAW_SEED = 20261017;
export const SERIES = ['rows', 'births', 'declared', 'mutations', 'wheel', 'inputLog', 'elements'];

export async function loadAdapters(names = GROUPS) {
  const out = [];
  for (const n of names) out.push(await import(pathToFileURL(path.join(LAB_ROOT, n, 'lab.mjs')).href));
  return out;
}

const pkey = (p) => crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 10);
export const cellKey = (c) => `${c.group}/${c.route}/${c.cv}/${c.kind === 'draw' ? 'd' + c.drawIndex : 'g' + c.gridIndex}-${pkey(c.params)}/${c.variant}`;

/**
 * The registered protocol: sweep cells (A1.4), the determinism stratum (A1.5: every (route, code variant, trace) at the
 * code variant's default params), the confirmation draws (A1.6 i: one vector per route or code variant, in A1.4 order,
 * mulberry32 seed 20261015 + index, default trace).
 */
export function plan(adapters, { drawSeed = DRAW_SEED } = {}) {
  const cells = []; const stratum = []; const draws = [];
  let drawIndex = 0;
  for (const A of adapters) {
    for (const c of A.cells()) cells.push({ ...c, group: A.name, kind: 'sweep' });
    for (const r of A.routes()) {
      for (const cv of r.codeVariants) {
        for (const v of r.traces) {
          const hit = cells.find((c) => c.group === A.name && c.route === r.id && c.cv === cv.id && c.variant === v && JSON.stringify(c.params) === JSON.stringify(cv.default));
          if (!hit) throw new Error(`${A.name}/${r.id}/${cv.id}/${v}: the code variant's default params are not a grid cell`);
          stratum.push(hit);
        }
        if (r.draw) {
          const i = drawIndex++; const params = A.draw(r.id, cv.id, mulberry32(drawSeed + i));
          draws.push({ group: A.name, route: r.id, cv: cv.id, params, variant: r.traces[0], kind: 'draw', drawIndex: i });
        }
      }
    }
  }
  for (const c of [...cells, ...draws]) c.key = cellKey(c);
  return { cells, stratum, draws };
}

/**
 * A1.4 sweep-size reductions, applied in order when the cost probe projects more than 3 h (decided before any result):
 *  r1 determinism K = 5 at R3 and R5, K = 2 at R2 and R4;
 *  r2 parameter grids 5 → 3 (default + both extremes of the route's primary parameter) for every route outside the
 *     protected set, per code variant whose grid has more than 3 vectors (M02 write variants: the same 3 α values);
 *  r3 traces 3 → 2 for the same unprotected routes, keeping the reversal and idle-gap variants (or, where a route has no
 *     such names, the variants that carry its registered rows; DROP_TRACE below).
 */
export const PROTECTED = new Set(['m07', 'm07x', 'm08', 'm16a', 'm16b', 'm16c', 'm16d', 'm16e', 'm16f', 'm20']);
// Amendment 2 C1 (owner-approved 2026-10-15): r3 does not drop a trace that carries a registered row no other kept trace
// can measure — `speed` stays for M01, M02 and M04 and `sweep` for M11 (slope/range endpoints, map family, pin range,
// hysteresis band edges, declared range ≤ 2 px). DROP_TRACE_A1 is the attempt-1/2 reduction, kept for the record.
export const DROP_TRACE_A1 = { m01: 'speed', m02: 'speed', m03: 'speed', m04: 'speed', m09: 'speed', m09b: 'speed', m11: 'sweep', m13: 'steps', m14: 'steps',
  m05: 'burst', m19: 'click', m10: 'slow' };
export const DROP_TRACE = { m03: 'speed', m09: 'speed', m09b: 'speed', m13: 'steps', m14: 'steps', m05: 'burst', m19: 'click', m10: 'slow' };
export const K_R1 = { R2: 2, R3: 5, R4: 2, R5: 5 };
/**
 * A1.5 escalation: "any stratum failure → K = 5 on every cell of that route". Routes whose stratum failed in an
 * earlier attempt (D-M2-8: M10 frame fast R2, the group B clock-anchor race) need K = 5 at every regime on every cell.
 */
export const ESCALATED = new Set(['m10']);
const primaryKey = (route, grid) => {
  if (route.box) return Object.keys(route.box)[0];
  for (const k of Object.keys(grid[0] || {})) { const v = new Set(grid.map((g) => JSON.stringify(g[k]))); if (v.size > 1 && grid.every((g) => typeof g[k] === 'number')) return k; }
  return null;
};
export function reduce(p, adapters, steps, { dropTrace = DROP_TRACE } = {}) {
  let cells = p.cells;
  if (steps.includes('r2')) {
    const keep = new Set();
    for (const A of adapters) for (const r of A.routes()) {
      for (const cv of r.codeVariants) {
        const grid = cv.grid; let kept = grid;
        if (!PROTECTED.has(r.id) && grid.length > 3) {
          const k = primaryKey(r, grid); const def = JSON.stringify(cv.default);
          const sorted = [...grid].sort((a, b) => a[k] - b[k]);
          const pick = [cv.default, sorted[0], sorted[sorted.length - 1]];
          if (new Set(pick.map((x) => JSON.stringify(x))).size < 3) pick.push(sorted.find((x) => !pick.some((y) => JSON.stringify(y) === JSON.stringify(x))));
          kept = pick; void def;
        }
        for (const g of kept) keep.add(`${A.name}|${r.id}|${JSON.stringify(g)}`);
        // write variants (M02): keep the kept α values
        const alphas = new Set(kept.map((g) => g.alpha));
        for (const c of cells) if (c.group === A.name && c.route === r.id && typeof c.gridIndex === 'string' && c.gridIndex.startsWith('w') && (PROTECTED.has(r.id) || alphas.has(c.params.alpha))) keep.add(`${A.name}|${r.id}|${JSON.stringify(c.params)}`);
      }
    }
    cells = cells.filter((c) => keep.has(`${c.group}|${c.route}|${JSON.stringify(c.params)}`));
  }
  if (steps.includes('r3')) cells = cells.filter((c) => PROTECTED.has(c.route) || dropTrace[c.route] !== c.variant);
  const keys = new Set(cells.map((c) => c.key));
  return { ...p, cells, stratum: p.stratum.filter((c) => keys.has(c.key)), K: steps.includes('r1') ? K_R1 : { R2: 5, R3: 5, R4: 5, R5: 5 }, reductions: steps };
}

/** sha256 of the rows after `boot-done` with k and T taken relative to it (determinism protocol §8.5). */
export function rowsDigest(take) {
  const b = (take.marks || []).find((m) => m.name === 'boot-done'); const k0 = b ? b.k : 0, T0 = b ? b.T : 0;
  const rows = take.data.rows.filter((r) => r.k >= k0).map((r) => ({ ...r, k: r.k - k0, T: Math.round((r.T - T0) * 1e6) / 1e6 }));
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * Record one take of a cell at a regime, run parity on it, snapshot truth (run 0 only), write take + meta.
 * @returns {Promise<object>} meta
 */
export async function recordTake(A, cell, regime, { origin, outRoot, runIndex = 0, write = true }) {
  const { openSession } = await import('../record/session.js');
  const { runActions } = await import('../record/scenario.js');
  const { writeTake } = await import('../record/take.js');
  const R = REGIMES[regime]; const spec = A.sessionSpec(cell);
  const url = `${origin}/${spec.page}${spec.hash}`;
  const t0 = Date.now();
  const s = await openSession({ lane: 'hx', rate: R.rate, stall: R.stall || null, url, engine: spec.engine, args: spec.args, viewport: spec.viewport, seed: spec.seed, scene: spec.scene });
  let take;
  try {
    await s.goto(url); await s.boot(spec.boot || {});
    if (spec.selectors && spec.selectors.length) await s.watch(spec.selectors);
    await runActions(s, spec.actions || []);
    ({ take } = await s.finish({ scenario: 'lab-cell', target: 'lab', write: false }));
  } finally { await s.close(); }
  const meta = { key: cell.key, regime, runIndex, wallMs: Date.now() - t0, frames: take.data.rows.length, digest: rowsDigest(take),
    pageErrors: take.pageErrors.length, inpageErrors: (take.errors || []).length, escapes: Object.keys(take.escapes || {}), settleTimeouts: (take.c && take.c.settleTimeouts) || 0, bootFrames: take.bootFrames };
  if (runIndex === 0) {
    try { meta.parity = A.parity(take, cell); } catch (e) { meta.parity = { pass: false, error: String(e && e.stack || e).slice(0, 400) }; }
  }
  if (write) {
    const dir = path.join(outRoot, 'takes', cell.key, `${regime}-${runIndex}`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    writeTake(take, { root: dir }); meta.dir = dir;
    if (runIndex === 0) {
      const truths = {};
      for (const reg of regime === 'R2' ? ['R2', 'R6'] : [regime]) { try { truths[reg] = A.truth(cell, reg, take); } catch (e) { truths[reg] = { error: String(e && e.stack || e).slice(0, 400) }; } }
      fs.writeFileSync(path.join(dir, 'truth.json'), JSON.stringify(truths));
    }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  }
  return meta;
}

/** A stored take reshaped like the recorder's in-memory take (what the group adapters' parity/truth read). */
export async function rawFromDisk(dir) {
  const { loadTake } = await import('../record/take.js');
  const { take, data } = loadTake(dir, ['rows', 'births', 'declared', 'mutations', 'wheel', 'inputLog', 'elements']);
  const ev = (k) => (take.env && take.env[k] && 'value' in take.env[k] ? take.env[k].value : undefined);
  return { ...take, data: { rows: data.rows, births: data.births, declared: data.declared, mut: data.mutations, wheel: data.wheel }, inputLog: data.inputLog, els: data.elements,
    marks: take.marks, env: { readback: ev('readbackFloor'), innerWidth: (ev('viewport') || {}).width, innerHeight: (ev('viewport') || {}).height }, cfg: { dateEpoch: ev('dateEpochMs') }, context: { viewport: ev('viewport') } };
}

/** Recompute the truth snapshot of a stored run-0 take (after a fixture truth fix; truth is never read by the fitter). */
export async function retruth(A, cell, regime, outRoot) {
  const dir = takeDir(outRoot, cell, regime); const take = await rawFromDisk(dir); const truths = {};
  for (const reg of regime === 'R2' ? ['R2', 'R6'] : [regime]) { try { truths[reg] = A.truth(cell, reg, take); } catch (e) { truths[reg] = { error: String(e && e.stack || e).slice(0, 400) }; } }
  fs.writeFileSync(path.join(dir, 'truth.json'), JSON.stringify(truths));
  return truths;
}

export const takeDir = (outRoot, cell, regime, runIndex = 0) => path.join(outRoot, 'takes', cell.key, `${regime}-${runIndex}`);
export const hasTake = (outRoot, cell, regime, runIndex = 0) => fs.existsSync(path.join(takeDir(outRoot, cell, regime, runIndex), 'meta.json'));
export const readMeta = (outRoot, cell, regime, runIndex = 0) => JSON.parse(fs.readFileSync(path.join(takeDir(outRoot, cell, regime, runIndex), 'meta.json'), 'utf8'));

/** Fit the cell's take sets (A1.2: R3↔R2, R4/R5 → R3 probe, R6 single-take from R2) and score each against truth. */
export async function fitAndScore(cell, outRoot, { idleCell = null, regimes = ['R2', 'R3', 'R4', 'R5', 'R6'] } = {}) {
  const { loadTake } = await import('../record/take.js');
  const { fitCell } = await import('../analysis/fit/lab/runner.js');
  const { scoreCell } = await import('../analysis/fit/lab/metrics.js');
  const takes = {}; const truths = {};
  for (const reg of RECORDED) {
    const d = takeDir(outRoot, cell, reg); if (!fs.existsSync(path.join(d, 'take.json'))) continue;
    takes[reg] = loadTake(d, SERIES);
    Object.assign(truths, JSON.parse(fs.readFileSync(path.join(d, 'truth.json'), 'utf8')));
  }
  const out = [];
  for (const reg of regimes) {
    const base = reg === 'R6' ? 'R2' : reg; if (!takes[base]) continue;
    const set = { ...takes };
    if (idleCell) { const d = takeDir(outRoot, idleCell, base); if (fs.existsSync(path.join(d, 'take.json'))) set.idle = loadTake(d, SERIES); }
    const truth = truths[reg];
    const res = { key: cell.key, group: cell.group, route: cell.route, cv: cell.cv, variant: cell.variant, kind: cell.kind, regime: reg, params: cell.params };
    if (!truth || truth.error) { out.push({ ...res, error: 'truth: ' + (truth ? truth.error : 'missing') }); continue; }
    try {
      const f = fitCell(set, reg);
      const write = cell.params.write || 'full';
      const dtMs = reg === 'R6' ? 1000 / 60 : 1000 / REGIMES[reg].rate;
      // A2-B certificates: the scroll offsets the page saw in this take set (primary at its full page rate — R6 uses the
      // R2 take's every frame — plus the probe take, A1.2)
      const PROBE = { R2: 'R3', R3: 'R2', R4: 'R3', R5: 'R3', R6: null }; const visitedSeq = [];
      for (const r of [base, PROBE[reg]]) if (r && takes[r]) visitedSeq.push(takes[r].data.rows.map((row) => row.sy).filter(Number.isFinite));
      const sc = scoreCell({ fit: f.fit, truth, ctx: { dtMs, write, regime: reg, route: cell.route, variant: cell.variant, visited: [...new Set(visitedSeq.flat())], visitedSeq } });
      out.push({ ...res, fitMs: f.ms, single: f.single, probe: f.probe, ...sc, records: f.fit.records.length });
    } catch (e) { out.push({ ...res, error: 'fit: ' + String(e && e.stack || e).slice(0, 600) }); }
  }
  return out;
}

export { serveLab, ensureOutDir };
