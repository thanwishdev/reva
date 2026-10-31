// Minimal zip reader/writer (store + deflate, no zip64, no encryption), enough for Playwright HAR zips.
// Why own code: the Node standard library has zlib but no zip container, and a dependency for ~80 lines is not worth it.
// Output is deterministic (fixed DOS timestamp, sorted by the caller) so an archive hashes the same twice.
import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_EOCD = 0x06054b50;

/** @returns {Map<string, Buffer>} entry name -> bytes (directories skipped) */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('zip: bad central directory entry');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('zip: zip64 is not supported');
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(lho) !== SIG_LOCAL) throw new Error(`zip: bad local header for ${name}`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`zip: unsupported compression method ${method} for ${name}`);
    if (data.length !== usize) throw new Error(`zip: size mismatch for ${name}`);
    out.set(name, data);
  }
  return out;
}

/** @param {Iterable<[string, Buffer]>} entries @returns {Buffer} */
export function writeZip(entries) {
  const parts = [], central = [];
  let offset = 0, count = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    let method = 0, body = data;
    if (data.length > 64) { const d = zlib.deflateRawSync(data); if (d.length < data.length) { method = 8; body = d; } }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); // 1980-01-01 00:00
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    parts.push(lh, nameBuf, body); central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length; count++;
    if (offset > 0xfffffff0 || count > 0xfffe) throw new Error('zip: archive too large (no zip64)');
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
