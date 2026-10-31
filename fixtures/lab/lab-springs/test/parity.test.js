// Group B parity proof (design M2-fitter.md 11): for every route x default params x every trace x R2 and R3, record an
// `hx` take on the repo's own launcher (chrome-headless-shell, throwaway profile) and require
// max |rendered - refsim| <= 2 x the channel's read-back floor. Also: the whole parameter grid at R2 on each route's first
// trace, and a determinism pair. Takes and the report go to ~/.reva/out/m2/parity/lab-springs/.
// LAB_PARITY=quick runs three cells only. Sequential: one browser at a time (keeps the machine quiet).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serve, loadJson, routes, recordCell, parity, saveTake, parityDir } from './harness.mjs';

const quick = process.env.LAB_PARITY === 'quick';
const RATES = { 120: 'R3', 60: 'R2' };
const report = { schema: 'reva.labparity/0', group: 'lab-springs', started: new Date().toISOString(), cells: [] };
let srv;
test.before(async () => { srv = await serve(); });
test.after(async () => {
  if (srv) await srv.close();
  report.finished = new Date().toISOString();
  report.summary = { cells: report.cells.length, pass: report.cells.filter(c => c.pass).length, fail: report.cells.filter(c => !c.pass).length };
  fs.mkdirSync(parityDir(), { recursive: true });
  const file = path.join(parityDir(), quick ? 'parity-quick.json' : 'parity.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 1));
  console.log('parity report', JSON.stringify(report.summary), file);
});

async function cell(route, variant, params, traceName, rate, tag) {
  const trace = loadJson(route.traces[traceName]);
  const t0 = Date.now();
  const { take, merged } = await recordCell(srv.origin, route, params, trace, { rate });
  const p = parity(route, merged, take);
  const name = `${route.id}.${variant}.${traceName}.${RATES[rate]}${tag}`;
  const dir = saveTake(take, name);
  const rec = { name, route: route.id, variant, trace: traceName, regime: RATES[rate], params: merged, wallMs: Date.now() - t0, takeDir: dir,
    pageErrors: take.pageErrors, inpageErrors: take.errors, escapes: Object.keys(take.escapes || {}), ...p };
  report.cells.push(rec);
  assert.deepEqual(take.pageErrors, [], name + ' page errors');
  assert.deepEqual(take.errors, [], name + ' in-page errors');
  assert.deepEqual(Object.keys(take.escapes || {}), [], name + ' escapes');
  assert.ok(p.pass, `${name} parity: ${JSON.stringify(p.channels)}`);
  return { take, rec };
}

test('parity: every route x default params x every trace x R2, R3', async (t) => {
  const rs = routes();
  for (const route of rs) for (const v of route.codeVariants) for (const tn of Object.keys(route.traces)) for (const rate of [120, 60]) {
    if (quick && !(route.id === 'm07' && v.id === 'i1h16' && tn === 'p400' || route.id === 'm10' && v.id === 'dt' && tn === 'fast' && rate === 60 || route.id === 'm08' && tn === 'v0' && rate === 60)) continue;
    await t.test(`${route.id}/${v.id}/${tn}/${RATES[rate]}`, async () => { await cell(route, v.id, v.default, tn, rate, ''); });
  }
});

test('parity: whole parameter grid at R2 on each route\'s first trace', { skip: quick }, async (t) => {
  for (const route of routes()) for (const v of route.codeVariants) {
    const tn = Object.keys(route.traces)[0];
    for (let i = 0; i < v.grid.length; i++) {
      if (JSON.stringify(v.grid[i]) === JSON.stringify(v.default)) continue;
      await t.test(`${route.id}/${v.id}/#${i}/${tn}/R2`, async () => { await cell(route, v.id, v.grid[i], tn, 60, `.g${i}`); });
    }
  }
});

test('determinism: the same cell recorded twice gives identical rows (K = 2; the sweep stratum uses K = 5)', { skip: quick }, async () => {
  const dig = (take) => crypto.createHash('sha256').update(JSON.stringify(take.data.rows)).digest('hex');
  for (const [id, variant, tn, rate] of [['m07', 'i1h16', 'p400', 120], ['m10', 'frame', 'fast', 60], ['m08', 'analytic', 'retarget', 60]]) {
    const route = routes().find(r => r.id === id), v = route.codeVariants.find(c => c.id === variant);
    const a = await cell(route, variant, v.default, tn, rate, '.detA'), b = await cell(route, variant, v.default, tn, rate, '.detB');
    const da = dig(a.take), db = dig(b.take);
    report.cells.push({ name: `determinism ${id}/${variant}/${tn}/${RATES[rate]}`, pass: da === db, digestA: da, digestB: db, anchorA: a.rec.anchorIndex, anchorB: b.rec.anchorIndex });
    assert.equal(da, db, 'rows differ between two takes of the same cell');
  }
});
