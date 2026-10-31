// Group D static checks (no browser): route table, blindness, forbidden values, server refusals, refsim and truth sanity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LAB_ROOT, allowed } from '../serve.mjs';
import { DEFAULTS, parseParams, encodeParams, decodeParams, mulberry32, cubicBezier, springConsts, springI1, springI7, project, CAM, expoOut } from '../core.js';
import { simulate, ROUTE_IDS } from '../refsim.mjs';
import { truth, planCtx, ROUTES, REGIME_DT, frameT } from '../truth.mjs';
import { BANNED, bannedSkip } from '../../banned-values.mjs';

const rd = (p) => fs.readFileSync(path.join(LAB_ROOT, p), 'utf8');
const EXPECT_CELLS = { m13: 15, m14: 15, m14b: 5, m16a: 5, m16b: 5, m16c: 5, m16d: 5, m20: 3, m21: 10, m22: 10 };

test('route table matches the pre-registered cell counts (DECISIONS A1.4 group D: 78 cells)', () => {
  assert.deepEqual(Object.fromEntries(ROUTES.map((r) => [r.id, r.params.grid.length * Object.keys(r.traces).length])), EXPECT_CELLS);
  assert.equal(Object.values(EXPECT_CELLS).reduce((a, b) => a + b, 0), 78);
  for (const r of ROUTES) {
    assert.deepEqual(r.params.default, r.params.grid[0], `${r.id} default is grid[0]`);
    assert.ok(r.params.grid.length === (r.id === 'm20' ? 1 : 5), `${r.id} grid size`);
    assert.ok(fs.existsSync(path.join(LAB_ROOT, r.page)), `${r.id} page`);
    assert.ok(fs.existsSync(path.join(LAB_ROOT, r.page.replace('.html', '.js'))), `${r.id} script`);
    for (const f of Object.values(r.traces)) assert.ok(fs.existsSync(path.join(LAB_ROOT, f)), f);
    assert.ok(ROUTE_IDS.includes(r.id), `${r.id} has a refsim`);
  }
});

test('traces: start signal first, first input at >= 400 ms, holds on the 100 ms grid, pointer marks pair with evals', () => {
  for (const r of ROUTES) for (const f of Object.values(r.traces)) {
    const t = JSON.parse(rd(f));
    assert.deepEqual(t.viewport, { width: 1280, height: 800 });
    assert.ok('eval' in t.actions[0] && /'go'/.test(t.actions[0].eval), `${f} starts with go`);
    assert.deepEqual(t.actions[1], { mark: 'go' });
    assert.deepEqual(t.actions[2], { hold: 400 }, `${f} 400 ms boot hold before the first input`);
    for (const a of t.actions) if ('hold' in a) assert.equal(a.hold % 100, 0, `${f} hold ${a.hold}`);
    const evals = t.actions.filter((a) => 'eval' in a && /pointermove/.test(a.eval)).length;
    const marks = t.actions.filter((a) => 'mark' in a && /^ptr:/.test(a.mark)).length;
    assert.equal(evals, marks, `${f}: one ptr mark per pointer eval`);
    for (const a of t.actions) if ('eval' in a && /pointermove/.test(a.eval)) assert.ok(+/clientX: (\d+)/.exec(a.eval)[1] < 1000, 'pointer x < 1000 (6-digit matrix serialisation)');
  }
});

test('blind pages: no truth hooks, no driver attribute, no mechanism names in markup, hash-only params', () => {
  const bad = /__WR_TRUTH__|__WR_PROBE|__GROUND_TRUTH__|data-wr-driver|\?truth=/;
  const mech = /ease|spring|ema\b|lerp|damp|tween|inertia|friction|smooth|follow|latch|lenis|jitter|ramp|stagger|composite|orbit|camera/i;
  for (const r of ROUTES) {
    const html = rd(r.page), js = rd(r.page.replace('.html', '.js'));
    assert.ok(!bad.test(html) && !bad.test(js), `${r.id} leaks`);
    const ids = [...html.matchAll(/\b(?:id|class)="([^"]*)"/g)].map((m) => m[1]).join(' ');
    assert.ok(!mech.test(ids), `${r.id} ids/classes: ${ids}`);
    assert.ok(!mech.test(/<title>(.*?)<\/title>/.exec(html)[1]), `${r.id} title`);
    assert.ok(!/data-/.test(html), `${r.id} data attributes`);
    assert.match(js, /parseParams\('/);
    assert.ok(!/from '\.\.\/(truth|refsim)/.test(js), `${r.id} imports lab-side code`);
  }
  assert.ok(!bad.test(rd('core.js')));
});

test('blind server: serves routes and core.js only', () => {
  for (const p of ['/core.js', '/routes/m13.html', '/routes/m13.js']) assert.ok(allowed(p), p);
  for (const p of ['/truth.mjs', '/refsim.mjs', '/routes.json', '/traces/m13.steps.json', '/truth/m13.json', '/pixel-channel.js', '/serve.mjs', '/test/static.test.js', '/routes/../truth.mjs', '/tools/harness.mjs', '/']) assert.ok(!allowed(p), p);
});

test('own parameters only: no value from a captured site in any default or grid (design §11)', { skip: bannedSkip }, () => {
  const { alpha, spring, durationsMs, beziers } = BANNED;
  const vecs = [...Object.entries(DEFAULTS).map(([id, p]) => [id, p]), ...ROUTES.flatMap((r) => r.params.grid.map((p) => [r.id, parseParams(r.id, p)]))];
  for (const [id, p] of vecs) {
    if ('alpha' in p) assert.ok(!alpha.includes(p.alpha), `${id} alpha ${p.alpha}`);
    if ('k' in p) assert.notEqual(p.k, spring.k);
    if ('c' in p) assert.notEqual(p.c, spring.c);
    for (const key of ['durMs', 'tweenMs']) if (key in p) assert.ok(!durationsMs.includes(p[key]), `${id} ${key}`);
    if (p.ease) assert.ok(!beziers.some((b) => b.every((v, i) => v === p.ease[i])), `${id} ease`);
  }
});

test('core: params round trip, mulberry32, bezier, springs, projection', () => {
  const o = { a: 1.5, s: 'é', arr: [1, 2] };
  assert.deepEqual(decodeParams(encodeParams(o)), o);
  assert.deepEqual(parseParams('m13', '#p=' + encodeParams({ alpha: 0.5 })), { ...DEFAULTS.m13, alpha: 0.5 });
  const a = mulberry32(7), b = mulberry32(7);
  const xs = Array.from({ length: 1000 }, a);
  assert.deepEqual(xs, Array.from({ length: 1000 }, b));
  assert.ok(xs.every((v) => v >= 0 && v < 1) && Math.abs(xs.reduce((s, v) => s + v, 0) / 1000 - 0.5) < 0.05);
  const ease = cubicBezier(0.25, 0.1, 0.25, 1);
  assert.ok(Math.abs(ease(0.5) - 0.8024033) < 1e-5, `CSS ease(0.5) = ${ease(0.5)}`);   // published value of the CSS "ease" keyword
  assert.equal(ease(0), 0); assert.equal(ease(1), 1);
  assert.equal(expoOut(1), 1); assert.ok(Math.abs(expoOut(0.5) - (1 - 2 ** -5)) < 1e-15);
  // small-step I1 converges to the analytic underdamped spring; I7 at 1 ms too
  const sp = springConsts(0.45, 0.8), s1 = { x: 0, v: 0 }, s7 = { x: 0, v: 0 };
  for (let i = 0; i < 1000; i++) { springI1(s1, 1, sp.k, sp.c, 1, 0.25); springI7(s7, 1, sp.k, sp.c, 1, 100); }
  const wd = sp.omega * Math.sqrt(1 - 0.45 ** 2), t = 1, an = 1 - Math.exp(-0.45 * sp.omega * t) * (Math.cos(wd * t) + (0.45 * sp.omega / wd) * Math.sin(wd * t));
  assert.ok(Math.abs(s1.x - an) < 2e-3 && Math.abs(s7.x - an) < 2e-3, `${s1.x} ${s7.x} ${an}`);
  // both markers stay inside the canvas for a camera angle sweep covering every trace and a 10 s orbit
  for (let ang = 0; ang < 5.2; ang += 0.01) for (const m of Object.values(CAM.markers)) {
    const p = project(m.pos, ang);
    assert.ok(p.depth > 1 && p.x > 20 && p.x < CAM.W - 20 && p.y > 20 && p.y < CAM.H - 20, `marker out of frame at angle ${ang}: ${JSON.stringify(p)}`);
  }
});

test('regime grid: R5 inserts a 100 ms frame every 30 frames', () => {
  assert.equal(frameT(30, 'R2') - frameT(29, 'R2') - REGIME_DT.R2 < 1e-6, true);
  assert.ok(Math.abs(frameT(30, 'R5') - frameT(29, 'R5') - 100) < 1e-5);
  assert.ok(Math.abs(frameT(60, 'R5') - (60 * REGIME_DT.R5 + 2 * (100 - REGIME_DT.R5))) < 1e-5);
});

for (const route of ROUTES) {
  test(`refsim ${route.id}: finite series on the planned trace, every grid vector, R2 and R3`, () => {
    for (const regime of ['R2', 'R3']) for (const variant of Object.keys(route.traces)) {
      const ctx = planCtx(route.id, variant, regime);
      for (const params of route.params.grid) {
        const { channels } = simulate(route.id, params, ctx);
        assert.ok(Object.keys(channels).length >= 1);
        for (const [key, s] of Object.entries(channels)) {
          assert.equal(s.length, ctx.frames.length, key);
          assert.ok(s.every((v) => v === null || Number.isFinite(v)), `${route.id} ${key} has a non-finite value`);
        }
      }
    }
  });
  test(`truth ${route.id}: schema, items, JSON-safe for every grid vector and regime`, () => {
    for (const regime of ['R2', 'R3', 'R4', 'R5']) for (const variant of Object.keys(route.traces)) for (const params of route.params.grid) {
      const t = truth(route.id, params, regime, { variant });
      assert.equal(t.schema, 'reva.labtruth/0');
      assert.ok(t.items.length >= 1 && t.metrics.length >= 1);
      assert.deepEqual(JSON.parse(JSON.stringify(t)), t, 'JSON round trip');
      for (const it of t.items) assert.ok(it.target && it.class, JSON.stringify(it));
    }
  });
}

test('refsim behaviours: settle value, delayed step, ramp slope, observer and timers', () => {
  // M13: ends exactly on the last pointer position; per-frame alpha constant, dt-aware alpha follows dt
  for (const regime of ['R2', 'R3']) {
    const ctx = planCtx('m13', 'steps', regime);
    const x = simulate('m13', { law: 'frame', alpha: 0.1 }, ctx).channels['.b0|drv:--x'];
    assert.equal(x.at(-1), 200);
    const t = truth('m13', { law: 'dt', lambda: 6 }, regime);
    assert.ok(Math.abs(t.items[0].params.alpha_per_frame - (1 - Math.exp(-6 * REGIME_DT[regime] / 1000))) < 1e-15);
    assert.equal(t.items[0].law, 'dt-aware');
  }
  // M16d: the output changes exactly two frames after the input frame (one frame later than an undelayed map)
  const c = planCtx('m16d', 'steps', 'R2');
  const out = simulate('m16d', {}, c).channels['.b0|drv:--x'];
  const inp = c.inputs[0], i0 = c.frames.findIndex((f) => f.k === inp.k);
  assert.equal(out[i0 + 1], 0); assert.equal(out[i0 + 2], DEFAULTS.m16d.amp);
  // M16c: constant speed, then rest at target
  const c2 = planCtx('m16c', 'steps', 'R3'), r = simulate('m16c', {}, c2).channels['.b0|drv:--x'];
  const dxs = r.slice(1).map((v, i) => v - r[i]).filter((d) => d > 0);
  const perFrame = (DEFAULTS.m16c.speed * REGIME_DT.R3) / 1000;
  assert.ok(dxs.filter((d) => Math.abs(d - perFrame) < 1e-5).length > 50);
  assert.equal(Math.max(...r), 400 * DEFAULTS.m16c.gain);
  // M20: spring retarget and tick times from the start signal, observer events at the scroll inputs
  const c3 = planCtx('m20', 'steps', 'R3'), s3 = simulate('m20', {}, c3);
  assert.deepEqual(s3.events.filter((e) => e.type === 'retarget').slice(0, 2).map((e) => e.T), [1000, 2000]);
  assert.deepEqual(s3.events.filter((e) => e.type === 'tick').slice(0, 2).map((e) => e.T), [1350, 2350]);
  assert.deepEqual(s3.events.filter((e) => e.type === 'observer').map((e) => e.inView), [true, false, true, false]);
  // M20 idle control: nothing scroll- or observer-driven writes
  const c4 = planCtx('m20', 'idle', 'R3'), s4 = simulate('m20', {}, c4).channels;
  assert.ok(s4['.e0|drv:--q'].filter((v) => v !== null).every((v) => v === 0) && s4['.e3|drv:--z'].filter((v) => v !== null).every((v) => v === 0));
});

test('truth/*.json on disk are current (regenerate with node tools/gen-truth.mjs)', async () => {
  const { buildTruthFile } = await import('../tools/gen-truth.mjs');
  for (const r of ROUTES) assert.equal(rd(`truth/${r.id}.json`), JSON.stringify(buildTruthFile(r), null, 1) + '\n', `truth/${r.id}.json is stale`);
});
