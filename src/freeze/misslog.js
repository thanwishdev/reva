// Replay wiring with a miss logger (PLAN M4 freeze, SYN §7.4 trap 4: "misses are silent").
// Playwright runs the most recently registered route first, so registration order is the reverse of execution order:
//   BLOCK abort  ->  HAR (class)  ->  HAR (union)  ->  catch-all that LOGS and aborts.
// Together with a browser started with every host name unresolvable, nothing can reach the network unseen:
// a request the archive cannot answer ends in the catch-all and is recorded here, even if the page swallows the failure.
import crypto from 'node:crypto';
import { blockTrackers } from './trackers.js';
import { installFuzzyFallback } from './fuzzy.js';

/**
 * @param {import('playwright-core').BrowserContext} ctx
 * @param {{hars:string[], block?:RegExp|null}} o  hars: least specific first (the union), most specific last
 * @returns {Promise<{misses:object[], blocked:string[]}>}
 */
export async function installMissLogger(ctx, { hars, block = null, trackers = true, fuzzy = true, ownUrl = null }) {
  const net = { misses: [], blocked: [], trackers: [], fuzzy: [] };
  const t0 = Date.now();
  await ctx.route('**/*', route => {
    const r = route.request();
    const post = r.postDataBuffer();
    net.misses.push({
      method: r.method(), url: r.url(), resourceType: r.resourceType(), navigation: r.isNavigationRequest(),
      frame: (() => { try { return r.frame().url(); } catch { return null; } })(),
      postSha256: post ? crypto.createHash('sha256').update(post).digest('hex') : undefined, tMs: Date.now() - t0,
    });
    route.abort('internetdisconnected');
  });
  if (fuzzy) net.fuzzy = await installFuzzyFallback(ctx, hars); // answers volatile-URL variants of archived entries, logged in net.fuzzy
  for (const h of hars) await ctx.routeFromHAR(h, { notFound: 'fallback' });
  if (trackers) await blockTrackers(ctx, net.trackers, { ownUrl }); // pure analytics beacons: aborted and logged, never a miss (F21)
  if (block) await ctx.route(block, r => { net.blocked.push(r.request().url()); r.abort(); });
  return net;
}

/** A miss is SILENT when the page raised no error about it: the page code swallowed the failure, a naive harness would pass. */
export function classifyMisses(misses, pageErrors) {
  return { total: misses.length, silent: pageErrors.length === 0 ? misses.length : 0, withPageError: pageErrors.length === 0 ? 0 : misses.length };
}
