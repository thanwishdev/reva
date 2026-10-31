// JSON file writer for values that hold very long strings.
//
// Node 26.0.0's fast JSON stringifier (V8 FastJsonStringifier) aborts the whole process on some long two-byte strings:
// `FATAL ERROR: Zone Allocation failed - process out of memory`, uncatchable, with RSS racing to ~11.6 GB first.
// Measured 27 Oct on one corpus site's computed dump (162,007,327 chars; 346 non-Latin-1 chars, 26,894 quotes, 172
// control chars): JSON.stringify crashes in 0.25 s; its first 150M chars serialise fine; the same string with the
// quotes, the control chars or the non-Latin-1 chars replaced serialises fine; `--no-json-stringify-fast-path` serialises
// it fine. It is an engine fault on one long string, not a size limit (synthetic 260M-char two-byte strings pass).
//
// writeJsonFile never hands a long string to one JSON.stringify call: it is serialised in slices that never split a
// surrogate pair, and JSON.stringify escapes each code point independently, so the file is byte-identical to
// JSON.stringify(value). Plain objects and arrays are walked; everything else goes through JSON.stringify as is.
import fs from 'node:fs';

const SLICE = 1 << 20; // chars per JSON.stringify call on a long string
const FLUSH = 1 << 23; // chars buffered before a write

const isPlain = v => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };

/** Serialise `value` exactly as JSON.stringify(value) would, as a sequence of pieces passed to put(). */
export function jsonPieces(value, put, { slice = SLICE } = {}) {
  const str = s => {
    if (s.length <= slice) { put(JSON.stringify(s)); return; }
    put('"');
    for (let i = 0; i < s.length;) {
      let j = Math.min(i + slice, s.length);
      const c = s.charCodeAt(j - 1);
      if (j < s.length && c >= 0xd800 && c <= 0xdbff) j++; // keep a surrogate pair in one slice (a lone one stays lone)
      put(JSON.stringify(s.slice(i, j)).slice(1, -1));
      i = j;
    }
    put('"');
  };
  const skip = v => v === undefined || typeof v === 'function' || typeof v === 'symbol';
  const val = v => {
    if (typeof v === 'string') return str(v);
    if (v === null || typeof v !== 'object' || typeof v.toJSON === 'function') { put(JSON.stringify(v) ?? 'null'); return; }
    if (Array.isArray(v)) {
      put('[');
      for (let i = 0; i < v.length; i++) { if (i) put(','); if (skip(v[i])) put('null'); else val(v[i]); }
      put(']');
      return;
    }
    if (!isPlain(v)) { put(JSON.stringify(v) ?? 'null'); return; }
    put('{');
    let first = true;
    for (const k of Object.keys(v)) {
      if (skip(v[k])) continue;
      put(`${first ? '' : ','}${JSON.stringify(k)}:`);
      first = false;
      val(v[k]);
    }
    put('}');
  };
  val(value);
}

/** fs.writeFileSync(file, JSON.stringify(value)) without the long-string engine fault above (same bytes). */
export function writeJsonFile(file, value, opts = {}) {
  const fd = fs.openSync(file, 'w');
  try {
    let buf = [], n = 0;
    const flush = () => {
      if (!buf.length) return;
      const b = Buffer.from(buf.join(''), 'utf8');
      buf = []; n = 0;
      for (let off = 0; off < b.length;) off += fs.writeSync(fd, b, off, b.length - off);
    };
    jsonPieces(value, s => { buf.push(s); n += s.length; if (n >= FLUSH) flush(); }, opts);
    flush();
  } finally { fs.closeSync(fd); }
}
