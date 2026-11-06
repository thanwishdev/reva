// The safety gate of the public commands (reva look, MCP look), REVA-PRODUCT §4.2 / §4.3: before a live page opens,
// read robots.txt of the page and of every redirect hop, and fetch the page once (preflight.js). Stop when a robots.txt
// disallows it (unless the person says the site is theirs: --ignore-robots typed on the CLI, or the domain listed in
// ownDomains of <data root>/config.json; the MCP has no override flag) or when the page is a bot, login or region wall; REVA never
// gets around those. The cookie banner's reject buttons found here are clicked in the page later (clickRejectInPage).
import { preflight, sameSite } from './preflight.js';
import { UA, PRODUCT_TOKEN, robotsVerdict, readRobotsBody, robotsUnreachableText } from './robots.js';
import { readOwnDomains, isOwnDomain, ownDomainsFile } from './own-domains.js';

const userError = (code, message) => Object.assign(new Error(message), { code });

/** The agent a robots.txt verdict names: '*' when the group for everyone disallows, else REVA's own token, else the Anthropic crawler. */
const verdictAgent = (v) => (v.star === 'disallow' ? '*' : v.reva === 'disallow' ? PRODUCT_TOKEN : v.anthropicAgent || null);

const WALL_WORD = { wall: 'bot wall', login: 'login wall', geo: 'region block', paywall: 'paywall' };

/**
 * @param {string} url
 * @param {object} [o]
 * @param {boolean} [o.ignoreRobots]  the person typed --ignore-robots: lifts a robots.txt refusal for the typed site only
 *   (same host, www. or subdomains), never for another host a redirect leads to
 * @param {string[]} [o.ownDomains]  domains the person listed as their own (default: ownDomains in <data root>/config.json);
 *   a robots.txt refusal on them is lifted. This is the ONLY override the MCP has: an agent cannot lift a refusal itself.
 * @param {'cli'|'mcp'} [o.who]  who reads the refusal (names the override that person can use)
 * @param {Function} [o.preflightImpl]  test seam, same contract as preflight()
 * @param {Function} [o.fetchImpl]  the fetch preflight uses (the MCP passes hopCheckedFetch so no redirect reaches a private address)
 * @param {(m:string)=>void} [o.log]
 * @returns {Promise<{verdict, reason, http, robots:{blocked, ignored, rule, agent}, wall, consent:{cmp, clicks, clicked:string[]}}>}
 */
export async function safetyGate(url, { ignoreRobots = false, ownDomains, who = 'cli', preflightImpl = preflight, fetchImpl, log = () => {} } = {}) {
  const own = ownDomains ?? readOwnDomains();
  const configFile = ownDomainsFile() || '~/.reva/config.json';
  const overridden = (u) => isOwnDomain(u, own) || (who !== 'mcp' && !!ignoreRobots && sameSite(u, url));
  const p = await preflightImpl(url, { ignoreRobots: overridden, ...(fetchImpl ? { fetchImpl } : {}) });
  const rb = p.robots || {};
  const blockedUrl = rb.url || url;
  let origin = blockedUrl; try { origin = new URL(blockedUrl).origin; } catch { /* invalid: preflight said so */ }
  const s = {
    verdict: p.verdict, reason: p.reason || null, http: p.http ?? null,
    robots: { blocked: !!rb.blocked, ignored: !!(rb.blocked && (rb.ignored ?? overridden(blockedUrl))), rule: rb.reason || null, agent: verdictAgent(rb), found: p.robotsText != null, ...(blockedUrl !== url ? { url: blockedUrl } : {}) },
    wall: p.wall || null,
    consent: { cmp: (p.consent && p.consent.cmp) || null, clicks: (p.consent && p.consent.clicks) || [], clicked: [] },
  };
  if (p.robotsTexts instanceof Map) Object.defineProperty(s, 'robotsTexts', { value: p.robotsTexts, enumerable: false });
  if (p.verdict === 'blocked:robots') {
    const via = blockedUrl !== url ? ` (${url} redirects there)` : '';
    const lift = who === 'mcp'
      ? `If the site is the user's own, the user can add its domain to "ownDomains" in ${configFile}; an agent cannot lift this refusal.`
      : ignoreRobots && !sameSite(blockedUrl, url)
        ? `--ignore-robots covers only ${new URL(url).hostname}, not the host the redirect leads to. If that site is yours too, add its domain to "ownDomains" in ${configFile}.`
        : `If the site is yours, run again with --ignore-robots, or add its domain to "ownDomains" in ${configFile}.`;
    throw userError('blocked_robots', `${origin}/robots.txt disallows ${blockedUrl}${via} for ${s.robots.agent === '*' ? 'all robots (User-agent: *)' : s.robots.agent}. REVA respects robots.txt and did not open the page. ${lift}`);
  }
  // robots.txt answered 5xx / 429 or not at all: not a wall and not a refusal, a "try again later" (transient)
  if (p.verdict === 'blocked:robots-unreachable') {
    const ru = p.robotsUnreachable || {};
    throw userError('robots_unreachable', robotsUnreachableText(ru.origin || origin, ru.error || (p.robotsFetch && p.robotsFetch.error)));
  }
  if (String(p.verdict).startsWith('blocked:')) {
    const kind = (p.wall && p.wall.kind) || p.verdict.slice(8);
    throw userError('blocked_wall', `${url} is behind a ${WALL_WORD[kind] || kind} (${(p.wall && p.wall.marker) || p.reason}). REVA does not get around bot, login or region walls, so it did not open the page.`);
  }
  // PR-06: the page answered 429 with no challenge: the site asked to slow down, so REVA does not open it now
  if (p.verdict === 'failed:rate-limited') {
    const wait = Number.isFinite(p.retryAfterMs) ? ` (it asked to wait ${Math.round(p.retryAfterMs / 1000)} s)` : '';
    throw userError('rate_limited', `${url} answered HTTP 429, too many requests${wait}. REVA did not open the page; try again later.`);
  }
  if (s.robots.ignored) log(`robots.txt disallows ${blockedUrl}; opening it anyway because ${isOwnDomain(blockedUrl, own) ? `its domain is in "ownDomains" (${configFile})` : 'of --ignore-robots'}`);
  if (String(p.verdict).startsWith('failed:')) log(`preflight could not fetch the page (${p.verdict}${p.reason ? ' ' + p.reason : ''}); robots.txt ${s.robots.found ? 'allows it' : 'not found'}; the browser will try`);
  return s;
}

/**
 * robots.txt for every main-frame navigation once the browser is open. The gate checks the typed URL and its HTTP redirect
 * hops before the browser starts; a page can still send the browser on with a meta refresh, a script setting location, a
 * form or a link an action clicks, or open a popup. `attach(page)` checks every main-frame document request of the
 * analysed page against robots.txt before it is sent, each redirect hop included (a context route for the first URL, a
 * CDP Fetch interception for every hop), and aborts a disallowed one; it also checks the committed URL of every
 * main-frame navigation. No popup loads a web page (its navigation is aborted and the popup closed); the analysis of the
 * page goes on. The first refusal of the analysed page itself calls onBlock (the caller
 * closes its browser) and is kept: `error()` is a blocked_robots error worded like the gate's; `settle()` waits for the
 * checks still running (a navigation the browser committed just before the caller finished). The overrides are the
 * gate's: ownDomains, and on the CLI --ignore-robots for the typed site only. One robots.txt fetch per origin, starting
 * from the texts the gate already read (safety.robotsTexts).
 * @param {string} typedUrl
 * @param {object} [o]  ignoreRobots, ownDomains, who: as safetyGate; fetchImpl: the robots.txt fetch (the MCP passes
 *   hopCheckedFetch); seed: Map origin -> robots text; log. attach(page, {onBlock}): onBlock(b) closes that browser
 * @param {boolean} [o.sticky]  true (look): after the first refusal every later navigation of the page is refused too, as the
 *   caller closes its browser. false (reva scan's live visit): each navigation is judged on its own, the visit goes on
 * @param {(url:string)=>boolean} [o.scope]  reva scan: a navigation outside it (another site) is refused as well (agent 'scope')
 */
export function navigationGuard(typedUrl, { ignoreRobots = false, ownDomains, who = 'cli', fetchImpl = globalThis.fetch, seed, log = () => {}, sticky = true, scope = null } = {}) {
  const own = ownDomains ?? readOwnDomains();
  const configFile = ownDomainsFile() || '~/.reva/config.json';
  const overridden = (u) => isOwnDomain(u, own) || (who !== 'mcp' && !!ignoreRobots && sameSite(u, typedUrl));
  const texts = new Map(seed instanceof Map ? seed : []);
  const verdicts = new Map(); const noted = new Set();
  const mainKeys = new Set();   // URLs checked for the analysed page itself (a popup's refusal never stops the analysis)
  let blocked = null;
  const robotsFor = async (o) => {
    if (!texts.has(o)) {
      texts.set(o, (async () => {
        try {
          const r = await fetchImpl(o + '/robots.txt', { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
          return r.status >= 200 && r.status < 300 ? await readRobotsBody(r) : null;
        } catch { return null; }
      })());
    }
    return texts.get(o);
  };
  /** null when the URL may be opened, else {url, origin, agent, rule}. Only http(s) is checked (about:, data:, error pages are not fetched from a site). */
  const check = (u, { popup = false } = {}) => {
    let url; try { url = new URL(u); } catch { return Promise.resolve(null); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return Promise.resolve(null);
    const key = url.href.split('#')[0];
    if (!popup) mainKeys.add(key);
    if (!verdicts.has(key)) {
      verdicts.set(key, (async () => {
        if (scope && !scope(key)) return { url: key, origin: url.origin, agent: 'scope', rule: 'outside the site being scanned' };
        const v = robotsVerdict(await robotsFor(url.origin), [key]);
        if (!v.blocked) return null;
        if (overridden(key)) {
          if (!noted.has(url.origin)) { noted.add(url.origin); log(`robots.txt disallows ${key}; the page went there and REVA follows because ${isOwnDomain(key, own) ? `its domain is in "ownDomains" (${configFile})` : 'of --ignore-robots'}`); }
          return null;
        }
        return { url: key, origin: url.origin, agent: verdictAgent(v), rule: v.reason };
      })());
    }
    return verdicts.get(key);
  };
  const block = (b, onBlock) => { if (!b) return; if (!blocked) blocked = b; try { onBlock(b); } catch { /* the caller's close */ } };
  const contexts = new WeakSet();
  const attach = async (page, { onBlock = () => {} } = {}) => {
    const isMain = (fr) => { try { return !!fr && fr.parentFrame() === null; } catch { return false; } };
    const ctx = page.context();
    // A popup (window.open, a target=_blank link an action clicks) is another page of the same browser. REVA analyses
    // one page and never measures a popup, and the redirect hops of a popup's navigation cannot be checked before they
    // are sent, so no popup loads a web page: its http(s) navigation is aborted before it is sent and the popup closed.
    const popupBlocked = (p, url) => {
      let shown = String(url); try { const x = new URL(url); shown = x.origin + x.pathname; } catch { /* keep */ }
      if (!noted.has('popup ' + shown)) { noted.add('popup ' + shown); log(`the page opened a popup to ${shown.slice(0, 200)}; REVA analyses one page and did not load it`); }
      if (p) p.close().catch(() => {});
    };
    const isWeb = (u) => /^https?:/i.test(String(u));
    if (!contexts.has(ctx)) {
      contexts.add(ctx);
      // context-level route: it sees the navigation requests of every page, popups included (page.route does not);
      // registered after the MCP's request guard, so an allowed request falls through to it
      await ctx.route('**/*', async (route) => {
        const req = route.request();
        let nav = false; try { nav = req.isNavigationRequest(); } catch { nav = false; }
        if (!nav) return route.fallback();
        // a popup's first navigation can be sent before its frame exists (req.frame() throws): it is a popup's
        let fr = null; try { fr = req.frame(); } catch { fr = null; }
        if (fr && !isMain(fr)) return route.fallback();
        let p = null; try { p = fr ? fr.page() : null; } catch { p = null; }
        if (p !== page) {
          if (!isWeb(req.url())) return route.fallback();
          popupBlocked(p, req.url());
          return route.abort('blockedbyclient').catch(() => {});
        }
        const b = (sticky && blocked) || await check(req.url()).catch(() => null);
        if (b) { block(b, onBlock); return route.abort('blockedbyclient').catch(() => {}); }
        return route.fallback();
      });
      // a popup that commits a web page anyway is closed
      const watch = (p) => { p.on('framenavigated', (fr) => { if (isMain(fr) && isWeb(fr.url())) popupBlocked(p, fr.url()); }); };
      ctx.on('page', (p) => { if (p !== page) watch(p); });
      for (const p of ctx.pages()) if (p !== page) watch(p);
    }
    // Every redirect hop of the analysed page's main frame (a link, a form, a script setting location, a meta refresh,
    // each answered with 3xx): Playwright routes only the FIRST url of a redirect chain, so a CDP Fetch interception of
    // document requests checks each hop before the browser sends it, and aborts a disallowed one.
    const cdp = await ctx.newCDPSession(page);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const mainId = frameTree && frameTree.frame && frameTree.frame.id;
    cdp.on('Fetch.requestPaused', async (e) => {
      const go = () => cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
      if (mainId && e.frameId && e.frameId !== mainId) return go();
      const b = (sticky && blocked) || await check(e.request && e.request.url).catch(() => null);
      if (!b) return go();
      block(b, onBlock);
      return cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    page.on('framenavigated', (fr) => { if (isMain(fr) && fr === page.mainFrame()) check(fr.url()).then((b) => block(b, onBlock), () => {}); });
  };
  const error = () => {
    if (!blocked) return null;
    const lift = who === 'mcp'
      ? `If the site is the user's own, the user can add its domain to "ownDomains" in ${configFile}; an agent cannot lift this refusal.`
      : ignoreRobots && !sameSite(blocked.url, typedUrl)
        ? `--ignore-robots covers only ${new URL(typedUrl).hostname}, not the host the page sent the browser to. If that site is yours too, add its domain to "ownDomains" in ${configFile}.`
        : `If the site is yours, run again with --ignore-robots, or add its domain to "ownDomains" in ${configFile}.`;
    return userError('blocked_robots', `${blocked.origin}/robots.txt disallows ${blocked.url} (${typedUrl} sent the browser there after it loaded) for ${blocked.agent === '*' ? 'all robots (User-agent: *)' : blocked.agent}. REVA respects robots.txt and stopped. ${lift}`);
  };
  const settle = async () => {
    for (const [k, p] of [...verdicts]) { if (!mainKeys.has(k)) continue; const b = await p.catch(() => null); if (b && !blocked) blocked = b; }
    return blocked;
  };
  return { attach, check, settle, error, get blocked() { return blocked; } };
}

/**
 * A fetch that follows redirects itself and runs `check(url)` (throws to refuse) before EVERY hop, so the preflight of
 * the MCP never requests a private / local address a public page redirects to (the browser itself goes through the
 * MCP guard proxy). Residual: the fetch resolves the host again after the check (DNS rebinding); it only sends a GET.
 */
export function hopCheckedFetch(check, fetchImpl = globalThis.fetch, maxHops = 5) {
  return async (url, init = {}) => {
    let u = String(url);
    // a caller that follows redirects itself (preflight, to check robots.txt per hop) gets one checked hop per call
    if (init.redirect === 'manual') { await check(u); return fetchImpl(u, init); }
    for (let i = 0; i <= maxHops; i++) {
      await check(u);
      const r = await fetchImpl(u, { ...init, redirect: 'manual' });
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      if (!loc) return r;
      try { await r.body?.cancel(); } catch { /* already closed */ }
      u = new URL(loc, u).href;
    }
    throw new Error(`more than ${maxHops} redirects`);
  };
}
