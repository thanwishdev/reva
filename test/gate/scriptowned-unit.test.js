// Unit tests for script-owned regions (stage D1b): owned(P) from recorded script writes + snapshot key sets,
// declared-by lookup, pixel masking, and the oracle skipping owned subtrees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { ownedAt, isOwned, declaredBy, paintRects, ownedRects } from '../../src/gate/scriptowned.js';
import { declareOwned } from '../../src/gate/capture.js';
import { compareSnapshots } from '../../src/gate/compare.js';
import { diffPng } from '../../src/gate/pixels.js';

const sw = els => ({ els });
const w = (cur, o = {}) => ({ cur, old0: null, writes: 1, phases: ['pt:x'], sizes: ['1x1'], where: 'https://s/app.js:1:2', ...o });

test('ownedAt: changed script-written attributes, value before a first write after C, text, inserted/removed nodes', () => {
  const swC = sw({ 'html/body[1]/div[1]': { style: w('transform: translateY(0px)') } });
  const swP = sw({
    'html/body[1]/div[1]': { style: w('transform: translateY(52px)') },                 // changed since C
    'html/body[1]/div[2]': { style: w('height: 10px', { old0: 'height: 10px' }) },      // written after C, same value
    'html/body[1]/div[3]': { 'data-state': w('paused', { old0: 'active' }) },           // written after C, changed
    'html/body[1]/p[1]': { text: w(null) },                                             // script text
    'html/body[1]/ul[1]': { childList: w('li,li,li') },
  });
  const textC = new Map([['html', ''], ['html/body[1]', ''], ['html/body[1]/div[1]', ''], ['html/body[1]/div[2]', ''], ['html/body[1]/div[3]', ''], ['html/body[1]/p[1]', '12:00'], ['html/body[1]/ul[1]', ''], ['html/body[1]/ul[1]/li[1]', ''], ['html/body[1]/ul[1]/li[2]', '']]);
  const textP = new Map([...textC, ['html/body[1]/p[1]', '12:01'], ['html/body[1]/ul[1]/li[3]', ''], ['html/body[1]/ul[1]/li[3]/b[1]', '']]);
  const o = ownedAt(swC, swP, textC, textP);
  const by = Object.fromEntries(o.map(e => [e.k, e]));
  assert.deepEqual(Object.keys(by).sort(), ['html/body[1]/div[1]', 'html/body[1]/div[3]', 'html/body[1]/p[1]', 'html/body[1]/ul[1]/li[3]']);
  assert.deepEqual(by['html/body[1]/div[1]'].inject, { style: 'transform: translateY(52px)' });
  assert.deepEqual(by['html/body[1]/div[3]'].inject, { 'data-state': 'paused' });
  assert.deepEqual(by['html/body[1]/p[1]'].inject, {}, 'text is masked, not injected');
  assert.equal(by['html/body[1]/ul[1]/li[3]'].how, 'inserted');
});

test('declareOwned + declaredBy: evidence kept per name; phases mapped to scroll/time/viewport', () => {
  const d = declareOwned(sw({ 'html/body[1]/ul[1]': { childList: w('li', { phases: ['sweep', 'probe:resize'] }) }, 'html/body[1]/i[1]': { style: w('x', { phases: ['probe:time'] }) } }));
  assert.deepEqual(d.find(x => x.k === 'html/body[1]/ul[1]').why, ['scroll', 'viewport']);
  assert.equal(d.find(x => x.k === 'html/body[1]/i[1]').names.style.where, 'https://s/app.js:1:2');
  assert.equal(declaredBy('html/body[1]/ul[1]/li[3]', d).k, 'html/body[1]/ul[1]');
  assert.equal(declaredBy('html/body[1]/ul[2]', d), null);
  assert.ok(isOwned('html/body[1]/i[1]#s/span[1]', ['html/body[1]/i[1]']) && !isOwned('html/body[1]/i[10]', ['html/body[1]/i[1]']));
});

test('oracle skips owned subtrees on both sides and counts them; other misses still fail', () => {
  const snap = (els) => ({ pl: ['color'], vt: ['red', 'blue'], els });
  const a = snap([{ k: 'html', b: [0, 0, 10, 10], t: '', s: [0, 0] }, { k: 'html/i[1]', b: [0, 0, 5, 5], t: '', s: [0, 0] }, { k: 'html/i[1]/b[1]', b: [0, 9, 5, 5], t: '', s: [0, 0] }, { k: 'html/p[1]', b: [0, 5, 5, 5], t: '', s: [0, 0] }]);
  const b = snap([{ k: 'html', b: [0, 0, 10, 10], t: '', s: [0, 0] }, { k: 'html/i[1]', b: [0, 3, 5, 5], t: '', s: [0, 1] }, { k: 'html/p[1]', b: [0, 5, 5, 5], t: '', s: [0, 0] }, { k: 'html/i[1]/u[1]', b: [0, 0, 1, 1], t: '', s: [0, 0] }]);
  const r = compareSnapshots(a, b, { owned: ['html/i[1]'] });
  assert.equal(r.pass, true); assert.equal(r.owned, 2);
  const r2 = compareSnapshots(a, { ...b, els: b.els.map(e => e.k === 'html/p[1]' ? { ...e, s: [0, 1] } : e) }, { owned: ['html/i[1]'] });
  assert.equal(r2.pass, false); assert.equal(r2.misses[0].k, 'html/p[1]');
});

test('pixel mask: same paint in both images hides only the owned rect; masked px reported', () => {
  const img = fill => { const p = new PNG({ width: 20, height: 10 }); for (let i = 0; i < 200; i++) p.data.set(fill(i % 20, (i / 20) | 0), i * 4); return PNG.sync.write(p); };
  const A = img(() => [255, 255, 255, 255]), B = img((x, y) => (x < 5 && y < 5) || (x === 15 && y === 8) ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  const snap = { els: [{ k: 'html/i[1]', b: [0, 0, 5, 5] }] };
  const d = diffPng(A, B, { mask: ownedRects(snap, ['html/i[1]']) });
  assert.equal(d.maskedPx, 25); assert.equal(d.diffPx, 1, 'the unowned pixel still counts');
  assert.equal(diffPng(A, B).diffPx, 26);
  const p = new PNG({ width: 4, height: 4 }); assert.equal(paintRects(p, [[-2, -2, 2, 2], [1, 1, 3, 3]]), 7);
});

test('decoder tolerance: <=2-level diffs inside given image rects are counted apart; larger or outside still count', () => {
  const img = fill => { const p = new PNG({ width: 10, height: 4 }); for (let i = 0; i < 40; i++) p.data.set(fill(i % 10, (i / 10) | 0), i * 4); return PNG.sync.write(p); };
  const A = img(() => [0, 0, 0, 255]);
  const B = img((x, y) => x < 2 && y === 0 ? [1, 0, 1, 255] : x === 3 && y === 0 ? [9, 0, 9, 255] : x === 8 ? [1, 0, 1, 255] : [0, 0, 0, 255]); // values measured on a real site: (0,0,0) vs (1,0,1)
  const plain = diffPng(A, B);
  const tol = diffPng(A, B, { decodeRects: [[0, 0, 5, 4]] });
  assert.equal(tol.decodePx, 2, 'two 2-level px inside the image');
  assert.equal(tol.diffPx, plain.diffPx - 2, 'the 9-level px in the image and the px outside still count');
});
