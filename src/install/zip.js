// Minimal zip reader (stored + deflate) so installing the browser needs no `unzip` binary and every path is checked before it is written.
// Not a general archiver: no zip64, no encryption, no multi-disk. Anything it does not understand is an error, never a guess.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export class ZipError extends Error { constructor(m) { super(m); this.code = 'bad_zip'; } }

const EOCD_SIG = 0x06054b50; const CEN_SIG = 0x02014b50; const LOC_SIG = 0x04034b50;
const MAX_ENTRY = 1024 * 1024 * 1024;          // one file may not expand past 1 GiB
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;      // the whole archive may not expand past 2 GiB

/** List the entries of a zip file: [{name, method, crc, csize, size, offset, mode, isDir, isSymlink}] */
export function listZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = fs.fstatSync(fd).size;
    const tailLen = Math.min(len, 65557);
    const tail = Buffer.alloc(tailLen); fs.readSync(fd, tail, 0, tailLen, len - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD_SIG) { e = i; break; }
    if (e < 0) throw new ZipError('not a zip file (no end-of-archive record); the download may be cut off or an error page');
    const count = tail.readUInt16LE(e + 10); const cenSize = tail.readUInt32LE(e + 12); const cenOff = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cenSize === 0xffffffff || cenOff === 0xffffffff) throw new ZipError('zip64 archives are not supported');
    if (cenOff + cenSize > len) throw new ZipError('zip directory points past the end of the file (truncated download?)');
    const cen = Buffer.alloc(cenSize); fs.readSync(fd, cen, 0, cenSize, cenOff);
    const out = []; let p = 0; let total = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cen.length || cen.readUInt32LE(p) !== CEN_SIG) throw new ZipError('broken zip directory');
      const flags = cen.readUInt16LE(p + 8); const method = cen.readUInt16LE(p + 10);
      const crc = cen.readUInt32LE(p + 16); const csize = cen.readUInt32LE(p + 20); const size = cen.readUInt32LE(p + 24);
      const nlen = cen.readUInt16LE(p + 28); const xlen = cen.readUInt16LE(p + 30); const clen = cen.readUInt16LE(p + 32);
      const ext = cen.readUInt32LE(p + 38); const offset = cen.readUInt32LE(p + 42);
      const name = cen.toString('utf8', p + 46, p + 46 + nlen);
      p += 46 + nlen + xlen + clen;
      if (flags & 1) throw new ZipError(`encrypted entry ${name} is not supported`);
      if (csize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError('zip64 entries are not supported');
      if (size > MAX_ENTRY) throw new ZipError(`entry ${name} is ${size} bytes (limit ${MAX_ENTRY})`);
      total += size; if (total > MAX_TOTAL) throw new ZipError(`archive expands past ${MAX_TOTAL} bytes`);
      const mode = (ext >>> 16) & 0xffff;
      out.push({ name, method, crc, csize, size, offset, mode, isDir: name.endsWith('/'), isSymlink: (mode & 0xf000) === 0xa000 });
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/** An entry name is safe when it is relative, has no `..` or empty parts, no backslash and no drive letter. */
export function safeEntryName(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every((part, i, a) => part !== '..' && part !== '.' && (part !== '' || i === a.length - 1));
}

/**
 * Extract `file` into `destDir` (created). Every entry must lie under `requiredRoot` (e.g. "chrome-headless-shell-mac-arm64/") and pass
 * safeEntryName; symlinks are allowed only to a plain file name in the same folder. The CRC32 of every file is checked.
 * Returns the number of files written.
 */
export function extractZip(file, destDir, { requiredRoot = '' } = {}) {
  const entries = listZip(file);
  const root = path.resolve(destDir);
  for (const e of entries) {
    if (!safeEntryName(e.name)) throw new ZipError(`unsafe path in archive: ${JSON.stringify(e.name)}`);
    if (requiredRoot && !e.name.startsWith(requiredRoot)) throw new ZipError(`unexpected path in archive: ${e.name} (expected everything under ${requiredRoot})`);
  }
  fs.mkdirSync(root, { recursive: true });
  const fd = fs.openSync(file, 'r');
  let files = 0;
  try {
    for (const e of entries) {
      const target = path.resolve(root, e.name);
      if (target !== root && !target.startsWith(root + path.sep)) throw new ZipError(`path escapes the target folder: ${e.name}`);
      if (e.isDir) { fs.mkdirSync(target, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const lh = Buffer.alloc(30); fs.readSync(fd, lh, 0, 30, e.offset);
      if (lh.readUInt32LE(0) !== LOC_SIG) throw new ZipError(`broken local header for ${e.name}`);
      const dataStart = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const comp = Buffer.alloc(e.csize); if (e.csize) fs.readSync(fd, comp, 0, e.csize, dataStart);
      let data;
      if (e.method === 0) data = comp;
      else if (e.method === 8) { try { data = zlib.inflateRawSync(comp); } catch (err) { throw new ZipError(`cannot unpack ${e.name}: ${err.message}`); } }
      else throw new ZipError(`entry ${e.name} uses compression method ${e.method}, which is not supported`);
      if (data.length !== e.size) throw new ZipError(`size mismatch for ${e.name}`);
      if ((zlib.crc32(data) >>> 0) !== e.crc) throw new ZipError(`checksum mismatch inside the archive for ${e.name}`);
      if (e.isSymlink) {
        const link = data.toString('utf8');
        // Only a link to a sibling file in the same folder (a plain name): it cannot reach outside, however links are chained.
        if (!/^[^/\\\0]+$/.test(link) || link === '..' || link === '.') throw new ZipError(`symlink ${e.name} has a target (${link}) that is not a plain file name in the same folder`);
        fs.symlinkSync(link, target);
      } else {
        fs.writeFileSync(target, data, { mode: (e.mode & 0o111) ? 0o755 : 0o644 });
        files++;
      }
    }
  } finally { fs.closeSync(fd); }
  return files;
}
