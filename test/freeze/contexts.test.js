// S11 (26 Oct): a shared browser (BrowserPool, one per round / per motion class, a fresh context per class / take) must
// give each session exactly the browser flags and context options its own launch would get. Pure: launch and pool are
// fakes that record what they are asked for; no browser starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openRecordBrowser, recordOpenOptions, contextOptions } from '../../src/freeze/record.js';
import { openVerifyBrowser, verifyOpenOptions } from '../../src/freeze/verify.js';
import { recordArgs } from '../../src/freeze/config.js';
import { assertPoolFits } from '../../src/browser/pool.js';
import { sessionArgs, sessionContext, sessionHandle } from '../../src/record/session.js';
import { OFFLINE_ARGS } from '../../src/replay/target.js';

const cfg = {
  startUrl: 'https://example.test/', locale: 'th-TH', timezone: 'Asia/Bangkok', hostRules: 'MAP cdn.example.test 127.0.0.1',
  classes: { A: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, E: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
};
const fakeLaunch = (calls) => async (o) => { calls.push(o); return { pooled: false, page: { bringToFront: async () => {} } }; };
const fakePool = (args, engine, calls, toolkit) => ({ args, engineId: engine, toolkitId: toolkit, open: async (o) => { calls.push(o); return { pooled: true, page: { bringToFront: async () => {} } }; } });

test('freeze recording: per-class context options and flags are the same through the pool and through a launch', async () => {
  for (const cls of ['A', 'E']) {
    const harPath = `/tmp/x/${cls}.har.zip`;
    const L = [], Pc = [];
    await openRecordBrowser(cfg, cls, { harPath, engine: 'cft', launch: fakeLaunch(L) });
    await openRecordBrowser(cfg, cls, { harPath, engine: 'cft', pool: fakePool(recordArgs(cfg), 'cft', Pc), launch: () => assert.fail('pool path launched a browser') });
    assert.deepEqual(Pc[0].context, L[0].context, cls);
    assert.deepEqual(L[0].args, recordArgs(cfg));
    assert.deepEqual(L[0].context, { ...contextOptions(cfg, cls), recordHar: { path: harPath, content: 'attach', mode: 'full' } });
    assert.deepEqual(recordOpenOptions(cfg, cls, harPath), { args: L[0].args, context: L[0].context });
  }
  // a pool started with other flags or another engine is refused, never used
  await assert.rejects(openRecordBrowser(cfg, 'A', { harPath: '/tmp/a', engine: 'cft', pool: fakePool([], 'cft', []) }), /pool args/);
  await assert.rejects(openRecordBrowser(cfg, 'A', { harPath: '/tmp/a', engine: 'cft', pool: fakePool(recordArgs(cfg), 'chs', []) }), /pool engine/);
});

test('freeze replay check: same per-class options through the pool and through a launch', async () => {
  for (const cls of ['A', 'E']) {
    const L = [], Pc = [];
    await openVerifyBrowser(cfg, cls, { engine: 'cft', launch: fakeLaunch(L) });
    await openVerifyBrowser(cfg, cls, { engine: 'cft', pool: fakePool(OFFLINE_ARGS, 'cft', Pc), launch: () => assert.fail('launched') });
    assert.deepEqual(Pc[0].context, L[0].context);
    assert.deepEqual(L[0].context, contextOptions(cfg, cls));
    assert.deepEqual(L[0].args, OFFLINE_ARGS);
    assert.deepEqual(verifyOpenOptions(cfg, cls), { args: OFFLINE_ARGS, context: L[0].context });
  }
  await assert.rejects(openVerifyBrowser(cfg, 'A', { engine: 'cft', pool: fakePool(recordArgs(cfg), 'cft', []) }), /pool args/);
});

test('motion session: the pool path is opt-in and gets the same context options and flags', async () => {
  const target = { classes: cfg.classes, locale: 'th-TH', timezone: 'Asia/Bangkok' };
  for (const cls of ['A', 'E']) {
    const o = { lane: 'hx', target, cls };
    const args = sessionArgs(o), ctxOpts = sessionContext(o);
    assert.deepEqual(args, OFFLINE_ARGS);
    assert.deepEqual(ctxOpts, { ...cfg.classes[cls], reducedMotion: 'no-preference', locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
    const L = [], Pc = [];
    const h1 = await sessionHandle(o, { engine: 'cft', args, ctxOpts, launch: fakeLaunch(L) }); // no o.pool: the look path
    assert.equal(h1.pooled, false); assert.equal(L.length, 1);
    assert.deepEqual(L[0], { engine: 'cft', toolkit: undefined, args, context: ctxOpts, prefs: undefined });
    const h2 = await sessionHandle({ ...o, pool: fakePool(args, 'cft', Pc) }, { engine: 'cft', args, ctxOpts, launch: () => assert.fail('launched') });
    assert.equal(h2.pooled, true); assert.deepEqual(Pc[0].context, L[0].context);
  }
  // flags fixed at the pool's launch must equal the session's (keepalive / timer flag / live change them)
  const o = { lane: 'hx', keepalive: true };
  await assert.rejects(sessionHandle({ ...o, pool: fakePool(OFFLINE_ARGS, 'cft', []) }, { engine: 'cft', args: sessionArgs(o), ctxOpts: sessionContext(o) }), /pool args/);
  await assert.rejects(sessionHandle({ lane: 'hx', prefs: { a: 1 }, pool: fakePool(OFFLINE_ARGS, 'cft', []) }, { engine: 'cft', args: OFFLINE_ARGS, ctxOpts: {} }), /prefs/);
  assert.throws(() => assertPoolFits(fakePool(OFFLINE_ARGS, 'cft', [], 't155'), { args: OFFLINE_ARGS, engine: 'cft' }), /toolkit/);
});
