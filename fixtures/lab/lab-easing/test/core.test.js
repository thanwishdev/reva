// Pure checks (no browser): math, parameter hygiene (own values only), routes.json sync.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cubicBezier as oracle } from '../../../../src/analysis/oracles.js';
import {
  cubicBezier, NAMED, easeFn, bezierOvershoot, encodeParams, paramsFromHash, quant, tweenAt, staggerIndex, equivalentKeys,
  DEFAULTS, GRIDS, BOXES,
} from '../core.js';
import { ROOT, loadRoutes } from '../tools/harness.mjs';
import { BANNED, bannedSkip } from '../../banned-values.mjs';

const bezierSpecs = () => {
  const out = [];
  for (const g of [DEFAULTS, ...Object.values(GRIDS).map((a) => Object.fromEntries(a.map((x, i) => [i, x])))]) {
    for (const p of Object.values(g)) for (const key of ['bz', 'ease', 'e0', 'e1', 'spline']) if (Array.isArray(p[key])) out.push(p[key]);
  }
  return out;
};

test('cubicBezier agrees with the A3-verified oracle on every curve used by the lab', () => {
  const specs = bezierSpecs();
  assert.ok(specs.length >= 20);
  for (const b of specs) {
    const a = cubicBezier(...b), o = oracle(...b);
    let mx = 0;
    for (let i = 0; i <= 2000; i++) mx = Math.max(mx, Math.abs(a(i / 2000) - o(i / 2000)));
    assert.ok(mx < 1e-7, `${b}: ${mx}`);
  }
});

test('named eases: endpoints and closed-form spot values', () => {
  for (const [n, f] of Object.entries(NAMED)) {
    assert.ok(Math.abs(f(0)) < 1e-12 || n === 'easeOutBack', `${n}(0)`);
    assert.ok(Math.abs(f(1) - 1) < 1e-12, `${n}(1)`);
  }
  assert.equal(NAMED.easeOutCubic(0.5), 0.875);
  assert.equal(NAMED.easeInOutQuad(0.25), 0.125);
  assert.ok(Math.abs(NAMED.easeOutExpo(0.5) - (1 - 2 ** -5)) < 1e-15);
  assert.equal(NAMED.easeOutExpo(1), 1);
  assert.throws(() => easeFn('nope'));
});

test('M16f grid and default overshoot 5 to 12 percent (back-out bezier, not a spring)', () => {
  const all = [DEFAULTS.m16f, ...GRIDS.m16f];
  for (const p of all) {
    const o = bezierOvershoot(p.bz);
    assert.ok(o >= 0.05 && o <= 0.12, `${p.bz}: ${o}`);
  }
});

test('hash parameters round-trip', () => {
  const p = { a: 1, b: [0.1, 2.5], c: 'x y', d: null };
  assert.deepEqual(paramsFromHash('#p=' + encodeParams(p)), p);
  assert.deepEqual(paramsFromHash(''), {});
  assert.deepEqual(paramsFromHash('#p=@@@'), {});
});

test('quant and tweenAt', () => {
  assert.equal(quant(1.23456, 'q3'), 1.235);
  assert.equal(quant(1.23456, 'q2'), 1.23);
  assert.equal(quant(1.23456, 'full'), 1.23456);
  const tw = { from: 10, to: 30, D: 100, t0: 50, ease: (p) => p };
  assert.equal(tweenAt(tw, 40).v, 10);
  assert.equal(tweenAt(tw, 100).v, 20);
  assert.deepEqual(tweenAt(tw, 150), { v: 30, p: 1, done: true });
});

test('stagger orders are permutations; equivalent keys', () => {
  for (const order of ['dom', 'reverse', 'column']) {
    const ranks = [0, 1, 2, 3, 4, 5].map((i) => staggerIndex(order, i, 3, 2));
    assert.deepEqual([...ranks].sort(), [0, 1, 2, 3, 4, 5], order);
    assert.ok(equivalentKeys(order).length > 0);
  }
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => staggerIndex('column', i, 3, 2)), [0, 2, 4, 1, 3, 5]);
});

test('own parameters only: no value from a captured site (PLAN section 4 M2, design section 11)', { skip: bannedSkip }, () => {
  const bannedBeziers = BANNED.beziers;
  const bannedDurations = new Set(BANNED.durationsMs);
  const durationKeys = new Set(['D', 'D2', 'du', 'cD', 'd0', 'd1', 'dur', 'delay']);
  const seen = [];
  const walk = (v, where, key) => {
    if (typeof v === 'number') { if (durationKeys.has(key) && bannedDurations.has(v)) seen.push(`${where}=${v}`); }
    else if (Array.isArray(v)) {
      if (v.length === 4 && v.every((x) => typeof x === 'number')) for (const b of bannedBeziers) if (b.every((x, i) => x === v[i])) seen.push(`${where}=bezier ${v}`);
      v.forEach((x, i) => walk(x, `${where}[${i}]`, key));
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`, k);
  };
  walk(DEFAULTS, 'DEFAULTS'); walk(GRIDS, 'GRIDS'); walk(BOXES, 'BOXES');
  for (const p of [DEFAULTS.m06, ...GRIDS.m06]) assert.ok(!(p.base === BANNED.stagger.base && p.step === BANNED.stagger.step), 'banned stagger');
  assert.deepEqual(seen, []);
  // the design's M06 override: delays 12 + 30*i ms
  assert.equal(DEFAULTS.m06.base, 12); assert.equal(DEFAULTS.m06.step, 30);
});

test('grid values lie inside the confirmation boxes (the no-hold control is the one allowed exception)', () => {
  for (const [route, box] of Object.entries(BOXES)) {
    for (const p of GRIDS[route]) for (const [k, [lo, hi]] of Object.entries(box)) {
      if (route === 'm06' && p.hold === 0 && k === 'hold') continue;
      assert.ok(p[k] >= lo && p[k] <= hi, `${route}.${k}=${p[k]} outside [${lo}, ${hi}]`);
    }
  }
});

test('routes.json is in sync with core.js and the traces on disk', () => {
  const r = loadRoutes();
  assert.equal(r.group, 'lab-easing');
  assert.deepEqual(r.routes.map((x) => x.id).sort(), Object.keys(DEFAULTS).sort());
  for (const route of r.routes) {
    assert.deepEqual(route.params.default, DEFAULTS[route.id]);
    assert.deepEqual(route.params.grid, GRIDS[route.id].map((g) => ({ ...DEFAULTS[route.id], ...g })));
    assert.equal(route.params.grid.length, 5);
    assert.ok(fs.existsSync(path.join(ROOT, route.page)));
    assert.ok(fs.existsSync(path.join(ROOT, route.page.replace(/\.html$/, '.js'))));
    for (const f of Object.values(route.traces)) {
      const spec = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      // inputs on the 100 ms grid, first input at T >= 400 ms (design section 11)
      const holds = spec.actions.filter((a) => 'hold' in a).map((a) => a.hold);
      assert.ok(spec.actions[0].hold >= 400, f);
      for (const h of holds) assert.equal(h % 100, 0, `${f} hold ${h}`);
      assert.ok(spec.actions.some((a) => 'eval' in a || 'scrollTo' in a || 'denseSweep' in a), f);
    }
  }
  // the traces carry the cell counts of D-M2-2 A1.4: M06 5x1, M11 5x3, M12 5x1, M15 5x1, M17 5x1, M18 5x2, M19 5x3, M16e 5x1, M16f 5x1
  const traceCount = Object.fromEntries(r.routes.map((x) => [x.id, Object.keys(x.traces).length]));
  assert.deepEqual(traceCount, { m06: 1, m11: 3, m12: 1, m15: 1, m17: 1, m18: 2, m19: 3, m16e: 1, m16f: 1 });
  assert.equal(r.routes.reduce((n, x) => n + x.params.grid.length * Object.keys(x.traces).length, 0), 70);
});
