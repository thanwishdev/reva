// A rebuild point that differs only inside canvas / video / iframe is `unpaintable` (listed, not a pass); a difference
// anywhere else, or an element mismatch, keeps it a plain failure. S3 (26 Oct): acceptance counts passed points only,
// so an unpaintable point fails acceptance (full and lite) and stays listed in the verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PNG } from 'pngjs';
import { unpaintableAt } from '../../src/gate/run.js';
import { acceptanceOf } from '../../src/gate/capture.js';

const W = 100, H = 100;
const snap = { vw: W, vh: H, els: [{ k: 'html/body[1]', b: [0, 0, W, H] }, { k: 'html/body[1]/canvas[1]', b: [10, 10, 30, 30] }, { k: 'html/body[1]/p[1]', b: [60, 60, 30, 20] }] };

function shot(file, paint) {
  const p = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) p.data.set([255, 255, 255, 255], i * 4);
  for (const [x0, y0, x1, y1] of paint) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) p.data.set([0, 0, 0, 255], (y * W + x) * 4);
  fs.writeFileSync(file, PNG.sync.write(p));
}
function dirs(paintB, sn = snap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unpaint-'));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  for (const d of [a, b]) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'p1.json.gz'), zlib.gzipSync(JSON.stringify(sn))); }
  shot(path.join(a, 'p1.png'), []); shot(path.join(b, 'p1.png'), paintB);
  return [a, b];
}
const failing = (oraclePass = true) => ({ pass: false, oracle: { pass: oraclePass }, pixel: { pass: false, blobBox: [15, 15, 35, 35], cap: 0 } });
const pt = { id: 'p1' };

test('difference only inside a canvas: unpaintable, with what was painted out', () => {
  const [a, b] = dirs([[15, 15, 35, 35]]);
  const u = unpaintableAt(a, b, pt, failing());
  assert.ok(u);
  assert.deepEqual(u.elements, ['html/body[1]/canvas[1]']);
  assert.equal(u.maskedPx, 30 * 30);
  assert.equal(u.pctViewport, 9);
});

test('a difference outside every canvas stays a failure', () => {
  const [a, b] = dirs([[15, 15, 35, 35], [65, 65, 80, 75]]);
  assert.equal(unpaintableAt(a, b, pt, failing()), null);
});

test('an element mismatch is never unpaintable', () => {
  const [a, b] = dirs([[15, 15, 35, 35]]);
  assert.equal(unpaintableAt(a, b, pt, failing(false)), null);
});

test('a passing or skipped point is left alone', () => {
  const [a, b] = dirs([]);
  assert.equal(unpaintableAt(a, b, pt, { pass: true, oracle: { pass: true }, pixel: { pass: true } }), null);
  assert.equal(unpaintableAt(a, b, pt, { pass: false, oracle: { pass: true }, pixel: { pass: false, skipped: 'clip', blobBox: null } }), null);
});

// a verdict that passes every other part, so only the rebuild decides
const good = { identityPass: true, captureSessionSame: true, scriptOwnedUndeclared: 0, auditPass: true, mutantsPass: true, installStalled: false };
const failingAt = box => ({ pass: false, oracle: { pass: true }, pixel: { pass: false, blobBox: box, cap: 0 } });

test('S3: a full-viewport canvas difference is listed unpaintable and fails acceptance (full and lite)', () => {
  const full = { vw: W, vh: H, els: [{ k: 'html/body[1]', b: [0, 0, W, H] }, { k: 'html/body[1]/canvas[1]', b: [0, 0, W, H] }] };
  const [a, b] = dirs([[0, 0, W, H]], full);
  const u = unpaintableAt(a, b, pt, failingAt([0, 0, W, H]));
  assert.ok(u); assert.equal(u.pctViewport, 100);
  // 1 point, 0 passed, 1 unpaintable (before 26 Oct: rebuildCovered 1 === points -> acceptance true)
  const s = { all: { pass: 0, points: 1 } };
  const v = { ...good, rebuildUnpaintable: ['p1'], rebuildCovered: 1 };
  const r = acceptanceOf(v, s, { minRebuildFrac: 0.8 });
  assert.equal(r.acceptance, false); assert.equal(r.liteAcceptance, false);
  assert.deepEqual(v.rebuildUnpaintable, ['p1'], 'still listed');
});

test('S3: a small iframe difference is listed unpaintable; full acceptance fails, lite counts only the real passes', () => {
  const sn = { vw: W, vh: H, els: [{ k: 'html/body[1]', b: [0, 0, W, H] }, { k: 'html/body[1]/iframe[1]', b: [70, 5, 20, 10] }] };
  const [a, b] = dirs([[72, 6, 88, 14]], sn);
  const u = unpaintableAt(a, b, pt, failingAt([72, 6, 88, 14]));
  assert.ok(u); assert.deepEqual(u.elements, ['html/body[1]/iframe[1]']); assert.equal(u.pctViewport, 2);
  // 5 points: 4 passed + 1 unpaintable. Full: not every point passed. Lite needs ceil(0.8 x 5) = 4 passed: lite passes on
  // the 4 real passes, never on the unpaintable one (4 passed + 1 unpaintable of 6 points: lite needs 5 -> false)
  assert.equal(acceptanceOf({ ...good, rebuildUnpaintable: ['p1'] }, { all: { pass: 4, points: 5 } }, null).acceptance, false);
  assert.equal(acceptanceOf({ ...good, rebuildUnpaintable: ['p1'] }, { all: { pass: 4, points: 6 } }, { minRebuildFrac: 0.8 }).liteAcceptance, false);
  assert.equal(acceptanceOf({ ...good, rebuildUnpaintable: ['p1'] }, { all: { pass: 4, points: 5 } }, { minRebuildFrac: 0.8 }).liteAcceptance, true);
  assert.equal(acceptanceOf(good, { all: { pass: 5, points: 5 } }, null).acceptance, true, 'all passed: accepted');
});
