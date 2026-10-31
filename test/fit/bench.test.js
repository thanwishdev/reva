// Fitter on the M1 bench takes (own fixture fixtures/bench, recorded with the repo recorder; the takes live in the
// private output root and the test skips when they are absent). Known truth from fixtures/bench/index.html:
// wa = WAAPI 800 ms back-out bezier, tr = CSS transition 1000 ms ease-in-out, to = CSS transition 400 ms linear,
// js = analytic spring k 170 c 26 (m 1) from performance.now(), ema = per-frame EMA α 0.2 toward 500 px.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTake } from '../../src/record/take.js';
import { outRoot } from '../../src/util/paths.js';
import { fitTakeSet } from '../../src/analysis/fit/index.js';

const ROOT = path.join(outRoot(), 'takes', 'fixture', 'bench-go');
const pick = (suffix) => { try { return fs.readdirSync(ROOT).filter((d) => d.endsWith(suffix)).sort().map((d) => path.join(ROOT, d)).find((d) => fs.existsSync(path.join(d, 'take.json'))); } catch { return null; } };
const L = (d) => loadTake(d, ['rows', 'births', 'declared', 'mutations', 'wheel', 'inputLog', 'elements']);
const d120 = pick('_hx120'), d60 = pick('_hx60');
const rel = (a, b) => Math.abs(a / b - 1);

test('bench take set (120 Hz + 60 Hz probe): declared confirmed, analytic spring identified as I6 with k/c, EMA per-frame', { skip: !(d120 && d60) && 'bench takes not present in the private output root' }, () => {
  const res = fitTakeSet({ primary: L(d120), probe: L(d60) });
  const rec = (id, ch = 'ren:tx') => res.records.filter((r) => r.target.desc.startsWith('DIV#' + id) && r.target.channel === ch);
  for (const id of ['wa', 'tr', 'to']) { const [r] = rec(id); assert.equal(r.tier, 'declared', id); assert.ok(r.fit.rms <= r.fit.explain_bar); }
  assert.equal(rec('tr')[0].model.params.duration.value, 1000);
  const js = rec('js', 'drv:transform')[0];
  assert.equal(js.class, 'spring'); assert.equal(js.model.integrator.identified, true); assert.ok(js.model.integrator.set.includes('I6'));
  assert.ok(rel(js.model.params.k.value, 170) < 0.01 && rel(js.model.params.c.value, 26) < 0.01, `k ${js.model.params.k.value} c ${js.model.params.c.value}`);
  const ema = rec('ema', 'drv:transform')[0];
  assert.equal(ema.class, 'first-order smoothing'); assert.equal(ema.model.law, 'per-frame'); assert.ok(rel(ema.model.params.alpha_per_frame.value, 0.2) < 0.01);
  // nothing is confidently wrong about the known motions: every fitted spring/EMA value above is within 1 %
  for (const r of res.records) for (const p of Object.values(r.model.params)) if (p && p.provenance === 'fitted') assert.ok(Number.isFinite(p.value));
});

test('bench single 120 Hz take: spring ω, ζ recovered (analytic); EMA α fitted with law unknown (U5)', { skip: !d120 && 'bench take not present' }, () => {
  const res = fitTakeSet({ primary: L(d120) });
  const js = res.records.find((r) => r.target.desc === 'DIV#js.b' && r.target.channel === 'drv:transform');
  assert.ok(rel(js.derived.omega, Math.sqrt(170)) < 0.01 && rel(js.derived.zeta, 26 / (2 * Math.sqrt(170))) < 0.01, `ω ${js.derived.omega} ζ ${js.derived.zeta}`);
  const ema = res.records.find((r) => r.target.desc === 'DIV#ema.b' && r.target.channel === 'drv:transform');
  assert.equal(ema.model.law, 'unknown'); assert.ok(ema.unknowns.some((u) => u.id === 'unk_smoothing_law'));
});
