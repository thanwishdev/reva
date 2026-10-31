// Parity proof (design section 11): every route renders in the browser and its refsim matches what the browser read back.
// Default: one trace per route at R2 and R3 (about 1.5 min). LAB_PARITY=full: every trace; LAB_PARITY=grid: also every grid point.
// Takes and the report go to the private output root (D-M0-5), never into the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { runParity, recordCell } from '../parity.mjs';
import { serveGroup } from '../serve.mjs';
import { privateRoot } from '../../../../src/util/paths.js';
import { routes } from './helpers.js';

const mode = process.env.LAB_PARITY || 'quick';
const outDir = path.join(privateRoot(), 'out', 'm2', 'parity', 'lab-scroll-test');

test(`parity (${mode}): refsim equals the rendered channels within 2 x the read-back floor`, { timeout: 40 * 60 * 1000 }, async () => {
  const quick = mode === 'quick';
  const report = await runParity({
    variants: quick ? ['gap', 'plain'] : undefined, regimes: ['R2', 'R3'], grid: mode === 'grid' ? 'all' : 'default', outDir, log: (l) => console.log(l),
  });
  const bad = report.results.filter(r => !r.ok);
  assert.equal(bad.length, 0, 'failing cells: ' + bad.map(b => `${b.route}.${b.variant}.${b.regime}`).join(', '));
  for (const r of report.results) {
    assert.deepEqual(r.pageErrors, [], `${r.route} page errors`);
    assert.deepEqual(r.escapes, [], `${r.route} escapes (nothing in the lab may be unsteppable)`);
    assert.ok(Object.keys(r.channels).length >= 4, `${r.route} compared channels`);
    for (const [name, c] of Object.entries(r.channels)) assert.ok(c.n > 50, `${r.route} ${name} compared ${c.n} rows`);
  }
  const expected = routes().routes.length * 2;
  assert.ok(report.cells >= (quick ? expected : expected * 3), `cells ${report.cells}`);
});

test('a lab take shows no mechanism name or parameter name in its element descriptors and channel names', { timeout: 120000 }, async () => {
  const srv = await serveGroup();
  try {
    const raw = await recordCell({ routeId: 'm02', params: { alpha: 0.18 }, variant: 'gap', regime: 'R3', origin: srv.origin, outDir, write: false });
    const surface = JSON.stringify([raw.els, raw.watch, Object.keys(raw.data.rows[raw.data.rows.length - 1].v).map(id => Object.keys(raw.data.rows[raw.data.rows.length - 1].v[id]))]);
    for (const word of ['m02', 'alpha', 'ema', 'smooth', 'ease', 'lerp', 'snap', 'write', 'b0', 'b1']) {
      assert.ok(!new RegExp(word, 'i').test(surface.replace(/translate|opacity|bbox/gi, '')), `"${word}" visible in descriptors/channels: ${surface.slice(0, 300)}`);
    }
  } finally { await srv.close(); }
});

test('determinism: two hx takes of the same cell have identical rows (K = 2 spot check)', { timeout: 240000 }, async () => {
  const srv = await serveGroup();
  try {
    const digests = [];
    for (const [routeId, params, variant] of [['m02', { alpha: 0.25 }, 'reversal'], ['m09', { lerp: 0.1 }, 'reversal'], ['m05', { dur: 540 }, 'retarget']]) {
      const ds = [];
      for (let i = 0; i < 2; i++) {
        const raw = await recordCell({ routeId, params, variant, regime: 'R2', origin: srv.origin, outDir, write: false });
        const boot = raw.marks.find(m => m.name === 'boot-done').k;
        ds.push(crypto.createHash('sha256').update(JSON.stringify(raw.data.rows.filter(r => r.k > boot))).digest('hex'));
      }
      assert.equal(ds[0], ds[1], `${routeId} rows differ between two takes`);
      digests.push([routeId, ds[0].slice(0, 12)]);
    }
    console.log('determinism', JSON.stringify(digests));
  } finally { await srv.close(); }
});
