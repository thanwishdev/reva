// Animation evidence: an animation object born on the element (CSS transition / CSS animation / Web Animation) gives exact
// timing, and wins over fitted laws for the channels it animates. Synthetic takes only (known by construction, no site data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitTakeSet } from '../../src/analysis/fit/index.js';
import { transitionRuns } from '../../src/look/index.js';
import { cubicBezier } from './oracle-shim.js';
import { synthTake } from './helpers.js';

const pv = (r, k) => r.model.params[k] && r.model.params[k].value;

test('siblings that share a descriptor: each element is explained by its own CSS animation (eight sparkles, one keyframes rule, staggered delays)', () => {
  // keyframes 0 % scale .2, 45 % scale 1, 70 % scale .5, 100 % scale .2; effect easing linear, keyframe easing sine in-out; infinite
  const E = cubicBezier(0.37, 0, 0.63, 1); const D = 2600; const born = 16.666667;
  const offs = [0, 0.45, 0.7, 1], vals = [0.2, 1, 0.5, 0.2];
  const at = (lt) => { if (lt < 0) return 1; const p = (lt % D) / D; let i = 0; while (i < 2 && p > offs[i + 1]) i++; const q = (p - offs[i]) / (offs[i + 1] - offs[i]); return vals[i] + (vals[i + 1] - vals[i]) * E(q); };
  const delays = [0, 300, 600, 900];
  const kf = offs.map((o, i) => ({ offset: o, easing: 'cubic-bezier(0.37, 0, 0.63, 1)', composite: 'auto', transform: `scale(${vals[i]})` }));
  const births = delays.map((d) => ({ name: 'glint', type: 'CSSAnimation', tgt: 'svg.glint', timeline: 'document', delay: d, duration: D, easing: 'linear', iterations: null, direction: 'normal', fill: 'none', keyframes: kf, T: born, k: 1 }));
  const take = synthTake({ rate: 60, dur: 3000, births, els: delays.map((d) => ({ desc: 'svg.glint', ch: { 'ren:sx': (k, T) => at(T - born - d) } })) });
  const res = fitTakeSet({ primary: take }, { earlyExit: true, onlyKeys: delays.map((_, i) => `${i}|ren:sx`) });
  assert.equal(res.records.length, delays.length, res.records.map((r) => r.tier).join(','));
  for (const r of res.records) {
    assert.equal(r.tier, 'declared', `${r.target.el}: ${r.tier} ${r.model.family}`);
    assert.equal(pv(r, 'duration'), D);
    // the element's own birth: its delay
    assert.equal(pv(r, 'delay'), delays[r.target.el], `el ${r.target.el} delay ${pv(r, 'delay')}`);
  }
  assert.ok(res.records.some((r) => r.declared.siblings && r.declared.siblings.matched === delays.length), 'says the births were chosen among siblings');
});

test('an animation created paused and played later (a reveal played on scroll) is still the declared law; its start is measured', () => {
  const E = cubicBezier(0.16, 1, 0.3, 1); const D = 900; const play = 1203.4;
  const y = (T) => (T < play ? 80 : 80 * (1 - E(Math.min(1, (T - play) / D))));
  const births = [{ name: 'waapi', type: 'Animation', tgt: 'SPAN.line', timeline: 'document', delay: 0, duration: D, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', iterations: 1, direction: 'normal', fill: 'both',
    keyframes: [{ offset: 0, easing: 'linear', transform: 'translateY(105%)' }, { offset: 1, easing: 'linear', transform: 'translateY(0px)' }], T: 16.666667, k: 1 }];
  const take = synthTake({ rate: 60, dur: 2600, births, els: [{ desc: 'SPAN.line', ch: { 'ren:ty': (k, T) => y(T) } }] });
  const res = fitTakeSet({ primary: take }, { earlyExit: true, onlyKeys: ['0|ren:ty'] });
  const [r] = res.records;
  assert.equal(r.tier, 'declared', `${r.tier} ${r.model.family}`);
  assert.equal(pv(r, 'duration'), D);
  assert.equal(pv(r, 'easing'), 'cubic-bezier(0.16, 1, 0.3, 1)');
  assert.equal(r.model.params.start.provenance, 'measured');
  assert.ok(Math.abs(pv(r, 'start') - play) < 1000 / 60, `start ${pv(r, 'start')} vs ${play}`);
  assert.ok(r.flags.some((f) => f.id === 'declared_start_measured'));
});

test('steps(): a clip-path typing reveal (one inset side) is one declared law with its steps() easing, not a run of instant changes', () => {
  const D = 930; const n = 15; const born = 500;
  const y = (T) => { const p = Math.max(0, Math.min(1, (T - born) / D)); return 100 - 100 * (p >= 1 ? 1 : Math.floor(p * n) / n); };
  const births = [{ name: 'waapi', type: 'Animation', tgt: 'SPAN.cmd', timeline: 'document', delay: 0, duration: D, easing: `steps(${n})`, iterations: 1, direction: 'normal', fill: 'forwards',
    keyframes: [{ offset: 0, easing: 'linear', clipPath: 'inset(0px 100% 0px 0px)' }, { offset: 1, easing: 'linear', clipPath: 'inset(0px 0% 0px 0px)' }], T: born, k: 30 }];
  const take = synthTake({ rate: 60, dur: 2000, births, els: [{ desc: 'SPAN.cmd', ch: { 'ren:clipPath.right': (k, T) => y(T) } }] });
  const res = fitTakeSet({ primary: take }, { earlyExit: true, onlyKeys: ['0|ren:clipPath.right'] });
  assert.equal(res.records.length, 1, res.records.map((r) => r.model.family).join(','));
  const [r] = res.records;
  assert.equal(r.tier, 'declared', `${r.tier} ${r.model.family}`);
  assert.equal(pv(r, 'duration'), D);
  assert.equal(pv(r, 'easing'), `steps(${n})`);
});

test('a transform transition a script retargets every frame (magnetic button): the record is the declared transition (exact duration and curve), the driver noted', () => {
  // :hover sets scale 1.04 through a 600 ms transition; a pointer spring writes --mx each frame, which restarts the transition
  const D = 600; const E = cubicBezier(0.22, 1, 0.36, 1); const t0 = 400; const rate = 60; const dt = 1000 / rate;
  const T = []; for (let k = 0; k <= 90; k++) T.push(Math.round(k * dt * 1e6) / 1e6);
  // simulate: every frame from t0 a new transition from the current value to 1.04
  const sx = []; let cur = 1, from = 1, start = null;
  const births = [];
  for (let k = 0; k < T.length; k++) {
    if (T[k] >= t0 && T[k] < t0 + 20 * dt) { from = cur; start = T[k]; births.push({ name: 'transform', type: 'CSSTransition', tgt: 'BUTTON.mag', timeline: 'document', delay: 0, duration: D, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', iterations: 1, direction: 'normal', fill: 'backwards',
      keyframes: [{ offset: 0, easing: 'linear', transform: `translate(${(k * 0.01).toFixed(2)}px) scale(${from.toFixed(5)})` }, { offset: 1, easing: 'linear', transform: `translate(${((k + 1) * 0.01).toFixed(2)}px) scale(1.04)` }], T: T[k], k }); }
    if (start != null) cur = from + (1.04 - from) * E(Math.min(1, (T[k] - start) / D));
    sx.push(cur);
  }
  const mx = T.map((t) => (t < t0 ? 0 : Math.min(20, (t - t0) / 30)));
  const take = synthTake({ rate, T, births, els: [{ desc: 'BUTTON.mag', ch: { 'ren:sx': sx, 'drv:--mx': mx } }] });
  const res = fitTakeSet({ primary: take }, { earlyExit: true, onlyKeys: ['0|ren:sx'] });
  const r = res.records.find((x) => x.target.channel === 'ren:sx');
  assert.equal(r.tier, 'declared', `${r.tier} ${r.model.family}`);
  assert.equal(r.model.family, 'declared:css');
  assert.equal(r.class, 'composite');
  assert.equal(pv(r, 'duration'), D);
  assert.ok(r.composite && r.composite.driverChannel === 'drv:--mx', JSON.stringify(r.composite));
});

test('transitionRuns: one retargeted run per hover leg (a script moves the translate each birth; the scale target turns), a hover in / out pair is two runs', () => {
  const tb = (T, from, to) => ({ name: 'transform', type: 'CSSTransition', tgt: 'BUTTON.mag', timeline: 'document', delay: 0, duration: 803, easing: 'linear(0 0%, 1 100%)', T,
    keyframes: [{ offset: 0, transform: from }, { offset: 1, transform: to }] });
  const births = [];
  for (let i = 0; i < 5; i++) births.push(tb(1000 + 16 * i, `translate(0px, ${i * 0.01}px) scale(${1 + i * 0.002})`, `translate(0px, ${(i + 1) * 0.01}px) scale(1.04)`));
  for (let i = 0; i < 4; i++) births.push(tb(2000 + 16 * i, `translate(0px, ${0.05 - i * 0.01}px) scale(${1.04 - i * 0.002})`, `translate(0px, ${0.04 - i * 0.01}px) scale(1)`));
  const runs = transitionRuns(births, 'BUTTON.mag');
  assert.equal(runs.length, 2, JSON.stringify(runs.map((r) => [r.first.T, r.n])));
  assert.deepEqual(runs.map((r) => r.n), [5, 4]);
  // hover in then out with one duration, nothing retargeting: two runs (the second ends where the first began)
  const pair = transitionRuns([tb(1000, 'none', 'translateY(-2px)'), tb(1800, 'translateY(-2px)', 'none')], 'BUTTON.mag');
  assert.equal(pair.length, 2);
});

test('an infinite 9 s linear rotate in a 12 s take: the rotation reads continuously past one turn (0 -> 480 deg) and is still the declared animation', () => {
  // the matrix gives principal angles; extractSeries unwraps them into a continuous 0 -> 480 deg ramp, while the declared
  // model restarts at 0 every 9 s. A rotation channel is matched against a repeating effect modulo whole turns
  const D = 9000; const born = 16.666667;
  const principal = (d) => { let a = ((d + 180) % 360 + 360) % 360 - 180; if (a === -180) a = 180; return a; };
  const truth = (T) => (360 * (((T - born) % D) / D));
  const births = [{ name: 'spin', type: 'CSSAnimation', tgt: 'svg.spin', timeline: 'document', delay: 0, duration: D, easing: 'linear', iterations: null, direction: 'normal', fill: 'none',
    keyframes: [{ offset: 0, easing: 'linear', transform: 'rotate(0deg)' }, { offset: 1, easing: 'linear', transform: 'rotate(360deg)' }], T: born, k: 1 }];
  const take = synthTake({ rate: 60, dur: 12000, births, els: [{ desc: 'svg.spin', ch: { 'ren:rz': (k, T) => principal(truth(T)) } }] });
  const res = fitTakeSet({ primary: take }, { earlyExit: true, onlyKeys: ['0|ren:rz'] });
  const [r] = res.records;
  assert.equal(r.tier, 'declared', `${r.tier} ${r.model.family}`);
  assert.equal(pv(r, 'duration'), D);
  assert.equal(pv(r, 'iterations'), 'infinite');
  const kv = pv(r, 'keyframeValues'); const vals = JSON.stringify(kv);
  assert.ok(kv && Math.abs(kv.flat()[0]) < 0.5 && Math.abs(kv.flat()[1] - 360) < 0.5, vals);
});

test('a rotation that gains a part of a turn per iteration (450 deg per 9 s) is not explained by the declared 0 -> 360 rotate: the turn column takes whole turns only', () => {
  const D = 9000; const born = 16.666667;
  const principal = (d) => { let a = ((d + 180) % 360 + 360) % 360 - 180; if (a === -180) a = 180; return a; };
  const births = [{ name: 'spin', type: 'CSSAnimation', tgt: 'svg.spin', timeline: 'document', delay: 0, duration: D, easing: 'linear', iterations: null, direction: 'normal', fill: 'none',
    keyframes: [{ offset: 0, easing: 'linear', transform: 'rotate(0deg)' }, { offset: 1, easing: 'linear', transform: 'rotate(360deg)' }], T: born, k: 1 }];
  const take = synthTake({ rate: 60, dur: 12000, births, els: [{ desc: 'svg.spin', ch: { 'ren:rz': (k, T) => principal(0.05 * (T - born)) } }] });
  const res = fitTakeSet({ primary: take }, { earlyExit: true, onlyKeys: ['0|ren:rz'] });
  assert.notEqual(res.records[0].tier, 'declared', res.records[0].model.family);
});
