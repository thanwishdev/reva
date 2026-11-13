// S14 deep data mode (26 Oct): the capture step's verdict is the pure verdictOf(r, mode). Data mode needs no rebuild,
// never claims acceptance, and is ok only with complete data + a passing noise check; any gap or a noise failure makes it
// partial with the reason. The replays are issued data first in every mode (captureRunPlan). No browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictOf, dataProblems, captureRunPlan } from '../../src/gate/capture.js';

const tables = { A: { elements: 120, rules: 300, vars: 12 }, E: { elements: 100, rules: 300, vars: 12 } };
/** A data-mode capture-gate.json as runCaptureSuite writes it (verify 'data'): no rebuild, audit or mutants. */
const dataGate = (v = {}) => ({ tables, verdict: { verification: 'sampled-out', noiseChecked: true, identityPass: true, captureSessionSame: true, pointsCaptured: '9/9', missingPoints: [], scriptOwnedUndeclared: 0, clockLateMs: 0, installStalled: false, shotSkipped: 0, dumpSkipped: [], unreadableSheets: [], acceptance: null, status: 'sampled-out', ...v } });

test('data mode: ok without any rebuild, verification sampled-out, acceptance never claimed', () => {
  const r = dataGate();
  assert.equal('rebuild' in r, false);
  const res = verdictOf(r, 'data');
  assert.equal(res.status, 'ok');
  assert.equal(res.reason, null);
  assert.equal(res.verify.verification, 'sampled-out');
  assert.equal(res.verify.acceptance, null);
  assert.equal(res.verify.noise, 'orig1 vs orig2');
  assert.deepEqual(res.measured, { elements: 220, rules: 600, vars: 24 });
  // even a capture-session mismatch or undeclared script writes cannot turn data mode into an acceptance claim
  for (const v of [{ captureSessionSame: false }, { scriptOwnedUndeclared: 3 }]) assert.equal(verdictOf(dataGate(v), 'data').verify.acceptance, null);
});

test('data mode: noise failure, stalled clock, skipped shot, unreadable sheet, missing point => partial with the reason', () => {
  const cases = [
    [{ identityPass: false }, /noise check failed/],
    [{ installStalled: true }, /fake-clock install stalled/],
    [{ shotSkipped: 2 }, /skipped: 2 screenshot/],
    [{ unreadableSheets: ['https://cdn.x/a.css'] }, /unreadable sheet/],
    [{ missingPoints: ['A-1440x900'], pointsCaptured: '8/9' }, /1 point\(s\) not captured: A-1440x900/],
  ];
  for (const [v, re] of cases) {
    const res = verdictOf(dataGate(v), 'data');
    assert.equal(res.status, 'partial', JSON.stringify(v));
    assert.match(res.reason, re);
    assert.equal(res.verify.acceptance, null);
  }
  assert.equal(dataProblems(dataGate().verdict).length, 0);
});

test('data mode inner page (no noise replay): ok on complete data, says there was no noise check', () => {
  const res = verdictOf(dataGate({ noiseChecked: false, identityPass: null }), 'data');
  assert.equal(res.status, 'ok');
  assert.match(res.verify.noise, /none \(inner page/);
});

const fullGate = (v = {}, pass = 9) => ({ tables, rebuild: { summary: { all: { pass, points: 9 } }, results: {} }, verdict: { identityPass: true, captureSessionSame: true, auditPass: true, scriptOwnedUndeclared: 0, mutantsKilled: '20/20', acceptance: true, liteAcceptance: true, status: 'pass', clockLateMs: 0, ...v } });

test('full and lite keep their rules; a data-mode gate cannot be judged as full', () => {
  assert.equal(verdictOf(fullGate(), 'full').status, 'ok');
  assert.equal(verdictOf(fullGate(), 'full').verify.verification, 'full');
  assert.equal(verdictOf(fullGate({ acceptance: false }), 'full').status, 'partial');
  assert.equal(verdictOf(fullGate({ liteAcceptance: false }), 'lite').status, 'partial');
  assert.equal(verdictOf(fullGate(), 'lite').verify.verification, 'lite');
  assert.throws(() => verdictOf(dataGate(), 'full'), /cannot be judged/);
});

test('capture-inner in full mode (no mutants by design) is judged by liteAcceptance, never by the 20-mutant rule', () => {
  // before: acceptance (needs >= 20 mutants) on a suite run with mutants 0, so an inner page could never be ok
  const g = fullGate({ acceptance: false, mutantsKilled: '0/0', liteAcceptance: true });
  assert.equal(verdictOf(g, 'full', { mutants: false }).status, 'ok');
  assert.equal(verdictOf(g, 'full', { mutants: false }).verify.verification, 'full');
  assert.equal(verdictOf({ ...g, verdict: { ...g.verdict, liteAcceptance: false } }, 'full', { mutants: false }).status, 'partial');
  assert.equal(verdictOf(g, 'full').status, 'partial', 'home capture keeps the mutant rule');
});

test('captureRunPlan: data first in every mode; data mode = orig1 + cap + cov + one noise replay, no dump, no verification', () => {
  const full = captureRunPlan({ verify: 'full' });
  assert.deepEqual(full.replays, ['orig1', 'cap', 'cov', 'orig2', 'orig3', 'orig4']);
  assert.deepEqual(full.verification, ['rb', 'audit', 'mutants']);
  assert.equal(full.dump, true);
  const lite = captureRunPlan({ verify: 'full', lite: { origs: 2, dump: false } });
  assert.deepEqual(lite.replays, ['orig1', 'cap', 'cov', 'orig2']);
  const data = captureRunPlan({ verify: 'data', lite: null });
  assert.deepEqual(data.replays, ['orig1', 'cap', 'cov', 'orig2']);
  assert.deepEqual(data.verification, []);
  assert.equal(data.dump, false);
  const inner = captureRunPlan({ verify: 'data', lite: { origs: 2 }, noise: false });
  assert.deepEqual(inner.replays, ['orig1', 'cap', 'cov']);
  assert.deepEqual(inner.origs, ['orig1']);
});

test('corpus capture writes no T6 dump (no corpus reader); the full plan keeps it by default', () => {
  assert.equal(captureRunPlan({ verify: 'full' }).dump, true);
  assert.equal(captureRunPlan({ verify: 'full', dump: false }).dump, false);
  assert.deepEqual(captureRunPlan({ verify: 'full', dump: false }).origs, captureRunPlan({ verify: 'full' }).origs);
});
