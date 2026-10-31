// look x GSAP: declared tweens (synthetic probe reads) joined with the look's fit records, put on the motions and printed
// (pure; no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { lookGsap, attachGsap, gsapLineText, declaredGsapCode } from '../../src/look/gsap.js';

const P = (v) => ({ value: v, provenance: 'fitted' });
const named = (el, desc, channel, ease, D) => ({ target: { el, desc, channel }, tier: 'fitted', model: { family: `named:${ease}`, params: { t0: P(500), D: P(D) }, valid_at: { frame_ms: 1000 / 60 } } });
const tween = (key, o) => ({ key, type: 'tween', parent: 'root', kind: 'to', startTime: 0, duration: 0.8, delay: 0.2, repeat: 0, yoyo: false, timeScale: 1, scale: 1,
  ease: { name: 'power2.out', source: 'vars' }, props: { y: { to: 0 } }, targets: ['DIV.card'], within: [], scrollTrigger: null, ...o });
const read = (at, tweens) => ({ at, probe: 'gsap-probe-1', found: true, via: 'window.gsap', version: '3.12.5', versions: [], expandos: 3, tweens, scrollTriggers: [], errors: [], ms: 4 });
const records = [named(7, 'DIV.card', 'ren:ty', 'easeOutCubic', 800), named(9, 'H1.title', 'ren:tx', 'easeOutCubic', 500)];
const motion = (lead, desc, channel) => ({ rank: lead, desc, lead, ids: [lead], lines: [], exports: [{ channel, family: 'named:easeOutCubic', kind: 'tween',
  exports: [{ lib: 'css', code: '.x {}', accuracy: { label: 'exact' }, match: { word: 'matches fit' } }, { lib: 'gsap', code: 'gsap.fromTo(el, { y: 40 }, { y: 0, duration: 0.8, ease: "power2.out" });', accuracy: { label: 'exact' }, match: { word: 'matches fit' } }] }] });

test('a matched tween: look.json "gsap" is compact, the motion prints the declared values and its gsap code is as declared', async () => {
  const { gsap, doc } = lookGsap([read('load', [tween('k1', {}), tween('k2', { duration: 1.4, targets: ['H1.title'], props: { x: { to: 100 } } })]), read('action', [tween('k1', {})])], records, 'A');
  assert.equal(gsap.found, true); assert.equal(gsap.version, '3.12.5'); assert.equal(gsap.via, 'window.gsap'); assert.equal(gsap.tweens, 2); assert.equal(gsap.ms, 8);
  assert.deepEqual(gsap.summary, { entries: 2, matched: 1, partlyChecked: 0, disagrees: 1, noFit: 0 });
  const ms = attachGsap([motion(7, 'DIV.card', 'ren:ty'), motion(9, 'H1.title', 'ren:tx')], gsap, doc);
  assert.equal(ms[0].gsap[0].text, 'GSAP declared (y): duration 0.8 s, ease power2.out, delay 0.2 s [exact]');
  const gx = ms[0].exports[0].exports.find((x) => x.lib === 'gsap');
  assert.equal(gx.match.word, 'as declared'); assert.equal(gx.code, 'gsap.to(el, { y: 0, duration: 0.8, delay: 0.2, ease: "power2.out" });');
  assert.match(gx.fitted.code, /fromTo/, 'the fitted snippet is kept');
  // a disagreement prints the declared values, says it disagrees, and keeps the fitted export
  assert.match(ms[1].gsap[0].text, /^GSAP declared \(x\): duration 1\.4 s, ease power2\.out, delay 0\.2 s \[exact\]: disagrees with the fit \(duration 500 ms fitted vs 1400 ms declared/);
  assert.equal(ms[1].exports[0].exports.find((x) => x.lib === 'gsap').match.word, 'matches fit');
  // printed under the motion, and the code line says "as declared"
  const { formatLook } = await import('../../src/look/cli.js');
  const t = formatLook({ ok: true, status: 'motion', source: { kind: 'url', url: 'http://localhost/', live: false }, errors: [], warnings: [], timing: { totalMs: 1000 }, take: { frames: 100, rate: 120, watched: 2, net: { misses: 0 } },
    action: { do: 'load', el: null, on: null }, page: null, motions: ms.map((m) => ({ ...m, count: 1, unknowns: [], covered: [], records: [] })), unknowns: [], others: [], alreadyMoving: [], pointerDriven: [], notFitted: [], gsap }, { code: ['gsap'] });
  assert.match(t, /GSAP declared \(y\): duration 0\.8 s, ease power2\.out, delay 0\.2 s \[exact\]/);
  assert.match(t, /-- gsap · ren:ty · as declared\n {3}gsap\.to\(el, \{ y: 0/);
});

test('bundled GSAP (no global): nothing read, look.json says why, no motion line', () => {
  const r = { at: 'load', probe: 'gsap-probe-1', found: false, via: null, versions: ['3.12.5'], expandos: 12, tweens: [], scrollTriggers: [], errors: [], why: 'GSAP runs on this page (12 element _gsap caches, versions 3.12.5) but no global exposes it (bundled build): its declared values cannot be read without patching the page' };
  const { gsap, doc } = lookGsap([r, { ...r, at: 'action' }], records, 'A');
  assert.equal(gsap.found, false); assert.match(gsap.why, /bundled build/); assert.equal(gsap.expandos, 12); assert.equal(gsap.entries, undefined);
  const ms = attachGsap([motion(7, 'DIV.card', 'ren:ty')], gsap, doc);
  assert.equal(ms[0].gsap, undefined); assert.equal(ms[0].exports[0].exports[1].match.word, 'matches fit');
});

test('a probe that failed (timeout) is said, never thrown; a non-literal value writes no declared code', () => {
  const { gsap } = lookGsap([{ at: 'load', found: false, error: 'gsap probe took over 1000 ms', ms: 1000 }], records, 'A');
  assert.equal(gsap.found, false); assert.match(gsap.why, /took over 1000 ms/);
  assert.equal(declaredGsapCode(tween('k', { props: { y: { to: 'function' } } }), 'y'), null);
  assert.equal(declaredGsapCode(tween('k', { kind: 'fromTo', props: { opacity: { from: 0, to: 1 } } }), 'opacity'), 'gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.8, delay: 0.2, ease: "power2.out" });');
  assert.equal(gsapLineText({ prop: 'x', status: 'partly-checked', checked: ['duration'], unchecked: ['ease (elastic eases are not compared)'], declared: { durationMs: 900, ease: 'elastic.out(1,0.3)', delayMs: 0, repeat: -1, yoyo: true } }),
    'GSAP declared (x): duration 0.9 s, ease elastic.out(1,0.3), repeat -1, yoyo [exact] (fit agrees on duration; not checked: ease (elastic eases are not compared))');
});
