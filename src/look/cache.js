// The session cache of one `reva look` (stability re-take, goal: a second take that is not disturbed by the network).
// The first take of a URL look records the page's responses with Playwright's own HAR recorder (context option
// recordHar: passive, the requests still go to the network exactly as before; mode minimal = only what routing needs;
// a .zip with the bodies as attached entries). The HAR is written when the take's browser closes. The re-take serves
// every request from it (routeFromHAR) and ABORTS anything the first take did not fetch: a replay never reaches the
// network, so it can never fetch more than the first take did, and every guard (robots, the MCP request guard, the local
// sinkhole) keeps holding (nothing new passes them). The aborted requests are counted (stats.misses) and said in look.json.
//
// Scope: one look. The folder is a fresh mkdtemp under the OS temp folder (never under the user's output folder or the
// data root), it is removed when the look ends (success, error, cancel: runLookOnce's finally), and a process exit
// sweeps any that are still registered (a Ctrl-C between the take and the end of the look). Nothing of it is kept.
// An archive needs no cache (it already replays the same bytes offline): cacheWanted is false for it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside } from '../util/paths.js';

export const CACHE_PREFIX = 'reva-look-cache-';
/** The HAR file name inside the cache folder (.zip: bodies stored as attached entries, compressed). */
export const CACHE_HAR = 'take.har.zip';

const live = new Set();
let hooked = false;
function hookExit() {
  if (hooked) return; hooked = true;
  process.on('exit', () => { for (const c of live) { try { fs.rmSync(c.dir, { recursive: true, force: true }); } catch { /* gone */ } } });
}

/**
 * Should this look record a session cache? Only for a URL (an archive replays already) and only when a re-take can run.
 * @param {{kind:string}} src  resolveSource output
 */
export function cacheWanted(src, o = {}) {
  return !!src && src.kind === 'url' && o.retake !== false && !o._retake;
}

/**
 * A fresh cache folder for one look. `forbid`: folders it must never be inside (the user's output folder, the data root):
 * a temp folder configured inside one of them is refused, never used.
 * @returns {{dir:string, har:string, recordHar:object, used:boolean, dispose():void, disposed:boolean}}
 */
export function createSessionCache({ base = os.tmpdir(), forbid = [] } = {}) {
  for (const f of forbid) if (f && isInside(base, f)) throw new Error(`the session cache folder ${base} is inside ${f}; the cache is never kept beside the output`);
  hookExit();
  const dir = fs.mkdtempSync(path.join(base, CACHE_PREFIX));
  const c = {
    dir, har: path.join(dir, CACHE_HAR), used: false, disposed: false,
    // what openSession passes to the browser context (src/record/session.js sessionContext)
    get recordHar() { return { path: c.har, mode: 'minimal', content: 'attach' }; },
    /** Has the first take's browser closed and written the HAR? */
    ready() { try { return fs.statSync(c.har).size > 0; } catch { return false; } },
    dispose() {
      if (c.disposed) return; c.disposed = true;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
      live.delete(c);
    },
  };
  live.add(c);
  return c;
}
/**
 * Run fn(cache) with a cache scoped to it: made when `want` (a cache that cannot be made is null: only the re-take is
 * lost), removed when fn ends, whether it returns or throws.
 */
export async function withSessionCache(want, fn, opts = {}) {
  let cache = null;
  if (want) { try { cache = createSessionCache(opts); } catch { cache = null; } }
  try { return await fn(cache); } finally { if (cache) cache.dispose(); }
}
/** Caches not yet disposed in this process (tests: nothing may stay behind). */
export const openCaches = () => [...live].map((c) => c.dir);

/**
 * Serve the re-take from the cache (browser side; call after every other route of the context is registered, so these
 * two run first: Playwright tries routes newest first). A request the HAR has is fulfilled from it; any other falls back
 * to the counter, which aborts it. Returns the stats object (misses by resource type, first URLs: origin + path only).
 */
export async function wireCacheReplay(ctx, cache) {
  const stats = { served: 'cache', misses: 0, byType: {}, sample: [] };
  await ctx.route('**/*', (route) => {
    const r = route.request(); let t = 'other'; try { t = r.resourceType(); } catch { /* closed */ }
    stats.misses++; stats.byType[t] = (stats.byType[t] || 0) + 1;
    if (stats.sample.length < 5) { let u = r.url(); try { const x = new URL(u); u = x.origin + x.pathname; } catch { /* keep */ } stats.sample.push({ type: t, url: String(u).slice(0, 160) }); }
    return route.abort('blockedbyclient').catch(() => {});
  });
  await ctx.routeFromHAR(cache.har, { notFound: 'fallback' });
  cache.used = true;
  return stats;
}

/** Budget of the stability re-take (wall ms): a hard stop (the browser is closed), and the planned upper bound. */
export const RETAKE_BUDGET_MS = 30000;
export const RETAKE_MAX_MS = 25000;
/** Motions compared by the re-take (the top ones with a fitted record; the re-take fits only their lead channels, with
 *  the first take's fit budgets: a fit depends on its budget, so both runs are fitted alike). */
export const RETAKE_MOTIONS = 5;

/**
 * Run the stability re-take, or why not (pure). `estMs`: the first take's own wall time (launch to record), the re-take's
 * expected cost; `leftMs`: time left before the look's deadline.
 * @returns {{run:true}|{run:false, why:string}}
 */
export function retakePlan({ retake = true, action, after = null, motions = 0, estMs = 0, leftMs = Infinity, cacheReady = true, srcKind = 'url' } = {}) {
  if (retake === false) return { run: false, why: 'turned off (--no-retake)' };
  if (!motions) return { run: false, why: 'no fitted motion to compare' };
  if (after) return { run: false, why: `--do ${action} --after: the click chain is not repeated` };
  if (srcKind === 'url' && !cacheReady) return { run: false, why: 'the first take\'s responses were not recorded' };
  if (estMs > RETAKE_BUDGET_MS) return { run: false, why: `the first take took ${Math.round(estMs / 1000)} s; a second one would add more than ${RETAKE_BUDGET_MS / 1000} s` };
  if (leftMs < Math.max(estMs, 5000) * 1.5 + 15000) return { run: false, why: 'the look is near its time limit' };
  return { run: true };
}
