// Read-through completion (DESIGN 3.7): a recording asks for a file the copy lacks, and that one file is fetched while the
// virtual clock waits, so no unit is recorded twice. Used live for one case only (owner, 6 Nov): the take of a WebGL experience a click
// opens (scan/index.js experienceMiss), with liveFetcher below and the README's rules. Every other take stays on the copy; the files it
// fetches are served to that take and are not joined to the archive (extra-*.har.zip).
import fs from 'node:fs';
import { parseHarZip } from '../freeze/sanitize.js';
import { sameSite } from './complete.js';
import { classify, pacer } from './stoprule.js';

export const LIMITS = { gapMs: 500, maxFiles: 300 };
const BODY_HEADERS_OUT = /^(content-encoding|content-length|transfer-encoding)$/i;

/**
 * @param {{fetcher:(url:string)=>Promise<{status:number, headers?:object, body?:Buffer|string}|null>, home:string, allowed?:(url:string)=>boolean|Promise<boolean>, gapMs?:number, maxFiles?:number}} o
 * @returns {{onMiss:(q:{method:()=>string, url:()=>string})=>Promise<object|null>, stats:object, rows:()=>object[]}}
 *   onMiss answers Playwright's route.fulfill options, or null when the request stays a miss, as it does today.
 */
export function readThrough({ fetcher, home, allowed = () => true, gapMs = LIMITS.gapMs, maxFiles = LIMITS.maxFiles, pace = pacer(gapMs) }) {
  const stats = { asked: 0, fetched: [], failed: [], refused: [], stopped: null, overBudget: 0 }, seen = new Map();
  const one = async (url) => {
    if (stats.stopped) return null;
    if (stats.fetched.length >= maxFiles) { stats.overBudget++; return null; }
    if (!(await allowed(url))) { stats.refused.push({ url, reason: 'robots.txt does not allow it' }); return null; }
    let a;
    try { a = await fetcher(url); } catch (e) { stats.failed.push({ url, reason: String(e.message ?? e).split('\n')[0] }); return null; }
    if (!a) { stats.failed.push({ url, reason: 'the site does not have it' }); return null; }
    const said = classify({ ...a, url });
    if (said.verdict === 'stop') { stats.stopped = { url, reason: said.why }; return null; }
    if (said.verdict === 'failed') { stats.failed.push({ url, reason: said.why }); return null; }
    stats.fetched.push(url);
    const headers = Object.fromEntries(Object.entries(a.headers ?? {}).filter(([k]) => !BODY_HEADERS_OUT.test(k)));
    return { status: a.status, headers, body: a.body ?? '' };
  };
  return {
    stats,
    onMiss(q) {
      const url = q.url();
      if (q.method() !== 'GET' || !/^https?:/.test(url) || !sameSite(url, home) || stats.stopped) return Promise.resolve(null);
      stats.asked++;
      if (!seen.has(url)) seen.set(url, pace(() => one(url)));   // two takes asking for one file make one fetch
      return seen.get(url);
    },
    /** The ledger's rows: nothing fetched here leaves the record. */
    rows() {
      const rows = [];
      if (stats.stopped) rows.push({ unit: 'request', id: stats.stopped.url, status: 'blocked', reason: `${stats.stopped.reason}: read-through stopped for this scan` });
      for (const f of stats.failed) rows.push({ unit: 'request', id: f.url, status: 'not-reached', reason: f.reason });
      for (const f of stats.refused) rows.push({ unit: 'request', id: f.url, status: 'refused', rule: f.reason });
      if (stats.overBudget) rows.push({ unit: 'request', id: 'read-through-budget', status: 'limit', name: 'read-through-budget', value: stats.overBudget, reason: `${stats.overBudget} requests came after the limit of ${maxFiles} files` });
      return rows;
    },
  };
}

/**
 * The only fetcher tonight: it answers from HAR files hidden from the recording, after a delay, so a sealed run can stand in for a site.
 * @param {string[]} harZips  the hidden extra-*.har.zip
 * @returns {(url:string)=>Promise<{status:number, headers:object, body:Buffer}|null>}
 */
export function simulatedFetcher(harZips, { delayMs = 300 } = {}) {
  const held = new Map();
  for (const file of harZips) {
    const { har, files } = parseHarZip(fs.readFileSync(file));
    for (const e of har.log?.entries ?? []) {
      const c = e.response?.content ?? {}, body = c._file ? files.get(c._file) : c.text != null ? Buffer.from(c.text, c.encoding === 'base64' ? 'base64' : 'utf8') : null;
      if (e.request?.method !== 'GET' || body == null) continue;
      held.set(e.request.url, { status: e.response.status, headers: Object.fromEntries((e.response.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])), body });
    }
  }
  return async (url) => { await new Promise((r) => setTimeout(r, delayMs)); return held.get(url) ?? null; };
}

/**
 * The live fetcher, for a WebGL experience's take only (S1 6 Nov, owner: a click-gated experience is waited for; its files go through
 * the site's per-host queue). Each file: robots.txt first, the host's turn (Crawl-delay or 500 ms), REVA's user agent; the bytes as sent.
 * The stop rule is readThrough's (classify): a 429, a 503 or a challenge ends read-through for the scan.
 * @param {{pacedFetch:(url:string, init?:object)=>Promise<Response>, robotsBlock:(url:string)=>Promise<object|null>}} policy  scan/polite.js
 */
export function liveFetcher(policy) {
  return async (url) => {
    if (await policy.robotsBlock(url)) return null;
    const r = await policy.pacedFetch(url);
    const headers = Object.fromEntries(r.headers.entries());
    // the README's stop rule: a 429, or a 503 with Retry-After, stops all traffic to the site, not only read-through
    if (r.status === 429 || (r.status === 503 && headers['retry-after'])) policy.stop?.({ why: `the site answered ${r.status}`, url, status: r.status });
    return { status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) };
  };
}
