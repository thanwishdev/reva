// Test/dev harness for the lab-easing group: a blind static server, take recording through the repo's recorder, and the
// refsim parity comparison. Lives outside the pages: the pages never see it. Browsers only through src/record/session.js
// (the repo's launcher, H1).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession } from '../../../../src/record/session.js';
import { runActions } from '../../../../src/record/scenario.js';
import { encodeParams } from '../core.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
/** Paths the blind server refuses: truth, refsim, routes, traces and the tooling (design section 11). */
export const FORBIDDEN = ['truth/', 'truth.mjs', 'refsim.mjs', 'routes.json', 'traces/', 'test/', 'tools/', 'README.md'];

/** Blind static server for this group's folder. Returns {origin, close()}. */
export function serveLab() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || FORBIDDEN.some((f) => rel === f || rel.startsWith(f)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ origin: `http://localhost:${port}`, port, close: () => new Promise((r) => server.close(r)) });
  }));
}

export const loadRoutes = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'routes.json'), 'utf8'));
export const loadTrace = (route, variant) => JSON.parse(fs.readFileSync(path.join(ROOT, 'traces', `${route}.${variant}.json`), 'utf8'));

/** Record one hx take of (route, params, trace variant) at `rate` Hz (120, 60, 30; `stall` = the R5 schedule, recorder X1). */
export async function recordCell({ origin, route, params, variant, rate = 120, engine = 'chs', lane = 'hx', stall = false }) {
  return recordCellInner({ origin, route, params, variant, rate, engine, lane, stall: stall ? { every: 30, ms: 100 } : null });
}

async function recordCellInner({ origin, route, params, variant, rate, engine, lane, stall }) {
  const routes = loadRoutes();
  const r = routes.routes.find((x) => x.id === route);
  const spec = loadTrace(route, variant);
  const url = `${origin}/${r.page}#p=${encodeParams(params)}`;
  const s = await openSession({ lane, rate, stall, url, engine, viewport: spec.viewport, seed: spec.seed, scene: { computedVars: r.watch.computedVars || [] } });
  try {
    await s.goto(url);
    await s.boot(spec.boot || {});
    await s.watch(r.watch.selectors);
    await runActions(s, spec.actions);
    const { take } = await s.finish({ scenario: `${route}.${variant}`, target: 'lab-easing', write: false });
    return take;
  } finally { await s.close(); }
}

/** elId for a selector such as '#b0' from the take's element descriptors (TAG#id.class). */
export function elementIndex(take) {
  const m = new Map();
  (take.els || []).forEach((d, i) => { const g = /#([A-Za-z0-9_-]+)/.exec(d || ''); if (g && !m.has('#' + g[1])) m.set('#' + g[1], i); });
  return m;
}

/** Read-back floor of a channel (design section 11): from the take's planted-value measurement (D3). */
export function channelFloor(ch, readback, registeredNumber = 5e-7) {
  const rb = (k) => (readback && readback[k] ? readback[k].maxAbsErr : null);
  if (ch.startsWith('drv:')) return 0;
  if (ch === 'ren:tx' || ch === 'ren:ty') return rb('translateX(px)');
  if (ch === 'ren:sx' || ch === 'ren:sy') return rb('scale');
  if (ch === 'ren:rz') return rb('rotate(deg)');
  if (ch === 'ren:opacity') return rb('opacity');
  if (/^ren:b[xywh]$/.test(ch)) return 1 / 64;
  if (ch.startsWith('ren:--')) return registeredNumber;   // registered number: serialised with 6 significant digits; unregistered is verbatim (see CUSTOM_EXACT)
  return null;
}
/** Unregistered custom properties read back verbatim (planted-value floor 0). */
export const CUSTOM_EXACT = new Set(['ren:--v', 'ren:--c', 'ren:--n', 'ren:--st']);

/**
 * Compare refsim channels with a take. Returns {ok, channels: [{key, n, maxAbs, floor, tol, at}]}.
 * A channel passes when max |rendered - refsim| <= max(2 * floor, 1e-9).
 */
/**
 * First frame a comparison covers. macOS: every row (0), as before. Elsewhere: the boot-done frame on, like lab-scroll's
 * parity (which starts after boot-done everywhere). Before that mark the page is still loading in real time: on a slower
 * machine (a CI runner, an emulated x64 under load) frame k=2 can be sampled before the stylesheet applies (measured
 * 31 Oct 2026 on linux-x64: m11.gap opacity read 1 at k=2 where the start value is 0.15; boot-done was k=4 in every run).
 */
export function compareFromK(take) {
  if (process.platform === 'darwin') return 0;
  return ((take.marks || []).find((m) => m.name === 'boot-done') || { k: 0 }).k;
}

export function compareToTake(take, sim, { registeredNumber = 5e-7, fromK = compareFromK(take) } = {}) {
  const idx = elementIndex(take);
  const rows = take.data.rows;
  const out = [];
  for (const [key, series] of Object.entries(sim.channels)) {
    const [sel, ch] = key.split('|');
    const id = idx.get(sel);
    if (id == null) { out.push({ key, error: 'element not found in take' }); continue; }
    let maxAbs = 0, at = -1, n = 0, missing = 0;
    for (let j = 0; j < rows.length; j++) {
      if (rows[j].k < fromK) continue;
      const v = rows[j].v && rows[j].v[id];
      if (!v) continue;
      const got = v[ch];
      const want = series[j];
      if (got == null || want == null) { missing++; continue; }
      n++;
      const d = Math.abs(got - want);
      if (d > maxAbs) { maxAbs = d; at = j; }
    }
    let floor = CUSTOM_EXACT.has(ch) ? 0 : channelFloor(ch, take.env && take.env.readback, registeredNumber);
    out.push({ key, n, missing, maxAbs, floor, tol: Math.max(2 * (floor ?? 0), 1e-9), at, k: at >= 0 ? rows[at].k : null, ok: n > 0 && floor != null && maxAbs <= Math.max(2 * floor, 1e-9) });
  }
  return { ok: out.length > 0 && out.every((c) => c.ok), channels: out };
}
