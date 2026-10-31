// look x Swiper / Lottie / Locomotive / anime.js: synthetic probe reads -> look.json "declaredLibs", printing, the anime.js
// attach; plus the in-page probe run against a fake window (pure; no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { lookLibs, declaredLibLines, attachAnime, swiperWords, lottieWords, buildLibProbeSource, LIB_PROBE_VERSION } from '../../src/look/libprobe.js';

const sw = (o = {}) => ({ el: 'DIV.swiper', speed: 600, effect: 'slide', slidesPerView: 1, spaceBetween: 0, loop: true, direction: 'horizontal', freeMode: false, autoplay: { delay: 4000, disableOnInteraction: false }, timing: 'ease', timingSource: 'computed', ...o });
const read = (at, o = {}) => ({ at, probe: LIB_PROBE_VERSION, found: true, swiper: [], lottie: [], locomotive: null, anime: [], errors: [], ms: 3, ...o });

test('swiper: words, identical containers print once with a count, load+action reads union', () => {
  const dl = lookLibs([read('load', { swiper: [sw(), sw({ el: 'DIV.swiper.b' })] }), read('action', { swiper: [sw()] })]);
  assert.equal(dl.found, true); assert.equal(dl.swiper.length, 2); assert.equal(dl.ms, 6);
  assert.equal(swiperWords(sw()), 'speed 600 ms, effect slide, loop, autoplay 4 s');
  // the words ignore the element: the two containers are identical declarations
  assert.deepEqual(declaredLibLines(dl), ['Swiper declared: speed 600 ms, effect slide, loop, autoplay 4 s [exact] ×2']);
  assert.match(swiperWords(sw({ timing: 'cubic-bezier(0.4, 0, 0.2, 1)', effect: 'fade', loop: false, autoplay: null })), /timing cubic-bezier.*effect fade|effect fade, timing cubic/);
});

test('lottie: duration from frames, canvas/svg note; dotlottie element', () => {
  const a = { via: 'lottie-web', frameRate: 30, totalFrames: 72, durationS: 2.4, loop: true, autoplay: true, playSpeed: 1 };
  assert.equal(lottieWords(a), '2.4 s at 30 fps, loop');
  const dl = lookLibs([read('load', { lottie: [a, { via: 'element', tag: 'dotlottie-player', srcHost: 'cdn.example.com', loop: false, autoplay: true, playSpeed: 2 }] })]);
  assert.deepEqual(declaredLibLines(dl), ['Lottie declared: 2.4 s at 30 fps, loop [exact] (canvas/svg content is not measured)', 'Lottie declared: dotlottie-player (cdn.example.com), speed 2x [exact] (canvas/svg content is not measured)']);
});

test('locomotive: instance values, else evidence only', () => {
  assert.deepEqual(declaredLibLines(lookLibs([read('load', { locomotive: { via: 'window.scroll', lerp: 0.1, multiplier: 1, smooth: true, direction: 'vertical' } })])), ['Locomotive Scroll declared: lerp 0.1, multiplier 1, smooth, vertical [exact] (window.scroll)']);
  assert.match(declaredLibLines(lookLibs([read('load', { locomotive: { via: null, evidence: 'html.has-scroll-smooth' } })]))[0], /smooth scroll active .*not readable/);
});

test('anime.js: attached under the motion whose element matches, the rest printed in the section', () => {
  const an = (t, o = {}) => ({ durationMs: 800, delay: 100, easing: 'easeOutExpo', loop: false, direction: 'normal', targets: t, targetCount: t.length, ...o });
  const dl = lookLibs([read('load', { anime: [an(['DIV.card.go']), an(['H1.other'], { durationMs: 300 })] })]);
  const ms = [{ rank: 1, desc: 'DIV.card' }, { rank: 2, desc: 'P.none' }];
  const rest = attachAnime(ms, dl);
  assert.deepEqual(ms[0].libDeclared, [{ lib: 'anime', text: 'anime.js declared: duration 800 ms, easing easeOutExpo, delay 100 ms [exact]' }]);
  assert.equal(ms[1].libDeclared, undefined); assert.equal(rest.length, 1);
  assert.deepEqual(declaredLibLines(dl, rest), ['anime.js declared: duration 300 ms, easing easeOutExpo, delay 100 ms [exact]']);
});

test('section is capped at 6 lines; nothing found / failed read -> why, no lines', () => {
  const many = Array.from({ length: 10 }, (_, i) => sw({ speed: 100 + i }));
  const ls = declaredLibLines(lookLibs([read('load', { swiper: many })]));
  assert.equal(ls.length, 6); assert.match(ls[5], /^… 5 more declared/);
  const none = lookLibs([read('load', { found: false, why: 'no Swiper' }), { at: 'action', found: false, error: 'lib probe took over 1000 ms' }]);
  assert.equal(none.found, false); assert.equal(none.error, 'lib probe took over 1000 ms'); assert.deepEqual(declaredLibLines(none), []);
});

test('in-page probe against a fake window: swiper + lottie + anime read, strings cleaned, cheap miss reads nothing', () => {
  const el = { tagName: 'DIV', id: '', classList: ['swiper'], swiper: { params: { speed: 450, effect: 'fade<script>', slidesPerView: 'auto', loop: false, autoplay: { delay: 2500, disableOnInteraction: true } }, wrapperEl: { style: { transitionTimingFunction: 'ease-out' } } }, querySelector: () => null };
  const mk = (extra) => {
    const win = { lottie: { getRegisteredAnimations: () => [{ name: 'x\u0000y', frameRate: 60, totalFrames: 120, loop: true, autoplay: true, playSpeed: 1, animationData: { w: 100, h: 50, layers: [1, 2, 3] }, wrapper: el }] },
      anime: { running: [{ duration: 700, delay: 0, params: { easing: 'spring(1, 80, 10, 0)', loop: 2 }, animatables: [{ target: el }] }] }, ...extra };
    const document = { querySelectorAll: (q) => (/swiper/.test(q) ? [el] : []), documentElement: { classList: { contains: (c) => c === 'has-scroll-smooth' } } };
    return new Function('window', 'document', 'getComputedStyle', 'location', 'URL', `return ${buildLibProbeSource()}`)(win, document, () => ({ transitionTimingFunction: 'ease' }), { href: 'https://a.test/' }, URL);
  };
  const r = mk({});
  assert.equal(r.found, true); assert.equal(r.swiper[0].speed, 450); assert.equal(r.swiper[0].effect, 'fadescript'); assert.equal(r.swiper[0].timing, 'ease-out'); assert.equal(r.swiper[0].timingSource, 'inline');
  assert.equal(r.swiper[0].slidesPerView, 'auto'); assert.equal(r.swiper[0].autoplay.delay, 2500);
  assert.equal(r.lottie[0].durationS, 2); assert.equal(r.lottie[0].name, 'xy'); assert.equal(r.lottie[0].layers, 3);
  assert.equal(r.anime[0].durationMs, 700); assert.equal(r.anime[0].loop, 2); assert.equal(r.anime[0].targets[0], 'DIV.swiper');
  assert.deepEqual(r.locomotive, { via: null, evidence: 'html.has-scroll-smooth' });
});
