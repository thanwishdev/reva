// Lottie files in the sealed archive (DESIGN 3.6): exact keyframes, read before the archive goes. A `.lottie` is a zip with one or more
// animations in it; a plain Lottie is JSON, often at an address with no extension, so JSON answers are looked at for its keys.
// What comes out is the timing a person can use: size, rate, length, and for each layer its transform keyframes with their bezier
// handles. Layer names are page text: cleaned here, stored, never followed. The folder stays local.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { listZip } from '../install/zip.js';

export const LOTTIE_FILE = 'lottie.json';
const SCHEMA = 'reva.lottie/1';
const MAX_FILE = 32e6, MAX_JSON = 8e6, MAX_LAYERS = 200, MAX_KEYS = 64, NAME_MAX = 60, LIST_MAX = 60;
const TRACKS = { o: 'opacity', r: 'rotate', p: 'position', s: 'scale', a: 'anchor' };
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').slice(0, NAME_MAX);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const first = (v) => (Array.isArray(v) ? v[0] : v);
const isLottie = (j) => !!j && typeof j === 'object' && Number.isFinite(j.fr) && Number.isFinite(j.op) && Array.isArray(j.layers);

/** One zip entry as a Buffer, or null when the file cannot give it. */
function readEntry(file, e) {
  if (e.size > MAX_FILE || e.csize > MAX_FILE) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(30); fs.readSync(fd, head, 0, 30, e.offset);
    const at = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), body = Buffer.alloc(e.csize);
    fs.readSync(fd, body, 0, e.csize, at);
    return e.method === 0 ? body : e.method === 8 ? zlib.inflateRawSync(body, { maxOutputLength: MAX_FILE }) : null;
  } finally { fs.closeSync(fd); }
}

/** A keyframed value as [{ms, v, in, out}], in the animation's own milliseconds; the handles are the eases between keys. */
function keysOf(prop, ip, fr) {
  const k = prop?.k;
  if (!Array.isArray(k) || typeof k[0] !== 'object' || k[0] === null || !('t' in k[0])) return null;
  return k.slice(0, MAX_KEYS).map((x) => ({
    ms: r3(((x.t - ip) * 1000) / fr), v: Array.isArray(x.s) ? x.s.map(r3) : x.s == null ? null : r3(x.s),
    ...(x.i ? { in: [r3(first(x.i.x)), r3(first(x.i.y))] } : {}), ...(x.o ? { out: [r3(first(x.o.x)), r3(first(x.o.y))] } : {}), ...(x.h ? { hold: true } : {}),
  }));
}
function countShapes(list) {
  let n = 0;
  for (const s of list || []) { if ([s?.ks, s?.o, s?.r, s?.p, s?.s].some((x) => x?.a === 1 || x?.k?.[0]?.t != null)) n++; if (Array.isArray(s?.it)) n += countShapes(s.it); }
  return n;
}
/** The transform keyframes of one layer. */
export function layerOf(l, ip, fr) {
  const tracks = {};
  for (const [k, name] of Object.entries(TRACKS)) { const keys = keysOf(l.ks?.[k], ip, fr); if (keys) tracks[name] = keys; }
  return { name: clean(l.nm), type: l.ty ?? null, ...(Object.keys(tracks).length ? { tracks } : {}), ...(countShapes(l.shapes) ? { animatedShapes: countShapes(l.shapes) } : {}) };
}
/** One animation, reduced. Pure. */
export function animationOf(j, id = null) {
  const ip = j.ip ?? 0, ms = r3(((j.op - ip) * 1000) / j.fr), comps = (j.assets || []).filter((a) => Array.isArray(a.layers));   // most of a real file sits in precomps
  const all = [...j.layers, ...comps.flatMap((a) => a.layers)], layers = all.slice(0, MAX_LAYERS).map((l) => layerOf(l, ip, j.fr));
  return { id: id == null ? null : clean(id), name: clean(j.nm), w: j.w ?? null, h: j.h ?? null, fr: j.fr, ms, frames: j.op - ip, layers, layerCount: all.length, assets: (j.assets || []).length };
}
/** Every animation inside a `.lottie` file. */
export function readDotLottie(file) {
  const out = [];
  for (const e of listZip(file)) {
    const m = /^(?:animations|a)\/([^/]+)\.json$/.exec(e.name); if (!m) continue;
    const buf = readEntry(file, e); if (!buf) continue;
    const j = JSON.parse(buf.toString('utf8')); if (isLottie(j)) out.push(animationOf(j, m[1]));
  }
  return out;
}
const looksJson = (x) => /json/i.test(x.contentType || '') || /\.json(?:[?#]|$)/i.test(x.url || '');
const looksDot = (x) => /\.lottie(?:[?#]|$)/i.test(x.url || '') || /dotlottie/i.test(x.contentType || '');

/**
 * Read every Lottie of a frozen archive. Nothing here reaches the network, and a file that will not read is a line in `skipped`.
 * @param {string} archiveDir  holds manifest.json and files/
 * @returns {{schema:string, files:object[], skipped:object[]}}
 */
export function readLottie(archiveDir) {
  const doc = { schema: SCHEMA, files: [], skipped: [] }, seen = new Set();
  let manifest; try { manifest = JSON.parse(fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8')); } catch { return doc; }
  for (const x of manifest.entries || []) {
    if (!x.path || !x.url || seen.has(x.path)) continue;
    const dot = looksDot(x);
    if (!dot && !looksJson(x)) continue;
    seen.add(x.path);
    const file = path.join(archiveDir, x.path); let size = 0;
    try { size = fs.statSync(file).size; } catch { if (dot) doc.skipped.push({ url: x.url, why: 'not in the archive' }); continue; }
    if (!size) { if (dot) doc.skipped.push({ url: x.url, why: 'empty body' }); continue; }
    if (size > (dot ? MAX_FILE : MAX_JSON)) { if (dot) doc.skipped.push({ url: x.url, why: 'too large' }); continue; }
    try {
      if (dot) { const animations = readDotLottie(file); if (animations.length) doc.files.push({ url: x.url, path: x.path, kind: 'lottie', animations }); else doc.skipped.push({ url: x.url, why: 'no animation inside' }); continue; }
      const text = fs.readFileSync(file, 'utf8'); if (!text.includes('"layers"')) continue;
      const j = JSON.parse(text); if (isLottie(j)) doc.files.push({ url: x.url, path: x.path, kind: 'json', animations: [animationOf(j)] });
    } catch (e) { if (dot) doc.skipped.push({ url: x.url, why: String(e.message).split('\n')[0].slice(0, 120) }); }
  }
  return doc;
}
/** S1, before the archive is deleted: `lottie.json` in the scan folder. Returns the counts. */
export function writeLottie(archiveDir, out) {
  const doc = readLottie(archiveDir);
  if (doc.files.length || doc.skipped.length) fs.writeFileSync(path.join(out, LOTTIE_FILE), JSON.stringify(doc));
  return { files: doc.files.length, animations: doc.files.reduce((a, f) => a + f.animations.length, 0), skipped: doc.skipped.length };
}
/** The short list for `site.lottie` in moves.json. */
export function lottieList(doc) {
  return (doc?.files || []).slice(0, LIST_MAX).flatMap((f) => f.animations.map((a) => ({ file: clean(path.posix.basename(new URL(f.url).pathname)), url: f.url, id: a.id, ms: a.ms, fr: a.fr, w: a.w, h: a.h, layers: a.layerCount })));
}
