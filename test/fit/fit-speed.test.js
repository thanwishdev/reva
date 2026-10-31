// L8 (26 Oct, fit speed): the speed-ups in the fit core must be bit-identical to the code they replace. Each fast path
// is compared with the old implementation (kept here or in the module) on seeded random inputs that include the edge
// values (non-finite driver values, −0, repeated offsets, irregular frame times). No browser, no files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSmoother, simulateSmootherGeneric, driverOf } from '../../src/analysis/fit/smoothing.js';
import { lm, jacobian, solve, sse, clamp, mulberry32, meter } from '../../src/analysis/fit/numeric.js';
import { NAMED } from '../../src/analysis/fit/eases.js';

const rnd = mulberry32(20261026);
const series = (n, { holds = true, nan = false } = {}) => {
  const T = []; let t = 0; for (let k = 0; k < n; k++) { t += [8.33, 8.34, 16.67, 8.33][k % 4] + (k % 7 === 0 ? rnd() * 3 : 0); T.push(t); }
  const g = []; let v = 0; for (let k = 0; k < n; k++) { if (!holds || k % 9 === 0) v = Math.round(rnd() * 400) - 100; g.push(nan && k % 13 === 5 ? NaN : k === 3 ? -0 : v); }
  return { T, g };
};

test('simulateSmoother: the per-law loops equal the generic loop bit for bit', () => {
  const E = NAMED['expo.out'].fn;
  const prms = [
    ['none', {}], ['ema', { alpha: 0.137 }], ['asym', { alphaUp: 0.31, alphaDown: 0.07 }], ['dtdamp', { lambda: 11.3 }],
    ['restarted', { L: 420, delay: 3, E }], ['restarted', { L: 90, delay: 0, E: NAMED.easeOutCubic.fn }],
  ];
  let n = 0;
  for (const [law, prm] of prms) for (const snap of [null, 'pre', 'post']) for (const opt of [{}, { holds: false }, { nan: true }]) {
    const { T, g } = series(160, opt); const p = snap ? { ...prm, eps: 0.8, snapMode: snap } : prm;
    for (const y0 of [0, -0, 37.5, NaN]) { assert.deepStrictEqual(simulateSmoother(law, p, g, T, y0), simulateSmootherGeneric(law, p, g, T, y0), `${law} ${snap} ${JSON.stringify(opt)} ${y0}`); n++; }
  }
  // NaN frame intervals (dt-damp factor cache) and an empty series
  const { T, g } = series(40); T[10] = NaN; T[11] = NaN;
  assert.deepStrictEqual(simulateSmoother('dtdamp', { lambda: 4 }, g, T, 1), simulateSmootherGeneric('dtdamp', { lambda: 4 }, g, T, 1));
  assert.deepStrictEqual(simulateSmoother('ema', { alpha: 0.5 }, [], [], 1), simulateSmootherGeneric('ema', { alpha: 0.5 }, [], [], 1));
  assert.ok(n >= 200);
});

test('driverOf: one map evaluation per distinct offset, same values as the per-frame map', () => {
  for (const opt of [{}, { holds: false }, { nan: true }]) {
    const { g: sy } = series(300, opt); sy[7] = 0; sy[8] = -0; sy[9] = undefined;
    const map = (s) => 3 + 0.25 * Math.max(0, Math.min(1, (s - 20) / 180)) ** 2 + (Object.is(s, -0) ? 1 : 0);   // tells −0 from +0
    for (const lag of [0, 1, 2]) {
      let calls = 0; const counted = (s) => { calls++; return map(s); };
      const got = driverOf(counted, sy, lag); const want = sy.map((_, k) => map(sy[Math.max(0, k - lag)]));
      assert.deepStrictEqual(got, want);
      if (opt.holds !== false) assert.ok(calls < sy.length / 3, `${calls} map calls for ${sy.length} frames`);
      assert.deepStrictEqual(driverOf(map, sy, lag), want, 'cached plan');
    }
  }
});

// the lm loop before L8 (jacobian() as an array of rows, then JᵀJ by rows)
function lmOld(rf, p0, o = {}) {
  const n = p0.length; const lo = o.lower || new Array(n).fill(-Infinity), hi = o.upper || new Array(n).fill(Infinity);
  const proj = (p) => p.map((v, i) => clamp(v, lo[i], hi[i]));
  const R = (p) => { const r = rf(p); for (const v of r) if (!Number.isFinite(v)) return null; return r; };
  let p = proj(p0.slice()); let r = R(p); if (!r) return { p, rss: Infinity, iters: 0, ok: false };
  let f = sse(r); let lam = 1e-3; let it = 0;
  for (; it < (o.maxIter || 100); it++) {
    const J = jacobian(rf, p, r, o.scale);
    const A = Array.from({ length: n }, () => new Array(n).fill(0)); const g = new Array(n).fill(0);
    for (let i = 0; i < r.length; i++) { const Ji = J[i]; for (let a = 0; a < n; a++) { g[a] += Ji[a] * r[i]; for (let b = a; b < n; b++) A[a][b] += Ji[a] * Ji[b]; } }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const M = A.map((row, a) => row.map((v, b) => (a === b ? v + lam * Math.max(v, 1e-30) : v)));
      const d = solve(M, g.map((v) => -v));
      if (!d) { lam *= 10; continue; }
      const q = proj(p.map((v, i) => v + d[i])); const rq = R(q);
      const fq = rq ? sse(rq) : Infinity;
      if (fq < f) { const rel = (f - fq) / Math.max(f, 1e-300); p = q; r = rq; f = fq; lam = Math.max(lam / 5, 1e-12); improved = true; if (rel < 1e-12) it = 1e9; break; }
      lam *= 8;
    }
    if (!improved) break;
  }
  return { p, rss: f, r, iters: it, ok: true };
}

test('lm: column-wise Jacobian gives the same iterates, result and evaluation sequence as before', () => {
  const T = Array.from({ length: 120 }, (_, k) => k * 8.33);
  const truth = [12, 0.004, 3.1, 250];
  const model = (p) => T.map((t) => p[0] * Math.exp(-p[1] * t) * Math.cos(p[2] * t / 100) + p[3] * (1 - Math.exp(-t / 300)));
  const y = model(truth).map((v, i) => v + Math.sin(i * 1.7) * 0.05);
  for (const start of [[10, 0.003, 3, 240], [1, 0.01, 2, 100], [30, 0.0001, 4, 500]]) for (const scale of [undefined, [1, 0.001, 1, 10]]) {
    const logs = [[], []]; const mk = (j) => (p) => { logs[j].push(p.join(',')); const m = model(p); return m.map((v, i) => v - y[i]); };
    const opts = { lower: [0, 0, 0, -Infinity], upper: [Infinity, 1, 10, Infinity], maxIter: 40, scale };
    const a = lm(mk(0), start, opts), b = lmOld(mk(1), start, opts);
    assert.deepStrictEqual(a.p, b.p); assert.ok(Object.is(a.rss, b.rss)); assert.equal(a.iters, b.iters); assert.deepStrictEqual(a.r, b.r);
    assert.deepStrictEqual(logs[0], logs[1], 'same evaluation points in the same order (meter charges)');
  }
  assert.equal(meter.hit, null);
});

test('fitMapShape: the corner-pair profile (shape evaluated only inside the range) equals the old loop', async () => {
  const { fitMapShape, MAP_SHAPES } = await import('../../src/analysis/fit/smoothing.js');
  const { clamp01 } = await import('../../src/analysis/oracles.js');
  const old = (S, pairs, gridN) => {   // the profile loop before L8
    const ss = pairs.map((p) => p.s), ys = pairs.map((p) => p.y); const smin = Math.min(...ss), smax = Math.max(...ss); const span = Math.max(1, smax - smin);
    const grid = Array.from({ length: gridN + 1 }, (_, q) => smin - span * 0.25 + (span * 1.5 * q) / gridN); const cands = [...new Set([...ss, ...grid])].sort((x, y) => x - y);
    let best = null;
    for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
      const s0 = cands[i], s1 = cands[j]; let sx = 0, sxx = 0, sy = 0, sxy = 0; const n = ss.length;
      const u = ss.map((s) => S(clamp01((s - s0) / (s1 - s0)))); for (let k = 0; k < n; k++) { sx += u[k]; sxx += u[k] * u[k]; sy += ys[k]; sxy += u[k] * ys[k]; }
      const det = n * sxx - sx * sx; if (Math.abs(det) < 1e-12) continue; const b = (n * sxy - sx * sy) / det, a = (sy - b * sx) / n;
      let e = 0; for (let k = 0; k < n; k++) e += (a + b * u[k] - ys[k]) ** 2; if (!best || e < best.e) best = { e, s0, s1, a, b };
    }
    return best;
  };
  for (const sh of Object.keys(MAP_SHAPES)) for (const gridN of [24, 64]) {
    const pairs = Array.from({ length: 23 }, (_, k) => { const s = k * 37 - 60; return { s, y: 5 + 80 * MAP_SHAPES.easeInOutCubic(clamp01((s - 120) / 400)) + Math.sin(k) * 0.3 }; });
    const got = fitMapShape(sh, pairs, 0.01, { profileOnly: true, gridN });
    assert.deepStrictEqual(got.prof, old(MAP_SHAPES[sh], pairs, gridN), `${sh} grid ${gridN}`);
  }
});

test('integrator simulate: the running target index equals the per-frame search (retargets, time going back, NaN)', async () => {
  const { simulate, HYPOTHESES } = await import('../../src/analysis/fit/integrators.js');
  const { springEval } = await import('../../src/analysis/fit/spring.js');
  const targetAt = (m, t) => { let j = 0; while (j < m.tr.length && t >= m.tr[j]) j++; return m.targets[j]; };
  const old = (h, m, T) => {   // the loop before L8 (discrete hypotheses)
    if (h.kind === 'analytic') { const w = Math.sqrt(Math.max(m.k, 1e-12)); return springEval({ t0: m.t0, x0: m.x0, v0: m.v0, w, z: m.c / (2 * w), targets: m.targets, tr: m.tr }, T); }
    const out = new Array(T.length); let x = m.x0, v = m.v0 / 1000, last = m.t0; let xPrev = m.x0 - m.v0 / 60; const k = m.k / 1e6, c = m.c / 1e3;
    for (let i = 0; i < T.length; i++) {
      const t = T[i]; if (t <= m.t0) { out[i] = m.x0; continue; }
      const g = targetAt(m, t); const dt = t - last; last = t;
      if (h.kind === 'sie-substep') { let o = dt; while (o > 1e-9) { const s = Math.min(o, h.h); v += (-k * (x - g) - c * v) * s; x += v * s; o -= s; } }
      else if (h.kind === 'sie-capped') { const s = Math.min(dt, h.cap); v += (-k * (x - g) - c * v) * s; x += v * s; }
      else if (h.kind === 'rk4') { const a = (xx, vv) => -k * (xx - g) - c * vv; const s = dt; const k1x = v, k1v = a(x, v), k2x = v + 0.5 * s * k1v, k2v = a(x + 0.5 * s * k1x, v + 0.5 * s * k1v); const k3x = v + 0.5 * s * k2v, k3v = a(x + 0.5 * s * k2x, v + 0.5 * s * k2v), k4x = v + s * k3v, k4v = a(x + s * k3x, v + s * k3v); x += (s / 6) * (k1x + 2 * k2x + 2 * k3x + k4x); v += (s / 6) * (k1v + 2 * k2v + 2 * k3v + k4v); }
      else if (h.kind === 'frame-unit-euler') { const u = (Math.min(dt, 1000 / 30) * 60) / 1000; const vel = (x - xPrev) / u; const acc = m.k * (g - x) - m.c * vel; const xn = x + (vel + acc) * u; xPrev = x; x = xn; }
      out[i] = x;
    }
    return out;
  };
  const T = Array.from({ length: 90 }, (_, i) => 100 + i * 16.67); const Tb = T.slice(); Tb[40] = Tb[20]; Tb[41] = NaN; Tb[60] = 50;
  for (const h of HYPOTHESES) for (const TT of [T, Tb]) for (const tr of [[], [400], [400, 700, 900], [400, NaN, 900]]) {
    const m = { k: h.native ? 0.08 : 300, c: h.native ? 0.4 : 20, t0: 120, x0: 0, v0: 50, targets: [100, -20, 60, 10].slice(0, tr.length + 1), tr };
    assert.deepStrictEqual(simulate(h, m, TT), old(h, m, TT), `${h.id} tr ${tr}`);
  }
});

test('springEval: the displacement-only step equals springStep()[0] in every damping regime', async () => {
  const { springStep, springDisp, springEval } = await import('../../src/analysis/fit/spring.js');
  for (const z of [0.05, 0.4, 0.999, 1, 1.000001, 1.3, 4]) for (const w of [3, 20, 80]) for (const tau of [-0.01, 0, 0.004, 0.0167, 0.2, 1.5, NaN]) for (const [d0, v0] of [[10, 0], [-3, 40], [0, 0]])
    assert.ok(Object.is(springDisp(w, z, d0, v0, tau), springStep(w, z, d0, v0, tau)[0]), `w ${w} z ${z} tau ${tau}`);
  const m = { t0: 100, x0: 0, v0: 20, w: 18, z: 0.35, targets: [100, 40], tr: [500] }; const T = Array.from({ length: 80 }, (_, i) => 90 + i * 16.67);
  const ref = T.map((t) => { if (t <= m.t0) return m.x0; const j = t >= 500 ? 1 : 0; const st = j ? (() => { const [d, v] = springStep(m.w, m.z, m.x0 - 100, m.v0, (500 - 100) / 1000); return { t: 500, x: d + 100, v }; })() : { t: 100, x: 0, v: 20 }; return springStep(m.w, m.z, st.x - m.targets[j], st.v, (t - st.t) / 1000)[0] + m.targets[j]; });
  assert.deepStrictEqual(springEval(m, T), ref);
});

test('duplicateMemo: a twin is not reused across a moving drv sibling (declaredRecord composite vs declared)', async () => {
  const { duplicateMemo } = await import('../../src/analysis/fit/index.js');
  const mk = (el, ch, kind, y) => ({ key: `${el}|${ch}`, el, desc: `div#${el}`, ch, kind, y, idx: y.map((_, i) => i), T: y.map((_, i) => i * 16.7) });
  const y = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const a = mk('a', 'ren:x', 'ren', y), b = mk('b', 'ren:x', 'ren', y), c = mk('c', 'ren:x', 'ren', y);
  const P = { view: { env: {}, births: [], declared: [] }, series: [a, mk('a', 'drv:--mx', 'drv', [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]), b, mk('b', 'drv:--mx', 'drv', [5, 5, 5, 5, 5, 5, 5, 5, 5, 5]), c] };
  const nf = { sigma: 0.1 };
  const memo = duplicateMemo(P, { units: 0 });
  const tgt = (s) => ({ el: s.el, desc: s.desc, channel: s.ch, untrusted_content: true });
  memo.store(a, nf, [{ target: tgt(a) }], 1, 1);
  assert.equal(memo.find(b, nf), null, 'b has a static drv sibling, a a moving one: no reuse');
  assert.equal(memo.find(c, nf), null, 'c has no drv sibling, a has a moving one: no reuse');
  memo.store(b, nf, [{ target: tgt(b) }], 1, 1);
  assert.notEqual(memo.find(c, nf), null, 'b and c both have no moving drv sibling: still reused');
});
