// A2 regression: real-time events (scroll, IntersectionObserver) must land in the same virtual frame no matter how
// much real time passes between an input and the next virtual step. Before the fix, a Node-side delay after
// scrollTo let a real frame dispatch the scroll event before the next virtual frame (one frame early); without the
// delay it was dispatched during that frame's real settle (one frame late) — measured on a real site as 1 take in 6.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSession } from '../src/record/session.js';
import { serveFixture } from './helpers.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function take(origin, gapMs) {
  const s = await openSession({ lane: 'hx', rate: 120, url: origin + '/', viewport: { width: 800, height: 600 }, seed: 1 });
  try {
    await s.goto(); await s.boot({});
    await s.watch(['#raf', '#cls', '#evt', '#io']);
    await s.hold(100);
    for (const y of [600, 1200, 0, 900]) {
      await s.scrollTo(y); await s.mark('land', { y });
      if (gapMs) await sleep(gapMs);        // real time passes; virtual time must not care
      await s.hold(500);
    }
    await s.wheel({ dy: 40, n: 6 });
    if (gapMs) await sleep(gapMs);
    await s.hold(300);
    const { take } = await s.finish({ scenario: 'scroll-race', write: false });
    const boot = take.marks.find(m => m.name === 'boot-done').k;
    return { rows: take.data.rows.filter(r => r.k >= boot).map(r => JSON.stringify([r.k, r.T, r.sy, Object.entries(r.v).map(([id, v]) => [take.els[id], v])])),
      births: JSON.stringify(take.data.births.filter(b => b.k >= boot).map(b => [b.name, b.tgt, b.T])) };
  } finally { await s.close(); }
}

test('A2 scroll-event race: real-time gap after input does not change the take', async () => {
  const srv = await serveFixture('scroll-race');
  try {
    const a = await take(srv.origin, 0), b = await take(srv.origin, 60);
    const diffs = a.rows.filter((r, i) => r !== b.rows[i]).length;
    const first = a.rows.findIndex((r, i) => r !== b.rows[i]);
    console.log('A2 scroll-race', JSON.stringify({ rows: [a.rows.length, b.rows.length], diffs, firstDiffIdx: first, birthsEqual: a.births === b.births }));
    assert.equal(a.rows.length, b.rows.length);
    assert.equal(diffs, 0);
    assert.equal(a.births, b.births);
  } finally { await srv.close(); }
});
