// robots.txt for the bounded freeze's completion fetch (26 Oct, lead item from L1): the completion pass fetches URLs the
// first recording never requested (render misses, same-site GET site-data misses, typed code literals). On the site's own
// hosts (same registrable domain) each such URL is checked against that host's robots.txt with the agents corpus
// preflight uses (`*`, REVA, the Anthropic crawlers: src/safety/robots.js robotsVerdict) before it is fetched; a disallowed
// URL is not fetched and is logged as not-fetched:robots. The project never bypasses robots. Same parser and same
// fetch rule as preflight: one robots.txt per origin, a missing or unreadable robots.txt allows everything.
import { robotsVerdict, fetchRobots, unreachableWhy } from '../safety/robots.js';
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
 * @param {{siteUrl:string, robotsText?:(origin:string)=>Promise<string|null|{text:string|null, unreachable?:boolean}>, allHosts?:boolean}} o
 *   allHosts: check another site's URL against that site's robots.txt too (reva scan: every host REVA fetches on its own)
 * @returns {Promise<{allowed:object[], disallowed:{url:string, origin?:string, reason:string, agent:string|null}[]}>}
 */
export async function robotsFilter(cands, { siteUrl, robotsText = robotsFetcher(), allHosts = false } = {}) {
  const allowed = [], disallowed = [];
  for (const c of cands) {
    let o = null;
    try { o = new URL(c.url).origin; } catch { /* not a URL: left to the fetch, which logs the error */ }
    if (!o || !siteUrl || (!allHosts && !sameSite(c.url, siteUrl))) { allowed.push(c); continue; }
    const r = await robotsText(o);
    const rec = r && typeof r === 'object' ? r : { text: r ?? null, unreachable: false }; // a plain text|null (older callers) still works
    // robots.txt answered 5xx / 429 or not at all: not a disallow (no agent), a "try again later"; the error says which
    if (rec.unreachable) { disallowed.push({ url: c.url, origin: c.origin, reason: 'not-fetched:robots-unreachable', agent: null, robotsOrigin: o, error: rec.error || null }); continue; }
    const v = robotsVerdict(rec.text, [c.url]);
    if (!v.blocked) { allowed.push(c); continue; }
    const agent = v.star === 'disallow' ? '*' : v.reva === 'disallow' ? 'REVA' : v.anthropicAgent;
    disallowed.push({ url: c.url, origin: c.origin, reason: 'not-fetched:robots', agent });
  }
  return { allowed, disallowed };
}

/** The log line of one URL robotsFilter kept from the completion fetch, in plain words. */
export function notFetchedText(d) {
  const u = String(d.url).slice(0, 200);
  if (d.reason === 'not-fetched:robots-unreachable') return `completion: not fetched (robots.txt of ${d.robotsOrigin || d.origin || 'the host'} could not be read (${unreachableWhy(d.error)}); try again later): ${u}`;
  return `completion: not fetched (robots.txt disallows ${d.agent || 'REVA'}): ${u}`;
}
