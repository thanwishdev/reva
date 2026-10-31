// Built-in tracker / analytics block list (corpus F21). These hosts only receive beacons: blocking them cannot change a
// page's design or motion, saves load time, keeps them out of the archive and out of the replay miss list.
// Deliberately NOT here: tag managers' script hosts, consent banners (OneTrust, Cookiebot), chat and form widgets, social
// embeds: they can render something. Every blocked URL is logged by the caller (never silent).
// Collector / beacon hosts only (exact host or any subdomain of it). NEVER a vendor's marketing site: segment.com, amplitude.com,
// mixpanel.com, hotjar.com, fullstory.com, plausible.io, criteo.com, taboola.com, outbrain.com, sentry.io, clarity.ms are pages
// someone may reverse. An entry with a path ("host/path") blocks that path prefix on that host only.
import { registrableDomain } from '../util/domain.js';

const HOSTS = [
  'google-analytics.com', 'analytics.google.com', 'stats.g.doubleclick.net', 'doubleclick.net', 'pagead2.googlesyndication.com',
  'googleadservices.com', 'google.com/ads', 'google.fi/ads', 'c.clarity.ms', 'in.hotjar.com', 'vc.hotjar.io', 'metrics.hotjar.io',
  'api.segment.io', 'api.mixpanel.com', 'api-js.mixpanel.com', 'api.amplitude.com', 'api2.amplitude.com', 'api.eu.amplitude.com',
  'c.heapanalytics.com', 'rs.fullstory.com', 'edge.fullstory.com', 'pixel.quantserve.com', 'sb.scorecardresearch.com', 'demdex.net',
  'omtrdc.net', 'insight.adsrvr.org', 'gum.criteo.com', 'dis.criteo.com', 'trc.taboola.com', 'tracking.outbrain.com', 'log.outbrain.com',
  'nr-data.net', 'browser-intake-datadoghq.com', 'vercel-insights.com', 'plausible.io/api/event', 'q.stripe.com', 'r.stripe.com',
  'events.mapbox.com', 'logx.optimizely.com', 'analytics.tiktok.com', 'ct.pinterest.com', 'analytics.twitter.com', 'static.ads-twitter.com',
  't.co/i/adsct', 'bat.bing.com', 'px.ads.linkedin.com', 'ingest.sentry.io', 'mc.yandex.ru/watch', 'analytics.yahoo.com', 'stats.wp.com',
];
const hostRe = h => h.replace(/\./g, '\\.');
const HOST_ONLY = HOSTS.filter(h => !h.includes('/'));
const HOST_PATHS = HOSTS.filter(h => h.includes('/')).map(h => { const k = h.indexOf('/'); return [h.slice(0, k), h.slice(k)]; });
export const TRACKER_HOST_RE = new RegExp(`(^|\\.)(${HOST_ONLY.map(hostRe).join('|')})$`, 'i');
/** Same-site beacon endpoints that are analytics by path alone (Cloudflare RUM, GA first-party proxy). Never a bare "/tr". */
const BEACON_PATH_RE = /^\/(cdn-cgi\/rum|g\/collect|ccm\/collect)(\/|\?|$)/i;

// 26 Oct: the shared registrable-domain helper (was the bare last two labels: every *.co.th host was "same site" on a .co.th page)
const regDomain = registrableDomain;

/**
 * @param {string} url
 * @param {string|null} ownUrl  the page being archived / replayed: requests to its own site are never trackers (reversing a
 *   vendor's own site must not abort its own document or its first-party collector)
 * @returns {boolean} true if the URL is a pure tracker/analytics beacon target
 */
export function isTrackerUrl(url, ownUrl = null) {
  let u; try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (ownUrl) { try { if (regDomain(new URL(ownUrl).hostname) === regDomain(u.hostname)) return false; } catch {} }
  if (TRACKER_HOST_RE.test(u.hostname)) return true;
  for (const [h, p] of HOST_PATHS) if ((u.hostname === h || u.hostname === `www.${h}`) && u.pathname.startsWith(p)) return true;
  if (u.hostname === 'www.facebook.com' && /^\/tr\/?$/.test(u.pathname)) return true; // the pixel host only: /tr is a real page elsewhere
  if (u.hostname === 'connect.facebook.net' && /\/(fbevents|signals)/.test(u.pathname)) return true;
  return BEACON_PATH_RE.test(u.pathname);
}

/**
 * Route handler installer: aborts tracker requests and records them.
 * @param {import('playwright-core').BrowserContext} ctx
 * @param {string[]} sink  receives "METHOD url"
 * @param {{ownUrl?:string|null}} [o]  the page's own URL: its site is never blocked, and navigations always pass
 */
export async function blockTrackers(ctx, sink, { ownUrl = null } = {}) {
  await ctx.route(url => isTrackerUrl(url.toString(), ownUrl), r => {
    if (r.request().isNavigationRequest()) return r.fallback(); // a document is never a beacon
    sink.push(`${r.request().method()} ${r.request().url()}`); r.abort('blockedbyclient');
  });
}

/** "METHOD url :: error" entries of a requestfailed log that are tracker blocks we made on purpose. */
export const isTrackerFailure = (f, ownUrl = null) => { const m = /^[A-Z]+ (\S+)/.exec(f); return !!m && isTrackerUrl(m[1], ownUrl); };
