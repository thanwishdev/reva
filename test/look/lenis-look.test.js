// look x Lenis: declared options (synthetic probe reads) -> look.json "lenis", printed lines, comparison with the fitted tau.
// Pure; the probe source is only run in a node vm against a fake window (no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { lookLenis, lenisDeclaredText, compareLenisTau, lerpToTauMs, easingName, lenisPageLines, lenisLibLine, fittedTauMs, buildLenisProbeSource } from '../../src/look/lenis.js';

const EXPO = '(t) => Math.min(1, 1.001 - Math.pow(2, -10 * t))';
const read = (options, extra = {}) => ({ probe: 'lenis-probe-1', found: true, via: 'window.lenis', version: '1.1.9', options, evidence: { htmlClass: true }, ...extra });
const page = (tau) => ({ lines: [{ kind: 'smoothing', text: 'Smooth follow of the scroll', values: [{ name: 'tau', value: tau, unit: 'ms', label: 'fitted' }] }] });

test('tau formula: lerp 0.1 -> 1 / (60 x 0.1) s = 166.67 ms', () => {
  assert.ok(Math.abs(lerpToTauMs(0.1) - 166.667) < 0.01); assert.equal(lerpToTauMs(0), null);
});

test('lerp mode: look.json shape, printed line, agreement within 10 %', () => {
  const l = lookLenis(read({ lerp: 0.1, smoothWheel: true, wheelMultiplier: 1, touchMultiplier: 2, orientation: 'vertical', easing: { fn: true, name: 'easing', src: EXPO } }));
  assert.equal(l.found, true); assert.equal(l.mode, 'lerp'); assert.equal(l.version, '1.1.9'); assert.ok(Math.abs(l.tauMs - 166.667) < 0.01);
  assert.equal(l.options.easing.known, true);
  assert.equal(lenisDeclaredText(l), 'Lenis declared 1.1.9: lerp 0.1, wheelMultiplier 1, smoothWheel true [exact]');
  const lines = lenisPageLines(l, page(175));
  assert.match(lines[1], /agrees \(5 % apart\)/);
  assert.match(lenisPageLines(l, page(250))[1], /disagrees \(50 % apart/);
  assert.equal(fittedTauMs(page(175)), 175);
});

test('duration mode: duration + easing printed, no tau comparison', () => {
  const l = lookLenis(read({ duration: 1.2, easing: { fn: true, name: 'e', src: '(t)=>t*t' }, smoothWheel: true }));
  assert.equal(l.mode, 'duration'); assert.equal(l.tauMs, null);
  assert.equal(lenisDeclaredText(l), 'Lenis declared 1.1.9: duration 1.2 s, easing function "(t)=>t*t", smoothWheel true [exact]');
  assert.equal(compareLenisTau(l, 150).state, 'n/a');
  assert.deepEqual(easingName({ fn: true, src: 'Math.min(1,1.001-2**(-10*t))' }).known, true);
});

test('smoothWheel false vs a fitted smoothing disagrees; page text from the page is cleaned and capped', () => {
  const l = lookLenis(read({ lerp: 0.1, smoothWheel: false, easing: { fn: true, src: 'x\u0007'.repeat(300) } }));
  assert.equal(compareLenisTau(l, 160).state, 'disagrees'); assert.equal(compareLenisTau(l, null).state, 'agrees');
  assert.ok(l.options.easing.src.length <= 200); assert.doesNotMatch(l.options.easing.src, /\u0007/);
});

test('not found: why says closure/bundle with the html class, a probe error is a note; nothing printed', () => {
  const a = lookLenis({ probe: 'lenis-probe-1', found: false, evidence: { htmlClass: true } });
  assert.equal(a.found, false); assert.match(a.why, /closure or bundle/);
  assert.match(lookLenis({ found: false, error: 'lenis probe took over 1000 ms' }).why, /took over/);
  assert.match(lookLenis({ probe: 'lenis-probe-1', found: false, evidence: {} }).why, /no Lenis instance/);
  assert.deepEqual(lenisPageLines(a, page(160)), []); assert.equal(lenisLibLine(a), null);
  assert.match(lenisLibLine(lookLenis(read({ lerp: 0.1 }))), /^Lenis \(read from the page\) 1\.1\.9: lerp 0\.1.*; tau 166\.67 ms$/);
});

test('probe source: finds window.lenis and a depth-1 instance, reads data props only, never writes', () => {
  const mk = (options) => { const c = class Lenis {}; const o = new c(); o.options = options; o.animatedScroll = 0; return o; };
  const run = (win) => { const ctx = vm.createContext(Object.defineProperties({ document: { documentElement: { classList: { contains: () => true } } } }, Object.getOwnPropertyDescriptors(win))); ctx.window = ctx; return vm.runInContext(buildLenisProbeSource(), ctx); };
  const a = run({ lenis: mk({ lerp: 0.12, smoothWheel: true, easing: (t) => t }) });
  assert.equal(a.found, true); assert.equal(a.via, 'window.lenis'); assert.equal(a.options.lerp, 0.12); assert.equal(a.options.easing.fn, true); assert.equal(a.evidence.htmlClass, true);
  const b = run({ myApp: { smooth: mk({ duration: 1.5 }) } });
  assert.equal(b.via, 'window.myApp.smooth'); assert.equal(b.options.duration, 1.5);
  // a getter is never invoked
  let hit = 0; const c = run(Object.defineProperty({}, 'lenis', { get() { hit++; return mk({ lerp: 0.1 }); }, enumerable: true }));
  assert.equal(c.found, false); assert.equal(hit, 0);
  assert.equal(run({ x: { options: { foo: 1 } } }).found, false);
});
