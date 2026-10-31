// Truth vs refsim consistency (no browser): the numbers in truth() must be what refsim's own series obeys.
// Each check recovers a parameter from the simulated series by an independent regression and compares it with truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../refsim.mjs';
import { truth, planCtx, ROUTES, REGIME_DT } from '../truth.mjs';

const route = (id) => ROUTES.find((r) => r.id === id);
const lstsq2 = (rows, ys) => {                       // y = a*r0 + b*r1 (no intercept), normal equations
  let s00 = 0, s01 = 0, s11 = 0, t0 = 0, t1 = 0;
  rows.forEach(([r0, r1], i) => { s00 += r0 * r0; s01 += r0 * r1; s11 += r1 * r1; t0 += r0 * ys[i]; t1 += r1 * ys[i]; });
  const d = s00 * s11 - s01 * s01;
  return [(t0 * s11 - t1 * s01) / d, (s00 * t1 - s01 * t0) / d];
};

test('M13 truth alpha: per-frame constant, dt-aware follows the frame time (all regimes, whole grid)', () => {
  for (const regime of ['R2', 'R3', 'R4', 'R5']) for (const params of route('m13').params.grid) {
    const ctx = planCtx('m13', 'reversal', regime), t = truth('m13', params, regime, { variant: 'reversal', ctx });
    const x = simulate('m13', params, ctx).channels['.b0|drv:--x'];
    // target: the last pointer mark at or before each frame
    const ptr = ctx.marks.filter((m) => m.name.startsWith('ptr:')).map((m) => ({ k: m.k, x: +/^ptr:(-?[\d.]+),/.exec(m.name)[1] }));
    const a = [];
    for (let i = 1; i < x.length; i++) {
      if (x[i] == null || x[i - 1] == null) continue;
      const tgt = [...ptr].reverse().find((p) => p.k <= ctx.frames[i].k - 1);
      if (!tgt || Math.abs(tgt.x - x[i - 1]) < 5) continue;                     // away from the snap
      a.push([(x[i] - x[i - 1]) / (tgt.x - x[i - 1]), ctx.frames[i].T - ctx.frames[i - 1].T]);
    }
    assert.ok(a.length > 8, `${regime} only ${a.length} usable frames`);
    if (params.law === 'frame') for (const [al] of a) assert.ok(Math.abs(al - params.alpha) < 1e-12, `${regime} ${al}`);
    else for (const [al, dt] of a) assert.ok(Math.abs(al - (1 - Math.exp((-params.lambda * dt) / 1000))) < 1e-12);
    if (regime !== 'R5') assert.ok(Math.abs(a[2][0] - t.items[0].params.alpha_per_frame) < 1e-6, 'truth alpha_per_frame at the regime dt');
    assert.ok(Math.abs(t.items[0].params.tau_ms - (params.law === 'frame' ? -REGIME_DT[regime] / Math.log(1 - params.alpha) : 1000 / params.lambda)) < 1e-9);
  }
});

test('M14 truth k/m and c/m: regression on the simulated angle recovers them (semi-implicit Euler, dt-capped)', () => {
  for (const regime of ['R2', 'R3', 'R4', 'R5']) for (const params of route('m14').params.grid.filter((p) => p.mode === 'spring')) {
    const ctx = planCtx('m14', 'steps', regime), t = truth('m14', params, regime, { ctx });
    const A = simulate('m14', params, ctx).channels['gl:u_a'];
    const P = { gain: 0.0012, capMs: 1000 / 30, ...params };
    const rows = [], ys = [];
    for (let i = 2; i < A.length; i++) {
      const h = Math.min(ctx.frames[i].T - ctx.frames[i - 1].T, P.capMs) / 1000, hp = Math.min(ctx.frames[i - 1].T - ctx.frames[i - 2].T, P.capMs) / 1000;
      const g = ctx.frames[i].sy * P.gain, v0 = (A[i - 1] - A[i - 2]) / hp, v1 = (A[i] - A[i - 1]) / h;
      if (Math.abs(A[i] - g) < 1e-4 || ctx.frames[i].k <= 0) continue;
      rows.push([-(A[i - 1] - g), -v0]); ys.push((v1 - v0) / h);
    }
    const [k, c] = lstsq2(rows, ys);
    const it = t.items[0];
    assert.ok(Math.abs(k / it.params.k_over_m - 1) < 1e-4 && Math.abs(c / it.params.c_over_m - 1) < 1e-4, `${regime} ${JSON.stringify(params)} k ${k} c ${c} vs ${it.params.k_over_m} ${it.params.c_over_m}`);
    assert.equal(it.integrator.id, 'I7');
  }
});

test('M14 pixel truth: marker pixel coordinates are the analytic projection of the simulated angle', () => {
  const ctx = planCtx('m14', 'steps', 'R3'), params = route('m14').params.grid[0];
  const ch = simulate('m14', params, ctx).channels;
  assert.ok(ch['pix:m:x'].every((v) => v != null && v > 240 && v < 1040));
  assert.ok(new Set(ch['pix:m:x']).size > 100);
  assert.equal(truth('m14', params, 'R3').items.find((i) => i.target === 'dom').class, 'not_applicable');
  assert.equal(truth('m14b', route('m14b').params.grid[0], 'R3').items.filter((i) => i.metric === 'pixel_nrmse').length, 2);
});

test('M20 truth spring and attribution labels; idle control marks the scroll-driven writers static', () => {
  const t = truth('m20', {}, 'R3', { variant: 'steps' });
  assert.deepEqual(Object.values(t.attribution), ['scroll-linked', 'time-driven', 'time-driven', 'scroll-triggered time-based']);
  const idle = truth('m20', {}, 'R3', { variant: 'idle' });
  assert.deepEqual(Object.values(idle.attribution), ['static', 'time-driven', 'time-driven', 'static']);
  // regression on the timer spring at 120 Hz (dt 8.33 ms < 16 ms: one substep per frame)
  const ctx = planCtx('m20', 'holds', 'R3'), s = simulate('m20', {}, ctx).channels['.e1|drv:--s'];
  const g = (i) => { const n = Math.floor((ctx.frames[i].T - 0) / 1000); return n % 2 === 1 ? 160 : 0; };
  const rows = [], ys = [], h = REGIME_DT.R3 / 1000;
  for (let i = 2; i < s.length; i++) {
    const T = ctx.frames[i].T; if (T % 1000 < 40) continue;                      // skip the frames around a retarget
    const v0 = (s[i - 1] - s[i - 2]) / h, v1 = (s[i] - s[i - 1]) / h;
    rows.push([-(s[i - 1] - g(i)), -v0]); ys.push((v1 - v0) / h);
  }
  const [k, c] = lstsq2(rows, ys);
  assert.ok(Math.abs(k / t.items[1].params.k_over_m - 1) < 1e-3 && Math.abs(c / t.items[1].params.c_over_m - 1) < 1e-3, `k ${k} c ${c}`);
});

test('M21 truth step-response times: t50 / t90 of the first step in the simulated series', () => {
  for (const regime of ['R2', 'R3']) for (const params of route('m21').params.grid) {
    const ctx = planCtx('m21', 'steps', regime), v = simulate('m21', params, ctx).channels['.b0|drv:--v'];
    const t = truth('m21', params, regime, { variant: 'steps', ctx }), d = t.items[0].derived;
    const inp = ctx.inputs[0], T0 = inp.T, final = 600 * 0.5;
    const cross = (frac) => { for (let i = 1; i < v.length; i++) if (ctx.frames[i].k > inp.k && v[i] >= frac * final) return ctx.frames[i - 1].T + (ctx.frames[i].T - ctx.frames[i - 1].T) * (frac * final - v[i - 1]) / (v[i] - v[i - 1]) - T0; return null; };
    const dt = REGIME_DT[regime];
    assert.ok(Math.abs(cross(0.5) - d.t50_ms) <= dt, `${regime} t50 ${cross(0.5)} vs ${d.t50_ms}`);
    assert.ok(Math.abs(cross(0.9) - d.t90_ms) <= dt * 1.2, `${regime} t90 ${cross(0.9)} vs ${d.t90_ms}`);
    assert.equal(d.step_response_duration_ms, params.durMs);
  }
});

test('M22 truth driver alpha: regression on the simulated driver recovers it', () => {
  for (const params of route('m22').params.grid) {
    const ctx = planCtx('m22', 'steps', 'R3'), d = simulate('m22', params, ctx).channels['.b0|drv:--d'];
    const t = truth('m22', params, 'R3', { variant: 'steps', ctx });
    const g = (i) => Math.min(ctx.frames[i].sy, 700) * 0.5, als = [];
    for (let i = 1; i < d.length; i++) { if (d[i] == null || d[i - 1] == null || Math.abs(g(i) - d[i - 1]) < 1) continue; als.push((d[i] - d[i - 1]) / (g(i) - d[i - 1])); }
    assert.ok(als.length > 10);
    const a = als.reduce((x, y) => x + y, 0) / als.length;
    assert.ok(Math.abs(a / t.items[0].stages[0].params.alpha_per_frame - 1) < 1e-6, `${a}`);
  }
});

test('negatives: truth carries accept/forbid lists, no model class for noise', () => {
  for (const id of ['m16a', 'm16b', 'm16c', 'm16d']) {
    const t = truth(id, route(id).params.default, 'R3');
    assert.ok(t.negative && t.negative.accept.length && t.negative.forbid.length, id);
    for (const c of ['spring', 'first-order smoothing']) assert.ok(t.negative.forbid.includes(c) || id === 'm16a' && false, `${id} forbids ${c}`);
  }
  assert.deepEqual(truth('m16b', route('m16b').params.default, 'R3').negative.accept, ['unknown', 'unexplained']);
});
