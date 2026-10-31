// L9-A (27 Oct): the fused fit evaluator must be bit-identical to the path it replaces, and the honest labels (selection
// within the noise of L, unidentified parameters) must follow their rule. No browser, no files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSmoother, simResidFused, mapDriverVals, driverOf, MAP_SHAPES } from '../../src/analysis/fit/smoothing.js';
import { lm, dotsInto, mulberry32, meter } from '../../src/analysis/fit/numeric.js';
import { fitModel } from '../../src/analysis/fit/model.js';
import { select, selectionAmbiguity, labelUnidentified, SELECT_NOISE_L } from '../../src/analysis/fit/select.js';
import { NAMED } from '../../src/analysis/fit/eases.js';
import { clamp01 } from '../../src/analysis/oracles.js';

const rnd = mulberry32(20261027);
const series = (n, { holds = true, nan = false } = {}) => {
  const T = []; let t = 0; for (let k = 0; k < n; k++) { t += [8.33, 8.34, 16.67, 8.33][k % 4] + (k % 7 === 0 ? rnd() * 3 : 0); T.push(t); }
  const sy = []; let v = 0; for (let k = 0; k < n; k++) { if (!holds || k % 9 === 0) v = Math.round(rnd() * 400) - 100; sy.push(nan && k % 13 === 5 ? NaN : k === 3 ? -0 : v); }
  return { T, sy };
};

test('simResidFused: SSE and residuals equal simulateSmoother + residual array + sse, bit for bit', () => {
  const E = NAMED['expo.out'].fn; const S = MAP_SHAPES.smoothstep; const S0 = S(clamp01(0)), S1 = S(clamp01(1));
  const laws = [['none', {}], ['ema', { alpha: 0.137 }], ['asym', { alphaUp: 0.31, alphaDown: 0.07 }], ['dtdamp', { lambda: 11.3 }],
    ['restarted', { L: 420, delay: 3, E }], ['restarted', { L: 90, delay: 0, E: NAMED.easeOutCubic.fn }]];
  let n = 0;
  for (const [law, prm] of laws) for (const snap of [null, 'pre', 'post']) for (const opt of [{}, { holds: false }, { nan: true }]) for (const lag of [0, 2]) {
    const { T, sy } = series(150, opt); const y = T.map((_, k) => 20 * Math.sin(k / 11) + (k % 5 === 0 ? 0.3 : 0));
    const a = 4, b = 60, s0 = -30, den = 250; const map = (sc) => { const v = (sc - s0) / den; return a + b * (v <= 0 ? S0 : v >= 1 ? S1 : S(clamp01(v))); };
    const d = mapDriverVals(S, S0, S1, a, b, s0, den, sy, lag); const g = driverOf(map, sy, lag);
    assert.deepStrictEqual(Array.from(g, (_, k) => d.v[d.at[k]]), g, 'driver values');
    const eps = snap ? 0.8 : undefined; const p = snap ? { ...prm, eps, snapMode: snap } : prm;
    for (const mask of [null, Uint8Array.from(T, (_, k) => (k % 4 === 1 ? 0 : 1))]) for (const y0 of [y[0], -0, NaN]) {
      const m = simulateSmoother(law, p, g, T, y0); const idx = T.map((_, k) => k).filter((k) => !mask || mask[k]);
      const r = idx.map((k) => m[k] - y[k]); let s = 0; for (const v of r) s += v * v;
      assert.ok(Object.is(simResidFused(law, prm, eps, snap || undefined, d.at, d.v, T, y, y0, mask, null), s), `${law} ${snap} ${JSON.stringify(opt)} lag ${lag} y0 ${y0}`);
      const out = new Float64Array(idx.length); assert.equal(simResidFused(law, prm, eps, snap || undefined, d.at, d.v, T, y, y0, mask, out), idx.length);
      assert.deepStrictEqual(Array.from(out), r); n++;
    }
  }
  assert.ok(n >= 400);
});

test('lm into buffers + dotsInto: same iterates, result and evaluation sequence as lm on residual arrays', () => {
  for (const k of [1, 2, 3, 5, 6, 7, 9]) { const m = 37; const x = Float64Array.from({ length: m }, () => rnd() - 0.5); const vecs = Array.from({ length: k }, () => Float64Array.from({ length: m }, () => rnd() * 3));
    const out = new Float64Array(k); dotsInto(x, vecs, k, m, out);
    vecs.forEach((v, q) => { let s = 0; for (let i = 0; i < m; i++) s += x[i] * v[i]; assert.ok(Object.is(out[q], s)); }); }
  const T = Array.from({ length: 120 }, (_, k) => k * 8.33);
  const model = (p) => T.map((t) => p[0] * Math.exp(-p[1] * t) * Math.cos(p[2] * t / 100) + p[3] * (1 - Math.exp(-t / 300)) + p[4] * t / 1000);
  const y = model([12, 0.004, 3.1, 250, 7]).map((v, i) => v + Math.sin(i * 1.7) * 0.05);
  for (const start of [[10, 0.003, 3, 240, 6], [1, 0.01, 2, 100, 0], [30, 0.0001, 4, 500, -3]]) for (const scale of [undefined, [1, 0.001, 1, 10, 1]]) {
    const logs = [[], []]; const rf = (p) => { logs[0].push(p.join(',')); return model(p).map((v, i) => v - y[i]); };
    const into = (p, out) => { logs[1].push(p.join(',')); const mm = model(p); for (let i = 0; i < mm.length; i++) out[i] = mm[i] - y[i]; };
    const opts = { lower: [0, 0, 0, -Infinity, -Infinity], upper: [Infinity, 1, 10, Infinity, Infinity], maxIter: 40, scale };
    const a = lm(rf, start, opts), b = lm(null, start, { ...opts, into, m: y.length });
    assert.deepStrictEqual(b.p, a.p); assert.ok(Object.is(b.rss, a.rss)); assert.equal(b.iters, a.iters); assert.deepStrictEqual(Array.from(b.r), a.r);
    assert.deepStrictEqual(logs[1], logs[0], 'same evaluation points in the same order (meter charges)');
  }
  assert.equal(meter.hit, null);
});

test('fitModel: a fused evaluator (fx) gives the same fit, intervals and meter units as the prediction function', () => {
  const { T, sy } = series(140, { holds: false }); const y = T.map((_, k) => 30 * Math.tanh((k - 50) / 20) + Math.sin(k) * 0.02);
  const S = MAP_SHAPES.linear, S0 = S(0), S1 = S(1); const E = NAMED['expo.out'].fn;
  for (const law of ['ema', 'restarted']) for (const use of [undefined, T.map((_, k) => k % 6 !== 2)]) {
    const spec = law === 'ema' ? [{ name: 'alpha', lo: 1e-4, hi: 1, scale: 0.01 }] : [{ name: 'L', lo: 8, hi: 5000, scale: 10 }, { name: 'delay', lo: 0, hi: 8, scale: 2 }];
    const nm = spec.length; const toPrm = (p) => (law === 'ema' ? { alpha: p[0] } : { L: p[0], delay: p[1], E });
    const den = (p) => Math.max(p[nm + 3], p[nm + 2] + 1e-6) - p[nm + 2] || 1e-9;
    const f = (p) => simulateSmoother(law, toPrm(p), driverOf((sc) => { const v = (sc - p[nm + 2]) / den(p); return p[nm] + p[nm + 1] * (v <= 0 ? S0 : v >= 1 ? S1 : S(clamp01(v))); }, sy, 1), T, y[0]);
    const drv = (p) => mapDriverVals(S, S0, S1, p[nm], p[nm + 1], p[nm + 2], den(p), sy, 1);
    const fx = { sse: (p, yv, mask) => { const d = drv(p); return simResidFused(law, toPrm(p), undefined, undefined, d.at, d.v, T, yv, y[0], mask, null); },
      resid: (p, yv, mask, out) => { const d = drv(p); simResidFused(law, toPrm(p), undefined, undefined, d.at, d.v, T, yv, y[0], mask, out); } };
    const o = { family: law, cls: 'x', T, y, spec: [...spec, { name: 'a', scale: 1 }, { name: 'b', scale: 1 }, { name: 's0', scale: 1 }, { name: 's1', scale: 1 }], f, starts: [[...(law === 'ema' ? [0.2] : [300, 4]), -30, 0.2, -100, 300]], sigma: 0.01, use, nm: law === 'restarted', nmIter: 60, lmIter: 15 };
    const u0 = meter.units; const a = fitModel(o); const u1 = meter.units; const b = fitModel({ ...o, fx }); const u2 = meter.units;
    assert.deepStrictEqual(b.p, a.p); assert.ok(Object.is(b.rss, a.rss)); assert.deepStrictEqual(b.params, a.params); assert.equal(u2 - u1, u1 - u0, 'meter units');
  }
});

const cand = (family, cls, L, k = 2, n = 100) => ({ family, cls, n, k, L, bic: L + k * Math.log(n), rss: 1, rms: 0 });
test('selection within the noise of L: labelled with the runner-up, values unchanged; a clear margin is not', () => {
  // nested rule: the scroll map (simpler) loses to the smoother only by ΔL ≥ 10 → at ΔL = 10.3 the decision is a knife edge
  for (const [dL, edge] of [[10 + SELECT_NOISE_L / 3, true], [10 - SELECT_NOISE_L / 3, true], [10 + 3 * SELECT_NOISE_L, false], [25, false]]) {
    const map = cand('none', 'scroll map', 0, 4), ema = cand('ema', 'first-order smoothing', -dL, 5);
    const sel = select([map, ema], { explainBar: 1 }); const sa = selectionAmbiguity(sel, sel.winner);
    assert.equal(!!sa, edge, `ΔL ${dL}`); if (sa) { assert.equal(sa.ambiguous, true); assert.notEqual(sa.runnerUp.family, sel.winner.family); assert.ok(Number.isFinite(sa.runnerUp.dL)); }
  }
  // same class, two families a hair apart in BIC (dt-damp vs EMA): knife edge; far apart: decided
  for (const [d, edge] of [[0.05, true], [5, false]]) {
    const sel = select([cand('ema+snap', 'first-order smoothing', 0, 3), cand('dtdamp+snap', 'first-order smoothing', d, 3)], { explainBar: 1 });
    assert.equal(!!selectionAmbiguity(sel, sel.winner), edge, `ΔBIC ${d}`);
  }
  // already ambiguous (class unknown): no second label
  const amb = select([cand('ema', 'first-order smoothing', 0), cand('restarted', 'restarted tween', 2)], { explainBar: 1 });
  assert.ok(amb.ambiguity); assert.equal(selectionAmbiguity(amb, amb.winner), null);
});

test('unidentified parameters: corners the samples never reach and ratio params with a half-width ≥ |value|', () => {
  const rec = { model: { map: { s0_provenance: 'unknown', s1_provenance: 'fitted' }, params: {
    mapS0: { value: -175332, provenance: 'fitted', ci95: [-191022, -159641] }, mapS1: { value: 900, provenance: 'fitted', ci95: [899, 901] },
    D: { value: 300, provenance: 'fitted', ci95: [-20, 620] }, omega: { value: 20, provenance: 'fitted', ci95: [19, 21] },
    t0: { value: 0.5, provenance: 'fitted', ci95: [-50, 51] }, zeta: { value: null, provenance: 'unknown', withheld_value: 0.3 } } } };
  const before = JSON.parse(JSON.stringify(rec));
  assert.deepStrictEqual(labelUnidentified(rec).sort(), ['D', 'mapS0']);
  for (const k of ['D', 'mapS0']) { assert.equal(rec.model.params[k].identified, false); assert.ok(rec.model.params[k].unidentified); }
  // values, provenance and intervals unchanged; nothing else touched
  for (const [k, p] of Object.entries(before.model.params)) for (const f of Object.keys(p)) assert.deepStrictEqual(rec.model.params[k][f], p[f], `${k}.${f}`);
  for (const k of ['mapS1', 'omega', 't0', 'zeta']) assert.equal(rec.model.params[k].identified, undefined, k);
});
