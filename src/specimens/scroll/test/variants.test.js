// Planted defects and the perturbation ladder: each variant is a different, runnable specimen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScrollSpecimen, simulate } from '../index.js';
import { easingSwap, rateSwap, noMotion, dropMechanism, perturb } from '../variants.js';
import { planInput } from '../input.js';
import * as F from './fixtures.js';

const base = () => buildScrollSpecimen(F.truthSmooth(), { docHeight: 2000, frameMs: 1000 / 120 });
const trace = (frameMs) => planInput([{ hold: 300 }, { scrollTo: 400 }, { denseSweep: { from: 400, to: 1200, px: 20 } }, { hold: 1200 }], { frameMs, maxScroll: 1200 });
const series = (spec, frameMs) => simulate(spec, trace(frameMs)).channels['b0|drv:--v0'];
const rms = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length);

test('every planted defect differs from the original; the originals agree with themselves', () => {
  const { spec } = base(); const ref = series(spec, spec.frameMs);
  assert.equal(rms(ref, series(spec, spec.frameMs)), 0);
  for (const [name, v] of Object.entries({ easingSwap: easingSwap(spec), noMotion: noMotion(spec), dropMechanism: dropMechanism(spec, 0) })) {
    assert.ok(rms(ref, series(v.spec, spec.frameMs)) > 0.01, `${name} must change the series`);
    assert.match(v.spec.id, /~/); assert.equal(v.spec.variantOf.id, spec.id); assert.ok(v.html.includes(v.spec.id));
  }
});

test('rate swap is invisible at the calibrated rate and visible at another (60 vs 120 Hz smoothing)', () => {
  const { spec } = base(); const v = rateSwap(spec).spec;
  assert.equal(v.mechanisms[0].smoothing.law, 'dtdamp');
  assert.ok(rms(series(spec, 1000 / 120), series(v, 1000 / 120)) < 1e-6, 'same at 120 Hz (up to the 1e-6 ms rounding of the frame times)');
  const s60 = { ...spec, frameMs: 1000 / 60 }, v60 = { ...v, frameMs: 1000 / 60 };
  assert.ok(rms(series(s60, 1000 / 60), series(v60, 1000 / 60)) > 0.01, 'different at 60 Hz');
});

test('perturbation ladder is monotone: bigger relative change, bigger distance', () => {
  const { spec } = base(); const ref = series(spec, spec.frameMs);
  const d = [0.01, 0.03, 0.1, 0.3].map((r) => rms(ref, series(perturb(spec, 0, 'smoothing.alpha', r).spec, spec.frameMs)));
  for (let i = 1; i < d.length; i++) assert.ok(d[i] > d[i - 1], `ladder ${d}`);
  assert.throws(() => perturb(spec, 0, 'map.shape', 0.1), /not a number/);
});
