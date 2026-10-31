// Scorer unit tests on synthetic takes (no browser): refusal rules, input replay, pooling, layers, protocol helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreTakeSets, compareEnv, compareEvents, pool } from '../../src/score/score.js';
import { resolveElement, numericOf, parseChannelKey } from '../../src/score/series.js';
import { spearman, ladderVerdict, selfBand, floors, twinsVerdict, readbackFloorSd, quantisedTwin } from '../../src/score/protocol.js';
import { formatScore } from '../../src/score/format.js';

const DT = 1000 / 120;
const outCubic = (t) => 1 - Math.pow(1 - t, 3);
/** A synthetic score input: one element '#a' whose ren:tx follows fn(t) after a 'go' input at Tgo. */
function synth({ fn, Tgo = 100, end = 1200, dt = DT, lane = 'hx', vp = { width: 800, height: 600 }, phase = 0 }) {
  const rows = [];
  for (let k = 0; k * dt <= end; k++) { const T = +(k * dt).toFixed(6); rows.push({ k, T, sy: 0, v: { 0: { 'ren:tx': fn(T - Tgo - phase) } } }); }
  return {
    id: 'synth', rows, elements: ['DIV#a'], inputLog: [], marks: [], extra: {},
    events: [{ T: Tgo + phase, kind: 'time', value: 'go' }],
    meta: { lane, rate: Math.round(1000 / dt), dtMs: lane === 'hx' ? dt : null, refreshHz: 1000 / dt, viewport: vp, dpr: 1, reducedMotion: 'no-preference', engine: 'chs', toolkit: 't147', readback: null },
  };
}
const tween = (D, amp = 200) => (t) => (t <= 0 ? 0 : amp * outCubic(Math.min(1, t / D)));
const SPEC = { mechanisms: [{ id: 'm', arms: ['response'], pairs: ['#a|ren:tx'] }] };
const run = (a, b, o = {}) => scoreTakeSets({ src: { response: a }, reb: { response: b } }, SPEC, { events: { src: a.events, reb: b.events }, ...o });

test('identical takes: S = 1, layer 1 identical, layer 2 pass', () => {
  const a = synth({ fn: tween(400) });
  const r = run(a, synth({ fn: tween(400) }));
  const m = r.mechanisms[0];
  assert.equal(m.pooled.score, 1); assert.equal(m.verdict.layer1, 'identical'); assert.equal(m.verdict.layer2, 'pass');
});

test('cross-rate, cross-lane and cross-viewport comparisons are refused, nothing is scored', () => {
  const a = synth({ fn: tween(400) });
  for (const b of [synth({ fn: tween(400), dt: 1000 / 60 }), synth({ fn: tween(400), lane: 'rt' }), synth({ fn: tween(400), vp: { width: 1280, height: 800 } })]) {
    const r = run(a, b);
    assert.ok(r.refused.length > 0, 'refused');
    assert.ok(r.mechanisms.every(m => !m.pooled), 'no score computed');
  }
  assert.equal(compareEnv(a, synth({ fn: tween(400) })).ok, true);
});

test('exact input replay: a different input schedule is refused; a sub-frame phase is reported', () => {
  assert.equal(compareEvents([{ T: 100, kind: 'scroll', value: 400 }], [{ T: 100, kind: 'scroll', value: 500 }], DT).ok, false);
  assert.equal(compareEvents([{ T: 100, kind: 'scroll', value: 400 }], [{ T: 100 + DT, kind: 'scroll', value: 400 }], DT).ok, false);
  const ok = compareEvents([{ T: 100, kind: 'scroll', value: 400 }], [{ T: 103, kind: 'scroll', value: 400 }], DT);
  assert.equal(ok.ok, true); assert.equal(ok.maxPhaseMs, 3);
});

test('a slower tween is different beyond the band; the lag channel is separate and not aligned away', () => {
  const a = synth({ fn: tween(400) });
  const band = selfBand([run(a, synth({ fn: tween(400), phase: DT / 2 }))]);
  const slow = run(a, synth({ fn: tween(480) }), { band });
  const m = slow.mechanisms[0];
  assert.equal(m.verdict.layer1, 'different'); assert.ok(m.pooled.score < 0.9);
  const late = run(a, synth({ fn: (t) => tween(400)(t - 60) }), { band }).mechanisms[0];
  assert.ok(Math.abs(late.lag.worstDeltaMs - 60) < 1, `lag Δ ${late.lag.worstDeltaMs}`);
  assert.equal(late.verdict.layer1, 'different');
});

test('all motion removed is caught by the amplitude cue', () => {
  const r = run(synth({ fn: tween(400) }), synth({ fn: () => 0 }));
  const m = r.mechanisms[0];
  assert.equal(m.verdict.layer1, 'different'); assert.equal(m.verdict.layer2, 'fail'); assert.ok(m.pooled.score < 1e-6);
});

test('Minkowski-3 pooling and the score function', () => {
  const p = pool([{ e: 1 }, { e: 1 }, { e: null }]);
  assert.ok(Math.abs(p.E - Math.cbrt(2)) < 1e-12); assert.ok(Math.abs(p.score - Math.exp(-2)) < 1e-12); assert.equal(p.n, 2);
  assert.equal(pool([]).score, 1);
});

test('element resolution and numeric channels', () => {
  const els = ['DIV#a.x', 'DIV.c.d', 'SPAN.c', 'DIV.c.e'];
  assert.equal(resolveElement(els, '#a'), 0);
  assert.equal(resolveElement(els, 'span.c'), 2);
  assert.throws(() => resolveElement(els, '.c'), /matched 3/);
  assert.equal(resolveElement(els, '.c:nth(2)'), 3);
  assert.equal(numericOf('inset(36% 0px)', 'ren:clipPath'), 36);
  assert.equal(numericOf('none', 'ren:scale'), 1);
  assert.equal(numericOf('none', 'ren:clipPath'), 0);
  assert.equal(numericOf('10px 4px', 'ren:translate', 1), 4);
  assert.deepEqual(parseChannelKey('#a|ren:clipPath#1'), { sel: '#a', channel: 'ren:clipPath', idx: 1 });
});

test('protocol helpers: Spearman, floor, ladder and twins verdicts', () => {
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-12);
  const floor = { mean: 0.998, sd: 0.001 };
  const pts = [1, 2, 5, 10, 20].flatMap(p => [{ p, score: 1 - p * p * 1e-4 }, { p: -p, score: 1 - p * p * 1.1e-4 }]);
  const v = ladderVerdict(pts, floor);
  assert.ok(v.rho <= -0.95); assert.equal(v.onePct.pass, true); assert.equal(v.tenPct.pass, true);
  assert.equal(twinsVerdict(0.9975, floor).pass, true); assert.equal(twinsVerdict(0.99, floor).pass, false);
  const a = synth({ fn: tween(400) });
  const ids = [DT / 8, DT / 4].map(ph => run(a, synth({ fn: tween(400), phase: ph })));
  const f = floors(ids).m;
  assert.equal(f.n, 2); assert.ok(f.mean > 0.99 && f.mean <= 1);
});

test('M3 Amendment 1: the 1 % row uses sd_eff = max(self-band sd, read-back floor, rt floor); the 10 % row does not', () => {
  const floor = { mean: 0.9999, sd: 0.00005 };
  const pts = [1, 2, 5, 10, 20].flatMap(p => [{ p, score: 1 - p * p * 5e-4 }, { p: -p, score: 1 - p * p * 4e-4 }]);
  // self-band only: S(+1 %) = 0.9995 < 0.9999 - 2 * 0.00005 = 0.9998 -> fail (the hold shape)
  const a = ladderVerdict(pts, floor);
  assert.equal(a.onePct.pass, false); assert.equal(a.onePct.sdFrom, 'self-band'); assert.equal(a.onePct.sdEff, floor.sd);
  // a read-back floor below the self-band sd changes nothing
  const b = ladderVerdict(pts, floor, { readback: 1e-9, rt: null });
  assert.equal(b.onePct.pass, false); assert.equal(b.onePct.limit, a.onePct.limit);
  // a wider measured floor (here rt) widens the 1 % limit only; the 10 % limit keeps the self-band sd
  const c = ladderVerdict(pts, floor, { readback: 1e-9, rt: 3e-4 });
  assert.equal(c.onePct.sdFrom, 'rt'); assert.ok(Math.abs(c.onePct.limit - (0.9999 - 6e-4)) < 1e-12); assert.equal(c.onePct.pass, true);
  assert.equal(c.tenPct.limit, a.tenPct.limit); assert.ok(Math.abs(c.tenPct.limit - (0.9999 - 5 * 0.00005)) < 1e-12);
  const d = ladderVerdict(pts, floor, { readback: 3e-4 });
  assert.equal(d.onePct.sdFrom, 'readback'); assert.equal(d.onePct.pass, true);
  // non-finite floors are ignored, never widen the limit
  assert.equal(ladderVerdict(pts, floor, { readback: NaN, rt: Infinity }).onePct.limit, a.onePct.limit);
});

test('read-back floor in score units: source vs itself moved by ±q per sample; q = 0 gives 0', () => {
  const a = synth({ fn: tween(400) });
  const el = 0, ch = 'ren:tx';
  const tw = quantisedTwin(a, el, ch, 0.5, (i) => (i % 2 ? -1 : 1));
  const moved = a.rows.filter(r => r.v && r.v[el] && typeof r.v[el][ch] === 'number');
  assert.ok(moved.length > 10);
  assert.ok(tw.rows.some((r, i) => r.v && r.v[el] && r.v[el][ch] !== a.rows[i].v[el][ch]));
  const scoreOf = (twin) => run(a, twin).mechanisms[0].pooled.score;
  const z = readbackFloorSd(a, [{ el, channel: ch, q: 0 }], scoreOf);
  assert.equal(z.sd, 0); assert.equal(z.per.length, 5);
  const small = readbackFloorSd(a, [{ el, channel: ch, q: 5e-4 }], scoreOf);
  const big = readbackFloorSd(a, [{ el, channel: ch, q: 0.5 }], scoreOf);
  assert.ok(small.sd >= 0 && small.sd < 1e-6, `small ${small.sd}`);
  assert.ok(big.sd > small.sd, `big ${big.sd} small ${small.sd}`);
});

test('the printed summary puts a band next to every cue number', () => {
  const a = synth({ fn: tween(400) });
  const band = selfBand([run(a, synth({ fn: tween(400), phase: DT / 2 }))]);
  const txt = formatScore(run(a, synth({ fn: tween(460) }), { band, floors: { m: { mean: 0.999, sd: 0.001, n: 4 } } }));
  const lines = txt.split('\n').filter(l => / Δ /.test(l));
  assert.ok(lines.length > 0);
  for (const l of lines) assert.equal(l.split(' Δ ').length - 1, (l.match(/\(band [^)]*\)/g) || []).length, l);
  assert.match(txt, /floor 0\.9990 ± 0\.0010/);
});
