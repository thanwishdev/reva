// M2 recorder extensions X1 (30 Hz + stall schedule, birth time under a stall), X2 (frame key on every input-log entry,
// page-observed pointer/click entries) on the own bench fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSession } from '../src/record/session.js';
import { serveFixture } from './helpers.js';

const r6 = (x) => Math.round(x * 1e6) / 1e6;

async function take(origin, o, body) {
  const s = await openSession({ lane: 'hx', url: origin + '/', viewport: { width: 800, height: 600 }, seed: 1, ...o });
  try {
    await s.goto(); await s.boot({});
    await body(s);
    const { take } = await s.finish({ scenario: 'x1', write: false });
    return take;
  } finally { await s.close(); }
}

test('X1: 30 Hz grid and the R5 stall schedule; births use the next frame time', async () => {
  const srv = await serveFixture('bench');
  try {
    const t30 = await take(srv.origin, { rate: 30 }, async (s) => { await s.hold(500); });
    for (const r of t30.data.rows) assert.equal(r.T, r6(r.k * 1000 / 30));
    const dt = 1000 / 60;
    const t5 = await take(srv.origin, { rate: 60, stall: { every: 30, ms: 100 } }, async (s) => { await s.hold(200); await s.ev(() => __go()); await s.hold(1200); });
    for (const r of t5.data.rows) assert.equal(r.T, r6(r.k * dt + Math.floor(r.k / 30) * (100 - dt)));
    const gap = t5.data.rows.find((r) => r.k === 30), before = t5.data.rows.find((r) => r.k === 29);
    assert.ok(Math.abs(gap.T - before.T - 100) < 1e-5, 'frame 30 follows a 100 ms stall');
    const frameT = (k) => r6(k * dt + Math.floor(k / 30) * (100 - dt));
    const grid = new Set(t5.data.rows.map((r) => r.T));
    assert.ok(t5.data.births.length > 0, 'the bench starts declared animations');
    for (const b of t5.data.births) assert.ok(grid.has(b.T) || b.T === frameT(b.k + 1) || b.T === frameT(b.k), `birth T ${b.T} on the stall grid (k ${b.k})`);
    assert.equal(t5.cfg.stall.every, 30);
  } finally { await srv.close(); }
});

test('X2: wheel entries carry k and T; page-observed pointer and click entries join the input log', async () => {
  const srv = await serveFixture('bench');
  try {
    const t = await take(srv.origin, { rate: 60 }, async (s) => {
      await s.hold(100);
      await s.wheel({ dy: 20, n: 3 });
      await s.ev(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 50 })); document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 3, clientY: 4 })); });
      await s.hold(100);
    });
    const wheels = t.inputLog.filter((e) => e.type === 'wheel');
    assert.equal(wheels.length, 3);
    wheels.forEach((w, i) => { assert.ok(Number.isInteger(w.k)); assert.ok(Number.isFinite(w.T)); assert.equal(w.k, t.data.wheel[i].k, 'same key as the page-side wheel log'); });
    const ptr = t.inputLog.filter((e) => e.source === 'page-observed');
    assert.deepEqual(ptr.map((e) => e.type), ['pointer', 'click'], 'the recorder\'s own positioning move before the wheel is muted');
    assert.equal(ptr[0].x, 100); assert.ok(Number.isInteger(ptr[0].k));
    for (let i = 1; i < t.inputLog.length; i++) assert.ok((t.inputLog[i].k ?? -1) >= (t.inputLog[i - 1].k ?? -1), 'ordered by frame key');
  } finally { await srv.close(); }
});
