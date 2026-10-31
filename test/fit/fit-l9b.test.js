// L9-B (27 Oct): the structured driver search's maths. Forward sensitivities must match finite differences of the exact
// evaluator, variable projection must give the full least-squares (a, b), the search must reach the full solve's optimum,
// and the map-profile cache must not change fitMapShape. No browser, no files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simResidFused, mapDriverVals, MAP_SHAPES, fitMapShape } from '../../src/analysis/fit/smoothing.js';
import { sensPass, driverSens, unpackAcc, projectAcc, driverSearch, lmSens, SHAPE_DERIV, EASE_DERIV, ACC } from '../../src/analysis/fit/drivesearch.js';
import { fitModel } from '../../src/analysis/fit/model.js';
import { mulberry32, lm } from '../../src/analysis/fit/numeric.js';
import { NAMED } from '../../src/analysis/fit/eases.js';

const rnd = mulberry32(20261027);
// a dense sweep with holds at both ends (the corpus scroll take), a NaN offset, uneven frame times
const take = (n = 160) => {
  const T = []; let t = 0; for (let k = 0; k < n; k++) { t += [8.33, 8.34, 16.67][k % 3]; T.push(t); }
  const sy = T.map((_, k) => (k < 20 ? 0 : k < 120 ? (k - 19) * 40 : 4000)); sy[7] = NaN;
  return { T, sy };
};
const planOf = (sy, lag) => { const vals = []; const at = new Int32Array(sy.length); const seen = new Map();
  sy.forEach((_, k) => { const v = sy[Math.max(0, k - lag)]; let j = Number.isNaN(v) ? seen.get('nan') : seen.get(v); if (j === undefined) { j = vals.length; vals.push(v); seen.set(Number.isNaN(v) ? 'nan' : v, j); } at[k] = j; });
  return { at, vals }; };
const prmOf = (law, d, E) => (law === 'ema' ? { alpha: d[0] } : law === 'dtdamp' ? { lambda: d[0] } : law === 'asym' ? { alphaUp: d[0], alphaDown: d[1] } : law === 'restarted' ? { L: d[0], delay: d[1], E } : {});
const NM = { none: 0, ema: 1, dtdamp: 1, asym: 2, restarted: 2 };

test('sensPass: x_k is the exact evaluator\'s, and every derivative matches a finite difference of it', () => {
  const { T, sy } = take(); let checked = 0, skipped = 0;
  const cases = [['none', []], ['ema', [0.21]], ['dtdamp', [23.5]], ['asym', [0.33, 0.08]], ['restarted', [180, 3.1], 'expo.out'], ['restarted', [95, 0.7], 'easeOutQuad'], ['restarted', [260, 5.2], 'easeOutCubic']];
  for (const [law, dyn, en] of cases) for (const shape of ['linear', 'smoothstep', 'easeInOutCubic']) for (const snap of law === 'restarted' || law === 'none' ? [null] : [null, 'pre', 'post']) for (const lag of [0, 1]) for (const masked of [false, true]) {
    const E = en ? NAMED[en].fn : undefined; const Ed = E ? EASE_DERIV.get(E) : undefined; const S = MAP_SHAPES[shape], Sd = SHAPE_DERIV[shape]; const S0 = S(0), S1 = S(1);
    const y = T.map((_, k) => 30 + 15 * Math.tanh((k - 70) / 25) + 0.2 * Math.sin(k)); const pl = planOf(sy, lag);
    const eps = snap ? 0.9 : undefined; const mask = masked ? Uint8Array.from(T, (_, k) => (k % 5 === 2 ? 0 : 1)) : null;
    // corners between sampled offsets (a corner ON an offset is a kink of the map)
    const p = [...dyn, 12, 40, 613.7, 3517.3]; const nm = NM[law]; const m = mask ? mask.reduce((a, b) => a + b, 0) : T.length;
    const run = (q, rows) => { const drv = { v: new Float64Array(pl.vals.length), db: new Float64Array(pl.vals.length), d0: new Float64Array(pl.vals.length), d1: new Float64Array(pl.vals.length) };
      driverSens(S, Sd, S0, S1, q[nm], q[nm + 1], q[nm + 2], q[nm + 3], pl.vals, drv); const acc = new Float64Array(ACC);
      const f = sensPass(law, prmOf(law, q, E), eps, snap || undefined, pl.at, drv, T, y, y[0], mask, acc, true, Ed, rows); return { f, acc, drv }; };
    const rows = { r: new Float64Array(m), J: Array.from({ length: 6 }, () => new Float64Array(m)) };
    const { f, acc, drv } = run(p, rows);
    // the driver and the simulation are the exact evaluator's, bit for bit
    const d = mapDriverVals(S, S0, S1, p[nm], p[nm + 1], p[nm + 2], Math.max(p[nm + 3], p[nm + 2] + 1e-6) - p[nm + 2], sy, lag);
    assert.deepStrictEqual(Array.from(drv.v), Array.from(d.v), 'driver values');
    assert.ok(Object.is(f, simResidFused(law, prmOf(law, p, E), eps, snap || undefined, d.at, d.v, T, y, y[0], mask, null)), `${law} ${shape} ${snap} SSE`);
    // the accumulated normal equations are the sums over the rows
    const sl = [...[0, 1].slice(0, nm), 2, 3, 4, 5]; const A = sl.map(() => new Float64Array(sl.length)), g = new Float64Array(sl.length); unpackAcc(acc, sl, A, g);
    for (let i = 0; i < sl.length; i++) { let s = 0; for (let k = 0; k < m; k++) s += rows.J[sl[i]][k] * rows.r[k]; assert.ok(Math.abs(s - g[i]) <= 1e-9 * (Math.abs(s) + 1), 'Jtr'); }
    // each derivative against a central difference (skipped where two step sizes disagree: a snap, clamp or restart edge)
    for (let i = 0; i < sl.length; i++) {
      const h = 1e-5 * Math.max(Math.abs(p[i]), 1); const fd = (hh) => { const a = p.slice(), b = p.slice(); a[i] += hh; b[i] -= hh; const ra = { r: new Float64Array(m), J: rows.J.map(() => new Float64Array(m)) }, rb = { r: new Float64Array(m), J: rows.J.map(() => new Float64Array(m)) }; run(a, ra); run(b, rb); return Array.from(ra.r, (v, k) => (v - rb.r[k]) / (2 * hh)); };
      const f1 = fd(h), f2 = fd(h / 2);
      for (let k = 0; k < m; k++) {
        const sc = Math.abs(f1[k]) + Math.abs(rows.J[sl[i]][k]) + 1e-4;   // + the rounding floor of a central difference on values ~30
        if (Math.abs(f1[k] - f2[k]) > 1e-4 * sc) { skipped++; continue; }
        assert.ok(Math.abs(rows.J[sl[i]][k] - f2[k]) <= 2e-4 * sc, `${law}/${shape}/${snap}/lag ${lag} d/dp${i} frame ${k}: analytic ${rows.J[sl[i]][k]} fd ${f2[k]}`); checked++;
      }
    }
  }
  assert.ok(checked > 50 * skipped, `checked ${checked}, skipped at kinks ${skipped}`);
});

test('projectAcc: the projected (a, b) are the full least-squares solution and the projected SSE is the exact SSE there', () => {
  const { T, sy } = take(); const pl = planOf(sy, 0); const S = MAP_SHAPES.smoothstep, Sd = SHAPE_DERIV.smoothstep; const E = NAMED['expo.out'].fn;
  for (const [law, dyn] of [['ema', [0.17]], ['dtdamp', [31]], ['none', []], ['restarted', [240, 2]]]) {
    const nm = NM[law]; const y = T.map((_, k) => 5 + 22 * Math.tanh((k - 60) / 30) + 0.1 * Math.cos(k * 1.3));
    const pass = (q) => { const drv = { v: new Float64Array(pl.vals.length), db: new Float64Array(pl.vals.length), d0: new Float64Array(pl.vals.length), d1: new Float64Array(pl.vals.length) };
      driverSens(S, Sd, S(0), S(1), q[nm], q[nm + 1], q[nm + 2], q[nm + 3], pl.vals, drv); const acc = new Float64Array(ACC);
      const f = sensPass(law, prmOf(law, q, E), undefined, undefined, pl.at, drv, T, y, y[0], null, acc, true, EASE_DERIV.get(E));
      const sl = [...[0, 1].slice(0, nm), 2, 3, 4, 5]; const st = { f, g: new Float64Array(sl.length), A: sl.map(() => new Float64Array(sl.length)) }; unpackAcc(acc, sl, st.A, st.g); return st; };
    const p = [...dyn, 3, 9, 500, 3300]; const st = pass(p); const q = p.slice(); projectAcc(q, st, [nm, nm + 1], [nm + 2, nm + 3]);
    // full solve: x = c + a·A + b·B (the law is affine in a, b): three simulations give c, A, B; 2×2 normal equations
    const sim = (a, b) => { const d = mapDriverVals(S, S(0), S(1), a, b, p[nm + 2], p[nm + 3] - p[nm + 2], sy, 0); const out = new Float64Array(T.length); simResidFused(law, prmOf(law, p, E), undefined, undefined, d.at, d.v, T, y, y[0], null, out); return out; };
    const r0 = sim(0, 0), ra = sim(1, 0), rb = sim(0, 1); let saa = 0, sab = 0, sbb = 0, sar = 0, sbr = 0;
    for (let k = 0; k < T.length; k++) { const u = ra[k] - r0[k], w = rb[k] - r0[k]; saa += u * u; sab += u * w; sbb += w * w; sar += u * r0[k]; sbr += w * r0[k]; }
    const det = saa * sbb - sab * sab; const a = -(sbb * sar - sab * sbr) / det, b = -(saa * sbr - sab * sar) / det;
    assert.ok(Math.abs(q[nm] - a) <= 1e-7 * (Math.abs(a) + 1) && Math.abs(q[nm + 1] - b) <= 1e-7 * (Math.abs(b) + 1), `${law}: projected (${q[nm]}, ${q[nm + 1]}) vs full solve (${a}, ${b})`);
    const exact = pass(q).f; assert.ok(Math.abs(st.f - exact) <= 1e-9 * exact, `${law}: projected SSE ${st.f} vs exact ${exact}`);
  }
});

test('lmSens (marquardt) is numeric.js lm step for step: with a forward-difference pass it reproduces lm() bit for bit', () => {
  const { T, sy } = take(150); const pl = planOf(sy, 0); const S = MAP_SHAPES.easeInOutCubic;
  for (const [law, dyn, lo, hi, sc] of [['ema', [0.6], [1e-4], [1], [0.01]], ['dtdamp', [40], [1e-3], [1e4], [1]], ['asym', [0.5, 0.2], [1e-4, 1e-4], [1, 1], [0.01, 0.01]]]) {
    const y = T.map((_, k) => 2 + 18 * Math.tanh((k - 60) / 22) + 0.05 * Math.sin(k * 2.1)); const nm = dyn.length;
    const lower = [...lo, -Infinity, -Infinity, -Infinity, -Infinity], upper = [...hi, Infinity, Infinity, Infinity, Infinity], scale = [...sc, 20, 40, 1, 1];
    const resid = (p, out) => { const d = mapDriverVals(S, S(0), S(1), p[nm], p[nm + 1], p[nm + 2], Math.max(p[nm + 3], p[nm + 2] + 1e-6) - p[nm + 2], sy, 0); simResidFused(law, prmOf(law, p), undefined, undefined, d.at, d.v, T, y, y[0], null, out); };
    const m = T.length, P = nm + 4; const r = new Float64Array(m), cols = Array.from({ length: P }, () => new Float64Array(m));
    const fdPass = (p, st) => {   // lmInto's Jacobian: forward differences, each sum over the rows in order
      resid(p, r); let f = 0; for (let i = 0; i < m; i++) { if (!Number.isFinite(r[i])) return -1; f += r[i] * r[i]; }
      for (let j = 0; j < P; j++) { const h = 1e-7 * Math.max(Math.abs(p[j]), scale[j], 1e-9); const q = Array.from(p); q[j] += h; resid(q, cols[j]); for (let i = 0; i < m; i++) cols[j][i] = (cols[j][i] - r[i]) / h; }
      for (let a = 0; a < P; a++) { let g = 0; for (let i = 0; i < m; i++) g += cols[a][i] * r[i]; st.g[a] = g; for (let b = a; b < P; b++) { let s2 = 0; for (let i = 0; i < m; i++) s2 += cols[a][i] * cols[b][i]; st.A[a][b] = st.A[b][a] = s2; } }
      st.f = f; return f; };
    const p0 = [...dyn, 1, 30, 400, 3000];
    const ref = lm(null, p0, { lower, upper, scale, maxIter: 60, into: (p, out) => resid(p, out), m });
    const mine = lmSens(fdPass, p0, { lower, upper, scale, P, schedule: 'marquardt' });
    assert.deepStrictEqual(mine.p, Array.from(ref.p), law); assert.ok(Object.is(mine.rss, ref.rss), `${law} rss`); if (ref.iters < 1e9) assert.equal(mine.iters, ref.iters);   // lm() reports 1e9 + 1 after its gain stop
  }
});

test('driverSearch reaches the full solve\'s optimum in both modes (EMA and restarted tween on a smoothstep map, noisy samples)', () => {
  const { T, sy } = take(200); const pl = planOf(sy, 1); const S = MAP_SHAPES.smoothstep;
  const truth = { ema: [[0.23], 4, 50, 700, 3100], restarted: [[210, 1.5], 4, 50, 700, 3100] };
  for (const mode of ['jacobian', 'varpro']) for (const law of ['ema', 'restarted']) {
    const [dyn, a, b, s0, s1] = truth[law]; const E = NAMED['expo.out'].fn; const nm = NM[law];
    const d = mapDriverVals(S, S(0), S(1), a, b, s0, s1 - s0, sy, 1); const x = new Float64Array(T.length);
    const yy = T.map(() => 0); simResidFused(law, prmOf(law, dyn, E), undefined, undefined, d.at, d.v, T, yy, 0, null, x);
    const y = Array.from(x, (v) => v + (rnd() - 0.5) * 0.02); y[0] = 0;
    const spec = law === 'ema' ? [{ name: 'alpha', lo: 1e-4, hi: 1, scale: 0.01 }] : [{ name: 'L', lo: 8, hi: 5000, scale: 10 }, { name: 'delay', lo: 0, hi: 8, scale: 2 }];
    const spec2 = [...spec, { name: 'mapA', scale: 4 }, { name: 'mapB', scale: 50 }, { name: 'mapS0', scale: 1 }, { name: 'mapS1', scale: 1 }];
    const fx = { sse: (p, yv, mask) => { const dd = mapDriverVals(S, S(0), S(1), p[nm], p[nm + 1], p[nm + 2], Math.max(p[nm + 3], p[nm + 2] + 1e-6) - p[nm + 2], sy, 1); return simResidFused(law, prmOf(law, p, E), undefined, undefined, dd.at, dd.v, T, yv, y[0], mask, null); },
      resid: (p, yv, mask, out) => { const dd = mapDriverVals(S, S(0), S(1), p[nm], p[nm + 1], p[nm + 2], Math.max(p[nm + 3], p[nm + 2] + 1e-6) - p[nm + 2], sy, 1); simResidFused(law, prmOf(law, p, E), undefined, undefined, dd.at, dd.v, T, yv, y[0], mask, out); } };
    const f = (p) => { const out = new Float64Array(T.length); fx.resid(p, T.map(() => 0), null, out); return Array.from(out); };
    const starts = law === 'ema' ? [[0.5, 3, 45, 650, 3200]] : [[300, 4, 3, 45, 650, 3200], [800, 4, 3, 45, 650, 3200]];
    const base = { family: law, cls: 'x', T, y, spec: spec2, f, fx, starts, sigma: 0.01, nm: law === 'restarted', noCI: true };
    const full = fitModel(base);
    const fast = fitModel({ ...base, search: (ctx) => driverSearch({ mode, law, nm, slots: law === 'ema' ? [0] : [0, 1], toPrm: (p) => prmOf(law, p, E), S, Sd: SHAPE_DERIV.smoothstep, S0: S(0), S1: S(1), plan: pl, T, y, y0: y[0], starts, nmStarts: law === 'restarted', dt: 8.33, sigma: 0.01, Ed: EASE_DERIV.get(E), exactSse: (p, mask) => fx.sse(p, y, mask) }, ctx) });
    assert.ok(fast.rss <= full.rss * (1 + 1e-6), `${mode} ${law}: rss ${fast.rss} vs full ${full.rss}`);
    for (let i = 0; i < nm; i++) assert.ok(Math.abs(fast.p[i] - full.p[i]) <= 2e-3 * Math.abs(full.p[i]) + 1e-3, `${mode} ${law} dyn ${i}: ${fast.p[i]} vs ${full.p[i]}`);
    for (let i = nm + 2; i < nm + 4; i++) assert.ok(Math.abs(fast.p[i] - full.p[i]) <= 1, `${mode} ${law} corner ${i}: ${fast.p[i]} vs ${full.p[i]}`);
  }
});

test('fitMapShape: the shared corner-pair profile (invertedMapSeeds) changes nothing', () => {
  const ss = Array.from({ length: 30 }, (_, k) => k * 37 + (k % 4)); const cache = new Map();
  for (const sh of ['smoothstep', 'easeInOutQuart', 'linear']) for (let r = 0; r < 4; r++) {
    const pairs = ss.map((s) => ({ s, y: 3 + 20 * MAP_SHAPES[sh](Math.min(1, Math.max(0, (s - 150) / 700))) + (rnd() - 0.5) * (r + 0.1) }));
    assert.deepStrictEqual(fitMapShape(sh, pairs, 0.01, { profileOnly: true, gridN: 24, cache }), fitMapShape(sh, pairs, 0.01, { profileOnly: true, gridN: 24 }));
  }
});
