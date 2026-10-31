// Test helpers: a tiny zip writer (stored / deflate) and a throwaway pins object for a fake browser.
import zlib from 'node:zlib';
import crypto from 'node:crypto';

/** entries: [{name, data?: string|Buffer, mode?: 0o755, method?: 'deflate'|'store', symlink?: boolean}] -> Buffer */
export function makeZip(entries) {
  const locals = []; const cens = []; let off = 0;
  for (const e of entries) {
    const nameB = Buffer.from(e.name);
    const data = Buffer.from(e.data ?? '');
    const dir = e.name.endsWith('/');
    const method = !dir && e.method !== 'store' ? 8 : 0;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    const mode = (e.symlink ? 0o120000 : dir ? 0o040000 : 0o100000) | (e.mode ?? (dir ? 0o755 : 0o644));
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE((mode << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    locals.push(lh, nameB, comp); cens.push(ch, nameB);
    off += 30 + nameB.length + comp.length;
  }
  const cen = Buffer.concat(cens);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cen.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cen, eocd]);
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A zip shaped like the real download: chrome-headless-shell-<zip>/chrome-headless-shell (+ a data file). */
export function fakeShellZip(zipName = 'mac-arm64', script = '#!/bin/sh\necho "HeadlessChrome 0.0.0 (fake)"\n') {
  return makeZip([
    { name: `chrome-headless-shell-${zipName}/`, data: '' },
    { name: `chrome-headless-shell-${zipName}/chrome-headless-shell`, data: script, mode: 0o755 },
    { name: `chrome-headless-shell-${zipName}/resources.pak`, data: Buffer.alloc(5000, 7), method: 'store' },
    { name: `chrome-headless-shell-${zipName}/locales/en-US.pak`, data: 'x'.repeat(3000) },
  ]);
}

export function pinsFor(zipBuf, { platform = 'darwin-arm64', dir = 'mac_arm', zip = 'mac-arm64', urlBase, version = '9.9.9.9' } = {}) {
  return { version, urlBase, platforms: { [platform]: { dir, zip, sha256: sha256(zipBuf), bytes: zipBuf.length } } };
}
