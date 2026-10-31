// Corpus S2: unstable regions of two identical replays (pure) and the indeterminate verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unstableAt, unionArea, statusOf, reasonOf } from '../../src/gate/stability.js';
import { perSiteRandom } from '../../src/gate/run.js';

const snap = els => ({ vw: 100, vh: 100, docH: 200, pl: ['opacity', 'height', 'color'], vt: ['1', '0.5', '10px', '20px', 'red'], els });
const el = (k, b, s) => ({ k, b, t: '', s });

test('unstableAt: a box-only container is folded into its differing child; html/body never root a region', () => {
  const a = snap([el('html', [0, 0, 100, 200], [1, 2]), el('html/body[1]', [0, 0, 100, 200], []), el('html/body[1]/div[1]', [0, 0, 50, 50], []), el('html/body[1]/div[1]/p[1]', [0, 0, 10, 10], [0, 0]), el('html/body[1]/i[1]', [60, 60, 20, 20], [2, 4])]);
  const b = snap([el('html', [0, 0, 100, 210], [1, 3]), el('html/body[1]', [0, 0, 100, 210], []), el('html/body[1]/div[1]', [0, 0, 50, 60], []), el('html/body[1]/div[1]/p[1]', [0, 0, 10, 10], [0, 1]), el('html/body[1]/i[1]', [60, 60, 20, 20], [2, 4])]);
  const u = unstableAt(a, b, { pixel: { pass: true } });
  const ks = u.regions.map(r => r.k);
  assert.ok(ks.includes('html/body[1]/div[1]/p[1]'), 'the differing leaf is a region');
  assert.ok(!ks.includes('html/body[1]/div[1]'), 'box-only parent folded');
  assert.equal(u.regions.find(r => r.k === 'html').page, true);
  assert.equal(u.regions.find(r => r.k === 'html/body[1]/div[1]/p[1]').reason, 'motion-state');
  assert.ok(u.unstablePctViewport > 0 && u.unstablePctViewport < 2, `area ${u.unstablePctViewport}`);
  assert.ok(!ks.includes('html/body[1]/i[1]'), 'an equal element is not listed');
});

test('unstableAt: pixel-only difference names the opaque elements under the blob', () => {
  const a = snap([el('html', [0, 0, 100, 100], []), el('html/body[1]/canvas[1]', [10, 10, 50, 50], [])]);
  const u = unstableAt(a, a, { pixel: { pass: false, reason: 'blob 900 px^2 > 64', diffPx: 900, blob: 900, blobBox: [20, 20, 50, 50] } });
  assert.equal(u.oracleFailed, 0);
  assert.deepEqual(u.pixel.opaqueUnder, { canvas: 1 });
  assert.match(u.pixel.why, /canvas/);
});

test('unionArea counts overlaps once and clips to the rect', () => {
  assert.equal(unionArea([[0, 0, 40, 40], [0, 0, 40, 40]], [0, 0, 100, 100]), 1600);
  assert.equal(unionArea([[80, 80, 40, 40]], [0, 0, 100, 100]), 400);
});

test('statusOf: identity fail or > 15 % masked is indeterminate, never fail', () => {
  assert.equal(statusOf({ identityPass: false, acceptance: false }).status, 'indeterminate');
  assert.equal(statusOf({ identityPass: true, acceptance: true, maskedPctViewportMax: 15.1 }).status, 'indeterminate');
  assert.equal(statusOf({ identityPass: true, acceptance: false }).status, 'fail');
  assert.equal(statusOf({ identityPass: true, acceptance: true }).status, 'pass');
});

test('reasonOf ranks DOM > text > font > motion > custom property', () => {
  assert.equal(reasonOf(new Set(['element-missing', 'prop']), ['opacity'], 'k'), 'dom-differs');
  assert.equal(reasonOf(new Set(['prop']), ['--x', 'transform'], 'k'), 'motion-state');
  assert.equal(reasonOf(new Set(['prop']), ['--x'], 'k'), 'custom-property');
});

test('perSiteRandom: each call site has its own stream, independent of interleaving', () => {
  const saved = Math.random;
  try {
    perSiteRandom(7); const a = () => Math.random(), b = () => Math.random();
    const x = [a(), a(), b()];
    perSiteRandom(7);
    const y = [b(), a(), a()];
    assert.deepEqual([y[1], y[2], y[0]], x);
    assert.ok(x.every(v => v >= 0 && v < 1) && x[0] !== x[1]);
  } finally { Math.random = saved; }
});

test('opaqueUnder lists canvas/svg/img content under a differing blob and nothing else', async () => {
  const { opaqueUnder } = await import('../../src/gate/stability.js');
  const snap = { els: [
    { k: 'html/body[1]/div[1]/canvas[1]', b: [0, 0, 100, 100] },
    { k: 'html/body[1]/p[1]', b: [0, 200, 100, 20] },
    { k: 'html/body[1]/svg[1]', b: [300, 300, 10, 10] },
    { k: 'html/body[1]/img[1]', b: [50, 50, 0, 0] },
  ] };
  assert.deepEqual(opaqueUnder(snap, [10, 10, 60, 60]), { canvas: 1 });
  assert.deepEqual(opaqueUnder(snap, [0, 200, 90, 215]), {}, 'text only');
  assert.deepEqual(opaqueUnder(snap, null), {});
});
