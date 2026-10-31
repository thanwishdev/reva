// S16 (L7): every failing check of a deep gate is labelled tool | site with a reason (src/gate/causes.js). Pure: fixtures
// are cut from stored 22-23 Oct deep gates (test/gate/fixtures/causes-gates.json, `src` names the gate) or built small.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { labelFailures, labelStates, crashCause, diffOrigins, rebuildEvidence, sessionEvidence } from '../../src/gate/causes.js';
import { compareSnapshots } from '../../src/gate/compare.js';

const FX = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'causes-gates.json'), 'utf8'));
const pick = (list, check) => list.filter(c => c.check === check);

// a snapshot in the oracle's in-memory form: pl/vt interned tables, s = flat [propIdx, valueIdx, ...]
function snap(els) {
  const pl = [], vt = [];
  const P = p => { let i = pl.indexOf(p); if (i < 0) { i = pl.length; pl.push(p); } return i; };
  const V = v => { let i = vt.indexOf(v); if (i < 0) { i = vt.length; vt.push(v); } return i; };
  return { vw: 100, vh: 100, docH: 100, pl, vt, els: els.map(([k, b, style = {}, t = '']) => ({ k, b, t, s: Object.entries(style).flatMap(([p, v]) => [P(p), V(v)]) })) };
}

test('identity: canvas-only pixel difference is site, script state difference is tool (stored gates)', () => {
  const site = pick(labelFailures(FX.canvas), 'identity');
  assert.equal(site.length, 1);
  assert.equal(site[0].bucket, 'canvas-pixels');
  assert.equal(site[0].label, 'site');
  assert.match(site[0].reason, /canvas/);
  assert.equal(site[0].evidence.noisePerClass.A, 13350);
  const tool = pick(labelFailures(FX.motion), 'identity');
  assert.equal(tool[0].bucket, 'motion-state');
  assert.equal(tool[0].label, 'tool');
  assert.ok(tool[0].evidence.regions.length > 0);
  // a stalled clock install is the harness's, whatever the regions say
  const stalled = labelFailures({ ...FX.motion, verdict: { ...FX.motion.verdict, installStalled: true, clockLateMs: 1800 } });
  assert.deepEqual(pick(stalled, 'identity').map(c => [c.bucket, c.label]), [['clock-stall', 'tool']]);
});

test('capture-session: follows identity (takes its label) vs a session that alone differs (tool)', () => {
  const g = { ...FX.canvas, verdict: { ...FX.canvas.verdict, captureSessionSame: false } };
  const ev = { 'A-1440x900': { failed: 0, pixelOnly: true, inIdentityUnstable: 0, identityFailedHere: true } };
  const follow = pick(labelFailures(g, { evidence: { session: ev } }), 'capture-session');
  assert.deepEqual(follow.map(c => [c.bucket, c.label]), [['follows-identity', 'site']]);
  const g2 = { ...FX.motion, identity: { fails: {}, unstable: {} }, verdict: { ...FX.motion.verdict, identityPass: true, captureSessionSame: false } };
  const own = pick(labelFailures(g2, { evidence: { session: { 'A-1440x900': { failed: 3, pixelOnly: false, inIdentityUnstable: 0, identityFailedHere: false, sample: ['html/body[1]/div[1]'] } } } }), 'capture-session');
  assert.deepEqual(own.map(c => [c.bucket, c.label]), [['session-state', 'tool']]);
  // sessionEvidence: a captured point whose capture-session snapshot differs inside an identity-unstable region
  const a = snap([['html', [0, 0, 100, 100]], ['html/body[1]', [0, 0, 100, 100]], ['html/body[1]/div[1]', [0, 0, 10, 10], { transform: 'none' }]]);
  const b = snap([['html', [0, 0, 100, 100]], ['html/body[1]', [0, 0, 100, 100]], ['html/body[1]/div[1]', [0, 0, 10, 10], { transform: 'matrix(1, 0, 0, 1, 5, 0)' }]]);
  const se = sessionEvidence({ points: [{ id: 'p', kind: 'captured' }], sameAsOrig1: { p: false }, read: r => (r === 'orig1' ? a : b), unstable: { p: { regions: [{ k: 'html/body[1]/div[1]' }] } } });
  assert.equal(se.p.failed, 1);
  assert.equal(se.p.inIdentityUnstable, 1);
});

test('rebuild: parser re-nesting is a tool root at the captured point; unpaintable is site (stored point)', () => {
  // table: <p><div>a</div></p> (script-built); the HTML parser closes the p, the div becomes its sibling + an empty p
  const T = { docs: [{ url: 'https://x/', tree: { t: 'html', i: 0, c: [{ t: 'body', i: 1, c: [{ t: 'p', i: 2, c: [{ t: 'div', i: 3, c: ['a'] }] }] }] } }], els: [{ k: 'html' }, { k: 'html/body[1]' }, { k: 'html/body[1]/p[1]' }, { k: 'html/body[1]/p[1]/div[1]' }], rules: [], sheets: [] };
  const cap = snap([['html', [0, 0, 100, 100]], ['html/body[1]', [0, 0, 100, 100]], ['html/body[1]/p[1]', [0, 0, 100, 20]], ['html/body[1]/p[1]/div[1]', [0, 0, 100, 20]]]);
  const rb = snap([['html', [0, 0, 100, 100]], ['html/body[1]', [0, 0, 100, 100]], ['html/body[1]/p[1]', [0, 0, 100, 0]], ['html/body[1]/div[1]', [0, 16, 100, 20]], ['html/body[1]/p[2]', [0, 52, 100, 0]]]);
  const o = compareSnapshots(cap, rb, { maxDetail: Infinity });
  assert.equal(o.pass, false);
  const roots = diffOrigins(cap, rb, o.misses, { moves: [{ k: 'html/body[1]/p[1]/div[1]', closes: 'html/body[1]/p[1]', parent: 'html/body[1]', repair: 'inner' }] });
  assert.ok(roots.length > 0 && roots.every(r => r.cat === 'renest'), JSON.stringify(roots));
  const results = { 'A-100x100': { kind: 'captured', pass: false, oracle: { pass: false, failedElements: o.failedElements, byKind: o.byKind }, pixel: { pass: false, reason: 'diffPx 900 > noise cap 0' } } };
  const ev = rebuildEvidence({ points: [{ id: 'A-100x100', cls: 'A', kind: 'captured' }], results, read: r => (r === 'rb' ? rb : cap), tables: { A: T } });
  assert.equal(ev.perPoint['A-100x100'].vs, 'cap');
  assert.equal(ev.moves.A.n, 1);
  const g = { points: [{ id: 'A-100x100', cls: 'A', kind: 'captured' }, { id: FX.unpaintable.id, cls: 'A', kind: 'heldout-band' }], rebuild: { results: { ...results, [FX.unpaintable.id]: FX.unpaintable.result }, evidence: ev }, verdict: { identityPass: true, captureSessionSame: true, allPass: false, auditPass: true, mutantsPass: true, scriptOwnedUndeclared: 0 } };
  const rbC = pick(labelFailures(g), 'rebuild');
  const by = Object.fromEntries(rbC.map(c => [c.bucket, c]));
  assert.equal(by.renest.label, 'tool');
  assert.equal(by.renest.evidence.atCaptured, 1);
  assert.equal(by.unpaintable.label, 'site');
});

test('rebuild: equal to the capture session but not to orig1 follows the replays (takes their label)', () => {
  const s0 = snap([['html', [0, 0, 100, 100]], ['html/body[1]', [0, 0, 100, 100], { opacity: '1' }]]);
  const s1 = snap([['html', [0, 0, 100, 100]], ['html/body[1]', [0, 0, 100, 100], { opacity: '0.5' }]]);
  const results = { p: { kind: 'captured', pass: false, oracle: { pass: false, failedElements: 1 }, pixel: { pass: false } } };
  const ev = rebuildEvidence({ points: [{ id: 'p', cls: 'A', kind: 'captured' }], results, read: r => (r === 'orig1' ? s0 : s1), tables: { A: { docs: [], els: [], rules: [], sheets: [] } } });
  assert.equal(ev.perPoint.p.followsReplay, true);
  const g = { ...FX.canvas, points: [{ id: 'p', cls: 'A', kind: 'captured' }], rebuild: { results, evidence: ev }, verdict: { ...FX.canvas.verdict, allPass: false } };
  const c = pick(labelFailures(g), 'rebuild');
  assert.deepEqual(c.map(x => [x.bucket, x.label]), [['follows-replay', 'site']]);
});

test('rebuild roots: lossy var() shorthand (empty longhands in the table), subpixel-only sizes', () => {
  const T = { docs: [{ tree: { t: 'html', i: 0, c: [] } }], els: [{ k: 'html' }, { k: 'html/body[1]', r: [0] }], rules: [{ t: 'style', d: [['transition-duration', ''], ['transition-property', 'opacity']] }], sheets: [] };
  const a = snap([['html', [0, 0, 100, 100]], ['html/body[1]', [0, 0, 100, 100], { 'transition-duration': '0.6s' }]]);
  const b = snap([['html', [0, 0, 100, 100]], ['html/body[1]', [0, 0, 100, 100], { 'transition-duration': '0.3s' }]]);
  const r1 = diffOrigins(a, b, compareSnapshots(a, b, { maxDetail: Infinity }).misses, { table: T });
  assert.deepEqual(r1.map(x => x.cat), ['lossy-var-shorthand']);
  // an authored empty custom property (`--tw-pan-x: ;`) is not a lost shorthand
  const T2 = { ...T, rules: [{ t: 'style', d: [['--tw-pan-x', '']] }] };
  assert.deepEqual(diffOrigins(a, b, compareSnapshots(a, b, { maxDetail: Infinity }).misses, { table: T2 }).map(x => x.cat), ['transition']);
  const c = snap([['html', [0, 0, 100, 100]], ['html/body[1]', [0, 0, 100, 100]], ['html/body[1]/div[1]', [0, 0, 50.3, 10], { width: '50.3px' }]]);
  const d = snap([['html', [0, 0, 100, 100]], ['html/body[1]', [0, 0, 100, 100]], ['html/body[1]/div[1]', [0, 0, 50.1, 10], { width: '50.1px' }]]);
  assert.deepEqual(diffOrigins(c, d, compareSnapshots(c, d, { maxDetail: Infinity }).misses).map(x => x.cat), ['subpixel']);
});

test('audit and crash are tool, with the mechanism named (stored audit issue, stored crash reasons)', () => {
  const a = pick(labelFailures({ ...FX.canvas, identity: { fails: {}, unstable: {} }, audit: FX.audit.audit, verdict: { ...FX.canvas.verdict, identityPass: true, auditPass: false } }), 'audit');
  assert.deepEqual(a.map(c => [c.bucket, c.label]), [['network', 'tool']]);
  assert.match(a[0].reason, /iframe/);
  const k = r => { const c = crashCause(r); return [c.bucket, c.label]; };
  assert.deepEqual(k({ status: 'failed', reason: 'clock.runFor: TypeError: window.updateNavColorFromSections is not a function' }), ['page-timer-error', 'tool']);
  assert.deepEqual(k({ status: 'failed', reason: 'page.evaluate: Target page, context or browser has been closed' }), ['browser-gone', 'tool']);
  assert.deepEqual(k({ status: 'deferred', reason: 'deferred:stop (STOP file)' }), ['stop-kill', 'tool']);
  assert.deepEqual(k({ status: 'timeout', reason: 'timeout:capture after 2700 s' }), ['wall-timeout', 'tool']);
  // labelFailures takes the step first: a crashed step has no gate
  assert.deepEqual(labelFailures(null, { step: { status: 'failed', reason: 'page.screenshot: Timeout 30000ms exceeded.' } }).map(c => c.bucket), ['screenshot-timeout']);
  assert.deepEqual(labelFailures(null, { step: { status: 'ok' } }), []);
});

test('states: rows failing like their base follow the capture rebuild; a navigating input is site', () => {
  const row = (state, pass, failed, identity = true) => ({ state, pass, identity, how: state ? 'click x' : 'base', oracle: { pass: !failed, failedElements: failed, byKind: failed ? { prop: failed } : {}, misses: [] }, pixel: { pass } });
  const g = { states: { A: row(null, false, 5), 'A~c1': row('c1', false, 5), 'A~c2': row('c2', false, 9), 'A~c3': row('c3', true, 0, false) }, classes: {}, verdict: { states: 3, statePass: 1, base: 1, basePass: 0, auditPass: true, skippedStates: [{ cls: 'A', id: 'j1', reason: 'navigated: page.evaluate: Execution context was destroyed' }] } };
  const capture = [{ check: 'rebuild', bucket: 'renest', label: 'tool', evidence: { points: 4 } }, { check: 'identity', bucket: 'canvas-pixels', label: 'site', evidence: { points: 2 } }];
  const c = labelStates(g, { capture });
  const by = Object.fromEntries(c.map(x => [`${x.check}|${x.bucket}`, x]));
  assert.equal(by['rebuild|follows-base-rebuild'].evidence.states, 1);
  assert.deepEqual(by['rebuild|follows-base-rebuild'].evidence.captureBuckets, ['renest']);
  assert.equal(by['rebuild|state-rebuild'].evidence.states, 1);
  assert.equal(by['identity|state-replays-differ'].label, 'site'); // inherits the capture gate's identity label
  assert.equal(by['skipped|state-navigated'].label, 'site');
});
