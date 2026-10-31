// Stage D1 acceptance on the own design fixture: the rebuild rendered from the rule table alone passes the gate at
// captured AND held-out points; source audit + provenance pass; >= 19/20 table mutants killed; the coverage report
// lists every state / media / container / pseudo-element rule that never applied. Browser test (~2-3 min).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveFixture } from '../helpers.js';
import { fixtureSite, pointsFromTruth } from '../../src/gate/index.js';
import { runCaptureSuite } from '../../src/gate/capture.js';
import { REPO_ROOT } from '../../src/util/paths.js';

test('rule-table capture passes the gate on the design fixture', { timeout: 900000 }, async () => {
  const truth = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fixtures/design/truth.json'), 'utf8'));
  const srv = await serveFixture('design');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-d1-'));
  try {
    const points = pointsFromTruth(truth, { perBand: 1 });
    const r = await runCaptureSuite(fixtureSite(srv.origin, truth), { points, out, mutants: 20, log: () => {} });
    const v = r.verdict;
    assert.equal(v.identityPass, true);
    assert.equal(v.captureSessionSame, true);
    assert.equal(r.rebuild.summary.captured.pass, r.rebuild.summary.captured.points, 'captured points');
    assert.equal(r.rebuild.summary.heldout.pass, r.rebuild.summary.heldout.points, `held-out points ${JSON.stringify(r.rebuild.summary)}`);
    assert.equal(v.auditPass, true, JSON.stringify(r.audit));
    assert.ok(Object.values(r.audit).every(a => a.provenance === true));
    assert.ok(r.mutants.made === 20 && r.mutants.killed >= 19, v.mutantsKilled);
    assert.deepEqual(r.deferred, []);
    // D2: the toast popover opened by script at load is in the top layer in every class and is put back there in the
    // rebuild by the harness (no `overlay` excuse any more); the feed re-rendered by script below 700 px is given its
    // recorded child-list markup at T-599/T-601 (structural replay) and then compared, not masked
    for (const [cls, tl] of Object.entries(r.topLayer)) assert.ok(tl.some(x => x.how === ':popover-open' && /\/div\[\d+\]$/.test(x.k)), `${cls} toast in top layer ${JSON.stringify(tl)}`);
    assert.ok(Object.values(r.rebuild.results).every(x => !(x.oracle.excusedN > 0)), 'nothing excused');
    assert.ok(['T-599x900', 'T-601x900'].every(id => r.scriptOwned.perPoint[id]?.structureReplayed?.some(x => x.kind === 'html')), JSON.stringify(r.scriptOwned.perPoint['T-601x900']).slice(0, 400));
    // script-owned (D1b): the clock digit and the viewport-height box are found from script writes with evidence and
    // declared by every class's capture; nothing owned lacks evidence
    for (const [cls, d] of Object.entries(r.scriptOwned.declared)) {
      const digit = d.find(x => x.k.endsWith('/div[1]/span[1]') && x.names.style);
      assert.ok(digit && digit.why.includes('time') && /index\.html|\/:\d+:\d+$|localhost/.test(digit.names.style), `${cls} digit ${JSON.stringify(d)}`);
      assert.ok(d.some(x => x.names.style && x.why.includes('viewport') && x !== digit), `${cls} vh box declared`);
    }
    assert.equal(v.scriptOwnedUndeclared, 0, JSON.stringify(r.scriptOwned.undeclared));
    // the digit's and the box's script-set values are replayed at held-out points (then compared, not masked)
    assert.ok(Object.values(r.scriptOwned.perPoint).some(p => p.changed > 0 && p.replayed > 0), JSON.stringify(r.scriptOwned.perPoint).slice(0, 400));
    for (const [, x] of Object.entries(r.rebuild.results)) assert.ok(!x.oracle.owned, 'nothing excluded on the fixture (no script-inserted nodes or text)');
    assert.equal(v.acceptance, true);
    // coverage (class M, 390 px): every rule that could not apply, with its reason
    const cov = JSON.parse(fs.readFileSync(path.join(out, 'coverage-M.json'), 'utf8'));
    const why = Object.fromEntries(cov.unused.map(u => [`${u.sel}|${u.ctx}`, u.why.join(',')]));
    for (const [k, w] of Object.entries({
      ':root|@media (prefers-color-scheme: dark)': 'media-inactive', '.nav-link:hover|': 'state', '.btn:hover|': 'state',
      '.btn:focus-visible|': 'state', '.link:focus|': 'state', '.more[open] summary|': 'state', '.modal::backdrop|': 'pseudo-element',
      '.grid|@media (min-width: 600px)': 'media-inactive', '.grid|@media (min-width: 960px)': 'media-inactive',
      '.card.has-media|@container (min-width: 420px)': 'container', '.fc|@media (min-width: 500px)': 'media-inactive',
    })) assert.equal(why[k], w, k);
    assert.equal(cov.unknownCount, 0);
    assert.deepEqual(cov.transient.map(x => x.sel), ['.site-head.scrolled'], 'scroll class applied during the sweep, not at rest');
    const t = JSON.parse(fs.readFileSync(path.join(out, 'cap', 'table-M.json'), 'utf8'));
    assert.equal(t.usageMap.orphans, 0);
    assert.ok(t.vars.vars['--accent'].usedBy.length >= 5);
  } finally { await srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
