// look: pure parts (no browser): source resolution, ranking + folding + channel filter, declared split, plain lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSource } from '../../src/look/source.js';
import { elementStats, chooseChannels, planFit, splitDeclaredTransform, selectorFromDesc, cssEscape, entrySelector, renderedTransformStill, matrixOf, matrixChanges } from '../../src/look/select.js';
import { describeRecord, describeElement, describeStagger, labelOf, canonicalFamily, springPreset } from '../../src/look/words.js';
import { parseTrigger, wheelUntil, exportWord } from '../../src/look/index.js';
import { clipParts, extractSeries, baseKey, numOf } from '../../src/analysis/fit/series.js';
import { numericOf } from '../../src/score/series.js';
import { selectorHint, where } from '../../src/look/cli.js';
import { fitOptsFromFlags } from '../../src/analysis/fit/cli.js';

test('source: live URL, local URL, archive folder, run folder, target file, unknown id', () => {
  assert.deepEqual(resolveSource('https://example.com/a'), { kind: 'url', url: 'https://example.com/a', live: true });
  assert.equal(resolveSource('http://localhost:8080/').live, false);
  assert.equal(resolveSource('http://127.0.0.1/x').live, false);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'look-src-'));
  try {
    const arch = path.join(d, 'run', 'archive'); fs.mkdirSync(path.join(d, 'run', 'motion'), { recursive: true }); fs.mkdirSync(arch);
    const t = { id: 't1', archive: arch, startUrl: 'https://example.com/', classes: { A: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } }, seed: 1 };
    fs.writeFileSync(path.join(arch, 'target.json'), JSON.stringify(t));
    fs.writeFileSync(path.join(d, 'run', 'motion', 'takes.json'), JSON.stringify([{ name: 'A-load', cls: 'A', rate: 60 }]));
    const a = resolveSource(arch);
    assert.equal(a.kind, 'archive'); assert.equal(a.archive, arch); assert.equal(a.rate, 60, 'rate from the corpus run (rateFor result)');
    assert.equal(resolveSource(path.join(d, 'run')).archive, arch, 'run folder -> its archive');
    assert.equal(resolveSource(path.join(arch, 'target.json')).target.id, 't1');
    assert.throws(() => resolveSource(arch, { cls: 'E' }), /no viewport class "E"/);
    assert.throws(() => resolveSource(d), /not an archive/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  assert.throws(() => resolveSource('no-such-target-id-xyz'), /not a URL, a folder or a known target id/);
});

test('selector from descriptor; css escaping (Tailwind-style classes)', () => {
  assert.equal(selectorFromDesc('DIV#rail.Card_track__A1b2'), 'div#rail.Card_track__A1b2');
  assert.equal(selectorFromDesc('DIV.dot.md:hidden.on'), 'div.dot.md\\:hidden.on');
  assert.equal(selectorFromDesc('SPAN'), 'span');
  assert.equal(cssEscape('1col'), '\\31 col');
});

// rows for a small synthetic take: el 0 fades + moves (big), els 1-4 the same descriptor (a stagger), el 5 only rides the scroll
function rows() {
  const out = []; const dt = 1000 / 120;
  for (let k = 0; k < 240; k++) {
    const T = k * dt; const sy = k > 120 ? (k - 120) * 10 : 0; const v = {};
    const p = Math.min(1, Math.max(0, (T - 100) / 500));
    v[0] = { 'ren:ty': 40 * (1 - p), 'ren:opacity': p, 'ren:transform': `matrix(1,0,0,1,0,${40 * (1 - p)})`, 'drv:transform': `translateY(${40 * (1 - p)}px)`, 'ren:bx': 100, 'ren:by': 100 + 40 * (1 - p) - sy, 'ren:bw': 600, 'ren:bh': 300 };
    for (let i = 1; i <= 4; i++) { const q = Math.min(1, Math.max(0, (T - 200 - 60 * i) / 300)); v[i] = { 'ren:ty': 10 * (1 - q), 'ren:opacity': q, 'ren:bx': 100 + 80 * i, 'ren:by': 500 + 10 * (1 - q) - sy, 'ren:bw': 60, 'ren:bh': 20 }; }
    v[5] = { 'ren:ty': 0, 'ren:opacity': 1, 'ren:bx': 0, 'ren:by': 700 - sy, 'ren:bw': 1440, 'ren:bh': 100 };
    out.push({ k, T, sy, sx: 0, v });
  }
  return out;
}
const ELS = ['DIV#hero', 'SPAN.word', 'SPAN.word', 'SPAN.word', 'SPAN.word', 'FOOTER.site'];

test('ranking by visual weight, folding repeated elements, scroll-only boxes are not motion', () => {
  const stats = elementStats({ rows: rows(), ids: [0, 1, 2, 3, 4, 5], dt: 1000 / 120, viewport: { width: 1440, height: 900 } });
  assert.ok(stats.get(5).moving.has('ren:by'), 'the footer moves on screen');
  assert.ok(!stats.get(5).docMoving.has('ren:by'), '... but only with the page scroll');
  const plan = planFit({ stats, els: ELS, candidates: [0, 1, 2, 3, 4, 5], top: 5, action: 'scroll' });
  assert.equal(plan.entries.length, 2, 'hero + the folded words; the scroll-riding footer is not an entry');
  assert.equal(plan.entries[0].desc, 'DIV#hero');
  const g = plan.entries[1]; assert.equal(g.kind, 'group'); assert.equal(g.count, 4); assert.deepEqual(g.ids, [1, 2, 3, 4], 'members in start order');
  assert.ok(Math.abs(plan.entries.reduce((a, e) => a + e.weightShare, 0) - 1) < 1e-9);
  // channel filter: string mirrors dropped, boxes dropped when a transform channel moves
  assert.deepEqual([...plan.entries[0].channels].sort(), ['ren:opacity', 'ren:ty']);
  // members get the lead's primary channel only; lead gets all its channels
  assert.ok(g.memberChannel === 'ren:ty' || g.memberChannel === 'ren:opacity');
  assert.equal(plan.onlyKeys.filter((k) => k.endsWith('|' + g.memberChannel) && g.ids.includes(+k.split('|')[0]) && +k.split('|')[0] !== g.lead).length, 3);
  // aimed at the footer on a scroll: its box only rides the page (layout), so it is not fitted (against the scroll it read
  // the page's own smoothing as the footer's law); the entry stays, with no channel to fit
  const aimed = planFit({ stats, els: ELS, candidates: [5], aimed: true, action: 'scroll' });
  assert.equal(aimed.entries.length, 1);
  assert.deepEqual(aimed.entries[0].channels, []);
  // ... on a load / hover / click the aimed box stays the evidence
  assert.deepEqual(planFit({ stats, els: ELS, candidates: [5], aimed: true, action: 'load' }).entries[0].channels, ['ren:by']);
  // budget: 3 channels in total -> the rest is listed, not dropped silently
  const small = planFit({ stats, els: ELS, candidates: [0, 1, 2, 3, 4], action: 'load', maxChannels: 3 });
  assert.equal(small.onlyKeys.length, 3); assert.ok(small.notFitted.length >= 3);
  assert.ok(small.notFitted.every((n) => /channel budget 3/.test(n.reason)));
});

test('pin plausibility keeps ren:by on a scroll action', () => {
  const rs = []; for (let k = 0; k < 120; k++) { const sy = k * 50; const by = sy < 1000 ? 800 - sy : sy < 2000 ? -200 : -200 - (sy - 2000); rs.push({ k, T: k * 8.33, sy, sx: 0, v: { 0: { 'ren:tx': sy > 1000 && sy < 2000 ? -(sy - 1000) : sy >= 2000 ? -1000 : 0, 'ren:by': by, 'ren:bx': 0, 'ren:bw': 3000, 'ren:bh': 400 } } }); }
  const st = elementStats({ rows: rs, ids: [0], dt: 8.33, viewport: { width: 1440, height: 900 } }).get(0);
  assert.equal(st.pinPlausible, true);
  assert.deepEqual(chooseChannels(st, { action: 'scroll', aimed: true }).sort(), ['ren:by', 'ren:tx']);
  assert.deepEqual(chooseChannels(st, { action: 'load', aimed: true }), ['ren:tx']);
});

test('declared transform transition: translate parts deferred to a second pass', () => {
  const births = [{ name: 'transform', type: 'CSSTransition', tgt: 'SPAN.badge', keyframes: [{ transform: 'rotate(-4deg)' }, { transform: 'rotate(-9deg) scale(1.3) translate(-3px, -1px)' }] }];
  const r = splitDeclaredTransform(['3|ren:rz', '3|ren:sx', '3|ren:tx', '3|ren:ty', '4|ren:tx'], births, ['', '', '', 'SPAN.badge', 'DIV.other']);
  assert.deepEqual(r.first, ['3|ren:rz', '3|ren:sx', '4|ren:tx']);
  assert.deepEqual(r.deferred, ['3|ren:tx', '3|ren:ty']);
  // only translate moving: nothing deferred (it must be fitted now)
  assert.deepEqual(splitDeclaredTransform(['3|ren:tx'], births, ['', '', '', 'SPAN.badge']).deferred, []);
});

const P = (value, provenance = 'fitted', unit = null) => ({ value, provenance, unit });
const rec = (o) => ({ schema: 'reva.motion/0', target: { el: 1, desc: 'DIV.a', channel: 'ren:ty' }, attribution: { label: 'time-driven' }, tier: 'fitted', derived: {}, unknowns: [], ...o });

test('labels: declared -> exact, fitted/measured -> fitted, unknown/withheld -> unknown', () => {
  assert.equal(labelOf('declared'), 'exact'); assert.equal(labelOf('measured'), 'fitted'); assert.equal(labelOf('fitted'), 'fitted'); assert.equal(labelOf('unknown'), 'unknown'); assert.equal(labelOf(undefined), 'unknown');
  assert.equal(canonicalFamily('ema'), 'smoothing'); assert.equal(canonicalFamily('dtdamp'), 'smoothing', 'ema and dtdamp are one curve at a fixed dt');
});

test('plain lines: spring, tween, declared, smoothing, scroll map, pin, unknown, ambiguous, stagger', () => {
  const sp = describeRecord(rec({ class: 'spring', model: { family: 'spring', params: { omega: P(13.2), zeta: P(0.33) } }, derived: { settle99: 1104 } }));
  assert.match(sp.text, /^Spring, clearly bouncy \(overshoots 33\.\d+ % \[fitted\]\); settles in 1104 ms \[fitted\]/);
  // stiffness / damping come from the fitter's own k, c: absent (or withheld) -> unknown with the reason, never "fitted"
  assert.match(sp.text, /stiffness 174\.2 \[unknown\], damping 8\.712 \[unknown\], mass 1/);
  assert.match(sp.text, /\(unknown: library value depends on the integrator/);
  const spk = describeRecord(rec({ class: 'spring', model: { family: 'spring', params: { omega: P(13.2), zeta: P(0.33), k: P(174.24), c: P(8.712) } } }));
  assert.match(spk.text, /stiffness 174\.2 \[fitted\], damping 8\.712 \[fitted\], mass 1/);
  const gentle = describeRecord(rec({ class: 'spring', model: { family: 'spring', params: { omega: P(10.95), zeta: P(0.64), k: P(119.9), c: P(14.02) } } }));
  assert.match(gentle.text, /≈ react-spring gentle/);
  // a cursor-spring record: ω, ζ fitted, k, c withheld -> no "≈ preset within x %" claim
  const W = (v, reason) => ({ value: null, withheld_value: v, provenance: 'unknown', reason });
  const lu = describeRecord(rec({ class: 'spring', model: { family: 'spring', params: { omega: P(11), zeta: P(0.65), k: W(121, 'identified set disagrees on (k, c) by more than 2 %'), c: W(14.3, 'identified set disagrees on (k, c) by more than 2 %') } } }));
  assert.match(lu.text, /ω 11 rad\/s \[fitted\], ζ 0\.65 \[fitted\]; stiffness 121 \[unknown\], damping 14\.3 \[unknown\]/);
  assert.doesNotMatch(lu.text, /≈|\[fitted\], damping/); assert.match(lu.text, /close to react-spring gentle .*\[unknown/); assert.match(lu.text, /disagrees on \(k, c\) by more than 2 %/);
  // withheld ω, ζ: every [unknown] carries its reason
  const ho = describeRecord(rec({ class: 'spring', model: { family: 'spring', params: { omega: W(9.5, 'holdout failed'), zeta: W(1.4, 'holdout failed') } } }));
  assert.match(ho.text, /ω 9\.5 rad\/s \[unknown\], ζ 1\.4 \[unknown\]/); assert.match(ho.text, /\(unknown: holdout failed/);
  assert.equal(springPreset(10, 1.5), null);
  const tw = describeRecord(rec({ class: 'tween', model: { family: 'named:easeOutQuint', params: { D: P(700, 'fitted', 'ms') } } }));
  assert.equal(tw.text, 'Tween, easeOutQuint (= GSAP power4.out) [fitted], 700 ms [fitted]');
  const bz = describeRecord(rec({ class: 'tween', model: { family: 'bezier', params: { D: P(912.4), x1: P(0.3), y1: P(0.01), x2: P(0.6), y2: P(0.002) } } }));
  assert.match(bz.text, /^Tween, cubic-bezier\(0\.3, 0\.01, 0\.6, 0\.002\) \[fitted\], 912\.4 ms \[fitted\]$/);
  const dc = describeRecord(rec({ tier: 'declared', class: 'declared', target: { el: 1, desc: 'SPAN.s', channel: 'ren:rz' }, declared: { births: [{ type: 'CSSTransition' }] },
    model: { family: 'declared:css', params: { duration: P(150, 'declared', 'ms'), delay: P(0, 'declared', 'ms'), easing: P('ease', 'declared'), iterations: P(1, 'declared'), keyframeValues: P([-4.00001, -9.00001], 'measured') } } }));
  assert.equal(dc.text, 'CSS transition: 150 ms [exact], ease [exact], rotation -4 → -9 [fitted]');
  assert.equal(dc.label, 'exact');
  const sm = describeRecord(rec({ class: 'first-order smoothing', attribution: { label: 'scroll-linked' }, model: { family: 'dtdamp', valid_at: { refresh_hz: 120 }, driver: { kind: 'wheel' }, params: { tau_ms: P(166.66, 'fitted', 'ms'), alpha_per_frame: P(0.04877) } } }));
  assert.match(sm.text, /^Smooth follow of the scroll, time constant 166\.7 ms \[fitted\], = lerp 0\.1 \[fitted\] per 60 Hz frame \(Lenis default 0\.1\), closes 4\.877 % \[fitted\] of the gap each 120 Hz frame$/);
  const map = describeRecord(rec({ class: 'scroll map', target: { el: 1, desc: 'DIV#t', channel: 'ren:tx' }, model: { family: 'scroll map (linear)', params: { mapS0: P(1500) }, map: { shape: 'linear', a: -1.2e-32, b: -640, s0_px: 1500.1, s1_px: 2140.1, s0_provenance: 'fitted', s1_provenance: 'fitted' } } }));
  assert.equal(map.text, 'Scroll-linked (scrubbed): x 0 [fitted] → -640 [fitted] while the page scrolls 1500 px [fitted] → 2140 px [fitted], linear');
  // a map whose driver is the pointer (model.driver) never says "while the page scrolls"
  const pm = describeRecord(rec({ class: 'scroll map', target: { el: 1, desc: 'P.dot', channel: 'ren:tx' }, model: { family: 'scroll map (linear)', driver: { kind: 'pointer', axis: 'x' }, params: { mapS0: P(2) }, map: { shape: 'linear', a: 2, b: 943, s0_px: 2, s1_px: 945 } } }));
  assert.match(pm.text, /^Pointer-linked: x 2 \[fitted\] → 945 \[fitted\] while the pointer x moves 2 px/);
  // a two-level switch on pointer input is an instant change on hover, never 'pointer-linked … linear'
  const ps = describeRecord(rec({ class: 'step', target: { el: 1, desc: 'A.btn', channel: 'ren:op' }, model: { family: 'step (two-level, on pointer input)', driver: { kind: 'pointer', axis: 'x' }, params: { before: P(0, 'measured'), after: P(1, 'measured') } } }));
  assert.match(ps.text, /^Instant change when the pointer arrives: 0 → 1/); assert.doesNotMatch(ps.text, /linked|linear/);
  const pin = describeRecord(rec({ class: 'scroll map', model: { family: 'pin (moves with the scroll, held over the pin range)', params: {}, pin: { start: { value: 1500.1 }, end: { value: 2140.1 } } } }));
  assert.match(pin.text, /^Pinned: held in place while the page scrolls 1500 px \[fitted\] → 2140 px \[fitted\]$/);
  // a missing value never prints as "null px"
  const pinN = describeRecord(rec({ class: 'scroll map', model: { family: 'pin (moves with the scroll, held over the pin range)', params: {}, pin: { start: { value: null }, end: { value: 1477 } } } }));
  assert.doesNotMatch(pinN.text, /null/); assert.match(pinN.text, /\? px \[unknown\] → 1477 px \[fitted\]/); assert.match(pinN.text, /\(unknown: /);
  // one recording rate: the smoothing line says its frame-rate behaviour is unknown
  const sm1 = describeRecord(rec({ class: 'first-order smoothing', model: { family: 'ema (targets from holds)', valid_at: { refresh_hz: 120 }, driver: { kind: 'pointer' }, params: { tau_ms: P(40), alpha_per_frame: P(0.19) } } }), { oneRate: 120 });
  assert.match(sm1.text, /frame-rate behaviour \[unknown\]/); assert.match(sm1.text, /recorded at 120 Hz only/);
  // asym with one direction seen reads as the same smoothing (stable across ema / dtdamp / asym labels), Lenis hint kept
  const as = describeRecord(rec({ class: 'first-order smoothing', model: { family: 'asym', valid_at: { refresh_hz: 120 }, driver: { kind: 'wheel' }, params: { alphaDown: P(0.04877223), alphaUp: { value: null, provenance: 'fitted' } } } }));
  assert.equal(as.kind, 'smoothing');
  assert.match(as.text, /^Smooth follow of the scroll, time constant 166\.7 ms \[fitted\], = lerp 0\.1 \[fitted\] per 60 Hz frame \(Lenis default 0\.1\)/);
  assert.match(as.text, /only falling values were seen, the rising direction \[unknown\].*not exercised in this take/);
  const un = describeRecord(rec({ tier: 'unexplained', class: 'unknown', model: { family: 'unexplained', params: {} }, unknowns: [{ reason: 'no family explains', probe: 'more takes' }] }));
  assert.equal(un.text, 'moves, but no model explains it [unknown]: no family explains (to resolve: more takes)'); assert.equal(un.label, 'unknown');
  const amb = describeRecord(rec({ tier: 'unknown', class: 'unknown', ambiguity: { candidates: [{ family: 'named:easeOutCubic' }, { family: 'ema' }] },
    model: { family: 'named:easeOutCubic', params: { D: { value: null, provenance: 'unknown', withheld_value: 800, reason: 'ambiguous class' } } } }));
  assert.match(amb.text, /800 ms \[unknown\]; ambiguous between named:easeOutCubic \/ ema \[unknown\] \(unknown: ambiguous class\)$/);
  const st = describeStagger({ members: ['1|ren:ty|0', '2|ren:ty|20', '3|ren:ty|40'], interval: { value: 20, provenance: 'fitted' }, constantStep: true, residual_ms: 0.0004, direction: { value: 'dom', provenance: 'fitted' } }, 20);
  assert.equal(st.text, 'Stagger: 3 of 20 start one after another, every 20 ms [fitted], constant step, in dom order');
  // never "k of N" with k > N: members are distinct elements, capped at the group size
  const st2 = describeStagger({ members: ['1|ren:ty|0', '1|ren:opacity|0', '2|ren:ty|20', '3|ren:ty|40', '4|ren:ty|60', '5|ren:ty|80'], interval: { value: 20, provenance: 'fitted' }, constantStep: true, direction: { value: 'dom' } }, 3);
  assert.match(st2.text, /^Stagger: 3 of 3 /);
});

test('element lines: channels of one motion merge; one declared transition is one line with its travels', () => {
  const sp = (ch, t0, w) => rec({ target: { el: 1, desc: 'DIV.b', channel: ch }, class: 'spring', model: { family: 'spring', params: { omega: P(w), zeta: P(0.4) } }, derived: { t0 } });
  const lines = describeElement([sp('ren:tx', 100, 12), sp('drv:transform', 100, 12.001), sp('ren:tx', 600, 12.002)]);
  assert.equal(lines.length, 1); assert.deepEqual([...new Set(lines[0].channels)], ['ren:tx', 'drv:transform']); assert.equal(lines[0].times, 2);
  const dec = (ch, kv) => rec({ tier: 'declared', class: 'declared', target: { el: 1, desc: 'S', channel: ch }, declared: { births: [{ type: 'CSSTransition' }] }, derived: { t0: 575 },
    model: { family: 'declared:css', params: { duration: P(150, 'declared'), easing: P('ease', 'declared'), keyframeValues: P(kv, 'measured') } } });
  const d = describeElement([dec('ren:sx', [1, 1.2]), dec('ren:sy', [1, 1.2]), dec('ren:rz', [-4, -9])]);
  assert.equal(d.length, 1);
  assert.equal(d[0].text, 'CSS transition: 150 ms [exact], ease [exact], rotation -4 → -9 [fitted], scale 1 → 1.2 [fitted]');
  // the action fills in a trigger the frames alone could not attribute
  const u = describeElement([rec({ attribution: { label: 'unknown' }, class: 'spring', model: { family: 'spring', params: { omega: P(12), zeta: P(0.4) } }, derived: { t0: 900 } })], { fallbackTrigger: (t) => (t > 500 ? 'starts after the click' : null) });
  assert.equal(u[0].trigger, 'starts after the click');
});

test('triggers, wheel stop expression, fit CLI options', () => {
  assert.deepEqual(parseTrigger('720,450'), { point: { x: 720, y: 450 } });
  assert.deepEqual(parseTrigger('point:10, 20'), { point: { x: 10, y: 20 } });
  assert.deepEqual(parseTrigger('a[href="/max"]'), { selector: 'a[href="/max"]' });
  const ex = wheelUntil(['#a']); assert.doesNotThrow(() => new Function(`return ${ex}`)); assert.match(ex, /"#a"/);
  assert.deepEqual(fitOptsFromFlags({ only: 'DIV.a|ren:ty,SPAN', 'max-channels': '5', 'eval-budget': '1e8', 'early-exit': true }), { only: ['DIV.a|ren:ty', 'SPAN'], maxChannels: 5, evalBudget: 1e8, earlyExit: true });
  assert.deepEqual(fitOptsFromFlags({}), {});
});

test('export words: matches fit / as declared / unknown model / smoothing at one rate', () => {
  const x = (label, extra = {}) => ({ lib: 'motion', code: 'x', accuracy: { label }, ...extra });
  assert.equal(exportWord(rec({ class: 'spring', model: { family: 'spring', params: { omega: P(10), zeta: P(1.5) } } }), { kind: 'spring' }, x('exact')).word, 'matches fit');
  assert.equal(exportWord(rec({ tier: 'declared', model: { family: 'declared:css', params: {} } }), { kind: 'tween' }, x('exact')).word, 'as declared');
  const w = exportWord(rec({ tier: 'unknown', model: { family: 'spring', params: { omega: { value: null, withheld_value: 9.5, provenance: 'unknown', reason: 'holdout failed' }, zeta: P(1.5) } } }), { kind: 'spring' }, x('exact'));
  assert.equal(w.word, 'unknown model'); assert.match(w.why, /holdout failed/);
  const sm = exportWord(rec({ model: { family: 'ema', params: { tau_ms: P(40), lambda: { value: null, provenance: 'unknown' } } } }), { kind: 'smoothing' }, x('exact', { lib: 'raf' }), 120);
  assert.equal(sm.word, 'matches fit at 120 Hz'); assert.match(sm.why, /frame-rate behaviour unknown/);
  assert.equal(exportWord(rec({ model: { family: 'spring', params: {} } }), { kind: 'spring' }, { lib: 'lenis', code: null, accuracy: { label: 'not representable in lenis', why: 'second order' } }).word, 'n/a');
});

test('clip-path parts: a wipe on a side other than the first number becomes its own channel', () => {
  assert.deepEqual(clipParts('inset(0% 0% 0.1456%)'), { top: 0, right: 0, bottom: 0.1456, left: 0 });
  assert.deepEqual(clipParts('inset(10px round 4px)'), { top: 10, right: 10, bottom: 10, left: 10 });
  assert.deepEqual(clipParts('polygon(0% 0%, 100% 50%)'), { p0: 0, p1: 0, p2: 100, p3: 50 });
  assert.equal(clipParts('none'), null);
  assert.equal(baseKey('15|ren:clipPath.bottom'), '15|ren:clipPath'); assert.equal(baseKey('15|ren:ty'), '15|ren:ty');
  const rows = []; for (let k = 0; k < 30; k++) rows.push({ k, T: k * 8.33, sy: 0, sx: 0, v: { 7: { 'ren:clipPath': k === 0 ? 'inset(0%)' : `inset(0% 0% ${(k * 3.3).toFixed(2)}%)` } } });
  const S = extractSeries({ rows, elements: { 7: 'DIV.wipe' } });
  const keys = S.series.map((s) => s.key);
  assert.ok(keys.includes('7|ren:clipPath'), 'the first-number channel stays (unchanged for every other caller)');
  assert.ok(keys.includes('7|ren:clipPath.bottom')); assert.ok(!keys.includes('7|ren:clipPath.left') && !keys.includes('7|ren:clipPath.right'));
  assert.equal(S.series.find((s) => s.key === '7|ren:clipPath.bottom').y.at(-1), 95.7);
});

test('scroll action: a cursor follower chasing the parked pointer is left out of the ranking', () => {
  const rs = []; for (let k = 0; k < 60; k++) { const f = Math.min(1, k / 20); rs.push({ k, T: k * 8.33, sy: k * 10, sx: 0, v: {
    0: { 'ren:tx': 0, 'ren:bx': -1000 + f * (1720 - 20), 'ren:by': -1000 + f * (1450 - 20), 'ren:bw': 40, 'ren:bh': 40 },
    1: { 'ren:ty': -k, 'ren:bx': 100, 'ren:by': 300 - k, 'ren:bw': 400, 'ren:bh': 300, 'ren:opacity': 1 } } }); }
  const stats = elementStats({ rows: rs, ids: [0, 1], dt: 8.33, viewport: { width: 1440, height: 900 }, pointer: { x: 720, y: 450 } });
  assert.equal(stats.get(0).followsPointer, true); assert.equal(stats.get(1).followsPointer, false);
  const plan = planFit({ stats, els: ['DIV.cursor', 'DIV.card'], candidates: [0, 1], action: 'scroll' });
  assert.deepEqual(plan.entries.map((e) => e.desc), ['DIV.card']); assert.deepEqual(plan.pointerDriven.map((p) => p.desc), ['DIV.cursor']);
  assert.equal(planFit({ stats, els: ['DIV.cursor', 'DIV.card'], candidates: [0], aimed: true, action: 'scroll' }).entries.length, 1, 'aimed at it: kept');
});

test('numbers in transform strings: the 3 of translate3d / matrix3d / scale3d is a name, not a value', () => {
  assert.equal(numOf('translate3d(0px, 0px, 0px)'), 0);
  assert.equal(numOf('translate(0px, 0px)'), 0);
  assert.equal(numOf('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)'), 1);
  assert.equal(numOf('scale3d(1.2, 1.2, 1)'), 1.2);
  assert.equal(numOf('translate3d(-12.5px, 3px, 0px)'), -12.5);
  for (const [v, n] of [['12px', 12], ['blur(3px)', 3], ['inset(4%)', 4], ['-0.5', -0.5], ['.25px', 0.25], ['1e-5', 1e-5], ['translateY(-20.5px)', -20.5], ['rotate(45deg)', 45]]) assert.equal(numOf(v), n, v);
  assert.equal(numericOf('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 40, 0, 0, 1)', 'ren:transform', 12), 40, 'score: 16 entries, not 17');
  // GSAP force3D "auto": translate3d(0px, 0px, 0px) -> translate(0px, 0px) at a tween's end: one constant series, no step
  const rows = [0, 1, 2, 3].map((k) => ({ k, T: k * 8.33, sy: 0, sx: 0, v: { 7: { 'drv:transform': k < 2 ? 'translate3d(0px, 0px, 0px)' : 'translate(0px, 0px)' } } }));
  const s = extractSeries({ rows, elements: { 7: 'DIV.x' } }).series.find((x) => x.ch === 'drv:transform');
  assert.deepEqual(s.y, [0, 0, 0, 0]);
});

test('rendered transform still: a string that switches forms while ren:tx..skx stay put is not motion', () => {
  const TF0 = { 'ren:tx': 0, 'ren:ty': 0, 'ren:tz': 0, 'ren:sx': 1, 'ren:sy': 1, 'ren:rz': 0, 'ren:skx': 0 };
  const rows = (ty) => [0, 1, 2, 3].map((k) => ({ k, T: k * 8.33, v: { 3: { ...TF0, 'ren:ty': ty(k), 'drv:transform': k < 2 ? 'translate3d(0px, 0px, 0px)' : 'translate(0px, 0px)' } } }));
  assert.equal(renderedTransformStill(rows(() => 0), 3), true);
  assert.equal(renderedTransformStill(rows((k) => k), 3), false, 'a real move');
  assert.equal(renderedTransformStill([{ k: 0, T: 0, v: { 3: { 'drv:transform': 'none' } } }], 3), false, 'no rendered parts recorded: unknown, not still');
});

test('rendered transform still: the whole matrix decides; a perspective zoom (m34, m44) is motion', () => {
  assert.deepEqual(matrixOf('none'), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.deepEqual(matrixOf('matrix(1, 0, 0, 1, 0, 0)'), matrixOf('none'), 'none and the identity are the same transform');
  assert.deepEqual(matrixOf('matrix(2, 0, 0, 2, 10, 20)'), [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1]);
  assert.equal(matrixOf('translateX(3px)'), null);
  // perspective(d) translateZ(200px): a, b, c, d and m41..m43 stay put (so do ren:tx..skx); m34 = -1/d, m44 = 1 - 200/d
  const TF0 = { 'ren:tx': 0, 'ren:ty': 0, 'ren:tz': 200, 'ren:sx': 1, 'ren:sy': 1, 'ren:rz': 0, 'ren:skx': 0 };
  const persp = (d) => `matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, ${-1 / d}, 0, 0, 200, ${1 - 200 / d})`;
  const zoom = [1000, 800, 600, 400].map((d, k) => ({ k, T: k * 8.33, v: { 3: { ...TF0, 'ren:transform': persp(d), 'drv:transform': `perspective(${d}px) translateZ(200px)` } } }));
  assert.equal(renderedTransformStill(zoom, 3), false, 'the 7 parts are still, the matrix is not');
  assert.deepEqual(matrixChanges(zoom, 3), ['m34', 'm44']);
  const forms = [0, 1, 2, 3].map((k) => ({ k, T: k * 8.33, v: { 3: { ...TF0, 'ren:tz': 0, 'ren:transform': k < 2 ? 'none' : 'matrix(1, 0, 0, 1, 0, 0)', 'drv:transform': k < 2 ? 'translate3d(0px, 0px, 0px)' : 'translate(0px, 0px)' } } }));
  assert.equal(renderedTransformStill(forms, 3), true, 'none -> identity matrix: still');
  assert.deepEqual(matrixChanges(forms, 3), []);
  const odd = [{ k: 0, T: 0, v: { 3: { ...TF0, 'ren:transform': 'none' } } }, { k: 1, T: 8, v: { 3: { ...TF0, 'ren:transform': 'something else' } } }];
  assert.equal(renderedTransformStill(odd, 3), false, 'a rendered transform it cannot read is never called still');
});

test('selector of nodes that left the page: the successors when the descriptor still matches, else the real reason', () => {
  // [unique selector | null, descriptor matches now, 1 = the node left the page]
  const sels = new Map([[1, [null, 4, 1]], [2, [null, 32, 1]], [3, [null, 0, 1]], [4, [null, 1, 1]], [5, [null, 9, 1]], [6, [null, 0]], [7, [null, 3, 0]]]);
  assert.deepEqual(entrySelector({ kind: 'group', count: 4, lead: 1, desc: 'DIV.tile.in' }, sels),
    { selector: 'div.tile.in', matches: 4, gone: true, why: 'the original nodes were replaced; this matches their successors' });
  const more = entrySelector({ kind: 'group', count: 30, lead: 2, desc: 'DIV.absolute.aspect-square' }, sels);
  assert.equal(more.selector, 'div.absolute.aspect-square'); assert.match(more.why, /replaced; this matches 32 elements now/);
  // a removed preloader: nothing has these classes now, but --el aims at the matches during the take
  const left = entrySelector({ kind: 'group', count: 5, lead: 3, desc: 'SPAN.word' }, sels);
  assert.deepEqual(left, { selector: 'span.word', matches: null, gone: true, why: 'these 5 elements left the page before the take ended; this selector names them while on the page (--el watches its matches during the take)' });
  const leftBare = entrySelector({ kind: 'group', count: 5, lead: 3, desc: 'SPAN' }, sels);
  assert.equal(leftBare.selector, null); assert.equal(leftBare.why, 'these 5 elements left the page before the take ended');
  assert.deepEqual(entrySelector({ kind: 'element', count: 1, lead: 4, desc: 'DIV#hero' }, sels),
    { selector: 'div#hero', matches: 1, gone: true, why: 'the original node was replaced; this matches its successor' });
  const bare = entrySelector({ kind: 'element', count: 1, lead: 5, desc: 'DIV' }, sels);
  assert.equal(bare.selector, null, 'a bare tag is never offered'); assert.equal(bare.why, 'the element left the page before the take ended ("div" matches 9 now)');
  assert.match(entrySelector({ kind: 'element', count: 1, lead: 6, desc: 'DIV.x' }, sels).why, /^the element left the page/, 'older takes: 0 matches = gone');
  assert.equal(entrySelector({ kind: 'element', count: 1, lead: 7, desc: 'DIV.x' }, sels).why, 'no selector matches only this element', 'connected: the real reason');
  assert.equal(selectorHint({ rank: 1, desc: 'DIV.tile.in', ...entrySelector({ kind: 'group', count: 4, lead: 1, desc: 'DIV.tile.in' }, sels) }), '(div.tile.in: the original nodes were replaced; this matches their successors)');
  assert.equal(selectorHint({ rank: 3, desc: 'SPAN.word', ...left }), '(span.word: these 5 elements left the page before the take ended; this selector names them while on the page (--el watches its matches during the take))');
  assert.equal(selectorHint({ rank: 3, desc: 'SPAN', ...leftBare }), `(these 5 elements left the page before the take ended; or --pick 'SPAN')`);
});

test('selector to print: unique per element, exact or counted for a group, never a bare tag; rows told apart', () => {
  const sels = new Map([[1, ['body > div:nth-of-type(3)', 40]], [2, [null, 40]], [3, ['span.word', 8]], [4, [null, 240]], [5, ['#a > span.char:nth-of-type(1)', 20]]]);
  assert.deepEqual(entrySelector({ kind: 'element', count: 1, lead: 1, desc: 'DIV' }, sels), { selector: 'body > div:nth-of-type(3)', matches: 1, why: null });
  const none = entrySelector({ kind: 'element', count: 1, lead: 2, desc: 'DIV', rank: 2 }, sels);
  assert.equal(none.selector, null); assert.match(none.why, /no selector matches only this element/);
  assert.equal(entrySelector({ kind: 'element', count: 1, lead: 9, desc: 'DIV' }, sels).why, 'no selector was recorded for this element');
  assert.deepEqual(entrySelector({ kind: 'group', count: 8, lead: 3, desc: 'SPAN.word' }, sels), { selector: 'span.word', matches: 8, why: null });
  const bare = entrySelector({ kind: 'group', count: 16, lead: 4, desc: 'DIV' }, sels);
  assert.equal(bare.selector, null, 'a bare tag matches every div: never offered');
  assert.equal(bare.leadSelector, null);
  assert.equal(selectorHint({ rank: 2, desc: 'DIV', ...bare, leadSelector: 'body > div:nth-of-type(3)' }), '(no selector matches only these 16 elements ("div" matches 240); one of them: body > div:nth-of-type(3))', 'never a --pick rank: ranks change between runs');
  const more = entrySelector({ kind: 'group', count: 12, lead: 5, desc: 'SPAN.char' }, sels);
  assert.equal(more.selector, 'span.char'); assert.equal(more.matches, 20); assert.match(more.why, /matches 20 elements; 12 of them moved/);
  assert.equal(selectorHint({ rank: 2, desc: 'DIV', ...none }), `(no selector matches only this element; or --pick 'DIV')`, 'the stable key, not the rank');
  assert.equal(selectorHint({ rank: 1, selector: 'body > div:nth-of-type(3)', selectorMatches: 1, selectorWhy: null }), '(body > div:nth-of-type(3))');
  assert.equal(where({ box: { x: 10, y: 20, w: 300, h: 40 } }), 'at 10,20 (300×40)');
  // planFit carries the selector and the on-screen box at the first move (two same-descriptor elements: two entries)
  const R = [0, 1, 2].map((k) => ({ k, T: k * 8.33, sy: 0, sx: 0, v: { 1: { 'ren:ty': k * 10, 'ren:bx': 0, 'ren:by': 100, 'ren:bw': 500, 'ren:bh': 500 }, 2: { 'ren:ty': k * 5, 'ren:bx': 600, 'ren:by': 100, 'ren:bw': 500, 'ren:bh': 500 } } }));
  const stats = elementStats({ rows: R, ids: [1, 2], dt: 8.33, viewport: { width: 1440, height: 900 } });
  const plan = planFit({ stats, els: ['', 'DIV', 'DIV'], candidates: [1, 2], action: 'load', sels });
  assert.equal(plan.entries.length, 2);
  assert.deepEqual(plan.entries.map((e) => e.selector), ['body > div:nth-of-type(3)', null]);
  assert.deepEqual(plan.entries.map((e) => e.box.x), [0, 600]);
});

test('group selector matching fewer elements than moved (a class changed during the take): never "matches 5; 8 of them moved" (recheck item 3)', () => {
  const sels = new Map([[1, ['div.a > div:nth-of-type(1)', 5, 0]], [2, ['div.b', 12, 0]], [3, [null, 8, 0]]]);
  const few = entrySelector({ kind: 'group', count: 8, lead: 1, desc: 'DIV.card' }, sels);
  assert.equal(few.selector, null); assert.equal(few.leadSelector, 'div.a > div:nth-of-type(1)');
  assert.equal(few.why, '"div.card" matches only 5 of the 8 elements that moved (a class changed during the take)');
  const many = entrySelector({ kind: 'group', count: 8, lead: 2, desc: 'DIV.card' }, sels);
  assert.equal(many.selector, 'div.card'); assert.equal(many.why, 'matches 12 elements; 8 of them moved');
  assert.deepEqual(entrySelector({ kind: 'group', count: 8, lead: 3, desc: 'DIV.card' }, sels), { selector: 'div.card', matches: 8, why: null });
});

test('look text: the network-miss count shows only for an archive replay (a live or local page has no miss counter)', async () => {
  const { formatLook } = await import('../../src/look/cli.js');
  const base = { ok: true, status: 'motion', errors: [], warnings: [], timing: { totalMs: 1000 }, take: { frames: 100, rate: 120, watched: 10, net: { misses: 2 } },
    action: { do: 'load', el: null, on: null }, page: null, motions: [], unknowns: [], others: [], alreadyMoving: [], pointerDriven: [], notFitted: [] };
  assert.doesNotMatch(formatLook({ ...base, source: { kind: 'url', url: 'https://example.com/', live: true } }), /network miss/);
  assert.doesNotMatch(formatLook({ ...base, source: { kind: 'url', url: 'http://localhost/', live: false } }), /network miss/);
  assert.match(formatLook({ ...base, source: { kind: 'archive', startUrl: 'https://example.com/' } }), /· 2 network miss\(es\)/);
});

// ---------- default text (recheck items 7, 13, 14) ----------
const lookResult = (motions, extra = {}) => ({ ok: true, status: 'motion', input: 'x', source: 'url', url: 'http://localhost/', errors: [], warnings: [], timing: { totalMs: 1000 },
  take: { frames: 100, rate: 120, watched: 10, net: { misses: 0 } }, action: { do: 'scroll', el: null, on: null, wheels: 40, stoppedEarly: true },
  page: null, motions, unknowns: [], others: [], alreadyMoving: [], pointerDriven: [], notFitted: [], ...extra });
const row = (rank, desc, box, w, more = {}) => ({ rank, kind: 'element', desc, selector: `${desc.toLowerCase()}:nth-of-type(${rank})`, count: 1, lead: rank, box, weightShare: w, lines: [], unknowns: [], covered: [], exports: [], records: [], ...more });
test('look text: same descriptor in the same box says which one; tiny rows of a long list fold; an empty top-N says why; the scroll stop names the page bottom', async () => {
  const { formatLook } = await import('../../src/look/cli.js');
  const B = { x: 40, y: 378, w: 1360, h: 144 };
  const t = formatLook(lookResult([row(1, 'DIV', B, 0.6), row(2, 'DIV', B, 0.3)]));
  assert.match(t, /1 {2}DIV at 40,378 \(1360×144\) \(1 of 2 here\)/); assert.match(t, /2 {2}DIV at 40,378 \(1360×144\) \(2 of 2 here\)/);
  assert.match(t, /\(stopped at the bottom of the page\)/, 'nothing aimed: not "once the element left"');
  const many = [row(1, 'SECTION', B, 0.9), ...Array.from({ length: 12 }, (_, i) => row(i + 2, 'SPAN', { x: i, y: 0, w: 1, h: 1 }, 0.0001))];
  const tm = formatLook(lookResult(many));
  assert.match(tm, /12 more row\(s\) under 0\.1 % of the visual weight \(ranks 2-13\): SPAN/); assert.doesNotMatch(tm, /\n5 {2}SPAN/);
  const empty = formatLook(lookResult([], { page: { lines: [{ kind: 'scroll map', text: 'x' }], unknowns: [], exports: [] }, alreadyMoving: [{ desc: 'DIV.loop', selector: 'div.loop' }] }));
  assert.match(empty, /No element moved on its own during this scroll: what moved went with the page scroll \(the page row above\); 1 element\(s\) are listed apart below\./);
  assert.doesNotMatch(empty, /chosen element/);
  assert.match(empty, /already moving before the scroll .*: div\.loop \(--el <selector> looks at one\)/);
  const aimedEmpty = formatLook(lookResult([], { action: { do: 'hover', el: '#x', on: null } }));
  assert.match(aimedEmpty, /No motion found on the chosen element\(s\) during this hover\./);
});
test('look text: on a hover top-N led by an intro, the reader is told rank 1 is not the hover response (recheck item 10)', async () => {
  const { formatLook } = await import('../../src/look/cli.js');
  const own = { text: 'Tween, 600 ms', label: 'fitted', trigger: 'plays on its own time', channels: ['ren:ty'] }; const ptr = { text: 'Smooth follow', label: 'fitted', trigger: 'reacts to the pointer', channels: ['ren:tx'] };
  const r = lookResult([row(1, 'DIV.loader', null, 0.7, { lines: [own] }), row(2, 'DIV.cursor', null, 0.3, { lines: [ptr] })], { action: { do: 'hover', el: null, on: '720,450' } });
  assert.match(formatLook(r), /! rank 1 plays on its own time \(an intro or loader running during the take\), not in response to the hover; rank 2 responds to it/);
  r.motions[0].lines = [ptr]; assert.doesNotMatch(formatLook(r), /rank 1 plays on its own time/);
});
