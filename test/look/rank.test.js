// look ranking by what a person notices (src/look/rank.js), WebGL scenes as ranked motions, the screens contract.
// Pure: synthetic frames, synthetic GL results, synthetic PNGs; no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { elementStats, planFit } from '../../src/look/select.js';
import { noticeOf, steadyLoop, glMotions, mergeRanked, screensOf } from '../../src/look/rank.js';
import { canvasesOf, boxDiffAt } from '../../src/look/screens.js';
import { formatLook } from '../../src/look/cli.js';

const VP = { width: 1440, height: 900 };
const DT = 1000 / 120;
const ease = (u) => 1 - (1 - u) ** 3;
const prog = (i, a, n) => Math.max(0, Math.min(1, (i - a) / n));
/** n frames; at(i) -> {sy?, v: {id: channels}} */
function frames(n, at) { const out = []; for (let i = 0; i < n; i++) { const f = at(i); out.push({ T: i * DT, sy: f.sy ?? 0, sx: 0, v: f.v }); } return out; }
const box = (x, y, w, h) => ({ 'ren:bx': x, 'ren:by': y, 'ren:bw': w, 'ren:bh': h });

// ---------- stripe-like load: a placeholder that fades out in 250 ms, an endless logo marquee, a hero entrance ----------
const STRIPE_ELS = ['DIV.single-wave__static', 'UL.logo-carousel__marquee', 'H1.hero__title', 'SPAN.footer-link'];
const stripeRows = () => frames(480, (i) => ({ v: {
  0: { ...box(0, 0, 1440, 600), 'ren:opacity': 1 - prog(i, 20, 30), 'ren:tx': 0 },
  1: { ...box(0, 760, 1440, 80), 'ren:tx': -((i * 0.25) % 400), 'ren:opacity': 1 },
  2: { ...box(100, 220, 900, 140), 'ren:ty': 40 * (1 - ease(prog(i, 30, 84))), 'ren:opacity': ease(prog(i, 30, 84)) },
  3: { ...box(40, 2400, 80, 20), 'ren:opacity': 0.6 + 0.4 * prog(i, 10, 20) },   // off screen
} }));

test('stripe-like load: the hero entrance outranks a 250 ms placeholder fade-out and the logo marquee; off-screen last', () => {
  const stats = elementStats({ rows: stripeRows(), ids: [0, 1, 2, 3], dt: DT, viewport: VP });
  assert.ok(stats.get(1).loop, 'the marquee is a constant-speed loop'); assert.equal(stats.get(1).loop.channel, 'ren:tx');
  assert.equal(stats.get(2).loop, null, 'an eased entrance is not a loop');
  const plan = planFit({ stats, els: STRIPE_ELS, candidates: [0, 1, 2, 3], top: 5, action: 'load', viewport: VP });
  const order = plan.entries.map((e) => e.desc);
  assert.equal(order[0], 'H1.hero__title');
  assert.equal(order[order.length - 1], 'SPAN.footer-link');
  const by = (d) => plan.entries.find((e) => e.desc === d).notice;
  assert.match(by('DIV.single-wave__static').why.join(' | '), /placeholder/);
  assert.match(by('UL.logo-carousel__marquee').why.join(' | '), /marquee/);
  assert.match(by('SPAN.footer-link').why.join(' | '), /off screen.*no visible change/);
  assert.match(by('H1.hero__title').why.join(' | '), /first screen/);
  // visual weight alone put the big placeholder first (the old order): the weight is kept, only the order changes
  assert.ok(plan.entries.find((e) => e.desc === 'DIV.single-wave__static').weight > plan.entries.find((e) => e.desc === 'H1.hero__title').weight);
  for (const e of plan.entries) assert.ok(Number.isFinite(e.notice.score) && Array.isArray(e.notice.why));
});

test('stripe-like load: a WebGL gradient covering 65 % of the screen ranks first, merged into the motions by score', () => {
  const stats = elementStats({ rows: stripeRows(), ids: [0, 1, 2, 3], dt: DT, viewport: VP });
  const plan = planFit({ stats, els: STRIPE_ELS, candidates: [0, 1, 2, 3], top: 5, action: 'load', viewport: VP });
  const motions = plan.entries.map((e) => ({ rank: e.rank, kind: e.kind, desc: e.desc, notice: e.notice, lines: [] }));
  const gl = { read: true, contexts: [{ id: 0, el: 9, offscreen: false }], programs: [{ id: 1, ctx: 0, uniforms: [{ name: 'u_time' }] }],
    lines: [{ kind: 'shader', text: 'WebGL shader p1', subject: 'shader p1' }, { kind: 'unsettled', label: 'unknown', subject: 'uniform u_time', channels: ['gl:u_time'], text: 'WebGL uniform u_time: 35000 → 38830 [measured] … still moving' }],
    records: [{ target: { channel: 'gl:u_time' }, tier: 'unexplained' }, { target: { channel: 'gl:other' } }] };
  const g = glMotions({ gl, canvases: [{ id: 9, end: { x: 337, y: 0, w: 1393, h: 761 }, before: { x: 337, y: 0, w: 1393, h: 761 }, diff: 0.03 }], viewport: VP, action: 'load', scrollY: 0, sels: new Map([[9, ['canvas#gradient-canvas', 1]]]) });
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, 'gl'); assert.match(g[0].desc, /^WebGL scene \(canvas, \d+ % of the screen\)$/);
  assert.deepEqual(g[0].box, { x: 337, y: 0, w: 1393, h: 761 });
  assert.deepEqual(g[0].lines.map((l) => l.subject), ['uniform u_time'], 'the gl lines that describe it, no shader line');
  assert.deepEqual(g[0].records.map((r) => r.target.channel), ['gl:u_time'], 'the records of its lines only');
  assert.equal(g[0].selector, 'canvas#gradient-canvas');
  const map = mergeRanked(motions, g);
  assert.equal(motions[0].kind, 'gl'); assert.equal(motions[0].rank, 1);
  assert.deepEqual(motions.map((m) => m.rank), motions.map((_, i) => i + 1));
  assert.equal(map.get(1), 2, 'the old rank 1 is now 2');
});

// ---------- apple-like scroll: a sticky local nav and its tray toggle their scroll state; product cards scale ----------
const APPLE_ELS = ['NAV#ac-localnav.css-sticky', 'DIV.ac-ln-wrapper', 'DIV.ac-ln-menu-tray', 'DIV.card.tile', 'DIV.card.tile', 'DIV.card.tile'];
const appleRows = () => frames(600, (i) => {
  const sy = i * 5;   // the page scrolls 3000 px
  const card = (k) => { const top = 900 + k * 40 - sy + 400; const u = prog(sy, 300 + k * 60, 600); return { ...box(100 + k * 420, top, 380, 500), 'ren:sx': 0.85 + 0.15 * u, 'ren:sy': 0.85 + 0.15 * u, 'ren:opacity': 1 }; };
  return { sy, v: {
    0: { ...box(0, 0, 1440, 52), 'ren:opacity': i > 100 ? 1 : 0.8 },   // stuck at the top while the page scrolls
    1: { ...box(0, i > 100 ? 0 : -52, 1440, 52), 'ren:ty': i > 100 ? -52 * (1 - ease(prog(i, 100, 28))) : -52 },
    2: { ...box(800, 8, 340, 40), 'ren:ty': i > 100 ? -20 * (1 - ease(prog(i, 100, 20))) : -20, 'ren:opacity': 1 },
    3: card(0), 4: card(1), 5: card(2),
  } };
});

test('apple-like scroll: product cards outrank the sticky nav and its tray (scroll-state toggles are down-ranked, kept)', () => {
  const rows = appleRows();
  const stats = elementStats({ rows, ids: [0, 1, 2, 3, 4, 5], dt: DT, viewport: VP });
  assert.ok(stats.get(0).heldMax >= 200, 'the nav stayed put while the page scrolled');
  const plan = planFit({ stats, els: APPLE_ELS, candidates: [0, 1, 2, 3, 4, 5], top: 5, action: 'scroll', viewport: VP });
  assert.equal(plan.entries[0].desc, 'DIV.card.tile');
  assert.equal(plan.entries[0].kind, 'group'); assert.match(plan.entries[0].notice.why.join(' | '), /3 repeats/);
  for (const d of ['NAV#ac-localnav.css-sticky', 'DIV.ac-ln-wrapper', 'DIV.ac-ln-menu-tray']) {
    const e = plan.entries.find((x) => x.desc === d); assert.ok(e, `${d} is still listed`);
    assert.match(e.notice.why.join(' | '), /sticky \/ fixed navigation/);
    assert.ok(e.notice.score < plan.entries[0].notice.score);
  }
});

test('the same nav moving on a load look is an entrance, not a scroll-state toggle', () => {
  const rows = frames(240, (i) => ({ v: { 0: { ...box(0, 0, 1440, 64), 'ren:ty': -64 * (1 - ease(prog(i, 10, 60))), 'ren:opacity': 1 } } }));
  const stats = elementStats({ rows, ids: [0], dt: DT, viewport: VP });
  const n = noticeOf({ members: [stats.get(0)], desc: 'HEADER.site-nav', viewport: VP, action: 'load' });
  assert.doesNotMatch(n.why.join(' | '), /sticky/);
});

test('notice score: tiny short fades and invisible elements are down-ranked; a bigger, longer, larger change scores more', () => {
  const st = (o) => ({ area: 0, areaOn: 0, disp: 0, movingMs: 0, movingOnMs: 0, weight: 1, box: { x: 0, y: 400, w: 100, h: 100 }, moving: new Set(['ren:opacity']), opStart: 1, opEnd: 1, opMax: 1, syFirst: 0, ...o });
  const tiny = noticeOf({ members: [st({ areaOn: 100 * 100, disp: 100, movingOnMs: 150, box: { x: 0, y: 1000, w: 100, h: 100 } })], viewport: VP, action: 'load' });
  assert.match(tiny.why.join(' | '), /short change on a small element/);
  const ghost = noticeOf({ members: [st({ areaOn: 400 * 400, disp: 10, movingOnMs: 900, opStart: 0, opEnd: 0, opMax: 0 })], viewport: VP, action: 'load' });
  assert.match(ghost.why.join(' | '), /invisible/);
  const small = noticeOf({ members: [st({ areaOn: 200 * 200, disp: 20, movingOnMs: 400, moving: new Set(['ren:ty']), box: { x: 0, y: 1000, w: 200, h: 200 } })], viewport: VP, action: 'load' });
  const big = noticeOf({ members: [st({ areaOn: 800 * 500, disp: 300, movingOnMs: 900, moving: new Set(['ren:ty']), box: { x: 0, y: 1000, w: 800, h: 500 } })], viewport: VP, action: 'load' });
  assert.ok(big.score > small.score && small.score > tiny.score && small.score > ghost.score);
  const zero = noticeOf({ members: [st({ weight: 0, areaOn: 0 })], viewport: VP, action: 'load' });
  assert.match(zero.why.join(' | '), /0 % weight/);
});

test('steadyLoop: constant speed with wraps is a loop; an eased tween, or a parallax that stops with the wheel, is not', () => {
  const lin = Array.from({ length: 200 }, (_, i) => (i % 50 === 49 ? 120 : -2.5));
  assert.deepEqual(steadyLoop({ 'ren:tx': { d: lin, still: [] } }, DT), { channel: 'ren:tx', pxPerSecond: -300 });
  const eased = Array.from({ length: 200 }, (_, i) => -3 * (1 - i / 200) ** 2);
  assert.equal(steadyLoop({ 'ren:tx': { d: eased, still: [] } }, DT), null);
  // moves at a constant rate while the page scrolls, stands still in the 100 steps where it does not
  const d = Array.from({ length: 200 }, (_, i) => (i < 100 ? -2 : 0)); const still = Array.from({ length: 200 }, (_, i) => i >= 100);
  assert.equal(steadyLoop({ 'ren:ty': { d, still } }, DT), null);
});

// ---------- WebGL entries ----------
const glBase = (lines, extra = {}) => ({ read: true, contexts: [{ id: 0, el: 5, offscreen: false }], programs: [{ id: 1, ctx: 0, uniforms: [{ name: 'uTime' }, { name: 'uProgress' }] }], lines, records: [], ...extra });
const CANVAS = { id: 5, end: { x: 0, y: 0, w: 1440, h: 900 }, before: { x: 0, y: 0, w: 1440, h: 900 } };

test('gl entries: a fitted uniform tween is a ranked motion with its lines and records', () => {
  const l = { kind: 'tween', label: 'fitted', subject: 'uniform uProgress', channels: ['gl:uProgress'], text: 'WebGL uniform uProgress: 0 → 1 [measured], Tween …', t0: 120 };
  const g = glMotions({ gl: glBase([l], { records: [{ target: { channel: 'gl:uProgress' }, tier: 'fitted' }] }), canvases: [{ ...CANVAS, diff: null, why: 'no frame before the action to compare' }], viewport: VP, action: 'load' });
  assert.equal(g.length, 1); assert.equal(g[0].desc, 'WebGL scene (canvas, 100 % of the screen)');
  assert.equal(g[0].lines.length, 1); assert.equal(g[0].lines[0].text, l.text); assert.equal(g[0].records.length, 1);
  assert.deepEqual(g[0].gl.pixels, { compared: false, why: 'no frame before the action to compare' });
  assert.match(g[0].notice.why.join(' | '), /100 % of the screen \(canvas\).*WebGL values change: uProgress/);
  // the canvas is not a watched element: its selector comes from the page read (unique there)
  assert.equal(g[0].selector, null);
  assert.equal(glMotions({ gl: glBase([l]), canvases: [{ ...CANVAS, sel: 'canvas#webgl' }], viewport: VP, action: 'load', sels: new Map([[5, [null, 3]]]) })[0].selector, 'canvas#webgl');
});

test('gl entries: a canvas whose pixels change with no fitted value still ranks, saying what was not measured', () => {
  const clock = { kind: 'clock', label: 'fitted', subject: 'uniform uTime', channels: ['gl:uTime'], text: 'WebGL uniform uTime: a clock, 1 per second [fitted]' };
  const g1 = glMotions({ gl: glBase([clock]), canvases: [{ ...CANVAS, diff: 0.05 }], viewport: VP, action: 'load' });
  assert.equal(g1.length, 1); assert.equal(g1[0].lines[0].kind, 'not measured');
  assert.match(g1[0].lines[0].text, /moves, values inside the canvas not measured: only a clock uniform \(uTime\)/);
  const g2 = glMotions({ gl: glBase([]), canvases: [{ ...CANVAS, diff: 0.05 }], viewport: VP, action: 'load' });
  assert.match(g2[0].lines[0].text, /moves, values inside the canvas not measured: its pixels changed but no uniform or camera value changed/);
  // a clock whose canvas did not change in the compared frames, an unchanged canvas, a canvas off screen: no entry
  assert.equal(glMotions({ gl: glBase([clock]), canvases: [{ ...CANVAS, diff: 0 }], viewport: VP, action: 'load' }).length, 0);
  assert.equal(glMotions({ gl: glBase([]), canvases: [{ ...CANVAS, diff: null }], viewport: VP, action: 'load' }).length, 0);
  assert.equal(glMotions({ gl: glBase([clock]), canvases: [{ id: 5, end: { x: 0, y: 2000, w: 1440, h: 900 }, diff: null }], viewport: VP, action: 'load' }).length, 0);
  assert.equal(glMotions({ gl: { ...glBase([clock]), read: false }, canvases: [CANVAS], viewport: VP, action: 'load' }).length, 0);
});

test('gl entries: two canvases each get their own lines (program -> context), ranked by on-screen area', () => {
  const gl = { read: true, contexts: [{ id: 0, el: 5 }, { id: 1, el: 6 }], programs: [{ id: 1, ctx: 0, uniforms: [{ name: 'uA' }] }, { id: 2, ctx: 1, uniforms: [{ name: 'uB' }] }],
    lines: [{ kind: 'tween', subject: 'uniform uA', channels: ['gl:uA'], text: 'A' }, { kind: 'spring', subject: 'uniform uB', channels: ['gl:uB'], text: 'B' }], records: [] };
  const g = glMotions({ gl, canvases: [{ id: 5, end: { x: 0, y: 0, w: 300, h: 300 }, diff: null }, { id: 6, end: { x: 0, y: 300, w: 1440, h: 600 }, diff: null }], viewport: VP, action: 'load' });
  assert.deepEqual(g.map((x) => x.lines.map((l) => l.text)), [['A'], ['B']]);
  assert.ok(g[1].notice.score > g[0].notice.score);
});

test('canvas pixel check: compared only when the canvas box stayed in place; a scroll that moved it says so', () => {
  const img = (w, h, fill) => { const p = new PNG({ width: w, height: h }); for (let i = 0; i < w * h; i++) { const [r, g, b] = fill(i % w, Math.floor(i / w)); p.data.set([r, g, b, 255], i * 4); } return PNG.sync.write(p); };
  const v = (canvases) => ({ w: 400, h: 200, scrollY: 0, dpr: 1, canvases });
  const a = img(100, 50, () => [0, 0, 0]), b = img(100, 50, (x) => (x < 50 ? [255, 255, 255] : [0, 0, 0]));
  const c = { id: 3, box: { x: 0, y: 0, w: 400, h: 200 } };
  const [same] = canvasesOf({ view: v([c]), small: a }, { view: v([c]), small: b });
  assert.ok(Math.abs(same.diff - 0.5) < 0.02, `half the canvas turned white: ${same.diff}`);
  const [moved] = canvasesOf({ view: v([{ id: 3, box: { x: 0, y: 100, w: 400, h: 200 } }]), small: a }, { view: v([c]), small: b });
  assert.equal(moved.diff, null); assert.match(moved.why, /moved on screen/);
  const [none] = canvasesOf(null, { view: v([c]), small: b });
  assert.equal(none.diff, null); assert.match(none.why, /no frame before/);
  assert.equal(boxDiffAt(null, 1, null, 1, c.box), null);
});

// ---------- screens contract (the card codes against exactly this) ----------
test('screens contract: viewport / before / page shapes, null when not taken', () => {
  const s = screensOf({ end: { w: 1440, h: 900, scrollY: 2400, dpr: 2 }, before: { w: 1440, h: 900, scrollY: 0, dpr: 2 }, page: { w: 1440, h: 29233, scale: 0.41, capped: 'scaled down to stay within 12000 px tall', data: Buffer.alloc(1), ms: 900 } });
  assert.deepEqual(s, {
    viewport: { file: 'screen-end.jpg', w: 1440, h: 900, scrollY: 2400, dpr: 2 },
    before: { file: 'screen-before.jpg', w: 1440, h: 900, scrollY: 0, dpr: 2 },
    page: { file: 'page.jpg', w: 1440, h: 29233, scale: 0.41, capped: 'scaled down to stay within 12000 px tall' },
  });
  assert.deepEqual(screensOf({ end: { w: 1440, h: 900, scrollY: 0, dpr: 1 } }), { viewport: { file: 'screen-end.jpg', w: 1440, h: 900, scrollY: 0, dpr: 1 }, before: null, page: null });
  assert.deepEqual(screensOf({}), { viewport: null, before: null, page: null });
});

// ---------- text ----------
test('look text: the top list follows the notice order; a gl motion prints its lines like an element', () => {
  const r = { ok: true, status: 'motion', errors: [], warnings: [], timing: { totalMs: 1000 }, source: { kind: 'url', url: 'https://example.com/', live: true },
    take: { frames: 100, rate: 60, watched: 10, net: { misses: 0 } }, action: { do: 'load', el: null, on: null }, page: null, unknowns: [], others: [], alreadyMoving: [], pointerDriven: [], notFitted: [],
    motions: [
      { rank: 1, kind: 'gl', desc: 'WebGL scene (canvas, 65 % of the screen)', selector: null, selectorWhy: 'the canvas has no unique selector', count: 1, box: { x: 0, y: 0, w: 1393, h: 761 }, weightShare: null, notice: { score: 61, why: ['65 % of the screen (canvas)', 'first screen'] },
        lines: [{ text: 'WebGL uniform u_time: 35000 → 38830 [measured] … still moving [unknown]', kind: 'unsettled', label: 'unknown', channels: ['gl:u_time'], trigger: null }], unknowns: [], covered: [], exports: [], records: [] },
      { rank: 2, kind: 'element', desc: 'DIV.single-wave__static', selector: 'div.single-wave__static', count: 1, box: { x: 0, y: 0, w: 1440, h: 600 }, weightShare: 0.6, notice: { score: 10, why: ['fades out and is gone (a placeholder swap)'] },
        lines: [], unknowns: [], covered: [], exports: [], records: [] },
    ] };
  const t = formatLook(r);
  const i1 = t.indexOf('1  WebGL scene'), i2 = t.indexOf('2  DIV.single-wave__static');
  assert.ok(i1 >= 0 && i2 > i1, t);
  assert.match(t, /ranked by: 65 % of the screen \(canvas\), first screen/);
  assert.match(t.slice(i1, i2), /WebGL uniform u_time: 35000 → 38830/);
});
