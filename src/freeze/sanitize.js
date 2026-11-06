// HAR sanitiser (PLAN M4 freeze; port of the ARCH recipe harprep.py, W2G1-4 §2).
// Fixes the three replay traps that live in a recorded HAR:
//   T2 a request that was blocked or failed is stored as status -1/0; Playwright's replay then STALLS it forever and `load` never fires
//   T3 request-body files (`postData._file`) must travel with the entry, or a POST falls through to a miss
//   plus: secrets in request headers/cookies are redacted, duplicate (method,url,body) entries are collapsed.
import crypto from 'node:crypto';
import { readZip, writeZip } from './zip.js';

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
export const DEFAULT_REDACT = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token'];

const header = (list, name) => (list || []).find(h => h.name.toLowerCase() === name)?.value;

/** Parse a Playwright `content:'attach'` HAR zip. @returns {{har:object, files:Map<string,Buffer>}} */
export function parseHarZip(buf) {
  const files = readZip(buf);
  const raw = files.get('har.har');
  if (!raw) throw new Error('not a Playwright HAR zip: har.har is missing');
  files.delete('har.har');
  return { har: JSON.parse(raw.toString('utf8')), files };
}

export function packHarZip({ har, files }) {
  const names = [...files.keys()].sort();
  return writeZip([['har.har', Buffer.from(JSON.stringify(har))], ...names.map(n => [n, files.get(n)])]);
}

/** Body bytes of a request post-data / response content record, or null. */
function bodyOf(rec, files) {
  if (!rec) return null;
  if (rec._file) return files.get(rec._file) ?? null;
  if (rec.text !== undefined) return Buffer.from(rec.text, rec.encoding === 'base64' ? 'base64' : 'utf8');
  return null;
}

/** Response body bytes of an entry (file, inline text, or the recorded size when the body is not stored). */
export function bodyLen(e, files) {
  const c = e.response.content || {};
  if (c._file) return files.get(c._file)?.length ?? 0;
  if (c.text !== undefined) return c.text.length;
  return c.size > 0 ? c.size : 0;
}

export function entryKey(e, files) {
  const post = bodyOf(e.request.postData, files);
  return `${e.request.method} ${e.request.url} ${post ? sha256(post) : '-'}`;
}

/**
 * @param {{har:object, files:Map}} input  a parsed HAR zip
 * @param {{block?:RegExp|null, redact?:string[]}} [opts]
 * @returns {{har:object, files:Map<string,Buffer>, report:object}}
 */
export function sanitizeHar({ har, files }, { block = null, redact = DEFAULT_REDACT } = {}) {
  const redactSet = new Set(redact.map(s => s.toLowerCase()));
  const report = { entriesIn: har.log.entries.length, kept: 0, dropped: {}, problems: [], redactedHeaders: 0, redactedCookies: 0, postBodies: 0, bodies: 0, duplicates: 0, setCookieNames: [] };
  const drop = reason => { report.dropped[reason] = (report.dropped[reason] || 0) + 1; };
  const best = new Map(); // key -> entry
  const rank = e => (e.response.status === 200 ? 4 : e.response.status >= 200 && e.response.status < 300 ? 3 : e.response.status >= 300 && e.response.status < 400 ? 2 : 1);
  for (const e of har.log.entries) {
    const url = e.request.url, st = e.response.status;
    if (/^(data|blob|chrome-extension|about):/.test(url)) { drop('non-network-url'); continue; }
    if (st <= 0) { drop(block && block.test(url) ? 'status-1(blocked)' : 'status-1'); continue; } // T2
    if (block && block.test(url)) { drop('blocked-but-recorded'); continue; }
    const c = e.response.content || {};
    if (c._file && !files.has(c._file)) { report.problems.push(`response body file missing: ${c._file} for ${e.request.method} ${url}`); drop('body-file-missing'); continue; }
    const p = e.request.postData;
    if (p && p._file && !files.has(p._file)) { report.problems.push(`request body file missing: ${p._file} for ${url}`); drop('post-body-file-missing'); continue; } // T3
    const k = entryKey(e, files);
    const prev = best.get(k);
    if (prev) {
      report.duplicates++;
      // A later duplicate must not replace a real body with an empty one (a 0-byte retry once blanked a whole page); then status rank; then the later one wins.
      const be = bodyLen(e, files), bp = bodyLen(prev, files);
      if ((be === 0) !== (bp === 0) ? be === 0 : rank(e) < rank(prev)) { if (be === 0 && bp > 0) report.emptyDuplicatesDropped = (report.emptyDuplicatesDropped || 0) + 1; continue; }
    }
    best.set(k, e);
  }
  const keep = [], keptFiles = new Map();
  for (const e of best.values()) {
    for (const h of e.request.headers || []) if (redactSet.has(h.name.toLowerCase()) && h.value !== '[redacted]') { h.value = '[redacted]'; report.redactedHeaders++; }
    if (e.request.cookies?.length) { report.redactedCookies += e.request.cookies.length; e.request.cookies = []; }
    for (const h of e.response.headers || []) if (h.name.toLowerCase() === 'set-cookie') report.setCookieNames.push(h.value.split('=')[0]);
    const c = e.response.content || {};
    if (c._file) { keptFiles.set(c._file, files.get(c._file)); report.bodies++; }
    if (e.request.postData?._file) { keptFiles.set(e.request.postData._file, files.get(e.request.postData._file)); report.postBodies++; } // T3
    delete e.serverIPAddress; delete e._serverPort;
    keep.push(e);
  }
  report.kept = keep.length;
  report.setCookieNames = [...new Set(report.setCookieNames)];
  return { har: { ...har, log: { ...har.log, entries: keep } }, files: keptFiles, report };
}

/** Union of several sanitised HARs: one entry per (method, URL, body). The first HAR wins ties. */
export function mergeHars(list) {
  const seen = new Map(), files = new Map();
  let base = null;
  for (const { har, files: f } of list) {
    base ||= har;
    for (const e of har.log.entries) {
      const k = entryKey(e, f);
      if (!seen.has(k)) seen.set(k, e);
      for (const x of [e.response.content?._file, e.request.postData?._file]) if (x && f.has(x)) files.set(x, f.get(x));
    }
  }
  return { har: { ...base, log: { ...base.log, entries: [...seen.values()] } }, files };
}

export { bodyOf, sha256 };
