// The look fit order (fitOrder + fitTakeSet opts.order): a declared entrance next to a motion whose one channel steps
// many times must not lose the evaluation budget to it (a real site, load: the hero's exact 700 ms CSS entrance was never
// fitted because the first motion's channels spent the whole take budget first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitTakeSet } from '../../src/analysis/fit/index.js';
import { fitOrder } from '../../src/look/select.js';
import { synthTake } from '../fit/helpers.js';

// el 0: one channel with 20 eased steps (each 40 px over 60 ms, every 90 ms); el 1: a 700 ms opacity fade-in, declared
const smooth = (u) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };
const steps = (k, T) => { let y = 0; for (let i = 0; i < 20; i++) y += 40 * smooth((T - 100 - 90 * i) / 60); return y; };
const fade = (k, T) => smooth((T - 300) / 700);
const births = [{ tgt: 'DIV.fade', name: 'fade-in', kind: 'CSSAnimation', keyframes: [{ opacity: '0' }, { opacity: '1' }] }];
const take = () => synthTake({ dur: 2400, births, els: [{ desc: 'DIV.steps', ch: { 'ren:tx': steps } }, { desc: 'DIV.fade', ch: { 'ren:opacity': fade } }] });
const entries = [
  { rank: 1, lead: 0, fitted: { lead: ['ren:tx'], members: [] } },
  { rank: 2, lead: 1, fitted: { lead: ['ren:opacity'], members: [] } },
];
const els = ['DIV.steps', 'DIV.fade'];

test('fitOrder: declared channels first, then one channel per motion per round, then group members; each key once', () => {
  const big = [
    { rank: 1, lead: 0, fitted: { lead: ['ren:rz', 'ren:tx', 'ren:ty'], members: [5, 6] }, memberChannel: 'ren:rz' },
    { rank: 2, lead: 1, fitted: { lead: ['ren:opacity', 'ren:filter'], members: [] } },
    { rank: 3, lead: 2, fitted: { lead: ['ren:sx'], members: [] } },
  ];
  const order = fitOrder(big, births, ['A', 'DIV.fade', 'B'], { pageKey: '9|ren:by' });
  assert.deepEqual(order, ['9|ren:by', '1|ren:opacity', '0|ren:rz', '2|ren:sx', '0|ren:tx', '1|ren:filter', '0|ren:ty', '5|ren:rz', '6|ren:rz']);
  // a transition of `all` or of transform names every transform part of its element
  const t = fitOrder(big, [{ tgt: 'B', name: 'transform', kind: 'CSSTransition' }], ['A', 'X', 'B']);
  assert.equal(t[0], '2|ren:sx');
});

test('a declared fade next to a many-step channel: in plan order the budget is gone before the fade; with fitOrder the fade is fitted', () => {
  const onlySteps = fitTakeSet({ primary: take() }, { onlyKeys: ['0|ren:tx'] });
  const cost = onlySteps.meterStats.evalUnits; assert.ok(cost > 0);
  const opts = { evalBudget: cost, onlyKeys: ['0|ren:tx', '1|ren:opacity'] };
  const fadeRec = (res) => res.records.find((r) => r.target.desc === 'DIV.fade' && r.target.channel === 'ren:opacity');
  const cutFade = (res) => res.unknowns.some((u) => u.id === 'unk_fit_budget' && /^DIV\.fade\|/.test(String(u.target || '')))
    || (fadeRec(res) && fadeRec(res).unknowns.some((u) => u.id === 'unk_fit_budget'));
  const plain = fitTakeSet({ primary: take() }, opts);
  assert.ok(cutFade(plain), 'plan order: the fade is cut by the take budget');
  const order = fitOrder(entries, births, els);
  assert.deepEqual(order, ['1|ren:opacity', '0|ren:tx']);
  const ordered = fitTakeSet({ primary: take() }, { ...opts, order });
  assert.ok(!cutFade(ordered), 'fitOrder: the fade is not cut');
  const r = fadeRec(ordered); assert.ok(r && r.tier !== 'unknown', JSON.stringify(r && { tier: r.tier, u: r.unknowns }));
  // the fade's fit does not depend on the order (same record as when it is fitted alone)
  const alone = fadeRec(fitTakeSet({ primary: take() }, { onlyKeys: ['1|ren:opacity'] }));
  assert.equal(JSON.stringify(r.model), JSON.stringify(alone.model));
});

test('opts.order unset or empty changes nothing (same bytes)', () => {
  const a = fitTakeSet({ primary: take() }); const b = fitTakeSet({ primary: take() }, { order: [] });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
