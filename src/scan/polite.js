// What a scan does to a live site, in one place (AUDIT-plan §5, owner go 3 Nov 2026). One object per scan holds the rules
// for every request REVA sends to the site or the site's page sends through REVA's browser:
//  - pacing: one queue per host shared by the whole scan (preflight, map, both viewports of the freeze, completion). The
//    site's own hosts: 500 ms between requests to a host, or that host's robots Crawl-delay if larger, subresources of a
//    page load included. Main-frame documents: 10 s apart per host (or the Crawl-delay), across viewports too.
//  - other sites' hosts (fonts, CDNs, embeds the page loads): 100 ms between requests to a host, so no host gets more than
//    10 a second from REVA. Their robots.txt is not read for what the page itself loads (a page view, as any browser
//    shows it); a URL REVA fetches on its own initiative (completion) is checked against its host's robots.txt and keeps
//    the full 500 ms gap, as the site's own. A 429 (or 503 with Retry-After) from another site's host: nothing more is
//    sent to that host for the rest of the scan.
//  - robots.txt: every URL of the site's own hosts is checked before it is sent (a disallowed one is aborted and listed);
//    every main-frame navigation, each redirect hop included, through navigationGuard (src/safety/gate.js), which also
//    refuses a navigation that leaves the site, so no click or script can take the live browser elsewhere.
//  - stop rules on every answer, not only the first page (stoprule.js stopVerdict): a 429, a 503 with Retry-After or a
//    challenge page ends all live traffic of the scan; what was captured before is kept and the ledger says why.
//    A login or region wall on an inner page: that page is not recorded, the rest goes on.
//  - every request names REVA: plain fetches send UA (robots.js), the browser sends browserUserAgent (capture.js CLASSES).
import { UA, fetchRobots, robotsVerdict } from '../safety/robots.js';
import { navigationGuard } from '../safety/gate.js';
import { sameSite } from '../util/domain.js';
import { stopVerdict, hostPacer } from './stoprule.js';
import { urlKey } from './map.js';

export const OWN_GAP_MS = 500;
export const OTHER_GAP_MS = 100;
export const NAV_GAP_MS = 10000;
/** Added to every gap: two requests a queue lets go exactly 500 ms apart can reach the server a few ms closer (a new
 *  connection for the first, a warm one for the second): 491-497 ms measured on the wire with no margin, 698 of 710 with 10 ms;
 *  a busy CI runner still landed 674-697 of 700 with 25 ms, so the margin is 60 ms: never below the site's own delay. */
export const WIRE_MARGIN_MS = 60;

/** Thrown by policy.fetch once the site asked REVA to stop: no request is sent. */
export class SiteStopped extends Error {
  constructor(stop) { super(`the site asked REVA to stop: ${stop.why}`); this.stop = stop; this.code = 'site_stopped'; }
}

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };
const keyOf = (u) => { try { return urlKey(u); } catch { return String(u); } };
const isWeb = (u) => /^https?:/i.test(String(u));

/**
 * @param {string} startUrl
 * @param {object} [o]
 * @param {Function} [o.fetchImpl]  the network (test seam)
 * @param {Map<string, string|null|Promise<string|null>>} [o.seed]  robots.txt texts already read (the safety gate's)
 * @param {number} [o.ownGapMs] / [o.otherGapMs] / [o.navGapMs]  the gaps above (tests shorten navGapMs only)
 * @param {(m:string)=>void} [o.log]
 */
export function sitePolicy(startUrl, { fetchImpl = globalThis.fetch, seed = null, ownGapMs = OWN_GAP_MS, otherGapMs = OTHER_GAP_MS, navGapMs = NAV_GAP_MS, now = Date.now, sleep, log = () => {} } = {}) {
  const robots = new Map();      // origin -> Promise<{status, text, unreachable, error?}>
  const delays = new Map();      // host -> Crawl-delay ms for REVA's groups (known once its robots.txt is read)
  const navLast = new Map();     // host -> start of the last main-frame document
  const explicit = new Set();    // URLs REVA asks for on its own (completion): robots-checked and fully paced on any host
  const stats = new Map();       // host -> { own, n, minGapMs, last }
  const S = { stopped: null, robotsBlocked: new Map(), hostsBlocked: new Map(), pageWalls: new Map(), refused: new Map(), docs: new Set() };
  const isOwn = (u) => sameSite(u, startUrl);
  const gapOf = (host, kind) => WIRE_MARGIN_MS + (kind === 'other' ? otherGapMs : Math.max(ownGapMs, delays.get(host) ?? 0));
  const pacer = hostPacer(gapOf, { now, ...(sleep ? { sleep } : {}) });

  const count = (host, own) => {
    const t = now(), s = stats.get(host) || { own, n: 0, minGapMs: null, last: null };
    if (s.last != null) s.minGapMs = s.minGapMs == null ? t - s.last : Math.min(s.minGapMs, t - s.last);
    s.n++; s.last = t; stats.set(host, s);
  };
  /** Wait for this URL's turn on its host (the job is only the permission to send). */
  const pace = (u, { kind } = {}) => {
    const host = hostOf(u), own = isOwn(u);
    const k = kind || (own || explicit.has(u) ? 'own' : 'other');
    return pacer.run(host, () => count(host, own), k);
  };
  /** The plain network with REVA's user agent, paced; no stop rule (robots.txt fetches and the safety gate use it). */
  const pacedFetch = async (u, init = {}) => {
    if (S.stopped) throw new SiteStopped(S.stopped);
    await pace(u, { kind: 'own' });
    if (S.stopped) throw new SiteStopped(S.stopped);
    return fetchImpl(u, { ...init, headers: { ...(init.headers || {}), 'user-agent': UA } });
  };
  const robotsOf = (origin) => {
    if (!robots.has(origin)) {
      robots.set(origin, fetchRobots(origin, { fetchImpl: pacedFetch }).then((r) => {
        const v = robotsVerdict(r.text, [origin + '/']);
        if (v.crawlDelay != null) delays.set(hostOf(origin), v.crawlDelay * 1000);
        return r;
      }));
    }
    return robots.get(origin);
  };
  const seedWith = (texts) => {
    if (!(texts instanceof Map)) return;
    for (const [origin, t] of texts) {
      if (robots.has(origin)) continue;
      robots.set(origin, Promise.resolve(t).then((text) => {
        const v = robotsVerdict(text ?? null, [origin + '/']);
        if (v.crawlDelay != null) delays.set(hostOf(origin), v.crawlDelay * 1000);
        return { status: text == null ? 404 : 200, text: text ?? null, unreachable: false };
      }));
    }
  };
  seedWith(seed);

  /** null when robots.txt of the URL's origin lets REVA fetch it, else {url, agent, rule}. Unreadable robots.txt: not now. */
  const robotsBlock = async (u) => {
    const o = originOf(u); if (!o) return null;
    const r = await robotsOf(o);
    if (r.unreachable) return { url: u, agent: null, rule: `robots.txt of ${o} could not be read (${r.error || 'no answer'})` };
    const v = robotsVerdict(r.text, [u]);
    if (!v.blocked) return null;
    return { url: u, agent: v.star === 'disallow' ? '*' : v.reva === 'disallow' ? 'REVA' : v.anthropicAgent, rule: v.reason };
  };
  const noteRobots = (b) => { if (!S.robotsBlocked.has(b.url)) { S.robotsBlocked.set(b.url, b); log(`not fetched: ${b.agent ? `robots.txt disallows it for ${b.agent}` : b.rule}: ${String(b.url).slice(0, 200)}`); } };

  const stop = (s) => {
    if (S.stopped) return S.stopped;
    S.stopped = { ...s, at: new Date(now()).toISOString() };
    log(`STOP: ${s.why} (${String(s.url || '').slice(0, 200)}); REVA sends nothing more to the site and keeps what it has`);
    return S.stopped;
  };
  const blockHost = (host, why) => { if (!S.hostsBlocked.has(host)) { S.hostsBlocked.set(host, why); log(`${host}: ${why}; REVA sends nothing more to that host`); } };

  /** The rule for one answer. own: a host of the site. document: a main-frame page. Returns the verdict. */
  const judgeAnswer = ({ url, status, headers, body = null, document = false, start = false }) => {
    const v = stopVerdict({ status, headers, body, url, document, start });
    if (v.verdict === 'stop') {
      if (isOwn(url) || document) stop({ why: v.why, url, status, retryAfterMs: v.retryAfterMs ?? null });
      else blockHost(hostOf(url), v.why);
    }
    return v;
  };

  /**
   * The plain fetch of the map and of every other GET REVA sends itself: robots.txt first (a disallowed URL is not sent),
   * the host's turn, REVA's user agent, then the stop rule on the answer. The body is read here (an HTML answer is checked
   * for a challenge), so the result is a fresh Response; `wall` is set when the page is a login or region wall.
   */
  const fetch = async (u, init = {}) => {
    if (S.stopped) throw new SiteStopped(S.stopped);
    const isRobotsFile = (() => { try { return new URL(u).pathname === '/robots.txt'; } catch { return false; } })();
    if (isRobotsFile && originOf(u) && !robots.has(originOf(u))) {
      // read once, through the cache that also gives the host its Crawl-delay; a 429 or 503 on it is still the stop rule's
      const rec = await robotsOf(originOf(u));
      if (rec.status === 429 || rec.status === 503) judgeAnswer({ url: u, status: rec.status, headers: {} });
      if (S.stopped) throw new SiteStopped(S.stopped);
      if (rec.status == null) throw new Error(`robots.txt: ${rec.error || 'no answer'}`);
      const out = new Response(rec.text ?? '', { status: rec.status });
      Object.defineProperty(out, 'url', { value: u });
      return out;
    }
    if (!isRobotsFile) { const b = await robotsBlock(u); if (b) { noteRobots(b); throw Object.assign(new Error(`robots.txt disallows ${u}`), { code: 'blocked_robots' }); } }
    const r = await pacedFetch(u, init);
    const headers = Object.fromEntries(r.headers.entries());
    const text = await r.text();
    const html = /html/i.test(headers['content-type'] || '');
    const v = judgeAnswer({ url: r.url || u, status: r.status, headers, body: html ? text : null, document: html, start: keyOf(u) === keyOf(startUrl) });
    if (S.stopped) throw new SiteStopped(S.stopped);
    const out = new Response(r.status === 204 || r.status === 304 ? null : text, { status: r.status, headers });
    Object.defineProperty(out, 'url', { value: r.url || u });
    if (v.verdict === 'wall') out.wall = v.why;
    return out;
  };

  /**
   * Put the rules on one recording context of the live visit (record.js). Registered before the caller's own routes, so a
   * tracker block or the config's block regex aborts first and never takes a turn in a queue.
   */
  const attach = async (ctx, page, { onLog = log } = {}) => {
    await ctx.route('**/*', async (route) => {
      const req = route.request(), u = req.url();
      if (!isWeb(u)) return route.fallback().catch(() => {});
      if (S.stopped) return route.abort('blockedbyclient').catch(() => {});
      const host = hostOf(u), own = isOwn(u), mine = explicit.has(u);
      if (S.hostsBlocked.has(host)) return route.abort('blockedbyclient').catch(() => {});
      let doc = false; try { doc = req.isNavigationRequest() && !req.frame().parentFrame(); } catch { doc = req.isNavigationRequest?.() ?? false; }
      // robots.txt for the site's own hosts and REVA's own fetches; a main-frame page is the navigation guard's to judge
      if ((own || mine) && !doc) { const b = await robotsBlock(u); if (b) { noteRobots(b); return route.abort('blockedbyclient').catch(() => {}); } }
      if (doc) {
        const gap = Math.max(navGapMs, delays.get(host) ?? 0), wait = (navLast.get(host) ?? -Infinity) + gap - now();
        navLast.set(host, Math.max(now(), (navLast.get(host) ?? -Infinity) + gap));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      await pace(u);
      if (S.stopped) return route.abort('blockedbyclient').catch(() => {});
      if (doc) S.docs.add(keyOf(u));
      return route.fallback().catch(() => {});
    });
    // every answer of the visit, not only the first page's
    ctx.on('response', async (r) => {
      try {
        const req = r.request(), u = r.url(), status = r.status();
        if (status >= 300 && status < 400) return;
        let doc = false; try { doc = req.isNavigationRequest() && !req.frame().parentFrame(); } catch { doc = false; }
        const headers = r.headers();
        const body = doc && /html/i.test(headers['content-type'] || '') ? await r.text().catch(() => null) : null;
        judgeAnswer({ url: u, status, headers, body, document: doc, start: doc && keyOf(u) === keyOf(startUrl) });
      } catch { /* the context closed */ }
    });
    // Playwright routes only the first URL of a redirect chain, and the browser sends a hop as soon as the 3xx arrives: each
    // hop of this page waits its turn here (and is checked against robots.txt; a main-frame hop is the guard's to judge)
    const cdp = await ctx.newCDPSession(page);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const mainId = frameTree?.frame?.id;
    cdp.on('Fetch.requestPaused', async (e) => {
      const go = () => cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
      const fail = () => cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      const u = e.request?.url;
      if (!e.redirectedRequestId || !isWeb(u)) return go();
      if (S.stopped || S.hostsBlocked.has(hostOf(u))) return fail();
      const doc = e.resourceType === 'Document' && e.frameId === mainId;
      if ((isOwn(u) || explicit.has(u)) && !doc) { const b = await robotsBlock(u); if (b) { noteRobots(b); return fail(); } }
      await pace(u);
      return S.stopped ? fail() : go();
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    // no click and no script takes the live page to a disallowed URL or another site
    const guard = navigationGuard(startUrl, { who: 'cli', ownDomains: [], sticky: false, scope: (u) => isOwn(u), log: onLog,
      fetchImpl: async (u) => { const r = await robotsOf(originOf(u)); return new Response(r.text ?? '', { status: r.text != null ? 200 : 404 }); } });
    await guard.attach(page, { onBlock: (b) => { if (!S.refused.has(b.url)) { S.refused.set(b.url, b); onLog(`refused a navigation to ${String(b.url).slice(0, 200)}: ${b.agent === 'scope' ? 'it leaves the site' : `robots.txt disallows it for ${b.agent}`}`); } } });
    return guard;
  };

  /**
   * After page.goto: the stop rule on the page REVA asked for, under the name REVA asked for it (a login wall reached by a
   * redirect is a wall of the requested page). Returns the verdict; a wall marks the page.
   */
  const judgePage = async (requested, resp, { start = false } = {}) => {
    if (!resp) return { verdict: 'ok', why: null };
    const headers = resp.headers(), status = resp.status();
    const body = /html/i.test(headers['content-type'] || '') ? await resp.text().catch(() => null) : null;
    const v = judgeAnswer({ url: resp.url(), status, headers, body, document: true, start });
    if (v.verdict === 'wall') S.pageWalls.set(keyOf(requested), v.why);
    return v;
  };

  return {
    startUrl, isOwn, fetch, pacedFetch, attach, judgePage, seed: seedWith, robotsBlock, stop,
    /** URLs REVA is about to fetch on its own: robots-checked and paced as the site's own, on any host. */
    markExplicit: (urls) => { for (const u of urls) explicit.add(u); },
    get stopped() { return S.stopped; },
    get pageWalls() { return S.pageWalls; },
    get robotsBlocked() { return S.robotsBlocked; },
    get hostsBlocked() { return S.hostsBlocked; },
    get refused() { return S.refused; },
    /** urlKey of every main-frame document the visit sent. */
    get docs() { return S.docs; },
    /** For scan.json: requests per host and the smallest gap seen between two of them. */
    summary() {
      const hosts = [...stats.entries()].map(([host, s]) => ({ host, own: s.own, requests: s.n, minGapMs: s.minGapMs }));
      return { ownGapMs, otherGapMs, navGapMs, crawlDelayMs: Object.fromEntries(delays), hosts, stopped: S.stopped, robotsBlocked: S.robotsBlocked.size, hostsBlocked: Object.fromEntries(S.hostsBlocked), pageWalls: Object.fromEntries(S.pageWalls), refused: S.refused.size };
    },
  };
}
