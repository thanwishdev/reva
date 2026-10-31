import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveStaticFixture } from '../../../fixtures/static/server.js';
import { runDembrandt, summariseHints, dembrandtEntry, DEMBRANDT_VERSION } from '../dembrandt.js';
import { Ledger } from '../prov.js';

const installed = fs.existsSync(dembrandtEntry());

test('summariseHints: everything is inferred + hint:true; a missing section is unknown with a reason', () => {
  const l = new Ledger();
  const h = summariseHints({ colors: { semantic: { primary: 'rgb(1, 2, 3)' }, palette: [] }, breakpoints: [{ px: '480px' }] }, l);
  assert.equal(h.colors.provenance, 'inferred'); assert.equal(h.colors.hint, true); assert.match(h.colors.from, /32 %|heuristic/);
  assert.equal(h.breakpoints.provenance, 'inferred'); assert.equal(h.breakpoints.hint, true);
  assert.equal(h.motion.provenance, 'unknown'); assert.ok(l.list().some(u => u.id === 'unk_dembrandt_motion'));
});

test('runDembrandt: a missing install is unknown with the install probe, not an exception', async () => {
  const r = await runDembrandt({ url: 'http://localhost:1/', entry: '/nonexistent/dembrandt.js' });
  assert.equal(r.hints.status.provenance, 'unknown'); assert.match(r.hints.status.probe, /npm install/);
});

test('dembrandt subprocess on the fixture: own session over CDP, hints only, headless, exit 0', { skip: installed ? false : 'dembrandt not installed under <data root>/tools' }, async () => {
  const srv = await serveStaticFixture(); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-dem-'));
  try {
    const r = await runDembrandt({ url: srv.origin + '/', engine: 'chs', outDir: out });
    assert.equal(r.exit.code, 0, JSON.stringify(r.hints).slice(0, 300));
    assert.equal(r.hints.tool, `dembrandt@${DEMBRANDT_VERSION}`); assert.equal(r.hints.hint, true);
    for (const k of ['colors', 'breakpoints', 'motion']) { assert.equal(r.hints[k].provenance, 'inferred', k); assert.equal(r.hints[k].hint, true, k); }
    // the heuristic breakpoint list is regex-based and sees only same-origin CSS: it must not be mistaken for the measured table
    const px = r.hints.breakpoints.value.map(x => x.px);
    assert.ok(px.includes('860px') && px.includes('600px'));
    assert.ok(!px.includes('1000px'), 'dembrandt 0.39.2 skips the cross-origin min-width:1000px rule; the measured sweep finds it');
    assert.ok(fs.existsSync(path.join(out, r.hints.raw.file)));
  } finally { await srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
