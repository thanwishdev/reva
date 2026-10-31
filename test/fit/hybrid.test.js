// S1b: hybrid 60/120 Hz fit (hybrid.js + the channel loop of index.js). No browser, no files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsFullRate, strideRows, hybridApplies } from '../../src/analysis/fit/hybrid.js';
import { fitTakeSet } from '../../src/analysis/fit/index.js';
import { synthTake } from './helpers.js';

const rec = (o) => ({ tier: 'fitted', class: 'tween', model: { params: { D: { value: 800 } } }, unknowns: [], evidence: { location: { kind: 'time_range', range: [0, 800] } }, ...o });

test('needsFullRate: unexplained, too few samples, short motion, selectionAmbiguity, spring, short tween -> full rate; a long clean tween stays at 60 Hz', () => {
  assert.equal(needsFullRate([rec({})], 5000), null);
  assert.equal(needsFullRate([], 100), null);
  assert.equal(needsFullRate([rec({ tier: 'unexplained' })], 5000), 'unexplained');
  assert.equal(needsFullRate([rec({ tier: 'unknown' })], 5000), 'unexplained');
  assert.equal(needsFullRate([rec({ unknowns: [{ id: 'unk_too_few_samples' }] })], 5000), 'too_few_samples');
  assert.equal(needsFullRate([rec({ selectionAmbiguity: { margin: 1 } })], 5000), 'selectionAmbiguity');
  assert.equal(needsFullRate([rec({ class: 'spring', model: { params: {} } })], 5000), 'spring');
  assert.equal(needsFullRate([rec({ model: { params: { D: { value: 250 } } } })], 5000), 'short tween');
  assert.equal(needsFullRate([rec({ evidence: { location: { kind: 'time_range', range: [100, 350] } } })], 5000), 'short');
  assert.equal(needsFullRate([rec({ class: 'step', model: { params: {} }, evidence: { location: { kind: 'frame_index', range: [118, 119] } } })], 5000), 'short (one-frame step)');
  assert.equal(needsFullRate([rec({ evidence: { location: { kind: 'scroll_range', range: [0, 900] } } })], 120), 'short');   // no time range of its own: the channel's moving span decides
  assert.equal(needsFullRate([rec({ tier: 'declared' })], 5000), 'declared');
  assert.equal(needsFullRate([rec({ tier: 'not_applicable', class: 'not_applicable' })], null), null);
});

test('strideRows keeps every 2nd page frame; hybridApplies only for a plain full-rate take', () => {
  const rows = Array.from({ length: 10 }, (_, k) => ({ k: k + 5 }));
  assert.deepEqual(strideRows(rows).map((r) => r.k), [5, 7, 9, 11, 13]);
  assert.equal(hybridApplies(new Array(100), 8.33, 1), true);
  assert.equal(hybridApplies(new Array(100), 8.33, 2), false);   // already a stride: the normal fit
  assert.equal(hybridApplies(new Array(100), undefined, 1), false);
  assert.equal(hybridApplies(new Array(10), 8.33, 1), false);
});

test('hybrid fit: a one-frame step is refit at full rate and equals the normal fit; the env says so; without opts.hybrid nothing changes', () => {
  const els = [
    { desc: 'DIV.step', ch: { 'ren:tx': (k) => (k < 61 ? 0 : 40) } },
    { desc: 'DIV.tw', ch: { 'ren:tx': (k, T) => { const u = Math.min(1, Math.max(0, (T - 200) / 1000)); return 120 * u * u * (3 - 2 * u); } } },
  ];
  const take = () => synthTake({ rate: 120, dur: 1800, els });
  const normal = fitTakeSet({ primary: take() });
  const hyb = fitTakeSet({ primary: take() }, { hybrid: true });
  assert.equal(normal.env.hybrid, undefined);
  assert.deepEqual(fitTakeSet({ primary: take() }, {}), normal);   // opts without hybrid: unchanged
  assert.ok(hyb.env.hybrid && hyb.env.hybrid.stride === 2, 'env records the hybrid mode');
  assert.equal(hyb.env.stride, 1);
  assert.ok(hyb.env.hybrid.fullRate.length >= 1, 'the step is refit');
  const key = (r) => `${r.target.desc}|${r.target.channel}`;
  const stepN = normal.records.filter((r) => key(r) === 'DIV.step|ren:tx'), stepH = hyb.records.filter((r) => key(r) === 'DIV.step|ren:tx');
  assert.ok(stepN.length >= 1);
  assert.equal(JSON.stringify(stepH), JSON.stringify(stepN), 'a refit channel is the normal fit, byte for byte');
  assert.deepEqual(hyb.records.map(key), normal.records.map(key), 'same records in the same order');
  assert.ok(hyb.records.every((r) => r.tier === normal.records.find((q) => key(q) === key(r)).tier));
});
