// Motion series I/O: JSON Lines, stored zstd-compressed (`<sha256>.jsonl.zst`) or plain (`<sha256>.jsonl`).
// One helper for the writer and every reader, so the two forms stay interchangeable. The digest in take.json is always
// the sha256 of the UNCOMPRESSED content; compression never changes what a reader sees (byte-identical round trip).
// Node's built-in zstd (zlib) is used, no dependency. Level 3: a 65 MB rows file stores in < 0.1 MB. Files are always one
// zstd frame (see zstdWriter).
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { rowDecoder, rowCursor } from './rowcodec.js';

export const ZSTD_LEVEL = 3;
export const zstdParams = () => ({ params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } });

/**
 * Resolve a series path to the file that exists on disk: the path as written in take.json, else its compressed
 * (`.zst` added) or plain (`.zst` removed) twin. Takes migrated by `corpus compress-motion` keep their take.json, so a
 * `series/<d>.jsonl` entry is found as `series/<d>.jsonl.zst`. Returns the input path when neither exists (the caller's
 * open then reports ENOENT on the recorded name).
 */
export function resolveSeriesFile(file) {
  if (fs.existsSync(file)) return file;
  const twin = file.endsWith('.zst') ? file.slice(0, -4) : file + '.zst';
  return fs.existsSync(twin) ? twin : file;
}

/** Iterate the text chunks of a series file (plain or zstd), decoded as UTF-8 across chunk boundaries. */
function* textChunks(file) {
  const dec = new StringDecoder('utf8');
  if (file.endsWith('.zst')) {
    // No sync streaming decoder in zlib: decompress to one off-heap Buffer (largest corpus series ~210 MB), then
    // decode it in slices so no single JS string approaches V8's max string length.
    const all = zlib.zstdDecompressSync(fs.readFileSync(file));
    for (let i = 0; i < all.length; i += 1 << 22) yield dec.write(all.subarray(i, i + (1 << 22)));
  } else {
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(1 << 22);
    try { for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; yield dec.write(buf.subarray(0, n)); } } finally { fs.closeSync(fd); }
  }
  const tail = dec.end(); if (tail) yield tail;
}

/**
 * Read a JSON Lines series (plain or `.zst`, resolved via resolveSeriesFile) in chunks; `pick` projects each element.
 * A streamed rows file (first line {"$rows":"delta/1"}, see rowcodec.js) reads as the full rows; decoded rows share what did
 * not change, so `pick` must not modify them.
 */
export function readJsonl(file, pick) {
  const out = []; let rest = ''; let first = true; let decode = null;
  const line = (l) => {
    let v = JSON.parse(l);
    if (first) {
      first = false;
      if (v && v.$rows) { if (v.$rows !== 'delta/1') throw new Error(`${file}: unknown rows encoding ${v.$rows}`); decode = rowDecoder(); return; }
    }
    if (decode) v = decode(v);
    out.push(pick ? pick(v) : v);
  };
  for (const chunk of textChunks(resolveSeriesFile(file))) {
    const parts = (rest + chunk).split('\n'); rest = parts.pop();
    for (const l of parts) if (l) line(l);
  }
  if (rest) line(rest);
  return out;
}

/**
 * A rows series opened for reading a few rows at a time: the same rows readJsonl gives, without holding them all.
 * The file's text stays in one off-heap Buffer, with where each row starts and its `k`. A delta file (rowcodec.js) is read
 * once to check it and to keep the decoder's state every `every` rows; read() starts from the last saved state before the
 * rows it is asked for. Rows read in one call share their unchanged objects as rowDecoder's rows do (rowCursor).
 * @param {string} file  series path as in take.json (plain or `.zst`, resolved via resolveSeriesFile)
 * @returns {{n:number, ks:any[], read:(idx:number[]) => Map<number, object>}}  read: row numbers, ascending, to rows
 */
export function openRows(file, { every = 128 } = {}) {
  const f = resolveSeriesFile(file), raw = fs.readFileSync(f), buf = f.endsWith('.zst') ? zlib.zstdDecompressSync(raw) : raw;
  const starts = [], ends = [];
  for (let a = 0; a < buf.length;) { let b = buf.indexOf(10, a); if (b < 0) b = buf.length; if (b > a) { starts.push(a); ends.push(b); } a = b + 1; }
  const text = (i) => buf.toString('utf8', starts[i], ends[i]);
  let skip = 0, cursor = null; const saved = [];
  if (starts.length) { const h = JSON.parse(text(0)); if (h && h.$rows) { if (h.$rows !== 'delta/1') throw new Error(`${f}: unknown rows encoding ${h.$rows}`); skip = 1; cursor = rowCursor(); } }
  const n = starts.length - skip, ks = new Array(n), line = (i) => JSON.parse(text(i + skip));
  if (cursor) for (let i = 0; i < n; i++) { if (i % every === 0) saved.push(cursor.save()); const w = line(i); ks[i] = w.k; cursor.step(w, false); }
  else for (let i = 0; i < n; i++) ks[i] = line(i).k;
  const read = (idx) => {
    const out = new Map(); if (!cursor) { for (const i of idx) out.set(i, line(i)); return out; }
    let at = Infinity;   // the next row the cursor would read
    for (const i of idx) {
      if (i < 0 || i >= n || out.has(i)) continue;
      const from = Math.floor(i / every) * every;
      if (at > i || at < from) { cursor.load(saved[from / every]); at = from; }
      for (; at < i; at++) cursor.step(line(at), false);
      out.set(i, cursor.step(line(i), true)); at = i + 1;
    }
    return out;
  };
  return { n, ks, read };
}

/** Raw bytes of a series file after decompression (tests and the migration check use it). */
export function readSeriesBytes(file) {
  const f = resolveSeriesFile(file); const b = fs.readFileSync(f);
  return f.endsWith('.zst') ? zlib.zstdDecompressSync(b) : b;
}

/**
 * Sync zstd writer: write(str) appends UTF-8 bytes (returned, for hashing); close() compresses them as ONE zstd frame and
 * returns { bytes (uncompressed), storedBytes }. Why one frame, not a frame per chunk: Node's zstdDecompressSync stops
 * at the end of the first frame (measured: 17,048,890 of 43,888,890 bytes returned from a 3-frame file, while the zstd
 * CLI decodes all), and zlib has no public sync streaming encoder. Peak extra memory is one series' uncompressed bytes
 * (largest corpus series ~210 MB, off-heap), small next to the in-memory element arrays the recorder already holds.
 */
export function zstdWriter(file) {
  let parts = []; let bytes = 0;
  return {
    write(str) { const b = Buffer.from(str, 'utf8'); parts.push(b); bytes += b.length; return b; },
    close() {
      const z = zlib.zstdCompressSync(Buffer.concat(parts, bytes), zstdParams()); parts = [];
      fs.writeFileSync(file, z); return { bytes, storedBytes: z.length };
    },
  };
}

/** Spool file of a streamed take: text appended as it arrives, so the data of a long take never sits in the heap. */
export class Spool {
  constructor(file, head = '') { this.file = file; this.head = head; this.fd = fs.openSync(file, 'a'); this.clear(); }
  /** Append one element's line. */
  line(str) { fs.writeSync(this.fd, str + '\n'); this.n++; }
  /** Forget everything written so far. */
  clear() { fs.ftruncateSync(this.fd, 0); this.n = 0; if (this.head) fs.writeSync(this.fd, this.head + '\n'); }
  close() { if (this.fd != null) { fs.closeSync(this.fd); this.fd = null; } }
}

/**
 * Store a finished spool as a series: `dst` becomes one zstd frame (see zstdWriter), returns { digest, bytes, storedBytes }.
 * Extra memory is the spool's size off the heap: a delta file is small, a full series of the same take is 50+ times larger.
 */
export function storeSpool(src, dst) {
  const b = fs.readFileSync(src);
  const digest = crypto.createHash('sha256').update(b).digest('hex');
  const z = zlib.zstdCompressSync(b, zstdParams());
  fs.writeFileSync(dst, z);
  return { digest, bytes: b.length, storedBytes: z.length };
}
