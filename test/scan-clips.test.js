// Clips and posters: the planning is pure and tested on numbers; the cutting runs against a fake encoder page that returns real-shaped chunks,
// so the file layout, the sizes and the marks are checked without a browser. No third-party data: pictures are invented bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cropFor, planClip, samplesFor, posterRowFor, pictureAt, heroSpans, cutClips, cutHeroPosters, sourceOf, evenDown, evenUp, NO_ENCODER_WORDS, bitShare, CLIP_BYTES, MIN_BIT_SHARE } from '../src/scan/clips.js';
import { runEncoder, bitrateFor, rateBytes, encodeTake, QP, TAKE_BIT_SHARE } from '../src/scan/video.js';

const DESK = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
const even = (n) => n % 2 === 0;

test('evenDown and evenUp', () => {
  assert.equal(evenDown(481), 480); assert.equal(evenDown(1), 2); assert.equal(evenUp(481), 482); assert.equal(evenUp(480), 480);
});

test('a small button gets its surroundings: at least 480 x 300, even, inside the viewport, centred on it', () => {
  const c = cropFor({ boxes: [[700, 400, 120, 40]], viewport: DESK, kind: 'touch' });
  assert.equal(c.shape, 'crop');
  assert.ok(c.w >= 480 && c.h >= 300);
  assert.ok(even(c.w) && even(c.h) && even(c.pw) && even(c.ph));
  assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= DESK.width && c.y + c.h <= DESK.height);
  assert.ok(c.x < 760 && c.x + c.w > 760 && c.y < 420 && c.y + c.h > 420, 'the button lies inside');
});

test('the crop snaps to one of the four ratios when it can', () => {
  const c = cropFor({ boxes: [[100, 100, 500, 100]], viewport: DESK, kind: 'touch' });
  const r = c.w / c.h;
  assert.ok([1.6, 4 / 3, 1, 0.75].some((x) => Math.abs(x - r) < 0.02), String(r));
});

test('a union at a viewport corner stays inside the viewport', () => {
  for (const b of [[0, 0, 60, 30], [1400, 870, 40, 30], [0, 870, 50, 30], [1390, 0, 50, 30]]) {
    const c = cropFor({ boxes: [b], viewport: DESK, kind: 'hover' });
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= DESK.width && c.y + c.h <= DESK.height, JSON.stringify(c));
    assert.ok(even(c.w) && even(c.h));
  }
});

test('phone clamp: the 480 minimum gives way to a 390 wide page, sizes stay even', () => {
  const c = cropFor({ boxes: [[100, 300, 150, 60]], viewport: PHONE, kind: 'touch' });
  assert.ok(c.w <= 390 && c.h <= 844 && even(c.w) && even(c.h));
  assert.ok(c.x >= 0 && c.x + c.w <= 390);
  const odd = cropFor({ boxes: [[10, 10, 50, 50]], viewport: { width: 391, height: 845 }, kind: 'touch' });
  assert.ok(even(odd.w) && even(odd.h) && odd.x + odd.w <= 391);
});

test('picture pixels follow the scale and are even', () => {
  const c = cropFor({ boxes: [[500, 300, 101, 51]], viewport: DESK, kind: 'touch', scale: 0.77 });
  assert.ok(even(c.pw) && even(c.ph));
});

test('viewport-shaped kinds and big load unions take the whole viewport', () => {
  assert.equal(cropFor({ boxes: [[10, 10, 50, 50]], viewport: DESK, kind: 'scroll' }).shape, 'viewport');
  assert.equal(cropFor({ boxes: [[10, 10, 50, 50]], viewport: DESK, kind: 'change' }).shape, 'viewport');
  assert.equal(cropFor({ boxes: [[0, 0, 1400, 800]], viewport: DESK, kind: 'load' }).shape, 'viewport');
  assert.equal(cropFor({ boxes: [[600, 300, 100, 100]], viewport: DESK, kind: 'load' }).shape, 'crop');
  assert.equal(cropFor({ boxes: [], viewport: DESK, kind: 'touch' }).shape, 'viewport');
  const v = cropFor({ boxes: [], viewport: { width: 1441, height: 901 }, kind: 'scroll' });
  assert.ok(even(v.w) && even(v.h) && even(v.pw) && even(v.ph));
});

test('a plain move is a window of rows, marks in clip seconds', () => {
  const p = planClip({ fromRow: 100, toRow: 190, kind: 'touch', marks: { in: 100, held: 130, out: 160 } });
  assert.deepEqual(p.segments, [[100, 190]]);
  assert.equal(p.frames, 90); assert.equal(p.ms, 1500);
  assert.deepEqual(p.marks, { in: 0, held: 0.5, out: 1 });
  assert.equal(p.sampled, false); assert.equal(p.trimmed, false);
});

test('a move is cut at 4 seconds from its start', () => {
  const p = planClip({ fromRow: 10, toRow: 1000, kind: 'load' });
  assert.equal(p.frames, 240); assert.equal(p.ms, 4000); assert.ok(p.trimmed);
  assert.deepEqual(p.segments, [[10, 250]]);
});

test('a long hold loses its middle, and the marks after it move up', () => {
  const p = planClip({ fromRow: 0, toRow: 400, kind: 'open', marks: { in: 0, held: 40, out: 300 } });
  assert.ok(p.trimmed);
  assert.ok(p.frames <= 240);
  assert.equal(p.segments.length >= 1, true);
  const total = p.segments.reduce((a, s) => a + s[1] - s[0], 0);
  assert.equal(total, p.frames);
  assert.ok(p.marks.held < 1 && p.marks.held > 0);
});

test('a hold of 2 s or less is kept whole', () => {
  const p = planClip({ fromRow: 0, toRow: 200, kind: 'open', marks: { held: 30, out: 140 } });
  assert.deepEqual(p.segments, [[0, 200]]);
  assert.equal(p.trimmed, false);
});

test('a long scroll is sampled to reach its end, never cut', () => {
  const p = planClip({ fromRow: 0, toRow: 1000, kind: 'scroll' });
  assert.ok(p.sampled && p.step === 5);
  assert.ok(p.frames <= 240);
  assert.deepEqual(p.segments, [[0, 1000]]);
  const rows = Array.from({ length: 1000 }, (_, i) => [i, i, i, i]);
  const s = samplesFor(rows, p);
  assert.equal(s[0].f, 0);
  assert.ok(s[s.length - 1].f >= 995, 'the end of the range is in the clip');
  const short = planClip({ fromRow: 0, toRow: 200, kind: 'scroll' });
  assert.equal(short.step, 1); assert.equal(short.sampled, false);
});

test('samplesFor merges a gated stretch into one picture and fills rows with no picture', () => {
  const rows = [[1, 1, 0, 0], [2, 2, 0, -1], [3, 3, 0, 0], [4, 4, 0, 1], [5, 5, 0, 1], [6, 6, 0, 2]];
  rows[1][3] = 0;
  const s = samplesFor(rows, planClip({ fromRow: 0, toRow: 6, kind: 'touch' }));
  assert.deepEqual(s, [{ f: 0, frames: 3 }, { f: 1, frames: 2 }, { f: 2, frames: 1 }]);
  assert.equal(s.reduce((a, x) => a + x.frames, 0), 6);
  assert.equal(pictureAt([[1, 1, 0, -1], [2, 2, 0, 3]], 0), -1);
  assert.equal(pictureAt([[1, 1, 0, 3], [2, 2, 0, -1]], 1), 3);
});

test('posters by kind', () => {
  assert.equal(posterRowFor({ fromRow: 0, toRow: 100, kind: 'load', peakRow: 30 }), 30);
  assert.equal(posterRowFor({ fromRow: 0, toRow: 100, kind: 'load' }), 40);
  assert.equal(posterRowFor({ fromRow: 10, toRow: 100, kind: 'touch' }), 10);
  assert.equal(posterRowFor({ fromRow: 0, toRow: 100, kind: 'open', marks: { opened: 55 } }), 55);
  assert.equal(posterRowFor({ fromRow: 0, toRow: 100, kind: 'scroll' }), 49);
  assert.equal(posterRowFor({ fromRow: 0, toRow: 100, kind: 'load', peakRow: 500 }), 99, 'inside the window');
});

test('hero spans in seconds from the phases', () => {
  const s = heroSpans({ phases: [{ name: 'load', from: 0, to: 180 }, { name: 'idle', from: 180, to: 300 }, { name: 'scroll-down', from: 300, to: 600 }, { name: 'scroll-up', from: 600, to: 900 }] });
  assert.deepEqual(s, { load: [0, 3], scroll: [5, 15] });
  assert.deepEqual(heroSpans({ phases: [] }), {});
});

// ---------------------------------------------------------------- a fake encoder page

/** Answers the in-page calls by function name. Chunks are 40 bytes each; the avcC is a stub the muxer accepts. */
function fakePage({ canEncode = true, quantizer = true, rateChunk = 40, log = [] } = {}) {
  const S = { chunks: [], pending: [], size: null, desc: null };
  return {
    log,
    async goto() {},
    async evaluate(fn, arg) {
      if (typeof fn === 'string') return undefined;
      switch (fn.name) {
        case 'encoderInPage': log.push(['config', arg.width, arg.height]); if (!canEncode) return { error: `no H.264 encoder for ${arg.width} x ${arg.height}` }; S.size = [arg.width, arg.height]; S.chunks = []; log.push(['qp', arg.qp ?? null, arg.bitrate]); const qp = quantizer && Number.isFinite(arg.qp) ? arg.qp : null; S.qp = qp; return { codec: 'avc1.test', qp };
        case 'pushCropInPage': case 'pushInPage': {
          log.push(['push', arg.ts, arg.key, arg.c ? arg.c.w : null]);
          S.chunks.push({ key: arg.key, ts: arg.ts, b: Buffer.alloc(S.qp == null ? rateChunk : 40, 7).toString('base64') }); return S.chunks.length;
        }
        case 'takeInPage': { const out = S.chunks.splice(0, 40); return { out, left: S.chunks.length, description: arg ? Buffer.from([1, 100, 0, 51, 255, 225, 0, 0]).toString('base64') : null }; }
        case 'posterInPage': log.push(['poster', arg.c.w, arg.c.h, arg.q]); return Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]).toString('base64');
        case 'openVideoInPage': log.push(['video', arg.url]); return { w: 1, h: 1, d: 1 };
        default: return undefined; // the closing call of runEncoder
      }
    },
  };
}
const fakeLaunch = (page) => async () => ({ page, close: async () => { page.closed = true; } });

function takeFolder({ rows = 120, jpegs = true, video = false, size = { width: 1440, height: 900 } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-'));
  const dir = path.join(root, 'frames', 'desktop', 'arrive');
  fs.mkdirSync(dir, { recursive: true });
  const rs = Array.from({ length: rows }, (_, i) => [i + 1, i * 16.7, 0, Math.floor(i / 2)]);
  const doc = { schema: 'reva.frames/0', format: 'jpeg', scale: 1, clip: size, size, cols: ['k', 'T', 'sy', 'f'], rows: rs, phases: [{ name: 'load', from: 0, to: rows }] };
  if (video) { fs.writeFileSync(path.join(dir, 'video.mp4'), 'x'); doc.video = { file: 'video.mp4' }; }
  fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(doc));
  if (jpegs) for (let f = 0; f <= Math.floor((rows - 1) / 2); f++) fs.writeFileSync(path.join(dir, String(f).padStart(5, '0') + '.jpg'), Buffer.from([0xff, 0xd8, f, 0xff, 0xd9]));
  return { root, dir };
}
const REQ = { id: 'm-aaaa1111', take: 'frames/desktop/arrive', boxes: [[600, 300, 200, 80]], kind: 'touch', fromRow: 10, toRow: 70, marks: { in: 10, held: 30, out: 50 }, viewport: DESK };

test('runEncoder muxes what the page gives and refuses odd sizes', async () => {
  const page = fakePage();
  const r = await runEncoder(page, { width: 480, height: 300, durations: [2, 3, 1], push: (i, key) => page.evaluate(function pushCropInPage() {}, { ts: i * 100, key }) });
  assert.ok(r.mp4 && r.mp4.length > 100 && r.pictures === 3 && r.codec === 'avc1.test');
  assert.match((await runEncoder(page, { width: 481, height: 300, durations: [1], push: async () => 0 })).error, /odd/);
  const none = await runEncoder(fakePage({ canEncode: false }), { width: 480, height: 300, durations: [1], push: async () => 0 });
  assert.match(none.error, /no H\.264/);
});

test('cutClips writes a clip and a poster under clips/, with a keyframe every 8 pictures', async () => {
  const { root } = takeFolder();
  const page = fakePage();
  const r = await cutClips(root, [REQ], { launch: fakeLaunch(page) });
  assert.equal(page.closed, true, 'the browser is closed');
  assert.equal(r.encoded, 1); assert.equal(r.posters, 1);
  const x = r.results[0];
  assert.equal(x.frame.clip, 'clips/m-aaaa1111.mp4'); assert.equal(x.frame.poster, 'clips/m-aaaa1111.jpg');
  assert.ok(fs.existsSync(path.join(root, x.frame.clip)) && fs.existsSync(path.join(root, x.frame.poster)));
  assert.ok(even(x.frame.w) && even(x.frame.h) && x.frame.w >= 480);
  assert.equal(x.frame.fps, 60); assert.equal(x.frame.ms, 1000); assert.equal(x.frame.shape, 'crop');
  assert.deepEqual(x.frame.marks, { in: 0, held: 0.333, out: 0.667 });
  const keys = page.log.filter((l) => l[0] === 'push').map((l) => l[2]);
  assert.deepEqual(keys, keys.map((_, i) => i % 8 === 0));
  const ts = page.log.filter((l) => l[0] === 'push').map((l) => l[1]);
  assert.ok(ts.every((t, i) => i === 0 || t > ts[i - 1]));
  assert.equal(page.log.find((l) => l[0] === 'poster')[3], 0.8);
  assert.equal(fs.readdirSync(path.join(root, 'clips')).length, 2, 'nothing else is written');
});

test('a phone clip carries -p in its name and stays inside 390 x 844', async () => {
  const { root } = takeFolder({ size: PHONE });
  const page = fakePage();
  const r = await cutClips(root, [{ ...REQ, phone: true, viewport: PHONE, boxes: [[100, 300, 120, 60]] }], { launch: fakeLaunch(page) });
  const f = r.results[0].frame;
  assert.equal(f.clip, 'clips/m-aaaa1111-p.mp4');
  assert.ok(f.w <= 390 && f.h <= 844 && even(f.w) && even(f.h));
});

test('no H.264 encoder: a poster and a gap sentence, and the next move does not try again', async () => {
  const { root } = takeFolder();
  const page = fakePage({ canEncode: false });
  const r = await cutClips(root, [REQ, { ...REQ, id: 'm-bbbb2222', boxes: [[100, 300, 120, 60]] }], { launch: fakeLaunch(page) });
  assert.equal(r.encoded, 0); assert.equal(r.posters, 2);
  for (const x of r.results) { assert.equal(x.gap, NO_ENCODER_WORDS); assert.equal(x.frame.clip, null); assert.ok(fs.existsSync(path.join(root, x.frame.poster))); }
  assert.equal(page.log.filter((l) => l[0] === 'config').length, 1);
  assert.ok(r.why);
});

test('two moves that show the same pictures in the same frame share one clip and one poster', async () => {
  const { root } = takeFolder();
  const page = fakePage();
  const r = await cutClips(root, [REQ, { ...REQ, id: 'm-bbbb2222' }], { launch: fakeLaunch(page) });
  assert.equal(r.encoded, 1); assert.equal(r.posters, 1); assert.equal(r.shared, 2);
  const [a, b] = r.results;
  assert.equal(b.id, 'm-bbbb2222');
  assert.equal(b.frame.clip, a.frame.clip); assert.equal(b.frame.poster, a.frame.poster);
  assert.deepEqual({ ...b.frame }, { ...a.frame });
  assert.ok(fs.existsSync(path.join(root, b.frame.clip)));
});

test('stored take with video only: read through the video, JPEG-less', async () => {
  const { root, dir } = takeFolder({ jpegs: false, video: true });
  assert.equal(sourceOf(dir).kind, 'video');
  const page = fakePage();
  const r = await cutClips(root, [REQ], { launch: fakeLaunch(page) });
  assert.equal(r.encoded, 1);
  assert.ok(page.log.some((l) => l[0] === 'video' && l[1].startsWith('file://')));
});

test('a take with no pictures is a row of its own, not a crash', async () => {
  const { root } = takeFolder({ jpegs: false });
  const r = await cutClips(root, [REQ, { ...REQ, id: 'm-cccc3333', take: 'frames/desktop/none' }], { launch: fakeLaunch(fakePage()) });
  assert.match(r.results[0].error, /no pictures/); assert.match(r.results[1].error, /no pictures/);
});

test('hero posters: whole viewport, named by page and viewport, with the spans', async () => {
  const { root } = takeFolder();
  const page = fakePage();
  const out = await cutHeroPosters(root, [{ page: 'home', viewportName: 'desktop', take: 'frames/desktop/arrive', row: 100, viewport: DESK }], { launch: fakeLaunch(page) });
  assert.equal(out.length, 1);
  assert.equal(out[0].hero.poster, 'clips/hero-home-desktop.jpg');
  assert.deepEqual(out[0].hero.load, [0, 2]);
  assert.ok(fs.existsSync(path.join(root, 'clips/hero-home-desktop.jpg')));
  const p = page.log.find((l) => l[0] === 'poster');
  assert.equal(p[1], 1440); assert.equal(p[2], 900);
  assert.equal(page.closed, true);
});

test('nothing to cut opens no browser', async () => {
  let opened = false;
  const r = await cutClips('/nonexistent', [], { launch: async () => { opened = true; } });
  assert.equal(r.encoded, 0); assert.equal(opened, false);
  assert.deepEqual(await cutHeroPosters('/nonexistent', [], { launch: async () => { opened = true; } }), []);
  assert.equal(opened, false);
});

const ROOT_FOR_ARGS = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-clips-'));

test('the encoder page may read a take video on disk, and a site over budget gives every clip the same smaller share', async () => {
  let args = null;
  await cutHeroPosters(ROOT_FOR_ARGS(), [{ page: 'home', viewportName: 'desktop', take: 'none', row: 0, viewport: DESK }], { launch: async (o) => { args = o.args; return { page: { goto: async () => {}, evaluate: async () => {} }, close: async () => {} }; } });
  assert.ok(args.includes('--allow-file-access-from-files'));
  const big = Array.from({ length: 40 }, () => ({ w: 1440, h: 900, ms: 4000 }));
  assert.equal(bitShare([{ w: 480, h: 300, ms: 1000 }]), 1);
  const s = bitShare(big);
  assert.ok(s < 1 && s >= MIN_BIT_SHARE);
  assert.equal(bitShare(Array.from({ length: 400 }, () => big[0])), MIN_BIT_SHARE, 'past the floor a site goes over budget, and says so, rather than smear');
  assert.ok(big.reduce((a, c) => a + (bitrateFor(c.w, c.h) * s * c.ms) / 8000, 0) * 0.85 <= CLIP_BYTES * 1.01);
});

// ---------------------------------------------------------------- size: constant quality, never larger than the fixed rate

test('rateBytes: what a fixed rate weighs for 60 Hz frames', () => {
  assert.equal(rateBytes(8e6, [60]), 1e6);
  assert.equal(rateBytes(4.8e6, [30, 30, 60]), 1.2e6);
});

test('a clip and a take ask for constant quality, the clip finer than the take', async () => {
  assert.ok(QP.clip < QP.take && QP.clip >= 18 && QP.take <= 36, 'QP in the measured range');
  const { root } = takeFolder();
  const page = fakePage();
  const r = await cutClips(root, [REQ], { launch: fakeLaunch(page) });
  assert.equal(r.encoded, 1); assert.equal(r.qp, QP.clip);
  assert.deepEqual(page.log.filter((l) => l[0] === 'qp').map((l) => l[1]), [QP.clip], 'one encode: the file stayed under the fixed rate');
});

test('a constant-quality file near the fixed rate is made at that rate too, and the smaller one is kept', async () => {
  // Pictures of 40 bytes at the quantizer, 20 at the rate, against a rate that allows 30 bytes a picture: the rate file wins.
  const durations = [1, 1, 1], bitrate = Math.round(30 * 8 * 60);
  const push = (p) => (i, key) => p.evaluate(function pushCropInPage() {}, { ts: i * 100, key });
  const page = fakePage({ rateChunk: 20 });
  const r = await runEncoder(page, { width: 480, height: 300, durations, bitrate, qp: 30, push: push(page) });
  assert.equal(r.qp, null);
  assert.deepEqual(page.log.filter((l) => l[0] === 'qp').map((l) => l[1]), [30, null]);
  // The rate file is larger: the quantizer file stays.
  const p2 = fakePage({ rateChunk: 400 });
  const r2 = await runEncoder(p2, { width: 480, height: 300, durations, bitrate, qp: 30, push: push(p2) });
  assert.equal(r2.qp, 30); assert.equal(p2.log.filter((l) => l[0] === 'qp').length, 2);
  // Far under the rate: one encode.
  const p3 = fakePage();
  const r3 = await runEncoder(p3, { width: 480, height: 300, durations, bitrate: 1e8, qp: 30, push: push(p3) });
  assert.equal(r3.qp, 30); assert.equal(p3.log.filter((l) => l[0] === 'qp').length, 1);
  // A browser without the quantizer mode: one encode at the fixed rate, said so.
  const old = fakePage({ quantizer: false });
  const o = await runEncoder(old, { width: 480, height: 300, durations: [2, 3], qp: 30, push: (i, key) => old.evaluate(function pushCropInPage() {}, { ts: i * 100, key }) });
  assert.equal(o.qp, null); assert.equal(old.log.filter((l) => l[0] === 'qp').length, 1);
});

test('encodeTake writes the take at constant quality and says which, and the JPEG files go', async () => {
  const { dir } = takeFolder({ rows: 40 });
  const r = await encodeTake(fakePage(), dir);
  assert.ok(r.bytes > 100 && r.pictures === 20);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  assert.equal(doc.video.qp, QP.take); assert.equal(doc.video.bitShare, undefined);
  assert.equal(doc.rows.length, 40, 'rows untouched');
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.jpg')));
  const { dir: d2 } = takeFolder({ rows: 40 });
  await encodeTake(fakePage({ quantizer: false }), d2);
  const v2 = JSON.parse(fs.readFileSync(path.join(d2, 'frames.json'), 'utf8')).video;
  assert.equal(v2.bitShare, TAKE_BIT_SHARE); assert.equal(v2.qp, undefined);
});
