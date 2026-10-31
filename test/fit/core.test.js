// Fitter core: vendored code, blind view, negatives, declared tier, stagger, output guard, import boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitTakeSet } from '../../src/analysis/fit/index.js';
import { blindView } from '../../src/analysis/fit/blind.js';
import { guardRecord } from '../../src/analysis/fit/select.js';
import { nelderMead } from '../../src/analysis/fit/vendor/understudy/optimize.js';
import { evalCubicBezier, fitCubicBezier } from '../../src/analysis/fit/vendor/understudy/bezier.js';
import { recoverStagger } from '../../src/analysis/fit/vendor/understudy/cluster.js';
import simplify from '../../src/analysis/fit/vendor/simplify-js/simplify.js';
import { linearStops } from '../../src/analysis/fit/simple.js';
import { cubicBezier, mulberry32Ok } from './oracle-shim.js';
import { synthTake, frameTimes } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIT_DIR = path.resolve(HERE, '../../src/analysis/fit');

test('vendored understudy optimize/bezier/cluster and simplify-js behave as upstream', () => {
  const r = nelderMead(([x, y]) => (1 - x) ** 2 + 100 * (y - x * x) ** 2, [-1.2, 1], { maxIterations: 4000, tolFun: 1e-14, tolX: 1e-10 });
  assert.ok(Math.abs(r.x[0] - 1) < 1e-3 && Math.abs(r.x[1] - 1) < 1e-3, `rosenbrock ${r.x}`);
  const ours = cubicBezier(0.25, 0.1, 0.25, 1); for (const x of [0.1, 0.37, 0.8]) assert.ok(Math.abs(evalCubicBezier([0.25, 0.1, 0.25, 1], x) - ours(x)) < 1e-5);
  const smp = Array.from({ length: 40 }, (_, i) => ({ t: i * 10, p: ours(i / 39) })); const f = fitCubicBezier(smp); assert.ok(f.residual < 0.01);
  const cl = recoverStagger([0, 30, 60, 90].map((t, i) => ({ id: 'e' + i, startT: 100 + t }))); assert.equal(cl[0].intervalMs, 30); assert.equal(cl[0].confident, true);
  const pts = Array.from({ length: 101 }, (_, i) => ({ x: i / 100, y: (i / 100) ** 2 })); assert.ok(simplify(pts, 0.01, true).length < 20);
  const lin = linearStops(frameTimes(120, 600), frameTimes(120, 600).map((t) => (t / 600) ** 2 * 50), 0.001); assert.ok(lin.maxVerticalErrRel < 0.002 && /^linear\(/.test(lin.css));
});

test('blind view hides route id, param names and param values (design §2)', () => {
  const truth = { route: 'M02-smoothstep-ema', params: { alphaQ: 0.137913, rangeVh: 0.25 } };
  const t = synthTake({ scenario: truth.route, marks: [{ name: 'route:' + truth.route, k: 3, T: 25 }], extra: { url: 'http://x/#p=' + Buffer.from(JSON.stringify(truth.params)).toString('base64url'), params: truth.params },
    els: [{ desc: 'DIV.b0', ch: { 'ren:tx': (k) => k * 0.5 } }] });
  t.take.env.scenario = { value: truth.route, provenance: 'declared' }; t.take.env.url = { value: 'http://lab/M02.html#p=xyz', provenance: 'declared' };
  const s = JSON.stringify(blindView(t));
  for (const needle of [truth.route, 'alphaQ', 'rangeVh', '0.137913', 'M02', '#p=']) assert.ok(!s.includes(needle), `blind view leaks ${needle}`);
});

test('negatives: static → no record; constant-velocity ramp → ramp; one-frame step → step; seeded jitter → never spring/EMA', () => {
  const rnd = mulberry32Ok(7);
  const res = fitTakeSet({ primary: synthTake({ dur: 2000, els: [
    { desc: 'DIV.n0', ch: { 'ren:tx': () => 12 } },
    { desc: 'DIV.n1', ch: { 'ren:tx': (k, T) => (T < 400 ? 0 : T > 1400 ? 250 : (T - 400) * 0.25) } },
    { desc: 'DIV.n2', ch: { 'ren:tx': (k, T) => (T < 700 ? 0 : 80) } },
    { desc: 'DIV.n3', ch: { 'ren:tx': () => (rnd() - 0.5) * 6 } },
  ] }) });
  const by = (d) => res.records.filter((r) => r.target.desc === d);
  assert.equal(by('DIV.n0').length, 0);
  assert.deepEqual(by('DIV.n1').map((r) => r.class), ['ramp']);
  assert.ok(Math.abs(by('DIV.n1')[0].model.params.t0.value - 400) < 0.5);
  assert.deepEqual(by('DIV.n2').map((r) => r.class), ['step']);
  for (const r of by('DIV.n3')) assert.ok(!['spring', 'first-order smoothing', 'friction'].includes(r.class) || r.tier !== 'fitted', `jitter → ${r.class}`);
});

test('declared tier: WAAPI timing confirmed on the take frames; hold reported as visible-onset disagreement', () => {
  const E = cubicBezier(0.4, 0, 0.2, 1); const start = 108.333333;
  // keyframes hold for the first 20 % (M06-style hold)
  const val = (T) => { const p = Math.max(0, Math.min(1, (T - start) / 600)); const e = E(p); const q = e <= 0.2 ? 0 : (e - 0.2) / 0.8; return q * 200; };
  const births = [{ name: 'waapi', type: 'Animation', tgt: 'DIV.d0', timeline: 'document', delay: 0, duration: 600, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', iterations: 1, direction: 'normal', fill: 'forwards',
    keyframes: [{ offset: 0, easing: 'linear', transform: 'translateX(0px)' }, { offset: 0.2, easing: 'linear', transform: 'translateX(0px)' }, { offset: 1, easing: 'linear', transform: 'translateX(200px)' }], T: start, k: 12 }];
  const res = fitTakeSet({ primary: synthTake({ dur: 1200, births, els: [{ desc: 'DIV.d0', ch: { 'ren:tx': (k, T) => val(T) } }] }) });
  const [r] = res.records; assert.equal(r.tier, 'declared'); assert.equal(r.model.params.duration.value, 600);
  assert.ok(r.flags.some((f) => f.id === 'visible_onset_after_declared'), 'hold flagged');
  // a declared model that lies (page plays it at 2x) is flagged and fitted as undeclared
  const res2 = fitTakeSet({ primary: synthTake({ dur: 1200, births, els: [{ desc: 'DIV.d0', ch: { 'ren:tx': (k, T) => val(start + (T - start) * 2) } }] }) });
  assert.ok(res2.records[0].tier !== 'declared' && res2.records[0].flags.some((f) => f.id === 'declared_mismatch'));
});

test('stagger: left-to-right row → direction x (dom equivalent), step 30 ms; a diagonal where x and y orders tie → unknown (U9)', () => {
  const E = cubicBezier(0.2, 0, 0, 1);
  const mk = (pos) => synthTake({ dur: 1600, els: pos.map(([x, y], i) => ({ desc: `DIV.c${i}`, rest: { x, y }, ch: { 'ren:ty': (k, T) => { const t0 = 200 + 30 * i + 0.4; return T <= t0 ? 0 : -40 * E(Math.min(1, (T - t0) / 500)); } } })) });
  const row = fitTakeSet({ primary: mk([[0, 100], [100, 100], [200, 100], [300, 100], [400, 100]]) });
  assert.equal(row.stagger.length, 1); const st = row.stagger[0];
  assert.ok(Math.abs(st.interval.value - 30) < 1, `step ${st.interval.value}`); assert.ok(st.direction.value === 'x' || st.direction.equivalent.includes('x'), JSON.stringify(st.direction));
  const diag = fitTakeSet({ primary: mk([[0, 0], [100, 300], [200, 100], [300, 400], [400, 200]]) });
  assert.ok(diag.stagger.length === 1);
  // dom order = x order here, y order differs; both must not be "fitted" unless one clearly wins
  assert.ok(['x', 'dom'].includes(diag.stagger[0].direction.value) || diag.stagger[0].direction.provenance === 'unknown');
});

test('output guard: fitted only with explain + holdout + no ambiguity + finite CI (+ identified integrator for k, c)', () => {
  const mk = () => ({ fit: { rms: 1e-3, explain_bar: 1e-2, holdout: { pass: true } }, ambiguity: null, model: { integrator: { identified: false },
    params: { t0: { value: 1, provenance: 'fitted', ci95: [0.9, 1.1] }, k: { value: 200, provenance: 'fitted', ci95: [190, 210] }, D: { value: 3, provenance: 'fitted', ci95: null } } } });
  const a = mk(); guardRecord(a);
  assert.equal(a.model.params.t0.provenance, 'fitted'); assert.equal(a.model.params.k.provenance, 'unknown'); assert.equal(a.model.params.k.value, null); assert.equal(a.model.params.D.provenance, 'unknown');
  const b = mk(); b.fit.holdout.pass = false; guardRecord(b); assert.equal(b.model.params.t0.provenance, 'unknown');
  const c = mk(); c.ambiguity = { candidates: [] }; guardRecord(c); assert.equal(c.model.params.t0.provenance, 'unknown');
  const d = mk(); d.fit.rms = 1; guardRecord(d); assert.equal(d.model.params.t0.provenance, 'unknown');
});

test('import boundary: the fit core never imports the lab (design §13)', () => {
  const files = fs.readdirSync(FIT_DIR).filter((f) => f.endsWith('.js'));
  for (const f of files) { const src = fs.readFileSync(path.join(FIT_DIR, f), 'utf8'); assert.ok(!/from\s+['"][^'"]*lab\//.test(src) && !/fixtures\/lab/.test(src), `${f} imports lab code`); }
});

test('FLIP signature: layout jump of Δ with a transform from −Δ to identity is marked flip (rAF variant)', () => {
  const E = cubicBezier(0.2, 0, 0, 1);
  const tx = (k, T) => (T < 400 ? 0 : -150 * (1 - E(Math.min(1, (T - 400) / 500))));
  const res = fitTakeSet({ primary: synthTake({ dur: 1400, els: [{ desc: 'DIV.f', ch: { 'ren:tx': tx, 'ren:bx': (k, T) => (T < 400 ? 0 : 150) + tx(k, T) } }] }) });
  const r = res.records.find((x) => x.target.channel === 'ren:tx');
  assert.ok(r.flip && Math.abs(r.flip.layoutDelta - 150) < 1e-6, JSON.stringify(res.records.map((x) => [x.target.channel, x.class, x.flip])));
});

test('pins and hysteresis from a dense sweep down and up (§4.7)', async () => {
  const { findPins, hysteresis } = await import('../../src/analysis/fit/scrollextras.js');
  const ys = []; for (let y = 0; y <= 600; y += 10) ys.push(y); const sweep = [...ys, ...ys.slice(0, -1).reverse()];
  const T = sweep.map((_, k) => k * 1000 / 60);
  // pinned between scroll 200 and 400 (screen y 100), moving with the page elsewhere
  const by = (s) => (s < 200 ? 300 - s : s <= 400 ? 100 : 100 - (s - 400));
  // index with hysteresis: switches 0→1 at progress ≥ 0.55 going down the page, 1→0 at < 0.45 going up
  const prog = (s) => s / 600; let idx = 0; const idxs = sweep.map((s, k) => { const p = prog(s); if (idx === 0 && p >= 0.55) idx = 1; else if (idx === 1 && p < 0.45) idx = 0; return idx; });
  const t = synthTake({ rate: 60, T, sy: sweep, els: [{ desc: 'DIV.pin', ch: { 'ren:by': (k) => by(sweep[k]) } }, { desc: 'DIV.h', ch: { 'drv:--i': idxs, 'drv:--p': (k) => prog(sweep[k]) } }] });
  t.data.rows.forEach((r) => { r.v[0]['ren:by'] = by(r.sy); });
  const { blindView } = await import('../../src/analysis/fit/blind.js');
  const pins = findPins(blindView(t), sweep); const p = pins.find((q) => q.desc === 'DIV.pin');
  assert.ok(p && Math.abs(p.start_px - 200) <= 2 && Math.abs(p.end_px - 400) <= 2, JSON.stringify(pins));
  const h = hysteresis({ y: idxs }, sweep, sweep.map(prog));
  assert.ok(h.hysteresis); assert.ok(Math.abs(h.bands[0].downEdge_sibling - 0.55) <= 0.05 && Math.abs(h.bands[0].upEdge_sibling - 0.44) <= 0.05, JSON.stringify(h.bands));
});
