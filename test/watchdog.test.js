import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUsage, decide, runWatched, EXIT_CAP, DEFAULT_CAPS } from '../src/quota/watchdog.js';

test('parseUsage: normal, empty 5h (fresh window), garbage', () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(parseUsage('1000000000 30 15', now), { epoch: 1000000000, sevenDay: 30, fiveHour: 15, ageS: 0 });
  assert.equal(parseUsage('1000000000 30', now).fiveHour, 0);
  assert.equal(parseUsage('1000000000 30 ', now).fiveHour, 0);
  assert.equal(parseUsage('', now), null);
  assert.equal(parseUsage('abc def', now), null);
});

test('decide: caps are inclusive, unknown never stops', () => {
  const u = (s, f) => ({ epoch: 0, sevenDay: s, fiveHour: f, ageS: 0 });
  assert.equal(decide(u(30, 87)).stop, false);
  assert.equal(decide(u(30, 88)).stop, true);
  assert.equal(decide(u(79, 10)).stop, true);
  assert.equal(decide(u(78, 10)).stop, false);
  assert.equal(decide(null).stop, false);
  assert.deepEqual(DEFAULT_CAPS, { fiveHour: 88, sevenDay: 79 });
});

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('dummy run: watchdog samples, stops the job at the cap, exits 75, child tree is gone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-wd-'));
  const file = path.join(dir, 'usage.txt'); const log = path.join(dir, 'wd.log');
  const stamp = (s, f) => fs.writeFileSync(file, `${Math.floor(Date.now() / 1000)} ${s} ${f}\n`);
  stamp(30, 10);
  const raise = setTimeout(() => stamp(30, 90), 1200);
  const t0 = Date.now();
  // `sh -c 'sleep 300 & wait'` makes a grandchild so the process-group kill is exercised.
  const r = await runWatched(['/bin/sh', '-c', 'sleep 300 & echo $! > ' + path.join(dir, 'gc.pid') + '; wait'], { file, intervalMs: 300, graceMs: 1000, logFile: undefined, nice: 20 });
  clearTimeout(raise);
  assert.equal(r.stoppedByCap, true);
  assert.equal(r.exitCode, EXIT_CAP);
  assert.match(r.reason, /5h 90% >= cap 88%/);
  assert.ok(r.samples >= 3, `samples=${r.samples}`);
  assert.ok(r.stopLatencyMs < 1500, `stop latency ${r.stopLatencyMs} ms`);
  assert.ok(Date.now() - t0 < 5000);
  const gc = Number(fs.readFileSync(path.join(dir, 'gc.pid'), 'utf8'));
  await new Promise(res => setTimeout(res, 200));
  assert.equal(alive(gc), false, 'grandchild must be stopped with the group');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a job that finishes under the cap passes its exit code through', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-wd-'));
  const file = path.join(dir, 'usage.txt');
  fs.writeFileSync(file, `${Math.floor(Date.now() / 1000)} 30 10\n`);
  const r = await runWatched(['/bin/sh', '-c', 'exit 7'], { file, intervalMs: 200, nice: 20 });
  assert.equal(r.stoppedByCap, false);
  assert.equal(r.exitCode, 7);
  fs.rmSync(dir, { recursive: true, force: true });
});
