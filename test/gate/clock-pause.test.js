// Fake-clock pauseAt must never fail as "Cannot fast-forward to the past" (install stall, or a long load/settle/sweep).
// Own synthetic page only. Run: node --test --test-concurrency=1 test/gate/clock-pause.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '../../src/browser/launch.js';
import { pauseClockAt, FIXED_TIME } from '../../src/gate/run.js';

const open = () => launchBrowser({ args: [], context: { viewport: { width: 400, height: 300 } } });

test('pauseClockAt: on time pauses exactly at the target, 0 late', { timeout: 60000 }, async () => {
  const h = await open();
  try {
    await h.page.clock.install({ time: FIXED_TIME - 1000 });
    assert.equal(await pauseClockAt(h.page, FIXED_TIME, 'set'), 0);
    await h.page.goto('about:blank');
    assert.equal(await h.page.evaluate(() => Date.now()), FIXED_TIME);
  } finally { await h.close(); }
});

test('pauseClockAt: install stalled past the 1 s head start still pauses at FIXED_TIME (set)', { timeout: 60000 }, async () => {
  const h = await open();
  try {
    await h.page.clock.install({ time: FIXED_TIME - 200 });
    await new Promise(r => setTimeout(r, 600)); // the stall: the running clock passes the target
    await assert.rejects(h.page.clock.pauseAt(FIXED_TIME), /fast-forward to the past/, 'precondition: plain pauseAt throws');
    await h.page.clock.resume();
    await new Promise(r => setTimeout(r, 100));
    const late = await pauseClockAt(h.page, FIXED_TIME, 'set');
    assert.ok(late > 0, 'reports it was late');
    assert.equal(await h.page.evaluate(() => Date.now()), FIXED_TIME, 'Date reset to the target, same for every replay');
    await h.page.clock.runFor(500);
    assert.equal(await h.page.evaluate(() => Date.now()), FIXED_TIME + 500, 'paused: moves only when advanced');
  } finally { await h.close(); }
});

test('pauseClockAt: a clock advanced past the target stays paused, no throw (keep)', { timeout: 60000 }, async () => {
  const h = await open();
  try {
    await h.page.clock.install({ time: FIXED_TIME - 1000 });
    await pauseClockAt(h.page, FIXED_TIME, 'set');
    await h.page.clock.runFor(400000); // beyond FIXED_TIME + 300000
    const late = await pauseClockAt(h.page, FIXED_TIME + 300000, 'keep');
    assert.equal(late, 100000);
    const t = await h.page.evaluate(() => Date.now());
    assert.equal(t, FIXED_TIME + 400000);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(await h.page.evaluate(() => Date.now()), t, 'still paused');
  } finally { await h.close(); }
});

test('openSession reports a stalled install (installLateMs) so the run can be marked indeterminate', { timeout: 60000 }, async () => {
  // pauseClockAt returns > 0 for the 'set' branch exactly when the install stalled; openSession passes it on as installLateMs
  const h = await open();
  try {
    await h.page.clock.install({ time: FIXED_TIME - 200 });
    await new Promise(r => setTimeout(r, 500));
    await h.page.clock.resume().catch(() => {});
    assert.ok(await pauseClockAt(h.page, FIXED_TIME, 'set') > 0);
  } finally { await h.close(); }
  const src = (await import('node:fs')).readFileSync(new URL('../../src/gate/run.js', import.meta.url), 'utf8');
  assert.match(src, /installLateMs = await pauseClockAt\(h\.page, FIXED_TIME, 'set'(, \w+)?\)/);
  assert.match(src, /return \{ h, net, requests, js, capState, flight, clockLateMs, installLateMs[ ,]/);
});
