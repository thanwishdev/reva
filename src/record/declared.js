// What a page declares through a library, read at its birth (DESIGN 3.6). Scan takes only: it goes in as the session's init script.
//
// Bundled GSAP has no global, so `src/corpus/gsap.js` cannot reach it. But its core runs `_globals.gsap = gsap` once, in the ticker's
// first wake (the shape `X.gsap=Y,(X.gsapVersions` in 59 of 60 stored bundles [M]). A setter on Object.prototype sees that one
// assignment, gives the object the plain data property it asked for, and steps aside. No page code changes.
// Then gsap.to/from/fromTo/set and the same methods of Timeline log each tween as it is made: tweens that finish and leave the timeline
// are gone from any read at rest. Rows of the log go through W.declared, which the session drains already, with `gsap-births` as label.
// A tween is logged by what it is once made (duration, ease, targets), since GSAP fills in defaults and rewrites `vars` as it goes.
import { EASE_NAMES, RESERVED_VARS, buildGsapProbeSource } from '../corpus/gsap.js';

export const HOOK = Object.freeze({ entries: 6000, targets: 64, props: 24, born: 4096 });
/** 'all': every SVG attribute that moves. 'core': only `d`, what the 5 % stop of DESIGN 3.6 keeps beside `transform` and `opacity`. */
export const SVG_ATTRS = 'all';

/* eslint-disable no-undef */
/** Self-contained: serialised into the page. Runs after the recorder's runtime, before any page script. */
function declaredHook(C) {
  const W = window.__WR;
  if (!W || !W.isTop || W.gsapHook) return;
  const DP = Object.defineProperty, OP = Object.prototype;
  const H = W.gsapHook = { core: null, log: [], born: [], errors: 0, over: 0, attrs: C.attrs, pending: () => false };
  const RESERVED = new Set(C.reserved), EASE = /^[a-z][a-z0-9]{0,20}(?:\.[a-z]{2,10})?(?:\([-+0-9.,\s]{0,40}\))?$/i;
  const clean = (v, n) => String(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').slice(0, n);
  const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const val = (v) => (typeof v === 'number' ? fin(v) : typeof v === 'string' ? clean(v, 80) : typeof v === 'function' ? 'function' : v == null ? null : typeof v);
  const get = (o, m) => { try { return o && typeof o[m] === 'function' ? o[m]() : undefined; } catch (e) { return undefined; } };

  // ---- one call, read before GSAP rewrites its vars
  const propsOf = (vars) => {
    const out = {}; let n = 0;
    if (!vars || typeof vars !== 'object') return out;
    for (const k of Object.keys(vars)) {
      if (RESERVED.has(k) || k.length > 40 || n >= C.props) continue;
      const v = vars[k];
      if ((k === 'css' || k === 'attr') && v && typeof v === 'object') { for (const k2 of Object.keys(v).slice(0, C.props)) { out[(k === 'attr' ? 'attr.' : '') + k2] = val(v[k2]); n++; } continue; }
      out[k] = val(v); n++;
    }
    return out;
  };
  const triggerOf = (st) => {
    if (!st || typeof st !== 'object') return st ? { scrub: false } : null;
    const spec = (x) => (typeof x === 'string' ? clean(x, 40) : typeof x === 'number' ? fin(x) : x == null ? null : 'function');
    return { start: spec(st.start), end: spec(st.end), scrub: st.scrub === true ? true : typeof st.scrub === 'number' ? fin(st.scrub) : !!st.scrub, pin: !!st.pin, toggleActions: typeof st.toggleActions === 'string' ? clean(st.toggleActions, 60) : null, once: !!st.once };
  };
  const callOf = (m, a) => {
    const legacy = typeof a[1] === 'number';   // to(targets, duration, vars), the GSAP 2 form that 3 still takes
    const from = m === 'fromTo' ? a[legacy ? 2 : 1] : null, vars = m === 'fromTo' ? a[legacy ? 3 : 2] : a[legacy ? 2 : 1];
    return { m, props: propsOf(vars), ...(from ? { from: propsOf(from) } : {}), ease: vars && typeof vars.ease === 'string' && EASE.test(vars.ease.trim()) ? vars.ease.trim() : null, st: triggerOf(vars && vars.scrollTrigger), paused: !!(vars && vars.paused), keyframes: !!(vars && vars.keyframes) };
  };

  // ---- the tween it made
  let names = null;
  const easeOf = (tw) => {
    if (!names) { names = new Map(); for (const n of C.easeNames) { try { const f = H.core.parseEase(n); if (typeof f === 'function' && !names.has(f)) names.set(f, n); } catch (e) { /* not on this version */ } } }
    // `_ease` exists only once a tween has rendered, so an ease left out comes from where GSAP will take it: the timeline's defaults, then its own
    const set = tw.vars && tw.vars.ease; if (typeof set === 'function') return names.get(set) || null;
    if (typeof tw._ease === 'function') return names.get(tw._ease) || null;
    for (let p = tw.parent; p; p = p.parent) { const e = p.vars && p.vars.defaults && p.vars.defaults.ease; if (typeof e === 'string') return e.trim(); }
    const e = H.core.defaults().ease; return typeof e === 'string' ? e.trim() : null;
  };
  const note = (call, tw) => {
    if (H.born.length >= C.born) H.born.splice(0, C.born >> 1);
    H.born.push(tw);
    if (H.log.length >= C.entries) { H.over++; return; }
    const kids = tw.timeline && get(tw.timeline, 'getChildren') ? tw.timeline.getChildren(false, true, false) : null;   // a stagger or keyframes tween
    const list = kids && kids.length ? kids : [tw], ids = [], off = [];
    for (const k of list) {
      for (const t of get(k, 'targets') || []) { if (t && t.nodeType === 1 && ids.length < C.targets) { ids.push(W.idOf(t)); off.push(k === tw ? 0 : fin(get(k, 'startTime')) ?? 0); } }
    }
    const first = list[0];
    if (!ids.length || !(get(first, 'duration') > 0)) return;   // a set has no motion to declare
    const parent = tw.parent, up = parent && parent.vars ? triggerOf(parent.vars.scrollTrigger) : null;
    H.log.push({ ...call, st: call.st || up, k: W.frameKey(), T: performance.now(), ids, n: fin(get(tw, 'targets') && tw.targets().length), off: off.some(Boolean) ? off : null,
      dur: fin(get(first, 'duration')), delay: fin(get(tw, 'delay')), rep: fin(get(tw, 'repeat')), yoyo: !!get(tw, 'yoyo'), inTl: !!(parent && parent !== H.core.globalTimeline),
      ease: call.ease || easeOf(first) });
  };
  let depth = 0;   // a stagger's own tweens are made through Timeline.to: the outer call is the one the site wrote
  const hooked = (f, m, onTl) => function (...a) {
    if (depth) return f.apply(this, a);
    let call = null; try { call = callOf(m, a); } catch (e) { H.errors++; }
    depth++; let r; try { r = f.apply(this, a); } finally { depth--; }
    try { const tw = onTl ? get(this, 'recent') : r; if (call && tw && typeof tw.duration === 'function') note(call, tw); } catch (e) { H.errors++; }
    return r;
  };
  const wrap = (o, m, onTl) => { const f = o && o[m]; if (typeof f === 'function') o[m] = hooked(f, m, onTl); };

  /** A tween made since this part's input that has yet to end: W.quiet waits for it. `inControl` skips what moves by itself. */
  H.pending = (inControl) => {
    for (const t of H.born) {
      try {
        if (!t.parent || t.repeat() < 0 || t.totalProgress() >= 1) continue;
        let held = false; for (let a = t; a; a = a.parent) if (a.paused() || a.scrollTrigger) held = true;
        if (held) continue;
        const ts = t.targets(); if (ts.length && ts.every((e) => e && e.nodeType === 1 && inControl(W.idOf(e)))) continue;
        return true;
      } catch (e) { H.errors++; }
    }
    return false;
  };

  // ---- the moment GSAP is born
  const isCore = (g) => !!g && typeof g === 'object' && typeof g.to === 'function' && typeof g.timeline === 'function' && !!g.globalTimeline;
  const caught = (g) => {
    H.core = g; H.version = typeof g.version === 'string' ? clean(g.version, 20) : null;
    for (const m of ['to', 'from', 'fromTo', 'set']) wrap(g, m, false);
    const Tl = g.core && g.core.Timeline, Tw = g.core && g.core.Tween;
    for (const m of ['to', 'from', 'fromTo', 'set']) { wrap(Tl && Tl.prototype, m, true); wrap(Tw, m, false); }
    const dc = g.delayedCall;   // a delay with no target: nothing to log, and W.quiet still has to wait for it
    if (typeof dc === 'function') g.delayedCall = function (...a) { const r = dc.apply(this, a); try { if (r) H.born.push(r); } catch (e) { H.errors++; } return r; };
  };
  try {
    DP(OP, 'gsap', { configurable: true, enumerable: false, get() { return undefined; }, set(v) {
      try { DP(this, 'gsap', { value: v, writable: true, enumerable: true, configurable: true }); } catch (e) { return; }   // frozen: as a plain assignment would
      if (H.core || !isCore(v)) return;
      try { caught(v); } catch (e) { H.errors++; }
      try { delete OP.gsap; } catch (e) { H.errors++; }
    } });
  } catch (e) { H.errors++; }

  // The session drains W.declared; this log joins it there, one row per drain.
  const flush = () => {
    if (!H.log.length && !H.over) return;
    W.declared.push({ label: 'gsap-births', k: W.frameKey(), n: 0, list: [], version: H.version ?? null, over: H.over, errors: H.errors, gsap: H.log, provenance: 'declared' });
    H.log = []; H.over = 0;
  };
  const D = W.drain;
  W.drain = (what) => { flush(); return D(what); };
}
/* eslint-enable no-undef */

/** Init script text of a scan take. */
export const DECLARED_INIT = `(${declaredHook.toString()})(${JSON.stringify({ ...HOOK, reserved: RESERVED_VARS, easeNames: EASE_NAMES, attrs: SVG_ATTRS })});`;

/**
 * One page.evaluate() expression for the end of a take: `src/corpus/gsap.js` reading at rest, on the object the hook caught, so it
 * sees bundled GSAP as it sees a global one (ScrollTrigger's real px ranges, tweens alive at rest). Elements that name a Lottie file come
 * with it, read while they are on the page. The result lands in W.declared as `gsap-rest`; the return value is a short summary.
 */
export function restSource() {
  return `(() => {
    const W = window.__WR, H = W && W.gsapHook;
    const scope = { gsap: (H && H.core) || window.gsap, GreenSockGlobals: window.GreenSockGlobals, gsapVersions: window.gsapVersions, TweenMax: window.TweenMax, TweenLite: window.TweenLite, ScrollTrigger: window.ScrollTrigger };
    const rest = ((window) => (${buildGsapProbeSource()}))(scope);
    if (H && H.core) rest.via = 'setter';
    const lottie = [];
    for (const e of document.querySelectorAll('[src],[data-src],[path],[data-path],[data-animation-path]')) {
      const url = ['src', 'data-src', 'path', 'data-path', 'data-animation-path'].map((a) => e.getAttribute(a)).find((u) => u && /\\.(lottie|json)(?:[?#]|$)/i.test(u));
      if (!url || lottie.length >= 100) continue;
      let abs = url; try { abs = new URL(url, location.href).href; } catch (x) { /* kept as written */ }
      lottie.push({ url: abs.slice(0, 400), selector: W.selectorOf(e) });
    }
    W.declared.push({ label: 'gsap-rest', k: W.frameKey(), n: 0, list: [], rest, lottie, provenance: 'declared' });
    return { found: rest.found, via: rest.via, version: rest.version, tweens: rest.tweens.length, triggers: rest.scrollTriggers.length, lottie: lottie.length, why: rest.why };
  })()`;
}
