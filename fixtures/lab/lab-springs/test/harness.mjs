// Test harness for group B: a blind static server (refuses truth/refsim/routes/traces like the real lab server will),
// a one-cell recorder on the repo's own launcher, and the refsim parity computation. Browser: only src/browser/launch.js.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession } from '../../../../src/record/session.js';
import { runActions } from '../../../../src/record/scenario.js';
import { writeTake } from '../../../../src/record/take.js';
import { outRoot } from '../../../../src/util/paths.js';
import { cellParams, cellUrl, ctxFromRows } from '../cell.mjs';
import { simulate, CHANNELS } from '../refsim.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const REFUSED = [/^\/truth(\/|\.mjs)/, /^\/refsim\.mjs/, /^\/routes\.json/, /^\/traces\//, /^\/test\//, /^\/cell\.mjs/, /^\/gen/];

export function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (REFUSED.some(r => r.test(u.pathname))) { res.writeHead(403); res.end('refused'); return; }
    const file = path.join(ROOT, u.pathname === '/' ? 'routes/m07.html' : u.pathname.slice(1));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ origin: `http://localhost:${port}`, close: () => new Promise(r => server.close(r)) });
  }));
}

export const loadJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
export const routes = () => loadJson('routes.json');

/** Record one cell on the repo launcher. Returns {take (raw), url}. */
export async function recordCell(origin, route, params, trace, { rate = 120, engine = 'chs', seed = 1 } = {}) {
  const merged = cellParams(params, trace);
  const url = cellUrl(origin, route, params, trace);
  const s = await openSession({ lane: 'hx', rate, url, engine, viewport: trace.viewport || { width: 1280, height: 800 }, seed, scene: trace.scene || {} });
  try {
    await s.goto(url);
    await s.boot(trace.boot || {});
    if (trace.scene && trace.scene.selectors) await s.watch(trace.scene.selectors);
    await runActions(s, trace.actions);
    const { take } = await s.finish({ scenario: `lab-springs-${route.id}-${trace.id}`, target: 'lab-springs', write: false });
    return { take, merged, url };
  } finally { await s.close(); }
}

export const ctxFromTake = (take) => ctxFromRows(take.data.rows, take.els);

/** Max |rendered - refsim| per channel, per-channel read-back floors and the 2x-floor verdict (design 11 parity proof). */
export function parity(route, merged, take) {
  const { elId, anchorIndex, ctx } = ctxFromTake(take);
  const sim = simulate(route.id, merged, { ...ctx, trace: { page: { sched: merged.sched } } });
  const fl = take.env.readback || {};
  const floorOf = { 'drv:--x': fl['--var(unregistered)'], 'ren:--x': fl['--var(unregistered)'], 'ren:tx': fl['translateX(px)'] };
  const res = {};
  for (const ch of CHANNELS) {
    const ref = sim.channels[`.b0|${ch}`]; let mx = 0, at = -1, n = 0;
    for (let i = anchorIndex; i < ctx.frames.length; i++) {
      const got = take.data.rows[i].v[elId] && take.data.rows[i].v[elId][ch];
      if (typeof got !== 'number') continue;
      const e = Math.abs(got - ref[i]); n++; if (e > mx) { mx = e; at = i; }
    }
    const floor = floorOf[ch] ? floorOf[ch].maxAbsErr : null;
    res[ch] = { maxAbs: mx, n, atFrame: at, floor, limit: floor == null ? null : Math.max(2 * floor, 1e-9), pass: floor != null && mx <= Math.max(2 * floor, 1e-9) };
  }
  return { anchorIndex, anchorT: ctx.frames[anchorIndex].T, frames: ctx.frames.length, channels: res, events: sim.events.length, pass: Object.values(res).every(r => r.pass) };
}

export const parityDir = () => path.join(outRoot(), 'm2', 'parity', 'lab-springs');
export function saveTake(take, name) {
  const dir = path.join(parityDir(), 'takes', name);
  fs.mkdirSync(dir, { recursive: true });
  return writeTake(take, { root: dir });
}

/**
 * Blindness probe (design 2): what the fitter would receive from a lab take (rows, element descriptors, births, declared
 * snapshots, mutation stamps, input log, wheel log, watch list, env without the scenario/url strings) must not contain the
 * route id, a parameter name or a string parameter value. Returns the tokens that leaked.
 */
export function leaks(take, route, merged, traceId) {
  const hay = JSON.stringify({ rows: take.data.rows, els: take.els, births: take.data.births, declared: take.data.declared, mut: take.data.mut,
    inputLog: take.inputLog, wheel: take.data.wheel, watch: take.watch, escapes: take.escapes });
  const tokens = new Set([route.id, traceId]);
  for (const [k, v] of Object.entries(merged)) { tokens.add(`"${k}":`); if (typeof v === 'string') tokens.add(`"${v}"`); }
  tokens.delete('"full"');   // the write mode appears nowhere in the data, but "full" is too generic a word to prove anything
  return [...tokens].filter(t => hay.includes(t));
}
