// A6 (bench part): hx stepper on our own bench page. Gate: page control <= 1 frame, `.finished` fires,
// browser microtask order (timer: 1, rAF: unset).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSession } from '../src/record/session.js';
import { analyseBench } from '../src/record/bench.js';
import { serveFixture } from './helpers.js';

export async function runBench(rate = 120) {
  const srv = await serveFixture('bench');
  const s = await openSession({ lane: 'hx', rate, url: srv.origin + '/', viewport: { width: 800, height: 600 }, seed: 1 });
  try {
    await s.goto(); await s.boot({});
    await s.watch(['.b']);
    await s.ev(() => __go());
    await s.hold(2400);
    const log = await s.ev(() => LOG);
    const { take } = await s.finish({ scenario: 'bench', write: false });
    return { r: analyseBench(take.data.rows, log, take.els), take };
  } finally { await s.close(); await srv.close(); }
}

test('A6 bench: hx 120 Hz page control within one frame, .finished fires, microtask order', async () => {
  const { r } = await runBench(120);
  const frame = 100 / 1000 * (1000 / 120);           // px per frame of the 100 px / 1000 ms loops
  console.log('bench', JSON.stringify(r));
  assert.ok(r.maxErr.ctl <= frame + 1e-3, `ctl ${r.maxErr.ctl}`);
  assert.ok(r.maxErr.rate <= 2 * frame + 1e-3, `rate ${r.maxErr.rate}`);   // playbackRate 2: one frame = 2x px
  assert.ok(r.maxErr.rev <= frame + 1e-3, `rev ${r.maxErr.rev}`);
  assert.ok(r.maxErr.js <= 0.01, `js spring ${r.maxErr.js}`);
  assert.equal(r.finishedFired, true);
  assert.equal(r.micro, '1');
  assert.equal(r.rafmicro, 'unset');
});
