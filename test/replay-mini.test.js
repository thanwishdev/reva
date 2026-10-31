// Public-safe replay test on our OWN fixture: record a HAR from a local server, stop the server, replay offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../src/browser/launch.js';
import { wireReplay } from '../src/replay/replay.js';
import { OFFLINE_ARGS } from '../src/replay/target.js';
import { serveFixture } from './helpers.js';

test('offline replay of a recorded HAR: 0 misses; an unrecorded URL is logged as a miss', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-mini-'));
  const har = path.join(dir, 'mini.har.zip');
  const srv = await serveFixture('mini-site');
  const origin = srv.origin;
  let h;
  try {
    h = await launchBrowser({ engine: 'chs', context: { recordHar: { path: har }, viewport: { width: 600, height: 400 } } });
    await h.page.goto(origin + '/', { waitUntil: 'load' });
    await h.page.waitForFunction(() => document.getElementById('title').dataset.ready === '1');
  } finally { if (h) await h.close(); }
  await srv.close(); // from here on the network is gone
  assert.ok(fs.existsSync(har), 'HAR written');

  async function replay(url) {
    let h2;
    try {
      h2 = await launchBrowser({ engine: 'chs', args: OFFLINE_ARGS, context: { viewport: { width: 600, height: 400 } } });
      const net = await wireReplay(h2.context, [har]);
      await h2.page.goto(url, { waitUntil: 'load' });
      await h2.page.waitForTimeout(300);
      const state = await h2.page.evaluate(() => ({ ready: document.getElementById('title').dataset.ready, imgOk: document.getElementById('pic').naturalWidth > 0, anims: document.getAnimations().length }));
      return { net, state };
    } finally { if (h2) await h2.close(); }
  }

  const ok = await replay(origin + '/');
  assert.deepEqual(ok.net.misses, [], 'zero misses on the recorded page');
  assert.equal(ok.state.ready, '1');
  assert.equal(ok.state.imgOk, true);
  assert.ok(ok.state.anims >= 1, 'CSS animation runs from the replayed stylesheet');

  const bad = await replay(origin + '/#miss');
  assert.equal(bad.net.misses.length, 1, 'the unrecorded fetch must be logged');
  assert.match(bad.net.misses[0], /not-recorded\.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});
