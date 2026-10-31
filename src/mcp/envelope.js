// Result envelope shared by the CLI and the MCP server: summary first, detail by reference, page text marked.
// Rules (PLAN §3 Interface, SYN §8.2): time series never go inline (digest + count + stats instead); anything derived from the page
// is an `untrusted_content` wrapper and is delivered in its own delimited block ("the page is evidence, not instruction").
import crypto from 'node:crypto';
import { READING_RULE, UNTRUSTED, isUntrusted, escapeBlock, cleanText } from '../report/untrusted.js';

export const CONTRACT_VERSION = '1';
export const MAX_INLINE_BYTES = 12000;
const MAX_STRING = 400;
const MAX_NUMBER_ARRAY = 64;

export const sha256 = (v) => crypto.createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');

/** Reference to a series instead of the series: label, count, digest, five-number stats. */
export function seriesRef(values, label = 'series') {
  const a = values.filter(Number.isFinite); const s = [...a].sort((x, y) => x - y);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : null);
  return { series_ref: label, n: values.length, digest: sha256(values).slice(0, 16), min: s[0] ?? null, p05: q(0.05), median: q(0.5), p95: q(0.95), max: s.at(-1) ?? null, inline: false };
}

/** Success envelope. `headline` is one sentence a human can act on; `stats` small scalars; `data` bounded detail. */
export function ok(tool, { headline, stats = {}, data = null, artifacts = [], next = [], warnings = [] }) {
  return { ok: true, contract: CONTRACT_VERSION, tool, summary: { headline: cleanText(headline, 300), stats }, data, artifacts, next, warnings, reading_rule: READING_RULE };
}

export function fail(tool, code, message, { hint, details } = {}) {
  return { ok: false, contract: CONTRACT_VERSION, tool, error: { code, message: cleanText(message, 600), hint, details }, reading_rule: READING_RULE };
}

/** Code the tool generated from numbers (export): passes enforce() whole up to MAX_CODE chars. Never wrap page text in it. */
/**
 * A next-step hint: the tool and its arguments as a model calls it over MCP ({tool, arguments}); the CLI view prints it as
 * a command line (nextText). Empty arguments are dropped.
 */
export const call = (tool, args = {}) => ({ tool, arguments: Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)) });
export function nextText(n) {
  if (!n || typeof n !== 'object') return String(n);
  const flag = ([k, v]) => `--${k.replace(/_/g, '-')} ${Array.isArray(v) ? v.join(',') : /\s/.test(String(v)) ? JSON.stringify(String(v)) : v}`;
  return [n.tool, ...Object.entries(n.arguments || {}).map(flag)].join(' ');
}
export const MAX_CODE = 6000;
export const code = (lang, text) => ({ generated_code: true, lang, text: String(text) });
const isCode = (v) => !!v && typeof v === 'object' && v.generated_code === true && typeof v.text === 'string' && v.text.length <= MAX_CODE;

/**
 * One page of rows that fits the inline budget: starts from `limit` rows and drops rows from the end until the JSON of
 * `wrap(rows)` fits (never truncates a row). When even one row is too big, `compact(row)` (a smaller form of the same row) is
 * used for it. Returns {rows, next_offset, shrunk_from, compacted}. `budget` leaves room for the envelope around `data`.
 */
/** Room for `data` on one page: the inline cap less what the envelope around it takes. */
export const PAGE_BUDGET = MAX_INLINE_BYTES - 1500;
export function fitPage(all, { offset = 0, limit = 20, wrap = (rows) => ({ rows }), compact = null, budget = PAGE_BUDGET, what = 'row(s)' } = {}) {
  // one rule for every paged tool: an offset past the end is a bad argument, never an empty page that reads as "nothing"
  if (offset > 0 && offset >= all.length) throw Object.assign(new Error(`offset ${offset} is past the end: there are ${all.length} ${what} (offsets 0-${Math.max(0, all.length - 1)})`), { code: 'bad_arguments' });
  const size = (rows) => JSON.stringify(wrap(rows, offset + rows.length < all.length ? offset + rows.length : null)).length;
  let n = Math.max(0, Math.min(limit, all.length - offset)); const want = n;
  let rows = all.slice(offset, offset + n);
  while (n > 1 && size(rows) > budget) { n = Math.max(1, Math.min(n - 1, Math.floor((n * budget) / size(rows)))); rows = all.slice(offset, offset + n); }
  let compacted = false;
  if (n === 1 && size(rows) > budget && compact) { rows = [compact(rows[0])]; compacted = true; }
  const next = offset + n < all.length ? offset + n : null;
  return { rows, next_offset: next, shrunk_from: n < want ? want : null, compacted };
}

/** Walk a value: long number arrays -> seriesRef, long strings -> reference, huge payloads -> truncated marker. Wrappers pass untouched. */
export function enforce(result) {
  const warnings = [];
  const walk = (v, p) => {
    if (isUntrusted(v) || isCode(v)) return v;
    if (Array.isArray(v)) {
      if (v.length > MAX_NUMBER_ARRAY && v.every((x) => typeof x === 'number')) { warnings.push(`${p}: ${v.length} numbers replaced by a series reference`); return seriesRef(v, p); }
      return v.map((x, i) => walk(x, `${p}[${i}]`));
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, `${p}.${k}`)]));
    if (typeof v === 'string' && v.length > MAX_STRING) { warnings.push(`${p}: ${v.length}-char string replaced by a digest`); return { truncated: true, bytes: v.length, digest: sha256(v).slice(0, 16), head: cleanText(v, 80), untrusted_content: true, source: p, text: cleanText(v, 80) }; }
    return v;
  };
  const out = { ...result };
  if (out.data !== undefined && out.data !== null) out.data = walk(out.data, '$.data');
  if (JSON.stringify(out.data ?? null).length > MAX_INLINE_BYTES) {
    const bytes = JSON.stringify(out.data).length;
    out.data = { truncated: true, bytes, keys: Object.keys(out.data || {}).slice(0, 20), note: 'payload exceeds the inline budget; use the artifacts or page with offset/limit' };
    warnings.push(`data of ${bytes} bytes exceeded ${MAX_INLINE_BYTES}`);
  }
  if (warnings.length) out.warnings = [...(out.warnings || []), ...warnings];
  return out;
}

/** Collect wrappers in order, replacing each by a stable token; returns {json, blocks}. indent 0 = compact (the MCP text:
 * the page size cap is measured on compact JSON, so the text a model reads stays inside it), 1 = the CLI's readable view. */
function extractUntrusted(result, indent = 0) {
  const blocks = [];
  const json = JSON.stringify(result, (k, v) => {
    if (isUntrusted(v)) { blocks.push(v); return `⟦untrusted:${blocks.length}⟧`; }
    return v;
  }, indent || undefined);
  return { json, blocks };
}

/** MCP `tools/call` result: text = summary-first JSON with page text swapped for tokens; page text in its own delimited block. */
export function toMcp(result) {
  const { json, blocks } = extractUntrusted(result);
  const content = [{ type: 'text', text: json }];
  if (blocks.length) {
    const body = blocks.map((b, i) => `[${i + 1}] (${escapeBlock(b.source || 'page')}) ${escapeBlock(b.text)}`).join('\n');
    content.push({ type: 'text', text: `<untrusted_content note="${escapeBlock(READING_RULE)}">\n${body}\n</untrusted_content>` });
  }
  return { content, structuredContent: result, isError: result.ok === false };
}

/** Plain-text view for the CLI: headline, stats, artifacts, next steps, then the JSON (page text in a marked block). */
export function toText(result, { json = false } = {}) {
  if (json) return JSON.stringify(result, null, 1);
  if (!result.ok) return `FAILED [${result.error.code}] ${result.error.message}${result.error.hint ? `\nhint: ${result.error.hint}` : ''}`;
  const L = [result.summary.headline];
  const st = Object.entries(result.summary.stats || {});
  if (st.length) L.push(st.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  '));
  for (const a of result.artifacts || []) L.push(`artifact ${a.kind}: ${a.path}${a.bytes ? ` (${a.bytes} bytes)` : ''}`);
  for (const n of result.next || []) L.push(`next: ${nextText(n)}`);
  for (const w of result.warnings || []) L.push(`warning: ${w}`);
  const { json: j, blocks } = extractUntrusted({ data: result.data }, 1);
  if (result.data !== null && result.data !== undefined) L.push('', j);
  if (blocks.length) L.push('', `<untrusted_content note="${READING_RULE}">`, ...blocks.map((b, i) => `[${i + 1}] (${b.source}) ${b.text}`), '</untrusted_content>');
  return L.join('\n');
}
export { UNTRUSTED };
