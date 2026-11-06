// WebGL in a worker (S1 6 Nov, gap 11): a canvas whose control went to a worker is tapped in the worker's scope, on the page's virtual
// clock: its program, uniforms and draws are rows on the page's frame keys. Synthetic fixture (fixtures/webgl-worker), real Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSession } from '../src/record/session.js';
import { serveFixture } from './helpers.js';

test('a worker canvas: its program, uniforms and draws are recorded frame for frame on the page\'s clock', async () => {
  const srv = await serveFixture('webgl-worker');
  try {
    const s = await openSession({ lane: 'hx', rate: 60, url: `${srv.origin}/`, viewport: { width: 600, height: 400 }, seed: 1, scan: true, maxElements: Infinity, discover: true });
    let take;
    try {
      await s.goto(); await s.boot({ until: 'window.CASE_DONE === true', maxMs: 30000 });
      await s.hold(1500);
      ({ take } = await s.finish({ scenario: 'worker-gl', write: false }));
    } finally { await s.close(); }
    const gl = take.gl, w = gl.workers[0];
    assert.equal(w.tapped, true, JSON.stringify(w));
    const prog = gl.programs.find((p) => p.worker);
    assert.ok(prog && prog.id === 1001 && /uniform float uProgress/.test(prog.fs), JSON.stringify(gl.programs.map((p) => p.id)));
    assert.deepEqual(prog.uniforms.map((u) => u.name).sort(), ['uColor', 'uProgress', 'uTime']);
    const ctx = gl.contexts.find((c) => c.worker === 0); assert.ok(ctx && ctx.offscreen && ctx.el != null, JSON.stringify(gl.contexts));
    const rows = take.glWorkerRows;
    assert.ok(rows.length >= 60, `${rows.length} worker rows`);
    // the worker's frames are the page's: frame k at T_k, one draw per frame
    for (const r of rows.slice(-20)) { assert.ok(Math.abs(r.T - r.k * (1000 / 60)) < 0.01, JSON.stringify(r)); assert.equal(r.gld.p1001[0], 1); }
    // uTime is the virtual clock in seconds; uProgress rises 1/60 a frame; uColor set once
    const held = {}; const at = []; for (const r of rows) { Object.assign(held, r.gl || {}); at.push({ k: r.k, ...held }); }
    const last = at.at(-1); assert.deepEqual(last['p1001|uColor'], [1, 0.5, 0.25]);
    const a = at.find((x) => x['p1001|uProgress'] > 0.2 && x['p1001|uProgress'] < 0.8), b = at.find((x) => x.k === a.k + 6);
    assert.ok(Math.abs(b['p1001|uProgress'] - a['p1001|uProgress'] - 0.1) < 1e-4, `${a['p1001|uProgress']} -> ${b['p1001|uProgress']}`);
    assert.ok(Math.abs(b['p1001|uTime'] - a['p1001|uTime'] - 0.1) < 1e-4, 'uTime steps 1/60 s a frame');
  } finally { await srv.close(); }
});
