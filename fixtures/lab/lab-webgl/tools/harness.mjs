// Isolated test harness for group D: record one lab cell with the repo's own recorder and compare it with refsim.
// The integrator's lab runner (src/analysis/fit/lab, src/lab/server.js) replaces the recording side; the comparison
// (parity) logic here is what each builder hands over (design §11 "parity proof").
import fs from 'node:fs';
import path from 'node:path';
import { openSession } from '../../../../src/record/session.js';
import { runActions } from '../../../../src/record/scenario.js';
import { startServer, LAB_ROOT } from '../serve.mjs';
import { encodeParams, parseParams, VIEWPORT } from '../core.js';
import { simulate } from '../refsim.mjs';

export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
export const routesJson = () => readJson(path.join(LAB_ROOT, 'routes.json'));
export const loadTrace = (route, variant) => readJson(path.join(LAB_ROOT, 'traces', `${route}.${variant}.json`));

/** Session scene options for a route: watched selectors, GL uniform tap, pixel channel (X4 via scene.init + probe). */
export function sceneFor(route) {
  const w = route.watch || {};
  const scene = { computedVars: w.computedVars || [], glUniforms: w.glUniforms || [] };
  if (w.pixelKeys) scene.pixelKeys = w.pixelKeys;   // X4 wired in the recorder (src/record/pixel.js): rows carry row.pix
  return scene;
}

/** Record one cell. rate: 120 | 60 (the rates the recorder has today). Returns the raw take (nothing written). */
export async function recordCell({ route, params, variant, rate = 120, server, extra = {} }) {
  const trace = loadTrace(route.id, variant);
  const own = !server;
  const srv = server || await startServer();
  try {
    const url = `${srv.origin}/${route.page}#p=${encodeParams(params || {})}`;
    const s = await openSession({
      lane: 'hx', rate, url, engine: route.engine || 'chs', args: route.launchArgs || [], viewport: trace.viewport || VIEWPORT,
      scene: sceneFor(route), seed: 1, ...extra,
    });
    try {
      await s.goto(); await s.boot(trace.boot || {});
      if (route.watch && route.watch.selectors) await s.watch(route.watch.selectors);
      await runActions(s, trace.actions);
      const { take } = await s.finish({ scenario: `${route.id}.${variant}`, write: false });
      return take;
    } finally { await s.close(); }
  } finally { if (own) await srv.close(); }
}

export const ctxFromTake = (take) => ({
  frames: take.data.rows.map((r) => ({ k: r.k, T: r.T, sy: r.sy, sx: r.sx })),
  inputs: take.inputLog, marks: take.marks, dateEpoch: take.cfg.dateEpoch,
});

/** One observed series from a take: "<selector>|<channel>" (drv:/ren:), "gl:<uniform>", "pix:<key>:x|y|n". */
export function observed(take, key) {
  const rows = take.data.rows;
  // recorder rows key uniforms by program: 'p<id>|<name>', a scalar or a vector (WebGL light, 21 Oct 2026)
  if (key.startsWith('gl:')) { const nm = key.slice(3); return rows.map((r) => { if (!r.gl) return null; const k = Object.keys(r.gl).find((x) => x === nm || x.endsWith('|' + nm)); if (k == null) return null; const v = r.gl[k]; return Array.isArray(v) ? v[0] : v; }); }
  if (key.startsWith('pix:')) return rows.map((r) => (r.pix ? r.pix[key] : r.probe ? r.probe[key] : null));
  const [sel, ch] = key.split('|');
  const cls = sel.slice(1);
  const id = take.els.findIndex((d) => d && d.split('.').slice(1).includes(cls));
  return rows.map((r) => (id >= 0 && r.v[id] && ch in r.v[id] ? r.v[id][ch] : null));
}

/** Read-back floor of a channel kind for this take (D3), with the parity multiplier 2 applied by the caller. */
export function floorOf(take, key) {
  const rb = (take.env && take.env.readback) || {};
  const e = (n) => (rb[n] ? rb[n].maxAbsErr : 0);
  if (key.startsWith('gl:')) return 1e-12;
  if (key.startsWith('pix:')) return key.endsWith(':n') ? 0 : PIXEL_FLOOR_PX;
  const ch = key.split('|')[1];
  if (ch.startsWith('drv:')) return Math.max(e('--var(unregistered)'), 1e-12);
  if (ch === 'ren:tx' || ch === 'ren:ty') return Math.max(e('translateX(px)'), 1e-9);
  if (ch === 'ren:opacity') return Math.max(e('opacity'), 1e-9);
  return 1 / 64;
}
/**
 * Pixel-channel floor: the quantisation floor of the colour-keyed centroid (anti-aliased disc, threshold 110).
 * Measured over 32 GL + canvas-2D takes (14 grid vectors, both rates; 2 markers x 2 axes, ~650 frames each, SwiftShader):
 * mean +-0.02, sd 0.05, max 0.160 px. Declared floor 0.2 px; test/parity.test.js asserts the max stays <= this value.
 */
export const PIXEL_FLOOR_PX = 0.2;

/** Parity of every simulated channel against the take. Rows after the start signal only. */
export function parity(take, routeId, params, { skip = () => false } = {}) {
  const ctx = ctxFromTake(take);
  const sim = simulate(routeId, params, ctx);
  const go = take.marks.find((m) => m.name === 'go');
  const res = {};
  for (const [key, series] of Object.entries(sim.channels)) {
    if (skip(key)) continue;
    const obs = observed(take, key);
    let max = 0, n = 0, bad = 0, firstBad = null;
    for (let i = 0; i < series.length; i++) {
      if (take.data.rows[i].k <= go.k) continue;
      const a = obs[i], b = series[i];
      if (b == null && a == null) continue;
      if (a == null || b == null || typeof a === 'string') { bad++; if (firstBad == null) firstBad = { i, k: take.data.rows[i].k, obs: a, sim: b }; continue; }
      const d = Math.abs(a - b); n++;
      if (d > max) max = d;
      if (d > 2 * floorOf(take, key) && firstBad == null) firstBad = { i, k: take.data.rows[i].k, obs: a, sim: b };
    }
    const floor = floorOf(take, key);
    res[key] = { n, maxAbs: max, floor, limit: 2 * floor, missing: bad, pass: bad === 0 && max <= 2 * floor, firstBad };
  }
  return { channels: res, events: sim.events, pass: Object.values(res).every((r) => r.pass) };
}

export const gridParams = (route) => route.params.grid;
export { parseParams };

/**
 * Blindness check on a recorded take (design §2 "blind view" unit test, fixture side): the fields a fitter may read
 * (element descriptors, births, declared snapshots, channel names, uniform names) must not contain the route id, a
 * parameter name or a string parameter value. URL, scenario, marks and `extra` are NOT searched: the fitter's blind
 * view strips them (take.env.docUrl and take.net.url carry the route and the #p= parameters).
 */
export function blindLeaks(take, route, params) {
  const rows = take.data.rows;
  const chan = new Set();
  for (const r of rows) { for (const v of Object.values(r.v)) for (const k of Object.keys(v)) chan.add(k); if (r.gl) for (const k of Object.keys(r.gl)) chan.add(k.replace(/^p\d+\|/, '')); }
  const hay = JSON.stringify({ els: take.els, births: take.data.births, declared: take.data.declared, chan: [...chan], watch: take.watch });
  const standard = new Set(['opacity']);               // a real CSS channel, not a leak
  const needles = [route.id, ...Object.keys(parseParams(route.id, params)).filter((k) => k.length >= 3 && !standard.has(k)),
    ...Object.values(params).filter((v) => typeof v === 'string' && v.length >= 3)];
  return needles.filter((n) => new RegExp(`(^|[^A-Za-z0-9])${n}([^A-Za-z0-9]|$)`).test(hay));
}
