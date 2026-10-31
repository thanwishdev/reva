// Parity proof (design section 11): for every route x default params x every trace x the rates the recorder has today
// (R2 = 60 Hz, R3 = 120 Hz), record an hx take, run refsim on the take's frames/inputs/marks and require
// max |rendered - refsim| <= 2 x the channel's read-back floor (bbox channels 1/64 px, driver channels exact), declared
// births equal to the refsim events, and the planned trace (what truth() uses) equal to the take's actual frames/marks.
// Also: the planted-value floor of a registered number property, K-run determinism, and take blindness.
// Reports go to the private output root (D-M0-5): ~/.reva/out/m2/parity/lab-easing/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureOutDir } from '../../../../src/util/paths.js';
import { openSession } from '../../../../src/record/session.js';
import { serveLab, loadRoutes, loadTrace, compareToTake } from '../tools/harness.mjs';
import { parityCell, ctxOf } from '../tools/parity.mjs';
import { planCtx, REGIMES, truth } from '../truth.mjs';
import { truthChannels } from './closed-form.js';
import { simulate } from '../refsim.mjs';
import { recordCell } from '../tools/harness.mjs';

const RATES = (process.env.LAB_PARITY_RATES || (process.env.LAB_PARITY === 'quick' ? '120' : '120,60')).split(',').map(Number);
const REG = { 120: 'R3', 60: 'R2', 30: 'R4' };
const outDir = ensureOutDir('m2', 'parity', 'lab-easing');
// Rows compared for determinism. macOS: every row, as before. Elsewhere: the rows from the boot-done mark on, plus an equal
// boot-done frame. Before that mark the page is still being parsed in real time, so on a slower machine (a CI runner, an
// emulated x64 under load) a boot frame can be sampled before the parser has made the element. Measured 31 Oct 2026 on
// linux-x64 under load: the only row that ever differed was frame k=2 (pre-boot, empty vs filled); boot-done was k=4 in every run.
const bootK = (take) => (take.marks.find((m) => m.name === 'boot-done') || {}).k;
const detRows = (take) => (process.platform === 'darwin' ? take.data.rows : take.data.rows.filter((r) => r.k >= bootK(take)));
const digest = (take) => crypto.createHash('sha256').update(JSON.stringify(detRows(take))).digest('hex');

let srv;
test.before(async () => { srv = await serveLab(); });
test.after(async () => { if (srv) await srv.close(); });

/** Planted-value floor of a registered <number> custom property (the D3 measurement does not cover it). */
async function registeredNumberFloor() {
  const url = 'data:text/html,' + encodeURIComponent('<!doctype html><title>x</title><div id=h></div>');
  const s = await openSession({ lane: 'hx', rate: 120, url, viewport: { width: 400, height: 300 }, seed: 1 });
  try {
    await s.goto(url);
    return await s.ev(() => {
      CSS.registerProperty({ name: '--q', syntax: '<number>', inherits: true, initialValue: '0' });
      const h = document.getElementById('h'), cs = getComputedStyle(h);
      let seed = 12345, mx = 0;
      for (let i = 0; i < 256; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const x = seed / 0x7fffffff; h.style.setProperty('--q', String(x)); mx = Math.max(mx, Math.abs(parseFloat(cs.getPropertyValue('--q')) - x)); }
      return mx;
    });
  } finally { await s.close(); }
}

test('registered number property read-back floor (6 significant digits)', async () => {
  const f = await registeredNumberFloor();
  fs.writeFileSync(path.join(outDir, 'registered-number-floor.json'), JSON.stringify({ maxAbsErr: f, n: 256, range: 1 }) + '\n');
  assert.ok(f > 0 && f <= 5.1e-7, `floor ${f}`);
});

const routes = loadRoutes().routes;
const results = [];
for (const r of routes) {
  for (const variant of Object.keys(r.traces)) {
    for (const rate of RATES) {
      test(`parity ${r.id}.${variant} @${rate} Hz`, { timeout: 180000 }, async () => {
        const res = await parityCell({ origin: srv.origin, route: r.id, params: r.params.default, variant, rate });
        // planned trace == actual take (truth() plans without a take)
        const plan = planCtx(r.id, loadTrace(r.id, variant), REG[rate]);
        const ctx = ctxOf(res.take, variant);
        assert.equal(plan.frames.length, ctx.frames.length, 'planned frame count');
        for (let i = 0; i < plan.frames.length; i++) {
          assert.ok(Math.abs(plan.frames[i].T - ctx.frames[i].T) < 1e-5 && plan.frames[i].k === ctx.frames[i].k && plan.frames[i].sy === ctx.frames[i].sy, `frame ${i}: plan ${JSON.stringify(plan.frames[i])} vs take ${JSON.stringify(ctx.frames[i])}`);
        }
        for (const m of plan.marks) {
          const a = ctx.marks.find((x) => x.name === m.name);
          assert.ok(a && a.k === m.k && Math.abs(a.T - m.T) < 1e-5, `mark ${m.name}: plan ${JSON.stringify(m)} vs take ${JSON.stringify(a)}`);
        }
        for (const i of plan.inputs) {
          const a = ctx.inputs.find((x) => x.type === i.type && x.k === i.k && x.want === i.want);
          assert.ok(a && Math.abs(a.T - i.T) < 1e-5, `input ${JSON.stringify(i)}`);
        }
        results.push({ route: r.id, variant, rate, pass: res.pass, frames: res.frames, worst: res.channels.reduce((m, c) => Math.max(m, c.tol ? c.maxAbs / c.tol : 0), 0), births: res.births.got, channels: res.channels.map((c) => ({ key: c.key, maxAbs: c.maxAbs, floor: c.floor, tol: c.tol, n: c.n })) });
        // truth file vs the browser, through closed forms written from the truth parameters (independent of refsim)
        const tr = truth(r.id, r.params.default, REG[rate], { ctx, variant });
        const tcmp = compareToTake(res.take, truthChannels(tr, res.take.data.rows, res.take.marks));
        results[results.length - 1].truthChannels = tcmp.channels.map((c) => ({ key: c.key, maxAbs: c.maxAbs, tol: c.tol, ok: c.ok }));
        assert.ok(tcmp.channels.length > 0, 'truth has no evaluable channel');
        assert.deepEqual(tcmp.channels.filter((c) => !c.ok), [], 'truth closed form vs rendered');
        const bad = res.channels.filter((c) => !c.ok);
        assert.deepEqual(bad, [], 'channels beyond 2 x floor');
        assert.deepEqual(res.births.mismatches, [], 'declared births');
        assert.deepEqual(res.errors, [], 'page errors');
        assert.ok(res.channels.length > 0);
      });
    }
  }
}

// the `write` knob (full | q3 | q2) is applied in core.js, so refsim and the page quantise identically
for (const write of ['q3', 'q2']) {
  test(`parity m19.timer with write=${write} @120 Hz`, { timeout: 180000 }, async () => {
    const r = routes.find((x) => x.id === 'm19');
    const res = await parityCell({ origin: srv.origin, route: 'm19', params: { ...r.params.default, write }, variant: 'timer', rate: 120 });
    assert.deepEqual(res.channels.filter((c) => !c.ok), []);
    const v = res.take.data.rows.map((row) => Object.values(row.v)[0] && Object.values(row.v)[0]['drv:--v']).filter((x) => x != null);
    const dec = write === 'q3' ? 3 : 2;
    assert.ok(v.every((x) => Math.abs(x * 10 ** dec - Math.round(x * 10 ** dec)) < 1e-6), 'written values are quantised');
  });
}

test('write the parity report', () => {
  fs.writeFileSync(path.join(outDir, 'parity-default.json'), JSON.stringify({ when: new Date().toISOString(), rates: RATES, cells: results.length, passed: results.filter((x) => x.pass).length, results }, null, 1));
  assert.ok(results.every((x) => x.pass));
});

// determinism (D-M2-2 A1.5, here at the default parameters of the riskiest paths): identical series digests
for (const [route, variant, K] of [['m12', 'go', 5], ['m17', 'go', 3], ['m18', 'interrupted', 3], ['m19', 'timer', 3], ['m06', 'go', 3]]) {
  test(`determinism ${route}.${variant}: ${K} runs bit-identical at 120 Hz`, { timeout: 300000 }, async () => {
    const r = routes.find((x) => x.id === route);
    const ds = []; const boots = [];
    for (let i = 0; i < K; i++) { const t = await recordCell({ origin: srv.origin, route, params: r.params.default, variant, rate: 120 }); ds.push(digest(t)); boots.push(bootK(t)); }
    assert.equal(new Set(boots).size, 1, `boot-done frames differ: ${boots}`);
    fs.appendFileSync(path.join(outDir, 'determinism.jsonl'), JSON.stringify({ when: new Date().toISOString(), route, variant, K, digests: ds.map((d) => d.slice(0, 16)) }) + '\n');
    assert.equal(new Set(ds).size, 1, `digests differ: ${ds.map((d) => d.slice(0, 8))}`);
  });
}

test('a recorded take names neither the route nor a mechanism in elements, animation names or targets', async () => {
  const r = routes.find((x) => x.id === 'm06');
  const take = await recordCell({ origin: srv.origin, route: 'm06', params: r.params.default, variant: 'go', rate: 120 });
  const seen = JSON.stringify({ els: take.els, births: take.data.births.map((b) => [b.name, b.tgt, b.type]), watch: take.watch });
  assert.ok(!/m06|spring|tween|stagger|hold|bezier|ease/i.test(seen), seen.slice(0, 300));
});
