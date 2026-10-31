// Group D parity proof (design M2-fitter.md §11): for every route x default params x every trace x R2 and R3, record an
// `hx` take with the repo's own launcher (chrome-headless-shell, SwiftShader for canvases, throwaway profile) and
// require max |rendered - refsim| <= 2 x the channel's read-back floor. Also proves each fixture renders (it moves,
// it draws, no page errors, no recorder escapes), that canvas routes leave the DOM static, that M22's transitions are
// declared with the page's parameters, and that a repeated take is bit-identical.
// Set LAB_PARITY=quick to run only the first trace of each route at R3. Reports: ~/.reva/out/m2/parity/lab-webgl/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer } from '../serve.mjs';
import { routesJson, recordCell, parity, observed, ctxFromTake, blindLeaks, PIXEL_FLOOR_PX } from '../tools/harness.mjs';
import { simulate } from '../refsim.mjs';
import { outRoot } from '../../../../src/util/paths.js';

const quick = process.env.LAB_PARITY === 'quick';
const OUT = path.join(outRoot(), 'm2', 'parity', 'lab-webgl');
fs.mkdirSync(OUT, { recursive: true });
const ROUTES = routesJson();
const distinct = (a) => new Set(a.filter((v) => v != null)).size;

/** Per-route evidence that the fixture renders: [channel key, minimum number of distinct values after the start]. */
const MOVES = {
  m13: [['.b0|ren:tx', 20], ['.b0|ren:ty', 20]], m14: [['pix:m:x', 50], ['pix:n:y', 50]], m14b: [['pix:m:x', 50], ['pix:n:y', 50]],
  m16a: [['.b0|ren:tx', 1]], m16b: [['.b0|ren:tx', 50]], m16c: [['.b0|ren:tx', 20]], m16d: [['.b0|ren:tx', 2]],
  m20: [['.e0|ren:tx', 5], ['.e1|ren:tx', 20], ['.e2|ren:opacity', 2], ['.e3|ren:tx', 20]], m21: [['.b0|ren:tx', 20]], m22: [['.b0|ren:tx', 20]],
};

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { if (srv) await srv.close(); });

for (const route of ROUTES) {
  const variants = quick ? [Object.keys(route.traces)[0]] : Object.keys(route.traces);
  for (const variant of variants) for (const rate of quick ? [120] : [120, 60]) {
    test(`${route.id} ${variant} @${rate} Hz: renders, parity with refsim`, { timeout: 180000 }, async () => {
      const params = route.params.default;
      const take = await recordCell({ route, params, variant, rate, server: srv });
      const p = parity(take, route.id, params);
      fs.writeFileSync(path.join(OUT, `test.${route.id}.${variant}.r${rate}.json`), JSON.stringify({ params, pass: p.pass, channels: p.channels }, null, 1));
      for (const [k, r] of Object.entries(p.channels)) assert.ok(r.pass, `${route.id}/${variant}/${rate} ${k}: max ${r.maxAbs} > limit ${r.limit} (missing ${r.missing}) first ${JSON.stringify(r.firstBad)}`);
      // the fixture renders and behaves
      assert.deepEqual(take.pageErrors, [], 'page errors');
      assert.deepEqual(Object.keys(take.escapes || {}), [], 'recorder escapes');
      assert.deepEqual(blindLeaks(take, route, params), [], 'route id / parameter names leak into fitter-visible fields');
      const go = take.marks.find((m) => m.name === 'go');
      assert.ok(go, 'start mark');
      const after = take.data.rows.map((r) => r.k > go.k);
      const moves = route.id === 'm20' && variant === 'idle' ? MOVES.m20.filter(([k]) => k === '.e1|ren:tx' || k === '.e2|ren:opacity') : MOVES[route.id];   // idle control: only the timers write
      for (const [key, min] of moves) {
        const series = observed(take, key).filter((v, i) => after[i]);
        assert.ok(distinct(series) >= min, `${key} has ${distinct(series)} distinct values after the start, wanted >= ${min}`);
      }
      if (route.id === 'm14' || route.id === 'm14b') {
        for (const key of ['m', 'n']) {
          const n = observed(take, `pix:${key}:n`).filter((v, i) => after[i]);
          assert.ok(n.every((v) => v > 150), `marker ${key} is drawn on every frame (min n ${Math.min(...n)})`);
        }
        // DOM sampling has nothing to say: every watched DOM channel is constant after the start
        const id = take.els.findIndex((d) => d && d.includes('cv'));
        const rows = take.data.rows.filter((r, i) => after[i]);
        for (const ch of Object.keys(rows[0].v[id])) assert.equal(distinct(rows.map((r) => JSON.stringify(r.v[id][ch]))), 1, `DOM channel ${ch} is static`);
        if (route.id === 'm14') {
          const u = observed(take, 'gl:u_a').filter((v, i) => after[i]);
          assert.ok(u.length === rows.length && distinct(u) >= (route.params.default.mode === 'orbit' ? 100 : 50), 'camera uniform tapped on every frame');
        }
        const sim = simulate(route.id, params, ctxFromTake(take)).channels;
        let mx = 0; for (const key of Object.keys(sim).filter((k) => k.startsWith('pix:'))) observed(take, key).forEach((v, i) => { if (after[i] && v != null) mx = Math.max(mx, Math.abs(v - sim[key][i])); });
        assert.ok(mx <= PIXEL_FLOOR_PX, `pixel centroid error ${mx} > measured floor ${PIXEL_FLOOR_PX}`);
      }
      if (route.id === 'm22') {
        const b = take.data.births.filter((x) => x.type === 'CSSTransition');
        assert.ok(b.length >= 10, `transitions declared (${b.length})`);
        assert.ok(b.every((x) => x.duration === params.durMs), 'declared duration');
        assert.ok(b.every((x) => x.easing === `cubic-bezier(${params.ease.join(', ')})`), `declared easing ${b[0] && b[0].easing}`);
      }
      if (route.id === 'm20' && variant === 'idle') {
        assert.equal(distinct(observed(take, '.e0|drv:--q').filter((v, i) => after[i])), 1, 'idle control: scroll-driven writer silent');
      }
    });
  }
}

const digest = (take) => crypto.createHash('sha256').update(JSON.stringify(take.data.rows)).digest('hex');
for (const [id, variant] of [['m14', 'steps'], ['m22', 'steps'], ['m16b', 'steps']]) {
  test(`${id} ${variant}: a repeated take is bit-identical (K = 2, one session apart)`, { timeout: 180000 }, async () => {
    const route = ROUTES.find((r) => r.id === id);
    const a = await recordCell({ route, params: route.params.default, variant, rate: 120, server: srv });
    const b = await recordCell({ route, params: route.params.default, variant, rate: 120, server: srv });
    assert.equal(a.data.rows.length, b.data.rows.length);
    assert.equal(digest(a), digest(b), `${id} rows differ between two takes`);
  });
}
