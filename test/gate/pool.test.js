import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { BrowserPool, killPoolTree } from '../../src/browser/pool.js';
import { launchBrowser } from '../../src/browser/launch.js';

const cmd = pid => { try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; } };

test('concurrent launches: every pool reports its own browser pid', async () => {
  const pools = [new BrowserPool(), new BrowserPool(), new BrowserPool()];
  let plain = null;
  try {
    const [, , , p] = await Promise.all([...pools.map(x => x.open({ context: {} })), launchBrowser({ context: {} })]);
    plain = p;
    const pids = pools.map(x => x.pid);
    assert.equal(new Set(pids).size, 3, `distinct pids ${pids}`);
    for (const x of pools) { assert.ok(x.pid > 1); assert.ok(cmd(x.pid).includes(x.marker), 'pid is the pool\'s own browser'); }
  } finally {
    await plain?.close();
    for (const x of pools) await x.close();
  }
  for (const x of pools) assert.equal(x.pid, 0);
});

test('a pool with pid 0 (or 1) kills nothing', async () => {
  const bystander = spawn('/bin/sleep', ['60']);
  try {
    for (const pid of [0, 1, -5, NaN, process.pid]) assert.equal(killPoolTree({ pid, marker: '--x' }), 0);
    assert.equal(killPoolTree({ pid: bystander.pid, marker: '--wr-pool-id=nope' }), 0); // a live pid without our marker
    assert.equal(killPoolTree({ pid: 0 }), 0);
    assert.ok(cmd(bystander.pid).includes('sleep'), 'bystander still alive');
  } finally { bystander.kill('SIGKILL'); }
});

test('recycle waits for open sessions, then relaunches', async () => {
  const pool = new BrowserPool({ maxUses: 2 });
  try {
    const a = await pool.open({ context: {} }), b = await pool.open({ context: {} });
    const first = pool.pid;
    const c = pool.open({ context: {} }); // limit hit while a and b are open: must wait
    await new Promise(r => setTimeout(r, 300));
    assert.equal(pool.launches, 1);
    await a.close(); await b.close();
    const h = await c;
    assert.equal(pool.launches, 2); assert.notEqual(pool.pid, first);
    await h.close();
  } finally { await pool.close(); }
});
