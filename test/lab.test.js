// M2 integration (design §12 X5): blind lab server, registered protocol plan (A1.4–A1.6), sweep-size reductions,
// router page, group adapters (contract reva.labgroup/0), the fitter's blind view on a lab-shaped take. No browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { serveLab, isServed, LAB_ROOT } from '../src/lab/server.js';
import { loadAdapters, plan, reduce, rowsDigest, DRAW_SEED, DRAW_SEED_A1, DRAW_SEED_A2, DROP_TRACE_A1 } from '../src/lab/runner.js';
import { routerHtml } from '../src/lab/router.js';
import { blindView } from '../src/analysis/fit/blind.js';

test('blind lab server: pages and page modules only; truth, refsim, routes, traces, tools, tests, adapters refused', async () => {
  const srv = await serveLab();
  try {
    const get = async (p) => (await fetch(srv.origin + p)).status;
    for (const p of ['/index.html', '/lab-easing/routes/m06.html', '/lab-easing/routes/m06.js', '/lab-easing/core.js', '/lab-easing/pagekit.js', '/lab-scroll/vendor/lenis.mjs', '/lab-springs/routes/page.js', '/lab-webgl/routes/m14.html'])
      assert.equal(await get(p), 200, p);
    for (const p of ['/lab-easing/truth.mjs', '/lab-easing/refsim.mjs', '/lab-easing/routes.json', '/lab-easing/traces/m06.go.json', '/lab-easing/truth/m06.json', '/lab-easing/lab.mjs',
      '/lab-easing/tools/harness.mjs', '/lab-easing/test/core.test.js', '/lab-easing/README.md', '/lab-springs/cell.mjs', '/lab-scroll/plan.mjs', '/lab-scroll/parity.mjs', '/lab-webgl/pixel-channel.js',
      '/lab-webgl/serve.mjs', '/lab-easing/routes/../truth.mjs', '/%2e%2e/package.json', '/../package.json'])
      assert.equal(await get(p), 404, p);
  } finally { await srv.close(); }
  assert.equal(isServed('lab-easing/routes/x.html'), true);
  assert.equal(isServed('lab-easing/x.mjs'), false);
});

test('registered protocol: 324 cells, 86-cell determinism stratum, 34 seeded confirmation draws (A1.4–A1.6)', async () => {
  const A = await loadAdapters(); const p = plan(A);
  const per = {}; for (const c of p.cells) per[c.group] = (per[c.group] || 0) + 1;
  assert.deepEqual(per, { 'lab-easing': 70, 'lab-springs': 76, 'lab-scroll': 100, 'lab-webgl': 78 });
  assert.equal(p.stratum.length, 86); assert.equal(p.draws.length, 34);
  assert.equal(new Set(p.cells.map((c) => c.key)).size, 324, 'cell keys are unique');
  assert.ok(!p.draws.some((d) => ['m07x', 'm16a', 'm16b', 'm16c', 'm16d', 'm20'].includes(d.route)), 'A1.6 i exclusions');
  const again = plan(await loadAdapters()); assert.deepEqual(again.draws.map((d) => d.params), p.draws.map((d) => d.params), 'draws are seeded (mulberry32 ' + DRAW_SEED + ' + index)');
  // reductions r1+r2+r3 (D-M2-5): 217 cells, stratum 71, 1,714 runs (attempts 1–2)
  const q = reduce(p, A, ['r1', 'r2', 'r3'], { dropTrace: DROP_TRACE_A1 });
  const det = q.stratum.length * Object.values(q.K).reduce((a, k) => a + k - 1, 0);
  assert.equal(q.cells.length, 217); assert.equal(q.stratum.length, 71); assert.equal(q.cells.length * 4 + p.draws.length * 4 + det, 1714);
  // Amendment 2 C1: the dense traces stay (speed for M01/M02/M04, sweep for M11): 229 cells, stratum 75, 1,802 runs
  const q2 = reduce(p, A, ['r1', 'r2', 'r3']);
  const det2 = q2.stratum.length * Object.values(q2.K).reduce((a, k) => a + k - 1, 0);
  assert.equal(q2.cells.length, 229); assert.equal(q2.stratum.length, 75); assert.equal(q2.cells.length * 4 + p.draws.length * 4 + det2, 1802);
  for (const [r, v] of [['m01', 'speed'], ['m02', 'speed'], ['m04', 'speed'], ['m11', 'sweep']]) assert.ok(q2.cells.some((c) => c.route === r && c.variant === v), `A2-C1 keeps ${r} ${v}`);
  // Amendment 2 C4 + owner decision W10: fresh draws (seed 20261017 + index), neither the attempt-2 nor the attempt-3 set
  const pA1 = plan(A, { drawSeed: DRAW_SEED_A1 }); const pA2 = plan(A, { drawSeed: DRAW_SEED_A2 }); assert.equal(DRAW_SEED, 20261017); assert.equal(DRAW_SEED_A2, 20261016);
  assert.notDeepEqual(pA1.draws.map((d) => d.params), p.draws.map((d) => d.params)); assert.notDeepEqual(pA2.draws.map((d) => d.params), p.draws.map((d) => d.params));
  assert.equal(pA2.draws.length, p.draws.length);
  for (const r of ['m07', 'm07x', 'm08', 'm16a', 'm16e', 'm20']) assert.equal(q.cells.filter((c) => c.route === r).length, p.cells.filter((c) => c.route === r).length, `${r} is protected`);
});

test('adapters: every cell has a session spec on a served page and parameters only in the hash', async () => {
  const A = await loadAdapters(); const p = plan(A);
  for (const c of [...p.stratum, ...p.draws]) {
    const a = A.find((x) => x.name === c.group); const s = a.sessionSpec(c);
    assert.ok(isServed(s.page), `${c.key}: ${s.page}`); assert.match(s.hash, /^#p=[A-Za-z0-9_-]+$/);
    assert.ok(fs.existsSync(path.join(LAB_ROOT, s.page)), s.page); assert.ok(Array.isArray(s.actions) && s.actions.length, c.key);
  }
});

test('router page is current and lists every route page', () => {
  const html = routerHtml(); assert.equal(fs.readFileSync(path.join(LAB_ROOT, 'index.html'), 'utf8'), html, 'run: node src/lab/router.js --write');
  for (const m of html.matchAll(/href="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(LAB_ROOT, m[1])), m[1]);
});

test('determinism digest ignores the boot length; blind view drops URL, docUrl, scenario and mark labels', () => {
  const rows = (k0) => [{ k: k0, T: k0 * 10, sy: 0, sx: 0, v: {} }, { k: k0 + 1, T: (k0 + 1) * 10, sy: 0, sx: 0, v: { 0: { 'ren:tx': 1 } } }];
  const a = { marks: [{ name: 'boot-done', k: 4, T: 40 }], data: { rows: rows(4) } }, b = { marks: [{ name: 'boot-done', k: 8, T: 80 }], data: { rows: rows(8) } };
  assert.equal(rowsDigest(a), rowsDigest(b));
  const v = blindView({ take: { env: { docUrl: 'http://x/lab-easing/routes/m06.html#p=abc', scenario: 'm06.go', dtMs: { value: 8.3, provenance: 'declared' } }, marks: [{ name: 'go', k: 3, T: 1 }], net: { url: 'http://x/m06' } }, data: { rows: [], elements: ['DIV#b0.b'] } });
  const s = JSON.stringify(v); assert.ok(!s.includes('m06') && !s.includes('#p=') && !s.includes('"go"'), s);
});
