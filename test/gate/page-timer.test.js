// L7 fix: Playwright's fake clock runs every due timer, advances, and only then rethrows the first exception a page
// callback threw. That is the page's own error (in a browser it is only reported), so the gate records it and goes on;
// a harness / browser failure still fails. Reasons below are the stored 22-23 Oct deep-run crash reasons. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPageTimerError, advance, pauseClockAt } from '../../src/gate/run.js';

const STORED = [
  'clock.runFor: TypeError: window.updateNavColorFromSections is not a function', // measured site 1
  "clock.runFor: TypeError: Cannot read properties of undefined (reading 'split')", // measured site 2
  'clock.runFor: RangeError: Maximum call stack size exceeded', // measured sites 3 and 4
  "clock.runFor: TypeError: Cannot read properties of null (reading 'close')", // measured site 5
];

test('isPageTimerError: page timer exceptions yes; harness/browser failures no', () => {
  for (const m of STORED) assert.equal(isPageTimerError(new Error(m)), true, m);
  for (const m of ['clock.runFor: Target page, context or browser has been closed', 'clock.pauseAt: Cannot fast-forward to the past', 'clock.runFor: Execution context was destroyed, most likely because of a navigation', 'page.evaluate: TypeError: x is not a function', 'clock.runFor: Timeout 30000ms exceeded.'])
    assert.equal(isPageTimerError(new Error(m)), false, m);
});

// a page whose fake clock throws once; evaluate answers (alive) unless told otherwise
function fakePage({ err, alive = true }) {
  let calls = 0;
  return {
    calls: () => calls,
    clock: { runFor: async () => { calls++; if (calls === 1) throw new Error(err); }, pauseAt: async () => { throw new Error(err); } },
    evaluate: async () => { if (!alive) throw new Error('page.evaluate: Target page, context or browser has been closed'); return 1; },
  };
}

test('advance: a page timer exception is recorded and the replay goes on; a dead page or harness error still throws', async () => {
  const net = { stats: { waits: 0 }, pending: () => 0, hold: async () => {}, release: () => {} };
  const p = fakePage({ err: STORED[0] });
  await advance(p, net, 750); // 3 chunks: the first throws a page error, the other two run
  assert.equal(p.calls(), 3);
  assert.equal(net.stats.pageTimerErrors, 1);
  assert.match(net.stats.pageTimerError, /updateNavColorFromSections/);
  await assert.rejects(advance(fakePage({ err: STORED[0], alive: false }), { stats: {}, pending: () => 0 }, 250), /updateNavColorFromSections/);
  await assert.rejects(advance(fakePage({ err: 'clock.runFor: Target page, context or browser has been closed' }), { stats: {}, pending: () => 0 }, 250), /closed/);
  // pauseAt: the clock is paused at the target before the rethrow: on time (0 ms late), recorded
  const n2 = { stats: {} };
  assert.equal(await pauseClockAt(fakePage({ err: 'clock.pauseAt: ' + STORED[2].slice('clock.runFor: '.length) }), 1000, 'keep', n2), 0);
  assert.equal(n2.stats.pageTimerErrors, 1);
});
