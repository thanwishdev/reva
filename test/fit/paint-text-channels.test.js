// Number channels the recorder adds next to transform / opacity: the leading number of the text (ren:text), colours and
// backgrounds by component (ren:color.r ... ren:bg.a), background / mask position (ren:bgPos.x/y, ren:maskPos.x/y), the
// SVG stroke dash offset (ren:dash) and the rotate property as an angle. Synthetic takes, no browser. Known by construction:
//   - a counter 0 -> 78, easeOutQuart over 1500 ms after a 500 ms wait, shown as a whole number in its text; its box width
//     grows by 8 px when it reaches two digits (the text reflows);
//   - a word whose background position runs 100 % -> 0 % linearly while the page scrolls 400 -> 1000 px;
//   - an SVG path whose dash offset runs 1 -> 0 linearly over the same scroll;
//   - an idle element: every new channel present and constant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitTakeSet } from '../../src/analysis/fit/index.js';
import { extractSeries, colorParts, positionParts, rotateDeg, baseKey, floorKind } from '../../src/analysis/fit/series.js';
import { LOOK_FIT } from '../../src/look/index.js';
import { describeElement, channelWord } from '../../src/look/words.js';
import { synthTake, frameTimes } from './helpers.js';

const fit = (take, keys) => fitTakeSet({ primary: take }, { ...LOOK_FIT, earlyExit: true, ...(keys ? { onlyKeys: keys } : {}) });
const rec = (res, el, ch) => res.records.find((r) => r.target.el === el && r.target.channel === ch);
const ex = (take) => extractSeries({ ...take.data, env: take.take.env });

test('parts: colours, paint positions, rotate angle, keys and words', () => {
  assert.deepEqual(colorParts('rgb(29, 26, 18)'), { r: 29, g: 26, b: 18, a: 1 });
  assert.deepEqual(colorParts('rgba(232, 181, 42, 0.5)'), { r: 232, g: 181, b: 42, a: 0.5 });
  assert.deepEqual(colorParts('rgb(10 20 30 / 25%)'), { r: 10, g: 20, b: 30, a: 0.25 });
  assert.deepEqual(colorParts('color(srgb 1 0.5 0 / 0.5)'), { r: 255, g: 127.5, b: 0, a: 0.5 });
  assert.equal(colorParts('oklch(0.5 0.1 20)'), null);
  assert.deepEqual(positionParts('100% 0%'), { x: 100, y: 0, unit: '% %' });
  assert.deepEqual(positionParts('-20px 50%, 0% 0%'), { x: -20, y: 50, unit: 'px %' });
  assert.equal(positionParts('calc(10% + 2px) 0%'), null);
  assert.equal(rotateDeg('45deg'), 45); assert.equal(rotateDeg('0 0 1 0.25turn'), 90); assert.equal(rotateDeg('x 30deg'), 30); assert.equal(rotateDeg('none'), 0);
  assert.equal(baseKey('3|ren:bg.r'), '3|ren:bg'); assert.equal(baseKey('3|ren:maskPos.y'), '3|ren:maskPos'); assert.equal(baseKey('3|ren:fvar.GRAD'), '3|ren:fvar.GRAD');
  assert.equal(floorKind('ren:bg.a'), 'colour'); assert.equal(floorKind('ren:text'), 'text-number'); assert.equal(floorKind('ren:dash'), 'stroke-dashoffset');
  assert.equal(channelWord('ren:text'), 'number shown in the text');
  assert.equal(channelWord('ren:bg.r'), 'background colour red (0-255)');
  assert.equal(channelWord('ren:bgPos.x'), 'background position x');
  assert.equal(channelWord('ren:stroke.b'), 'stroke colour blue (0-255)');
  assert.equal(channelWord('ren:dash'), 'line drawing offset (stroke-dashoffset)');
});

const easeOutQuart = (p) => 1 - (1 - p) ** 4;
function counterTake() {
  const rate = 60, T = frameTimes(rate, 2600);
  const n = T.map((t) => Math.round(78 * easeOutQuart(Math.min(1, Math.max(0, (t - 500) / 1500)))));
  return synthTake({ T, rate, els: [
    { desc: 'SPAN.count', ch: { 'ren:text': n, 'ren:bw': n.map((v) => (v >= 10 ? 24 : 16)), 'ren:color': 'rgb(20, 20, 20)', 'ren:bg': 'rgba(0, 0, 0, 0)' } },
    { desc: 'DIV.idle', ch: { 'ren:text': 1888, 'ren:color': 'rgb(29, 26, 18)', 'ren:bg': 'rgb(232, 181, 42)', 'ren:bgPos': '100% 0%', 'ren:maskPos': '0px 0px', 'ren:dash': 0, 'ren:rotate': '0 0 1 45deg' } },
  ] });
}

test('ren:text: a counter is fitted as a tween of its number; the box reflow is covered by it, not a motion', () => {
  const take = counterTake(); const x = ex(take);
  assert.ok(x.series.some((s) => s.key === '0|ren:text'));
  assert.ok(!x.series.some((s) => s.key === '0|ren:bw'), 'the width step is the text reflowing');
  assert.deepEqual(x.covered.map((c) => c.key), ['0|ren:bw']);
  // constant colour strings never become channels (no part moves past its floor)
  assert.ok(!x.series.some((s) => /ren:(color|bg|bgPos|maskPos)/.test(s.ch)), x.series.map((s) => s.key).join(' '));
  const res = fit(take, ['0|ren:text']);
  const r = rec(res, 0, 'ren:text');
  assert.ok(r && r.tier === 'fitted', JSON.stringify(res.records.map((q) => [q.target.channel, q.tier, q.class, q.model.family])));
  assert.equal(r.class, 'tween', r.model.family);
  const D = r.model.params.D.value; assert.ok(Math.abs(D - 1500) <= 0.05 * 1500, `duration ${D}`);
  const line = describeElement([r])[0]; assert.match(line.text, /^Tween, /);
});

test('text reflow is surfaced: the covered box is listed in the fit result (pruned), so look says it is covered', () => {
  const res = fit(counterTake(), ['0|ren:text', '0|ren:bw']);
  const p = res.pruned.find((q) => q.key === '0|ren:bw');
  assert.ok(p && p.redundant_with === 'ren:text' && /text reflow/.test(p.why), JSON.stringify(res.pruned));
  assert.ok(!res.records.some((r) => r.target.channel === 'ren:bw'));
});

test('proportional digits: a box that goes back and forth by glyph widths with the text is reflow', () => {
  const rate = 60, T = frameTimes(rate, 2600);
  const n = T.map((t) => Math.round(78 * easeOutQuart(Math.min(1, Math.max(0, (t - 500) / 1500)))));
  const gw = { 0: 9, 1: 5, 2: 8, 3: 8, 4: 9, 5: 8, 6: 9, 7: 7, 8: 9, 9: 9 };
  const w = n.map((v) => [...String(v)].reduce((a, c) => a + gw[c], 0));
  const take = synthTake({ T, rate, els: [{ desc: 'SPAN.count', ch: { 'ren:text': n, 'ren:bw': w, 'ren:bh': 20 } }] });
  const x = ex(take);
  assert.deepEqual(x.covered.map((c) => c.key), ['0|ren:bw']);
});

test('progress bar with its % inside: width and text change in the same frames, the width stays a motion', () => {
  const rate = 60, T = frameTimes(rate, 2000);
  // 60 frames from t = 500 ms: width 0 -> 300 px and text 0 -> 100 %, linear, both change every frame
  const p = T.map((t) => Math.min(1, Math.max(0, (t - 500) / 1000)));
  const take = synthTake({ T, rate, els: [{ desc: 'DIV.bar', ch: { 'ren:text': p.map((v) => Math.round(100 * v)), 'ren:bw': p.map((v) => 300 * v), 'ren:bh': 20 } }] });
  const x = ex(take);
  assert.deepEqual(x.covered, []);
  assert.ok(x.series.some((s) => s.key === '0|ren:bw'), x.series.map((s) => s.key).join(' '));
  const res = fit(take, ['0|ren:text', '0|ren:bw']);
  const r = rec(res, 0, 'ren:bw');
  assert.ok(r && r.tier === 'fitted', JSON.stringify(res.records.map((q) => [q.target.channel, q.tier, q.class])));
  assert.ok(!res.pruned.some((q) => q.key === '0|ren:bw'));
});

test('idle element: every new channel present and constant gives no motion', () => {
  const take = counterTake(); const res = fit(take);
  assert.deepEqual(res.records.filter((r) => r.target.el === 1).map((r) => r.target.channel), []);
});

function scrollTake() {
  const rate = 60, T = frameTimes(rate, 3000); const N = T.length;
  const sy = T.map((_, k) => Math.round(Math.min(1400, Math.max(0, (k - 20) * 12))));
  const inputLog = []; for (let k = 21; k < N && sy[k] !== sy[k - 1]; k++) inputLog.push({ type: 'scrollTo', want: sy[k], got: sy[k], k: k - 1, T: T[k - 1] });
  const p = sy.map((y) => Math.min(1, Math.max(0, (y - 400) / 600)));
  return synthTake({ T, rate, sy, inputLog, els: [
    { desc: 'SPAN.w', ch: { 'ren:bgPos': p.map((q) => `${+(100 - 100 * q).toFixed(4)}% 0%`), 'ren:by': sy.map((y) => 900 - y) } },
    { desc: 'path.line', ch: { 'ren:dash': p.map((q) => +(1 - q).toFixed(5)), 'ren:by': sy.map((y) => 900 - y) } },
  ] });
}

test('ren:bgPos.x and ren:dash: scrubbed by the scroll, fitted as scroll maps with their values and range', () => {
  const take = scrollTake(); const x = ex(take);
  assert.ok(x.series.some((s) => s.key === '0|ren:bgPos.x'));
  assert.ok(!x.series.some((s) => s.key === '0|ren:bgPos.y'), 'y never moves: no channel');
  for (const [el, ch, a, b] of [[0, 'ren:bgPos.x', 100, 0], [1, 'ren:dash', 1, 0]]) {
    const res = fit(take, [`${el}|${ch.replace(/\.x$/, '')}`]);
    const r = rec(res, el, ch);
    assert.ok(r && r.tier === 'fitted', JSON.stringify(res.records.map((q) => [q.target.channel, q.tier, q.class, q.model.family])));
    assert.equal(r.class, 'scroll map', r.model.family);
    const m = r.model.map; const tol = 0.01 * Math.abs(b - a);
    assert.ok(Math.abs(m.a - a) <= tol && Math.abs(m.a + m.b - b) <= tol, JSON.stringify(m));
    assert.ok(Math.abs(m.s0_px - 400) <= 13 && Math.abs(m.s1_px - 1000) <= 13, JSON.stringify(m));
    assert.match(describeElement([r])[0].text, new RegExp(`^Scroll-linked \\(scrubbed\\): ${channelWord(ch).replace(/[()]/g, '\\$&')} `));
  }
});

// The recorder's leadNum runs in the page (wrRuntime is serialised with toString): its two declarations are taken from
// that same source and run here on fake elements, so the test pins the code the browser runs.
import { wrRuntime } from '../../src/record/inpage.js';
function leadNumFromSource() {
  const src = wrRuntime.toString();
  const re = /const NUMRE = .*?;\n/.exec(src)[0]; const fn = /const leadNum = \(el\) => \{[\s\S]*?\n {2}\};\n/.exec(src)[0];
  return new Function(`${re}${fn}return leadNum;`)();
}
test('ren:text: the leading number of a short text, separators, signs and units', () => {
  const leadNum = leadNumFromSource(); const el = (t, kids = 0) => ({ textContent: t, childElementCount: kids });
  const cases = [['78', 78], ['1,284.1 ms', 1284.1], ['×5.0', 5], ['−12 %', -12], ['- 3', 3], ['-3', -3], ['1 000 000 km', 1000000], ["12'345", 12345],
    ['Iteration 260', 260], ['A-1', 1], ['0.6309', 0.6309], ['.5', 0.5], ['1,23', 1], ['works: 0', 0], ['no number', null], ['', null]];
  for (const [t, want] of cases) assert.equal(leadNum(el(t)), want, JSON.stringify(t));
  assert.equal(leadNum(el('x'.repeat(81) + ' 5')), null, 'a long text is not a readout');
  assert.equal(leadNum(el('5', 9)), null, 'an element with many children is not read');
});
