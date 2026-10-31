// robots.txt for the bounded freeze's completion fetch (26 Oct, lead item from L1): the completion pass fetches URLs the
// first recording never requested (render misses, same-site GET site-data misses, typed code literals). On the site's own
// hosts (same registrable domain) each such URL is checked against that host's robots.txt with the agents corpus
// preflight uses (`*`, REVA, the Anthropic crawlers: src/safety/robots.js robotsVerdict) before it is fetched; a disallowed
// URL is not fetched and is logged as not-fetched:robots. The project never bypasses robots. Same parser and same
// fetch rule as preflight: one robots.txt per origin, a missing or unreadable robots.txt allows everything.
import { UA, robotsVerdict, readRobotsBody } from '../safety/robots.js';
import { sameSite } from '../util/domain.js';

/** origin -> Promise<robots.txt text | null>, cached (one fetch per origin per freeze). */
export function robotsFetcher({ fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const cache = new Map();
  return (origin) => {
    if (!cache.has(origin)) cache.set(origin, (async () => {
      try {
        const r = await fetchImpl(origin + '/robots.txt', { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
        return r.status >= 200 && r.status < 300 ? await readRobotsBody(r) : null;
      } catch { return null; }
    })());
    return cache.get(origin);
  };
}

/**
 * Split completion candidates into the ones robots.txt allows and the ones it disallows. Only URLs on the site's own hosts
 * are checked (third-party hosts are not the site; they keep their old handling).
 * @param {{url:string, origin?:string}[]} cands
 * @param {{siteUrl:string, robotsText?:(origin:string)=>Promise<string|null>}} o
 * @returns {Promise<{allowed:object[], disallowed:{url:string, origin?:string, reason:string, agent:string|null}[]}>}
 */
export async function robotsFilter(cands, { siteUrl, robotsText = robotsFetcher() } = {}) {
  const allowed = [], disallowed = [];
  for (const c of cands) {
    let o = null;
    try { o = new URL(c.url).origin; } catch { /* not a URL: left to the fetch, which logs the error */ }
    if (!o || !siteUrl || !sameSite(c.url, siteUrl)) { allowed.push(c); continue; }
    const v = robotsVerdict(await robotsText(o), [c.url]);
    if (!v.blocked) { allowed.push(c); continue; }
    const agent = v.star === 'disallow' ? '*' : v.reva === 'disallow' ? 'REVA' : v.anthropicAgent;
    disallowed.push({ url: c.url, origin: c.origin, reason: 'not-fetched:robots', agent });
  }
  return { allowed, disallowed };
}
