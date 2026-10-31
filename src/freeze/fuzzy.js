// Volatile-URL fallback for archive replay (corpus F10/F32). A page builds some URLs from the clock or a random id
// (`?_=1792670327729`, `ts=...`, `cb=lzla3rlic3z1`, `sku=...`, `id=<uuid>`, a JSONP `callback=jQuery..._<ms>`), so the replayed URL never equals the recorded one
// and the HAR router misses it. This route runs AFTER the HARs (they get the exact match first) and BEFORE the catch-all miss
// logger: it answers from the recorded entry whose URL is equal once volatile query parameters are dropped (and, for a POST, only when the body is equal
// after blanking timestamps, nonces and uuids: different GraphQL bodies to one endpoint stay misses). Every such answer is logged in `net.fuzzy`, so it is never silent, and it is not counted as a miss.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseHarZip, bodyOf } from './sanitize.js';

// A query value is volatile only because of its parameter NAME (a cache-buster, timestamp or nonce). Never by value shape alone:
// ?sku=A and ?sku=B, ?id=<uuid-1> and ?id=<uuid-2> can be different things.
const VOLATILE_NAMES = new Set(['_', '_t', 'ts', 'cb', 'cachebust', 'cachebuster', 'nocache', 'rnd', 'rand', 'random', 'nonce', 'timestamp']);
const NUMERIC_NAMES = new Set(['t', 'v']); // volatile only when the value is a timestamp-sized number
const TIMESTAMPISH = /^\d{10,13}$/;
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Host-scoped names: `sku` is Mapbox's per-map-session billing token (the tile is identified by its path), but on a shop `?sku=A` is a product.
// 26 Oct: Stripe's third-party iframe documents (b.stripecdn.com/stripethirdparty-srv/.../PrivacyCompliance.html,
// GoogleTagManager.html, HCaptchaInvisible.html) carry a fresh uuid `id` per load (a postMessage channel id read from the
// iframe's own URL; the recorded bodies of different ids are byte-identical static HTML). Stored evidence: one corpus
// capture (20261023 full) misses.json, 8 render misses, all this shape. Scoped to that path and to a uuid value only.
// Entries: [host regex, names, {path?: prefix, value?: regex}]
const HOST_VOLATILE = [
  [/(^|\.)mapbox\.com$/i, new Set(['sku'])],
  [/^b\.stripecdn\.com$/i, new Set(['id']), { path: '/stripethirdparty-srv/', value: UUID_VALUE }],
];
// JSONP (26 Oct): a callback name the page library generates per request (jQuery `jQuery<digits>_<ms>`, `__jp<n>`,
// `jsonp<n>`) is volatile; the recorded body then calls the recorded name, so the answer rewrites that leading call to the
// replayed name (jsonpRewrite). Stored evidence: one corpus capture (20261023 full), a site-builder form host /index.php/form/getForm
// `callback=jQuery371..._<ms>`, 2 render misses.
const JSONP_NAMES = new Set(['callback', 'jsonp', 'jsoncallback']);
const JSONP_VALUE = /^(jQuery\d+_\d+|__jp\d+|jsonp\d+)$/;
const isJsonpParam = (k, v) => JSONP_NAMES.has(k.toLowerCase()) && JSONP_VALUE.test(v);
const isVolatileParam = (k, v, host = '', pathname = '') => {
  const n = k.toLowerCase();
  return VOLATILE_NAMES.has(n) || (NUMERIC_NAMES.has(n) && TIMESTAMPISH.test(v)) || isJsonpParam(k, v)
    || HOST_VOLATILE.some(([re, names, o]) => names.has(n) && re.test(host) && (!o?.path || pathname.startsWith(o.path)) && (!o?.value || o.value.test(v)));
};

/** The JSONP callback of a URL ({name, value}) when it is a generated (volatile) one, else null. */
export function jsonpCallback(url) {
  let u; try { u = new URL(url); } catch { return null; }
  for (const [k, v] of u.searchParams) if (isJsonpParam(k, v)) return { name: k, value: v };
  return null;
}

/**
 * Body for a replayed JSONP request answered from a recorded one: the recorded body's leading call `<old>(` becomes
 * `<new>(`. Only when the body starts with exactly that call (else null: the answer would call a function the page never
 * defined, so the request stays a miss). Non-JSONP pairs return the body unchanged.
 */
export function jsonpRewrite(recordedUrl, replayedUrl, body) {
  const a = jsonpCallback(recordedUrl), b = jsonpCallback(replayedUrl);
  if (!a && !b) return body;
  if (!a || !b || a.name !== b.name) return null;
  if (a.value === b.value) return body;
  const head = Buffer.from(a.value + '(');
  if (!body || body.length < head.length || !body.subarray(0, head.length).equals(head)) return null;
  return Buffer.concat([Buffer.from(b.value + '('), body.subarray(head.length)]);
}

/** URL with volatile query parameters removed and the rest sorted; null for a URL that cannot be parsed. */
export function volatileKey(url) {
  let u; try { u = new URL(url); } catch { return null; }
  const keep = [];
  for (const [k, v] of u.searchParams) if (!isVolatileParam(k, v, u.hostname, u.pathname)) keep.push([k, v]);
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return `${u.origin}${u.pathname}?${keep.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

const BODY_VOLATILE_KEYS = new Set(['ts', 'timestamp', 'time', 'nonce', 'rnd', 'rand', 'random', '_t', 'cb', 'sentat', 'sent_at', 'clienttime', 'client_time', 'requestid', 'request_id', 'uuid']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scrub = v => {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = BODY_VOLATILE_KEYS.has(k.toLowerCase()) ? '~' : scrub(v[k]); return o; }
  if (typeof v === 'number' && v >= 1e9 && v < 1e14 && Number.isInteger(v)) return '~'; // epoch seconds / ms
  if (typeof v === 'string' && UUID.test(v)) return '~';
  return v;
};
/** Stable text of a request body: JSON and form bodies with only timestamps / nonces / uuids blanked; anything else is itself. */
export function bodyKey(buf) {
  const text = buf ? buf.toString('utf8') : '';
  if (!text) return '';
  try { return 'j' + JSON.stringify(scrub(JSON.parse(text))); } catch {}
  if (/^[^=&]+=[^&]*(&[^=&]+=[^&]*)*$/.test(text)) {
    try { const p = [...new URLSearchParams(text)].map(([k, v]) => [k, BODY_VOLATILE_KEYS.has(k.toLowerCase()) || UUID.test(v) ? '~' : v]).sort(); return 'f' + JSON.stringify(p); } catch {}
  }
  return 'r' + text;
}
const entryBodyKey = (method, buf) => (method === 'GET' || method === 'HEAD' ? '' : '#' + crypto.createHash('sha256').update(bodyKey(buf)).digest('hex'));

const DROP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

/**
 * buildFuzzyIndex, memoised per process (S-SPEED #8, 27 Oct): every gate session (capture, states) and replay check of a
 * site rebuilt the same index from the same two HAR zips (20-216 ms each, measured). The key is every path with its
 * size, mtime (ns) and inode, or "-" for a missing file, so a rewritten or replaced archive (freeze's v2 renamed over
 * v1) builds anew. The index is only read (Map.get; bodies go to route.fulfill as they are), so sharing it is exact.
 * At most FUZZY_MEMO_MAX indexes are kept (oldest dropped). REVA_FUZZY_MEMO=0: built every time, as before.
 */
const FUZZY_MEMO_MAX = 4;
const fuzzyMemo = new Map();
export function fuzzyIndexKey(harPaths) {
  return JSON.stringify([...harPaths].map(p => { try { const s = fs.statSync(p, { bigint: true }); return [p, String(s.size), String(s.mtimeNs), String(s.ino)]; } catch { return [p, '-']; } }));
}
export function fuzzyIndexFor(harPaths) {
  if (process.env.REVA_FUZZY_MEMO === '0') return buildFuzzyIndex(harPaths);
  const k = fuzzyIndexKey(harPaths);
  let idx = fuzzyMemo.get(k);
  if (idx) { fuzzyMemo.delete(k); fuzzyMemo.set(k, idx); return idx; } // most recent last
  idx = buildFuzzyIndex(harPaths);
  if (fuzzyIndexKey(harPaths) !== k) return idx; // a file changed while it was read: do not keep it
  fuzzyMemo.set(k, idx);
  while (fuzzyMemo.size > FUZZY_MEMO_MAX) fuzzyMemo.delete(fuzzyMemo.keys().next().value);
  return idx;
}

/** Index of the entries in the given HAR zips (least specific first; a later HAR wins). Map "METHOD key" -> response record. */
export function buildFuzzyIndex(harPaths) {
  const idx = new Map();
  for (const p of [...harPaths].reverse()) {
    if (!fs.existsSync(p)) continue;
    let parsed; try { parsed = parseHarZip(fs.readFileSync(p)); } catch { continue; }
    const { har, files } = parsed;
    for (const e of har.log.entries) {
      const k = volatileKey(e.request.url); if (!k || e.response.status <= 0) continue;
      // a POST whose recorded body is gone is a damaged archive entry: it must stay a miss, not be papered over (trap 3)
      if (e.request.postData) { const pb = bodyOf(e.request.postData, files); if (pb == null || (!pb.length && e.request.bodySize > 0)) continue; }
      const key = `${e.request.method} ${k}${entryBodyKey(e.request.method, e.request.postData ? bodyOf(e.request.postData, files) : null)}`;
      const prev = idx.get(key);
      if (prev && !(prev.status !== 200 && e.response.status === 200)) continue;
      const body = bodyOf(e.response.content, files);
      idx.set(key, {
        status: e.response.status,
        headers: Object.fromEntries((e.response.headers || []).filter(h => !DROP_HEADERS.has(h.name.toLowerCase())).map(h => [h.name, h.value])),
        body: body || Buffer.alloc(0), url: e.request.url,
      });
    }
  }
  return idx;
}

/**
 * Register the fuzzy fallback. Call it BEFORE routeFromHAR (Playwright runs the most recently registered route first) and
 * AFTER the catch-all, so the order is: HARs, then this, then the catch-all.
 * @returns {Promise<Array<{method:string,url:string,matched:string}>>} the log of answers given
 */
export async function installFuzzyFallback(ctx, harPaths) {
  const idx = fuzzyIndexFor(harPaths), log = [];
  if (!idx.size) return log;
  await ctx.route(() => true, route => {
    const r = route.request(), k = volatileKey(r.url());
    const hit = k && idx.get(`${r.method()} ${k}${entryBodyKey(r.method(), r.postDataBuffer())}`);
    if (!hit) return route.fallback();
    const body = jsonpRewrite(hit.url, r.url(), hit.body);
    if (body == null) return route.fallback(); // a JSONP body that does not start with the recorded call: stays a miss
    log.push({ method: r.method(), url: r.url().slice(0, 300), matched: hit.url.slice(0, 300), ...(body !== hit.body ? { jsonp: { from: jsonpCallback(hit.url).value, to: jsonpCallback(r.url()).value } } : {}) });
    return route.fulfill({ status: hit.status, headers: hit.headers, body });
  });
  return log;
}
