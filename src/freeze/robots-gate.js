// robots.txt for the bounded freeze's completion fetch (26 Oct, lead item from L1): the completion pass fetches URLs the
// first recording never requested (render misses, same-site GET site-data misses, typed code literals). On the site's own
// hosts (same registrable domain) each such URL is checked against that host's robots.txt with the agents corpus
// preflight uses (`*`, REVA, the Anthropic crawlers: src/safety/robots.js robotsVerdict) before it is fetched; a disallowed
// URL is not fetched and is logged as not-fetched:robots. The project never bypasses robots. Same parser and same
// fetch rule as preflight: one robots.txt per origin, a missing or unreadable robots.txt allows everything.
import { robotsVerdict, fetchRobots } from '../safety/robots.js';
import { sameSite } from '../util/domain.js';

/** origin -> Promise<{status, text, unreachable, error?}> (fetchRobots), cached (one fetch per origin per freeze). */
export function robotsFetcher({ fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const cache = new Map();
  return (origin) => {
    if (!cache.has(origin)) cache.set(origin, fetchRobots(origin, { fetchImpl, timeoutMs }));
    return cache.get(origin);
  };
}

/**
 * Split completion candidates into the ones robots.txt allows and the ones it disallows. Only URLs on the site's own hosts
 * are checked (third-party hosts are not the site; they keep their old handling).
 * @param {{url:string, origin?:string}[]} cands
 * @param {{siteUrl:string, robotsText?:(origin:string)=>Promise<string|null|{text:string|null, unreachable?:boolean}>}} o
 * @returns {Promise<{allowed:object[], disallowed:{url:string, origin?:string, reason:string, agent:string|null}[]}>}
 */
export async function robotsFilter(cands, { siteUrl, robotsText = robotsFetcher() } = {}) {
  const allowed = [], disallowed = [];
  for (const c of cands) {
    let o = null;
    try { o = new URL(c.url).origin; } catch { /* not a URL: left to the fetch, which logs the error */ }
    if (!o || !siteUrl || !sameSite(c.url, siteUrl)) { allowed.push(c); continue; }
    const r = await robotsText(o);
    const rec = r && typeof r === 'object' ? r : { text: r ?? null, unreachable: false }; // a plain text|null (older callers) still works
    if (rec.unreachable) { disallowed.push({ url: c.url, origin: c.origin, reason: 'not-fetched:robots-unreachable', agent: 'robots-unreachable' }); continue; }
    const v = robotsVerdict(rec.text, [c.url]);
    if (!v.blocked) { allowed.push(c); continue; }
    const agent = v.star === 'disallow' ? '*' : v.reva === 'disallow' ? 'REVA' : v.anthropicAgent;
    disallowed.push({ url: c.url, origin: c.origin, reason: 'not-fetched:robots', agent });
  }
  return { allowed, disallowed };
}
