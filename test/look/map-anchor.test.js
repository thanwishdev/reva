// A scroll map is reported over the scroll range the take sampled. Measured case (a reading-progress bar, width =
// scrollY / 2252 * 1440, sampled 100 -> 2252 px): the fit put the ramp at 200 -> 2476 px and 127.9 -> 1584 px, numbers
// the take never saw, and the GSAP export held 128 px over scroll 0-200.
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorMapToSamples, exportWord } from '../../src/look/exportword.js';
import { describeElement } from '../../src/look/words.js';
import { exportRecord } from '../../src/export/index.js';

const rec = () => ({
  target: { el: 0, channel: 'ren:bw', desc: 'DIV.bar' }, tier: 'fitted', class: 'scroll map',
  evidence: { takes: ['t'], location: { kind: 'scroll_range', range: [100, 2252] } },
  model: { family: 'scroll map (linear)',
    params: { mapA: { value: 127.875, provenance: 'fitted', ci95: [127.84, 127.9] }, mapB: { value: 1455.63, provenance: 'fitted', ci95: [-27814, 30726] },
      mapS0: { value: 200, provenance: 'fitted', unit: 'px', ci95: [199.9, 200.1] }, mapS1: { value: 2476.42, provenance: 'fitted', unit: 'px', ci95: [-43298, 48251] } },
    map: { shape: 'linear', a: 127.875, b: 1455.63, s0_px: 200, s1_px: 2476.42, s0_ci95: [199.9, 200.1], s1_ci95: [-43298, 48251], s0_provenance: 'unknown', s1_provenance: 'unknown', s1_interval: [2252, null] } },
  unknowns: [{ id: 'unk_map_start', reason: 'no sample below the map start (200.0 px)' }, { id: 'unk_map_end', reason: 'no sample past the map end (2476.4 px)' }],
});

test('unobserved corners move to the sampled range; the values there come off the fitted line; nothing is extrapolated', () => {
  const r = anchorMapToSamples(rec()); const m = r.model.map;
  assert.equal(m.s0_px, 100); assert.equal(m.s1_px, 2252);
  assert.ok(Math.abs(m.a - 63.93) < 0.05, String(m.a)); assert.ok(Math.abs(m.a + m.b - 1440) < 0.5, String(m.a + m.b));
  assert.equal(m.s0_ci95, null); assert.equal(m.s1_ci95, null);
  assert.equal(r.model.params.mapS0.provenance, 'unknown'); assert.equal(r.model.params.mapA.provenance, 'fitted');
  const text = describeElement([r], {}).map((l) => l.text).join('\n');
  assert.match(text, /width 63\.9\d* \[fitted\] → 1440 \[fitted\] while the page scrolls 100 px \[unknown\] → 2252 px \[unknown\]/);
  assert.doesNotMatch(text, /1584|2476|127\.9/);
  const x = exportRecord(r, { to: ['gsap'] }); const g = x.exports[0];
  assert.match(g.code, /start: 100, end: 2252/); assert.doesNotMatch(g.code, /2476|1583/);
  assert.equal(exportWord(r, x, g, 120).word, 'unknown model', 'an export whose ramp ends are unknown never says "matches fit"');
});

test('an observed (fitted) corner and a ramp that is not identified are left as they are', () => {
  const fitted = rec(); fitted.model.map.s0_provenance = 'fitted'; fitted.model.map.s1_provenance = 'fitted';
  assert.equal(anchorMapToSamples(fitted), fitted);
  const noRamp = rec(); noRamp.unknowns.push({ id: 'unk_map_range', reason: '1 distinct offset(s) inside' });
  assert.equal(anchorMapToSamples(noRamp), noRamp);
  const curved = rec(); curved.model.map.shape = 'smoothstep';
  assert.equal(anchorMapToSamples(curved), curved);
});

// A scrubbed timeline whose fitted easeInQuad map starts at -8697 px, a point the page never scrolled to (a hero footer
// planted y 0 -> -40, linear over 0 -> 750 px). Stated at the extrapolated corner it read "y 210.7 -> -40". On the sampled
// range 0 -> 789.8 px the fitted curve is only the last 8 % of that easeInQuad, which is nearly straight: the text must
// name the shape that matches it there (linear), with its largest deviation, never "easeInQuad" over 0 -> 789.8 px
// (which is up to ~24 % of the travel off the fitted curve).
const heroFoot = () => ({
  target: { el: 0, channel: 'ren:ty', desc: 'DIV.foot' }, tier: 'fitted', class: 'restarted tween',
  evidence: { takes: ['t'], location: { kind: 'scroll_range', range: [0, 4597] } },
  model: { family: 'restarted expo.out', ease: 'expo.out', driver: { kind: 'scroll', pageOwned: true },
    params: { L: { value: 518.7, provenance: 'fitted', ci95: [515.2, 522.2] }, mapA: { value: 210.70286911350004, provenance: 'fitted', ci95: [205.7, 215.7] }, mapB: { value: -250.7028687752589, provenance: 'fitted', ci95: [-255.7, -245.7] },
      mapS0: { value: null, provenance: 'unknown' }, mapS1: { value: 789.82, provenance: 'fitted', ci95: [787.7, 791.9] } },
    map: { shape: 'easeInQuad', a: 210.70286911350004, b: -250.7028687752589, s0_px: -8697.354345826918, s1_px: 789.8220200483928, s0_provenance: 'unknown', s1_provenance: 'fitted' } },
  unknowns: [{ id: 'unk_map_start', reason: 'no sample below the map start' }],
});

test('a curved map with an unobserved corner is stated at the sampled edge with the shape that matches it there', () => {
  const r = heroFoot(); const m = r.model.map;
  const text = describeElement([r], {}).map((l) => l.text).join('\n');
  assert.match(text, /y 0\.00\d* \[fitted\] → -40 \[fitted\] over the scroll 0 px \[unknown\] → 789\.8 px \[fitted\], linear on the sampled range \(at most 0\.43, 1\.1 % of the travel, off the fitted easeInQuad, whose start -8697 px was never scrolled to\)/);
  assert.doesNotMatch(text, /210\.7|easeInQuad \(its start not observed\)/);
  // the stated line is within the stated 0.43 of the fitted curve everywhere on the sampled range
  const fit = (x) => m.a + m.b * Math.min(1, Math.max(0, (x - m.s0_px) / (m.s1_px - m.s0_px))) ** 2;
  const y0 = fit(0), y1 = fit(789.82); let worst = 0;
  for (let x = 0; x <= 789.82; x += 5) worst = Math.max(worst, Math.abs(y0 + ((y1 - y0) * x) / 789.82 - fit(x)));
  assert.ok(worst <= 0.435 && worst > 0.4, `worst ${worst}`);
  assert.equal(r.model.map.s0_px, -8697.354345826918, 'the record itself is not changed');
});

test('a clipped curve that no named shape matches on the sampled range states only the edge values and the fitted shape', () => {
  const r = heroFoot(); r.target.channel = 'ren:opacity'; r.evidence.location.range = [0, 700];
  r.model.params.mapA = { value: 0, provenance: 'fitted', ci95: [-0.01, 0.01] }; r.model.params.mapB = { value: 1, provenance: 'fitted', ci95: [0.99, 1.01] };
  r.model.params.mapS0 = { value: 0, provenance: 'fitted', ci95: [-1, 1] }; r.model.params.mapS1 = { value: null, provenance: 'unknown' };
  r.model.map = { shape: 'easeInOutQuart', a: 0, b: 1, s0_px: 0, s1_px: 1000, s0_provenance: 'fitted', s1_provenance: 'unknown' };
  const text = describeElement([r], {}).map((l) => l.text).join('\n');
  // easeInOutQuart at 0.7 = 1 - (0.6^4)/2 = 0.9352
  assert.match(text, /opacity 0 \[fitted\] → 0\.9352 \[fitted\] over the scroll 0 px \[fitted\] → 700 px \[unknown\], values at the sampled edge \(the fitted easeInOutQuart, whose end 1000 px was never scrolled to; no named shape within 2 % of the travel on the sampled range\)/);
});
