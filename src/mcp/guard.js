// What the MCP `look` tool may open (plan item 1.5, MCP part). A model behind the MCP (or a page prompt-injecting it) must
// not be able to point the browser at the user's own machine or network: file: URLs, loopback, private, link-local and other
// non-public addresses are refused unless the person running the server opted in (REVA_MCP_ALLOW_LOCAL=1 or
// `reva mcp --allow-local`). The opt-in is a server setting on purpose: a tool argument would be set by the model.
// Frozen archives and the repo's own fixtures have their own explicit inputs (`archive`, `fixture`) and stay allowed.
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';

export class TargetBlocked extends Error { constructor(m, hint) { super(m); this.code = 'target_blocked'; this.hint = hint; } }

const OPT_IN = 'set REVA_MCP_ALLOW_LOCAL=1 in the MCP server config (or start it with `reva mcp --allow-local`) to allow local targets; frozen archives go through `archive`, the bundled demo page through `fixture: "demo"`';

/** Server-level opt-in, read once per call from the environment (or ctx.allowLocal set by `mcp --allow-local`). */
export const allowLocal = (ctx = {}) => ctx.allowLocal === true || /^(1|true|yes)$/i.test(String((ctx.env || process.env).REVA_MCP_ALLOW_LOCAL || ''));

const V4_BLOCKS = [ // [network, prefix bits, why]
  ['0.0.0.0', 8, 'this-network'], ['10.0.0.0', 8, 'private'], ['100.64.0.0', 10, 'carrier-grade NAT'], ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'], ['172.16.0.0', 12, 'private'], ['192.0.0.0', 24, 'IETF protocol assignments'], ['192.0.2.0', 24, 'documentation'],
  ['192.168.0.0', 16, 'private'], ['198.18.0.0', 15, 'benchmarking'], ['198.51.100.0', 24, 'documentation'], ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'], ['240.0.0.0', 4, 'reserved'],
];
const v4int = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);

/** An IPv6 literal as 8 hextets (numbers), embedded dotted IPv4 and a zone id handled; null when it does not parse. */
export function parseV6(ip) {
  let s = String(ip).toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (net.isIP(dotted[1]) !== 4) return null;
    const n = v4int(dotted[1]);
    s = `${s.slice(0, -dotted[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x) => (x ? x.split(':') : []);
  const head = part(halves[0]); const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const out = [...head, ...Array(fill).fill('0'), ...tail].map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return out.length === 8 && out.every(Number.isFinite) ? out : null;
}

const v4of = (h, i) => `${h[i] >> 8}.${h[i] & 255}.${h[i + 1] >> 8}.${h[i + 1] & 255}`;
const embedded = (h, i, form) => { const why = nonPublicReason(v4of(h, i)); return why ? `${why} (${v4of(h, i)} in ${form})` : null; };

/**
 * Why an IPv6 address (8 hextets) is not public. Allow-list: only global unicast 2000::/3 is public, minus the special
 * ranges inside it; the forms that carry an IPv4 address (IPv4-mapped / -compatible / -translated, NAT64 64:ff9b::/96,
 * 6to4 2002::/16) are judged by that IPv4 address, because that is where the packet ends up.
 */
function v6Reason(h) {
  if (!h) return 'unparseable IPv6';
  const z = (from, to) => h.slice(from, to).every((x) => x === 0);
  if (z(0, 8)) return 'unspecified';
  if (z(0, 7) && h[7] === 1) return 'loopback';
  if (z(0, 5) && h[5] === 0xffff) return embedded(h, 6, 'IPv4-mapped IPv6');               // ::ffff:0:0/96
  if (z(0, 6)) return embedded(h, 6, 'IPv4-compatible IPv6') || 'IPv4-compatible (deprecated)'; // ::/96
  if (z(0, 4) && h[4] === 0xffff && h[5] === 0) return embedded(h, 6, 'IPv4-translated IPv6');   // ::ffff:0:0:0/96
  if (h[0] === 0x64 && h[1] === 0xff9b && z(2, 6)) return embedded(h, 6, 'NAT64');       // 64:ff9b::/96
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return 'local-use NAT64';               // 64:ff9b:1::/48
  if (h[0] === 0x100 && z(1, 4)) return 'discard-only';                                       // 100::/64
  if ((h[0] & 0xfe00) === 0xfc00) return 'unique-local (private)';                            // fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return 'link-local';                                        // fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return 'site-local (private)';                              // fec0::/10
  if ((h[0] & 0xff00) === 0xff00) return 'multicast';                                         // ff00::/8
  if ((h[0] & 0xe000) !== 0x2000) return 'not global unicast';                                // outside 2000::/3
  if (h[0] === 0x2001 && h[1] < 0x200) return h[1] === 0 ? 'Teredo' : 'IETF protocol assignments'; // 2001::/23 (incl. 2001::/32)
  if (h[0] === 0x2001 && h[1] === 0xdb8) return 'documentation';                              // 2001:db8::/32
  if (h[0] === 0x3fff && h[1] < 0x1000) return 'documentation';                               // 3fff::/20
  if (h[0] === 0x2002) return embedded(h, 1, '6to4');                                    // 2002::/16
  return null;
}

/** Why an IP address is not a public internet address, or null when it is public. */
export function nonPublicReason(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const n = v4int(ip);
    for (const [base, bits, why] of V4_BLOCKS) { const size = 2 ** (32 - bits); const b = v4int(base); if (n >= b && n < b + size) return why; }
    return null;
  }
  if (v === 6) return v6Reason(parseV6(ip));
  return 'not an IP address';
}

const LOCAL_NAMES = /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$|\.(localhost|local|internal|home\.arpa|lan)$/i;

/**
 * Why a host name is not public: an IP literal in a non-public range, a local-only name, or a name whose DNS answers include
 * a non-public address (any one is enough: the browser may pick it). Returns null for a public host.
 * lookup(host) -> Promise<[{address}]> is injectable (tests never touch DNS).
 */
export async function hostReason(hostname, lookup = defaultLookup) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return 'empty host';
  if (net.isIP(h)) { const why = nonPublicReason(h); return why ? `${h} is a ${why} address` : null; }
  if (LOCAL_NAMES.test(h)) return `${h} is a local name`;
  const r = await resolvePublic(h, lookup);
  return r.why || null;
}

/**
 * Resolve a (non-IP, non-local) name and check every answer. Fails closed: a lookup error or an empty answer is a refusal,
 * never a pass (a transient error must not let a name through that the browser then resolves to 127.0.0.1).
 * Returns { ip } (the first public answer, IPv4 first) or { why }.
 */
async function resolvePublic(h, lookup) {
  let addrs;
  try { addrs = await lookup(h); } catch (e) { return { why: `${h} could not be resolved (${cleanCode(e)}); refused, the check fails closed` }; }
  if (!addrs || !addrs.length) return { why: `${h} has no address; refused, the check fails closed` };
  for (const a of addrs) { const why = nonPublicReason(a.address); if (why) return { why: `${h} resolves to ${a.address} (${why})` }; }
  const v4 = addrs.find((a) => net.isIPv4(a.address));
  return { ip: (v4 || addrs[0]).address };
}
const cleanCode = (e) => String((e && (e.code || e.message)) || 'lookup failed').replace(/[^\w .:-]/g, '').slice(0, 60);
export const defaultLookup = (h) => dns.promises.lookup(h, { all: true, verbatim: true });

/**
 * Check a URL given to `look`. Returns the normalised URL string or throws TargetBlocked.
 * Allowed without the opt-in: http(s) to public hosts. With the opt-in: also loopback / private hosts and file: URLs.
 */
export async function checkTargetUrl(raw, { allow = false, lookup = defaultLookup } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new TargetBlocked(`not a URL: ${String(raw).slice(0, 80)}`); }
  if (u.protocol === 'file:') {
    if (!allow) throw new TargetBlocked('file: URLs are blocked over MCP (they read files on this machine)', OPT_IN);
    return u.href;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TargetBlocked(`only http(s) URLs can be analysed (got ${u.protocol})`);
  if (u.username || u.password) throw new TargetBlocked('URLs with credentials are refused');
  if (!allow) { const why = await hostReason(u.hostname, lookup); if (why) throw new TargetBlocked(`blocked: ${why}; the MCP only opens public sites by default`, OPT_IN); }
  return u.href;
}

/**
 * Route-level guard for a live analysis (defense in depth: the enforcing layer is startGuardProxy below). Every request
 * Playwright routes to a non-public host is aborted. Playwright routes only the FIRST url of a redirect chain and never
 * WebSockets, and its answer can differ from the browser's own DNS answer, so on its own this is not a boundary.
 * Returns an async (S) => void for runLook's onSession hook (it also removes the WebRTC / WebTransport APIs, see
 * NO_UDP_APIS_SCRIPT), plus the list of blocked requests.
 */
export function liveRequestGuard({ lookup = defaultLookup } = {}) {
  const cache = new Map(); const blocked = [];
  const reason = (host) => { if (!cache.has(host)) cache.set(host, hostReason(host, lookup)); return cache.get(host); };
  const handler = async (route) => {
    let u; try { u = new URL(route.request().url()); } catch { return route.continue(); }
    if (u.protocol === 'file:') { blocked.push({ url: 'file:', why: 'file: URL' }); return route.abort('blockedbyclient'); }
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const why = await reason(u.hostname);
      if (why) { if (blocked.length < 50) blocked.push({ host: u.hostname, why }); return route.abort('blockedbyclient'); }
    }
    return route.continue();
  };
  return { blocked, handler, onSession: async (S) => { await S.ctx.addInitScript({ content: NO_UDP_APIS_SCRIPT }); await S.ctx.route('**/*', handler); } };
}

// ---------- WebRTC / WebTransport: UDP the proxy never sees ----------

/**
 * WebRTC sends STUN / TURN-over-UDP (and gathers host candidates) straight from the browser to whatever address the page
 * names: neither the proxy nor the route guard sees UDP. The command-line switch --force-webrtc-ip-handling-policy is
 * ignored by the browser we launch (verified: datagrams still reached 127.0.0.1), so the policy goes in as a profile pref,
 * which the browser does read. With it, WebRTC may only use the proxy (TURN over TCP via CONNECT, checked like any other).
 */
export const WEBRTC_PREFS = { webrtc: { ip_handling_policy: 'disable_non_proxied_udp', multiple_routes_enabled: false, nonproxied_udp_enabled: false } };

/**
 * Second layer, in every frame before any page script: the WebRTC and WebTransport constructors are gone (a motion
 * analysis never needs them). Non-configurable, so the page cannot put them back.
 */
export const NO_UDP_APIS_SCRIPT = `(() => {
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport', 'RTCIceCandidate', 'RTCSctpTransport', 'RTCDtlsTransport', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'WebTransport']) {
    try { delete globalThis[k]; } catch (e) {}
    try { Object.defineProperty(globalThis, k, { value: undefined, writable: false, configurable: false }); } catch (e) {}
  }
})();`;

// ---------- the enforcing layer: a forward proxy every live request goes through ----------

/** Split "host:port" / "[v6]:port" (CONNECT authority). */
function authority(a, defPort) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(a) || /^([^:]+)(?::(\d+))?$/.exec(a);
  if (!m) return null;
  const port = Number(m[2] || defPort);
  return Number.isInteger(port) && port > 0 && port < 65536 ? { host: m[1], port } : null;
}

/** Check a host and pick the exact IP to connect to: { ip } or { why }. Fresh per connection (no cache: rebinding pins nothing). */
export async function checkHost(hostname, lookup = defaultLookup) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!h) return { why: 'empty host' };
  if (net.isIP(h)) { const why = nonPublicReason(h); return why ? { why: `${h} is a ${why} address` } : { ip: h }; }
  if (LOCAL_NAMES.test(h)) return { why: `${h} is a local name` };
  return resolvePublic(h, lookup);
}

const HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

/**
 * In-process forward proxy (HTTP + CONNECT) for live analyses. Chromium is started with --proxy-server pointing here and
 * --proxy-bypass-list=<-loopback>, so EVERY request it makes (top-level navigations, every redirect hop, subresources,
 * WebSockets via CONNECT, fetch/beacon, service workers) arrives here as a host name. The proxy resolves the name itself,
 * refuses any non-public answer (and fails closed on lookup errors), and connects to the exact IP it checked: redirects,
 * WebSockets and DNS rebinding all meet the same check. QUIC is disabled and WebRTC may not send non-proxied UDP.
 * lookup and dial are injectable (tests never touch DNS or the internet).
 * Returns { port, args, prefs, blocked, close }: launch the browser with both args and prefs (prefs = WEBRTC_PREFS).
 */
export async function startGuardProxy({ lookup = defaultLookup, dial = (ip, port) => net.connect({ host: ip, port }), ports = [] } = {}) {
  const blocked = []; const sockets = new Set();
  // destination ports: the web's own (80, 443, 8000-8999) plus the analysed URL's port. The proxy is unauthenticated on
  // 127.0.0.1 while an analysis runs, so it must not be a way to reach arbitrary public host:port pairs (verifier item 19)
  const portOk = (n) => n === 80 || n === 443 || (n >= 8000 && n <= 8999) || ports.map(Number).includes(n);
  const portWhy = (n) => `port ${n} is outside the web ports the guard proxy relays (80, 443, 8000-8999, the analysed URL's port)`;
  const note = (host, why) => { if (blocked.length < 50) blocked.push({ host, why }); };
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => s.destroy()); return s; };
  const server = http.createServer(async (req, res) => {
    let u; try { u = new URL(req.url); } catch { res.writeHead(400); return res.end('absolute URL expected'); }
    if (u.protocol !== 'http:') { note(u.protocol, 'not http'); res.writeHead(403); return res.end(); }
    const c = await checkHost(u.hostname, lookup);
    if (c.why) { note(u.hostname, c.why); res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('blocked by the REVA MCP guard'); }
    if (!portOk(Number(u.port || 80))) { note(u.hostname, portWhy(Number(u.port))); res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('blocked by the REVA MCP guard'); }
    const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    const up = http.request({ method: req.method, path: `${u.pathname}${u.search}`, headers, setHost: false, createConnection: () => track(dial(c.ip, Number(u.port || 80))) }, (r) => {
      const h = {}; for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) h[k] = v;
      res.writeHead(r.statusCode, h); r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('connect', async (req, client, head) => {
    track(client);
    const a = authority(String(req.url), 443);
    const c = a ? await checkHost(a.host, lookup) : { why: 'bad CONNECT authority' };
    if (c.why) { note(a ? a.host : String(req.url).slice(0, 80), c.why); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    if (!portOk(Number(a.port))) { note(a.host, portWhy(a.port)); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = track(dial(c.ip, a.port));
    up.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head && head.length) up.write(head); up.pipe(client); client.pipe(up); });
    up.once('error', () => { if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  });
  // a ws:// upgrade sent in absolute form (Chromium normally tunnels WebSockets with CONNECT): same check, raw relay
  server.on('upgrade', async (req, client, head) => {
    track(client);
    let u; try { u = new URL(req.url); } catch { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const c = u.protocol === 'http:' || u.protocol === 'ws:' ? await checkHost(u.hostname, lookup) : { why: 'not http' };
    if (c.why) { note(u.hostname, c.why); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    if (!portOk(Number(u.port || 80))) { note(u.hostname, portWhy(Number(u.port))); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = track(dial(c.ip, Number(u.port || 80)));
    up.once('connect', () => {
      const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (!/^proxy-/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`); if (head && head.length) up.write(head); up.pipe(client); client.pipe(up);
    });
    up.once('error', () => client.destroy());
  });
  server.on('clientError', (e, s) => s.destroy());
  await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
  const { port } = server.address();
  return {
    port, blocked,
    // the WebRTC switch is kept for builds that honour it; the enforcing setting is the profile pref (WEBRTC_PREFS)
    args: [`--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    prefs: WEBRTC_PREFS,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); server.closeAllConnections?.(); }),
  };
}
