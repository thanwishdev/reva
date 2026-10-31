// Bounded freeze policy (corpus C-REVIEW §3, C-PLAN-v2-CHECK §6 S1): which URLs are worth a completion fetch, which
// misses count against completeness, and how complete an archive is. Pure functions, no browser.
import { sameSite } from '../util/domain.js';

/** Hosts and paths that are telemetry: logged, never chased, never counted as a render miss. */
export const TELEMETRY_RE = /(^|\.)(google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.[a-z.]+|syndication\.twitter\.com|ads-twitter\.com|t\.co|analytics\.twitter\.com|linkedin\.com|licdn\.com|clarity\.ms|bing\.com|line\.me|q\.stripe\.com|m\.stripe\.com|r\.stripe\.com|m\.stripe\.network|facebook\.com|facebook\.net|connect\.facebook\.net|hotjar\.com|hotjar\.io|segment\.io|segment\.com|sentry\.io|newrelic\.com|nr-data\.net|tiktok\.com|analytics\.tiktok\.com|snapchat\.com|pinterest\.com|ct\.pinterest\.com|criteo\.com|criteo\.net|taboola\.com|outbrain\.com|amplitude\.com|mixpanel\.com|heapanalytics\.com|fullstory\.com|quantserve\.com|scorecardresearch\.com|demdex\.net|omtrdc\.net|adsrvr\.org|yandex\.ru|mc\.yandex\.ru|onetrust\.com|cookielaw\.org|cookiebot\.com|usercentrics\.eu|intercom\.io|hubspot\.com|hs-analytics\.net|hs-scripts\.com|klaviyo\.com|datadoghq-browser-agent\.com|browser-intake-datadoghq\.com|vercel-insights\.com|plausible\.io|decibelinsight\.net|dreamdata\.cloud|amazon-adsystem\.com)$/i;
const TELEMETRY_PATH = /\/(collect|beacon|ping|track|pixel|analytics|events?|log|rum|insights?|player-stats|ga\/\d+|sync\/batch)(\/|\?|$)/i;

/** Resource types a page renders from (Playwright resourceType). */
const RENDER_TYPES = new Set(['document', 'stylesheet', 'script', 'font', 'image', 'media', 'texttrack', 'manifest']);
/** File types worth fetching when only the URL is known (a code literal, an untyped fetch/xhr miss). */
const RENDER_EXT = /\.(css|m?js|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mov|m4v|mp3|m4a|ogg|oga|wav|aac|flac|vtt|json|glb|gltf|bin|ktx2?|basis|hdr|exr|drc|wasm|riv|lottie|usdz|obj|fbx|atlas|fnt|xml)$/i;

// 26 Oct (S2): the path rule (/events, /log, /track ...) no longer applies on the site's own hosts: there /events or /log can
// be the site's own data (an events listing, a changelog feed). On the site's own hosts only a collector host (first label
// collect, events, rum ...) keeps the path rule, plus the exact beacon endpoints of SITE_BEACON (platform conventions,
// not words). Third-party hosts keep the path rule: there it only reclassifies tolerated api / non-GET misses and the
// tracking pixels and tag scripts served from /collect, /track (stored evidence, 234 local archives: 24 such misses,
// e.g. www.google.com/rmkt/collect images, *.cls.tencentcs.com/track, would otherwise fail the freeze as render misses).
// Without a siteUrl nothing is the site's own (the old rule, used by callers that do not know the site).
export const COLLECTOR_LABELS = new Set(['collect', 'collector', 'telemetry', 'analytics', 'stats', 'metrics', 'events', 'log', 'logs', 'rum', 'beacon', 'pixel', 'track', 'tracking', 'insights']);
const collectorHost = h => TELEMETRY_RE.test(h) || COLLECTOR_LABELS.has(String(h).toLowerCase().split('.')[0]);
// Same-site beacon endpoints by exact path: Cloudflare RUM, the GA first-party proxy / tag gateway (any prefix), Shopify's
// monorail analytics, CSP violation reports.
const SITE_BEACON = /\/(cdn-cgi\/rum|g\/collect|ccm\/collect|\.well-known\/shopify\/monorail|csp[-_]?reports?)(\/|\?|$)/i;
// Sentry's tunnel route (Next.js default /monitoring, ?o=<org id>&p=<project id>): an error envelope, never page data.
const sentryTunnel = u => /\/monitoring\/?$/.test(u.pathname) && /^\d+$/.test(u.searchParams.get('o') || '') && /^\d+$/.test(u.searchParams.get('p') || '');

const PATH_EXEMPT_TYPES = new Set(['document', 'script', 'font', 'stylesheet', 'media']);

/** @param {string} url @param {{siteUrl?:string|null, resourceType?:string|null}} [opts] the page being archived (its own hosts lose the path rule) */
export function isTelemetry(url, { siteUrl = null, resourceType = null } = {}) {
  let u; try { u = new URL(url); } catch { return false; }
  if (TELEMETRY_RE.test(u.hostname)) return true;
  if (RENDER_EXT.test(u.pathname)) return false; // /events/hero.jpg is an asset
  if (SITE_BEACON.test(u.pathname) || sentryTunnel(u)) return true;
  // F6: the path rule comes after the resource type: a document, script, stylesheet, font or media file is what the page renders
  // from, never telemetry by its path (an event-widget iframe at /event/..., a script at /track/...). Image stays on the path
  // rule: tracking pixels are images served from /collect, /track (S2 comment above; www.google.com/rmkt/collect)
  if (resourceType && PATH_EXEMPT_TYPES.has(resourceType)) return false;
  return TELEMETRY_PATH.test(u.pathname) && (collectorHost(u.hostname) || !sameSite(url, siteUrl));
}

/** Resource types that only send (navigator.sendBeacon / <a ping>, CSP violation reports): telemetry whatever the method. */
const SEND_ONLY_TYPES = new Set(['ping', 'beacon', 'csp_report', 'cspviolationreport']);

/**
 * Kind of a URL for the completion and the miss log: 'render' (worth fetching / counts against completeness),
 * 'site-data' (the site's own api / JSON / GraphQL or non-GET request: relevant, a replay miss of it fails the check),
 * 'telemetry', 'non-GET' / 'api' (a third-party endpoint: logged, not chased), 'other' (data:, blob: ...).
 * 26 Oct (S2): a same-site api or non-GET miss is data the page shows (prices, lists, a form's fields), so it is
 * relevant again; before, every api / non-GET miss was tolerated. Same site = registrable domain of opts.siteUrl
 * (the freeze startUrl); without a siteUrl nothing is same-site (the old behaviour).
 * @param {{url:string, method?:string, resourceType?:string}} r
 * @param {{siteUrl?:string|null}} [opts]
 */
export function kindOf({ url, method = 'GET', resourceType = null }, { siteUrl = null } = {}) {
  if (!/^https?:/i.test(url)) return 'other';
  if (isTelemetry(url, { siteUrl, resourceType })) return 'telemetry'; // a beacon is telemetry whatever its method (a POST to /collect is not an archive hole)
  if (resourceType && SEND_ONLY_TYPES.has(resourceType)) return 'telemetry'; // before the method check: a POST beacon is telemetry
  const own = sameSite(url, siteUrl);
  if (method !== 'GET') return own ? 'site-data' : 'non-GET';
  if (resourceType === 'eventsource' || resourceType === 'websocket') return 'telemetry';
  let p; try { p = new URL(url).pathname; } catch { return 'other'; }
  if (resourceType && RENDER_TYPES.has(resourceType)) return 'render';
  if (RENDER_EXT.test(p)) return 'render';
  return own ? 'site-data' : 'api';
}

/** A same-site data URL whose body depends on request headers a plain completion fetch() does not send (Next.js RSC
 *  `?_rsc=`: the payload follows the Next-Router-State-Tree header). Fetching it by URL would archive a different body
 *  (the HTML page) under that URL, so it is not fetched: it stays a logged site-data miss. */
const HEADER_DEPENDENT = /[?&]_rsc=/;

/** A miss kind the replay check fails on (render-relevant or the site's own data). */
export const isRelevantKind = k => k === 'render' || k === 'site-data';

/**
 * Completion candidates in policy order: (a) render-relevant replay misses (measured), then (b) typed code literals.
 * Capped at maxUrls; the rest go to the miss log as not-fetched:budget.
 * @param {{misses:object[], literals:object[], have:Set<string>, maxUrls:number}} o literals: {url, ...provenance}
 * @returns {{picked:Array<{url:string, origin:string}>, notFetched:Array<{url:string, origin:string, reason:string}>, dropped:{[kind:string]:number}}}
 */
export function rankCandidates({ misses = [], literals = [], have = new Set(), maxUrls = 200, origin = null, siteUrl = null }) {
  // Literals the page itself needs come before third-party ones when the cap cuts the list (corpus F10: a payment widget's 480
  // icon URLs crowded out the site's own web fonts, which then showed up as replay misses). Stable within a class.
  const own = c => { try { return origin && new URL(c.url).origin === origin ? 0 : 1; } catch { return 1; } };
  const sorted = origin ? literals.map((c, i) => [own(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]) : literals;
  const seen = new Set(have), all = [], dropped = {};
  const add = (url, origin, kind, extra = {}) => {
    if (seen.has(url)) return; seen.add(url);
    // a same-site GET data miss (site-data, GET) is fetched like a render miss (own host: the crawl-delay gap of record.js
    // applies); a same-site non-GET cannot be fetched by URL alone and stays in the log
    if (kind === 'site-data' && extra.method === 'GET' && HEADER_DEPENDENT.test(url)) { dropped['site-data:header-dependent'] = (dropped['site-data:header-dependent'] || 0) + 1; return; }
    if (!(kind === 'render' || (kind === 'site-data' && extra.method === 'GET'))) { dropped[kind] = (dropped[kind] || 0) + 1; return; }
    delete extra.method;
    all.push({ url, origin, ...extra });
  };
  for (const m of misses) add(m.url, 'miss-driven', kindOf(m, { siteUrl }), { resourceType: m.resourceType, method: m.method || 'GET' });
  for (const c of sorted) add(c.url, 'completed', kindOf({ url: c.url }), { method: 'GET', provenance: c.provenance, kind: c.kind, template: c.template, file: c.file, how: c.how });
  return { picked: all.slice(0, maxUrls), notFetched: all.slice(maxUrls).map(c => ({ url: c.url, origin: c.origin, reason: 'not-fetched:budget' })), dropped };
}

/**
 * Completeness of an archive from its replay checks: share of replay requests that were not relevant misses
 * (render-relevant or same-site data). renderMisses and siteDataMisses are reported apart.
 * @param {{[cls:string]:{requests?:number, misses?:object[]}}} verifies
 * @param {{siteUrl?:string|null}} [opts]
 */
export function completenessOf(verifies, { siteUrl = null } = {}) {
  let requests = 0; const counts = { render: 0, 'site-data': 0, telemetry: 0, 'non-GET': 0, api: 0, other: 0 }; const missLog = [];
  for (const [cls, v] of Object.entries(verifies)) {
    requests += v.requests || 0;
    for (const m of v.misses || []) { const k = kindOf(m, { siteUrl }); counts[k]++; missLog.push({ cls, kind: k, method: m.method, resourceType: m.resourceType, url: String(m.url).slice(0, 500) }); }
  }
  const relevant = counts.render + counts['site-data'];
  const pct = requests ? Math.round(1000 * (1 - relevant / requests)) / 10 : 0;
  return { pct, requests, renderMisses: counts.render, siteDataMisses: counts['site-data'], misses: counts, missLog };
}
