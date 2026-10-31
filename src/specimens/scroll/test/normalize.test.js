// Record adapters: both dialects, H6 (unknown stays unknown, defaults are listed), skip reasons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecords } from '../normalize.js';
import { buildScrollSpecimen } from '../index.js';
import * as F from './fixtures.js';

test('lab truth: map + EMA driver with a rendered mirror becomes one mechanism with a via-channel', () => {
  const n = normalizeRecords(F.truthSmooth(), { docHeight: 2000 });
  assert.equal(n.mechanisms.length, 1);
  const m = n.mechanisms[0];
  assert.equal(m.kind, 'scroll-driven'); assert.deepEqual(m.map, { shape: 'smoothstep', bezier: null, s0: 500, s1: 1100, flip: false });
  assert.deepEqual(m.smoothing, { law: 'ema', alpha: 0.2, snap: 0.001 });
  const [drv, ren] = m.channels;
  assert.equal(drv.kind, 'var'); assert.equal(drv.name, 'drv:--v0'); assert.equal(ren.name, 'ren:ty'); assert.equal(ren.via, 0);
  // the mirror maps 0 -> 0, 1 -> -200; the driver is x itself, so ren = -200 * written driver
  assert.equal(ren.k1, -200); assert.equal(ren.k0, 0);
  assert.deepEqual(n.channelMap.map((c) => [c.source, c.specimen]), [['#t|drv:--e', 'b0|drv:--v0'], ['#t|ren:ty', 'b0|ren:ty']]);
  assert.equal(n.skipped.length, 0);
});

test('a falling map flips the smoothed quantity so the primary channel rises with it', () => {
  const n = normalizeRecords(F.truthMap(), { docHeight: 1500 });
  const m = n.mechanisms[0];
  assert.equal(m.map.flip, true); const c = m.channels[0];
  assert.equal(c.k0, 0); assert.equal(c.k1, 1);   // a = 1, b = -1 -> v = (a + b) + (-b) x = x
  assert.ok(m.channels.some((q) => q.role === 'visual' && q.compare === false), 'synthetic visual channel is never compared');
});

test('asymmetric smoothing, hysteresis, pin and wheel smoother', () => {
  assert.deepEqual(normalizeRecords(F.truthAsym()).mechanisms[0].smoothing, { law: 'asym', alphaUp: 1, alphaDown: 0.3, snap: 0.001 });
  const h = normalizeRecords(F.truthHysteresis(), { docHeight: 2000 });
  assert.deepEqual(h.mechanisms.map((m) => m.kind), ['hysteresis']); assert.deepEqual(h.mechanisms[0].up, [600, 900, 1200]);
  assert.deepEqual(h.pins.map((p) => [p.start, p.end]), [[300, 1300]]); assert.equal(h.pins[0].subject, h.mechanisms[0].subject);
  const w = normalizeRecords(F.truthWheel(), { docHeight: 3000, viewport: { width: 1280, height: 800 } });
  assert.deepEqual([w.mechanisms[0].kind, w.mechanisms[0].law, w.mechanisms[0].lambda, w.mechanisms[0].limit], ['wheel-smooth', 'dtdamp', 6, 2200]);
  assert.ok(w.assumptions.some((a) => a.id === 'wheel_mult'), 'the wheel multiplier is an assumption, not a silent default');
});

test('inertia: pointer script reconstructed from the drag record, defaults listed as assumptions', () => {
  const n = normalizeRecords(F.truthInertia());
  assert.equal(n.mechanisms[0].kind, 'inertia'); assert.equal(n.mechanisms[0].friction, 0.9);
  const p = n.inputHints.pointer; assert.equal(p[0].type, 'down'); assert.equal(p[p.length - 1].type, 'up'); assert.equal(p[p.length - 1].T, 905);
  assert.ok(n.assumptions.some((a) => a.id === 'pointer_script'));
  assert.ok(n.skipped.some((s) => /drag segment/.test(s.reason)));
});

test('flip and view transition: triggers derived from the record, latency of the view transition', () => {
  const f = normalizeRecords(F.truthFlip(), { frameMs: 1000 / 120 });
  assert.deepEqual(f.mechanisms[0].triggers, [433.333333, 733.333333]); assert.equal(f.mechanisms[0].D, 600);
  assert.equal(f.mechanisms[0].B.w, 320, 'sx 0.5: the new box is twice the old one'); assert.equal(f.mechanisms[0].A.x - f.mechanisms[0].B.x, -440);
  assert.ok(f.assumptions.some((a) => /flip_box/.test(a.id)));
  const v = normalizeRecords(F.truthVT(), { frameMs: 1000 / 120 });
  assert.equal(v.mechanisms[0].kind, 'view-transition'); assert.equal(v.mechanisms[0].latencyFrames, 2);
  assert.equal(v.mechanisms[0].triggers[0], 433.333333);   // start 450 ms = trigger + 2 frames
  assert.ok(v.skipped.some((s) => /layout step/.test(s.reason)));
});

test('fitted dialect: map + smoothing form', () => {
  const n = normalizeRecords([F.fittedEma()], { docHeight: 2000 });
  const m = n.mechanisms[0];
  assert.deepEqual(m.map, { shape: 'easeInOutCubic', bezier: null, s0: 400, s1: 1200, flip: true });
  assert.equal(m.smoothing.alpha, 0.25); assert.equal(m.smoothing.snap, 0.001);
  assert.equal(n.channelMap[0].source, '#hero|drv:--s', 'selector from the descriptor, tag stripped');
  assert.equal(m.channels[0].k0, 0.5); assert.equal(m.channels[0].k1, 0.5, 'a 1, b -0.5 flipped -> 0.5 + 0.5 x');
});

test('H6: an unknown map corner is a listed placeholder; unexplained records are skipped with a reason; nothing is silent', () => {
  const n = normalizeRecords({ records: [F.fittedMapUnknownCorner(), F.fittedUnexplained(), F.fittedEma({ shape: 'wibble' })] }, { docHeight: 1000 });
  assert.equal(n.mechanisms.length, 1, 'only the map with a withheld corner is built');
  assert.equal(n.mechanisms[0].map.s0, -155.5);
  const u = n.unknowns.find((q) => /unk_map_s0/.test(q.id)); assert.ok(u && u.placeholder === true && /placeholder/.test(u.reason));
  assert.equal(n.skipped.length, 2); assert.ok(n.skipped.some((s) => /no model to rebuild/.test(s.reason)) && n.skipped.some((s) => /wibble/.test(s.reason)));
  const b = buildScrollSpecimen({ records: [F.fittedMapUnknownCorner()] }, { docHeight: 1000 });
  assert.deepEqual(b.spec.placeholders, ['unk_map_s0:#box|drv:--p']);
});

test('smoothing without a snap epsilon is an assumption (no silent default)', () => {
  const rec = F.fittedEma(); rec.smoothing.snap_eps = null;
  const n = normalizeRecords([rec], { docHeight: 2000 });
  assert.equal(n.mechanisms[0].smoothing.snap, 0); assert.ok(n.assumptions.some((a) => /^snap:/.test(a.id)));
});

test('an unknown smoothing law is carried as an unknown (U5) while a per-frame EMA is built', () => {
  const rec = F.fittedEma(); rec.model.law = 'unknown'; rec.smoothing.law = 'unknown';
  const n = normalizeRecords([rec], { docHeight: 2000 });
  assert.ok(n.unknowns.some((q) => /^unk_law:/.test(q.id)));
});

test('fit result pins: bracketed ends are placeholders with a listed unknown', () => {
  const n = normalizeRecords({ records: [], pins: [{ el: 0, desc: 'DIV#p', start_px: null, end_px: null, start: { value: null, interval: [600, 610] }, end: { value: null, interval: [2000, 2010] } }, { desc: 'DIV#q', start: {}, end: {} }] });
  assert.equal(n.pins.length, 1); assert.deepEqual([n.pins[0].start, n.pins[0].end], [605, 2005]);
  assert.equal(n.unknowns.filter((u) => u.placeholder).length, 2); assert.equal(n.skipped.length, 1);
});

test('fitted hysteresis bands become edges (downEdge = crossed while the offset grows)', () => {
  const rec = { schema: 'reva.motion/0', target: { el: 3, desc: 'DIV#t', channel: 'drv:--i' }, tier: 'unknown', class: 'unknown', model: { family: 'x', params: {} }, unknowns: [],
    hysteresis: { hysteresis: true, bands: [{ between: [0, 1], downEdge_px: 640, upEdge_px: 480 }, { between: [1, 2], downEdge_px: 880, upEdge_px: 720 }, { between: [20, 400], downEdge_px: 380, upEdge_px: null }] } };
  const n = normalizeRecords([rec], { docHeight: 2000 });
  assert.deepEqual(n.mechanisms[0].up, [640, 880]); assert.deepEqual(n.mechanisms[0].down, [480, 720]); assert.equal(n.mechanisms[0].levels, 3);
});

test('one pin per element: the widest held interval of a fit result wins, the others are listed', () => {
  const pin = (a, b) => ({ desc: 'DIV#k', start_px: a, end_px: b, start: {}, end: {} });
  const n = normalizeRecords({ records: [], pins: [pin(100, 130), pin(500, 1500), pin(2000, 2040)] });
  assert.equal(n.pins.length, 1); assert.deepEqual([n.pins[0].start, n.pins[0].end], [500, 1500]);
  assert.equal(n.skipped.filter((s) => s.kind === 'pin').length, 2);
});
