// Driver lag (record: map.driverLagFrames): a scroll-driven mechanism with lagFrames = L reads the scroll offset of frame k - L.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScrollSpecimen, simulate } from '../index.js';
import { planInput } from '../input.js';
import * as F from './fixtures.js';

const DT = 1000 / 120;
test('lagFrames = 1 delays the driver response by exactly one frame; lagFrames = 0 / absent is unchanged', () => {
  const built = buildScrollSpecimen(F.truthSmooth(), { docHeight: 2400, frameMs: DT });
  const input = planInput([{ hold: 100 }, { scrollTo: 800 }, { hold: 400 }, { scrollTo: 0 }, { hold: 400 }], { frameMs: DT, maxScroll: 1600 });
  const lagged = JSON.parse(JSON.stringify(built.spec));
  for (const m of lagged.mechanisms) if (m.kind === 'scroll-driven') m.map.lagFrames = 1;
  const a = simulate(built.spec, input), b = simulate(lagged, input);
  const moves = (X) => X.reduce((n, v, i) => n + (i && v !== X[i - 1] ? 1 : 0), 0);
  const key = Object.keys(a.channels).sort((p, q) => moves(a.channels[q]) - moves(a.channels[p]))[0];
  const A = a.channels[key], B = b.channels[key];
  assert.ok(A.some((v, i) => i && v !== A[i - 1]), 'the unlagged channel moves');
  assert.equal(B[0], A[0]);
  for (let i = 2; i < A.length; i++) assert.ok(Math.abs(B[i] - A[i - 1]) < 1e-12 || A[i - 1] === A[i - 2], `frame ${i}: lagged value equals the unlagged value one frame earlier`);
});
