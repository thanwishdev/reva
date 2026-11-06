// The takes' series, packed tighter once the scan no longer reads them in a hurry (DESIGN 8, size). A take closes its series at
// zstd level 3, which costs nothing while the lanes record; at the end of the scan worker threads pack each file again at level
// 19, beside the clips and the take video. Lossless: a file is replaced only when its new bytes decode to exactly the old ones,
// and the name (the sha256 of the uncompressed text) stays. Measured 5 Nov, a 3D portfolio site (sealed): 169.9 to 127.7 MB.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';

export const REPACK_LEVEL = 19;
/** Threads: level 19 runs at about 3.4 MB of text a second on one core (a 3D portfolio site: about 230 core-seconds in all). */
export const REPACK_WORKERS = 3;
/**
 * Series up to this many stored bytes start on one thread beside the take video: three threads pack them alone in seconds after
 * it (a small agency site, 18 MB: 16.5 s offline). Larger ones start on all threads, since one would outlast the video by minutes (a 3D portfolio site,
 * 170 MB: 180 s on three beside it) and those sites fit their memory that way (5 Nov: the 3D portfolio site 4.93 of 5 GB, the marketing site 5.79 of 6).
 */
export const REPACK_SMALL_BYTES = 50e6;

/** Pack one file again at `level`. Pure apart from the file itself. @returns {{file:string, before:number, after:number}} */
export function repackFile(file, level = REPACK_LEVEL) {
  const raw = fs.readFileSync(file), text = zlib.zstdDecompressSync(raw);
  const z = zlib.zstdCompressSync(text, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
  if (z.length >= raw.length) return { file, before: raw.length, after: raw.length };
  if (!zlib.zstdDecompressSync(z).equals(text)) throw new Error(`packing ${path.basename(file)} again did not give back the same bytes`);
  const tmp = `${file}.repack.tmp`;
  fs.writeFileSync(tmp, z);
  fs.renameSync(tmp, file); // a reader holds the old file or the new one, and both decode to the same text
  return { file, before: raw.length, after: z.length };
}

/** Every take folder of a scan: <out>/takes/<vp>/<take> and <out>/pages/<id>/takes/<vp>/<take>. */
export function takeDirs(out) {
  const roots = [out], pages = path.join(out, 'pages'), dirs = [];
  if (fs.existsSync(pages)) for (const p of fs.readdirSync(pages)) roots.push(path.join(pages, p));
  for (const r of roots) {
    const t = path.join(r, 'takes'); if (!fs.existsSync(t)) continue;
    for (const vp of fs.readdirSync(t)) { const v = path.join(t, vp); if (!fs.statSync(v).isDirectory()) continue; for (const k of fs.readdirSync(v)) if (fs.existsSync(path.join(v, k, 'take.json'))) dirs.push(path.join(v, k)); }
  }
  return dirs;
}

const WORKER = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', async ({ file, level, url }) => {
  try { const { repackFile } = await import(url); parentPort.postMessage({ ok: repackFile(file, level) }); }
  catch (e) { parentPort.postMessage({ error: String(e && e.message || e) }); }
});`;

/**
 * Pack every zstd series of a scan again, largest first, on `workers` threads; take.json keeps its storedBytes true.
 * `first` threads start at once and the rest join when `widen` settles: beside the take video's two browsers one thread runs, and
 * all of them once it ends, for series up to REPACK_SMALL_BYTES (a small agency site, 5 Nov: tree 5.07 GB with three beside it; one thread holds 0.36 GB, three 0.84 GB).
 * Which thread packs a file does not change its bytes.
 * @returns {Promise<{files:number, before:number, after:number, failed:number, wallMs:number}>}
 */
export async function repackSeries(out, { workers = REPACK_WORKERS, first = workers, widen = null, level = REPACK_LEVEL, log = () => {} } = {}) {
  // `first` may be a function of the stored bytes to pack
  const t0 = Date.now(), jobs = [];
  for (const dir of takeDirs(out)) {
    let take; try { take = JSON.parse(fs.readFileSync(path.join(dir, 'take.json'), 'utf8')); } catch { continue; }
    for (const [name, s] of Object.entries(take.series || {})) {
      const file = path.join(dir, s.file || '');
      if (s.compression === 'zstd' && s.file?.endsWith('.zst') && fs.existsSync(file)) jobs.push({ dir, name, file, size: fs.statSync(file).size });
    }
  }
  jobs.sort((a, b) => b.size - a.size);
  const res = { files: jobs.length, before: 0, after: 0, failed: 0, wallMs: 0 }, done = new Map();
  const url = new URL(import.meta.url).href, queue = [...jobs];
  const lane = () => new Promise((resolve) => {
    const w = new Worker(WORKER, { eval: true });
    const next = () => {
      const j = queue.shift();
      if (!j) { w.terminate().then(() => resolve(), () => resolve()); return; }
      w.once('message', (m) => {
        if (m.error) { res.failed++; res.before += j.size; res.after += j.size; log(`series ${path.relative(out, j.file)} kept as it was: ${m.error}`); }
        else { res.before += m.ok.before; res.after += m.ok.after; done.set(j.file, m.ok.after); }
        next();
      });
      w.postMessage({ file: j.file, level, url });
    };
    w.once('error', (e) => { log(`a packing thread stopped: ${String(e.message).split('\n')[0]}`); resolve(); });
    next();
  });
  let live = 0, closed = false, widened = !widen;
  const ends = [];
  const add = (n) => { while (!closed && n-- > 0 && live < workers && queue.length) { live++; ends.push(lane().finally(() => { live--; })); } };
  const n0 = typeof first === 'function' ? first(jobs.reduce((a, j) => a + j.size, 0)) : first;
  add(Math.max(1, Math.min(n0, workers)));
  const wide = widen ? Promise.resolve(widen).catch(() => {}).then(() => { widened = true; add(workers); }) : null;
  for (;;) {
    const n = ends.length;
    await Promise.all(ends);
    if (ends.length > n) continue;
    if (queue.length && !widened) { await wide; continue; } // a thread that stopped early leaves its files to the ones still to come
    break;
  }
  closed = true;
  // a job a stopped thread held, or never took, stays as it was
  for (const dir of new Set(jobs.map((j) => j.dir))) {
    const f = path.join(dir, 'take.json'), take = JSON.parse(fs.readFileSync(f, 'utf8'));
    let changed = false;
    for (const s of Object.values(take.series || {})) { const n = done.get(path.join(dir, s.file || '')); if (n != null && n !== s.storedBytes) { s.storedBytes = n; s.level = level; changed = true; } }
    if (changed) fs.writeFileSync(f, JSON.stringify(take, null, 1));
  }
  res.wallMs = Date.now() - t0;
  return res;
}
