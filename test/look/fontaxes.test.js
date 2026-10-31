// Font-axis helpers and the declared-only rows for font properties, without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAxes, axisOfChannel, axisWord, travelText } from '../../src/look/fontaxes.js';
import { declaredOnly, declaredLine, fillMeasuredFontEnds } from '../../src/look/declared.js';
import { channelWord } from '../../src/look/words.js';

test('parseAxes: font-variation-settings, font-weight and font-stretch values; unreadable text is null', () => {
  assert.deepEqual(parseAxes('font-variation-settings', '"wght" 300, "wdth" 87.5, "GRAD" -20'), { wght: 300, wdth: 87.5, GRAD: -20 });
  assert.deepEqual(parseAxes('font-variation-settings', "'opsz' 14"), { opsz: 14 });
  assert.equal(parseAxes('font-variation-settings', 'normal'), null);
  assert.deepEqual(parseAxes('font-weight', 'bold'), { wght: 700 });
  assert.deepEqual(parseAxes('font-weight', '350'), { wght: 350 });
  assert.equal(parseAxes('font-weight', 'bolder'), null);
  assert.deepEqual(parseAxes('font-stretch', '75%'), { wdth: 75 });
  assert.deepEqual(parseAxes('font-stretch', 'condensed'), { wdth: 75 });
  assert.equal(parseAxes('color', 'red'), null);
});

test('channel words: plain names, never the channel id', () => {
  assert.equal(axisOfChannel('ren:wght'), 'wght'); assert.equal(axisOfChannel('ren:fvar.GRAD'), 'GRAD'); assert.equal(axisOfChannel('ren:opacity'), null);
  assert.equal(channelWord('ren:wght'), 'font weight'); assert.equal(channelWord('ren:wdth'), 'font width');
  assert.equal(channelWord('ren:fvar.opsz'), 'font optical size'); assert.equal(channelWord('ren:fvar.GRAD'), 'font axis GRAD');
  assert.equal(travelText('wght', 300, 800), 'font weight 300 → 800'); assert.equal(travelText('wdth', 75, 125), 'font width 75% → 125%');
  assert.equal(axisWord('slnt'), 'font slant');
});

const birth = (name, kf, o = {}) => ({ type: 'CSSTransition', name, tgt: 'P#h', duration: 600, delay: 0, easing: 'ease-out', iterations: 1, direction: 'normal', T: 100, keyframes: kf, ...o });

test('declared-only: Chrome serialises a transition on font-variation-settings as normal -> normal; no end values are invented', () => {
  const d = declaredOnly([birth('font-variation-settings', [{ offset: 0, fontVariationSettings: 'normal' }, { offset: 1, fontVariationSettings: 'normal' }])]);
  assert.equal(d.length, 1);
  assert.equal(d[0].durationMs, 600); assert.equal(d[0].easing, 'ease-out');
  const p = d[0].properties[0];
  assert.equal(p.from, null); assert.equal(p.to, null); assert.equal(p.measure, true);
  assert.ok(!/normal/.test(declaredLine(d[0])), declaredLine(d[0]));
  assert.match(declaredLine(d[0]), /^CSS transition: font variation \(end values not exposed by the page\) · 600 ms \[exact\], ease-out \[exact\]$/);
});

test('declared-only: measured ends fill a font row (labelled measured -> [fitted]); no moving channel leaves it unfilled', () => {
  const mk = () => declaredOnly([birth('font-variation-settings', [{ fontVariationSettings: 'normal' }, { fontVariationSettings: 'normal' }])]);
  const rec = { target: { desc: 'P#h', channel: 'ren:wght' }, derived: { t0: 100 } };
  const filled = fillMeasuredFontEnds(mk(), [rec], () => ({ from: 300, to: 800 }));
  assert.deepEqual(filled[0].properties.map((p) => [p.axis, p.from, p.to, p.source]), [['wght', 300, 800, 'measured']]);
  assert.match(declaredLine(filled[0]), /^CSS transition: font weight 300 → 800 \[fitted\] · 600 ms \[exact\]/);
  // another element's channel, or a channel that did not change, fills nothing
  const none = fillMeasuredFontEnds(mk(), [{ ...rec, target: { desc: 'P#other', channel: 'ren:wght' } }, rec], (r) => (r.target.desc === 'P#h' ? { from: 400, to: 400 } : null));
  assert.equal(none[0].properties[0].from, null); assert.match(none[0].properties[0].note, /no recorded channel/);
});

test('declared-only: @keyframes values the page does expose are exact, one row per axis', () => {
  const kf = [{ offset: 0, fontVariationSettings: '"wght" 200, "wdth" 75' }, { offset: 1, fontVariationSettings: '"wght" 900, "wdth" 125' }];
  const d = declaredOnly([birth('', kf, { type: 'CSSAnimation', name: 'kf' })]);
  assert.deepEqual(d[0].properties.map((p) => [p.axis, p.from, p.to, p.measure || false]), [['wght', 200, 900, false], ['wdth', 75, 125, false]]);
  assert.equal(declaredLine(d[0]), 'CSS animation: font weight 200 → 900; font width 75% → 125% · 600 ms [exact], ease-out [exact]');
  // font-weight keywords
  const w = declaredOnly([birth('font-weight', [{ fontWeight: 'normal' }, { fontWeight: 'bold' }], { type: 'CSSAnimation', name: 'w' })]);
  assert.deepEqual(w[0].properties.map((p) => [p.axis, p.from, p.to]), [['wght', 400, 700]]);
  // but a font-weight TRANSITION: Chrome reports 400 / 400 for both ends whatever the page declared, so they are not read
  const t = declaredOnly([birth('font-weight', [{ fontWeight: '400' }, { fontWeight: '400' }])]);
  assert.deepEqual(t[0].properties.map((p) => [p.from, p.to, p.measure]), [[null, null, true]]);
});
