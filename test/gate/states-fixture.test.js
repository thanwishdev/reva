// Stage D2 acceptance on the own design fixture: every state (CSS forced + JS by real input) passes the G gate at
// the captured point and a held-out point of each class (rebuild in that state, from our JSON, vs the original in that
// state); identity holds; the state-rule coverage lists every state rule as exercised or with a reason; known answers
// (truth.json "states") hold; a corrupted state rule fails its state. Browser test (~6-8 min).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveFixture } from '../helpers.js';
import { fixtureSite, pointsFromTruth } from '../../src/gate/index.js';
import { runStatesSuite, captureBaseTables } from '../../src/gate/states.js';
import { REPO_ROOT } from '../../src/util/paths.js';

test('states pass the gate on the design fixture', { timeout: 1500000 }, async () => {
  const truth = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fixtures/design/truth.json'), 'utf8'));
  const srv = await serveFixture('design');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-d2-'));
  try {
    const site = fixtureSite(srv.origin, truth);
    const points = pointsFromTruth(truth, { perBand: 1 });
    const tables = await captureBaseTables(site, points.filter(p => p.kind === 'captured'), path.join(out, 'base'));
    const S = truth.states;
    const r = await runStatesSuite(site, { points, tables, out, held: S.held, stateMutant: S.mutant, log: () => {} });
    const v = r.verdict;
    const fails = Object.entries(r.states).filter(([, x]) => !x.pass || !x.identity).map(([id, x]) => `${id} ${x.how} ${JSON.stringify(x.oracle.misses.slice(0, 2))} ${x.pixel.reason || ''}`);
    assert.deepEqual(fails, [], 'every state and base point passes, identity holds');
    assert.equal(v.acceptance, true);
    assert.equal(v.archiveMisses, 0);
    assert.equal(v.auditPass, true);
    for (const [cls, c] of Object.entries(r.classes)) {
      // known answers: the CSS states the plan must find (target + pseudo-classes) and the JS states (by kind)
      const css = Object.values(r.states).filter(x => x.state?.startsWith('c') && x.kind === 'captured' && r.classes[cls].points.cap && x === r.states[`${c.points.cap}~${x.state}`]).map(x => x.how);
      for (const want of S.css) assert.ok(css.some(h => h.startsWith(want.pc) && h.endsWith(want.target)), `${cls}: css state ${JSON.stringify(want)} in ${JSON.stringify(css)}`);
      assert.deepEqual(c.plan.js.map(j => j.how).sort(), [...S.js].sort(), `${cls} js states`);
      // newly applying rules per state (rule usage delta) contain the expected state rule
      for (const [sel, how] of Object.entries(S.newRules)) {
        const hit = Object.entries(r.states).some(([id, x]) => id.startsWith(c.points.cap + '~') && x.how.includes(how) && x.rulesNew.some(y => y.sel === sel));
        assert.ok(hit, `${cls}: ${sel} newly applies in the "${how}" state`);
      }
      // coverage: every state rule exercised, except the known dead one
      const cov = JSON.parse(fs.readFileSync(path.join(out, `state-coverage-${cls}.json`), 'utf8'));
      const notEx = cov.rows.filter(x => x.status !== 'exercised');
      assert.deepEqual(notEx.map(x => x.sel).sort(), Object.keys(S.unreachable).sort(), `${cls} not exercised: ${JSON.stringify(notEx)}`);
      for (const x of notEx) assert.match(x.reason, new RegExp(S.unreachable[x.sel]));
      assert.ok(c.identity.all.pass === c.identity.all.points);
      // JS-state candidates (D2b): the listener-only swatch is found from its click listener and exercised; the
      // selected tab's click listener is the tab component already represented by the ARIA candidate; every
      // candidate not exercised carries a reason
      const jc = cov.jsCandidates;
      assert.ok(jc.list.some(x => x.source === 'listener' && x.status === 'exercised' && x.how === 'listener:click' && /Swatch/.test(x.label)), JSON.stringify(jc.list));
      assert.ok(jc.list.some(x => x.source === 'listener' && /same component as the tab candidate/.test(x.reason || '')), JSON.stringify(jc.list));
      assert.ok(jc.list.filter(x => x.status !== 'exercised').every(x => x.reason));
    }
    // the toast popover is replayed into the top layer of every rebuild; the feed re-render is replayed structurally
    // (entered once per rebuild session: later points find it already open, so the call is idempotent there)
    for (const [cls, c] of Object.entries(r.classes)) assert.ok(r.states[c.points.cap].prepared?.topLayer?.entered === 1, `${cls} toast entered the top layer in the rebuild`);
    assert.ok(r.states[`${S.held.T}`].prepared?.html >= 1, 'feed markup replayed at the held-out T point');
    assert.ok(r.stateMutant.killed && r.stateMutant.basePass, JSON.stringify(r.stateMutant));
  } finally { await srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
