// Behaviour-based fallback: known-truth traces generated from the models themselves (own fixtures).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyScrollResponse, analyseBehaviour, detectLibraries, librariesSection } from '../../src/libdetect/index.js';
import { lerpTrace, expoTrace, linearTrace, instantTrace, synthetic as S } from './fixtures.js';

test('per-frame lerp: factor recovered within 5 % of truth for 0.05 / 0.1 / 0.2', () => {
  for (const f of [0.05, 0.1, 0.2]) {
    const c = classifyScrollResponse(lerpTrace({ perFrame: f }));
    assert.equal(c.model, 'exp-approach', `f=${f}`);
    assert.ok(Math.abs(c.perFrameFactor - f) / f < 0.05, `f=${f} got ${c.perFrameFactor}`);
    assert.ok(c.r2 > 0.98);
  }
  assert.equal(classifyScrollResponse(lerpTrace({ perFrame: 0.1 })).matchesLenisDefaultLerp, true);
  assert.equal(classifyScrollResponse(lerpTrace({ perFrame: 0.2 })).matchesLenisDefaultLerp, false);
});

test('frame-rate independent: a lerp measured at 120 Hz reports the same tau as at 60 Hz', () => {
  const tau = (c) => c.tauMs;
  const a = classifyScrollResponse(lerpTrace({ perFrame: 0.1, frameMs: 1000 / 60, frames: 150 }));
  // same physical decay sampled at 120 Hz: per-frame factor 1 - (1 - 0.1)^(1/2)
  const b = classifyScrollResponse(lerpTrace({ perFrame: 1 - Math.sqrt(0.9), frameMs: 1000 / 120, frames: 300 }));
  assert.ok(Math.abs(tau(a) - tau(b)) / tau(a) < 0.06, `${tau(a)} vs ${tau(b)}`);
});

test('duration-based expo.out also reads as an exponential approach: the family is the honest answer, not the library', () => {
  const c = classifyScrollResponse(expoTrace({ duration: 1200 }));
  assert.equal(c.model, 'exp-approach');
  assert.ok(c.tauMs > 140 && c.tauMs < 210, `tau ${c.tauMs}`); // analytic 1200 / (10 ln 2) = 173 ms
});

test('linear, instant and too-short traces are not reported as smooth scroll', () => {
  assert.equal(classifyScrollResponse(linearTrace()).model, 'other');
  assert.equal(classifyScrollResponse(instantTrace()).model, 'instant');
  assert.equal(classifyScrollResponse({ samples: [{ t: 0, y: 0 }, { t: 16, y: 5 }] }).model, 'insufficient');
  const unsettled = lerpTrace({ perFrame: 0.1, frames: 20 }); // still moving at the end
  assert.equal(classifyScrollResponse(unsettled).model, 'insufficient');
  assert.match(classifyScrollResponse(unsettled).reason, /did not settle/);
  assert.equal(analyseBehaviour({ scrollResponse: linearTrace() }).families.length, 0);
  assert.equal(analyseBehaviour({ scrollResponse: linearTrace() }).notes[0].model, 'other');
});

test('behaviour families carry candidates and what cannot be separated', () => {
  const b = analyseBehaviour({
    scrollResponse: lerpTrace({ perFrame: 0.1 }),
    animations: [{ easing: 'linear(0, 0.2, 0.5, 0.8, 0.95, 1.02, 1.01, 1, 1)' }, { easing: 'cubic-bezier(.2,0,0,1)' }],
    fits: [{ model: 'spring', params: { k: 100 } }, { model: 'ema', target: 'scroll' }, { model: 'ema', target: 'cursor' }, { model: 'expo.out' }],
    webgl: { continuousDrawing: true },
  });
  const names = b.families.map(f => f.family).sort();
  assert.deepEqual(names, ['generated-easing', 'js-spring', 'js-tween', 'smooth-scroll', 'webgl-render-loop']);
  for (const f of b.families) { assert.equal(f.status, 'behaviour-hint'); assert.equal(f.provenance, 'inferred'); assert.ok(f.candidates.length >= 1 && f.can_not_separate.length > 10); }
  // an EMA on the cursor is not a scroll smoother
  const sm = b.families.find(f => f.family === 'smooth-scroll');
  assert.equal([].concat(sm.evidence).filter(e => e.kind === 'fit').length, 1);
});

test('fallback: nothing in the bundle, behaviour says smooth scroll -> a family hint, no library, an unknown with a probe', () => {
  const r = detectLibraries({ modules: [{ id: 'app.js', source: S.appCode }], behaviour: { scrollResponse: lerpTrace({ perFrame: 0.1 }) } });
  assert.deepEqual(r.libraries.filter(l => l.status !== 'hint').map(l => l.id), []);
  assert.deepEqual(r.libraries.filter(l => l.id === 'lenis' && l.status !== 'hint'), [], 'behaviour alone must not name Lenis');
  const f = r.families.find(x => x.family === 'smooth-scroll');
  assert.equal(f.state, 'behaviour_only'); assert.deepEqual(f.covered_by, []);
  assert.ok(f.candidates.includes('lenis'));
  const u = r.unknowns.find(x => x.id === 'unk_libdetect_family_smooth-scroll');
  assert.ok(u && u.probe && u.reason);
  assert.match(librariesSection(r).markdown, /behaviour only, no signature matched/);
});

test('behaviour corroborates a weak signature but never creates a detection', () => {
  const weak = 'var x="lenis";'; // the bare word: weight 1 = hint
  const without = detectLibraries({ modules: [{ id: 'a.js', source: weak }] });
  assert.equal(without.libraries.find(l => l.id === 'lenis').status, 'hint');
  const withB = detectLibraries({ modules: [{ id: 'a.js', source: weak }], behaviour: { scrollResponse: lerpTrace() } });
  const l = withB.libraries.find(x => x.id === 'lenis');
  assert.equal(l.status, 'probable');
  assert.ok(l.evidence.some(e => e.where === 'behaviour' && /corroborates only/.test(e.note)));
  // and the family is then explained by a (probable) signature match only when >= probable
  assert.equal(withB.families[0].state, 'explained_by_signature');
  // behaviour with no other evidence for any candidate adds no library at all
  const none = detectLibraries({ modules: [{ id: 'a.js', source: 'var y=1' }], behaviour: { scrollResponse: lerpTrace() } });
  assert.equal(none.libraries.length, 0);
});

test('a detected signature explains the family; the family stays listed', () => {
  const r = detectLibraries({ modules: [{ id: 'l.js', source: S.lenis }], behaviour: { scrollResponse: lerpTrace() } });
  const f = r.families.find(x => x.family === 'smooth-scroll');
  assert.equal(f.state, 'explained_by_signature'); assert.deepEqual(f.covered_by, ['lenis']);
  assert.ok(!r.unknowns.some(u => u.id === 'unk_libdetect_family_smooth-scroll'));
});
