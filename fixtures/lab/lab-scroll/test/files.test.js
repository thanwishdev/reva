import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT, read, routes, pagesOf } from './helpers.js';
import { isServable } from '../serve.mjs';
import { buildTraces } from '../tools/gen-traces.mjs';
import { buildTruthFiles } from '../tools/gen-truth.mjs';
import { truth, tauMs } from '../truth.mjs';
import { defaultsOf } from '../refsim.mjs';
import { BANNED, bannedSkip } from '../../banned-values.mjs';

test('routes.json: every page and trace exists; grids match the registered cell counts (A1.4: 100 cells for group C)', () => {
  const r = routes();
  let cells = 0;
  for (const route of r.routes) {
    assert.ok(fs.existsSync(path.join(ROOT, route.page)), route.page);
    for (const f of Object.values(route.traces)) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
    assert.equal(Object.keys(route.traces).length, 3);
    assert.deepEqual(route.regimes, ['R2', 'R3', 'R4', 'R5']);
    assert.ok(route.metrics.length > 0);
    cells += route.params.grid.length * 3 + (route.params.writeVariants ? route.params.writeVariants.length : 0);
  }
  assert.equal(cells, 100);
  assert.deepEqual(r.routes.map(x => x.id), ['m01', 'm02', 'm03', 'm04', 'm05', 'm09', 'm09b']);
  for (const route of r.routes) assert.equal(route.params.grid.length, { m09: 3, m09b: 2 }[route.id] || 5);
});

test('own parameters only: no value from a captured site in the grids or defaults', { skip: bannedSkip }, () => {
  const FORBIDDEN_ALPHA = BANNED.alpha;
  const FORBIDDEN_MS = BANNED.durationsMs;
  for (const route of routes().routes) {
    const all = [route.params.default, ...route.params.grid, ...(route.params.writeVariants || [])];
    for (const p of all) {
      for (const [k, v] of Object.entries({ ...defaultsOf(route.id), ...p })) {
        for (const x of [].concat(v)) {
          if (typeof x !== 'number') continue;
          if (/alpha|aDown|aExit|lerp/.test(k)) assert.ok(!FORBIDDEN_ALPHA.includes(x), `${route.id}.${k}=${x}`);
          if (/dur/.test(k)) assert.ok(!FORBIDDEN_MS.includes(x), `${route.id}.${k}=${x}`);
        }
      }
    }
  }
  const d2 = defaultsOf('m02'), d4 = defaultsOf('m04');
  assert.notEqual(+(d2.b0 - d2.b1).toFixed(6), BANNED.scroll.smoothstepSpanVh, 'smoothstep span is a banned value');
  assert.notEqual(d4.scrub, BANNED.scroll.scrubVh);
  assert.ok(d2.b0 !== BANNED.scroll.m02Bounds[0] || d2.b1 !== BANNED.scroll.m02Bounds[1], 'M02 bounds are a banned pair');
});

test('M02 bounds are the amended 0.85 / 0.25 vh', () => {
  const d2 = defaultsOf('m02');
  assert.equal(d2.b0, 0.85); assert.equal(d2.b1, 0.25);
});

test('blind pages: single-letter ids, single-letter custom properties, no data attributes, no truth hooks', () => {
  const BANNED = /ema|alpha|lerp|smooth|ease|spring|tween|latch|hyster|scrub|lenis|damp|snap|pin\b|momentum|inertia/i;
  for (const f of pagesOf()) {
    const src = read('routes/' + f);
    for (const m of src.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) assert.match(m[1], /^[a-z]$/, `${f} id ${m[1]}`);
    for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) assert.match(m[1], /^[a-z]$/, `${f} getElementById ${m[1]}`);
    for (const m of src.matchAll(/block\(\s*['"]([^'"]+)['"]/g)) assert.match(m[1], /^[a-z]$/, `${f} block ${m[1]}`);
    for (const m of src.matchAll(/(?<![\w-])--([A-Za-z0-9-]+)/g)) assert.match(m[1], /^[a-z]$/, `${f} custom property --${m[1]}`);
    assert.ok(!/\bclass\s*=|classList|className/.test(src), `${f} uses classes`);
    assert.ok(!/data-[a-z]/.test(src), `${f} data attribute`);
    assert.ok(!/__WR|__GROUND_TRUTH__|data-wr-driver/.test(src), `${f} truth hook`);
    const title = /<title>([^<]*)<\/title>/.exec(src);
    if (title) assert.equal(title[1], 'lab');
    if (f.endsWith('.html')) assert.ok(!BANNED.test(src.replace(/<script[^>]*src="[^"]*"/g, '')), `${f}: mechanism word in the page markup`);
  }
});

test('the static server serves pages and the vendored library, and refuses truth, refsim, routes, traces, tests', () => {
  for (const ok of ['routes/m02.html', 'routes/m02.js', 'routes/lib.js', 'routes/base.css', 'core.js', 'vendor/lenis.mjs']) assert.ok(isServable(ok), ok);
  for (const no of ['truth.mjs', 'refsim.mjs', 'routes.json', 'plan.mjs', 'truth/m02.json', 'traces/m02.gap.json', 'test/core.test.js', 'tools/gen-truth.mjs', 'vendor/LICENSE-lenis', '../x', 'parity.mjs']) assert.ok(!isServable(no), no);
});

test('generated files are current (traces, truth review files)', () => {
  for (const [name, text] of Object.entries(buildTraces())) assert.equal(read('traces/' + name), text, name);
  for (const [name, text] of Object.entries(buildTruthFiles())) assert.equal(read('truth/' + name), text, name);
});

test('every trace starts with a 500 ms boot hold and uses only multiples of 100 ms', () => {
  for (const route of routes().routes) for (const f of Object.values(route.traces)) {
    const t = JSON.parse(read(f));
    assert.equal(t.schema, 'reva.labtrace/0');
    assert.deepEqual(t.actions[0], { hold: 500 });
    for (const a of t.actions) if ('hold' in a) assert.equal(a.hold % 100, 0, `${f}: hold ${a.hold}`);
  }
});

test('truth: the M02 gap trace ends with a tail long enough for the slowest alpha at 30 Hz; model settle frames are registered', () => {
  const t = truth('m02', { alpha: 0.08 }, 'R4', 'gap');
  const tails = t.items[0].derived.settle_tails;
  assert.equal(tails.length, 5);
  assert.equal(tails[tails.length - 1].settled, true, 'the last step settles inside the take');
  assert.equal(t.items[0].derived.settle_frames_unit_step.value, Math.ceil(Math.log(1e-3) / Math.log(1 - 0.08)));
  assert.equal(truth('m09', { lerp: 0.1 }, 'R3', 'reversal').events.wheels.some(w => w.dy === -100 && w.changed === false), true, 'a wheel at the top is clamped and changes nothing');
});

test('vendored Lenis is the pinned version with its licence', () => {
  assert.match(read('vendor/lenis.mjs').split('\n', 3).join('\n'), /var version = "1\.3\.26"/);
  // dist/lenis.mjs of the npm tarball lenis@1.3.26 (tarball sha256 f8930e6b3e26a88f7ccd9ec45f1a11c85d2118cd14673b304204d59e49a68415), unmodified
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'vendor/lenis.mjs'))).digest('hex'), 'b7a2f6896b9ce086d8192ff17c91aad457447976764971fe5011c42169602e9e');
  assert.match(read('vendor/LICENSE-lenis'), /MIT License/);
  assert.match(read('vendor/LICENSE-lenis'), /darkroom\.engineering/);
});

test('truth: closed forms (tau at dt, dt-aware tau independent of the rate)', () => {
  const t = (id, p, reg) => truth(id, p, reg, Object.keys(routes().routes.find(r => r.id === id).traces)[0]);
  const d = (x) => x.items.find(i => i.scored).derived;
  assert.ok(Math.abs(d(t('m02', { alpha: 0.18 }, 'R3')).tau_ms.value - 1000 / 120 / -Math.log(0.82)) < 1e-9);
  assert.ok(Math.abs(d(t('m02', { alpha: 0.18 }, 'R3')).tau_ms.value * 2 - d(t('m02', { alpha: 0.18 }, 'R2')).tau_ms.value) < 1e-9);
  for (const reg of ['R2', 'R3', 'R4']) assert.ok(Math.abs(d(t('m09', { lerp: 0.1 }, reg)).tau_ms.value - 1000 / 6) < 1e-9);
  assert.ok(Math.abs(d(t('m09b', { lerp: 0.1 }, 'R2')).tau_ms.value - tauMs(0.1, 1000 / 60)) < 1e-9);
  assert.equal(t('m09', { lerp: 0.1 }, 'R5').items[0].derived.alpha_on_stall_frame.at_dt_ms, 100);
  assert.equal(t('m02', { alpha: 0.18 }, 'R6').items[0].derived.alpha_per_sample.stride, 2);
});

test('truth: structure (schema, attribution for every item, scored driver items, metrics from routes.json)', () => {
  for (const route of routes().routes) {
    const t = truth(route.id, route.params.default, 'R3', Object.keys(route.traces)[0]);
    assert.equal(t.schema, 'reva.labtruth/0');
    assert.deepEqual(t.metrics, route.metrics);
    assert.ok(t.items.some(i => i.scored && i.role === 'driver'));
    for (const i of t.items) { assert.ok(t.attribution[i.target], i.target); assert.ok(i.class); }
    assert.equal(t.stagger, null);
  }
});

test('truth: M04 hysteresis edges, pin range; M05 latch decisions and retarget; M03 asymmetry runs', () => {
  const m4 = truth('m04', { alpha: 0.15 }, 'R3', 'speed');
  const i = m4.items.find(x => x.target === '#c|drv:--i');
  assert.deepEqual(i.params.edges.up.map(x => +x.toFixed(6)), [0.8, 1.8, 2.8, 3.8]);
  assert.deepEqual(i.params.edges.down.map(x => +x.toFixed(6)), [0.2, 1.2, 2.2, 3.2]);
  assert.equal(i.derived.observed_up.length, 4); assert.equal(i.derived.observed_down.length, 4);
  const pin = m4.items.find(x => x.family === 'pin').params.pin;
  assert.deepEqual([pin.start_px, pin.end_px], [400, 2400]);
  const m5 = truth('m05', { dur: 540 }, 'R3', 'retarget');
  assert.deepEqual(m5.events.latch.expected_prevented, [true, true, true, false]);
  assert.equal(m5.events.retargets.length, 1);
  const plain = truth('m05', { dur: 540 }, 'R3', 'plain');
  assert.deepEqual(plain.events.latch.expected_prevented, [true, true, false]);          // third wheel: armed, not latched -> passes through
  assert.deepEqual(plain.events.wheels.map(w => w.action), ['start', 'start', 'not-latched']);
  const burst = truth('m05', { dur: 540 }, 'R3', 'burst');
  assert.deepEqual(burst.events.wheels.map(w => w.action), ['start', 'swallowed', 'retarget', 'retarget', 'ignored']);   // last wheel: not armed
  assert.equal(m5.events.retargets[0].semantics, 'from-current');
  const m3 = truth('m03', {}, 'R3', 'gap');
  assert.ok(m3.events.asymmetry.some(r => r.direction === 'rise' && r.response === 'instant'));
  assert.ok(m3.events.asymmetry.some(r => r.direction === 'fall' && r.response !== 'instant'));
});
