// Site map for `reva scan` (phase 3): every reachable URL listed, grouped by path shape, then by rendered structure.
// Polite: robots.txt first, one request at a time, a gap between requests, robots-disallowed URLs are listed and never fetched.
// reva scan passes its live-visit policy's fetch (src/scan/polite.js): the shared per-host queue (Crawl-delay included), the stop
// rules on every answer, and a page that is a login or region wall marked `blocked` with the reason.
import { parseRobots, robotsAllows, UA } from '../safety/robots.js';

const AGENTS = ['*', 'REVA', 'ClaudeBot', 'anthropic-ai', 'Claude-User'];
const FILE = /\.(pdf|zip|jpe?g|png|gif|svg|webp|mp4|webm|mp3|dmg|exe|xml|json|txt|ics|csv|css|js|woff2?)$/i;
const SKIP_TAGS = /^(a|span|br|p|li|i|b|em|strong|img|source|path|h[1-6])$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = (u) => new URL(u).hostname.replace(/^www\./, '');

/** One URL, no hash, no query, no trailing slash: the identity of a page for listing. */
export function urlKey(u) { const x = new URL(u); x.hash = ''; x.search = ''; return x.href.replace(/\/$/, '') || x.origin; }

// Path shape: first segment kept, every deeper segment becomes a star.
export function pathShape(u) {
  const s = new URL(u).pathname.split('/').filter(Boolean);
  return '/' + s.map((x, i) => (i > 0 ? '*' : x)).join('/');
}

/** Set of tag 3-grams of the rendered markup (scripts, styles, svg and inline noise removed). */
export function structureOf(html) {
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, '');
  const tags = [...body.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b/g)].map((m) => m[1].toLowerCase()).filter((t) => !SKIP_TAGS.test(t));
  const s = new Set();
  for (let i = 0; i + 3 <= tags.length; i++) s.add(tags.slice(i, i + 3).join('>'));
  return s;
}
export function jaccard(a, b) {
  let i = 0; for (const x of a) if (b.has(x)) i++;
  return i / Math.max(1, a.size + b.size - i);
}
const spread = (arr, n) => (arr.length <= n ? arr : Array.from({ length: n }, (_, i) => arr[Math.floor((i * arr.length) / n)]));

/**
 * mapSite(startUrl, opts) -> { start, host, robots, requests, kb, pages, templates, clusters, counts }
 * opts: fetchImpl (default global fetch), gapMs (500), maxFetch (page budget, 250), perShape (pages sampled per shape, 3),
 *       similarity (0.6), maxSitemaps (30), onProgress(msg), halted() (true once the site asked REVA to stop: nothing more is fetched)
 * pages: every URL, { url, shape, status: 'sampled'|'listed'|'blocked', cluster }. A listed page takes the cluster of its shape.
 */
export async function mapSite(startUrl, opts = {}) {
  const { fetchImpl = fetch, gapMs = 500, maxFetch = 250, perShape = 3, similarity = 0.6, maxSitemaps = 30, onProgress = () => {}, halted = () => false } = opts;
  const base = new URL(startUrl); const start = urlKey(base.href); const h = host(start);
  let last = 0; const req = { n: 0, bytes: 0 };
  const get = async (u) => {
    const w = gapMs - (Date.now() - last); if (w > 0) await sleep(w); last = Date.now(); req.n++;
    try {
      const r = await fetchImpl(u, { headers: { 'user-agent': UA, accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      const t = await r.text(); req.bytes += t.length;
      return { s: r.status, t, ct: r.headers.get('content-type') || '', url: r.url || u, wall: r.wall || null };
    } catch (e) { return { s: 0, t: '', ct: '', url: u, err: String(e.message || e).slice(0, 80) }; }
  };
  // robots: 404 means no rules; anything else unreadable stops the map (a page whose robots cannot be read is never opened)
  const rb = await get(new URL('/robots.txt', base).href);
  if (rb.s === 0 || rb.s === 429 || rb.s >= 500) {
    return { start, host: h, robots: { status: rb.s, unreadable: true }, requests: req.n, kb: 0, pages: [], templates: [], clusters: [], counts: { listed: 0, sampled: 0, blocked: 0 } };
  }
  const robotsText = rb.s === 200 ? rb.t : '';
  const parsed = robotsText ? parseRobots(robotsText) : null;
  const allowed = (u) => !parsed || AGENTS.every((a) => robotsAllows(parsed, a, u).allowed);

  // sitemaps (index files followed, capped)
  const smQ = [...robotsText.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]); if (!smQ.length) smQ.push(new URL('/sitemap.xml', base).href);
  const smUrls = []; let smFiles = 0;
  while (smQ.length && smFiles < maxSitemaps && !halted()) {
    const u = smQ.shift(); smFiles++; const r = await get(u); if (r.s !== 200) continue;
    const locs = [...r.t.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(r.t)) smQ.push(...locs); else smUrls.push(...locs);
  }
  const sameSite = (u) => { try { return host(u) === h && /^https?:$/.test(new URL(u).protocol); } catch { return false; } };

  const found = new Map(); // key -> { url, shape, status, cluster, html? }
  const add = (u, via = 'link') => { if (!sameSite(u)) return false; let k; try { if (FILE.test(new URL(u).pathname)) return false; k = urlKey(u); } catch { return false; } if (found.has(k)) return false; found.set(k, { url: k, shape: pathShape(k), status: 'listed', cluster: null, from: via }); return true; };
  add(start, 'start'); for (const u of smUrls) add(u, 'sitemap');
  onProgress(`sitemap: ${smUrls.length} urls in ${smFiles} files`);

  const byShape = () => { const m = new Map(); for (const p of found.values()) { if (!m.has(p.shape)) m.set(p.shape, []); m.get(p.shape).push(p); } return m; };
  const sampled = []; let fetched = 0;
  const visit = async (p) => {
    if (p.status !== 'listed') return;
    if (!allowed(p.url)) { p.status = 'blocked'; return; }
    if (halted()) return;
    fetched++;
    const r = await get(p.url);
    if (halted()) return;
    if (r.wall) { p.status = 'blocked'; p.blockedWhy = r.wall; return; } // a login or region wall: never recorded
    p.status = 'sampled';
    if (r.s !== 200 || !/html/.test(r.ct)) { p.httpStatus = r.s; p.sh = new Set(); return; }
    p.httpStatus = 200; p.sh = structureOf(r.t); p.bytes = r.t.length; sampled.push(p);
    for (const m of r.t.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'#]+)/gi)) { try { add(new URL(m[1].replace(/&amp;/g, '&'), r.url).href); } catch { /* bad href */ } }
  };
  // order: home, then one per shape (so every shape is seen once), then more per shape, spread across its list
  await visit(found.get(start));
  for (let round = 0; round < perShape && fetched < maxFetch; round++) {
    const shapes = byShape(); let any = false;
    for (const [, list] of [...shapes.entries()].sort((a, b) => b[1].length - a[1].length)) {
      if (fetched >= maxFetch) break;
      const open = list.filter((p) => p.status === 'listed');
      const done = list.length - open.length;
      if (done > round || !open.length) continue;
      const pick = spread(open, Math.max(1, perShape - done))[0];
      any = true; await visit(pick);
    }
    if (!any || halted()) break;
  }
  // a listed URL robots.txt disallows is blocked whether or not it was sampled (AUDIT finding 15)
  for (const p of found.values()) if (p.status === 'listed' && !allowed(p.url)) p.status = 'blocked';
  onProgress(`fetched ${fetched} pages, ${found.size} urls known`);

  // clusters by rendered structure; first page of a cluster is its representative
  const clusters = [];
  for (const p of sampled) {
    let best = null, bj = 0;
    for (const c of clusters) { const j = jaccard(p.sh, c.rep.sh); if (j > bj) { bj = j; best = c; } }
    if (best && bj >= similarity) { best.members.push(p); p.cluster = best.id; } else { const c = { id: clusters.length, rep: p, members: [p] }; clusters.push(c); p.cluster = c.id; }
  }
  // a shape belongs to the cluster most of its sampled pages landed in; unsampled pages follow their shape
  const templates = [];
  for (const [shape, list] of byShape()) {
    const votes = new Map(); for (const p of list) if (p.cluster != null) votes.set(p.cluster, (votes.get(p.cluster) || 0) + 1);
    const cl = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    for (const p of list) if (p.status === 'listed' && cl != null) p.cluster = cl;
    templates.push({ shape, count: list.length, cluster: cl, sampled: list.filter((p) => p.status === 'sampled').length, blocked: list.filter((p) => p.status === 'blocked').length });
  }
  templates.sort((a, b) => b.count - a.count);
  const pages = [...found.values()].map(({ sh, ...p }) => p);
  const outClusters = clusters.map((c) => ({
    id: c.id, rep: c.rep.url, sampled: c.members.length,
    pages: pages.filter((p) => p.cluster === c.id).length,
    shapes: templates.filter((t) => t.cluster === c.id).map((t) => t.shape),
  })).sort((a, b) => b.pages - a.pages);
  return {
    start, host: h, robots: { status: rb.s, unreadable: false, sitemaps: smFiles, sitemapUrls: smUrls.length }, requests: req.n, kb: Math.round(req.bytes / 1024),
    pages, templates, clusters: outClusters,
    counts: { listed: pages.length, sampled: pages.filter((p) => p.status === 'sampled').length, blocked: pages.filter((p) => p.status === 'blocked').length, shapes: templates.length, clusters: outClusters.length },
  };
}

/** Up to this many path shapes, every shape is recorded: an app shell serves one structure for all its pages (2 Nov: two portfolio sites, 5 shapes each, both 1 structure). */
export const PER_SHAPE_UP_TO = 8;

/** The pages `reva scan` should record: the home, then one per path shape on a small site, else the representative of every cluster. */
export function pagesToRecord(map) {
  const out = [{ url: map.start, why: 'home' }]; const seen = new Set([map.start]);
  if ((map.counts?.shapes ?? Infinity) <= PER_SHAPE_UP_TO) {
    for (const t of map.templates) {
      const p = map.pages.find((x) => x.shape === t.shape && x.status === 'sampled' && x.httpStatus === 200);
      if (p && !seen.has(p.url) && !map.pages.some((x) => x.shape === t.shape && seen.has(x.url))) { seen.add(p.url); out.push({ url: p.url, why: `path shape ${t.shape}: ${t.count} pages` }); }
    }
    return out;
  }
  for (const c of map.clusters) if (!seen.has(c.rep)) { seen.add(c.rep); out.push({ url: c.rep, why: `structure ${c.id}: ${c.pages} pages` }); }
  return out;
}

/** The map in plain sentences, for the scan's first printed lines and the card's site level. */
export function describeMap(map) {
  if (map.robots.unreadable) return [`robots.txt of ${map.host} could not be read (HTTP ${map.robots.status || 'no answer'}); nothing was opened.`];
  const c = map.counts;
  const lines = [`${c.listed} pages listed, ${c.shapes} path shapes, ${c.clusters} page structures. ${c.sampled} pages were opened to tell them apart (${map.requests} requests, ${map.kb} KB).`];
  if (c.blocked) lines.push(`${c.blocked} pages are disallowed by robots.txt: listed, never opened.`);
  for (const k of map.clusters.slice(0, 12)) lines.push(`${k.pages} pages look like ${k.rep} (${k.shapes.slice(0, 4).join(', ')}${k.shapes.length > 4 ? ', ...' : ''}).`);
  return lines;
}
