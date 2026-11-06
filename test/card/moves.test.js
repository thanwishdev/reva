// The move card without a browser: the inline index, the clip requests read from a take, the join into the card, and the page's pure
// parts (rows, mirrored time, marks, words). Data is synthetic: nothing from a real site enters the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { applyClips, applyHeroes, cardIndex, clipRequests, heroRequests, injectMoves, onScreen, playOf, rowOf, takeDir } from '../../src/card/moves.js';
import { ASSETS } from '../../scripts/check-pack.js';

const page = fs.readFileSync(new URL('../../src/card/page/moves.html', import.meta.url), 'utf8');
const pure = (() => {
  const src = /\/\*pure\*\/([\s\S]*?)\/\*end pure\*\//.exec(page)[1], box = {};
  vm.runInNewContext(`${src};Object.assign(box,{justify,mirrored,marksOf,secs,changeWords,curveData,differs,partsOf})`, { box });
  // results cross a realm: brought back as plain data, so deepEqual compares values
  const plain = (f) => (...a) => { const r = f(...a); return typeof r === 'object' ? JSON.parse(JSON.stringify(r)) : r; };
  return Object.fromEntries(Object.entries(box).map(([k, f]) => [k, plain(f)]));
})();

const rows = (n, k0 = 100) => Array.from({ length: n }, (_, i) => [k0 + i, (k0 + i) * 16.667, 0, i]);
function scanDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-moves-'));
  const take = (rel, doc) => { const d = path.join(dir, rel); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'frames.json'), JSON.stringify(doc)); fs.writeFileSync(path.join(d, 'video.mp4'), 'x'); };
  const base = { size: { width: 1440, height: 900 }, clip: { width: 1440, height: 900 }, scale: 1, video: { file: 'video.mp4' } };
  take('frames/desktop/patterns', { ...base, rows: rows(400) });
  take('frames/phone/patterns', { ...base, clip: { width: 390, height: 844 }, size: { width: 390, height: 844 }, rows: rows(400) });
  take('frames/desktop/load', { ...base, rows: rows(180, 0), phases: [{ name: 'load', from: 0, to: 180 }] });
  take('frames/desktop/scroll', { ...base, rows: rows(600, 0), phases: [{ name: 'scroll-down', from: 0, to: 300 }, { name: 'scroll-up', from: 300, to: 600 }] });
  take('pages/p1/frames/desktop/change-1', { ...base, rows: [...rows(60, 0), ...rows(60, 0).map((r) => [r[0], r[1] + 5000, 0, r[3] + 60])] });
  return dir;
}
const INDEX = () => ({
  site: { host: 'example.com', url: 'https://example.com/', pages: [{ id: 'home', label: 'Home', url: 'https://example.com/', hero: null }, { id: 'p1', label: '/a', url: 'https://example.com/a', hero: null }], viewports: ['desktop', 'phone'], built: [], feel: { sentences: ['Most things take 0.6 s.'] } },
  scan: { date: '2026-11-03' }, coverage: null, tally: { frames: 10 }, groups: [{ id: 'hover', title: 'Hover and press', moves: ['m-1'] }], top: [],
  moves: [
    { id: 'm-1', kind: 'touch', group: 'hover', name: 'Card, hover', sentence: 'On hover it lifts.', trigger: { kind: 'hover', word: 'When the pointer arrives', parts: [] }, frame: null, curve: { kind: 'tween', name: 'power3.out', bezier: [0, 0, 1, 1] }, proof: { source: 'fitted', word: 'Measured', errorPct: 1, frames: 9 }, time: { ms: 600 }, n: 2, variants: 0, phone: { status: 'same', id: null }, gap: null, runs: 40,
      instances: [{ page: 'home', viewport: 'desktop', take: 'patterns', T0: 2000, T1: 3500, k0: 120, k1: 210, elements: 3, box: [100, 100, 200, 100], marks: { in: 130, held: 172, press: 172, out: 200 }, video: null },
        { page: 'home', viewport: 'phone', take: 'patterns', T0: 2000, T1: 2500, k0: 120, k1: 150, elements: 1, box: [10, 10, 100, 100], video: null }] },
    { id: 'm-2', kind: 'change', group: 'between', name: 'Page change', sentence: 'x', trigger: { kind: 'page', word: 'Between pages', parts: [] }, frame: null, curve: {}, proof: {}, time: {}, n: 1, variants: 0, phone: { status: 'none' }, gap: null,
      instances: [{ page: 'p1', viewport: 'desktop', take: 'change-1', T0: 5500, T1: 5900, k0: 30, k1: 50, elements: 1, box: [0, 0, 1440, 900], video: null }] },
    { id: 'm-3', kind: 'page-scroll', group: 'scrolling', name: 'Page scroll', sentence: 'y', trigger: { kind: 'scroll-linked', word: 'Tied to the scroll', parts: [] }, frame: null, curve: {}, proof: {}, time: {}, n: 1, variants: 0, phone: null, gap: null, instances: [] },
  ],
});

test('rows: k restarts on a new document, so the clock picks which', () => {
  const r = [...rows(10, 0), ...rows(10, 0).map((x) => [x[0], x[1] + 5000, 0, 0])];
  assert.equal(rowOf(r, 4), 4);
  assert.equal(rowOf(r, 4, 5066), 14);
  assert.equal(rowOf(rows(5, 100), 3), 0, 'before the first row: the first row');
  assert.equal(rowOf(rows(5, 100), 500), -1);
});

test('take folders: home at the root, other pages under pages/, scan.json dir wins', () => {
  assert.equal(takeDir({ page: 'home', viewport: 'desktop', take: 'load' }), 'frames/desktop/load');
  assert.equal(takeDir({ page: 'p1', viewport: 'phone', take: 'load' }), 'pages/p1/frames/phone/load');
  assert.equal(takeDir({ page: 'p1', viewport: 'phone', take: 'load' }, [{ id: 'p1', dir: 'x' }]), 'x/frames/phone/load');
});

test('play modes follow DESIGN 5.4, and a scroll move never runs on a timer', () => {
  assert.equal(playOf({ kind: 'scroll' }), 'scrub'); assert.equal(playOf({ kind: 'scroll-up' }), 'scrub');
  assert.equal(playOf({ kind: 'touch' }), 'hover'); assert.equal(playOf({ kind: 'open' }), 'hover');
  assert.equal(playOf({ kind: 'load' }), 'once'); assert.equal(playOf({ kind: 'ambient' }), 'loop');
  assert.equal(playOf({ kind: 'scene', trigger: { kind: 'time' } }), 'loop');
  assert.equal(playOf({ kind: 'scene', trigger: { kind: 'scroll-linked' } }), 'scrub');
});

test('clip requests: rows from frames.json, a touch clip opens at the pointer, a phone twin gets -p, no take means no request', () => {
  const dir = scanDir(), rq = clipRequests(dir, INDEX());
  assert.equal(rq.length, 3);
  const a = rq.find((r) => r.id === 'm-1' && !r.phone);
  assert.equal(a.take, 'frames/desktop/patterns');
  assert.equal(a.fromRow, 30 - 12, 'row of marks.in, less the lead');
  assert.deepEqual(a.marks, { in: 30, held: 72, press: 72, out: 100 });
  assert.equal(a.play, 'hover'); assert.deepEqual(a.viewport, { width: 1440, height: 900 });
  assert.ok(rq.some((r) => r.id === 'm-1' && r.phone && r.viewport.width === 390));
  const c = rq.find((r) => r.id === 'm-2');
  assert.equal(c.take, 'pages/p1/frames/desktop/change-1');
  assert.ok(c.fromRow >= 60, 'the second document of the take, by its clock');
  assert.ok(!rq.some((r) => r.id === 'm-3'));
});

test('applyClips writes frame, play, the phone clip and every instance video, and returns the clips\' starts', () => {
  const dir = scanDir(), ix = INDEX(), rq = clipRequests(dir, ix);
  const results = rq.map((r) => ({ id: r.id, frame: { shape: 'crop', w: 640, h: 400, clip: `clips/${r.id}${r.phone ? '-p' : ''}.mp4`, poster: `clips/${r.id}.jpg`, ms: 900, fps: 60, marks: { in: 0.2 } }, ...(r.id === 'm-2' ? { sampled: 3 } : {}) }));
  const a = applyClips(dir, ix, rq, results);
  assert.equal(a.framed, 2); assert.equal(a.failed.length, 0);
  const [one, two] = ix.moves;
  assert.equal(one.frame.play, 'hover'); assert.equal(one.phone.clip, 'clips/m-1-p.mp4'); assert.equal(one.phone.status, 'same');
  assert.equal(two.frame.step, 3);
  assert.equal(one.instances[0].video.file, 'frames/desktop/patterns/video.mp4');
  assert.equal(one.instances[0].video.t0, +(20 / 60).toFixed(3));
  assert.ok(Number.isFinite(a.starts['m-1']));
  const bad = applyClips(dir, INDEX(), rq, rq.map((r) => ({ id: r.id, error: 'no pictures' })));
  assert.equal(bad.framed, 0); assert.equal(bad.failed.length, rq.length);
});

test('hero: one poster per page and viewport; stored takes keep load and scroll in two videos', () => {
  const dir = scanDir(), ix = INDEX(), hr = heroRequests(dir, ix);
  assert.equal(hr.length, 1); assert.equal(hr[0].row, 179); assert.equal(hr[0].take, 'frames/desktop/load');
  applyHeroes(dir, ix, [{ page: 'home', viewportName: 'desktop', hero: { poster: 'clips/hero-home-desktop.jpg' } }]);
  const h = ix.site.pages[0].hero.desktop;
  assert.equal(h.video, 'frames/desktop/load/video.mp4'); assert.equal(h.scrollVideo, 'frames/desktop/scroll/video.mp4');
  assert.deepEqual(h.load, [0, 3]); assert.deepEqual(h.scroll, [0, 10]);
  assert.equal(h.poster, 'clips/hero-home-desktop.jpg');
  assert.equal(ix.site.pages[1].hero, null, 'a page with no takes has no hero');
});

test('the inline index keeps what screens read and folds instances', () => {
  const dir = scanDir(), ix = INDEX(), rq = clipRequests(dir, ix);
  applyClips(dir, ix, rq, rq.map((r) => ({ id: r.id, frame: { shape: 'viewport', w: 1440, h: 900, clip: 'c.mp4', poster: 'p.jpg', ms: 900, marks: {} } })));
  const c = cardIndex(ix, { coverage: { line: 'One page recorded.', reasons: [] } }), m = c.moves[0];
  assert.equal(c.coverage.line, 'One page recorded.');
  assert.deepEqual(m.vp, ['desktop', 'phone']); assert.deepEqual(m.pg, [0]);
  assert.equal(m.seen.file, 'frames/desktop/patterns/video.mp4'); assert.equal(m.seen.viewport, 'desktop');
  for (const k of ['instances', 'rank', 'runs', 'take']) assert.ok(!(k in m), `${k} stays out`);
  assert.equal(c.moves[2].frame, null, 'a move with no frame stays in the list');
  assert.deepEqual(c.moves[1].pg, [1]);
  assert.ok(JSON.stringify(c).length < 4000);
});

test('the page joins the card, and the card opens from disk: no fetch, no module script, no small type', () => {
  const html = injectMoves('<html><head><style>a{}</style></head><body><main><section id="overview"></section></main><script>const DATA=null;</script></body></html>');
  assert.ok(html.indexOf('<section id="moves"') < html.indexOf('<section id="overview"'));
  assert.ok(html.indexOf('.mv-page') < html.indexOf('</head>'));
  assert.ok(html.lastIndexOf('routeMoves()') > html.indexOf('const DATA=null'), 'its script runs after the data');
  assert.ok(!/\bfetch\(|type="module"|import\(/.test(page));
  for (const m of page.matchAll(/font-size:(\d+)px/g)) assert.ok(+m[1] >= 14, m[0]);
  assert.ok(!/text-transform:\s*uppercase/.test(page));
  assert.equal((page.split('<style>')[1].match(/var\(--accent\)/g) || []).length, 3, 'focus ring, playhead line and dot, nothing else');
  assert.ok(ASSETS.includes('src/card/page/moves.html'));
});

test('rows fill the width, keep their tiles in rank order, and frames of one shape do not make an even grid', () => {
  const same = Array.from({ length: 9 }, (_, i) => ({ i, a: 1.6 }));
  const rows2 = pure.justify(same, 1320, 28, [430, 300, 360]);
  assert.deepEqual(rows2.flatMap((r) => r.items.map((t) => t.i)), same.map((t) => t.i));
  for (const r of rows2.slice(0, -1)) {
    const w = r.items.reduce((a, t) => a + t.w, 0) + 28 * (r.items.length - 1);
    assert.ok(Math.abs(w - 1320) < .01, `row width ${w}`);
  }
  assert.ok(new Set(rows2.map((r) => r.items.length)).size > 1, 'rows differ in how many frames they hold');
  const last = pure.justify([{ a: 1 }], 1320, 28, [300]);
  assert.equal(last[0].h, 300, 'a lone last tile keeps its height and is not blown up');
  const mix = pure.justify([{ a: 1.6 }, { a: 1 }, { a: .75 }, { a: 1.33 }, { a: 1.6 }], 1320, 28, [430]);
  assert.ok(mix[0].items.length >= 2);
});

test('an interrupted leave answers from where the hover was', () => {
  assert.equal(pure.mirrored(0, 0, 1, 2, 3), 3, 'nothing happened yet: the leave has nothing to play');
  assert.equal(pure.mirrored(1, 0, 1, 2, 3), 2, 'held: the whole leave');
  assert.equal(pure.mirrored(.25, 0, 1, 2, 3), 2.75);
  assert.equal(pure.mirrored(9, 0, 1, 2, 3), 2, 'past the end clamps');
});

test('marks: a press-only move plays from its press, a clip with none plays whole', () => {
  assert.deepEqual(pure.marksOf({ ms: 2000, marks: { in: .1, held: .8, press: .8, out: 1.2 } }), { at: .1, held: .8, press: .8, out: 1.2, end: 2 });
  assert.deepEqual(pure.marksOf({ ms: 2000, marks: { press: .3, out: 1 } }), { at: .3, held: 1, press: .3, out: 1, end: 2 });
  assert.deepEqual(pure.marksOf({ ms: 1000 }), { at: 0, held: 1, press: null, out: 1, end: 1 });
});

test('the words of a change', () => {
  assert.equal(pure.changeWords({ family: 'move', property: 'y', from: 39, to: 0, unit: 'px' }), 'rises 39 px');
  assert.equal(pure.changeWords({ family: 'move', property: 'x', from: 0, to: 12.5, unit: 'px' }), 'slides right 13 px');
  assert.equal(pure.changeWords({ family: 'fade', from: 0, to: 1 }), 'fades in');
  assert.equal(pure.changeWords({ family: 'fade', from: 1, to: .5 }), 'fades to 50 %');
  assert.equal(pure.changeWords({ family: 'scale', from: 1, to: 1.06 }), 'scale 1 to 1.06');
  assert.equal(pure.changeWords({ family: 'colour', from: 'rgb(0, 0, 0)', to: 'rgb(1, 1, 1)' }), 'changes colour');
  assert.equal(pure.secs(600), '0.6 s'); assert.equal(pure.secs(1200), '1.2 s'); assert.equal(pure.secs(12300), '12 s');
});

test('the index carries one status per move, and a box far off the screen is cut to it and said', () => {
  const ix = INDEX();
  ix.moves[0].proof = { source: 'declared', via: 'gsap' }; ix.moves[0].gap = 'No simple curve fits this, so the code replays what was recorded.';
  ix.moves[1].proof = { source: 'sampled' }; ix.moves[1].frame = { shape: 'viewport', w: 1440, h: 900, clip: 'c.mp4' };
  ix.moves[1].instances[0].box = [-116851.55, 0, 118882, 117957.41];
  ix.moves[2].proof = { source: 'seen' }; ix.moves[2].gap = 'The page glides after the wheel, and no single law describes how.';
  const c = cardIndex(ix), [a, b, p] = c.moves;
  assert.equal(a.status.key, 'exact'); assert.equal(a.status.reason, null); assert.equal(a.status.clip, null);
  assert.equal(b.status.key, 'recorded'); assert.match(b.status.note, /frame by frame/);
  assert.equal(p.status.key, 'pictures'); assert.match(p.status.reason, /glides/);
  assert.deepEqual(b.size, { w: 1440, h: 900, screen: [1440, 900], off: [118882, 117957] });
  assert.deepEqual(a.size, { w: 200, h: 100, screen: [1440, 900] }, 'a box on the screen: no note');
  assert.ok(!('size' in p), 'no instance, no size');
  assert.deepEqual(onScreen([-10, -10, 30, 30], { width: 100, height: 100 }), [0, 0, 20, 20]);
  assert.equal(onScreen([200, 0, 10, 10], { width: 100, height: 100 }), null);
});

test('clip requests frame the screen, never a box past it', () => {
  const dir = scanDir(), ix = INDEX();
  ix.moves[0].instances[0].box = [-5000, 100, 5300, 100];
  const a = clipRequests(dir, ix).find((r) => r.id === 'm-1' && !r.phone);
  assert.deepEqual(a.boxes, [[0, 100, 300, 100]]);
});

test('the curve area always draws something real: the law, the recorded progress, an instant step; never a broken scale', () => {
  const law = { curve: [[0, 0], [300, 0.8], [600, 1]], dots: [[0, 0], [300, 0.79]], law: { class: 'tween' } };
  assert.deepEqual(pure.curveData(law).c, law.curve);
  const flat = { curve: [[0, 1], [30250, 1]], dots: [[0, 0], [333, -0.5], [700, -1]], law: { class: 'keyframes' } };
  const r = pure.curveData(flat); assert.deepEqual(r.c, flat.dots, 'a flat curve gives way to the recorded progress'); assert.equal(r.recorded, true);
  const broken = { curve: [], dots: [[0, 0], [33, 1500000], [66, 1500000]], law: { class: 'keyframes' } };
  assert.equal(pure.curveData(broken), null, 'dots on a broken scale are not drawn');
  assert.deepEqual(pure.curveData({ curve: [], dots: [], law: { class: 'steps' } }).c, [[0, 0], [0, 1], [1, 1]]);
  assert.equal(pure.curveData({ curve: [], dots: [], law: null }), null);
});

test('parts that move differently get their own small curves, lead first, at most three, no name twice', () => {
  const ease = (ms, f) => Array.from({ length: 11 }, (_, i) => [(i * ms) / 10, f(i / 10)]);
  const g = (name, ms, f, o = {}) => ({ name, curve: ease(ms, f), dots: [], law: { class: 'tween' }, ...o });
  const lin = (p) => p, out = (p) => 1 - (1 - p) ** 3;
  assert.equal(pure.differs(ease(600, lin), ease(620, lin)), false);
  assert.equal(pure.differs(ease(600, lin), ease(1200, lin)), true, 'twice as long');
  assert.equal(pure.differs(ease(600, lin), ease(600, out)), true, 'another shape');
  const one = pure.partsOf([g('Card', 600, out, { role: 'lead' }), g('Title', 600, out)]);
  assert.deepEqual(one.map((x) => x.g.name), ['Card'], 'parts that move alike: the lead alone');
  const many = pure.partsOf([g('Image', 600, lin), g('Card', 600, out, { role: 'lead' }), g('Card', 1200, out), g('Title', 1200, out), g('Line', 300, lin), g('Dot', 90, lin)]);
  assert.deepEqual(many.map((x) => x.g.name), ['Card', 'Image', 'Title']);
  const leaving = pure.partsOf([g('Menu', 600, out, { part: 'out' })]);
  assert.equal(leaving.length, 1, 'a move of leaving parts only still has a curve');
  assert.deepEqual(pure.partsOf([g('Menu', 600, out, { part: 'out' }), g('Panel', 300, lin)]).map((x) => x.g.name), ['Panel']);
});

test('a clip is one stretch of pictures: its lead stops at a hole, so clipT0 is inside the clip (a shader-transition site, 6 Nov)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-moves-'));
  try {
    // pictures k 100-159, then a hole, then k 277-366 (T 4616-6100): the move starts at k 268 (no picture), its mark at k 260
    const d = path.join(dir, 'frames/desktop/opens-0'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'frames.json'), JSON.stringify({ size: { width: 1440, height: 900 }, clip: { width: 1440, height: 900 }, scale: 1, video: { file: 'video.mp4' }, rows: [...rows(60, 100), ...rows(90, 277).map((r, i) => [r[0], r[1], 0, 60 + i])] }));
    fs.writeFileSync(path.join(d, 'video.mp4'), 'x');
    const ix = INDEX(); ix.moves = [{ ...ix.moves[0], id: 'm-9', kind: 'open', instances: [{ page: 'home', viewport: 'desktop', take: 'opens-0', T0: 268 * 16.667, T1: 340 * 16.667, k0: 268, k1: 340, elements: 1, box: [0, 0, 1440, 900], marks: { in: 260 }, video: null }] }];
    const [rq] = clipRequests(dir, ix, { phone: false });
    assert.equal(rq.fromRow, 60, 'the first picture after the hole, not 12 frames of 2 s earlier');
    assert.equal(rq.startT, 277 * 16.667);
    const { writeClipT0 } = await import('../../src/scan/moves/fit.js');
    fs.mkdirSync(path.join(dir, 'moves'));
    fs.writeFileSync(path.join(dir, 'moves', 'm-9.json'), JSON.stringify({ id: 'm-9', groups: [{ t0: 276 * 16.667 }, { t0: 280 * 16.667 }] }));
    writeClipT0(dir, { 'm-9': rq.startT });
    const g = JSON.parse(fs.readFileSync(path.join(dir, 'moves', 'm-9.json'), 'utf8')).groups;
    assert.deepEqual([g[0].clipT0, g[0].clipLagMs, g[1].clipT0, g[1].clipLagMs], [0, 16.7, 0.05, undefined]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
