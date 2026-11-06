// A minimal MP4 file for one H.264 track, no dependency: REVA's pictures are encoded by the browser's own WebCodecs and this wraps
// the chunks, so a scan needs no ffmpeg. The index sits at the front, and samples keep their own durations (a picture that did not
// change is not stored twice: it is one sample that lasts longer). `<video>` then seeks to any frame, from disk or from a server.

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const box = (name, ...parts) => { const body = Buffer.concat(parts.flat()); return Buffer.concat([u32(body.length + 8), Buffer.from(name, 'latin1'), body]); };
const full = (name, version, flags, ...parts) => box(name, u32(((version & 255) << 24) | flags), ...parts);
const zero = (n) => Buffer.alloc(n);
const MATRIX = Buffer.concat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);

/** Equal neighbouring durations as [count, delta] runs (stts). */
export function durationRuns(durations) {
  const out = [];
  for (const d of durations) { const l = out[out.length - 1]; if (l && l[1] === d) l[0]++; else out.push([1, d]); }
  return out;
}

/**
 * @param {{width:number, height:number, timescale:number, avcC:Buffer, samples:{data:Buffer, duration:number, key:boolean}[]}} o
 * @returns {Buffer} the whole file
 */
export function muxMp4({ width, height, timescale, avcC, samples }) {
  const total = samples.reduce((a, s) => a + s.duration, 0);
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(512), Buffer.from('isomiso2avc1mp41', 'latin1'));
  const runs = durationRuns(samples.map((s) => s.duration));
  const keys = samples.flatMap((s, i) => (s.key ? [i + 1] : []));
  const build = (offset) => {
    const avc1 = box('avc1', zero(6), u16(1), zero(16), u16(width), u16(height), u32(0x480000), u32(0x480000), u32(0), u16(1), zero(32), u16(24), Buffer.from([0xff, 0xff]), box('avcC', avcC));
    const stbl = box('stbl',
      full('stsd', 0, 0, u32(1), avc1),
      full('stts', 0, 0, u32(runs.length), ...runs.map(([n, d]) => Buffer.concat([u32(n), u32(d)]))),
      full('stss', 0, 0, u32(keys.length), ...keys.map(u32)),
      full('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
      full('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length))),
      full('stco', 0, 0, u32(1), u32(offset)));
    const minf = box('minf', full('vmhd', 0, 1, zero(8)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
    const mdia = box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(total), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), Buffer.from('vide', 'latin1'), zero(12), Buffer.from('REVA\0', 'latin1')), minf);
    const trak = box('trak', full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(total), zero(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16)), mdia);
    return box('moov', full('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(total), u32(0x10000), u16(0x100), zero(10), MATRIX, zero(24), u32(2)), trak);
  };
  const moov = build(ftyp.length + build(0).length + 8);
  const mdat = box('mdat', samples.map((s) => s.data));
  return Buffer.concat([ftyp, moov, mdat]);
}
