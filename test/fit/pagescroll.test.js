// Scroll-scrubbed motion on a page that owns its scroll (a Lenis-like smooth scroller prevents every wheel and moves the
// window itself), synthetic take, no browser. Known by construction:
//   - 160 wheels of 100 px, one per 120 Hz frame, prevented; the offset closes 1 - exp(-6 dt) of the gap per frame
//     (Lenis lerp 0.1 = lambda 6 /s) and is rounded like window.scrollY;
//   - el 0 (scrub: true, ease none): ty = -400 * clamp((sy - 2000) / 4000);
//   - el 1 (scrub 0.5, ScrollTrigger style): progress r = clamp((sy - 2000) / 4000) followed by an expo.out tween of 500 ms
//     restarted on every change; tx = 600 * shown;
//   - el 2 (pinned panel whose content also slides): box y = held at 0 for 2000 <= sy <= 6000, else 2000 - sy (+ 6000
//     side), plus its own ty = -50 * clamp((sy - 2000) / 4000).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitTakeSet } from '../../src/analysis/fit/index.js';
import { LOOK_FIT } from '../../src/look/index.js';
import { synthTake, frameTimes } from './helpers.js';

const clamp = (v) => Math.min(1, Math.max(0, v));
const expoOut = (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p));
function pageScrollTake() {
  const rate = 120, T = frameTimes(rate, 3200), N = T.length, K0 = 24, WHEELS = 160;
  const inputLog = [], wheel = []; let target = 0, cur = 0; const sy = [];
  for (let k = 0; k < N; k++) {
    if (k >= K0 && k < K0 + WHEELS) { target += 100; inputLog.push({ type: 'wheel', i: k - K0, dy: 100, k: k - 1, T: T[k - 1] }); wheel.push({ k: k - 1, dy: 100, sy0: Math.round(cur), prevented: true, cancelable: true, sy1: Math.round(cur) }); }
    if (k) { cur += (target - cur) * (1 - Math.exp(-6 * (T[k] - T[k - 1]) / 1000)); if (Math.abs(target - cur) < 0.5) cur = target; }
    sy.push(Math.round(cur));
  }
  const p = sy.map((y) => clamp((y - 2000) / 4000));
  let shown = 0, from = 0, to = 0, t0 = 0; const scrub = [];
  for (let k = 0; k < N; k++) { if (p[k] !== to) { from = shown; to = p[k]; t0 = T[k]; } shown = from + (to - from) * expoOut((T[k] - t0) / 500); scrub.push(600 * shown); }
  const pinBy = sy.map((y) => (y < 2000 ? 2000 - y : y > 6000 ? 6000 - y : 0) - 50 * clamp((y - 2000) / 4000));
  const t = synthTake({ T, sy, inputLog, els: [
    { desc: 'DIV.ht', ch: { 'ren:ty': p.map((v) => -400 * v) } },
    { desc: 'DIV.scr', ch: { 'ren:tx': scrub } },
    { desc: 'DIV.pin', ch: { 'ren:by': pinBy, 'ren:ty': p.map((v) => -50 * v) } },
  ] });
  t.data.wheel = wheel;
  return t;
}
const take = pageScrollTake();
const fit = (keys, extra = {}) => fitTakeSet({ primary: take }, { ...LOOK_FIT, earlyExit: true, onlyKeys: keys, ...extra });
const rec = (res, el, ch) => res.records.find((r) => r.target.el === el && r.target.channel === ch);

test('page-owned scroll, scrub: true: a linear map of the scroll offset (not of the wheel sum), page driver named', () => {
  const r = rec(fit(['0|ren:ty']), 0, 'ren:ty');
  assert.equal(r.tier, 'fitted'); assert.match(r.model.family, /^scroll map \(linear\)/);
  assert.equal(r.model.driver.kind, 'scroll'); assert.equal(r.model.driver.pageOwned, true);
  const m = r.model.map; assert.ok(Math.abs(m.s0_px - 2000) <= 2 && Math.abs(m.s1_px - 6000) <= 2, JSON.stringify(m));
  assert.ok(Math.abs(m.b + 400) <= 1, `amplitude ${m.b}`);
});

test('page-owned scroll, scrub 0.5: the restarted expo.out (= first-order smoothing, tau = 500 / (10 ln 2) ms) on the scroll offset', () => {
  const r = rec(fit(['1|ren:tx']), 1, 'ren:tx');
  assert.equal(r.tier, 'fitted', JSON.stringify(r.unknowns)); assert.equal(r.model.driver.kind, 'scroll');
  const tau = r.model.params.tau_ms && r.model.params.tau_ms.value;
  assert.ok(Number.isFinite(tau) && Math.abs(tau - 500 / (10 * Math.LN2)) <= 0.03 * 72.13, `tau ${tau} (${r.model.family}) ${JSON.stringify(Object.keys(r.model.params))}`);
});

test('pin under the element\'s own translate: found once the translate is taken out; no time families on the box', () => {
  const res = fit(['2|ren:by', '2|ren:ty']);
  const p = rec(res, 2, 'ren:by');
  assert.ok(p, JSON.stringify(res.pruned)); assert.match(p.model.family, /^pin/);
  assert.ok(Math.abs(p.model.pin.start.value - 2000) <= 1 && Math.abs(p.model.pin.end.value - 6000) <= 1, JSON.stringify(p.model.pin));
  assert.equal(p.model.pin.ownTranslateRemoved, true);
});

test('a box that rides the page with its own transform and no pin is covered by the own channel, not fitted', () => {
  // el 0's box: doc position 3000 minus the offset, plus its own ty; never held
  const t = pageScrollTake(); for (const r of t.data.rows) r.v[0]['ren:by'] = 3000 - r.sy + r.v[0]['ren:ty'];
  const res = fitTakeSet({ primary: t }, { ...LOOK_FIT, earlyExit: true, onlyKeys: ['0|ren:by', '0|ren:ty'] });
  assert.ok(!rec(res, 0, 'ren:by'), 'no record for the box');
  const pr = res.pruned.find((x) => x.key === '0|ren:by'); assert.ok(pr && pr.redundant_with === 'ren:ty', JSON.stringify(res.pruned));
  assert.ok(res.meterStats.evalUnits < 5e7, `evaluations ${res.meterStats.evalUnits}`);
});

test('without earlyExit (lab, corpus) the offset of a page-owned scroll stays an output: no page driver', () => {
  const r = rec(fitTakeSet({ primary: take }, { onlyKeys: ['0|ren:ty'], evalBudget: 3e8 }), 0, 'ren:ty');
  assert.ok(!(r.model.driver && r.model.driver.pageOwned), JSON.stringify(r.model.driver));
});
