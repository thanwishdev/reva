// The page's own scroll line and the axes of the individual transform properties, synthetic takes, no browser.
// Known by construction:
//   - HTML box y = -offset. Lenis-like page: 120 wheels of 100 px at 60 Hz; the offset closes 1 - exp(-6 dt) of the gap
//     per frame (lerp 0.1, tau 166.7 ms). Wheels 0-2 land before the scroller is wired (not prevented), so the offset was
//     moved by an input: before, the offset itself explained the root box (y = -offset, "box y scrubbed with the page
//     scroll"), which says nothing about the smoothing;
//   - native page: no smoothing, the offset IS the wheel sum (every wheel not prevented): a 1:1 wheel map, no lag;
//   - FIGURE translate '0px Ypx', Y = 40 -> -40 linear over the offset 1000 -> 3000 (a drift written with the CSS
//     translate property): x never moves, so the recorded channel (its first number) is still.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitTakeSet } from '../../src/analysis/fit/index.js';
import { extractSeries, axisParts, baseKey } from '../../src/analysis/fit/series.js';
import { LOOK_FIT } from '../../src/look/index.js';
import { describeElement, channelWord } from '../../src/look/words.js';
import { synthTake, frameTimes } from './helpers.js';

const clamp = (v) => Math.min(1, Math.max(0, v));
function rootTake({ smooth }) {
  const rate = 60, T = frameTimes(rate, 3600), N = T.length, K0 = 12, WHEELS = 120;
  const inputLog = [], wheel = []; let target = 0, cur = 0; const sy = [];
  for (let k = 0; k < N; k++) {
    if (k >= K0 && k < K0 + WHEELS) {
      target += 100; inputLog.push({ type: 'wheel', i: k - K0, dy: 100, k: k - 1, T: T[k - 1] });
      wheel.push({ k: k - 1, dy: 100, sy0: Math.round(cur), prevented: smooth ? k - K0 >= 3 : false, cancelable: true, sy1: Math.round(cur) });
    }
    if (smooth) { if (k) { cur += (target - cur) * (1 - Math.exp(-6 * (T[k] - T[k - 1]) / 1000)); if (Math.abs(target - cur) < 0.5) cur = target; } } else cur = target;
    sy.push(Math.round(cur));
  }
  const ty = sy.map((y) => 40 - 80 * clamp((y - 1000) / 2000));
  const t = synthTake({ T, rate, sy, inputLog, els: [
    { desc: 'HTML.js', ch: { 'ren:by': sy.map((y) => -y) } },
    { desc: 'FIGURE.fig', ch: { 'ren:translate': ty.map((y) => `0px ${+y.toFixed(3)}px`) } },
  ] });
  t.data.wheel = wheel;
  return t;
}
const fit = (take, keys) => fitTakeSet({ primary: take }, { ...LOOK_FIT, earlyExit: true, onlyKeys: keys });
const rec = (res, el, ch) => res.records.find((r) => r.target.el === el && r.target.channel === ch);

test('root box on a smooth-scrolled page: the page smoothing against the wheel sum (Lenis lerp 0.1), not the offset map', () => {
  const res = fit(rootTake({ smooth: true }), ['0|ren:by']);
  const r = rec(res, 0, 'ren:by');
  assert.ok(r && r.tier === 'fitted', JSON.stringify(r && r.unknowns));
  assert.equal(r.class, 'first-order smoothing', r.model.family);
  assert.equal(r.model.driver && r.model.driver.kind, 'wheel');
  const tau = r.model.params.tau_ms.value; assert.ok(Math.abs(tau - 166.67) <= 0.02 * 166.67, `tau ${tau}`);
  const line = describeElement([r], { oneRate: 60 })[0];
  assert.match(line.text, /lerp 0\.(1|0999\d?) \[fitted\] per 60 Hz frame \(Lenis default 0\.1\)/);
  assert.ok(!r.hysteresis, 'no staircase / hysteresis reading on the root box');
});

test('root box on a native page: a 1:1 map of the wheel sum (reads as native), never a map of its own offset', () => {
  const r = rec(fit(rootTake({ smooth: false }), ['0|ren:by']), 0, 'ren:by');
  assert.ok(r && r.tier === 'fitted', JSON.stringify(r && r.unknowns));
  assert.equal(r.class, 'scroll map');
  assert.equal(r.model.driver && r.model.driver.kind, 'wheel');
  assert.ok(Math.abs(r.model.map.b / ((r.model.map.s1_px - r.model.map.s0_px) || 1) + 1) <= 0.01, JSON.stringify(r.model.map));
});

test('translate property: its y axis is a channel of its own (ren:translate.y), fitted as the scrubbed law', () => {
  assert.deepEqual(axisParts('ren:translate', '0px 40px'), { x: 0, y: 40, z: 0 });
  assert.deepEqual(axisParts('ren:translate', '12px'), { x: 12, y: 0, z: 0 });
  assert.deepEqual(axisParts('ren:scale', '1.2'), { x: 1.2, y: 1.2, z: 1 });
  assert.equal(axisParts('ren:translate', '10% 4px'), null);
  assert.equal(axisParts('ren:translate', 'none'), null);
  assert.equal(baseKey('3|ren:translate.y'), '3|ren:translate');
  assert.equal(channelWord('ren:translate.y'), 'translate y');
  const take = rootTake({ smooth: true });
  const ex = extractSeries({ ...take.data, elements: take.data.elements });
  assert.ok(ex.series.some((s) => s.key === '1|ren:translate.y'), 'derived y channel');
  assert.ok(!ex.series.some((s) => s.key === '1|ren:translate.z'), 'z never moves: no channel');
  const res = fit(take, ['1|ren:translate']);
  const r = rec(res, 1, 'ren:translate.y');
  assert.ok(r && r.tier === 'fitted', JSON.stringify(res.records.map((x) => [x.target.channel, x.tier, x.unknowns])));
  assert.match(r.model.family, /^scroll map \(linear\)/);
  const m = r.model.map;
  assert.ok(Math.abs(m.a - 40) <= 0.5 && Math.abs(m.a + m.b + 40) <= 0.5, JSON.stringify(m));
  assert.ok(Math.abs(m.s0_px - 1000) <= 3 && Math.abs(m.s1_px - 3000) <= 3, JSON.stringify(m));
});

// A Lenis page with a ScrollTrigger scrubbed timeline, built here (no recorded site data). Known by construction:
//   - 47 wheels of 100 px, one per 60 Hz frame, all prevented; the page moves its own offset, closing 10 % of the gap
//     per frame (Lenis lerp 0.1);
//   - a timeline of length 1 scrubbed over the offset 0 -> 1500 px with scrub 0.6 s: on every progress change an
//     expo.out tween of 600 ms restarts from the current timeline progress toward clamp(offset / 1500);
//   - the motion is opacity 0 -> 1 placed at 0.4 -> 1 of that timeline: equivalent to 600 -> 1500 px of offset, but
//     the smoothing runs BEFORE the map (on the timeline progress), so the fade starts late and keeps easing after the
//     offset has left the range. Opacity is read back to 4 decimals, as the recorder does.
// Before (9d585b6): on a page-owned scroll only the lean offset search ran ("only a piecewise time curve fits").
// Fit tolerance: on a fast sweep a one-frame driver lag and a shift of the map corners by one frame of scroll (~90 px)
// trade off, so the corners are pinned to ±100 px (the same take shape measured on a live page read 675 -> 1580 px).
function scrubTimelineTake({ lerp = 0.1, L = 600, range = 1500, at = 0.4 } = {}) {
  const rate = 60, T = frameTimes(rate, 2750), N = T.length, K0 = 58, WHEELS = 47;
  const inputLog = [], wheel = []; let target = 0, cur = 0; const sy = [];
  for (let k = 0; k < N; k++) {
    if (k >= K0 && k < K0 + WHEELS) {
      inputLog.push({ type: 'wheel', i: k - K0, dy: 100, k, T: T[k] });
      wheel.push({ k, dy: 100, sy0: Math.round(cur), prevented: true, cancelable: true, sy1: Math.round(cur) });
      target += 100;
    }
    if (k) { cur += (target - cur) * lerp; if (Math.abs(target - cur) < 0.5) cur = target; }
    sy.push(Math.round(cur));
  }
  const expoOut = (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p));
  const op = []; let from = 0, to = 0, t0 = 0, lastP = 0;
  for (let k = 0; k < N; k++) {
    const p = clamp(sy[k] / range); const now = (t) => from + (to - from) * expoOut(Math.max(0, t - t0) / L);
    if (p !== lastP) { from = now(T[k]); to = p; t0 = T[k]; lastP = p; }
    op.push(Math.round(clamp((now(T[k]) - at) / (1 - at)) * 1e4) / 1e4);
  }
  const t = synthTake({ T, rate, sy, inputLog, els: [{ desc: 'DIV.scrim', ch: { 'ren:opacity': op, 'ren:by': sy.map((y) => (y > range ? range - y : 0)) } }] });
  t.data.rows = t.data.rows.filter((r) => r.T >= T[K0] - 300);   // the look fits from 300 ms before the scroll
  t.data.wheel = wheel;
  return t;
}

test('page-owned scroll: a scrub 0.6 timeline (opacity at 0.4 -> 1 of 0 -> 1500 px) is found as the scrubbed timeline', () => {
  const r = rec(fit(scrubTimelineTake(), ['0|ren:opacity']), 0, 'ren:opacity');
  assert.ok(r && r.tier === 'fitted', JSON.stringify(r && r.unknowns));
  assert.equal(r.class, 'restarted tween', r.model.family);
  assert.ok(r.model.driver && r.model.driver.pageOwned, JSON.stringify(r.model.driver));
  const L = r.model.params.L.value; assert.ok(Math.abs(L - 600) <= 0.05 * 600, `scrub length ${L}`);
  const m = r.model.map; assert.ok(Math.abs(m.a) <= 0.02 && Math.abs(m.a + m.b - 1) <= 0.02, JSON.stringify(m));
  assert.ok(Math.abs(m.s0_px - 600) <= 100 && Math.abs(m.s1_px - 1500) <= 100, `range ${m.s0_px} -> ${m.s1_px}`);
});
