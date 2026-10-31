// Motion series I/O: JSON Lines, stored zstd-compressed (`<sha256>.jsonl.zst`) or plain (`<sha256>.jsonl`).
// One helper for the writer and every reader, so the two forms stay interchangeable. The digest in take.json is always
// the sha256 of the UNCOMPRESSED content; compression never changes what a reader sees (byte-identical round trip).
// Node's built-in zstd (zlib) is used, no dependency. Level 3: a 65 MB rows file stores in < 0.1 MB. Files are always one
// zstd frame (see zstdWriter).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';

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

/** Read a JSON Lines series (plain or `.zst`, resolved via resolveSeriesFile) in chunks; `pick` projects each element. */
export function readJsonl(file, pick) {
  const out = []; let rest = '';
  for (const chunk of textChunks(resolveSeriesFile(file))) {
    const parts = (rest + chunk).split('\n'); rest = parts.pop();
    for (const l of parts) if (l) { const v = JSON.parse(l); out.push(pick ? pick(v) : v); }
  }
  if (rest) { const v = JSON.parse(rest); out.push(pick ? pick(v) : v); }
  return out;
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
