// URL completion (PLAN M4 freeze, SYN §7.4 trap 1: "a recording is not a closure").
// A scroll recording misses URLs that page code builds from templates (on a real site, many image URLs are built by one function and only a few are recorded).
// This pass reads the CODE in the recorded bodies (not a guess about the site) and derives what that code can request:
//   literals   '/img/a.svg', url(x.png), src="..."          -> candidate, provenance inferred
//   templates  `/img/${slug}-${w}.svg`, '/img/' + k + '.svg' -> expanded when every hole has a domain, else listed UNKNOWN (H6)
// Hole domains come from (declared) the freeze config, or (inferred) literal arrays / loop bindings / ternaries / call-site
// arguments in the same file. Nothing is guessed: an unresolved hole becomes an `unk_url_*` entry with the probe that would resolve it.
// This is a static heuristic, not a JS evaluator; the miss-driven round (freeze.js) and the replay check are the safety net.

export const ASSET_EXT = ['js', 'mjs', 'css', 'json', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'mp3', 'ogg', 'wav', 'wasm', 'txt'];
const EXT_RE = new RegExp(`\\.(${ASSET_EXT.join('|')})(?:[?#].*)?$`, 'i');
const MAX_COMBOS = 256;

const isIdent = s => /^[A-Za-z_$][\w$]*$/.test(s);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseLiteral(s) {
  s = s.trim();
  let m;
  if ((m = /^'((?:\\.|[^'\\\n])*)'$/.exec(s)) || (m = /^"((?:\\.|[^"\\\n])*)"$/.exec(s))) return m[1];
  if ((m = /^`([^`$\\]*)`$/.exec(s))) return m[1];
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  return null;
}

/** Index of the bracket matching code[open], skipping strings. -1 if none. */
function matching(code, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') { for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++; continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') { if (stack.pop() !== c) return -1; if (!stack.length) return i; }
  }
  return -1;
}

/** Split `s` on top-level commas (outside brackets and strings). */
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { let j = i + 1; for (; j < s.length && s[j] !== c; j++) if (s[j] === '\\') j++; cur += s.slice(i, j + 1); i = j; continue; }
    if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

/** Literal values of `const NAME = [ ... ]` / `NAME: [ ... ]` (null unless every element is a literal). */
function findArray(code, name) {
  const re = new RegExp(`(?:(?:const|let|var)\\s+${esc(name)}\\s*=|\\b${esc(name)}\\s*[:=])\\s*\\[`, 'g');
  let m;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1, close = matching(code, open);
    if (close < 0) continue;
    const vals = splitTop(code.slice(open + 1, close)).map(parseLiteral);
    if (vals.length && vals.every(v => v !== null)) return vals;
  }
  return null;
}

/** Literals of `cond ? A : B` (one level) or a bare literal. */
function literalsOf(expr) {
  expr = expr.trim().replace(/;$/, '').replace(/^\((.*)\)$/s, '$1').trim();
  const lit = parseLiteral(expr);
  if (lit !== null) return [lit];
  const q = expr.lastIndexOf('?');
  if (q > 0) {
    const rest = expr.slice(q + 1), c = rest.lastIndexOf(':');
    if (c > 0) { const a = literalsOf(rest.slice(0, c)), b = literalsOf(rest.slice(c + 1)); if (a && b) return [...a, ...b]; }
  }
  return null;
}

/** Every function definition in code, in scan order (r1..r4 matches), keyword names left out: [{fn, index, params}]. */
function allFunctionDefs(code) {
  const defs = [];
  const add = (fn, params, index) => { if (fn && !/^(if|for|while|switch|catch|function|return)$/.test(fn)) defs.push({ fn, index, params: splitTop(params).map(p => p.replace(/\s*=.*$/s, '').trim()) }); };
  let m;
  const r1 = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g; while ((m = r1.exec(code))) add(m[1], m[2], m.index);
  const r2 = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g; while ((m = r2.exec(code))) add(m[1], m[2], m.index);
  const r3 = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>/g; while ((m = r3.exec(code))) add(m[1], m[2], m.index);
  const r4 = /(?:^|[\s,{;])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm; while ((m = r4.exec(code))) add(m[1], m[2], m.index);
  return defs;
}

/** Function definitions that take `name` as a parameter and start before `pos`: [{fn, index, params}] closest first.
 *  The scan order is kept before the (stable) sort, so ties come out as they always did. */
function enclosingFunctions(code, name, pos, memo = null) {
  const all = memoGet(memo, 'defs', () => allFunctionDefs(code));
  return all.filter(d => d.index < pos && d.params.includes(name)).sort((a, b) => b.index - a.index);
}

/** Per-file memo of resolveHole's whole-file lookups (S-SPEED #7): each depends only on (code, name), never on the use
 *  site, and minified code asks for the same one-letter names over and over (stripe: the `.map(` loop regex for `a` and
 *  `t` was 3.1 of the 7 s left after chainMatches). A fresh memo per file; REVA_COMPLETE_FAST=0: no memo. */
const memoGet = (memo, key, fn) => { if (!memo) return fn(); if (memo.has(key)) return memo.get(key); const v = fn(); memo.set(key, v); return v; };

/** Top-level argument texts of every call `fn(...)` in code (definitions excluded). */
function callSites(code, fn) {
  const out = [];
  const re = new RegExp(`\\b${esc(fn)}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(code))) {
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    const open = m.index + m[0].length - 1, close = matching(code, open);
    if (close < 0) continue;
    if (/^\s*\{/.test(code.slice(close + 1, close + 4))) continue; // method-shorthand definition
    out.push({ args: splitTop(code.slice(open + 1, close)), pos: m.index });
  }
  return out;
}

/**
 * Resolve the domain of one template hole.
 * @returns {{values:string[], how:string, provenance:'declared'|'inferred'} | {reason:string}}
 */
export function resolveHole(expr, code, pos, domains = {}, depth = 3, memo = null) {
  expr = expr.trim();
  if (domains[expr]) return { values: domains[expr].map(String), how: 'config domains', provenance: 'declared' };
  const direct = literalsOf(expr);
  if (direct) return { values: [...new Set(direct)], how: 'literal at the use site', provenance: 'inferred' };
  if (!isIdent(expr)) return { reason: `hole "${expr}" is a runtime expression` };
  if (depth <= 0) return { reason: `hole "${expr}": resolution too deep` };
  const arrOf = name => memoGet(memo, `a:${name}`, () => findArray(code, name)); // read only below (spread into a Set)
  const arr = arrOf(expr);
  if (arr) return { values: [...new Set(arr)], how: `array literal ${expr}`, provenance: 'inferred' };
  const loopSrc = memoGet(memo, `l:${expr}`, () => {
    const loop = new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+${esc(expr)}\\s+of\\s+([\\w$.]+|\\[[^\\]]*\\])\\s*\\)`).exec(code)
      || new RegExp(`([\\w$.]+)\\.(?:map|forEach|flatMap|filter)\\(\\s*\\(?\\s*${esc(expr)}\\b`).exec(code);
    return loop ? loop[1] : null;
  });
  if (loopSrc !== null) {
    const src = loopSrc;
    if (src.startsWith('[')) { const v = splitTop(src.slice(1, -1)).map(parseLiteral); if (v.every(x => x !== null)) return { values: [...new Set(v)], how: 'loop over a literal array', provenance: 'inferred' }; }
    else { const a = arrOf(src.split('.').pop()); if (a) return { values: [...new Set(a)], how: `loop variable over ${src}`, provenance: 'inferred' }; }
  }
  const init = memoGet(memo, `i:${expr}`, () => { const m = new RegExp(`\\b(?:const|let|var)\\s+${esc(expr)}\\s*=\\s*([^;\\n]+)`).exec(code); return m ? m[1] : null; });
  if (init !== null) {
    const v = literalsOf(init);
    if (v) return { values: [...new Set(v)], how: `initializer of ${expr}`, provenance: 'inferred' };
  }
  const defs = enclosingFunctions(code, expr, pos, memo);
  if (defs.length) {
    const { fn, params } = defs[0], idx = params.indexOf(expr);
    const sites = memoGet(memo, `c:${fn}`, () => callSites(code, fn));
    if (!sites.length) return { reason: `parameter "${expr}" of ${fn}(): no call site found in this file` };
    const vals = new Set(); let prov = 'inferred';
    for (const s of sites) {
      const arg = s.args[idx];
      if (arg === undefined) return { reason: `${fn}() is called without argument ${idx + 1}` };
      const r = resolveHole(arg, code, s.pos, domains, depth - 1, memo);
      if (r.reason) return { reason: `${fn}(${arg}): ${r.reason}` };
      r.values.forEach(v => vals.add(v)); if (r.provenance === 'declared') prov = 'declared';
    }
    return { values: [...vals], how: `call sites of ${fn}()`, provenance: prov };
  }
  return { reason: `hole "${expr}" has no literal domain in this file` };
}

const TERM = String.raw`(?:'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|[A-Za-z_$][\w$.]*(?:\([^()]*\))?)`;
const CHAIN_RE = new RegExp(String.raw`(?:'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")(?:\s*\+\s*${TERM})+`, 'g');
const TERM_RE = new RegExp(TERM, 'g');
const TEMPLATE_RE = /`((?:\\.|\$\{[^}]*\}|[^`\\])*)`/g;
const TAIL_Y = new RegExp(String.raw`(?:\s*\+\s*${TERM})+`, 'y'); // CHAIN_RE after its leading literal
const isLineTerm = c => c === 10 || c === 13 || c === 0x2028 || c === 0x2029; // what `.` does not match

/**
 * The matches of CHAIN_RE's global exec loop over `code`, in the same order with the same index and text (S-SPEED #7,
 * 27 Oct). The global regex tries every quote character as a start; where that quote's string literal never closes on
 * its line it scans to the end of the line first, so a long minified line with many quotes cost O(quotes x line):
 * measured 21.6 s for one 4 MB bundle of a payments-docs site (373k `"`, 2 lines), 95 % of that site's 69 s completion analysis.
 * Exact by construction:
 *  - CHAIN_RE = literal + TAIL. The literal's token scan has one way through (an escape pair `\\.` or one plain character;
 *    neither can match the quote or `\`), so from a start quote it either closes at one position q or fails, and the
 *    match is then the literal + the first successful path of TAIL at q + 1 (nothing follows TAIL in the pattern).
 *  - one right-to-left pass gives every quote's q (rolling: the scan from i is decided by s[i] and the scans from
 *    i + 1 / i + 2); TAIL depends on q only, so it runs once per q (sticky, memoised).
 *  - a match can only start at a quote; trying the starts in ascending order from the last match's end finds the
 *    leftmost match, exactly as exec does from lastIndex.
 * Returns [{0: text, index}] (extractTemplates reads only these). REVA_COMPLETE_FAST=0: the plain global exec loop.
 */
export function chainMatches(code) {
  const out = [];
  let m;
  if (process.env.REVA_COMPLETE_FAST === '0') { CHAIN_RE.lastIndex = 0; while ((m = CHAIN_RE.exec(code))) out.push(m); return out; }
  const n = code.length, starts = [], closes = [];
  // e1x/e2x: where the literal token scan for quote x (s = ', d = ") started at i + 1 / i + 2 closes (-1: it fails)
  let e1s = -1, e2s = -1, e1d = -1, e2d = -1;
  for (let i = n - 1; i >= 0; i--) {
    const c = code.charCodeAt(i);
    if (c === 39 && e1s >= 0) { starts.push(i); closes.push(e1s); }
    else if (c === 34 && e1d >= 0) { starts.push(i); closes.push(e1d); }
    let es, ed;
    if (c === 10) { es = -1; ed = -1; } // [^'\\\n]: a newline ends the literal unclosed
    else if (c === 92) { const ok = i + 1 < n && !isLineTerm(code.charCodeAt(i + 1)); es = ok ? e2s : -1; ed = ok ? e2d : -1; }
    else { es = c === 39 ? i : e1s; ed = c === 34 ? i : e1d; }
    e2s = e1s; e1s = es; e2d = e1d; e1d = ed;
  }
  const tailEnd = new Map(); // q -> end of TAIL at q + 1, or -1
  let last = 0;
  for (let j = starts.length - 1; j >= 0; j--) { // ascending start positions
    const p = starts[j];
    if (p < last) continue;
    const q = closes[j];
    let end = tailEnd.get(q);
    if (end === undefined) { TAIL_Y.lastIndex = q + 1; const t = TAIL_Y.exec(code); end = t ? q + 1 + t[0].length : -1; tailEnd.set(q, end); }
    if (end < 0) continue;
    const r = [code.slice(p, end)]; r.index = p;
    out.push(r); last = end;
  }
  return out;
}

/**
 * The matches of TEMPLATE_RE's global exec loop over `code` (same order, index, m[1]) without its backtracking blow-up
 * (S-SPEED #7, 27 Oct). The body `(?:\\.|\$\{[^}]*\}|[^`\\])*` can read `${...}` two ways (as one hole token, or `$` as
 * a plain character), so a backtick that never closes makes the engine try every combination: one 572 KB cmp2ui-en.js
 * (a wheel-spinner site, 9 backticks) never finished, and that freeze stalled in production after `v1 sealed`.
 * Exact by construction: from body position p the engine's first successful path depends on p only:
 *   `\` + a character that is not a line terminator -> continue at p + 2 (else fail);
 *   `${` with a `}` at q (the first one after it)  -> the path from q + 1 first, else `$` as a plain character (p + 1);
 *   a backtick -> the match closes at p;  any other character -> p + 1;  end of input -> fail.
 * So close(p) is computed once per position, right to left (it only reads positions > p), and a match starts at the
 * first backtick at or after the last match's end whose body closes, as exec's leftmost search does.
 * Returns [{0: text, 1: body, index}]. REVA_COMPLETE_FAST=0: the plain global exec loop.
 */
export function templateMatches(code) {
  const out = [];
  let m;
  if (process.env.REVA_COMPLETE_FAST === '0') { TEMPLATE_RE.lastIndex = 0; while ((m = TEMPLATE_RE.exec(code))) out.push(m); return out; }
  if (code.indexOf('`') < 0) return out;
  const n = code.length, close = new Int32Array(n + 1).fill(-1); // close[p]: closing backtick of a body starting at p
  let nextBrace = -1; // first '}' at or after i + 2 while computing position i
  for (let i = n - 1; i >= 0; i--) {
    const c = code.charCodeAt(i);
    if (i + 2 < n && code.charCodeAt(i + 2) === 125) nextBrace = i + 2; // '}'
    if (c === 96) close[i] = i; // '`'
    else if (c === 92) close[i] = i + 1 < n && !isLineTerm(code.charCodeAt(i + 1)) && i + 2 <= n ? close[i + 2] : -1; // '\'
    else if (c === 36 && i + 1 < n && code.charCodeAt(i + 1) === 123 && nextBrace >= 0) { const a = close[nextBrace + 1]; close[i] = a >= 0 ? a : close[i + 1]; } // '${'
    else close[i] = close[i + 1];
  }
  for (let p = code.indexOf('`'); p >= 0; p = code.indexOf('`', p + 1)) {
    const e = close[p + 1];
    if (e < 0) continue;
    const r = [code.slice(p, e + 1), code.slice(p + 1, e)]; r.index = p;
    out.push(r); p = e;
  }
  return out;
}

/** Template literals and string-concatenation chains with at least one hole. @returns {{parts:Array, index:number, text:string}[]} */
export function extractTemplates(code) {
  const out = [];
  let m;
  for (m of templateMatches(code)) {
    if (!m[1].includes('${')) continue;
    const parts = []; let last = 0, h;
    const hr = /\$\{([^}]*)\}/g;
    while ((h = hr.exec(m[1]))) { if (h.index > last) parts.push({ s: m[1].slice(last, h.index) }); parts.push({ h: h[1].trim() }); last = hr.lastIndex; }
    if (last < m[1].length) parts.push({ s: m[1].slice(last) });
    out.push({ parts, index: m.index, text: '`' + m[1] + '`' });
  }
  for (m of chainMatches(code)) {
    const parts = [];
    for (const t of m[0].match(TERM_RE)) { const lit = parseLiteral(t); parts.push(lit !== null && /^['"]/.test(t) ? { s: lit } : { h: t }); }
    if (parts.some(p => p.h)) out.push({ parts, index: m.index, text: m[0] });
  }
  return out;
}

const displayOf = parts => parts.map(p => (p.s !== undefined ? p.s : '${' + p.h + '}')).join('');
const staticHead = parts => (parts[0]?.s ?? '');

function acceptTemplate(parts) {
  const head = staticHead(parts);
  if (!(/^\/(?!\/)/.test(head) || /^https?:\/\//.test(head))) return null;
  const tail = [...parts].reverse().find(p => p.s !== undefined && !parts.slice(parts.indexOf(p) + 1).some(q => q.h !== undefined))?.s ?? '';
  if (EXT_RE.test(tail)) return 'asset';
  if (/^\/(api|graphql|v\d+)(\/|$)/.test(head)) return 'api';
  return null;
}

function looksLikeAssetUrl(s) {
  if (s.length > 300 || /\s/.test(s) || s.includes('${')) return false;
  if (!/^(\/(?!\/)|\.\.?\/|https?:\/\/|\/\/)/.test(s)) return false;
  return EXT_RE.test(s);
}

function* literalsIn(text, kind) {
  let m;
  if (kind === 'css') {
    const re = /url\(\s*(["']?)([^)"']+)\1\s*\)/g;
    while ((m = re.exec(text))) yield { s: m[2].trim(), index: m.index };
  }
  if (kind === 'html') {
    const re = /\b(?:src|href|poster|data-src|data-srcset|srcset)\s*=\s*(["'])(.*?)\1/gis;
    while ((m = re.exec(text))) {
      const attr = /srcset/i.test(m[0].split('=')[0]);
      for (const part of attr ? m[2].split(',').map(x => x.trim().split(/\s+/)[0]) : [m[2]]) yield { s: part.trim(), index: m.index };
    }
  }
  const re = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g; // quoted strings (JS, also inline JS/CSS inside HTML)
  while ((m = re.exec(text))) yield { s: m[2], index: m.index };
}

/**
 * @param {object} o
 * @param {{url:string, contentType:string, text:string}[]} o.files  code-like response bodies from the recording
 * @param {string} o.documentOrigin                                 origin of the start URL (resolves rooted strings)
 * @param {Set<string>} o.have                                      every URL already in the HAR (any status)
 * @param {RegExp|null} [o.block]                                   telemetry block list: never a candidate
 * @param {Object<string,string[]>} [o.domains]                     declared hole domains, by hole expression
 * @returns {{candidates:object[], unknown:object[], scanned:object}}
 */
export function analyseCompletion({ files, documentOrigin, have, block = null, domains = {} }) {
  const cand = new Map(), unknown = [];
  let bytes = 0, scannedFiles = 0, ukn = 0;
  const addCand = (url, c) => {
    if (have.has(url) || (block && block.test(url)) || cand.has(url)) return;
    cand.set(url, { url, ...c });
  };
  for (const f of files) {
    const kind = /css/i.test(f.contentType) ? 'css' : /html/i.test(f.contentType) ? 'html' : /javascript|ecmascript|json/i.test(f.contentType) ? 'js' : null;
    if (!kind) continue;
    scannedFiles++; bytes += f.text.length;
    const resolveLit = s => {
      try {
        if (/^\.\.?\//.test(s)) return new URL(s, f.url).href;
        if (kind === 'css' || kind === 'html') return new URL(s, f.url).href;
        return new URL(s, documentOrigin + '/').href;
      } catch { return null; }
    };
    const tpls = kind === 'js' || kind === 'html' ? extractTemplates(f.text) : [];
    const inTemplate = i => tpls.some(t => i >= t.index && i < t.index + t.text.length);
    for (const lit of literalsIn(f.text, kind)) {
      if (!looksLikeAssetUrl(lit.s)) continue;
      // `base + '/x.png'`: the literal is only a suffix, its real URL depends on a runtime value -> unknown, never resolved against the page origin.
      const dyn = kind === 'js' && !inTemplate(lit.index) ? /([A-Za-z_$][\w$.]*(?:\([^()]*\))?)\s*\+\s*$/.exec(f.text.slice(Math.max(0, lit.index - 120), lit.index)) : null;
      if (dyn) {
        unknown.push({ id: `unk_url_${++ukn}`, kind: 'suffix-literal', template: '${' + dyn[1] + '}' + lit.s, file: f.url, hole: dyn[1],
          reason: `literal "${lit.s}" is appended to a runtime value "${dyn[1]}"`, probe: 'declare the base in the freeze config (domains: {"<expr>": [...]}) or drive the page state that builds this URL, then re-freeze' });
        continue;
      }
      const url = resolveLit(lit.s);
      if (url && /^https?:/.test(url)) addCand(url.replace(/#.*$/, ''), { kind: 'literal', provenance: 'inferred', file: f.url, how: 'string literal in code' });
    }
    if (tpls.length) {
      const memo = process.env.REVA_COMPLETE_FAST === '0' ? null : new Map(); // per file: lookups depend on (this file, name)
      for (const t of tpls) {
        const cls = acceptTemplate(t.parts);
        if (!cls) continue;
        const display = displayOf(t.parts);
        const holes = t.parts.filter(p => p.h !== undefined).map(p => p.h);
        const res = holes.map(h => [h, resolveHole(h, f.text, t.index, domains, 3, memo)]);
        const bad = res.find(([, r]) => r.reason);
        const reason = bad ? bad[1].reason : cls === 'api' ? 'API-like URL template: not fetched blindly (a GET may not be safe or meaningful)' : null;
        if (reason) {
          unknown.push({ id: `unk_url_${++ukn}`, kind: 'template', template: display, file: f.url, hole: bad ? bad[0] : null, reason,
            probe: 'declare the hole domain in the freeze config (domains: {"<hole>": [...]}) or drive the page state that builds this URL, then re-freeze' });
          continue;
        }
        const size = res.reduce((a, [, r]) => a * r.values.length, 1);
        if (size > MAX_COMBOS) { unknown.push({ id: `unk_url_${++ukn}`, kind: 'template', template: display, file: f.url, hole: null, reason: `${size} combinations exceed the cap of ${MAX_COMBOS}`, probe: 'narrow the domains in the freeze config' }); continue; }
        let combos = [[]];
        for (const [, r] of res) combos = combos.flatMap(c => r.values.map(v => [...c, v]));
        const prov = res.every(([, r]) => r.provenance === 'declared') ? 'declared' : 'inferred';
        for (const combo of combos) {
          let i = 0;
          const path = t.parts.map(p => (p.s !== undefined ? p.s : combo[i++])).join('');
          let url;
          try { url = new URL(path, documentOrigin + '/').href; } catch { continue; }
          addCand(url, { kind: 'template', provenance: prov, file: f.url, template: display, how: res.map(([h, r]) => `${h}: ${r.how}`).join('; ') });
        }
      }
    }
  }
  return { candidates: [...cand.values()].sort((a, b) => a.url.localeCompare(b.url)), unknown, scanned: { files: scannedFiles, chars: bytes } };
}
