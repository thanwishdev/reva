// Clips and posters (DESIGN 5.4): what the card shows for a move is a real picture of the page, cropped around the move and
// cut from the take's pictures, at 60 Hz while it moves. Two sources: the take's JPEG files (at finish, before encodeTake deletes
// them) or the take's video (stored takes, M1 and G8). All sizes are even, since the H.264 encoder refuses odd ones.
//
// Pure parts (cropFor, planClip, posterRowFor, samplesFor) need no browser. cutClips() opens one encoder page, like encodeScan.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from '../browser/launch.js';
import { CLIP } from './moves/contract.js';
import { VIDEO_NAME, QP, bitrateFor, samplesOf, installEncoderHelpers, runEncoder } from './video.js';

const RATE = 60;
export const CLIPS_DIR = 'clips';
/** Said on a move that has a picture and no clip, when this machine's browser cannot encode H.264. */
export const NO_ENCODER_WORDS = "This machine's browser cannot encode video, so this move has a still picture and no clip.";

/** What the clips of one site may weigh, the 80 MB of DESIGN 8 with a margin, and what a clip keeps at the least. */
export const CLIP_BYTES = 72e6, MIN_BIT_SHARE = 0.5;
/** Clips came to 0.74 of their nominal bit rate on a small agency site (stored), 107 MB of 145 [M]; the larger clips run nearer 1. */
const FILL = 0.85;
/**
 * The encoder page opens file:///, and a take video on disk would taint its canvas without this. No network is reachable from it:
 * it loads no page, and only reads the take the scan itself wrote.
 */
export const ENCODER_ARGS = ['--use-mock-keychain', '--password-store=basic', '--allow-file-access-from-files'];

/**
 * The share of the full bit rate that brings a site's clips under the budget, the same for every clip, so none looks worse than its
 * neighbour. Never under MIN_BIT_SHARE: past that the text smears, and a clip over budget is reported, not ruined. Pure.
 * @param {{w:number, h:number, ms:number}[]} clips
 */
export function bitShare(clips, budget = CLIP_BYTES) {
  const bytes = clips.reduce((a, c) => a + (bitrateFor(c.w, c.h) * c.ms) / 8000, 0) * FILL;
  return bytes <= budget ? 1 : Math.max(MIN_BIT_SHARE, +(budget / bytes).toFixed(3));
}

/** Largest even number not above n, never below 2. */
export const evenDown = (n) => Math.max(2, Math.floor(n / 2) * 2);
/** Smallest even number not below n. */
export const evenUp = (n) => Math.ceil(n / 2) * 2;

/**
 * The frame of one move in CSS pixels. Union of the member boxes plus a margin of max(24 px, 15 %), grown to the smallest of
 * 16:10, 4:3, 1:1 and 3:4 that holds it, at least 480 x 300 (CLIP.minW, minH), then clamped to the viewport (a phone is 390 wide)
 * and made even. A viewport-shaped kind, or a union that fills the viewport, returns the whole viewport.
 * @param {{boxes:number[][], viewport:{width:number,height:number}, kind?:string, scale?:number}} o  boxes: [x, y, w, h] in viewport CSS px; scale: picture pixels per CSS pixel
 * @returns {{shape:'crop'|'viewport', x:number, y:number, w:number, h:number, pw:number, ph:number, scale:number}}
 */
export function cropFor({ boxes, viewport, kind = 'touch', scale = 1 }) {
  const vw = evenDown(viewport.width), vh = evenDown(viewport.height);
  const whole = () => finish({ shape: 'viewport', x: 0, y: 0, w: vw, h: vh });
  function finish(c) {
    const pw = evenDown(Math.round(c.w * scale)), ph = evenDown(Math.round(c.h * scale));
    return { ...c, pw, ph, scale };
  }
  const list = (boxes || []).filter((b) => b && b.length >= 4 && b[2] > 0 && b[3] > 0);
  if (['scroll', 'change'].includes(kind) || !list.length) return whole();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y, w, h] of list) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(viewport.width, x1); y1 = Math.min(viewport.height, y1);
  const uw = x1 - x0, uh = y1 - y0;
  if (uw <= 0 || uh <= 0) return whole();
  if (['load', 'gate'].includes(kind) && uw * uh >= CLIP.viewportShare * viewport.width * viewport.height) return whole();
  const mx = Math.max(CLIP.marginPx, CLIP.marginShare * uw), my = Math.max(CLIP.marginPx, CLIP.marginShare * uh);
  const needW = Math.max(CLIP.minW, uw + 2 * mx), needH = Math.max(CLIP.minH, uh + 2 * my);
  // The smallest snapped ratio box that holds the need. Ties go to the earlier ratio, so wide stays the first choice.
  let best = null;
  for (const [a, b] of CLIP.ratios) {
    const k = Math.max(needW / a, needH / b);
    const w = a * k, h = b * k;
    if (!best || w * h < best.w * best.h - 1e-6) best = { w, h };
  }
  let w = best.w, h = best.h;
  if (w >= viewport.width * 0.98 && h >= viewport.height * 0.98) return whole();
  // Phone clamp: a 480 wide minimum cannot exist on a 390 wide page. Clamp each side; the ratio gives way, the margin does not.
  w = Math.min(w, vw); h = Math.min(h, vh);
  w = evenUp(w); h = evenUp(h);
  if (w > vw) w = vw;
  if (h > vh) h = vh;
  let x = (x0 + x1) / 2 - w / 2, y = (y0 + y1) / 2 - h / 2;
  x = Math.min(Math.max(0, x), viewport.width - w); y = Math.min(Math.max(0, y), viewport.height - h);
  x = Math.round(x); y = Math.round(y);
  if (w >= vw && h >= vh) return whole();
  return finish({ shape: 'crop', x, y, w, h });
}

/** The picture a row shows: its own file index, or the last one before it when the shot gate skipped it. -1 before the first. */
export function pictureAt(rows, r) {
  for (let i = Math.min(r, rows.length - 1); i >= 0; i--) if (rows[i][3] >= 0) return rows[i][3];
  return -1;
}

/**
 * Which rows of the take a clip holds. At most `maxMs`; a hold longer than `holdMs` loses its middle (the marks then say so);
 * a scroll longer than `maxMs` is sampled to reach the end of the range, never cut.
 * @param {{fromRow:number, toRow:number, kind?:string, marks?:object, rate?:number}} o  rows [fromRow, toRow); marks in rows of the take: in, held, press, out
 * @returns {{segments:number[][], step:number, frames:number, ms:number, sampled:boolean, trimmed:boolean, marks:object}}
 */
export function planClip({ fromRow, toRow, kind = 'touch', marks = {}, rate = RATE }) {
  const maxF = Math.round((CLIP.maxMs * rate) / 1000), holdF = Math.round((CLIP.holdMs * rate) / 1000);
  const from = Math.max(0, Math.floor(fromRow)), to = Math.max(from + 1, Math.floor(toRow));
  let segs = [[from, to]], step = 1, sampled = false, trimmed = false;
  const size = () => segs.reduce((a, s) => a + (s[1] - s[0]), 0);
  if (kind === 'scroll') {
    if (to - from > maxF) { step = Math.ceil((to - from) / maxF); sampled = true; }
  } else {
    const held = Number.isFinite(marks.held) ? marks.held : null;
    if (held !== null && held >= from && held < to) {
      const next = [marks.press, marks.out].filter((m) => Number.isFinite(m) && m > held && m < to).sort((a, b) => a - b)[0] ?? to;
      if (next - held > holdF) {
        const keep = Math.floor(holdF / 2);
        segs = [[from, held + keep], [next - keep, to]]; trimmed = true;
      }
    }
    // A cap on length: the tail goes first, since a move shows its start.
    let over = size() - maxF;
    while (over > 0 && segs.length) {
      const last = segs[segs.length - 1], len = last[1] - last[0];
      if (len > over) { last[1] -= over; over = 0; } else { over -= len; segs.pop(); }
      trimmed = true;
    }
  }
  const frames = Math.ceil(size() / step);
  const clipSeconds = (row) => {
    let before = 0;
    for (const s of segs) {
      if (row < s[0]) break;
      if (row < s[1]) return (before + (row - s[0])) / step / rate;
      before += s[1] - s[0];
    }
    return before / step / rate;
  };
  const out = {};
  for (const k of ['in', 'held', 'press', 'out']) if (Number.isFinite(marks[k])) out[k] = +clipSeconds(marks[k]).toFixed(3);
  if (out.in === undefined) out.in = 0;
  return { segments: segs, step, frames, ms: Math.round((frames * 1000) / rate), sampled, trimmed, marks: out };
}

/**
 * The pictures of a plan, in order, one per distinct file, each lasting for the frames it fills (a gated stretch is one long
 * picture, like a sample in take video). @returns {{f:number, frames:number}[]}
 */
export function samplesFor(rows, plan) {
  const out = [];
  for (const [a, b] of plan.segments) {
    for (let r = a; r < b; r += plan.step) {
      const f = pictureAt(rows, r);
      if (f < 0) continue;
      const frames = Math.min(plan.step, b - r);
      const l = out[out.length - 1];
      if (l && l.f === f) l.frames += frames; else out.push({ f, frames });
    }
  }
  return out;
}

/**
 * The row a poster is cut from, by kind (DESIGN 5.3): load and gate at the peak, scroll in the middle of its band, touch at rest,
 * open when open, change in the middle of the transition, anything that loops in the middle.
 * @param {{fromRow:number, toRow:number, kind?:string, marks?:object, peakRow?:number}} o
 */
export function posterRowFor({ fromRow, toRow, kind = 'touch', marks = {}, peakRow }) {
  const mid = Math.floor((fromRow + Math.max(fromRow, toRow - 1)) / 2);
  const clamp = (r) => Math.min(Math.max(fromRow, Math.round(r)), Math.max(fromRow, toRow - 1));
  if (kind === 'load' || kind === 'gate') return clamp(Number.isFinite(peakRow) ? peakRow : fromRow + 0.4 * (toRow - fromRow));
  if (kind === 'touch') return clamp(fromRow);
  if (kind === 'open') return clamp(Number.isFinite(marks.opened) ? marks.opened : Number.isFinite(marks.held) ? marks.held : toRow - 1);
  return clamp(mid);
}

/** The take's hero span in seconds of its video: where load ends and where the scroll runs. Phase names as frames.json writes them. */
export function heroSpans(doc) {
  const ph = (n) => (doc.phases || []).find((p) => p.name === n);
  const sec = (r) => +(r / RATE).toFixed(3);
  const out = {};
  const load = ph('load'), gate = ph('gate'), down = ph('scroll-down') || ph('scroll'), up = ph('scroll-up');
  if (load) out.load = [sec(load.from), sec((gate || load).to)];
  if (down) out.scroll = [sec(down.from), sec((up || down).to)];
  return out;
}

// ---------------------------------------------------------------- in the encoder page

/** In the page: the source of pictures when it is a take video. */
async function openVideoInPage({ url }) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = url;
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('the take video did not load')); });
  window.__vid = v;
  return { w: v.videoWidth, h: v.videoHeight, d: v.duration };
}
/** In the page: draw one picture's crop onto the shared canvas. Source: a JPEG (base64) or the take video at time t. */
async function drawInPage({ jpg, t, c }) {
  let cv = window.__cv;
  if (!cv || cv.width !== c.w || cv.height !== c.h) { cv = window.__cv = new OffscreenCanvas(c.w, c.h); window.__cx = cv.getContext('2d'); }
  const cx = window.__cx;
  if (jpg) {
    const bin = Uint8Array.from(atob(jpg), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: 'image/jpeg' }));
    cx.drawImage(bmp, c.sx, c.sy, c.sw, c.sh, 0, 0, c.w, c.h); bmp.close();
  } else {
    const v = window.__vid;
    if (Math.abs(v.currentTime - t) > 1e-4) { await new Promise((res) => { v.onseeked = res; v.currentTime = t; }); }
    cx.drawImage(v, c.sx, c.sy, c.sw, c.sh, 0, 0, c.w, c.h);
  }
  return cv;
}
/** In the page: one clip frame to the encoder. */
async function pushCropInPage(a) {
  const S = window.__enc; if (S.error) throw new Error(S.error);
  const cv = await window.__draw(a);
  const f = new VideoFrame(cv, { timestamp: a.ts });
  S.encoder.encode(f, S.qp == null ? { keyFrame: a.key } : { keyFrame: a.key, avc: { quantizer: S.qp } }); f.close();
  while (S.encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 1));
  return S.chunks.length;
}
/** In the page: one crop as a JPEG, base64. */
async function posterInPage(a) {
  const cv = await window.__draw(a);
  const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: a.q });
  const u = new Uint8Array(await blob.arrayBuffer());
  return self.__b64(u);
}

async function prepare(page) {
  await page.goto('file:///');
  await installEncoderHelpers(page);
  await page.evaluate(`window.__draw=${drawInPage.toString()}`);
}

/** Pixel crop of a picture, from a CSS crop: the picture is `doc.size`, at `doc.scale` pixels per CSS pixel. */
export function pixelCrop(crop, doc) {
  const sc = doc.scale || 1, size = doc.size || { width: Math.round((doc.clip?.width || 0) * sc), height: Math.round((doc.clip?.height || 0) * sc) };
  const sx = Math.min(Math.round(crop.x * sc), Math.max(0, size.width - 2)), sy = Math.min(Math.round(crop.y * sc), Math.max(0, size.height - 2));
  const sw = Math.min(Math.round(crop.w * sc), size.width - sx), sh = Math.min(Math.round(crop.h * sc), size.height - sy);
  return { sx, sy, sw, sh, w: evenDown(sw), h: evenDown(sh) };
}

/** What a take offers as pictures: JPEG files, or its video, or nothing. */
export function sourceOf(dir) {
  const file = path.join(dir, 'frames.json');
  if (!fs.existsSync(file)) return null;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc.size || !doc.rows?.length) return null;
  const jpegs = fs.readdirSync(dir).some((n) => /^\d+\.jpg$/.test(n));
  if (jpegs) return { kind: 'jpeg', doc, dir };
  if (doc.video && fs.existsSync(path.join(dir, doc.video.file || VIDEO_NAME))) return { kind: 'video', doc, dir, file: path.join(dir, doc.video.file || VIDEO_NAME) };
  return null;
}

/** Arguments of drawInPage for picture f of a source. Video time: the middle of the picture's first row. */
function drawArgs(src, f, firstRow, c) {
  if (src.kind === 'jpeg') return { jpg: fs.readFileSync(path.join(src.dir, String(f).padStart(5, '0') + '.jpg')).toString('base64'), c };
  return { t: (firstRow + 0.5) / RATE, c };
}

/**
 * Cut clips and posters for a list of requests, in one encoder page. Write nothing outside `<root>/clips/`.
 * @param {string} root  the scan folder
 * @param {{id:string, take:string, phone?:boolean, boxes:number[][], kind:string, fromRow:number, toRow:number, marks?:object, peakRow?:number, viewport:{width:number,height:number}}[]} requests
 *        take: the picture folder, relative to root. phone: the file name gets `-p`.
 * @returns {Promise<{results:object[], encoded:number, posters:number, bytes:number, wallMs:number, why:string|null}>}
 *          a result is { id, frame:{shape,w,h,clip,poster,ms,fps,marks} } or { id, frame:{poster,...}, gap } or { id, error }
 */
export async function cutClips(root, requests, { engine, log = () => {}, launch = launchBrowser } = {}) {
  const t0 = Date.now(), res = { results: [], encoded: 0, posters: 0, shared: 0, bytes: 0, wallMs: 0, why: null };
  if (!requests.length) return res;
  const posters_ = new Map(), clips_ = new Map(); // the same pictures in the same frame -> the file that holds them
  const outDir = path.join(root, CLIPS_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const sources = new Map(), sourceFor = (take) => { if (!sources.has(take)) sources.set(take, sourceOf(path.join(root, take))); return sources.get(take); };
  const sized = requests.flatMap((rq) => { const s = sourceFor(rq.take); if (!s) return []; const c = pixelCrop(cropFor({ boxes: rq.boxes, viewport: rq.viewport, kind: rq.kind, scale: s.doc.scale || 1 }), s.doc); return [{ w: c.w, h: c.h, ms: planClip(rq).ms }]; });
  const share = res.scale = bitShare(sized);
  const h = await launch({ engine, context: { viewport: { width: 400, height: 300 } }, args: ENCODER_ARGS });
  try {
    await prepare(h.page);
    let open = null, canEncode = true;
    for (const rq of requests) {
      const src = sourceFor(rq.take);
      if (!src) { res.results.push({ id: rq.id, error: `no pictures in ${rq.take}` }); continue; }
      try {
        if (src.kind === 'video' && open !== src.file) { await h.page.evaluate(openVideoInPage, { url: pathToFileURL(src.file).href }); open = src.file; }
        const rows = src.doc.rows, list = samplesOf(rows), firstRow = new Map(list.map((s) => [s.f, s.from]));
        const crop = cropFor({ boxes: rq.boxes, viewport: rq.viewport, kind: rq.kind, scale: src.doc.scale || 1 });
        const px = pixelCrop(crop, src.doc);
        const name = rq.id + (rq.phone ? '-p' : '');
        const jpg = `${CLIPS_DIR}/${name}.jpg`, mp4 = `${CLIPS_DIR}/${name}.mp4`;
        const pr = posterRowFor(rq);
        const pf = pictureAt(rows, pr);
        if (pf < 0) { res.results.push({ id: rq.id, error: 'no picture at the poster row' }); continue; }
        const plan = planClip(rq);
        const pics = samplesFor(rows, plan);
        // The same picture in the same frame is one file: a poster or a clip another move already wrote is named again, not made
        // again (the card reads the file named in the result, never one named after the move)
        const pKey = JSON.stringify([rq.take, px, pf, firstRow.get(pf) ?? pr]);
        let poster = posters_.get(pKey);
        if (poster) res.shared++;
        else {
          const pb = await h.page.evaluate(posterInPage, { ...drawArgs(src, pf, firstRow.get(pf) ?? pr, px), q: CLIP.posterQuality / 100 });
          fs.writeFileSync(path.join(root, jpg), Buffer.from(pb, 'base64')); res.posters++; posters_.set(pKey, poster = jpg);
        }
        const base = { shape: crop.shape, w: px.w, h: px.h, poster, ms: plan.ms, fps: RATE, marks: plan.marks };
        const extra = { ...(plan.sampled ? { sampled: plan.step } : {}), ...(plan.trimmed ? { trimmed: true } : {}) };
        const cKey = JSON.stringify([rq.take, px, pics.map((q) => [q.f, q.frames])]);
        if (canEncode && pics.length && clips_.has(cKey)) { res.shared++; res.results.push({ id: rq.id, frame: { ...base, clip: clips_.get(cKey) }, ...extra }); continue; }
        if (!canEncode || !pics.length) { res.results.push({ id: rq.id, frame: { ...base, clip: null }, gap: NO_ENCODER_WORDS }); continue; }
        let ts = 0;
        const starts = pics.map((p) => { const t = ts; ts += p.frames; return t; });
        const made = await runEncoder(h.page, {
          width: px.w, height: px.h, durations: pics.map((p) => p.frames), gop: CLIP.gop, bitrate: Math.round(bitrateFor(px.w, px.h) * share), qp: QP.clip,
          push: (i, key) => h.page.evaluate(pushCropInPage, { ...drawArgs(src, pics[i].f, firstRow.get(pics[i].f) ?? 0, px), ts: Math.round((starts[i] * 1e6) / RATE), key }),
        });
        if (made.error) {
          if (/no H\.264 encoder|no WebCodecs/.test(made.error)) canEncode = false;
          res.why = made.error; log(`clip ${rq.id}: ${made.error}`);
          res.results.push({ id: rq.id, frame: { ...base, clip: null }, gap: NO_ENCODER_WORDS }); continue;
        }
        fs.writeFileSync(path.join(root, mp4), made.mp4); res.encoded++; res.bytes += made.mp4.length; if (made.qp != null) res.qp = made.qp;
        clips_.set(cKey, mp4); res.results.push({ id: rq.id, frame: { ...base, clip: mp4 }, ...extra });
      } catch (e) { res.results.push({ id: rq.id, error: String(e.message || e).split('\n')[0] }); }
    }
  } finally { await h.close(); }
  res.wallMs = Date.now() - t0;
  return res;
}

/**
 * A hero poster: the whole viewport at the end of the load, written to clips/hero-<page>-<viewport>.jpg. Same encoder page rules as
 * cutClips; one request per page and viewport. @param {{page:string, viewportName:string, take:string, row:number, viewport:{width:number,height:number}}[]} heroes
 * @returns {Promise<{hero:{poster:string, load?:number[], scroll?:number[]}, page:string, viewportName:string}[]>}
 */
export async function cutHeroPosters(root, heroes, { engine, log = () => {}, launch = launchBrowser } = {}) {
  const out = [];
  if (!heroes.length) return out;
  fs.mkdirSync(path.join(root, CLIPS_DIR), { recursive: true });
  const h = await launch({ engine, context: { viewport: { width: 400, height: 300 } }, args: ENCODER_ARGS });
  try {
    await prepare(h.page);
    let open = null;
    for (const hr of heroes) {
      const src = sourceOf(path.join(root, hr.take));
      if (!src) { log(`hero ${hr.page}: no pictures`); continue; }
      try {
        if (src.kind === 'video' && open !== src.file) { await h.page.evaluate(openVideoInPage, { url: pathToFileURL(src.file).href }); open = src.file; }
        const rows = src.doc.rows, firstRow = new Map(samplesOf(rows).map((s) => [s.f, s.from]));
        const f = pictureAt(rows, hr.row); if (f < 0) continue;
        const crop = cropFor({ boxes: [], viewport: hr.viewport, kind: 'scroll', scale: src.doc.scale || 1 });
        const px = pixelCrop(crop, src.doc);
        const rel = `${CLIPS_DIR}/hero-${hr.page}-${hr.viewportName}.jpg`;
        const b = await h.page.evaluate(posterInPage, { ...drawArgs(src, f, firstRow.get(f) ?? hr.row, px), q: CLIP.posterQuality / 100 });
        fs.writeFileSync(path.join(root, rel), Buffer.from(b, 'base64'));
        out.push({ page: hr.page, viewportName: hr.viewportName, hero: { poster: rel, ...heroSpans(src.doc) } });
      } catch (e) { log(`hero ${hr.page}: ${String(e.message || e).split('\n')[0]}`); }
    }
  } finally { await h.close(); }
  return out;
}
