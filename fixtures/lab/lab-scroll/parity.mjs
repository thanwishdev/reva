// Fixture Lab, group C: the parity proof (design section 11).
// For route x params x trace x regime: record an `hx` take through the recorder, run refsim on the take's own frames and
// inputs, and compare every simulated channel with what the browser read back. Pass <=> max |rendered - refsim| is within
// 2 x the channel's read-back floor (bbox channels: 1/64 px, so 1/32). Takes and the report go to the private output root.
//   node fixtures/lab/lab-scroll/parity.mjs [--routes m01,m02] [--variants speed,gap] [--regimes R2,R3] [--grid default|all] [--out DIR]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openSession } from '../../../src/record/session.js';
import { runActions } from '../../../src/record/scenario.js';
import { writeTake } from '../../../src/record/take.js';
import { privateRoot } from '../../../src/util/paths.js';
import { serveGroup } from './serve.mjs';
import { scenarioSpec, pageHash, planFrames, routesFile, REGIMES } from './plan.mjs';
import { simulate, ctxFromTake, defaultsOf } from './refsim.mjs';

// R2 / R3 are recorded today. R4 (30 Hz) is recorded here with the same grid formula once RATES knows 30 (design X1: the
// integrator adds it; until then this file adds the entry to the in-memory table of THIS process only, no shared file is edited).
// R5 (stall schedule) needs the recorder change itself and is not available here.
export const RECORDED_RATES = { R2: 60, R3: 120, R4: 30, R5: 60 };   // R4/R5 via recorder X1 (rate 30, stall schedule)

/** tolerance (absolute) per channel kind, from the take's measured read-back floor */
export function toleranceFor(channel, floor) {
  const f = (name) => (floor && floor[name] ? floor[name].maxAbsErr : 0);
  if (channel === 'sy') return 1e-9;   // window scroll position: the browser keeps integer offsets, refsim rounds the same way
  if (/^drv:|^ren:--/.test(channel)) return 1e-9;
  if (/^ren:(tx|ty)$/.test(channel)) return Math.max(2 * f('translateX(px)'), 1e-6);
  if (/^ren:(sx|sy)$/.test(channel)) return Math.max(2 * f('scale'), 1e-9);
  if (channel === 'ren:opacity') return Math.max(2 * f('opacity'), 1e-9);
  if (/^ren:(bx|by|bw|bh)$/.test(channel)) return 2 / 64;
  throw new Error('no tolerance rule for channel ' + channel);
}

function elementIndex(els) {
  // selector -> element id, for the simple selectors the lab uses (#id, .class)
  return (sel) => {
    const rx = sel.startsWith('#') ? new RegExp('#' + sel.slice(1) + '(?![\\w-])') : new RegExp('\\.' + sel.slice(1) + '(?![\\w-])');
    const ids = els.map((d, i) => (rx.test(String(d)) ? i : -1)).filter(i => i >= 0);
    return ids.length === 1 ? ids[0] : null;
  };
}

export function compareTake(raw, routeId, params, { fromK } = {}) {
  const data = { rows: raw.data.rows, inputLog: raw.inputLog, wheel: raw.data.wheel };
  const ctx = ctxFromTake({ take: raw, data });
  const sim = simulate(routeId, params, ctx);
  const find = elementIndex(raw.els || []);
  const floor = raw.env && raw.env.readback;
  const start = fromK ?? (raw.marks.find(m => m.name === 'boot-done') || { k: 0 }).k + 1;
  const channels = {};
  let worst = 0, ok = true;
  for (const [name, series] of Object.entries(sim.channels)) {
    const [sel, ch] = name.split('|');
    const tol = toleranceFor(sel === 'window' ? 'sy' : ch, floor);
    let max = 0, n = 0, firstBad = null, missing = 0;
    for (let i = 0; i < ctx.frames.length; i++) {
      const row = raw.data.rows[i]; if (row.k < start) continue;
      let got;
      if (sel === 'window') got = row.sy;
      else { const id = find(sel); got = id == null ? undefined : (row.v[id] || {})[ch]; }
      if (typeof got !== 'number') { missing++; continue; }
      const d = Math.abs(got - series[i]); n++;
      if (d > max) max = d;
      if (d > tol && firstBad == null) firstBad = { k: row.k, got, want: series[i] };
    }
    const pass = n > 0 && max <= tol && missing === 0;
    channels[name] = { n, max, tol, pass, missing, firstBad };
    if (!pass) ok = false;
    worst = Math.max(worst, tol ? max / tol : 0);
  }
  // events: the page-side wheel log (defaultPrevented) against refsim
  let eventsOk = true; const eventDiffs = [];
  const pageWheel = raw.data.wheel || [];
  sim.events.filter(e => e.type === 'wheel').forEach((e, i) => {
    const pw = pageWheel[i];
    if (pw && typeof pw.prevented === 'boolean' && pw.prevented !== e.prevented) { eventsOk = false; eventDiffs.push({ i, k: e.k, sim: e.prevented, page: pw.prevented }); }
    if (pw && pw.k !== e.k) { eventsOk = false; eventDiffs.push({ i, simK: e.k, pageK: pw.k }); }
  });
  return { ok: ok && eventsOk, worstRatio: worst, channels, events: { n: sim.events.length, ok: eventsOk, diffs: eventDiffs }, frames: ctx.frames.length, start };
}

/** Record one cell (route x params x variant x regime) and write the take to `outDir`. */
export async function recordCell({ routeId, params, variant, regime, origin, outDir, write = true }) {
  const route = routesFile().routes.find(r => r.id === routeId);
  const spec = scenarioSpec(routeId, variant, route);
  const full = { ...defaultsOf(routeId), ...params };
  const s = await openSession({ lane: 'hx', rate: RECORDED_RATES[regime], stall: REGIMES[regime].stall, engine: route.engine, url: origin + '/' + route.page + pageHash(params), viewport: spec.viewport, seed: spec.seed, scene: spec.scene });
  try {
    await s.goto(); await s.boot(spec.boot);
    await s.watch(spec.scene.selectors);
    await runActions(s, spec.actions);
    const { take } = await s.finish({ scenario: `${routeId}.${variant}.${regime}`, target: 'lab-scroll', write: false, extra: { lab: 'lab-scroll', route: routeId, variant, regime, params: full } });
    take.dirOut = write ? writeTake(take, { root: path.join(outDir, `${routeId}.${variant}.${regime}.${paramTag(params)}`) }) : null;
    return take;
  } finally { await s.close(); }
}
const paramTag = (p) => Object.entries(p).map(([k, v]) => `${k}${v}`).join('_') || 'default';

export async function runParity({ routes, variants, regimes = ['R2', 'R3'], grid = 'default', outDir, log = console.log } = {}) {
  const file = routesFile();
  const srv = await serveGroup();
  const results = [];
  try {
    for (const r of file.routes) {
      if (routes && !routes.includes(r.id)) continue;
      const plist = grid === 'all' ? r.params.grid : [r.params.default];
      const cellsOf = [];
      for (const variant of Object.keys(r.traces)) {
        if (variants && !variants.includes(variant)) continue;
        for (const params of plist) cellsOf.push([params, variant]);
      }
      // write-quantisation variants (A1.4: trace 1 only) join the full-grid run
      if (grid === 'all' && r.params.writeVariants && (!variants || variants.includes(r.params.writeVariantTrace))) for (const params of r.params.writeVariants) cellsOf.push([params, r.params.writeVariantTrace]);
      for (const [params, variant] of cellsOf) {
        for (const regime of regimes) {
          const t0 = Date.now();
          const raw = await recordCell({ routeId: r.id, params, variant, regime, origin: srv.origin, outDir });
          const cmp = compareTake(raw, r.id, params);
          // plan check: the frames a trace plans are the frames the recorder produced (T always, sy for scroll-driven routes)
          const boot = raw.marks.find(m => m.name === 'boot-done').k;
          const plan = planFrames(scenarioSpec(r.id, variant, r).actions, regime, { routeId: r.id, k0: boot });
          const planned = new Map(plan.frames.map(f => [f.k, f]));
          let tDiff = 0, syDiff = 0, cnt = 0;
          for (const row of raw.data.rows) { const f = planned.get(row.k); if (!f || row.k <= boot) continue; cnt++; tDiff = Math.max(tDiff, Math.abs(f.T - row.T)); if (r.driver === 'scroll') syDiff = Math.max(syDiff, Math.abs(f.sy - row.sy)); }
          const planOk = tDiff < 1e-4 && (r.driver !== 'scroll' || syDiff === 0) && cnt > 0;
          const rec = { route: r.id, variant, regime, params, ok: cmp.ok && planOk, worstRatio: cmp.worstRatio, planOk, tDiff, syDiff, frames: raw.data.rows.length, wallMs: Date.now() - t0, channels: cmp.channels, events: cmp.events, take: raw.dirOut, pageErrors: raw.pageErrors, escapes: Object.keys(raw.escapes || {}) };
          results.push(rec);
          log(`${rec.ok ? 'PASS' : 'FAIL'} ${r.id} ${variant} ${regime} ${JSON.stringify(params)} frames=${rec.frames} worst=${cmp.worstRatio.toExponential(2)}x-tol plan=${planOk} ${rec.wallMs}ms${cmp.ok ? '' : ' ' + failSummary(cmp)}`);
        }
      }
    }
  } finally { await srv.close(); }
  const report = { schema: 'reva.labparity/0', group: 'lab-scroll', at: new Date().toISOString(), host: os.hostname(), cells: results.length, passed: results.filter(r => r.ok).length, results };
  if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1)); }
  return report;
}
const failSummary = (cmp) => Object.entries(cmp.channels).filter(([, c]) => !c.pass).slice(0, 4).map(([n, c]) => `${n}:max=${c.max.toExponential(2)}/tol=${c.tol.toExponential(1)}/miss=${c.missing}@${c.firstBad ? c.firstBad.k : '-'}`).join(' ') + (cmp.events.ok ? '' : ' events:' + JSON.stringify(cmp.events.diffs.slice(0, 3)));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
  const list = (v) => (v ? v.split(',') : undefined);
  const outDir = arg('out', path.join(privateRoot(), 'out', 'm2', 'parity', 'lab-scroll'));
  const report = await runParity({ routes: list(arg('routes')), variants: list(arg('variants')), regimes: list(arg('regimes', 'R2,R3')), grid: arg('grid', 'default'), outDir });
  console.log(`parity: ${report.passed}/${report.cells} cells pass -> ${path.join(outDir, 'report.json')}`);
  process.exit(report.passed === report.cells ? 0 : 1);
}
