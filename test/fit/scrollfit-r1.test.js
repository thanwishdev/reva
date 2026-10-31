// Scroll-map reading fixes (fix round 1, scroll-fit lane), synthetic takes, no browser. Known by construction:
//   - a scrubbed turn rotate 0 -> 240 deg over scroll 0 -> 900 px (linear), recorded as the matrix's principal angle
//     (-180, 180], so the samples read 162 then -177.6 and end at -120;
//   - a hero pinned from the page top: box y 0 for scroll 0 -> 1500 px, then 1500 - scroll; the take starts at scroll 0;
//   - a layer whose value overflows between two samples (tan near 90 deg): ~1000 up to 6550 px, 3.0e19 after it, on a
//     scroll moving 400 px per frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitTakeSet, pinStartAtTop, degenerateMap } from '../../src/analysis/fit/index.js';
import { unwrapDegrees } from '../../src/analysis/fit/series.js';
import { LOOK_FIT } from '../../src/look/index.js';
import { synthTake, frameTimes, scrollSteps } from './helpers.js';

const clamp = (v) => Math.min(1, Math.max(0, v));
const principal = (d) => { let a = ((d + 180) % 360 + 360) % 360 - 180; if (a === -180) a = 180; return a; };
const look = (take, keys) => fitTakeSet({ primary: take }, { ...LOOK_FIT, earlyExit: true, onlyKeys: keys });
const rec = (res, el, ch) => res.records.find((r) => r.target.el === el && r.target.channel === ch);

/** A native scroll sweep: `step` px per frame from frame 30 up to `to`, then held. */
function sweep(rate, dur, step, to) {
  const T = frameTimes(rate, dur); const steps = []; let y = 0;
  for (let k = 30; k < T.length && y < to; k++) { y = Math.min(to, y + step); steps.push([T[k], y]); }
  return { T, ...scrollSteps(T, steps) };
}

test('unwrapDegrees: principal angles back to the continuous turn', () => {
  const turn = Array.from({ length: 50 }, (_, i) => i * 7.5);           // 0 -> 367.5 deg
  assert.deepEqual(unwrapDegrees(turn.map(principal)).map((v) => +v.toFixed(9)), turn);
  const back = Array.from({ length: 40 }, (_, i) => 0 - i * 11 || 0);            // 0 -> -429 deg
  assert.deepEqual(unwrapDegrees(back.map(principal)).map((v) => +v.toFixed(9)), back);
  assert.deepEqual(unwrapDegrees([10, 20, 30]), [10, 20, 30]);
});

test('a scrubbed 0 -> 240 deg turn recorded as principal angles is a linear scroll map (not a bouncy spring)', () => {
  const { T, sy, inputLog } = sweep(60, 2500, 25, 1400);
  const rz = sy.map((s) => principal(240 * clamp(s / 900)));
  assert.ok(rz.some((v) => v < -170) && Math.abs(rz.at(-1) + 120) < 1e-9, 'the samples wrap');
  const take = synthTake({ rate: 60, T, sy, inputLog, els: [{ desc: 'svg', ch: { 'ren:rz': rz } }] });
  const r = rec(look(take, ['0|ren:rz']), 0, 'ren:rz');
  assert.equal(r.tier, 'fitted', JSON.stringify(r.unknowns));
  assert.match(r.model.family, /^scroll map \(linear\)/);
  const m = r.model.map; const at = (s) => m.a + m.b * clamp((s - m.s0_px) / (m.s1_px - m.s0_px));
  assert.ok(Math.abs(at(0)) <= 0.05 && Math.abs(at(900) - 240) <= 0.05, JSON.stringify(m));
  assert.ok(Math.abs(m.s1_px - 900) <= 2, `end ${m.s1_px}`);
});

test('pinStartAtTop: a pin held from scroll 0 starts at 0 px (measured); other unknown starts stay unknown', () => {
  const unknown = { value: null, interval: [null, 0], provenance: 'unknown' };
  const st = pinStartAtTop({ start: unknown, heldFrom_px: 0 }, [0, 0, 40, 80]);
  assert.equal(st.value, 0); assert.equal(st.provenance, 'measured'); assert.match(st.reason, /page top/);
  assert.equal(pinStartAtTop({ start: unknown, heldFrom_px: 120 }, [120, 160]).value, null);
  const known = { value: 300, provenance: 'measured' };
  assert.equal(pinStartAtTop({ start: known, heldFrom_px: 0 }, [0, 10]), known);
});

test('a hero pinned from the page top: the pin record states start 0 px and end 1500 px', () => {
  const { T, sy, inputLog } = sweep(60, 2500, 40, 2400);
  const by = sy.map((s) => (s <= 1500 ? 0 : 1500 - s));
  const take = synthTake({ rate: 60, T, sy, inputLog, els: [{ desc: 'SECTION.hero', ch: { 'ren:by': by } }] });
  const r = rec(look(take, ['0|ren:by']), 0, 'ren:by');
  assert.ok(r && /^pin/.test(r.model.family), JSON.stringify(r && r.model));
  assert.equal(r.model.pin.start.value, 0); assert.equal(r.model.pin.start.provenance, 'measured');
  assert.ok(Math.abs(r.model.pin.end.value - 1500) <= 1, JSON.stringify(r.model.pin.end));
});

test('degenerateMap: overflowing ends, or clamp-sized ends on a ramp no sample enters', () => {
  const sy = [0, 400, 800, 6150, 6550, 6950, 7350];
  assert.equal(degenerateMap({ a: 4670, b: 3e19, s0: 6550, s1: 6569 }, sy), true);
  assert.equal(degenerateMap({ a: -1020, b: -3.355e7, s0: 6450, s1: 6537 }, sy), true);
  assert.equal(degenerateMap({ a: 0, b: -120, s0: 0, s1: 900 }, sy), false);
  assert.equal(degenerateMap({ a: 0, b: 2e7, s0: 0, s1: 7000 }, sy), false);   // a big counter whose ramp is sampled
});

test('a value that overflows between two samples is not reported as a scroll map', () => {
  const { T, sy, inputLog } = sweep(60, 2000, 400, 9000);
  const v = sy.map((s) => (s < 6550 ? 860 + 0.12 * s : 2.9969e19));
  const take = synthTake({ rate: 60, T, sy, inputLog, els: [{ desc: 'svg.rays', ch: { 'drv:--rw': v } }] });
  const res = look(take, ['0|drv:--rw']);
  for (const r of res.records.filter((q) => q.target.el === 0)) {
    assert.ok(!(r.model.map && Math.abs(r.model.map.a + r.model.map.b) > 1e9), `no overflowing map: ${r.model.family} ${JSON.stringify(r.model.map)}`);
  }
});
