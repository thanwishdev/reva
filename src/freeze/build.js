// Archive writer + checksum manifest (PLAN M4 freeze, output "like ARCH"):
//   har/<cls>.har.zip, har/all.har.zip   sanitised HARs; replay with src/replay (harDir 'har', harUnion 'all')
//   har-raw/<cls>.har.zip                exactly as recorded, provenance only (do NOT replay: trap 2)
//   files/<host>/<path>                  one body per answered URL
//   manifest.json                        every HAR entry: method, url, status, bytes, sha256, provenance
//   SHA256SUMS (files/)  ARCHIVE.SHA256SUMS (everything else)   verified by src/archive.js verifyArchive (shasum -c)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { packHarZip, bodyOf, sha256 } from './sanitize.js';

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const seg = s => s.replace(/[^A-Za-z0-9._~@%+=,-]/g, '_');
const hdr = (list, name) => (list || []).find(h => h.name.toLowerCase() === name)?.value || '';

/** Deterministic, filesystem-safe relative path for a URL (query hashed, trailing slash -> index.html). */
export function urlToPath(url, contentType = '') {
  const u = new URL(url);
  let segs = u.pathname.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } }).map(s => (s === '.' || s === '..' ? '_' : seg(s)));
  const trailing = u.pathname.endsWith('/') || !segs.length;
  if (trailing) segs.push('index.html');
  let name = segs.pop();
  if (!trailing && !/\.[A-Za-z0-9]{1,8}$/.test(name) && /html/i.test(contentType)) name += '.html';
  if (u.search) name += '__q_' + sha1(u.search).slice(0, 10);
  if (name.length > 120) { const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] || ''; name = name.slice(0, 100) + '~' + sha1(name).slice(0, 8) + ext; }
  segs = segs.map(s => (s.length > 120 ? s.slice(0, 100) + '~' + sha1(s).slice(0, 8) : s));
  return ['files', seg(u.host.replace(':', '_')), ...segs, name].join('/');
}

function writeFile(root, rel, data) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
}

/**
 * @param {object} o
 * @param {string} o.dir            archive directory (created; must not exist or be empty)
 * @param {{har,files}} o.union     sanitised union
 * @param {Object<string,{har,files}>} o.classes  sanitised per class
 * @param {Object<string,Buffer>} o.raw           raw HAR zips per class
 * @param {Map<string,{origin:string, provenance:string}>} [o.provenance]  url -> how it entered the archive (default: recorded / measured)
 * @param {object} o.meta           anything to embed at the top of the manifest (toolkit, config id, dates, source)
 */
export function buildArchive({ dir, union, classes, raw, provenance = new Map(), meta = {} }) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`archive directory is not empty: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [cls, h] of Object.entries(classes)) writeFile(dir, `har/${cls}.har.zip`, packHarZip(h));
  writeFile(dir, 'har/all.har.zip', packHarZip(union));
  for (const [cls, buf] of Object.entries(raw)) writeFile(dir, `har-raw/${cls}.har.zip`, buf);

  const classOf = new Map(); // method+url -> classes that saw it
  for (const [cls, h] of Object.entries(classes)) for (const e of h.har.log.entries) {
    const k = e.request.method + ' ' + e.request.url; (classOf.get(k) || classOf.set(k, []).get(k)).push(cls);
  }
  const used = new Set(), entries = [];
  for (const e of union.har.log.entries) {
    const { method, url } = e.request, st = e.response.status, files = union.files;
    const body = bodyOf(e.response.content, files);
    const post = bodyOf(e.request.postData, files);
    const ct = hdr(e.response.headers, 'content-type');
    let rel = null;
    if (body && body.length) {
      rel = method === 'GET' && st >= 200 && st < 300 ? urlToPath(url, ct) : `files/_other/${method}_${st}_${sha1(method + url + (post ? sha256(post) : '')).slice(0, 16)}.bin`;
      if (used.has(rel.toLowerCase())) rel = `files/_other/${method}_${st}_${sha1(method + url + (post ? sha256(post) : '')).slice(0, 16)}.bin`; // case-insensitive collisions
      used.add(rel.toLowerCase());
      try { writeFile(dir, rel, body); } catch { rel = `files/_other/${method}_${st}_${sha1(url).slice(0, 16)}.bin`; writeFile(dir, rel, body); } // a file/dir name clash
    }
    const prov = provenance.get(url) || { origin: 'recorded', provenance: 'measured' };
    entries.push({
      method, url, status: st, path: rel, bytes: body ? body.length : 0, sha256: body && body.length ? sha256(body) : null,
      contentType: ct, cacheControl: hdr(e.response.headers, 'cache-control'), etag: hdr(e.response.headers, 'etag'), lastModified: hdr(e.response.headers, 'last-modified'),
      postSha256: post ? sha256(post) : undefined, postBytes: post ? post.length : undefined,
      classes: (classOf.get(method + ' ' + url) || []).sort(), origin: prov.origin, provenance: prov.provenance,
    });
  }
  entries.sort((a, b) => (a.url + a.method).localeCompare(b.url + b.method));
  const manifest = { schema: 1, ...meta, counts: { entries: entries.length, files: entries.filter(x => x.path).length, bytes: entries.reduce((a, x) => a + x.bytes, 0) }, entries };
  writeFile(dir, 'manifest.json', JSON.stringify(manifest, null, 1));
  return { manifest, dir };
}

const walk = (root, rel = '') => fs.readdirSync(path.join(root, rel), { withFileTypes: true })
  .flatMap(d => (d.isDirectory() ? walk(root, path.join(rel, d.name)) : [path.join(rel, d.name)])).sort();

/** Write SHA256SUMS (files/) and ARCHIVE.SHA256SUMS (everything else), then make the archive files read-only. Call after every other file is in place. */
export function sealArchive(dir) {
  const line = rel => `${sha256(fs.readFileSync(path.join(dir, rel)))}  ${rel}\n`;
  const all = walk(dir).filter(r => r !== 'ARCHIVE.SHA256SUMS');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), all.filter(r => r.startsWith('files/')).map(line).join(''));
  const rest = walk(dir).filter(r => r !== 'ARCHIVE.SHA256SUMS');
  fs.writeFileSync(path.join(dir, 'ARCHIVE.SHA256SUMS'), rest.map(line).join(''));
  for (const r of walk(dir)) fs.chmodSync(path.join(dir, r), 0o444);
  return { files: rest.length };
}

/** Make an archive deletable again (tests, re-freeze). */
export function unsealArchive(dir) { for (const r of walk(dir)) fs.chmodSync(path.join(dir, r), 0o644); }
