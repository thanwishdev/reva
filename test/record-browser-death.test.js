// Phase 0 (2 Nov): a browser killed mid-take must end the take in an error within 30 s, never hang.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSession, BrowserDiedError } from '../src/record/session.js';
import { procsUsingProfile } from '../src/browser/procs.js';
import { serveFixture } from './helpers.js';

test('browser killed mid-take: the next step rejects with BrowserDiedError within 30 s', async () => {
  const srv = await serveFixture('scroll-race');
  const s = await openSession({ lane: 'hx', rate: 120, url: srv.origin + '/', viewport: { width: 800, height: 600 }, seed: 1 });
  try {
    await s.goto(); await s.boot({});
    await s.hold(100);
    // only PIDs of OUR throwaway profile are signalled
    const mine = procsUsingProfile(s.h.profile).map(r => r.pid);
    assert.ok(mine.length > 0, 'found our browser processes');
    for (const pid of mine) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    const t0 = Date.now();
    await assert.rejects(async () => { for (let i = 0; i < 200; i++) await s.hold(500); }, e => e instanceof BrowserDiedError || /Target|closed|browser died/i.test(e.message));
    const ms = Date.now() - t0;
    console.log('browser-death', JSON.stringify({ ms }));
    assert.ok(ms < 30000, `ended in ${ms} ms`);
  } finally { await s.close().catch(() => {}); await srv.close?.(); }
});
