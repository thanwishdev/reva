// Frame recorder (PLAN §4 frames, §8 stage): real pictures of the page on the virtual clock, taken between two frames
// of the take, so every picture lines up with one row of the take (same frame key k). Measured 2 Nov: capturing does not
// change the recorded values (57 of 5.06 M differ, two runs without capture differ in 56).
//
//   <dir>/00000.jpg ...   one file per picture that differs from the one before (an identical picture is not stored twice)
//   <dir>/frames.json     { cols: ['k','T','sy','f'], rows: [[k, T, scrollY, fileIndex], ...], phases: [{name, from, to}] }
//
// A CDP clip is in PAGE coordinates, so the clip follows the scroll (the 'clip at 0,0' mistake of look/screens.js, fixed 2 Nov).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SHOTS } from './moves/contract.js';

export const FRAMES_SCHEMA = 'reva.frames/0';
/** Output width target in pixels. The JPEG files are only a step: at the end of a scan each take becomes one H.264 file (video.js). */
export const FRAME_WIDTH = 1440;
export const FRAME_QUALITY = 82;

/**
 * The shot gate (DESIGN 3.3), pure. Rows stay at 60 Hz on every frame; a picture is taken only when it can differ.
 * pictures: 'gate' every frame that moved, 'cap' the same at 30 a second, 'floor' repeats and inside tests, 'all' every frame.
 * Always the first frame of a phase, and at least every SHOTS.floor frames. `off`: something no row can see is in view, so
 * "nothing moved" means nothing: those frames get 30 a second. What moved keeps its rate. The floor stays: those frames are repeats.
 */
export function wantShot({ pictures = 'gate', fresh, gap, moved, off }) {
  if (pictures === 'all' || fresh || gap >= SHOTS.floor) return true;
  if (pictures === 'floor') return false;
  if (moved) return pictures === 'cap' ? gap >= 2 : true;
  return !!off && gap >= 2;
}

/** Pixel size of a JPEG from its first SOF marker, or null. */
export function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * @param {object} S  a record session (src/record/session.js)
 * @param {{dir:string, width:number, height:number, targetWidth?:number, quality?:number, gate?:boolean}} o  width/height: the
 *   viewport in CSS px; gate: the shot gate, for a session with o.scan
 */
export function frameRecorder(S, { dir, width, height, targetWidth = FRAME_WIDTH, quality = FRAME_QUALITY, gate = false }) {
  fs.mkdirSync(dir, { recursive: true });
  const scale = Math.min(1, targetWidth / width);
  const rows = [], phases = [];
  let files = 0, last = null, dup = 0, bytes = 0, size = null, cur = null, ms = 0, shots = 0, skipped = 0, lastK = -1e9, offBy = null;
  /** One frame of `phase`. { pictures } as wantShot; { quiet: n } also reads W.quiet(n) in the same call: the result's `quiet`. */
  const shot = async (phase, { pictures = 'gate', quiet = 0 } = {}) => {
    const t0 = Date.now();
    const fresh = !cur || cur.name !== phase;
    if (fresh) { cur = { name: phase, from: rows.length, to: rows.length, shots: 0 }; phases.push(cur); }
    const m = await S.evRetry(gate ? (n) => window.__WR.shotInfo(n) : () => ({ k: window.__WR.frameKey(), T: performance.now(), sx: scrollX, sy: scrollY }), quiet);
    if (m.off) offBy = m.off;
    // (a new document restarts k: no gap to measure)
    if (gate && files && !wantShot({ pictures, fresh: fresh || m.k <= lastK, gap: m.k - lastK, moved: m.moved, off: m.off })) {
      skipped++; rows.push([m.k, m.T, m.sy, files - 1]); cur.to = rows.length; ms += Date.now() - t0;
      return m;
    }
    lastK = m.k; shots++; cur.shots++;
    const r = await S.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality, fromSurface: true, captureBeyondViewport: false, ...(scale === 1 ? {} : { clip: { x: m.sx || 0, y: m.sy, width, height, scale } }) }); // a clip from this second session clears the page's emulation: a phone drops to DPR 1
    const b = Buffer.from(r.data, 'base64');
    const h = crypto.createHash('sha1').update(b).digest('hex');
    if (h !== last) {
      fs.writeFileSync(path.join(dir, String(files).padStart(5, '0') + '.jpg'), b);
      if (!size) size = jpegSize(b);
      files++; bytes += b.length; last = h;
    } else dup++;
    rows.push([m.k, m.T, m.sy, files - 1]);
    cur.to = rows.length;
    ms += Date.now() - t0;
    return m;
  };
  /** Write frames.json; returns the summary the ledger keeps as evidence. */
  const close = () => {
    const doc = { schema: FRAMES_SCHEMA, format: 'jpeg', quality, scale, clip: { width, height }, size, cols: ['k', 'T', 'sy', 'f'], rows, phases, files, bytes, ...(gate ? { gate: { floor: SHOTS.floor, shots, skipped, offBy } } : {}),
      note: 'f = index of the picture file (<f padded to 5>.jpg); a repeated f means the picture did not change' };
    fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(doc));
    return { dir, frames: rows.length, files, duplicates: dup, bytes, size, captureMs: ms, ...(gate ? { shots, skipped, offBy } : {}), phases: phases.map((p) => ({ name: p.name, from: p.from, to: p.to, ...(gate ? { shots: p.shots } : {}) })) };
  };
  return { shot, close, get count() { return rows.length; } };
}
