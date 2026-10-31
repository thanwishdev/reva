// Stage G acceptance on the own design fixture (fixtures/design): identical replay passes; the T6 computed-style
// dump passes at the captured points and fails at held-out points; source audit passes; >= 19/20 mutants killed.
// Browser test (~2-3 min). Outputs go to a temp dir outside the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveFixture } from '../helpers.js';
import { runGateSuite, fixtureSite, pointsFromTruth } from '../../src/gate/index.js';
import { REPO_ROOT } from '../../src/util/paths.js';

test('gate acceptance on the design fixture', { timeout: 900000 }, async () => {
  const truth = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fixtures/design/truth.json'), 'utf8'));
  const srv = await serveFixture('design');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-gate-'));
  try {
    const points = pointsFromTruth(truth, { perBand: 1 });
    const r = await runGateSuite(fixtureSite(srv.origin, truth), { points, out, mutants: 20, log: () => {} });
    const v = r.verdict;
    assert.deepEqual(v.archiveMisses, { orig1: 0, orig2: 0, orig3: 0, orig4: 0 });
    assert.equal(r.noise.oraclePass, true, 'element oracle is exact across identical replays');
    assert.equal(v.identityPass, true, 'identical replay passes');
    assert.equal(v.t6CapturedPass, true, 'T6 dump passes at captured points');
    assert.equal(v.t6HeldoutFailCount, r.t6.summary.heldout.points, 'T6 dump fails at every held-out point');
    assert.equal(v.auditPass, true, JSON.stringify(r.audit));
    assert.ok(r.mutants.made === 20 && r.mutants.killed >= 19, v.mutantsKilled);
    assert.equal(v.acceptance, true);
  } finally { await srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
