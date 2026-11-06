// robots.txt policy: parse, per-agent rule match, and the verdict REVA uses before it opens a page.
// Shared by `reva` (look) and the corpus runner; nothing here is corpus-specific.
/** Where a site owner reads what REVA is and how to opt out (named in every user agent REVA sends). */
export const PROJECT_URL = 'https://github.com/thanwishdev/reva';
export const UA = `REVA/0.1 (+${PROJECT_URL}; measures how a page moves and is designed; checks robots.txt first)`;
/**
 * The user agent of reva scan's browser on a live site (owner go 3 Nov): what Chrome itself sends for that device (the
 * reduced UA string), then REVA's product token and the project URL, as crawlers that render pages do. The token is the one
 * robots.txt groups match ("User-agent: REVA"), so the name a site owner sees in a log is the name that opts out.
 * Phone: Chrome on Android, so a site serves its phone version (the context is also mobile, touch, DPR 2).
 * @param {'desktop'|'phone'} kind
 * @param {string|number} chromeVersion  e.g. "147.0.7727.57" (only the major is sent, as Chrome does)
 */
export function browserUserAgent(kind, chromeVersion) {
  const major = String(chromeVersion).split('.')[0];
  const base = kind === 'phone'
    ? `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
    : `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return `${base} (compatible; REVA/0.1; +${PROJECT_URL})`;
}
/** The product token REVA obeys in robots.txt ("User-agent: REVA"), matched case-insensitively, any version suffix ignored. */
export const PRODUCT_TOKEN = 'REVA';
/** RFC 9309 2.5: a parser may ignore content past 500 KiB. Longer rule paths are ignored (no real rule is that long). */
export const MAX_ROBOTS_BYTES = 500 * 1024;
export const MAX_RULE_LENGTH = 2048;

/** Read a robots.txt response body, at most MAX_ROBOTS_BYTES of it (a huge file never fills memory). */
export async function readRobotsBody(res, max = MAX_ROBOTS_BYTES) {
  if (!res.body || typeof res.body.getReader !== 'function') return String(await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const chunks = []; let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); n += value.byteLength;
    }
  } finally { try { await reader.cancel(); } catch { /* closed */ } }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, max));
}

/**
 * Fetch one origin's robots.txt and classify the answer (RFC 9309 2.3.1; PR-07, 31 Oct):
 *   2xx                      -> {status, text}: the file decides
 *   other 4xx (404, 403 ...) -> {status, text: null}: no robots.txt, everything is allowed
 *   5xx, 429, timeout, network error -> unreachable: the site said "try later" or could not be asked, so REVA does not open
 *                                       the page (transient: the corpus runner retries once later)
 *   DNS failure (ENOTFOUND)  -> not unreachable: the page fetch fails with the same cause and that failure is permanent
 * @returns {Promise<{status:number|null, text:string|null, unreachable:boolean, error?:string}>}
 */
export async function fetchRobots(origin, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  try {
    const r = await fetchImpl(origin + '/robots.txt', { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const status = r.status;
    if (status >= 200 && status < 300) return { status, text: await readRobotsBody(r), unreachable: false };
    try { r.body?.cancel()?.catch?.(() => {}); } catch { /* already closed */ } // not awaited: a cancel can wait for a second reader of a teed body
    if (status >= 500 || status === 429) return { status, text: null, unreachable: true, error: `http ${status}` };
    return { status, text: null, unreachable: false };
  } catch (e) {
    const code = e?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.code ?? null;
    if (code === 'ENOTFOUND') return { status: null, text: null, unreachable: false, error: 'network ENOTFOUND' };
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { status: null, text: null, unreachable: true, error: timeout ? 'timeout' : `network${code ? ' ' + code : ''}` };
  }
}

export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let cur = null;
  let lastWasAgent = false;
  let body = String(text ?? '');
  if (body.length > MAX_ROBOTS_BYTES) body = body.slice(0, MAX_ROBOTS_BYTES);
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], crawlDelay: null }; groups.push(cur); }
      // product token only: "REVA/0.1" and "reva" name the same crawler
      cur.agents.push(value.toLowerCase().split(/[\/\s]/)[0]);
      lastWasAgent = true;
      continue;
    }
    if (field === 'sitemap') { if (value) sitemaps.push(value); continue; }
    if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (cur && value && value.length <= MAX_RULE_LENGTH) cur.rules.push({ allow: field === 'allow', path: value });
      continue;
    }
    if (field === 'crawl-delay') {
      lastWasAgent = false;
      const n = Number(value);
      if (cur && Number.isFinite(n)) cur.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

function normPath(p) {
  // Uppercase percent escapes, decode unreserved characters so encodings compare equal.
  return p.replace(/%([0-9a-fA-F]{2})/g, (m, h) => {
    const c = String.fromCharCode(parseInt(h, 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : '%' + h.toUpperCase();
  });
}

function toPath(urlOrPath) {
  const s = String(urlOrPath);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { const u = new URL(s); return u.pathname + u.search; } catch { /* fall through */ }
  }
  return s.startsWith('/') ? s : '/' + s;
}

/**
 * Compile a robots.txt path pattern ('*' = any run of characters, a final '$' = end of path) into a matcher that runs in
 * linear time. A RegExp of '.*' pieces backtracks exponentially on a hostile rule ('*a*a*a...' against a long path) and
 * would freeze the event loop; a pattern with only '*' wildcards is matched exactly by taking each literal piece at its
 * leftmost possible place (greedy leftmost is optimal when the only wildcard is '*').
 */
export function ruleMatcher(path) {
  let p = normPath(path);
  let anchored = false;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  const parts = p.split('*');
  const first = parts[0];
  if (parts.length === 1) return anchored ? (s) => s === first : (s) => s.startsWith(first);
  const last = parts[parts.length - 1];
  const middle = parts.slice(1, -1).filter(Boolean);
  return (s) => {
    if (!s.startsWith(first)) return false;
    let pos = first.length;
    for (const piece of middle) {
      const at = s.indexOf(piece, pos);
      if (at < 0) return false;
      pos = at + piece.length;
    }
    if (!anchored) return last === '' || s.indexOf(last, pos) >= 0;
    return s.length - last.length >= pos && s.endsWith(last);
  };
}

const matcherCache = new Map();
function matches(rulePath, path) {
  let m = matcherCache.get(rulePath);
  if (!m) {
    m = ruleMatcher(rulePath);
    if (matcherCache.size > 5000) matcherCache.clear();
    matcherCache.set(rulePath, m);
  }
  return m(path);
}

function selectGroups(parsed, agent) {
  const a = String(agent).toLowerCase();
  if (a === '*') {
    const star = parsed.groups.filter((g) => g.agents.includes('*'));
    return { groups: star, kind: star.length ? 'star' : 'none' };
  }
  const specific = parsed.groups.filter((g) => g.agents.some((t) => t !== '*' && t && a.startsWith(t)));
  if (specific.length) return { groups: specific, kind: 'specific' };
  const star = parsed.groups.filter((g) => g.agents.includes('*'));
  return { groups: star, kind: star.length ? 'star' : 'none' };
}

export function robotsAllows(parsed, agent, urlOrPath) {
  const path = normPath(toPath(urlOrPath));
  const { groups, kind } = selectGroups(parsed, agent);
  if (path === '/robots.txt') return { allowed: true, rule: null, group: kind };
  let best = null;
  for (const g of groups) {
    for (const r of g.rules) {
      if (!matches(r.path, path)) continue;
      const len = normPath(r.path).length;
      if (!best || len > best.len || (len === best.len && r.allow && !best.r.allow)) best = { len, r };
    }
  }
  if (!best) return { allowed: true, rule: null, group: kind };
  return { allowed: best.r.allow, rule: (best.r.allow ? 'Allow: ' : 'Disallow: ') + best.r.path, group: kind };
}

// REVA's own token first, then the Anthropic crawlers (REVA is built with Claude; a site that opts out of them is respected).
const ANTHROPIC_AGENTS = ['ClaudeBot', 'anthropic-ai', 'Claude-User'];
const OTHER_AGENTS = ['GPTBot', 'CCBot', 'Google-Extended'];

export function robotsVerdict(text, urls) {
  const list = Array.isArray(urls) ? urls : [urls];
  const parsed = text == null ? { groups: [], sitemaps: [] } : parseRobots(text);
  const denies = (agent) => list.some((u) => !robotsAllows(parsed, agent, u).allowed);
  const star = denies('*') ? 'disallow' : 'allow';
  const reva = denies(PRODUCT_TOKEN) ? 'disallow' : 'allow';
  const anthropicAgent = ANTHROPIC_AGENTS.find((a) => denies(a)) || null;
  const others = {};
  for (const a of OTHER_AGENTS) others[a] = denies(a) ? 'disallow' : 'allow';
  let crawlDelay = null;
  for (const a of ['*', PRODUCT_TOKEN, ...ANTHROPIC_AGENTS]) {
    for (const g of selectGroups(parsed, a).groups) {
      if (g.crawlDelay != null && (crawlDelay == null || g.crawlDelay > crawlDelay)) crawlDelay = g.crawlDelay;
    }
  }
  const blocked = star === 'disallow' || reva === 'disallow' || anthropicAgent !== null;
  return {
    star,
    reva,
    anthropic: anthropicAgent ? 'disallow' : 'allow',
    anthropicAgent,
    crawlDelay,
    others,
    blocked,
    reason: star === 'disallow' ? 'robots:star' : reva === 'disallow' ? 'robots:reva' : anthropicAgent ? 'robots:anthropic' : null,
  };
}

/** Why a robots.txt could not be read, in plain words, from fetchRobots' error ('http 503', 'timeout', 'network ECONNRESET'). */
export function unreachableWhy(error) {
  const e = String(error || '');
  const m = /^http (\d{3})$/.exec(e);
  if (m) return m[1] === '429' ? 'HTTP 429, too many requests' : `HTTP ${m[1]}`;
  if (e === 'timeout') return 'no answer within 10 s';
  if (/^network/.test(e)) return `network error${e.slice(7) ? ` ${e.slice(8)}` : ''}`;
  return e || 'no answer';
}

/** The sentence for a page REVA did not open because its robots.txt could not be read (5xx, 429, timeout, network error). */
export const robotsUnreachableText = (origin, error) => `robots.txt of ${origin} could not be read (${unreachableWhy(error)}); REVA does not open a page whose robots.txt it cannot read. Try again later.`;
