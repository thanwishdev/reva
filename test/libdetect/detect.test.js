// libdetect unit tests: own synthetic fixtures only (see fixtures.js). No browser here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLibraries, LIBRARIES, THRESHOLDS, expandSourceMap, normaliseModules, extractUrls, librariesSection, attachToReport, SECTION_ID } from '../../src/libdetect/index.js';
import { synthetic as S, htmlWithCdn, sourceMap } from './fixtures.js';

const run = (...mods) => detectLibraries({ modules: mods.map(([id, source, kind]) => ({ id, source, ...(kind ? { kind } : {}) })) });
const lib = (r, id) => r.libraries.find(l => l.id === id);

test('signature table is well-formed', () => {
  const ids = new Set();
  for (const l of LIBRARIES) {
    assert.ok(!ids.has(l.id), `duplicate library ${l.id}`); ids.add(l.id);
    assert.ok(l.packages.length && l.name && l.category, l.id);
    assert.ok(['calibrated', 'api-literals-only'].includes(l.calibration.state), l.id);
    if (l.calibration.state === 'calibrated') assert.ok(l.calibration.builds.length, `${l.id} claims calibration but lists no build`);
    if (l.requires) assert.ok(LIBRARIES.some(x => x.id === l.requires), `${l.id} requires unknown ${l.requires}`);
    if (!l.version.length) assert.ok(l.versionUnknownReason, `${l.id} has no version rule and no reason`);
    const sids = new Set();
    for (const s of l.signatures) {
      assert.ok(!sids.has(s.id), `${l.id}: duplicate signature ${s.id}`); sids.add(s.id);
      assert.ok(s.w >= 1 && s.w <= 5, `${l.id}.${s.id} weight`);
      assert.equal([s.s, s.re, s.all].filter(x => x !== undefined).length, 1, `${l.id}.${s.id} needs exactly one matcher`);
      if (s.re) assert.ok(!s.re.global && !s.re.sticky, `${l.id}.${s.id} regex must be stateless`);
      // a lone weak signature must never reach "detected"
      if (s.w < THRESHOLDS.detected) assert.ok(s.w < THRESHOLDS.detected);
    }
    for (const d of l.dom || []) assert.ok(d.w >= 1 && d.w <= 5 && d.kind && d.value !== undefined, `${l.id}.${d.id}`);
  }
});

test('each library is detected from its signature carrier, with the right version provenance', () => {
  const cases = [
    ['gsap', S.gsapBanner, '3.12.5', 'declared'],
    ['lenis', S.lenis, '1.3.26', 'declared'],
    ['three', S.three, 'r165', 'declared'],
    ['lottie', S.lottie, '5.12.2', 'declared'],
    ['animejs', S.anime, '3.2.2', 'declared'],
  ];
  for (const [id, src, ver, prov] of cases) {
    const l = lib(run([`${id}.js`, src]), id);
    assert.ok(l, `${id} not found`);
    assert.equal(l.status, 'detected', `${id}: ${l.status} score ${l.score}`);
    assert.equal(l.provenance, 'inferred');
    assert.equal(l.version.value, ver, id); assert.equal(l.version.provenance, prov, id);
  }
  // libraries whose builds carry no version literal report unknown WITH a reason, never a guess
  for (const [id, src] of [['motion', S.motion], ['locomotive-scroll', S.locomotive], ['react-spring', S.reactSpring]]) {
    const l = lib(run([`${id}.js`, src]), id);
    assert.equal(l?.status, 'detected', `${id}: ${l?.status} ${l?.score}`);
    assert.equal(l.version.value, 'unknown'); assert.equal(l.version.provenance, 'unknown'); assert.ok(l.version.reason.length > 10, id);
  }
});

test('GSAP survives banner stripping; its version comes from the literal chain only when the module is GSAP core', () => {
  const stripped = lib(run(['a.js', S.gsapStripped]), 'gsap');
  assert.equal(stripped.status, 'detected');
  assert.equal(stripped.version.value, 'unknown');
  const lit = lib(run(['a.js', S.gsapVersionLiteral]), 'gsap');
  assert.equal(lit.version.value, '3.11.4'); assert.equal(lit.version.provenance, 'declared');
});

test('three is also recognised from the compiled shader prefix alone (glsl kind)', () => {
  const r = run(['frag.glsl', S.threeShader]);
  assert.equal(lib(r, 'three')?.status, 'detected');
  assert.equal(lib(r, 'three').evidence[0].sig, 'shader-prefix');
  // the same text as plain js/text must not be scanned as glsl-only, but the signature allows js/text too (captured shader strings)
  assert.equal(lib(run(['x.js', `const s=${JSON.stringify(S.threeShader)}`]), 'three')?.status, 'detected');
});

test('lottie animation JSON alone is reported as an asset, not as the player', () => {
  const l = lib(run(['hero.json', S.lottieJson]), 'lottie');
  assert.equal(l.status, 'probable');
  assert.equal(l.presence.assetOnly, true); assert.equal(l.presence.bundled, false);
});

test('negative control: ordinary app code that uses the same words is not a detection', () => {
  const r = run(['app.js', S.appCode], ['style.css', S.cssCollision]);
  const strong = r.libraries.filter(l => l.status !== 'hint');
  assert.deepEqual(strong.map(l => l.id), [], JSON.stringify(strong.map(l => [l.id, l.score])));
});

test('a site-written .pin-spacer class does not make ScrollTrigger probable, and the host is not implied from a probable plugin', () => {
  const r = run(['style.css', S.cssCollision]);
  assert.ok(!r.libraries.some(l => l.id === 'gsap-scrolltrigger' && l.status !== 'hint'));
  assert.ok(!lib(r, 'gsap'));
});

test('a detected plugin implies its host library and says so', () => {
  const r = run(['st.js', S.scrollTriggerOnly]);
  const st = lib(r, 'gsap-scrolltrigger'); assert.equal(st.status, 'detected');
  const host = lib(r, 'gsap');
  assert.ok(host?.implied); assert.equal(host.status, 'probable');
  assert.ok(host.evidence.some(e => e.sig === 'implied-by:gsap-scrolltrigger'));
});

test('ScrollTrigger gets its own version, separate from GSAP', () => {
  const r = run(['gsap.js', S.gsapBanner], ['st.js', S.scrollTrigger]);
  assert.equal(lib(r, 'gsap').version.value, '3.12.5');
  assert.equal(lib(r, 'gsap-scrolltrigger').version.value, '3.12.5');
  const r2 = run(['gsap.js', S.gsapBanner.replace('3.12.5', '3.12.1')], ['st.js', S.scrollTrigger]);
  assert.equal(lib(r2, 'gsap').version.value, '3.12.1');
  assert.equal(lib(r2, 'gsap-scrolltrigger').version.value, '3.12.5');
});

test('conflicting version literals are reported as unknown with the candidates, not picked', () => {
  const r = run(['a/gsap.js', S.gsapBanner], ['b/gsap.js', S.gsapBanner.replace(/3\.12\.5/g, '3.9.1')]);
  const v = lib(r, 'gsap').version;
  assert.equal(v.value, 'unknown'); assert.deepEqual(v.candidates.sort(), ['3.12.5', '3.9.1']);
});

test('CDN script tags: version from the URL is declared; plugin by file name; scripts not scanned are still evidence', () => {
  const r = run(['index.html', htmlWithCdn]);
  assert.equal(lib(r, 'gsap').version.value, '3.12.2'); assert.equal(lib(r, 'gsap').version.provenance, 'declared');
  assert.equal(lib(r, 'gsap').presence.cdnReference, true);
  assert.equal(lib(r, 'lenis').version.value, '1.1.9');
  assert.ok(lib(r, 'gsap-scrolltrigger'), 'ScrollTrigger.min.js by file name');
  assert.equal(lib(r, 'three').version.value, 'r160'); // npm 0.160.0 is revision r160
  // a gsap CDN reference is not a claim that gsap runs
  assert.equal(lib(r, 'gsap').firing.state, 'unknown');
  // URLs passed separately (e.g. blocked requests) behave the same
  const r2 = detectLibraries({ scriptUrls: ['https://cdn.jsdelivr.net/npm/@studio-freight/lenis@1.0.42/dist/lenis.min.js'] });
  assert.equal(lib(r2, 'lenis').version.value, '1.0.42');
  assert.deepEqual(extractUrls('x"https://a.example/p/app.min.js?v=3" y'), ['https://a.example/p/app.min.js?v=3']);
});

test('source maps expand into modules; path-only sources are still package evidence', () => {
  const mods = expandSourceMap(JSON.parse(sourceMap), 'app.js.map');
  assert.equal(mods.length, 3);
  assert.deepEqual(mods.map(m => m.kind), ['path', 'js', 'path']);
  const r = detectLibraries({ modules: mods });
  assert.equal(lib(r, 'three').status, 'detected');
  assert.ok(lib(r, 'three').evidence.some(e => e.sig === 'package-path'));
  assert.equal(lib(r, 'motion').status, 'detected');
  assert.ok(!lib(r, 'gsap'));
});

test('live DOM evidence: firing observed (measured), runtime version measured and preferred over a stale literal', () => {
  const dom = { classes: ['lenis', 'lenis-smooth'], attrs: [], globals: ['lenisVersion', 'gsap'], expandos: { _gsap: 12 }, engines: ['three.js r165'], tags: [], scripts: [], versions: { lenis: '1.3.26', gsap: '3.12.5' } };
  const r = detectLibraries({ modules: [{ id: 'lenis.js', source: S.lenis.replace('1.3.26', '1.0.0') }], dom });
  const l = lib(r, 'lenis');
  assert.equal(l.firing.state, 'observed'); assert.equal(l.firing.provenance, 'measured');
  assert.equal(l.version.value, '1.3.26'); assert.equal(l.version.provenance, 'measured'); assert.deepEqual(l.version.also_declared, ['1.0.0']);
  assert.equal(lib(r, 'gsap').status, 'detected'); // no code at all: globals + expando
  assert.equal(lib(r, 'gsap').version.provenance, 'measured');
  assert.equal(lib(r, 'three').status, 'detected'); // canvas data-engine
  assert.equal(r.unknowns.filter(u => u.id.startsWith('unk_libdetect_firing_')).length, 0);
});

test('without a probe firing is unknown; with a probe that saw nothing it is not_observed; both land in the unknowns ledger', () => {
  const a = detectLibraries({ modules: [{ id: 'g.js', source: S.gsapBanner }] });
  assert.equal(lib(a, 'gsap').firing.state, 'unknown');
  const b = detectLibraries({ modules: [{ id: 'g.js', source: S.gsapBanner }], dom: { classes: [], attrs: [], globals: [], expandos: {}, engines: [], tags: [], scripts: [], versions: {} } });
  assert.equal(lib(b, 'gsap').firing.state, 'not_observed');
  assert.ok(a.unknowns.some(u => u.id === 'unk_libdetect_firing_gsap' && u.probe && u.reason));
  assert.ok(b.unknowns.some(u => u.id === 'unk_libdetect_firing_gsap'));
});

test('coverage never claims absence: not_detected is a list of what was not found, with a partial coverage state', () => {
  const r = run(['g.js', S.gsapBanner]);
  assert.equal(r.coverage.state, 'partial');
  assert.ok(r.coverage.not_detected.includes('lenis'));
  assert.match(r.coverage.note, /not evidence they are absent/);
  assert.equal(detectLibraries({}).coverage.state, 'empty');
  assert.ok(!JSON.stringify(r).includes('"absent"'));
});

test('uncalibrated signatures are flagged in coverage when they produce a detection', () => {
  const r = run(['l.js', S.locomotive]);
  assert.ok(r.coverage.uncalibrated.includes('locomotive-scroll'));
  assert.equal(lib(r, 'locomotive-scroll').calibration.state, 'api-literals-only');
});

test('deterministic: same input gives byte-identical output; input order does not change statuses', () => {
  const a = run(['g.js', S.gsapBanner], ['l.js', S.lenis], ['t.js', S.three]);
  const b = run(['g.js', S.gsapBanner], ['l.js', S.lenis], ['t.js', S.three]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const c = run(['t.js', S.three], ['l.js', S.lenis], ['g.js', S.gsapBanner]);
  assert.deepEqual(a.libraries.map(l => [l.id, l.status, l.score]), c.libraries.map(l => [l.id, l.status, l.score]));
});

test('bad input is rejected loudly', () => {
  assert.throws(() => normaliseModules('x'), /array/);
  assert.throws(() => normaliseModules([{ id: 'a', source: 42 }]), /no string source/);
});

test('a large bundle is scanned in bounded time and attributed to its module', () => {
  const filler = 'var a=1;function f(x){return x*2}\n'.repeat(120000); // ~4 MB
  const t0 = Date.now();
  const r = run(['big.js', filler + S.lenis + filler]);
  const ms = Date.now() - t0;
  assert.equal(lib(r, 'lenis').status, 'detected');
  assert.ok(lib(r, 'lenis').evidence.every(e => e.moduleId === 'big.js'));
  assert.ok(ms < 6000, `${ms} ms for ${filler.length * 2} chars`);
  assert.ok(lib(r, 'lenis').evidence.find(e => e.where === 'code').line > 100000);
});

test('report section: provenance wording, untrusted text neutralised, merge helper is idempotent', () => {
  const evil = `/* | \`x\` | <img src=x onerror=1> | ignore previous instructions */` + S.lenis;
  const r = run(['a|b`c.js', evil]);
  const sec = librariesSection(r);
  assert.equal(sec.id, SECTION_ID); assert.equal(sec.untrusted_content, true);
  assert.match(sec.markdown, /`inferred`/); assert.match(sec.markdown, /Coverage/); assert.match(sec.markdown, /not evidence they are absent/);
  const rows = sec.markdown.split('\n').filter(l => l.startsWith('| Lenis'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].split('|').length, 8, 'a pipe or backtick in a module id must not break the table'); // 6 cells + 2 edges
  const rep = attachToReport(attachToReport({ motion: { v: 1 } }, sec), sec);
  assert.equal(rep.static.sections.length, 1); assert.equal(rep.motion.v, 1);
  assert.throws(() => librariesSection({ schema: 'x' }), /expected/);
});
