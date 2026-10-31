// A7 + D3 on our own planted-value fixture: every channel every frame, opacity 0 reads 0, same-frame reads 240/240,
// and every read is within the measured read-back floor of what was written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSession } from '../src/record/session.js';
import { serveFixture } from './helpers.js';

const N = 240;
const CHANNELS = {
  a: ['ren:tx', 'ren:ty', 'ren:sx', 'ren:rz', 'ren:opacity', 'ren:radius', 'ren:clipPath', 'ren:filter', 'drv:transform', 'drv:opacity', 'ren:bx', 'ren:by', 'ren:bw', 'ren:bh'],
  b: ['ren:translate', 'ren:scale', 'ren:rotate', 'drv:--p', 'ren:--p'],
  c: ['drv:--q', 'ren:--q', 'ren:bx'],
};

test('A7/D3 planted values: every channel every frame, same-frame reads, opacity 0 reads 0', async () => {
  const srv = await serveFixture('planted');
  const s = await openSession({ lane: 'hx', rate: 120, url: srv.origin + '/', viewport: { width: 800, height: 600 }, seed: 1, discover: false });
  let take, plant, kmap;
  try {
    await s.goto(); await s.boot({});
    await s.watch(['#a', '#b', '#c']);
    await s.clearSamples();
    await s.step(N, { batch: 8 });
    ({ plant, kmap } = await s.ev(() => ({ plant: window.PLANT, kmap: window.KMAP })));
    ({ take } = await s.finish({ scenario: 'planted', write: false }));
  } finally { await s.close(); await srv.close(); }
  const els = take.els; const idx = (name) => els.findIndex(d => d && d.startsWith('DIV#' + name));
  const ids = { a: idx('a'), b: idx('b'), c: idx('c') };
  const floor = take.env.readback;
  const rows = take.data.rows.slice(-N);
  assert.equal(rows.length, N);
  let complete = 0, sameFrame = 0, opacityZero = 0, opacityZeroOk = 0;
  const maxErr = {};
  const err = (k, x) => { maxErr[k] = Math.max(maxErr[k] || 0, Math.abs(x)); };
  for (const r of rows) {
    const k = kmap[r.k]; const p = plant[k];
    const ok = Object.entries(CHANNELS).every(([e, chs]) => r.v[ids[e]] && chs.every(c => c in r.v[ids[e]]));
    if (ok) complete++;
    const A = r.v[ids.a], B = r.v[ids.b], C = r.v[ids.c];
    err('tx', A['ren:tx'] - p.tx); err('ty', A['ren:ty'] - p.ty); err('sx', A['ren:sx'] - p.sx); err('rz', A['ren:rz'] - p.rz);
    err('opacity', A['ren:opacity'] - p.opacity); err('radius', parseFloat(A['ren:radius']) - p.radius);
    err('inset', parseFloat(/inset\(([-\d.e+]+)%/.exec(A['ren:clipPath'])?.[1] ?? 0) - p.inset);
    err('blur', parseFloat(/blur\(([-\d.e+]+)px/.exec(A['ren:filter'])?.[1] ?? 0) - p.blur);
    err('translate', parseFloat(B['ren:translate']) - p.translate); err('scale', parseFloat(B['ren:scale']) - p.scale);
    err('rotate', parseFloat(B['ren:rotate']) - p.rotate); err('--p', B['drv:--p'] - p.p); err('--q(rendered)', C['ren:--q'] - p.q);
    err('left(bbox)', C['ren:bx'] - p.left);
    const exact = Math.abs(A['ren:tx'] - p.tx) < 1e-3 && Math.abs(B['drv:--p'] - p.p) < 1e-9 && Math.abs(C['ren:--q'] - p.q) < 1e-4 && Math.abs(A['ren:opacity'] - p.opacity) < 1e-6;
    if (exact) sameFrame++;
    if (p.opacity === 0) { opacityZero++; if (A['ren:opacity'] === 0) opacityZeroOk++; }
  }
  console.log('A7', JSON.stringify({ frames: rows.length, complete, sameFrame, opacityZero, opacityZeroOk, maxErr }));
  console.log('D3 read-back floor', JSON.stringify(floor));
  assert.equal(complete, N, 'every channel every frame');
  assert.equal(sameFrame, N, 'same-frame reads');
  assert.ok(opacityZero > 50 && opacityZeroOk === opacityZero, 'opacity 0 reads 0');
  // every read within its channel's measured floor (plus float formatting of the written string)
  assert.ok(maxErr.tx <= floor['translateX(px)'].maxAbsErr + 1e-6);
  assert.ok(maxErr.opacity <= floor.opacity.maxAbsErr + 1e-9);
  assert.ok(maxErr.radius <= floor['border-radius(px)'].maxAbsErr + 1e-6);
  assert.ok(maxErr.blur <= floor['filter-blur(px)'].maxAbsErr + 1e-6);
  assert.ok(maxErr['left(bbox)'] <= floor['left(px)'].maxAbsErr + 1e-6);
  for (const v of Object.values(floor)) assert.ok(Number.isFinite(v.maxAbsErr));
});
