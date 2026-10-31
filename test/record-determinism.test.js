// A2 on our own fixture: two hx takes with the same input schedule are bit-identical after load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSession } from '../src/record/session.js';
import { serveFixture } from './helpers.js';

async function take(origin) {
  const s = await openSession({ lane: 'hx', rate: 120, url: origin + '/', viewport: { width: 800, height: 600 }, seed: 1 });
  try {
    await s.goto(); await s.boot({});
    await s.ev(() => __go());
    await s.hold(600);
    await s.scrollTo(400); await s.hold(200);
    await s.wheel({ dy: 40, n: 10 });
    await s.hold(600);
    const { take } = await s.finish({ scenario: 'determinism', write: false });
    const boot = take.marks.find(m => m.name === 'boot-done').k;
    return { rows: take.data.rows.filter(r => r.k >= boot).map(r => JSON.stringify([r.k, r.T, r.sy, Object.entries(r.v).map(([id, v]) => [take.els[id], v])])), births: JSON.stringify(take.data.births.map(b => [b.name, b.tgt, b.T])) };
  } finally { await s.close(); }
}

test('A2 determinism: two hx takes, same schedule, bit-identical after load', async () => {
  const srv = await serveFixture('bench');
  try {
    const a = await take(srv.origin), b = await take(srv.origin);
    const diffs = a.rows.filter((r, i) => r !== b.rows[i]).length;
    console.log('A2 fixture', JSON.stringify({ rows: [a.rows.length, b.rows.length], diffs, birthsEqual: a.births === b.births }));
    assert.equal(a.rows.length, b.rows.length);
    assert.equal(diffs, 0);
    assert.equal(a.births, b.births);
  } finally { await srv.close(); }
});
