// Pictures to video (PLAN §8): every take's frames become one H.264 file, encoded by the browser REVA already runs (WebCodecs),
// one keyframe every 15 pictures. Measured 2 Nov: about 8 times smaller than JPEG, a random seek in 5 ms. When this machine's
// browser cannot encode H.264, the JPEG files stay and the card plays those: nothing is lost, only disk.
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../browser/launch.js';
import { muxMp4 } from './mp4.js';

export const VIDEO_NAME = 'video.mp4';
export const GOP = 15;
/** One recorded frame at 60 Hz in the file's time scale. */
export const TICKS = 100;
export const TIMESCALE = 6000;
export const H264_CODECS = ['avc1.640033', 'avc1.640032', 'avc1.4d0033', 'avc1.42e033'];

/** Bits per second for a picture size: enough for text to stay sharp at 60 pictures a second. */
export const bitrateFor = (w, h) => Math.round(Math.min(14e6, Math.max(2e6, w * h * 5)));

/** A take video is the Study view, not the clip a person studies: 0.65 of the size at 60 % of the rate, SSIM down 0.002-0.01 (DESIGN 3.5). */
export const TAKE_BIT_SHARE = 0.6;

/**
 * Constant quality instead of a fixed rate (DESIGN 8, size). A fixed rate spends the same bits on a still page as on a WebGL scene;
 * a fixed quantizer spends what each picture needs. Measured 3 Nov, two stored sites (a 3D portfolio site, a large marketing site) re-encoded with this browser (VideoToolbox):
 * takes at QP 32 went 138 to 61 MB and 157 to 90 MB, clips at QP 26 61 to 47 MB; text and edges equal at 100 %, mean SSIM to the
 * old file 0.99. A clip is what a person studies, so it gets the finer step.
 * A browser without the quantizer mode gets the fixed rate as before, and a file the quantizer makes larger than the fixed rate would
 * is encoded again at that rate (noise, grain), so no file grows.
 */
export const QP = Object.freeze({ take: 32, clip: 26 });

/** In the page: set up the encoder; chunks wait in window.__enc until they are taken. With qp, constant quality when it can. */
export async function encoderInPage({ width, height, bitrate, codecs, qp = null }) {
  if (!window.VideoEncoder) return { error: 'this browser has no WebCodecs' };
  let cfg = null;
  const modes = Number.isFinite(qp) ? ['quantizer', 'variable'] : ['variable'];
  for (const mode of modes) {
    for (const codec of codecs) {
      const c = { codec, width, height, framerate: 60, latencyMode: 'quality', avc: { format: 'avc' } };
      if (mode === 'quantizer') c.bitrateMode = 'quantizer'; else c.bitrate = bitrate;
      try { if ((await VideoEncoder.isConfigSupported(c)).supported) { cfg = c; break; } } catch { /* the next one */ }
    }
    if (cfg) break;
  }
  if (!cfg) return { error: `no H.264 encoder for ${width} x ${height}` };
  const S = window.__enc = { chunks: [], description: null, error: null, n: 0, qp: cfg.bitrateMode === 'quantizer' ? qp : null };
  S.encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && meta.decoderConfig.description && !S.description) S.description = new Uint8Array(meta.decoderConfig.description instanceof ArrayBuffer ? meta.decoderConfig.description : meta.decoderConfig.description.buffer);
      const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b);
      S.chunks.push({ key: chunk.type === 'key', ts: chunk.timestamp, b });
    },
    error: (e) => { S.error = String(e.message || e); },
  });
  S.encoder.configure(cfg);
  return { codec: cfg.codec, qp: S.qp };
}
export const b64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); };
export async function pushInPage({ jpg, ts, key }) {
  const S = window.__enc; if (S.error) throw new Error(S.error);
  const bin = Uint8Array.from(atob(jpg), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bin], { type: 'image/jpeg' }));
  const f = new VideoFrame(bmp, { timestamp: ts });
  S.encoder.encode(f, S.qp == null ? { keyFrame: key } : { keyFrame: key, avc: { quantizer: S.qp } }); f.close(); bmp.close();
  while (S.encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 1));
  return S.chunks.length;
}
export async function takeInPage(flush) {
  const S = window.__enc;
  if (flush) await S.encoder.flush();
  if (S.error) throw new Error(S.error);
  const out = S.chunks.splice(0, 40).map((c) => ({ key: c.key, ts: c.ts, b: self.__b64(c.b) }));
  return { out, left: S.chunks.length, description: flush && S.description ? self.__b64(S.description) : null };
}

/** The sample list from frames.json rows: one sample per distinct picture, lasting until the next one. */
export function samplesOf(rows) {
  const out = [];
  rows.forEach((r, i) => { const f = r[3]; if (f < 0) return; if (!out.length || out[out.length - 1].f !== f) out.push({ f, from: i }); });
  out.forEach((s, j) => { s.frames = (j + 1 < out.length ? out[j + 1].from : rows.length) - s.from; });
  return out;
}

/** Once per encoder page: the helper the in-page code uses to hand bytes back. */
export const installEncoderHelpers = (page) => page.evaluate(`self.__b64=${b64.toString()}`);

/**
 * Encode pictures the caller feeds one by one, and mux them. `push(i, key)` runs the in-page push for picture i and returns the
 * number of chunks waiting; `durations[i]` is how many 60 Hz frames picture i lasts. Used by the clip cutter (clips.js), which
 * decides what a picture is (a crop of a JPEG, a crop of a take-video frame); the file layout is the same as encodeTake's.
 * With `qp`, constant quality (QP); when that file may be larger than `bitrate` would make it, it is encoded at `bitrate` too and
 * the smaller one kept.
 * @returns {Promise<{mp4:Buffer, codec:string, pictures:number, qp:number|null}|{error:string}>}
 */
export async function runEncoder(page, { width, height, durations, push, gop = GOP, bitrate = bitrateFor(width, height), qp = null }) {
  if (width % 2 || height % 2) return { error: `odd picture size ${width} x ${height}` };
  const made = await encodeOnce(page, { width, height, durations, push, gop, bitrate, qp });
  if (made.error || made.qp == null || made.mp4.length <= TRY_RATE * rateBytes(bitrate, durations)) return made;
  const rate = await encodeOnce(page, { width, height, durations, push, gop, bitrate, qp: null });
  return !rate.error && rate.mp4.length < made.mp4.length ? rate : made;
}

/**
 * A rate-encoded file lands at 0.75-0.95 of its nominal size, so a quantizer file past 0.7 of it may be the larger: then both are
 * made and the smaller kept. Measured 3 Nov: the rate file won for 57 of 308 clips (the marketing site at the 0.5 share floor) and 1 of 191 takes.
 */
export const TRY_RATE = 0.7;

/** What a file at a fixed rate weighs, for pictures lasting `durations` frames at 60 Hz. Pure. */
export const rateBytes = (bitrate, durations) => (bitrate * durations.reduce((a, d) => a + d, 0)) / 60 / 8;

async function encodeOnce(page, { width, height, durations, push, gop, bitrate, qp }) {
  const start = await page.evaluate(encoderInPage, { width, height, bitrate, codecs: H264_CODECS, qp });
  if (start.error) return { error: start.error };
  const got = [];
  const drain = async (flush) => { for (;;) { const r = await page.evaluate(takeInPage, flush); got.push(...r.out); if (r.description) got.description = r.description; if (!r.left && (!flush || r.out.length < 40)) return; } };
  try {
    for (let i = 0; i < durations.length; i++) { const n = await push(i, i % gop === 0); if (n >= 40) await drain(false); }
    await drain(true);
    await drain(false);
  } finally { await page.evaluate(() => { try { window.__enc.encoder.close(); } catch { /* closed */ } }).catch(() => {}); }
  if (got.length !== durations.length || !got.description) return { error: `the encoder gave ${got.length} of ${durations.length} pictures` };
  for (let i = 1; i < got.length; i++) if (got[i].ts <= got[i - 1].ts) return { error: 'the encoder reordered pictures' };
  const samples = got.map((c, i) => ({ data: Buffer.from(c.b, 'base64'), key: c.key, duration: durations[i] * TICKS }));
  return { mp4: muxMp4({ width, height, timescale: TIMESCALE, avcC: Buffer.from(got.description, 'base64'), samples }), codec: start.codec, pictures: got.length, qp: start.qp ?? null };
}

/** Encode one picture folder; the JPEG files are removed only when the file holds every picture. */
export async function encodeTake(page, dir) {
  const file = path.join(dir, 'frames.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc.video) return { skipped: true, bytes: fs.statSync(path.join(dir, doc.video.file)).size };
  const list = samplesOf(doc.rows);
  if (!list.length || !doc.size) return { skipped: true, bytes: 0 };
  const { width, height } = doc.size;
  if (width % 2 || height % 2) return { error: `odd picture size ${width} x ${height}` };
  const name = (s) => path.join(dir, String(s.f).padStart(5, '0') + '.jpg');
  const made = await runEncoder(page, {
    width, height, durations: list.map((s) => s.frames), gop: GOP, bitrate: Math.round(bitrateFor(width, height) * TAKE_BIT_SHARE), qp: QP.take,
    push: (i, key) => page.evaluate(pushInPage, { jpg: fs.readFileSync(name(list[i])).toString('base64'), ts: Math.round((list[i].from * 1e6) / 60), key }),
  });
  if (made.error) return { error: made.error };
  const mp4 = made.mp4;
  fs.writeFileSync(path.join(dir, VIDEO_NAME), mp4);
  const rate = made.qp == null ? { bitShare: TAKE_BIT_SHARE } : { qp: made.qp };
  fs.writeFileSync(file, JSON.stringify({ ...doc, video: { file: VIDEO_NAME, codec: made.codec, fps: 60, gop: GOP, bytes: mp4.length, ...rate } }));
  for (const f of fs.readdirSync(dir)) if (/^\d+\.jpg$/.test(f)) fs.rmSync(path.join(dir, f));
  return { bytes: mp4.length, jpegBytes: doc.bytes, pictures: list.length };
}

/** Every picture folder of a scan (the first page and the others). */
export function pictureDirs(out) {
  const roots = [out];
  const pages = path.join(out, 'pages');
  if (fs.existsSync(pages)) for (const p of fs.readdirSync(pages)) roots.push(path.join(pages, p));
  const dirs = [];
  for (const r of roots) { const f = path.join(r, 'frames'); if (!fs.existsSync(f)) continue; for (const vp of fs.readdirSync(f)) for (const t of fs.readdirSync(path.join(f, vp))) if (fs.existsSync(path.join(f, vp, t, 'frames.json'))) dirs.push(path.join(f, vp, t)); }
  return dirs;
}

/**
 * Two encoder browsers take folders from one queue. The cost of a picture is mostly the trip into the page and the JPEG decode,
 * not the encoder: measured 5 Nov on a 3D portfolio site's two arrive takes, twice (4 folders, 18.9 MB of video), one browser 43.8 s, two
 * 24.5 s, three 23.4 s, two pages of one browser 33.9 s; every file the same size.
 */
export const ENCODERS = 2;

/** @returns {{takes:number, encoded:number, kept:number, bytes:number, jpegBytes:number, wallMs:number, why:string|null}} */
export async function encodeScan(out, { engine, log = () => {}, encoders = ENCODERS } = {}) {
  const t0 = Date.now();
  const dirs = pictureDirs(out);
  const res = { takes: dirs.length, encoded: 0, kept: 0, bytes: 0, jpegBytes: 0, wallMs: 0, why: null };
  if (!dirs.length) return res;
  const queue = [...dirs];
  const one = async () => {
    const h = await launchBrowser({ engine, context: { viewport: { width: 400, height: 300 } }, args: ['--use-mock-keychain', '--password-store=basic'] });
    try {
      await h.page.goto('file:///');
      await h.page.evaluate(`self.__b64=${b64.toString()}`);
      for (let d; (d = queue.shift());) {
        const r = await encodeTake(h.page, d).catch((e) => ({ error: String(e.message).split('\n')[0] }));
        if (r.error) { res.kept++; res.why = r.error; log(`pictures of ${path.relative(out, d)} stay as JPEG: ${r.error}`); continue; }
        if (!r.skipped) { res.encoded++; res.jpegBytes += r.jpegBytes; }
        res.bytes += r.bytes;
      }
    } finally { await h.close(); }
  };
  const ends = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(encoders, dirs.length)) }, one));
  if (ends.every((x) => x.status === 'rejected')) throw ends[0].reason; // one browser that opened drains the whole queue
  res.wallMs = Date.now() - t0;
  return res;
}
