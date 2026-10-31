// Group B pure-math tests: the recurrences against closed forms, blindness of the pages, route table consistency.
// Fast (no browser). The browser parity proof is in parity.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TimedSpring, Inertia, analyticAt, encodeParams, paramsFromHash, quantise, INERTIA_STOP, INTEGRATORS, SCHEDULES, pointerEvents, canonical } from '../core.js';
import { nativePoleEquivalent } from '../truth.mjs';
import { loadRoutes, loadTrace, isValid, cellParams, drawParams, ROOT } from '../cell.mjs';
import { BANNED } from '../../banned-values.mjs';

const SETA = { k: 200, c: 12, m: 1, A: 200 };
const run = (params, dtMs, untilMs, g = 200) => {
  const s = new TimedSpring(params, 0); s.retarget(g, 0); const xs = [];
  for (let t = dtMs; t <= untilMs + 1e-9; t += dtMs) xs.push([t, s.frame(dtMs / 1000, t)]);
  return xs;
};
const maxDev = (xs, seg) => Math.max(...xs.map(([t, x]) => Math.abs(x - analyticAt(seg, t / 1000).x)));
const segOf = (P, g = 200) => { const c = canonical(P); return { x0: 0, v0: 0, g, omega: Math.sqrt(c.k / c.m), zeta: c.c / (2 * Math.sqrt(c.k * c.m)) }; };

test('analyticAt: all three damping regimes agree with a fine semi-implicit integration', () => {
  for (const [omega, zeta] of [[14, 0.25], [14, 1.0], [10, 1.5]]) {
    const seg = { x0: 10, v0: -300, g: 150, omega, zeta };
    let x = seg.x0, v = seg.v0; const h = 1e-5; let mx = 0;
    for (let i = 1; i <= 100000; i++) { v += (-omega * omega * (x - seg.g) - 2 * zeta * omega * v) * h; x += v * h; if (i % 1000 === 0) mx = Math.max(mx, Math.abs(x - analyticAt(seg, i * h).x)); }
    assert.ok(mx < 0.02, `zeta ${zeta}: ${mx}`);
  }
});

test('recurrences converge to the closed form: i6 exact, i5 / i1h1 / verlet close, i1h16 visibly different', () => {
  const seg = segOf(SETA);
  const dev = (id) => maxDev(run({ ...SETA, integrator: id }, 1000 / 60, 3000), seg);
  assert.ok(dev('i6') < 1e-9, 'i6 ' + dev('i6'));
  assert.ok(dev('i5') < 0.05, 'i5 ' + dev('i5'));            // RK4 at 60 Hz, fourth order
  assert.ok(dev('verlet') < 1.5, 'verlet ' + dev('verlet')); // second order
  assert.ok(dev('i1h1') < 1.5, 'i1h1 ' + dev('i1h1'));       // 1 ms substeps with remainder
  assert.ok(dev('i1h16') > dev('i1h1'), 'coarse substeps deviate more');
  assert.ok(dev('i1h16') > 3, 'i1h16 must differ from the analytic curve by several px: ' + dev('i1h16'));
});

test('i7 equals one semi-implicit step per frame whenever dt < 1/30 s, and loses time above the cap', () => {
  const a = new TimedSpring({ ...SETA, integrator: 'i7' }, 0), b = new TimedSpring({ ...SETA, integrator: 'i1h16' }, 0);
  a.retarget(200, 0); b.retarget(200, 0);
  for (let i = 0; i < 40; i++) { a.frame(0.0125, 0); b.frame(0.0125, 0); }   // dt 12.5 ms < 16 ms substep: identical single step
  assert.equal(a.x, b.x); assert.equal(a.v, b.v);
  const c = new TimedSpring({ ...SETA, integrator: 'i7' }, 0), d = new TimedSpring({ ...SETA, integrator: 'i7' }, 0);
  c.retarget(200, 0); d.retarget(200, 0); c.frame(0.1, 0); d.frame(1 / 30, 0);
  assert.equal(c.x, d.x, 'a 100 ms frame advances only 1/30 s');
});

test('i4: the native (kf, cf) recurrence has the poles the generator claims (zeta 0.42 / 0.87 / 1.5)', () => {
  const sets = loadRoutes().find(r => r.id === 'm07').codeVariants.find(v => v.id === 'i4').grid;
  const want = [0.42, 0.87, 1.5];
  sets.forEach((p, i) => {
    const eq = nativePoleEquivalent(p.kf, p.cf);
    assert.ok(Math.abs(eq.zeta - want[i]) < 0.015, `set ${i}: zeta ${eq.zeta}`);
    // independent check: run the recurrence at u = 1 and fit the sampled poles from the impulse-free step response
    const s = new TimedSpring({ ...p, integrator: 'i4' }, 0); s.retarget(1, 0);
    const xs = []; for (let n = 0; n < 6; n++) xs.push(s.frame(1 / 60, 0));
    // x[n+1] = a1 x[n] + a2 x[n-1] + kf g with a1 = 2 - kf - cf, a2 = -(1 - cf)
    const x = [0, ...xs]; const a1 = 2 - p.kf - p.cf, a2 = -(1 - p.cf);
    for (let n = 1; n < 6; n++) assert.ok(Math.abs(x[n + 1] - (a1 * x[n] + a2 * x[n - 1] + p.kf)) < 1e-12);
  });
});

test('frame-rate behaviour: i6 is frame invariant, i4 and i1h16 are not', () => {
  const at = (id, params, dtMs, tMs) => { const xs = run({ integrator: id, ...params }, dtMs, tMs + 1); return xs.find(([t]) => Math.abs(t - tMs) < 1e-6)[1]; };
  const n4 = loadRoutes().find(r => r.id === 'm07').codeVariants.find(v => v.id === 'i4').default;
  assert.ok(Math.abs(at('i6', SETA, 1000 / 60, 300) - at('i6', SETA, 1000 / 120, 300)) < 1e-9);
  assert.ok(Math.abs(at('i4', n4, 1000 / 60, 300) - at('i4', n4, 1000 / 120, 300)) > 3);
  assert.ok(Math.abs(at('i1h16', SETA, 1000 / 60, 300) - at('i1h16', SETA, 1000 / 120, 300)) > 0.5);
});

test('i6 retarget keeps position and velocity continuous', () => {
  const s = new TimedSpring({ integrator: 'i6', omega0: 14, zeta: 0.3 }, 0);
  s.retarget(100, 500);
  const before = s.frame(0, 800);                       // evaluate just before the retarget
  const v1 = analyticAt(s.seg, 0.3).v;
  s.retarget(20, 800);
  assert.ok(Math.abs(s.x - before) < 1e-9, 'position continuous');
  assert.ok(Math.abs(s.v - v1) < 1e-9, 'velocity continuous');
});

test('inertia: release velocity is read from the last 100 ms; stopped pointer gives no momentum', () => {
  const x = new Inertia({ friction: 0.94, law: 'frame' }, 120);
  x.down(160, 500); for (let t = 510; t <= 900; t += 10) x.move(160 + 0.6 * (t - 500), t);
  x.up(905);
  assert.ok(Math.abs(x.release.vms - 0.6) < 1e-9);
  assert.ok(Math.abs(x.v - 10) < 1e-9);
  const y = new Inertia({ friction: 0.94, law: 'frame' }, 120);
  y.down(160, 500); for (let t = 510; t <= 800; t += 10) y.move(160 + 0.5 * (t - 500), t);
  y.up(1100); assert.equal(y.mode, 'done'); assert.equal(y.release.vms, 0);
});

test('inertia stopping distance equals the geometric-series closed form (per-frame law)', () => {
  for (const f of [0.9, 0.94, 0.97]) {
    const x = new Inertia({ friction: f, law: 'frame' }, 0); x.mode = 'coast'; x.v = 8;
    const x0 = x.x; let n = 0; while (x.mode === 'coast') { x.frame(1 / 60); if (++n > 1e5) break; }
    // closed form: sum_{j=1..N} 8 f^j with N the last j where 8 f^j >= INERTIA_STOP
    const N = Math.floor(Math.log(INERTIA_STOP / 8) / Math.log(f)) + (8 * Math.pow(f, Math.floor(Math.log(INERTIA_STOP / 8) / Math.log(f))) >= INERTIA_STOP ? 0 : -1);
    const cf = 8 * f * (1 - Math.pow(f, N)) / (1 - f);
    assert.ok(Math.abs((x.x - x0) - cf) < 1e-6, `f ${f}: ${x.x - x0} vs ${cf}`);
  }
});

test('hash round trip and quantisation', () => {
  const p = { integrator: 'i4', kf: 0.052, cf: 0.183, sched: 'p400', note: 'ü' .replace('ü', 'u') };
  assert.deepEqual(paramsFromHash('#p=' + encodeParams(p)), p);
  assert.deepEqual(paramsFromHash(''), {});
  assert.equal(quantise(1.23456, 'q3'), 1.235); assert.equal(quantise(1.23456, 'q2'), 1.23); assert.equal(quantise(1.23456, 'full'), 1.23456);
});

test('pointer scripts: first event at >= 500 ms, ordered, moves 10 ms apart', () => {
  for (const name of ['fast', 'slow', 'still']) {
    const ev = pointerEvents(name); assert.ok(ev[0].t >= 500); assert.equal(ev[0].type, 'down'); assert.equal(ev[ev.length - 1].type, 'up');
    for (let i = 1; i < ev.length; i++) assert.ok(ev[i].t >= ev[i - 1].t);
  }
  for (const [k, s] of Object.entries(SCHEDULES)) assert.ok(s[0].t >= 500, k);
});

// ------------------------------------------------------------------------------------------------ route table
test('routes.json: 76 cells, traces exist, grids valid, own parameters only', () => {
  const routes = loadRoutes();
  assert.equal(routes.reduce((a, r) => a + r.cells.total, 0), 76);
  const by = Object.fromEntries(routes.map(r => [r.id, r.cells.total]));
  assert.deepEqual(by, { m07: 42, m07x: 4, m08: 15, m10: 15 });
  for (const r of routes) {
    assert.equal(r.params.grid.length * Object.keys(r.traces).length, r.cells.total);
    for (const [name, f] of Object.entries(r.traces)) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), f);
      const t = loadTrace(r, name); assert.ok(t.boot && t.actions.length && t.scene.selectors.includes('.b0'));
      for (const p of r.params.grid) assert.ok(isValid(r.id, p, t), `${r.id}/${name} invalid ${JSON.stringify(p)}`);
    }
    for (const v of r.codeVariants) assert.ok(v.grid.length >= 2 && v.default);
  }
  // never a spring measured on a captured site (design 11; the private list is read when REVA_BANNED_VALUES is set)
  if (BANNED) {
    const { k, c, m } = BANNED.spring; const all = JSON.stringify(routes);
    assert.ok(!new RegExp(`"k": ?${k}\\b|"c": ?${c}\\b|"m": ?${String(m).replace('.', '\\.')}[,}\\s]`).test(all));
    for (const r of routes) for (const p of r.params.grid) assert.ok(!(p.k === k && p.c === c));
  }
});

test('pages are blind: no truth hook, no driver attribute, neutral ids / classes / titles', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) {
    const s = fs.readFileSync(path.join(ROOT, 'routes', f), 'utf8');
    assert.ok(!/__WR_TRUTH__|__WR_PROBE|data-wr-driver|__GROUND_TRUTH__/.test(s), f);
    if (f.endsWith('.html')) {
      const ids = [...s.matchAll(/\b(?:id|class)="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/));
      assert.deepEqual(ids.sort(), ['b0', 'c']);
      assert.ok(!/data-/.test(s));
      assert.match(s, /<title>x<\/title>/);
    }
  }
});

test('confirmation draws are valid, deterministic, inside the box', () => {
  const routes = loadRoutes();
  const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  for (const r of routes) for (const v of r.codeVariants) {
    for (let i = 0; i < 4; i++) {
      const a = drawParams(r, v.id, mulberry32(20261015 + i)), b = drawParams(r, v.id, mulberry32(20261015 + i));
      assert.deepEqual(a, b);
      if (v.draw.kind === 'omega-zeta-m') {
        const c = canonical(a), w = Math.sqrt(c.k / c.m), z = c.c / (2 * Math.sqrt(c.k * c.m));
        assert.ok(w >= v.draw.omega0[0] - 0.01 && w <= v.draw.omega0[1] + 0.01 && z >= v.draw.zeta[0] - 0.01 && z <= v.draw.zeta[1] + 0.01);
      }
      if (v.draw.kind === 'range') assert.ok(a.friction >= v.draw.friction[0] && a.friction <= v.draw.friction[1]);
    }
  }
});
