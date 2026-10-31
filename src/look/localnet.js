// Network policy of a LOCAL look (http://localhost:<port>/page, 127.0.0.1, [::1]).
//
// Decision (D-LOCALNET-1, 20 Oct 2026): a local look stays offline BY DEFAULT: the page is served from loopback and every
// other host resolves to nothing (DNS sinkhole), so a look never reaches the network on its own and never fingerprints the
// machine to a third party. That is a safety property of REVA (it is also what keeps the MCP's local targets from being
// a way to probe the network), so it is not relaxed silently. Two things make it useful instead:
//   1. NEVER SILENT: every request the page made to a host outside loopback and the sinkhole refused is counted, grouped by
//      host and resource type, and reported (warning line, look.json "network"): "cdn.jsdelivr.net ×1 script blocked; the
//      motion that library drives is missing; run again with --allow-net cdn.jsdelivr.net".
//   2. AN EXPLICIT OPT-IN, typed by the person on the CLI: --allow-net <host,...> (exact host names) or --allow-cdn (the
//      well-known library and font CDNs below, nothing else: no analytics, no ad hosts). Allowed hosts are removed from the
//      sinkhole and the proxy bypass list; everything else stays blocked and is still reported. The MCP never passes it.
// Host names only: no IP literals (a LAN address is not a CDN), no wildcards, no ports.

/** Library and font CDNs a hand-written test page loads GSAP, Lenis, Three, Google Fonts ... from. */
export const KNOWN_CDNS = Object.freeze(['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'code.jquery.com', 'ajax.googleapis.com']);

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const isLoopbackHost = (h) => LOOPBACK.has(String(h || '').toLowerCase());

/**
 * Validate a list of allowed host names. Throws a usage error (code bad_arguments) for anything that is not a plain DNS name.
 * @param {string[]} list
 * @returns {string[]} lower-case, de-duplicated
 */
export function normalizeAllowNet(list) {
  const out = [];
  for (const raw of list || []) {
    const h = String(raw || '').trim().toLowerCase();
    if (!h) continue;
    const bad = (why) => Object.assign(new Error(`--allow-net "${raw}": ${why} (give plain host names such as cdn.jsdelivr.net, comma-separated)`), { code: 'bad_arguments' });
    if (/[/:@*\s]/.test(h)) throw bad('not a plain host name (no scheme, port, path, wildcard or user info)');
    if (h === 'localhost') continue;   // loopback needs no allowing
    if (/^[\d.]+$/.test(h) || h.includes('[')) throw bad('IP addresses are not allowed (a LAN or loopback address is not a CDN)');
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) || h.length > 253) throw bad('not a valid host name');
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/**
 * Browser args of a local look: loopback plus `allow` resolve, every other name goes nowhere. The dead proxy is only a
 * backstop for a run without the sinkhole (loopback and the allowed hosts bypass it, everything else goes nowhere).
 * @param {string[]} [allow]  normalised host names
 * @param {{map?:Object<string,string>}} [o]  map: TEST ONLY, host -> IP the sinkhole resolves instead (a fixture's fake CDN on loopback)
 */
export function localArgs(allow = [], { map = null } = {}) {
  // the test map applies to an ALLOWED host only (an EXCLUDEd name skips every rule, a MAP included): without the allow it stays sinkholed
  const mapped = Object.entries(map || {}).filter(([h]) => allow.includes(h));
  const maps = mapped.map(([h, ip]) => `MAP ${h} ${ip}`);
  const hosts = ['localhost', '127.0.0.1', '[::1]'];
  const open = allow.filter((h) => !mapped.some(([m]) => m === h));
  const rules = [...maps, 'MAP * ~NOTFOUND', ...hosts.map((h) => `EXCLUDE ${h}`), ...open.map((h) => `EXCLUDE ${h}`)];
  return [`--host-resolver-rules=${rules.join(', ')}`, '--proxy-server=127.0.0.1:9', `--proxy-bypass-list=${[...hosts, ...allow].join(';')}`];
}

/**
 * Watch the requests a local page makes outside loopback that the sinkhole refused. A listener only: nothing runs in the
 * page, nothing is added to the take. Call `.summary()` after the take.
 * @param {import('playwright-core').Page} page
 */
export function watchBlocked(page) {
  const seen = new Map();   // host -> { count, types:Map, urls:[] }
  const refused = /ERR_NAME_NOT_RESOLVED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_REFUSED|ERR_TUNNEL_CONNECTION_FAILED|ERR_BLOCKED_BY_CLIENT/;
  page.on('requestfailed', (r) => {
    try {
      const why = (r.failure() && r.failure().errorText) || ''; if (!refused.test(why)) return;
      const u = new URL(r.url()); if (!/^https?:$|^wss?:$/.test(u.protocol) || isLoopbackHost(u.hostname)) return;
      const e = seen.get(u.hostname) || { count: 0, types: new Map(), urls: [] };
      const t = r.resourceType(); e.count++; e.types.set(t, (e.types.get(t) || 0) + 1);
      const shown = u.origin + u.pathname; if (e.urls.length < 5 && !e.urls.includes(shown)) e.urls.push(shown);
      seen.set(u.hostname, e);
    } catch { /* a closed page or an odd URL: not worth failing the look */ }
  });
  return {
    summary() {
      const hosts = [...seen.entries()].map(([host, e]) => ({ host, count: e.count, types: Object.fromEntries(e.types), urls: e.urls })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
      return { count: hosts.reduce((a, h) => a + h.count, 0), hosts };
    },
  };
}

/**
 * The `network` block of a look result for a local page, and the warning line when requests were blocked.
 * @param {string[]} allow  hosts the person allowed
 * @param {{count:number,hosts:object[]}} blocked  watchBlocked().summary()
 */
export function describeLocalNet(allow, blocked) {
  const net = { mode: 'local', policy: allow.length ? 'loopback plus the allowed hosts; everything else is blocked' : 'loopback only; every other host is blocked', allowed: allow, blocked };
  const warnings = [];
  if (blocked.count) {
    const part = (h) => `${h.host} ×${h.count} ${Object.entries(h.types).map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join('/')}`;
    const shown = blocked.hosts.slice(0, 6).map(part).join(', ') + (blocked.hosts.length > 6 ? `, and ${blocked.hosts.length - 6} more host(s)` : '');
    const fix = blocked.hosts.slice(0, 6).map((h) => h.host).join(',');
    const known = blocked.hosts.every((h) => KNOWN_CDNS.includes(h.host));
    warnings.push(`${blocked.count} request(s) to hosts outside this machine were blocked because this is a local look: ${shown}. Scripts, styles and fonts from them did not load, so motion they drive (a library from a CDN) is missing or different. `
      + `To let the page fetch them, run again with ${known ? '--allow-cdn' : `--allow-net ${fix}`}${known && blocked.hosts.length ? ` (or --allow-net ${fix})` : ''}.`);
  }
  if (allow.length) warnings.push(`local look with network access for ${allow.join(', ')} (--allow-net / --allow-cdn): the page may fetch from these hosts; everything else is blocked.`);
  return { net, warnings };
}
