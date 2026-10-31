// Preflight before a page is opened (reva look, MCP look and the corpus runner): robots.txt, wall detection, consent banner.
// The page fetch follows redirects itself, one hop at a time, and checks robots.txt of EVERY hop's origin before that hop is
// requested, so a short link, an apex-to-other-host redirect or a redirector URL cannot open a page whose robots.txt disallows
// REVA (the browser follows the same redirects). One robots.txt fetch per origin.
import { UA, robotsVerdict, readRobotsBody } from './robots.js';
import { detectWall } from './wall.js';
import { detectConsent } from './consent.js';

const firstLine = (s) => String(s || '').split('\n')[0];
const MAX_HOPS = 10;
const rank = (r) => (!r ? -1 : r.blocked && !r.ignored ? 2 : r.blocked ? 1 : 0);

const bareHost = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
/** True when `u` is on the same site as `typed`: the same host, give or take a leading www., or a subdomain of it either way. */
export function sameSite(u, typed) {
  const a = bareHost(u); const b = bareHost(typed);
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

/**
 * @param {string} url
 * @param {object} [o]
 * @param {boolean|((url:string)=>boolean)} [o.ignoreRobots]  a robots.txt block of a hop is kept in out.robots but does not
 *   stop the check. `true` (the person typed --ignore-robots: the site is theirs) covers only the typed site (sameSite), never
 *   another host a redirect leads to; a function decides per hop URL (the own-domains list). Walls are always checked.
 */
export async function preflight(url, { fetchImpl = globalThis.fetch, timeoutMs = 20000, now = Date.now, ignoreRobots = false } = {}) {
  const t0 = now();
  const out = {
    url, finalUrl: url, http: null, redirectHost: null, robots: null, robotsText: null, hops: [],
    wall: null, consent: { cmp: null, clicks: [] }, html: '', verdict: 'ok', reason: null, ms: 0,
  };
  const done = (verdict, reason = null) => { out.verdict = verdict; out.reason = reason; out.ms = now() - t0; return out; };

  let origin;
  try { origin = new URL(url).origin; } catch (e) { return done('failed:network', 'invalid url'); }
  const overridden = typeof ignoreRobots === 'function' ? (u) => { try { return !!ignoreRobots(u); } catch { return false; } }
    : ignoreRobots ? (u) => sameSite(u, url) : () => false;

  const robotsTexts = new Map();
  // origin -> robots.txt text (null: none), not enumerable (never in a JSON result): the navigation guard starts from it
  Object.defineProperty(out, 'robotsTexts', { value: robotsTexts, enumerable: false });
  const robotsFor = async (o) => {
    if (robotsTexts.has(o)) return robotsTexts.get(o);
    let text = null;
    try {
      const r = await fetchImpl(o + '/robots.txt', { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(Math.min(10000, timeoutMs)) });
      if (r.status >= 200 && r.status < 300) text = await readRobotsBody(r);
    } catch { text = null; }
    robotsTexts.set(o, text);
    return text;
  };
  /** Check robots.txt for one hop; returns true when the hop must not be requested. */
  const blockedHop = async (u) => {
    let o; try { o = new URL(u).origin; } catch { return false; }
    const text = await robotsFor(o);
    const v = robotsVerdict(text, [u]);
    const ignored = v.blocked && overridden(u);
    out.hops.push({ url: u, blocked: v.blocked, ignored });
    // out.robots: the first hop that stops the check, else the first blocked-but-overridden hop, else the typed URL's verdict
    const cand = { ...v, url: u, origin: o, ignored };
    if (rank(cand) > rank(out.robots)) out.robots = cand;
    return v.blocked && !ignored;
  };

  if (await blockedHop(url)) { out.robotsText = robotsTexts.get(origin); return done('blocked:robots', out.robots.reason); }
  out.robotsText = robotsTexts.get(origin);

  let res; let html; let u = url;
  try {
    for (let i = 0; ; i++) {
      res = await fetchImpl(u, { headers: { 'user-agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      const loc = res.status >= 300 && res.status < 400 && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      if (!loc) break;
      try { await res.body?.cancel(); } catch { /* already closed */ }
      if (i >= MAX_HOPS) return done('failed:network', `more than ${MAX_HOPS} redirects`);
      u = new URL(loc, u).href;
      if (await blockedHop(u)) { out.finalUrl = u; return done('blocked:robots', out.robots.reason); }
    }
    // a fetch that followed redirects by itself (it ignored redirect:'manual') still has its landing page checked
    if (res.url && res.url !== u) {
      u = res.url;
      if (await blockedHop(u)) { out.finalUrl = u; return done('blocked:robots', out.robots.reason); }
    }
    html = await res.text();
  } catch (e) {
    return done('failed:network', firstLine(e && (e.name === 'Error' ? e.message : `${e.name}: ${e.message}`)));
  }
  out.http = res.status;
  out.finalUrl = u;
  out.html = html;
  try {
    const fh = new URL(out.finalUrl).hostname;
    if (fh !== new URL(url).hostname) out.redirectHost = fh;
  } catch { /* ignore */ }
  out.wall = detectWall({ status: res.status, html, headers: res.headers, finalUrl: out.finalUrl });
  out.consent = detectConsent(html);
  if (out.wall) return done('blocked:' + (out.wall.kind === 'wall' ? 'wall' : out.wall.kind), out.wall.marker);
  if (res.status >= 400) return done('failed:http', 'http ' + res.status);
  return done('ok');
}
