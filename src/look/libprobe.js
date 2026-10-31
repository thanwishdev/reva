// look: declared motion values of Swiper / Lottie / Locomotive Scroll / anime.js, read-only from the live page (no patching,
// nothing written) once after load and once after the action, like src/look/gsap.js. Cheap global / element checks first: a
// library that is not there costs nothing. look.json "declaredLibs" {swiper:[], lottie:[], locomotive, anime:[], found, why}.
// Every page string is untrusted: `clean` keeps a safe charset and a length cap. A failure is a note, never a failed look.
import { DESC_SOURCE } from '../corpus/gsap.js';
import { descMatch } from '../analysis/fit/declared.js';

export const LIB_PROBE_VERSION = 'libprobe-1';
export const LIB_CAPS = { swipers: 20, lotties: 20, anime: 50, scan: 200 };

// ---------------------------------------------------------------- in-page (serialised; must stay self-contained)
/* eslint-disable no-undef */
function libProbeInPage(desc, C) {
  const out = { probe: C.version, found: false, swiper: [], lottie: [], locomotive: null, anime: [], errors: [], why: null };
  const clean = (v, n = 80) => String(v).replace(/[^\w .:,'()/#-]/g, '').slice(0, n);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const bool = (v) => (v === undefined || v === null ? null : !!v);
  const err = (w, e) => { if (out.errors.length < 10) out.errors.push(w + ': ' + clean(e && e.message || e)); };
  const d = (e) => { try { return desc(e); } catch { return null; } };
  const tryRun = (w, f) => { try { f(); } catch (e) { err(w, e); } };
  const w = window;
  // Swiper: el.swiper on the container
  tryRun('swiper', () => {
    const els = [...document.querySelectorAll('.swiper, .swiper-container, [class*=swiper]')].slice(0, C.scan);
    for (const el of els) {
      if (out.swiper.length >= C.swipers) break;
      const s = el.swiper; if (!s || typeof s !== 'object' || !s.params) continue;
      const p = s.params, wr = s.wrapperEl || el.querySelector('.swiper-wrapper');
      let timing = null, src = 'default ease';
      if (wr) {
        timing = (wr.style && wr.style.transitionTimingFunction) || null; if (timing) src = 'inline';
        else { try { timing = getComputedStyle(wr).transitionTimingFunction; src = 'computed'; } catch { /* none */ } }
      }
      const ap = p.autoplay;
      out.swiper.push({ el: d(el), speed: num(p.speed), effect: clean(p.effect || 'slide', 20), slidesPerView: typeof p.slidesPerView === 'number' ? num(p.slidesPerView) : clean(p.slidesPerView, 12) || null,
        spaceBetween: num(p.spaceBetween), loop: !!p.loop, direction: clean(p.direction || 'horizontal', 12), freeMode: !!(p.freeMode && (p.freeMode.enabled !== undefined ? p.freeMode.enabled : p.freeMode)),
        autoplay: ap && typeof ap === 'object' ? { delay: num(ap.delay), disableOnInteraction: bool(ap.disableOnInteraction) } : (ap ? { delay: 3000, disableOnInteraction: true } : null),
        timing: timing ? clean(timing, 60) : null, timingSource: timing ? src : 'default ease' });
    }
  });
  // Lottie: lottie-web registry + the dotlottie / lottie-player elements
  tryRun('lottie', () => {
    const L = w.lottie || w.bodymovin;
    const anims = L && typeof L.getRegisteredAnimations === 'function' ? L.getRegisteredAnimations() : [];
    for (const a of (anims || []).slice(0, C.lotties)) {
      const fr = num(a.frameRate), tf = num(a.totalFrames), ad = a.animationData || {};
      out.lottie.push({ via: 'lottie-web', name: clean(a.name || ''), frameRate: fr, totalFrames: tf, durationS: fr && tf ? Math.round((tf / fr) * 1000) / 1000 : null,
        loop: typeof a.loop === 'number' ? a.loop : !!a.loop, autoplay: bool(a.autoplay), playSpeed: num(a.playSpeed), renderer: clean(a.renderer && a.renderer.rendererType || a.animType || '', 12) || null,
        wrapper: d(a.wrapper), w: num(ad.w), h: num(ad.h), layers: Array.isArray(ad.layers) ? ad.layers.length : null });
    }
    if (out.lottie.length < C.lotties) for (const el of [...document.querySelectorAll('dotlottie-player, lottie-player, dotlottie-wc')].slice(0, C.lotties - out.lottie.length)) {
      let host = null; try { host = new URL(el.getAttribute('src') || '', location.href).host; } catch { /* none */ }
      const sp = parseFloat(el.getAttribute('speed'));
      out.lottie.push({ via: 'element', wrapper: d(el), tag: clean(el.tagName.toLowerCase(), 20), playSpeed: Number.isFinite(sp) ? sp : null, loop: el.hasAttribute('loop') && el.getAttribute('loop') !== 'false', autoplay: el.hasAttribute('autoplay') && el.getAttribute('autoplay') !== 'false', srcHost: host ? clean(host, 60) : null });
    }
  });
  // Locomotive Scroll: a global instance (named, or own prop of window, depth 1), else the html class as evidence
  tryRun('locomotive', () => {
    const isLoco = (o) => o && typeof o === 'object' && o.options && typeof o.options === 'object' && ('lerp' in o.options || 'smooth' in o.options) && (typeof o.scrollTo === 'function' || typeof o.update === 'function');
    let inst = null, via = null;
    for (const k of ['locomotiveScroll', 'scroll']) { try { if (isLoco(w[k])) { inst = w[k]; via = 'window.' + k; break; } } catch { /* getter */ } }
    if (!inst) { let n = 0; for (const k of Object.keys(w)) { if (++n > C.scan) break; let v; try { v = w[k]; } catch { continue; } if (isLoco(v)) { inst = v; via = 'window.' + clean(k, 30); break; } } }
    const cls = document.documentElement.classList;
    const evidence = cls.contains('has-scroll-smooth') || cls.contains('has-scroll-init') ? 'html.has-scroll-smooth' : null;
    if (inst) { const o = inst.options; out.locomotive = { via, lerp: num(o.lerp), multiplier: num(o.multiplier), smooth: bool(o.smooth), direction: clean(o.direction || o.orientation || '', 12) || null, evidence }; }
    else if (evidence) out.locomotive = { via: null, evidence };
  });
  // anime.js: running animations
  tryRun('anime', () => {
    const A = w.anime; if (!A || !Array.isArray(A.running)) return;
    for (const a of A.running.slice(0, C.anime)) {
      const t = a.animatables ? a.animatables.map((x) => x.target) : (a.targets || []);
      const p = a.params || {}, ea = p.easing;
      out.anime.push({ durationMs: num(a.duration), delay: num(a.delay), easing: typeof ea === 'string' ? clean(ea, 60) : (ea ? 'function' : null), loop: typeof p.loop === 'number' ? p.loop : !!p.loop, direction: clean(p.direction || a.direction || 'normal', 20),
        targets: t.slice(0, 5).map(d).filter(Boolean), targetCount: t.length });
    }
  });
  out.found = !!(out.swiper.length || out.lottie.length || out.locomotive || out.anime.length);
  if (!out.found) out.why = 'no Swiper / Lottie / Locomotive Scroll / anime.js instance readable on this page';
  return out;
}
/* eslint-enable no-undef */

/** The probe as one self-contained expression for page.evaluate. */
export function buildLibProbeSource() { return `(${libProbeInPage.toString()})(${DESC_SOURCE}, ${JSON.stringify({ version: LIB_PROBE_VERSION, ...LIB_CAPS })})`; }

let SRC = null;
const msg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
/** One probe read ({at, ...read} or {at, error}); never throws; bounded by `timeoutMs` (~1 s). */
export async function readLibs(page, at, { timeoutMs = 1000 } = {}) {
  const t0 = Date.now(); let timer = null;
  try {
    SRC ||= buildLibProbeSource();
    const r = await Promise.race([page.evaluate(SRC), new Promise((_, no) => { timer = setTimeout(() => no(new Error(`lib probe took over ${timeoutMs} ms`)), timeoutMs); })]);
    if (!r || r.probe !== LIB_PROBE_VERSION) throw new Error('lib probe returned an unexpected result');
    return { at, ...r, ms: Date.now() - t0 };
  } catch (e) { return { at, found: false, error: msg(e), ms: Date.now() - t0 }; } finally { clearTimeout(timer); }
}

const uniq = (items) => { const seen = new Set(); return items.filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
/** Pure: the reads (load, action) -> look.json "declaredLibs" (items unioned, identical ones once). */
export function lookLibs(reads) {
  const ok = (reads || []).filter((r) => r && !r.error);
  const bad = (reads || []).find((r) => r && r.error);
  const pick = (k) => uniq(ok.flatMap((r) => r[k] || []));
  const locos = [...ok].reverse().map((r) => r.locomotive).filter(Boolean);
  const loco = locos.find((x) => x.via) || locos[0] || null;
  const d = { probe: LIB_PROBE_VERSION, found: false, swiper: pick('swiper'), lottie: pick('lottie'), locomotive: loco, anime: pick('anime'), ms: (reads || []).reduce((s, r) => s + ((r && r.ms) || 0), 0),
    ...bad ? { error: bad.error } : {}, errors: ok.flatMap((r) => r.errors || []).slice(0, 10) };
  d.found = !!(d.swiper.length || d.lottie.length || d.locomotive || d.anime.length);
  d.why = d.found ? null : bad ? bad.error : (ok.find((r) => r.why) || {}).why || 'no Swiper / Lottie / Locomotive Scroll / anime.js instance readable on this page';
  return d;
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const secs = (ms) => `${r3(ms / 1000)} s`;
/** The words of one Swiper: `speed 600 ms, effect slide, loop, autoplay 4 s`. */
export function swiperWords(s) {
  const p = [];
  if (Number.isFinite(s.speed)) p.push(`speed ${s.speed} ms`);
  p.push(`effect ${s.effect || 'slide'}`);
  if (s.timing && s.timing !== 'ease') p.push(`timing ${s.timing}`);
  if (s.slidesPerView != null && s.slidesPerView !== 1) p.push(`${s.slidesPerView} per view`);
  if (s.spaceBetween) p.push(`gap ${s.spaceBetween} px`);
  if (s.direction === 'vertical') p.push('vertical');
  if (s.freeMode) p.push('free mode');
  if (s.loop) p.push('loop');
  if (s.autoplay && Number.isFinite(s.autoplay.delay)) p.push(`autoplay ${secs(s.autoplay.delay)}`);
  return p.join(', ');
}
export function lottieWords(a) {
  const p = [];
  if (Number.isFinite(a.durationS)) p.push(`${r3(a.durationS)} s at ${a.frameRate} fps`);
  else if (a.via === 'element') p.push(a.srcHost ? `${a.tag || 'lottie-player'} (${a.srcHost})` : a.tag || 'lottie-player');
  if (a.playSpeed != null && a.playSpeed !== 1) p.push(`speed ${a.playSpeed}x`);
  if (a.loop) p.push(typeof a.loop === 'number' && a.loop !== 1 ? `loop ${a.loop}` : 'loop');
  if (a.autoplay === false) p.push('no autoplay');
  return p.join(', ');
}
export function locomotiveWords(l) {
  const p = [];
  if (Number.isFinite(l.lerp)) p.push(`lerp ${l.lerp}`);
  if (Number.isFinite(l.multiplier)) p.push(`multiplier ${l.multiplier}`);
  if (l.smooth != null) p.push(l.smooth ? 'smooth' : 'not smooth');
  if (l.direction) p.push(l.direction);
  return p.join(', ');
}
export function animeWords(a) {
  const p = [];
  if (Number.isFinite(a.durationMs)) p.push(`duration ${a.durationMs} ms`);
  if (a.easing) p.push(`easing ${a.easing}`);
  if (a.delay > 0) p.push(`delay ${a.delay} ms`);
  if (a.loop) p.push(a.loop === true ? 'loop' : `loop ${a.loop}`);
  if (a.direction && a.direction !== 'normal') p.push(a.direction);
  return p.join(', ');
}
export const animeLine = (a) => `anime.js declared: ${animeWords(a)} [exact]`;

/** Pure: put the anime.js animations whose target matches a motion's element on that motion (m.libDeclared, printed under it).
 *  Returns the animations nobody took (the section prints those). Mutates the motions. */
export function attachAnime(motions, dl) {
  const list = (dl && dl.anime) || []; const taken = new Set();
  for (const m of motions || []) {
    const mine = []; const seen = new Set();
    list.forEach((a, i) => {
      if (!(a.targets || []).some((t) => descMatch(t, m.desc))) return;
      taken.add(i); const text = animeLine(a); if (seen.has(text)) return; seen.add(text); mine.push({ lib: 'anime', text });
    });
    if (mine.length) m.libDeclared = mine;
  }
  return list.filter((_, i) => !taken.has(i));
}

/** Pure: the section lines (at most `max` = 6) for look.json "declaredLibs"; `rest` = the anime.js animations not shown under a motion. */
export function declaredLibLines(dl, rest, max = 6) {
  if (!dl || !dl.found) return [];
  const L = [];
  const grouped = (items, f) => { const by = new Map(); for (const x of items) { const t = f(x); if (t) by.set(t, (by.get(t) || 0) + 1); } return [...by].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)); };
  L.push(...grouped(dl.swiper || [], (s) => `Swiper declared: ${swiperWords(s)} [exact]`));
  L.push(...grouped(dl.lottie || [], (a) => { const w = lottieWords(a); return w ? `Lottie declared: ${w} [exact] (canvas/svg content is not measured)` : null; }));
  const l = dl.locomotive;
  if (l) { const w = locomotiveWords(l); L.push(w ? `Locomotive Scroll declared: ${w} [exact] (${l.via})` : `Locomotive Scroll: smooth scroll active (${l.evidence}); its options are not readable`); }
  L.push(...grouped(rest == null ? dl.anime || [] : rest, (a) => (animeWords(a) ? animeLine(a) : null)));
  return L.length > max ? [...L.slice(0, max - 1), `… ${L.length - max + 1} more declared (look.json "declaredLibs")`] : L;
}
