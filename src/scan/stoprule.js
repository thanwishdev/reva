// When a site says stop (DESIGN 3.7). Pure: an answer goes in, a word comes out, so the rule is the same for every fetcher.
// classify and pacer serve read-through; stopVerdict and hostPacer serve the live visit of a scan (src/scan/polite.js).
import { detectWall } from '../safety/wall.js';

/** Answers that mean the site does not want this traffic. Any one stops every fetch of the scan. */
const STOP_STATUS = new Set([403, 429, 503]);

/**
 * @param {{status:number, headers?:object, body?:string|Buffer|null, url?:string}} a  the answer; body may be cut short, the markers sit at the top
 * @returns {{verdict:'ok'|'failed'|'stop', why:string|null}}
 */
export function classify({ status, headers = {}, body = null, url = null }) {
  if (STOP_STATUS.has(status)) return { verdict: 'stop', why: `the site answered ${status}` };
  const type = String(headers['content-type'] ?? headers['Content-Type'] ?? '');
  if (body != null && (/html/i.test(type) || !type)) {
    const html = Buffer.isBuffer(body) ? body.subarray(0, 65536).toString('utf8') : String(body).slice(0, 65536);
    const w = detectWall({ status, html, headers, finalUrl: url });
    if (w?.kind === 'wall') return { verdict: 'stop', why: `the site showed a challenge (${w.marker ?? 'wall'})` };
  }
  if (!(status >= 200 && status < 400)) return { verdict: 'failed', why: `the site answered ${status}` };
  return { verdict: 'ok', why: null };
}

/**
 * One fetch at a time, at least gapMs between starts.
 * @returns {(job:()=>Promise<any>)=>Promise<any>}  queues the job; the result is the job's
 */
export function pacer(gapMs, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let tail = Promise.resolve(), last = -Infinity;
  return (job) => {
    const run = tail.then(async () => {
      const wait = last + gapMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
      return job();
    });
    tail = run.catch(() => {});
    return run;
  };
}

/** Retry-After in ms (seconds or an HTTP date), or null when absent or unreadable. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/**
 * The live visit's rule (owner go 3 Nov, item 3), for every answer of a scan's live visit, not only the first page:
 *   429 anywhere, or 503 with Retry-After          -> stop: the site asked for less traffic
 *   a page whose HTML is a challenge or bot wall    -> stop
 *   a page that is a login or region wall           -> wall: this page is not recorded (on the start page: stop)
 * A 403 or a 503 without Retry-After is not a stop by itself (S3 answers 403 for a missing file); a challenge says so in its HTML.
 * @param {{status:number, headers?:object, body?:string|Buffer|null, url?:string|null, document?:boolean, start?:boolean}} a
 * @returns {{verdict:'ok'|'stop'|'wall', why:string|null, retryAfterMs?:number|null, marker?:string}}
 */
export function stopVerdict({ status, headers = {}, body = null, url = null, document = false, start = false }) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const ra = retryAfterMs(h['retry-after']);
  const wait = ra != null ? ` and asked to wait ${Math.round(ra / 1000)} s` : '';
  if (status === 429) return { verdict: 'stop', why: `the site answered 429 Too Many Requests${wait}`, retryAfterMs: ra };
  if (status === 503 && ra != null) return { verdict: 'stop', why: `the site answered 503 Service Unavailable${wait}`, retryAfterMs: ra };
  if (!document || body == null) return { verdict: 'ok', why: null };
  const type = String(h['content-type'] ?? '');
  if (type && !/html/i.test(type)) return { verdict: 'ok', why: null };
  const html = Buffer.isBuffer(body) ? body.subarray(0, 262144).toString('utf8') : String(body).slice(0, 262144);
  const w = detectWall({ status, html, headers: h, finalUrl: url });
  if (!w) return { verdict: 'ok', why: null };
  if (w.kind === 'wall' && !/^status:/.test(w.marker)) return { verdict: 'stop', why: `the site showed a challenge or bot wall (${w.marker})`, marker: w.marker };
  if (w.kind === 'login' || w.kind === 'geo') {
    const what = w.kind === 'login' ? 'a login wall' : 'a region block';
    return { verdict: start ? 'stop' : 'wall', why: `the page is ${what} (${w.marker})`, marker: w.marker };
  }
  return { verdict: 'ok', why: null };
}

/**
 * One queue per host: a job starts at least gapOf(host, job) ms after the previous start on that host (gaps can differ per
 * job: REVA's own fetch to another site keeps the full gap, the page's own load of it a shorter one). A job here is the
 * permission to send, so the queue spaces starts; a job that awaits its answer also keeps the host to one at a time.
 */
export function hostPacer(gapOf, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const hosts = new Map(); // host -> { tail, last }
  const run = (host, job, kind) => {
    if (!hosts.has(host)) hosts.set(host, { tail: Promise.resolve(), last: -Infinity });
    const q = hosts.get(host);
    const p = q.tail.then(async () => {
      const wait = q.last + gapOf(host, kind) - now();
      if (wait > 0) await sleep(wait);
      q.last = now();
      return job();
    });
    q.tail = p.catch(() => {});
    return p;
  };
  return { run, last: (host) => hosts.get(host)?.last ?? null };
}
