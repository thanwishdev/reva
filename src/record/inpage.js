// In-page recorder runtime. Injected with addInitScript before any page script (so libraries that cache clock
// functions at load, e.g. GSAP's Date.now, read virtual time). Clean rewrite of the W2G1-2 `hx` prototype
// (own research code), with the D1 fix: virtual time is an integer frame count, never an accumulated float.
//
// Lanes:
//   hx : virtual clock (performance.now, Date, timers, rAF) on an exact grid T_k = round6(T0 + k*dt); CSS/WAAPI
//        animations pinned by an accumulator + finish() rule; Animation accessors report page intent.
//   rt : real time; the same sampler runs once per real frame (rAF -> MessageChannel post-frame task).
//
// This function is serialised with Function.prototype.toString and must stay self-contained.
import { rowEncoder } from './rowcodec.js';

export function wrRuntime(CFG, rowEncoder, scanTracker) {
  if (window.__WR) return;
  const isTop = (() => { try { return window.top === window; } catch { return false; } })();
  const RAF = window.requestAnimationFrame.bind(window);
  const RPN = performance.now.bind(performance);
  const RST = window.setTimeout.bind(window);
  const RIC0 = window.requestIdleCallback ? window.requestIdleCallback.bind(window) : null;   // native, before the page or the escape wrapper replaces it
  const OD = Date;
  const JS = JSON.stringify; const GOPD = Object.getOwnPropertyDescriptor; const DP = Object.defineProperty;
  const W = window.__WR = {
    cfg: CFG, isTop, errors: [], escapes: {}, births: [], rows: [], marks: [], mut: [], wheel: [], declared: [],
    c: { timers: 0, rafs: 0, steps: 0, pagePause: 0, pagePlay: 0, pageReverse: 0, pageFinish: 0, pageRate: 0, pageStartTime: 0,
      pageCT: 0, pinned: 0, finishedByPin: 0, settleTimeouts: 0, sampleMs: 0 },
  };
  W.realNow = RPN;
  // when the main thread last finished a long task (> 50 ms), real time: look waits for the page's own start-up (module graph,
  // library init, shader compile) to go quiet before the virtual clock moves, so the start-up does not race the take window
  W.lastLongEnd = 0;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) W.lastLongEnd = Math.max(W.lastLongEnd, e.startTime + e.duration); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  const err = (m) => { if (W.errors.length < 500) W.errors.push(String(m).slice(0, 300)); };
  addEventListener('error', (e) => err('error: ' + (e.message || e.type) + ' @' + (e.filename || '') + ':' + (e.lineno || '')));
  addEventListener('unhandledrejection', (e) => err('rejection: ' + String(e.reason && (e.reason.stack || e.reason))));

  // ---------------------------------------------------------------- escapes (detect and flag, never step: PLAN M1)
  const escape = (kind, reason, detail) => {
    const e = W.escapes[kind] || (W.escapes[kind] = { kind, steppable: false, reason, count: 0, first: null, details: [] });
    e.count++; if (e.first == null) e.first = W.V ? W.V.now : RPN();
    if (detail && e.details.length < 10) e.details.push(String(detail).slice(0, 200));
  };
  W.escape = escape;
  const wrapCtor = (name, kind, reason) => {
    const O = window[name]; if (typeof O !== 'function') return;
    const F = function (...a) { escape(kind, reason, a[0] && String(a[0])); return new O(...a); };
    F.prototype = O.prototype; Object.setPrototypeOf(F, O);
    try { Object.defineProperty(window, name, { configurable: true, writable: true, value: F }); } catch (e) { err('wrap ' + name + ': ' + e.message); }
  };
  // scan: a dedicated worker starts from a bootstrap that runs the WebGL tap first (workergl.js), on this page's virtual clock; a worker
  // of another origin (which the page could not start) or a page that forbids blob workers starts as it would have
  if (CFG.scan && typeof window.Worker === 'function' && window.__WR_WORKER_TAP) {
    const OW = window.Worker; let nW = 0;
    const F = function (url, opts) {
      escape('worker', 'a Worker runs its own script; scan takes tap its WebGL and run its clock with the page', url && String(url));
      if (!new.target) return OW(url, opts);
      let abs = null; try { abs = new URL(String(url), location.href).href; } catch (e) {}
      const own = abs && (new URL(abs).origin === location.origin || /^(blob|data):/i.test(abs));
      if (!own) return new OW(url, opts);
      try {
        const C = { t0: CFG.t0 || 0, dt: CFG.dt, epoch: CFG.dateEpoch || 0, k0: W.V ? W.V.k : 0, idBase: 1000 * ++nW, base: abs };
        const head = '(' + window.__WR_WORKER_TAP + ')(' + JSON.stringify(C) + ');', mk = (s) => URL.createObjectURL(new Blob([s], { type: 'text/javascript' }));
        const boot = opts && opts.type === 'module' ? 'import ' + JSON.stringify(mk(head)) + ';\nimport ' + JSON.stringify(abs) + ';' : head + '\nimportScripts(' + JSON.stringify(abs) + ');';
        const w = new OW(mk(boot), opts); W.workerTaps = (W.workerTaps || 0) + 1; return w;
      } catch (e) { return new OW(url, opts); }
    };
    F.prototype = OW.prototype; Object.setPrototypeOf(F, OW);
    try { Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: F }); } catch (e) { err('wrap Worker: ' + e.message); }
  } else wrapCtor('Worker', 'worker', 'a Worker has its own clock (performance.now, timers, rAF); hx steps only the top document');
  wrapCtor('SharedWorker', 'shared-worker', 'a SharedWorker has its own clock; hx steps only the top document');
  // an OffscreenCanvas made on the page itself (three.js r128 makes a 1x1 one to resize images) draws on this thread: its WebGL is
  // tapped like any other, so it is said apart from a canvas whose control went to a worker (a shader-transition site, 6 Nov: a false "worker" row)
  wrapCtor('OffscreenCanvas', 'offscreen-main', 'an OffscreenCanvas made on the page itself: drawn on this thread, its WebGL is recorded like any canvas');
  try {
    const T = HTMLCanvasElement.prototype.transferControlToOffscreen;
    if (CFG.scan) W.xfer = [];
    if (T) HTMLCanvasElement.prototype.transferControlToOffscreen = function (...a) { if (W.xfer) W.xfer.push(this); try { if (W.watchEl) W.watchEl(this, 'webgl'); } catch (e) {} escape('offscreen-canvas', 'canvas control moved off the main thread; frames come from a clock hx does not control'); return T.apply(this, a); };
  } catch (e) {}
  try {
    const RIC = window.requestIdleCallback;
    if (RIC) window.requestIdleCallback = function (...a) { escape('request-idle-callback', 'requestIdleCallback runs on real idle time, not on the virtual clock'); return RIC.apply(this, a); };
  } catch (e) {}
  try {
    if (window.scheduler && scheduler.postTask) { const PT = scheduler.postTask.bind(scheduler); scheduler.postTask = (...a) => { escape('scheduler-post-task', 'scheduler.postTask delays run on real time'); return PT(...a); }; }
  } catch (e) {}
  try {
    const d = Object.getOwnPropertyDescriptor(Event.prototype, 'timeStamp');
    // a scan take: the event's time on the virtual clock, kept per event (velocity code reads it; a sweep is false without it)
    const stamps = new WeakMap();
    if (d && d.get && CFG.scan && CFG.lane === 'hx' && isTop) Object.defineProperty(Event.prototype, 'timeStamp', { configurable: true, get() { let t = stamps.get(this); if (t == null) { t = W.V ? W.V.now : d.get.call(this); stamps.set(this, t); } return t; } });
    else if (d && d.get) Object.defineProperty(Event.prototype, 'timeStamp', { configurable: true, get() { if (CFG.lane === 'hx') escape('event-timestamp', 'Event.timeStamp is real time; velocity trackers that read it see real, not virtual, deltas'); return d.get.call(this); } });
  } catch (e) {}
  const originOf = (src) => { try { return new URL(src, location.href).origin; } catch { return null; } };
  const seenFrames = new WeakSet();
  const checkFrame = (f) => {
    if (seenFrames.has(f)) return; seenFrames.add(f);
    const src = f.getAttribute('src') || 'about:blank';
    const o = originOf(src);
    // classify by the src origin: at insertion time every frame is still about:blank (same-origin) until it navigates
    const cross = !!(o && o !== 'null' && o !== location.origin && !/^(about|data|blob|javascript):/i.test(src));
    if (cross) escape('iframe-cross-origin', 'a cross-origin frame is a separate document with its own real clock; hx steps only the top document', src);
    else escape('iframe-same-origin', 'a nested document runs its own clock and animations; hx steps only the top document', src);
  };
  const checkMedia = (m) => { if (!seenFrames.has(m)) { seenFrames.add(m); escape('media-element', '<video>/<audio> playback runs on the media clock, not the virtual clock', m.currentSrc || m.getAttribute('src')); } };
  if (isTop) {
    new MutationObserver((list) => {
      for (const r of list) for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IFRAME' || n.tagName === 'FRAME') checkFrame(n);
        if (n.tagName === 'VIDEO' || n.tagName === 'AUDIO') checkMedia(n);
        if (n.querySelectorAll) { for (const f of n.querySelectorAll('iframe,frame')) checkFrame(f); for (const m of n.querySelectorAll('video,audio')) checkMedia(m); }
      }
    }).observe(document, { childList: true, subtree: true });
  }
  if (!isTop) return;   // nested documents are detected from the top and never stepped (PLAN M1: detect and flag only)

  // ---------------------------------------------------------------- helpers
  const mc = new MessageChannel(); const mq = []; mc.port1.onmessage = () => { const r = mq.shift(); if (r) r(); };
  const macro = () => new Promise((r) => { mq.push(r); mc.port2.postMessage(0); });
  // id and class names are page text: terminal escapes (ESC/BEL/CSI/OSC) and bidi overrides are dropped here, at the source
  // (same class as report/untrusted.js CONTROL_CHARS); session.js strips them again because the page can replace W.desc
  const desc = (e) => !e ? null : (e.tagName + (e.id ? '#' + e.id : '') + (e.classList && e.classList.length ? '.' + [...e.classList].filter(c => !/^svelte-/.test(c)).slice(0, 3).join('.') : '')).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');
  W.desc = desc;
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  // two real frames, with a real-time fallback so a stalled display link cannot hang the recorder (W2G1-2 §6)
  W.realFrame = () => new Promise((res) => {
    let done = false; const fin = (ok) => { if (done) return; done = true; if (!ok) W.c.settleTimeouts++; res(ok); };
    RAF(() => RAF(() => fin(true))); RST(() => fin(false), CFG.settleTimeoutMs || 250);
  });
  // the page's main thread is idle (native requestIdleCallback after one real frame): used by the network gate, so a
  // response the page is still handling (a module being parsed, a font decoded) is handled before virtual time runs
  W.idle = (ms) => new Promise((res) => {
    const t0 = RPN(); const done = (ok) => res({ ok, ms: Math.round(RPN() - t0) });
    if (!RIC0) { RST(() => done(null), 0); return; }
    RAF(() => RIC0((d) => done(!d.didTimeout), { timeout: ms || 2000 }));
  });

  // ---------------------------------------------------------------- driver writes (setProperty / style attr / class)
  W.frameKey = () => (W.V ? W.V.k : W.rtK || 0);
  const elIds = new WeakMap(); const els = []; W.els = els;
  const idOf = (el) => { let i = elIds.get(el); if (i == null) { i = els.length; els.push(el); elIds.set(el, i); } return i; };
  W.idOf = idOf;
  // A pseudo-element (::before / ::after ...) has no node: it is recorded as its own id that points at the host element and
  // remembers the pseudo name. Its channels are read with getComputedStyle(host, '::after'); there is no box API for it,
  // so only the size from the computed style is recorded (ren:bw, ren:bh).
  const pseudoIds = new Map(); const pseudoOf = new Map();   // hostId -> Map(pseudo -> id) ; id -> pseudo
  const pseudoId = (el, ps) => { const h = idOf(el); let m = pseudoIds.get(h); if (!m) pseudoIds.set(h, m = new Map()); let i = m.get(ps); if (i == null) { i = els.length; els.push(el); m.set(ps, i); pseudoOf.set(i, ps); } return i; };
  W.pseudoOf = pseudoOf;
  const varsOf = new Map();   // elId -> Set of custom property names written
  W.varsOf = varsOf;
  try {
    const SP = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value, prio) {
      try { if (typeof name === 'string' && name.startsWith('--') && W.styleOwner) { const el = W.styleOwner.get(this); if (el) { const id = idOf(el); let s = varsOf.get(id); if (!s) varsOf.set(id, s = new Set()); s.add(name); } } } catch (e) {}
      return SP.call(this, name, value, prio);
    };
  } catch (e) { err('setProperty hook: ' + e.message); }
  // map CSSStyleDeclaration -> element lazily (style objects are per element and stable)
  W.styleOwner = new WeakMap();
  try {
    const sd = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style');
    if (sd && sd.get) Object.defineProperty(HTMLElement.prototype, 'style', { configurable: true, get() { const s = sd.get.call(this); W.styleOwner.set(s, this); return s; }, set: sd.set });
    const sd2 = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'style');
    if (sd2 && sd2.get) Object.defineProperty(SVGElement.prototype, 'style', { configurable: true, get() { const s = sd2.get.call(this); W.styleOwner.set(s, this); return s; }, set: sd2.set });
  } catch (e) { err('style owner hook: ' + e.message); }
  // mutation stamps for stream attribution: [frameKey, scrollY, elId, attr]
  W.mutOn = true;
  new MutationObserver((list) => {
    if (!W.mutOn) return;
    const k = W.frameKey(), sy = Math.round(scrollY);
    for (const r of list) { if (r.target.nodeType !== 1) continue; if (W.mut.length < 2e6) W.mut.push([k, sy, idOf(r.target), r.attributeName === 'class' ? 1 : 0]); }
  }).observe(document, { attributes: true, attributeFilter: ['style', 'class'], subtree: true });

  // ---------------------------------------------------------------- wheel log (defaultPrevented per event)
  addEventListener('wheel', (e) => {
    const rec = { k: W.frameKey(), dy: e.deltaY, sy0: scrollY, prevented: null, cancelable: e.cancelable };
    if (W.wheel.length < 1e5) W.wheel.push(rec);
    macro().then(() => { rec.prevented = e.defaultPrevented; rec.sy1 = scrollY; });
  }, { capture: true, passive: true });

  // ---------------------------------------------------------------- pointer / click log (inputs the page received)
  // Every pointer/click event the page receives, from the driver (CDP) or dispatched by page code, with the frame key
  // after which it landed and the (virtual) time. Passive capture listeners: the page's own handling is unchanged.
  W.inputs = [];
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click']) addEventListener(type, (e) => {
    if (W.inputs.length >= 1e5 || W.inputMute) return;   // inputMute: the recorder's own pointer positioning (wheel)
    W.inputs.push({ type: type === 'pointermove' || type === 'pointerdown' ? 'pointer' : type, ev: type, k: W.frameKey(), T: performance.now(), x: e.clientX, y: e.clientY, buttons: e.buttons, trusted: e.isTrusted, source: 'page-observed' });
  }, { capture: true, passive: true });

  // ---------------------------------------------------------------- births + declared layer
  const timelineKind = (a) => { const t = a.timeline; if (!t) return 'none'; if (t instanceof DocumentTimeline) return 'document'; return t.constructor ? t.constructor.name : 'other'; };
  const declOf = (a) => {
    let tm = {}, kf = null;
    try { tm = a.effect.getTiming(); } catch (e) {}
    try { kf = a.effect.getKeyframes().slice(0, CFG.scan ? Infinity : 12).map(f => { const o = {}; for (const [k, v] of Object.entries(f)) if (k !== 'computedOffset') o[k] = typeof v === 'string' ? v.slice(0, 120) : v; return o; }); } catch (e) {}
    // an animation on ::before / ::after / ::marker ... belongs to that pseudo-element, not to its host (the descriptor carries the
    // pseudo name, as the element descriptor of a recorded pseudo-element does); View Transition pseudos keep the root as target
    let pse = ''; try { const pe = a.effect && a.effect.pseudoElement; if (pe && /^::(before|after|marker|placeholder|first-letter|first-line|backdrop|selection|file-selector-button)$/.test(pe)) pse = String(pe); } catch (e) {}
    const d = { name: a.animationName || a.transitionProperty || a.id || 'waapi', type: a.constructor.name, tgt: desc(a.effect && a.effect.target) + (pse && a.effect.target ? pse : ''), timeline: timelineKind(a),
      delay: tm.delay, duration: tm.duration, easing: String(tm.easing || ''), iterations: tm.iterations, direction: tm.direction, fill: tm.fill, keyframes: kf };
    // the target's element id (the id its sampled channels carry; a pseudo-element's own id): the fitter matches births to an
    // element by it, not by the descriptor that siblings share (two lines of one heading, each with its own delay)
    try { const te = a.effect && a.effect.target; if (te && te.nodeType === 1) d.el = pse ? pseudoId(te, pse) : idOf(te); } catch (e) {}
    // M2 X-ext: pseudo-element target (View Transitions) and scroll/view-timeline range + subject (declared range, M11)
    try { const pe = a.effect && a.effect.pseudoElement; if (pe) d.pseudoElement = String(pe); } catch (e) {}
    if (d.timeline !== 'document' && d.timeline !== 'none') {
      const rg = (r) => (r == null ? null : typeof r === 'string' ? r : { name: r.rangeName != null ? String(r.rangeName) : null, offset: r.offset != null ? String(r.offset) : null });
      try { d.rangeStart = rg(a.rangeStart); d.rangeEnd = rg(a.rangeEnd); } catch (e) {}
      try { const t = a.timeline; d.timelineInfo = { axis: t.axis != null ? String(t.axis) : null, subject: t.subject ? desc(t.subject) : null, source: t.source ? desc(t.source) : null }; } catch (e) {}
    }
    return d;
  };
  W.birth = (a, T) => { if (W.births.length > 20000) return; const d = declOf(a); d.T = T; d.k = W.frameKey(); d.sy = Math.round(scrollY); d.provenance = 'declared'; W.births.push(d); };
  // SMIL is invisible to getAnimations(): its declarations are read from the animation elements' attributes (lab M15)
  const smilOf = (a) => {
    const at = (n) => (a.getAttribute(n) == null ? null : String(a.getAttribute(n)).slice(0, 200));
    let start = null; try { start = a.getStartTime(); } catch (e) {}
    const tgt = a.targetElement || (a.getAttribute('href') ? document.querySelector(a.getAttribute('href')) : a.parentElement);
    return { name: a.tagName.toLowerCase(), type: 'SMIL', tgt: desc(tgt), attributeName: at('attributeName'), from: at('from'), to: at('to'), by: at('by'), values: at('values'), dur: at('dur'), begin: at('begin'),
      repeatCount: at('repeatCount'), repeatDur: at('repeatDur'), calcMode: at('calcMode'), keyTimes: at('keyTimes'), keySplines: at('keySplines'), fill: at('fill'), additive: at('additive'), accumulate: at('accumulate'), startTimeS: start };
  };
  W.snapshotDeclared = (label) => {
    const list = document.getAnimations().map(declOf);
    let smil = []; try { smil = [...document.querySelectorAll('animate, animateTransform, animateMotion, set')].slice(0, 100).map(smilOf); } catch (e) {}
    W.declared.push({ label, k: W.frameKey(), sy: Math.round(scrollY), n: list.length, list: list.slice(0, 400), ...(smil.length ? { smil } : {}), provenance: 'declared' }); return list.length;
  };

  // ---------------------------------------------------------------- sampler (channels)
  // Moving set: animation targets + elements with style/class writes + explicit selectors; capped (PLAN: <= ~300).
  const cap = CFG.maxElements || 300;
  W.watch = new Map();      // elId -> {el, why}
  // over the cap: W.c.watchOverflow counts distinct elements left out (not attempts). capPolicy 'viewport' (look, top-N):
  // a newcomer on screen takes the slot of a watched element that is off screen or has no size (a bounded scan per
  // frame), so a big page's visible motion is not lost to whatever happened to move first; W.c.watchEvicted counts them
  const over = new Set(); let evictAt = 0, evictChecks = 0, evictFrame = -1;
  const onScreen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; };
  const evictFor = (el) => {
    if (CFG.capPolicy !== 'viewport') return false;
    const f = W.frameKey ? W.frameKey() : 0; if (f !== evictFrame) { evictFrame = f; evictChecks = 0; }
    if (evictChecks >= 20) return false; evictChecks++;
    if (!onScreen(el)) return false;
    const ids = [...W.watch.keys()]; const n = ids.length;
    for (let j = 0; j < Math.min(n, 40); j++) {
      const id = ids[(evictAt + j) % n]; const w = W.watch.get(id);
      if (w.why === 'selector' || w.why === 'aim') continue;
      if (!w.el.isConnected || !onScreen(w.el)) { W.watch.delete(id); evictAt = (evictAt + j) % Math.max(1, n - 1); W.c.watchEvicted = (W.c.watchEvicted || 0) + 1; return true; }
    }
    evictAt = (evictAt + 40) % Math.max(1, n);
    return false;
  };
  const watch = (el, why, idArg) => {
    if (!el || el.nodeType !== 1) return; const id = idArg != null ? idArg : idOf(el); if (W.watch.has(id)) return;
    if (el.closest && el.closest('[data-reva-hidden]')) return; // a consent banner the scan took out (src/safety/banner.js): no motion of the site
    if (W.watch.size < cap || (why === 'selector' && CFG.capPolicy) || evictFor(el)) { W.watch.set(id, { el, why }); over.delete(id); if (W.selQ) W.selQ.push(id); return; }
    if (over.size < 1e6) over.add(id); W.c.watchOverflow = over.size;
  };
  W.watchEl = (el, why) => watch(el, why);
  W.watchSelectors = (sels) => { let n = 0; for (const s of sels || []) for (const el of document.querySelectorAll(s)) { watch(el, 'selector'); n++; } return n; };
  // Aim mode (`look --el`, promoted from the spike): only elements matching the aim selectors join the moving set, each
  // when it first gets a style/class write, a --var write or a running animation (the same trigger as the discovery
  // below), and every match once the driver calls aimOn (action start). Watching every match from frame 1 recorded
  // pre-init / pre-layout values that split the first segment and broke fits (spike finding 2).
  W.aimOn = false; W.aimIds = new Set();
  const aimDiscover = () => {
    const mutated = new Set(); for (let i = W._mutSeen || 0; i < W.mut.length; i++) mutated.add(W.mut[i][2]); W._mutSeen = W.mut.length;
    CFG.aim.selectors.forEach((s, si) => {
      const ps = (CFG.aim.pseudos && CFG.aim.pseudos[si]) || null;   // "sel::after": the elements of `sel`, read at their ::after
      let list; try { list = document.querySelectorAll(s); } catch (e) { return; }
      for (const el of list) {
        const hid = idOf(el); const id = ps ? pseudoId(el, ps) : hid; W.aimIds.add(id); if (W.watch.has(id)) continue;
        let anim = false; try { anim = ps ? el.getAnimations({ subtree: true }).some((a) => { try { return a.effect && a.effect.target === el && a.effect.pseudoElement === ps; } catch (e) { return false; } }) : !!(el.getAnimations && el.getAnimations().length); } catch (e) {}
        if (W.aimOn || mutated.has(hid) || varsOf.has(hid) || anim) watch(el, W.aimOn ? 'aim' : 'aim-discover', id);
      }
    });
  };
  // Scan: an animation on ::before / ::after is that pseudo-element's own motion, and a scroll or view timeline never reaches W.pin,
  // so it is born here (DESIGN 3.6). The host stays watched too, as it always was.
  const PSEUDO = /^::(before|after|marker|placeholder|first-letter|first-line|backdrop|selection|file-selector-button)$/;
  const scrollBorn = new WeakSet();
  const scanAnim = (a, t) => {
    try {
      const pe = a.effect && a.effect.pseudoElement;
      if (t && pe && PSEUDO.test(pe)) watch(t, 'animation', pseudoId(t, String(pe)));
      const tl = a.timeline;
      if (CFG.births && tl && !(tl instanceof DocumentTimeline) && !scrollBorn.has(a)) { scrollBorn.add(a); W.birth(a, performance.now()); }
    } catch (e) { err('scan discovery: ' + e.message); }
  };
  const discover = () => {
    if (CFG.aim) { aimDiscover(); return; }
    if (CFG.discover === false) return;
    for (const a of document.getAnimations()) { const t = a.effect && a.effect.target; if (t) watch(t, 'animation'); if (CFG.scan) scanAnim(a, t); }
    for (let i = W._mutSeen || 0; i < W.mut.length; i++) { const el = els[W.mut[i][2]]; if (el) watch(el, 'mutation'); }
    W._mutSeen = W.mut.length;
    for (const id of varsOf.keys()) watch(els[id], 'setProperty');
  };
  W.discover = discover;
  const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : (s == null ? null : String(s)); };
  const decompose = (tf) => {
    if (!tf || tf === 'none') return [0, 0, 0, 1, 1, 0, 0];
    let m; try { m = new DOMMatrixReadOnly(tf); } catch (e) { return null; }
    const a = m.a, b = m.b, c = m.c, d = m.d; const det = a * d - b * c; let sx = Math.hypot(a, b);
    // a mirrored matrix (det < 0) puts the negative scale on x when the x axis points backwards (a spring overshooting scaleX
    // through 0 reads sx < 0, not "rotate 180 and sy -1"), else on y (scaleY(-1)); a scaleX(0) matrix has det 0 and its y scale
    // is the length of the second column (an underline growing from scaleX(0) must not show a scaleY step 0 -> 1)
    const flipX = det < 0 && a < 0; const skew0 = sx ? Math.atan2(a * c + b * d, sx * sx) * 180 / Math.PI : 0; if (flipX) sx = -sx;
    const rot = Math.atan2(flipX ? -b : b, flipX ? -a : a) * 180 / Math.PI;
    const sy = sx ? det / sx : Math.hypot(c, d); const skew = skew0;
    return [m.m41, m.m42, m.m43, sx, sy, rot, skew];
  };
  const TF = ['tx', 'ty', 'tz', 'sx', 'sy', 'rz', 'skx'];
  // Font variation axes, one channel per axis: ren:wght (font-variation-settings 'wght', else font-weight), ren:wdth ('wdth',
  // else font-stretch), and any other registered or custom axis the page sets in font-variation-settings as ren:fvar.<tag>.
  // The computed value is read, so a running transition / animation / script gives the interpolated number every frame.
  const STRETCH = { 'ultra-condensed': 50, 'extra-condensed': 62.5, condensed: 75, 'semi-condensed': 87.5, normal: 100, 'semi-expanded': 112.5, expanded: 125, 'extra-expanded': 150, 'ultra-expanded': 200 };
  const fontAxes = (cs, o) => {
    const fvs = cs.fontVariationSettings; const ax = {};
    if (fvs && fvs !== 'normal') { const re = /["']([^"']{4})["']\s+(-?\d*\.?\d+(?:e[+-]?\d+)?)/gi; let m; while ((m = re.exec(fvs))) ax[m[1]] = +m[2]; }
    const w = parseFloat(cs.fontWeight); const st = cs.fontStretch;
    o['ren:wght'] = ax.wght != null ? ax.wght : (Number.isFinite(w) ? w : 400);
    const sp = parseFloat(st); o['ren:wdth'] = ax.wdth != null ? ax.wdth : (/%$/.test(st) && Number.isFinite(sp) ? sp : STRETCH[st] ?? 100);
    for (const t of Object.keys(ax)) if (t !== 'wght' && t !== 'wdth' && /^[A-Za-z0-9]{4}$/.test(t)) o['ren:fvar.' + t] = ax[t];
  };
  // The leading number of an element's text (a counter, a HUD readout, a table cell): '1,284.1 ms' -> 1284.1, '×5.0' -> 5,
  // '−12 %' -> -12, '1 000 000' -> 1000000. Thousands separators (comma, thin / narrow / no-break space, apostrophe) count
  // only in groups of three after the first group; a sign counts only right before the digits (U+2212 minus, hyphen, en
  // dash) and not after a letter or digit ('A-1' is 1). Units and words around the number are ignored. null when the text
  // is long (not a readout) or has no number. Reading textContent is bounded: an element with many children is skipped.
  const NUMRE = /(^|[^\p{L}\d.])([-−–]?)(\d+(?:[,   ' ]\d{3})*(?:\.\d+)?|\.\d+)(?![\d])/u;
  const leadNum = (el) => {
    if (el.childElementCount > 8) return null;
    const t = el.textContent; if (!t || t.length > 80) return null;
    const m = NUMRE.exec(t); if (!m) return null;
    const v = +(m[3].replace(/[,   ' ]/g, '')); if (!Number.isFinite(v)) return null;
    return m[2] ? -v : v;
  };
  W.leadNum = leadNum;
  W.channelsOf = (el, id) => {
    const ps = pseudoOf.get(id); const cs = getComputedStyle(el, ps || null); const o = {};
    const dm = decompose(cs.transform); if (dm) for (let i = 0; i < 7; i++) o['ren:' + TF[i]] = dm[i];
    o['ren:transform'] = cs.transform;
    o['ren:translate'] = cs.translate; o['ren:scale'] = cs.scale; o['ren:rotate'] = cs.rotate;
    o['ren:opacity'] = +cs.opacity;
    fontAxes(cs, o);
    o['ren:radius'] = cs.borderTopLeftRadius; o['ren:clipPath'] = cs.clipPath; o['ren:filter'] = cs.filter;
    // colour, background and the paint offsets, as the computed strings; the fitter splits them into numbers (series.js:
    // ren:color.r/g/b/a, ren:bgPos.x/y, ...) and keeps only the parts that move. Recorded only where they can matter, so an
    // idle page's take does not grow: background position with a background image, mask position with a mask image,
    // fill / stroke / dash offset on SVG elements.
    // the text colour paints only text: an element with no text of its own (an <img>, an empty box) gets no colour channel
    // (an inherited colour change on a replaced element is not a visible motion)
    let txt = false; for (let c = el.firstChild, n = 0; c && n < 32 && !txt; c = c.nextSibling, n++) txt = c.nodeType === 3 && /\S/.test(c.data);
    if (!txt && !ps && el.childElementCount <= 8) { const t = el.textContent; txt = !!t && t.length <= 2000 && /\S/.test(t); }
    if (txt || ps) o['ren:color'] = cs.color;
    o['ren:bg'] = cs.backgroundColor;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') o['ren:bgPos'] = cs.backgroundPosition;
    const mi = cs.maskImage || cs.webkitMaskImage; if (mi && mi !== 'none') o['ren:maskPos'] = cs.maskPosition || cs.webkitMaskPosition;
    if (typeof SVGElement !== 'undefined' && el instanceof SVGElement) { o['ren:fill'] = cs.fill; o['ren:stroke'] = cs.stroke; const d = parseFloat(cs.strokeDashoffset); if (Number.isFinite(d)) o['ren:dash'] = d; }
    if (W.attrsOf && !ps) { const as = W.attrsOf.get(id); if (as) W.attrChannels(el, id, as, o); }
    if (W.charsOf && !ps && W.charsOf.has(id)) o['ren:chars'] = W.charsText(el);
    if (!ps) { const n = leadNum(el); if (n != null) o['ren:text'] = n; }
    if (ps) {   // a pseudo-element: no rect, no inline style; its size comes from the computed style when it is a number of px
      const w = parseFloat(cs.width), h = parseFloat(cs.height); if (Number.isFinite(w)) o['ren:bw'] = w; if (Number.isFinite(h)) o['ren:bh'] = h;
      if (CFG.scan) { const r = el.getBoundingClientRect(); o['ren:bx'] = r.x; o['ren:by'] = r.y; if (!Number.isFinite(w)) o['ren:bw'] = r.width; if (!Number.isFinite(h)) o['ren:bh'] = r.height; }   // a scan frames it by its host's box
      for (const n of CFG.computedVars || []) { const rv = cs.getPropertyValue(n); if (rv !== '') o['ren:' + n] = num(rv); }
      return o;
    }
    const r = el.getBoundingClientRect(); o['ren:bx'] = r.x; o['ren:by'] = r.y; o['ren:bw'] = r.width; o['ren:bh'] = r.height;
    const st = el.style;
    if (st) {
      if (st.transform) o['drv:transform'] = st.transform;
      if (st.opacity !== '') o['drv:opacity'] = num(st.opacity);
      const vs = varsOf.get(id);
      const names = new Set(vs ? [...vs] : []);
      for (let i = 0; i < st.length; i++) if (st[i].startsWith('--')) names.add(st[i]);
      for (const n of names) { o['drv:' + n] = num(st.getPropertyValue(n)); const rv = cs.getPropertyValue(n); if (rv !== '') o['ren:' + n] = num(rv); }
    }
    for (const n of CFG.computedVars || []) { const rv = cs.getPropertyValue(n); if (rv !== '') o['ren:' + n] = num(rv); }
    return o;
  };
  // ---------------------------------------------------------------- WebGL light (WebGL1 + WebGL2, engine-agnostic)
  // Hooks the WebGL API on the context prototypes (before any page script runs): shader sources at link time, the uniform
  // list of every program, every float uniform the page sets (sample-and-hold, keyed program + name) and the 4x4 matrices
  // that look like a camera (projection / view by name, or a perspective-shaped value). Counters only for framebuffer
  // binds and instanced draws: no per-draw capture. Read-only: every call goes through to the page's own context unchanged.
  // CFG.glUniforms (older lab scenes) is subsumed: every float uniform is tapped, up to CFG.glMaxKeys keys.
  W.glT = null;
  const GLP = [window.WebGLRenderingContext && WebGLRenderingContext.prototype, window.WebGL2RenderingContext && WebGL2RenderingContext.prototype].filter(Boolean);
  if (GLP.length && CFG.glTap !== false) {
    const G = W.glT = { ctxs: [], ctxIdx: new WeakMap(), progs: [], progOf: new WeakMap(), shaders: new WeakMap(), locs: new WeakMap(), vals: {}, mats: {}, keys: 0, mkeys: 0,
      dropped: { keys: [], arrays: [], matrices: [], programs: 0, textures: 0, objects: [], states: 0 }, multi: {}, setFrames: {}, last: {}, frame: 0, fbs: new WeakSet(), fbN: 0, fbBinds: 0, instanced: 0, divisor: 0, cur: new WeakMap(), extW: new WeakSet(),
      // per frame: which program drew how often into which target (pass order); object matrices of every program; texture descriptions
      fbId: new WeakMap(), fbList: [], curFb: new WeakMap(), draws: {}, seq: 0, objs: {}, okeys: 0, ofk: {}, on: {}, texId: new WeakMap(), texList: [], unit: new WeakMap(), bound: new WeakMap(),
      // per frame, per program: the blend / depth / cull / scissor state it drew with, as ids into a table of the states seen (sample-and-hold)
      st: new WeakMap(), blends: {}, states: [], stateIdx: {},
      // per target (ctx:fb), the programs drawn into it since its last colour clear; per frame, per program, those it was drawn over
      since: {}, under: {},
      // scan: uniform arrays past 64 elements (bones: mat4[41]) one key per element, changed elements only, a program whose array holds
      // the same values as another's this frame named by it; per-draw values one slot per set in the frame; geometry per draw
      arrs: {}, akeys: 0, arrHash: {}, arrFk: -1, slots: {}, skeys: 0, setN: {}, firstV: {}, bufs: [], bufId: new WeakMap(), boundBuf: new WeakMap(), vaos: new WeakMap(), curVao: new WeakMap(),
      geoms: [], geomIdx: {}, gdraw: {}, bufStore: {}, bufStoreBytes: 0, abUrl: new WeakMap(), places: {} };
    // scan caps sized for a big engine (a skinned-mesh WebGL site, 6 Nov: 84 programs, 600 uniform keys, 192 object matrices hit 64 / 320 / 128); values are
    // sample-and-hold deltas, so a key costs only when it changes
    const MAXK = CFG.glMaxKeys || (CFG.scan ? 4096 : 96), MAXM = 8, MAXSRC = 200000, MAXP = CFG.scan ? 256 : 64, MAXU = CFG.scan ? 512 : 160;
    const MAXA = 4096, SLOTS = 32, MAXSL = 2048, MAXG = 512, MAXB = 1024, BUF_KEEP = 262144, BUF_STORE = 16 * 1048576;
    // object matrices (modelView / model of every program, not only the camera-like first 8): 7 significant digits (a float32 holds
    // about 7), sample-and-hold like the rest. A program that draws several objects sets its matrix once per object: the n-th set of a
    // frame is object n (`key#n`, draw order), up to OBJ_SLOTS objects per program
    const MAXO = CFG.scan ? 4096 : 2 * MAXP, OBJ_SLOTS = CFG.scan ? 32 : 8, MAXT = CFG.scan ? 2048 : 256, SIG = (v) => +(+v).toPrecision(7);
    const TY = { 5126: 'float', 35664: 'vec2', 35665: 'vec3', 35666: 'vec4', 5124: 'int', 35667: 'ivec2', 35668: 'ivec3', 35669: 'ivec4', 5125: 'uint', 35670: 'bool', 35674: 'mat2', 35675: 'mat3', 35676: 'mat4',
      35678: 'sampler2D', 35679: 'sampler3D', 35680: 'samplerCube', 35682: 'sampler2DShadow', 36289: 'sampler2DArray', 36298: 'isampler2D', 36306: 'usampler2D' };
    const noteOnce = (list, k) => { if (list.length < 40 && !list.includes(k)) list.push(k); };
    const ctxOf = (gl) => { let c = G.ctxIdx.get(gl); if (c == null) { c = G.ctxs.length; G.ctxs.push({ gl, canvas: gl.canvas, v2: !!(window.WebGL2RenderingContext && gl instanceof WebGL2RenderingContext) }); G.ctxIdx.set(gl, c);
      // scan: a WebGL canvas is always in the rows (its box, opacity, transform per frame), whatever moves
      if (CFG.scan && gl.canvas && gl.canvas.nodeType === 1) { try { watch(gl.canvas, 'webgl'); } catch (e) {} } } return c; };
    // where a canvas sits among the page's layers: its CSS, its stacking parents and what is painted over it (scan, at its first draw
    // and again at the take's end)
    const cssOf = (el) => { const cs = getComputedStyle(el); return { position: cs.position, zIndex: cs.zIndex, transform: cs.transform, opacity: +cs.opacity, mixBlendMode: cs.mixBlendMode, pointerEvents: cs.pointerEvents, filter: cs.filter, visibility: cs.visibility, display: cs.display, isolation: cs.isolation }; };
    const placeOf = (el) => {
      if (!el || el.nodeType !== 1 || !el.isConnected) return null;
      const r = el.getBoundingClientRect(), own = cssOf(el), parents = [];
      for (let p = el.parentElement, n = 0; p && n < 12; p = p.parentElement, n++) { const c = cssOf(p); if (c.position !== 'static' || c.zIndex !== 'auto' || c.opacity < 1 || c.transform !== 'none' || c.isolation === 'isolate' || c.mixBlendMode !== 'normal' || c.filter !== 'none') parents.push({ el: idOf(p), desc: desc(p), ...c }); if (parents.length >= 6) break; }
      // what is painted over it, at its centre and four inner points: the elements before it in hit order (pointer-events: none is skipped
      // by hit testing, so an overlay that lets the pointer through is not seen: said by pointerEvents of the canvas and its parents)
      const over = [], seen = new Set();
      for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy; if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        for (const e of document.elementsFromPoint(x, y)) { if (e === el) break; if (e === document.documentElement || e === document.body || seen.has(e)) continue; seen.add(e); if (over.length < 12) over.push({ el: idOf(e), desc: desc(e), zIndex: getComputedStyle(e).zIndex }); }
      }
      return { box: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100), ...own, parent: el.parentElement ? desc(el.parentElement) : null, index: el.parentElement ? [...el.parentElement.children].indexOf(el) : null, parents, over };
    };
    const same = (a, b) => { if (typeof a === 'number' || typeof b === 'number') return a === b; if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
    const listU = (p) => { const out = []; try { const gl = p.gl; const n = gl.getProgramParameter(p.p, gl.ACTIVE_UNIFORMS) || 0;
      for (let i = 0; i < Math.min(n, MAXU); i++) { const u = gl.getActiveUniform(p.p, i); if (u) out.push({ name: u.name, type: TY[u.type] || String(u.type), size: u.size }); }
      if (n > MAXU) out.push({ name: '…', type: 'more', size: n - MAXU }); } catch (e) { return null; } return out; };
    // per-frame bookkeeping (page frame key): a uniform set to two different values in one frame is set per draw (one
    // value per object), so its last value is not the uniform's motion
    const store = (bag, key, v) => {
      const fk = W.frameKey();
      if (G.last[key] === fk) {
        if (!same(bag[key], v)) G.multi[key] = (G.multi[key] || 0) + 1;
        // scan: a value set again in the same frame is one per draw (an object's opacity, its matrix): each set its own slot, #0 the first
        if (CFG.scan) { const n = ++G.setN[key]; if (n === 1) slot(key + '#0', G.firstV[key]); if (n < SLOTS) slot(key + '#' + n, v); }
      }
      else { G.last[key] = fk; G.setFrames[key] = (G.setFrames[key] || 0) + 1; if (CFG.scan) { G.setN[key] = 0; G.firstV[key] = v; } }
      bag[key] = v;
    };
    const slot = (k, v) => { if (!(k in G.slots)) { if (G.skeys >= MAXSL) { noteOnce(G.dropped.keys, k); return; } G.skeys++; } G.slots[k] = Array.isArray(v) ? v.map(SIG) : SIG(v); };
    // an array uniform past 64 elements (or a mat4 / mat3 array): its elements, n floats each, as keys `name[i]` (7 significant digits)
    const fnv = (d, off, len) => { let h = 2166136261; for (let i = off; i < off + len; i++) { const x = Math.round(+d[i] * 1e6); h ^= x & 0xffff; h = Math.imul(h, 16777619); h ^= x >>> 16; h = Math.imul(h, 16777619); } return h >>> 0; };
    const putArr = (key, data, off, total, n) => {
      if (!data || !(total > 0)) return;
      const base = key.replace(/\[0\]$/, ''), fk = W.frameKey();
      if (G.arrFk !== fk) { G.arrFk = fk; G.arrHash = {}; }
      const h = fnv(data, off, total) + ':' + total, name = base.slice(base.indexOf('|') + 1), same0 = G.arrHash[name + '|' + h];
      if (same0 && same0 !== base) { if (!(base in G.arrs)) G.akeys++; G.arrs[base] = '=' + same0; return; }
      G.arrHash[name + '|' + h] = base;
      if (typeof G.arrs[base] === 'string') G.arrs[base] = null;
      const m = Math.floor(total / n);
      for (let i = 0; i < m; i++) {
        const k = base + '[' + i + ']';
        if (!(k in G.arrs)) { if (G.akeys >= MAXA) { noteOnce(G.dropped.arrays, base); return; } G.akeys++; }
        const v = new Array(n); for (let j = 0; j < n; j++) v[j] = SIG(data[off + i * n + j]); G.arrs[k] = v;
      }
    };
    const putF = (L, data, off, len, n) => {
      if (data == null) return;
      const key = L.key;
      let v;
      if (n === 0) v = Number(data);
      else { off = off || 0; const total = len || (data.length - off);
        // scan: an array uniform is one key per element, `name[i]`, so the fit reads it as it reads a vector (DESIGN 3.6: up to 64)
        if (CFG.scan && total > n && total <= n * 64) { const base = key.replace(/\[0\]$/, ''); for (let i = 0; i * n < total; i++) putF({ key: base + '[' + i + ']' }, Array.prototype.slice.call(data, off + i * n, off + (i + 1) * n), 0, n, n); return; }
        if (CFG.scan && total > n) { putArr(key, data, off, total, n); return; }
        if (total > n) { noteOnce(G.dropped.arrays, key); return; } v = Array.prototype.slice.call(data, off, off + n).map(Number); if (v.length === 1) v = v[0]; }
      if (!(key in G.vals)) { if (G.keys >= MAXK) { noteOnce(G.dropped.keys, key); return; } G.keys++; }
      store(G.vals, key, v);
    };
    // scan: an int is mostly a sampler slot or a flag that never changes, so it takes a key only once it has changed
    const intFirst = {};
    const putI = (L, data, off, len, n) => {
      if (data == null) return;
      off = off || 0; const total = len || (data.length - off); if (total !== n) { if (total > n) noteOnce(G.dropped.arrays, L.key); return; }
      let v = Array.prototype.slice.call(data, off, off + n).map(Number); if (n === 1) v = v[0];
      const key = L.key;
      if (key in G.vals) { store(G.vals, key, v); return; }
      if (!(key in intFirst)) { intFirst[key] = v; return; }
      if (same(intFirst[key], v)) return;
      if (G.keys >= MAXK) { noteOnce(G.dropped.keys, key); return; } G.keys++;
      store(G.vals, key, v);
    };
    const transposed = (d, off, total) => { const out = new Array(total); for (let b = 0; b < total; b += 16) for (let i = 0; i < 16; i++) out[b + i] = +d[off + b + [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15][i]]; return out; };
    const camName = (nm) => /proj|view|cam|mvp/i.test(nm) && !/normal|shadow|light|bone|tex|uv|inverse|inv[A-Z_]/.test(nm);
    const putM = (L, transpose, data, off) => {
      if (!data || data.length < 16) return;
      off = off || 0; let m = Array.prototype.slice.call(data, off, off + 16).map(Number); if (m.length < 16) return;
      if (transpose) m = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15].map((i) => m[i]);
      const key = L.key;
      if (!(key in G.mats)) {
        const persp = Math.abs(m[11] + 1) < 1e-6 && Math.abs(m[15]) < 1e-6, cam = camName(L.name) || persp;
        // not a camera key, or past the camera keys: an object matrix of its program
        // scan: every other mat4 is kept too (a normal matrix, an inverse view-projection, a camera past the first 8), one key per draw slot
        if (!cam || G.mkeys >= MAXM) { if (CFG.scan) putO(key, m); else if (cam) noteOnce(G.dropped.matrices, key); return; }
        G.mkeys++;
      }
      store(G.mats, key, m);
    };
    // a program's own projection, past the camera keys: with its object matrix it puts the object on the screen
    const projName = (nm) => /^(projectionMatrix|uProjection|u_projection|uProjectionMatrix|u_projectionMatrix)$/.test(nm);
    const objName = (nm) => /^(modelViewMatrix|modelMatrix|uModelViewMatrix|uModelMatrix|u_modelViewMatrix|u_modelMatrix|uModel|u_model|uMV|u_mv|worldMatrix|uWorld|u_world)$/.test(nm);
    const putO = (key, m) => {
      const fk = W.frameKey(); let n;
      if (G.ofk[key] === fk) n = ++G.on[key]; else { G.ofk[key] = fk; n = G.on[key] = 0; }
      if (n >= OBJ_SLOTS) { if (n === OBJ_SLOTS) noteOnce(G.dropped.objects, key); return; }
      const k = n ? key + '#' + n : key;
      if (!(k in G.objs)) { if (G.okeys >= MAXO) { noteOnce(G.dropped.objects, k); return; } G.okeys++; }
      G.objs[k] = m.map(SIG);
    };
    // a draw: its program, how many times this frame, the order it first drew in, the targets it drew into (0 = the canvas)
    const fbOf = (fb) => { let id = G.fbId.get(fb); if (id == null) { id = G.fbList.length + 1; G.fbId.set(fb, id); G.fbList.push({ id, ctx: null, tex: [], w: null, h: null }); } return id; };
    const TEX_FOR = { sampler2D: 3553, sampler2DShadow: 3553, isampler2D: 3553, usampler2D: 3553, samplerCube: 34067, sampler3D: 32879, sampler2DArray: 35866 };
    const samplersOf = (p) => { if (p.samplers) return p.samplers; const list = []; try { const gl = p.gl, n = gl.getProgramParameter(p.p, gl.ACTIVE_UNIFORMS) || 0;
      for (let i = 0; i < Math.min(n, MAXU); i++) { const u = gl.getActiveUniform(p.p, i); const t = u && TY[u.type]; if (t && TEX_FOR[t]) list.push({ name: u.name.replace(/\[0\]$/, ''), target: TEX_FOR[t] }); } } catch (e) {}
      return (p.samplers = list); };
    // the state a draw composites with: blend (on, equation rgb / alpha, src rgb / alpha, dst rgb / alpha), depth (test, write, func),
    // cull (on, face), scissor (on), colour mask. Kept per context from the calls that change it (WebGL defaults to start), interned
    // once per change: a draw costs one lookup
    const MAXS = 64;
    const stOf = (gl) => { let s = G.st.get(gl); if (!s) G.st.set(gl, s = { b: 0, eq: [32774, 32774], f: [1, 0, 1, 0], dt: 0, dw: 1, df: 513, cu: 0, cf: 1029, sc: 0, cm: [1, 1, 1, 1], sid: null }); return s; };
    const sidOf = (gl) => {
      const s = stOf(gl); if (s.sid != null) return s.sid;
      const sig = [s.b, s.b ? s.eq.join(',') : '', s.b ? s.f.join(',') : '', s.dt, s.dw, s.df, s.cu, s.cf, s.sc, s.cm.join('')].join('|');
      let id = G.stateIdx[sig];
      if (id == null) {
        if (G.states.length >= MAXS) { G.dropped.states++; return (s.sid = 0); }
        id = G.states.length + 1; G.stateIdx[sig] = id;
        G.states.push({ id, blend: s.b ? { eq: s.eq.slice(), src: [s.f[0], s.f[2]], dst: [s.f[1], s.f[3]] } : null, depth: { test: !!s.dt, write: !!s.dw, func: s.df }, cull: s.cu ? s.cf : null, scissor: !!s.sc, colorMask: s.cm.slice() });
      }
      return (s.sid = id);
    };
    const CAPS = { 3042: 'b', 2929: 'dt', 2884: 'cu', 3089: 'sc' };
    // a draw's geometry, interned: program, mode, counts, index type, instances and the attribute layout (by the program's attribute names)
    const attrsOf = (p) => { if (p.attrNames) return p.attrNames; const out = {}; try { const gl = p.gl, n = gl.getProgramParameter(p.p, 35721) || 0;
      for (let i = 0; i < Math.min(n, 32); i++) { const a = gl.getActiveAttrib(p.p, i); if (!a) continue; const loc = gl.getAttribLocation(p.p, a.name); if (loc >= 0) out[loc] = { name: a.name, glslType: TY[a.type] || String(a.type), size: a.size }; } } catch (e) {} return (p.attrNames = out); };
    const geomOf = (gl, p, geo) => {
      const v = G.vaoState ? G.vaoState(gl) : null; if (!v) return 0;
      // an engine without vertex arrays sets its attributes again before each draw: the layout, not the call count, names a geometry
      if (v.sigVer !== v.ver) { v.sig = JSON.stringify([v.attrs, v.on, v.div || null, v.index ? v.index.id : null]); v.sigVer = v.ver; }
      const key = p.id + '|' + v.sig + '|' + geo.mode + '|' + geo.count + '|' + (geo.type || 0) + '|' + (geo.offset || 0) + '|' + (geo.first || 0) + '|' + (geo.inst || 0);
      let id = G.geomIdx[key]; if (id !== undefined) return id;
      if (G.geoms.length >= MAXG) { G.dropped.geometries = (G.dropped.geometries || 0) + 1; return (G.geomIdx[key] = 0); }
      const names = attrsOf(p), attribs = [];
      for (const loc of Object.keys(names)) { const a = v.on[loc] ? v.attrs[loc] : null, b = a && a.buffer ? G.bufs[a.buffer - 1] : null;
        attribs.push({ name: names[loc].name, glslType: names[loc].glslType, location: +loc, ...(a ? { size: a.size, type: a.type, normalized: a.normalized, ...(a.integer ? { integer: true } : {}), stride: a.stride, offset: a.offset, buffer: a.buffer, ...(v.div && v.div[loc] ? { divisor: v.div[loc] } : {}), ...(b ? { bufferBytes: b.size, hash: b.hash } : {}) } : { constant: true }) }); }
      const ib = geo.type ? v.index : null;
      id = G.geoms.length + 1; G.geomIdx[key] = id;
      G.geoms.push({ id, program: 'p' + p.id, mode: geo.mode, count: geo.count, ...(geo.first ? { first: geo.first } : {}), ...(geo.type ? { indexType: geo.type, indexOffset: geo.offset || 0, indexBuffer: ib ? ib.id : null, ...(ib ? { indexBytes: ib.size, indexHash: ib.hash } : {}) } : {}), instances: geo.inst || 0, attribs });
      return id;
    };
    const drawn = (gl, geo) => {
      const p = G.cur.get(gl); if (!p) return;
      const k = 'p' + p.id, fb = G.curFb.get(gl) || 0;
      // the geometry of each draw, in draw order (up to SLOTS a frame), so draw n pairs with the n-th slot of its per-draw values
      // (a WebGL gallery site, 6 Nov: one page draws 7 meshes twice a frame; a list of distinct ids could not say which matrix went with which mesh)
      if (geo) { try { const gid = geomOf(gl, p, geo); if (gid) { const g = G.gdraw[k]; if (g === undefined) G.gdraw[k] = gid; else if (typeof g === 'number') G.gdraw[k] = [g, gid]; else if (g.length < SLOTS) g.push(gid); } } catch (e) {} }
      // the canvas drew: its frame, and how many frames it drew in (an experience that loads before it draws is waited for)
      if (!fb) { const fk = W.frameKey(); if (G.canvasK !== fk) { G.canvasK = fk; G.canvasFrames = (G.canvasFrames || 0) + 1; } }
      if (!fb && G.places[p.ctx] === undefined) { G.places[p.ctx] = null; try { G.places[p.ctx] = { T: W.V ? W.V.now : null, ...placeOf(gl.canvas) }; } catch (e) {} }
      let d = G.draws[k]; if (!d) d = G.draws[k] = [0, G.seq++];
      d[0]++; if (d.indexOf(fb, 2) < 0) d.push(fb);
      // what it is drawn over: the programs that drew into this target since its colour was last cleared (a target keeps its
      // list across frames, as its pixels stay; the canvas starts each frame empty)
      const sk = p.ctx + ':' + fb, list = G.since[sk] || (G.since[sk] = []);
      if (list.indexOf(p.id) < 0) { if (list.length) { const u = G.under[k]; if (!u) G.under[k] = list.slice(); else for (const q of list) if (u.indexOf(q) < 0 && u.length < 32) u.push(q); } if (list.length < 32) list.push(p.id); }
      const sid = sidOf(gl), b = G.blends[k];
      if (b === undefined) G.blends[k] = sid; else if (b !== sid) { if (typeof b === 'number') G.blends[k] = [b, sid]; else if (b.indexOf(sid) < 0 && b.length < 8) b.push(sid); }
      const ss = samplersOf(p); if (!ss.length) return;
      const units = G.bound.get(gl); if (!units) return;
      for (const sm of ss) { const u = (p.ints && p.ints[sm.name]) || 0, t = units[u + '|' + sm.target]; if (t && t.sampled.length < 16) { const by = 'p' + p.id + '|' + sm.name; if (t.sampled.indexOf(by) < 0) t.sampled.push(by); } }
    };
    const srcKind = (x) => { if (x == null) return 'empty'; if (ArrayBuffer.isView(x)) return 'data'; const n = x.constructor && x.constructor.name; return n === 'HTMLImageElement' ? 'image' : n === 'HTMLCanvasElement' || n === 'OffscreenCanvas' ? 'canvas' : n === 'HTMLVideoElement' ? 'video' : n === 'ImageBitmap' ? 'bitmap' : n === 'ImageData' ? 'imagedata' : typeof x === 'number' ? 'buffer' : 'other'; };
    const srcSize = (x) => { try { if (!x || ArrayBuffer.isView(x) || typeof x === 'number') return [null, null]; return [x.naturalWidth || x.videoWidth || x.width || null, x.naturalHeight || x.videoHeight || x.height || null]; } catch (e) { return [null, null]; } };
    const boundTex = (gl, target) => { const units = G.bound.get(gl); if (!units) return null; const t = target >= 34069 && target <= 34074 ? 34067 : target; return units[((G.unit.get(gl) || 0)) + '|' + t] || null; };
    // the file a buffer's bytes came from: fetch / XHR array buffers are tagged with their URL, and a slice keeps the tag (glTF
    // loaders slice a buffer view out of the file). Read-only: every call returns what it returned before.
    if (CFG.scan) {
      try { const oab = Response.prototype.arrayBuffer; Response.prototype.arrayBuffer = function () { const url = this.url; return oab.call(this).then((ab) => { try { if (url) G.abUrl.set(ab, url); } catch (e) {} return ab; }); }; } catch (e) {}
      try { const d = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response'); if (d && d.get) Object.defineProperty(XMLHttpRequest.prototype, 'response', { configurable: true, enumerable: d.enumerable, get() { const r = d.get.call(this); try { if (r instanceof ArrayBuffer && !G.abUrl.has(r)) G.abUrl.set(r, this.responseURL); } catch (e) {} return r; } }); } catch (e) {}
      try { const os = ArrayBuffer.prototype.slice; ArrayBuffer.prototype.slice = function () { const r = os.apply(this, arguments); try { const u = G.abUrl.get(this); if (u) G.abUrl.set(r, u); } catch (e) {} return r; }; } catch (e) {}
    }
    for (const P of GLP) {
      const wrap = (fn, make) => { const o = P[fn]; if (typeof o === 'function') P[fn] = make(o); };
      wrap('createShader', (o) => function (type) { const sh = o.call(this, type); try { if (sh) G.shaders.set(sh, { type, src: null }); } catch (e) {} return sh; });
      wrap('shaderSource', (o) => function (sh, src) { try { const s = G.shaders.get(sh); if (s) { s.src = String(src).slice(0, MAXSRC); s.len = String(src).length; } } catch (e) {} return o.call(this, sh, src); });
      wrap('createProgram', (o) => function () { const p = o.call(this); try { if (p) { if (G.progs.length < MAXP) { const info = { id: G.progs.length + 1, ctx: ctxOf(this), p, gl: this, sh: new Set(), vs: null, fs: null, vsLen: 0, fsLen: 0, links: 0, uses: 0, inst: 0, uniforms: null, deleted: false }; G.progs.push(info); G.progOf.set(p, info); } else G.dropped.programs++; } } catch (e) {} return p; });
      wrap('attachShader', (o) => function (p, sh) { try { const i = G.progOf.get(p); if (i) i.sh.add(sh); } catch (e) {} return o.call(this, p, sh); });
      wrap('detachShader', (o) => function (p, sh) { try { const i = G.progOf.get(p); if (i) i.sh.delete(sh); } catch (e) {} return o.call(this, p, sh); });
      wrap('linkProgram', (o) => function (p) { const r = o.call(this, p); try { const i = G.progOf.get(p); if (i) { i.links++; for (const sh of i.sh) { const s = G.shaders.get(sh); if (!s) continue; if (s.type === 35633) { i.vs = s.src; i.vsLen = s.len || 0; } else if (s.type === 35632) { i.fs = s.src; i.fsLen = s.len || 0; } } } } catch (e) {} return r; });
      wrap('deleteProgram', (o) => function (p) { try { const i = G.progOf.get(p); if (i && !i.deleted) { i.uniforms = listU(i); i.deleted = true; } } catch (e) {} return o.call(this, p); });
      wrap('useProgram', (o) => function (p) { try { const i = p && G.progOf.get(p); if (i) i.uses++; G.cur.set(this, i || null); } catch (e) {} return o.call(this, p); });
      wrap('getUniformLocation', (o) => function (p, name) { const loc = o.call(this, p, name); try { const i = loc && G.progOf.get(p); if (i) G.locs.set(loc, { info: i, name: String(name), key: 'p' + i.id + '|' + String(name) }); } catch (e) {} return loc; });
      for (const [fn, n] of [['uniform1f', 0], ['uniform2f', 2], ['uniform3f', 3], ['uniform4f', 4]]) wrap(fn, (o) => function (loc, ...a) { try { const L = loc && G.locs.get(loc); if (L) putF(L, n === 0 ? a[0] : a.slice(0, n), 0, n || 1, n); } catch (e) {} return o.call(this, loc, ...a); });
      for (const [fn, n] of [['uniform1fv', 1], ['uniform2fv', 2], ['uniform3fv', 3], ['uniform4fv', 4]]) wrap(fn, (o) => function (loc, data, off, len) { try { const L = loc && G.locs.get(loc); if (L) putF(L, data, off, len, n); } catch (e) {} return o.apply(this, arguments); });
      if (CFG.scan) {
        for (const [fn, n] of [['uniform1i', 1], ['uniform2i', 2], ['uniform3i', 3], ['uniform4i', 4], ['uniform1ui', 1], ['uniform2ui', 2], ['uniform3ui', 3], ['uniform4ui', 4]]) wrap(fn, (o) => function (loc, ...a) { try { const L = loc && G.locs.get(loc); if (L) putI(L, a, 0, n, n); } catch (e) {} return o.call(this, loc, ...a); });
        for (const [fn, n] of [['uniform1iv', 1], ['uniform2iv', 2], ['uniform3iv', 3], ['uniform4iv', 4], ['uniform1uiv', 1], ['uniform2uiv', 2], ['uniform3uiv', 3], ['uniform4uiv', 4]]) wrap(fn, (o) => function (loc, data, off, len) { try { const L = loc && G.locs.get(loc); if (L) putI(L, data, off, len, n); } catch (e) {} return o.apply(this, arguments); });
        // a 3x3 is its three columns, the vectors the fit can read
        wrap('uniformMatrix3fv', (o) => function (loc, tr, data, off, len) { try { const L = loc && G.locs.get(loc); if (L) putF(L, data, off, len || (data.length - (off || 0)), 3); } catch (e) {} return o.apply(this, arguments); });
      }
      wrap('uniformMatrix4fv', (o) => function (loc, tr, data, off, len) { try { const L = loc && G.locs.get(loc); if (L) { const total = len || (data ? data.length - (off || 0) : 0);
        if (CFG.scan && total > 16) putArr(L.key, tr ? transposed(data, off || 0, total) : data, tr ? 0 : off || 0, total, 16); else putM(L, tr, data, off); } } catch (e) {} return o.apply(this, arguments); });
      wrap('bindFramebuffer', (o) => function (t, fb) { try { if (fb) { G.fbBinds++; if (!G.fbs.has(fb)) { G.fbs.add(fb); G.fbN++; } } if (CFG.scan && t !== 36008) G.curFb.set(this, fb ? fbOf(fb) : 0); } catch (e) {} return o.call(this, t, fb); });
      if (CFG.scan) {
        // a draw and its geometry: mode, counts, the index type, instances (drawArrays(mode, first, count); drawElements(mode, count, type, offset);
        // ...Instanced(..., instances); drawRangeElements(mode, start, end, count, type, offset))
        const GEO = { drawArrays: (a) => ({ mode: a[0], first: a[1], count: a[2] }), drawElements: (a) => ({ mode: a[0], count: a[1], type: a[2], offset: a[3] }),
          drawArraysInstanced: (a) => ({ mode: a[0], first: a[1], count: a[2], inst: a[3] }), drawElementsInstanced: (a) => ({ mode: a[0], count: a[1], type: a[2], offset: a[3], inst: a[4] }),
          drawRangeElements: (a) => ({ mode: a[0], count: a[3], type: a[4], offset: a[5] }) };
        for (const fn of Object.keys(GEO)) wrap(fn, (o) => function () { try { drawn(this, GEO[fn](arguments)); } catch (e) {} return o.apply(this, arguments); });
        // buffers: size, usage, a content hash per upload, the contents of small ones once per hash, the file a big one came from
        const bufInfo = (b) => b && G.bufId.get(b);
        const bytesOf = (d, off, len) => { if (d == null || typeof d === 'number') return null; let u8 = null;
          if (d instanceof ArrayBuffer) u8 = new Uint8Array(d); else if (ArrayBuffer.isView(d)) { const el = d.BYTES_PER_ELEMENT || 1; u8 = new Uint8Array(d.buffer, d.byteOffset + (off || 0) * el, len ? len * el : d.byteLength - (off || 0) * el); }
          return u8; };
        const fnvBytes = (u8) => { let h = 2166136261; const n = u8.length, w = n >> 2, v32 = (u8.byteOffset & 3) === 0 ? new Uint32Array(u8.buffer, u8.byteOffset, w) : null;
          if (v32) { for (let i = 0; i < w; i++) { h ^= v32[i]; h = Math.imul(h, 16777619); } for (let i = w << 2; i < n; i++) { h ^= u8[i]; h = Math.imul(h, 16777619); } }
          else for (let i = 0; i < n; i++) { h ^= u8[i]; h = Math.imul(h, 16777619); }
          return ((h >>> 0).toString(16).padStart(8, '0')) + ':' + n; };
        const keep = (i, u8, hash) => { if (u8.length > BUF_KEEP) return; if (hash in G.bufStore) { i.kept = true; return; } if (G.bufStoreBytes + u8.length > BUF_STORE) { i.notKept = 'past the 16 MB store of a take'; return; }
          let bin = ''; for (let j = 0; j < u8.length; j += 8192) bin += String.fromCharCode.apply(null, u8.subarray(j, j + 8192)); G.bufStore[hash] = btoa(bin); G.bufStoreBytes += u8.length; i.kept = true; };
        wrap('createBuffer', (o) => function () { const b = o.call(this); try { if (b) { if (G.bufs.length < MAXB) { const i = { id: G.bufs.length + 1, ctx: ctxOf(this), target: null, size: null, usage: null, hash: null, hashes: [], uploads: 0, updates: 0, url: null, kept: false }; G.bufs.push(i); G.bufId.set(b, i); } else G.dropped.buffers = (G.dropped.buffers || 0) + 1; } } catch (e) {} return b; });
        wrap('bindBuffer', (o) => function (target, b) { try { let m = G.boundBuf.get(this); if (!m) G.boundBuf.set(this, m = {}); const i = bufInfo(b) || null; m[target] = i; if (i && i.target == null) i.target = target;
          // the element buffer is the vertex array's state
          if (target === 34963) { const v = vaoState(this); v.index = i; v.ver++; } } catch (e) {} return o.call(this, target, b); });
        wrap('bufferData', (o) => function (target, d, usage, off, len) { try { const i = (G.boundBuf.get(this) || {})[target]; if (i) { i.uploads++; i.usage = usage;
          const u8 = bytesOf(d, off, len); if (u8) { i.size = u8.length; const h = fnvBytes(u8); i.hash = h; if (i.hashes.length < 4 && i.hashes.indexOf(h) < 0) i.hashes.push(h); keep(i, u8, h); const url = G.abUrl.get(u8.buffer); if (url && !i.url) i.url = url; } else if (typeof d === 'number') { i.size = d; i.hash = null; } } } catch (e) {} return o.apply(this, arguments); });
        wrap('bufferSubData', (o) => function (target, dstOff, d, off, len) { try { const i = (G.boundBuf.get(this) || {})[target]; if (i) { i.updates++; const u8 = bytesOf(d, off, len); if (u8) { const h = fnvBytes(u8); i.lastSub = { at: dstOff, hash: h }; if (i.hashes.length < 4 && i.updates <= 4) keep(i, u8, h); } } } catch (e) {} return o.apply(this, arguments); });
        // vertex arrays: the attribute layout a draw reads (WebGL 2 and OES_vertex_array_object); the default one per context
        const vaoState = (gl) => { const cur = G.curVao.get(gl) || gl; let v = G.vaos.get(cur); if (!v) G.vaos.set(cur, v = { id: G.vaos.n = (G.vaos.n || 0) + 1, attrs: {}, on: {}, index: null, ver: 0 }); return v; };
        G.vaoState = vaoState;
        wrap('bindVertexArray', (o) => function (a) { try { G.curVao.set(this, a || null); } catch (e) {} return o.call(this, a); });
        wrap('vertexAttribPointer', (o) => function (idx, size, type, norm, stride, off) { try { const v = vaoState(this), b = (G.boundBuf.get(this) || {})[34962] || null; v.attrs[idx] = { size, type, normalized: !!norm, stride, offset: off, buffer: b ? b.id : null }; v.ver++; } catch (e) {} return o.apply(this, arguments); });
        wrap('vertexAttribIPointer', (o) => function (idx, size, type, stride, off) { try { const v = vaoState(this), b = (G.boundBuf.get(this) || {})[34962] || null; v.attrs[idx] = { size, type, integer: true, stride, offset: off, buffer: b ? b.id : null }; v.ver++; } catch (e) {} return o.apply(this, arguments); });
        wrap('enableVertexAttribArray', (o) => function (idx) { try { const v = vaoState(this); v.on[idx] = 1; v.ver++; } catch (e) {} return o.call(this, idx); });
        wrap('disableVertexAttribArray', (o) => function (idx) { try { const v = vaoState(this); delete v.on[idx]; v.ver++; } catch (e) {} return o.call(this, idx); });
        wrap('vertexAttribDivisor', (o) => function (idx, d) { try { const v = vaoState(this); (v.div || (v.div = {}))[idx] = d; v.ver++; } catch (e) {} return o.call(this, idx, d); });
        // composite state: only the calls that change it (an engine caches its state, so these are few per frame)
        const setSt = (gl, f) => { const s = stOf(gl); f(s); s.sid = null; };
        wrap('clear', (o) => function (mask) { try { if (mask & 16384) { const c = G.ctxIdx.get(this); if (c != null) G.since[c + ':' + (G.curFb.get(this) || 0)] = []; } } catch (e) {} return o.call(this, mask); });
        wrap('enable', (o) => function (cap) { try { const c = CAPS[cap]; if (c) setSt(this, (s) => { s[c] = 1; }); } catch (e) {} return o.call(this, cap); });
        wrap('disable', (o) => function (cap) { try { const c = CAPS[cap]; if (c) setSt(this, (s) => { s[c] = 0; }); } catch (e) {} return o.call(this, cap); });
        wrap('blendEquation', (o) => function (m) { try { setSt(this, (s) => { s.eq = [m, m]; }); } catch (e) {} return o.call(this, m); });
        wrap('blendEquationSeparate', (o) => function (r, a) { try { setSt(this, (s) => { s.eq = [r, a]; }); } catch (e) {} return o.call(this, r, a); });
        wrap('blendFunc', (o) => function (sf, df) { try { setSt(this, (s) => { s.f = [sf, df, sf, df]; }); } catch (e) {} return o.call(this, sf, df); });
        wrap('blendFuncSeparate', (o) => function (sr, dr, sa, da) { try { setSt(this, (s) => { s.f = [sr, dr, sa, da]; }); } catch (e) {} return o.call(this, sr, dr, sa, da); });
        wrap('depthMask', (o) => function (f) { try { setSt(this, (s) => { s.dw = f ? 1 : 0; }); } catch (e) {} return o.call(this, f); });
        wrap('depthFunc', (o) => function (f) { try { setSt(this, (s) => { s.df = f; }); } catch (e) {} return o.call(this, f); });
        wrap('cullFace', (o) => function (m) { try { setSt(this, (s) => { s.cf = m; }); } catch (e) {} return o.call(this, m); });
        wrap('colorMask', (o) => function (r, g, b, a) { try { setSt(this, (s) => { s.cm = [r ? 1 : 0, g ? 1 : 0, b ? 1 : 0, a ? 1 : 0]; }); } catch (e) {} return o.call(this, r, g, b, a); });
        // sampler units: an int a program sets on a sampler says which texture unit it reads (default 0)
        wrap('uniform1i', (o) => function (loc, v) { try { const L = loc && G.locs.get(loc); if (L) (L.info.ints || (L.info.ints = {}))[L.name.replace(/\[0\]$/, '')] = v; } catch (e) {} return o.call(this, loc, v); });
        wrap('createTexture', (o) => function () { const t = o.call(this); try { if (t) { if (G.texList.length < MAXT) { const i = { id: G.texList.length + 1, ctx: ctxOf(this), target: null, w: null, h: null, internalFormat: null, format: null, type: null, source: null, uploads: 0, updates: 0, levels: 0, fb: null, sampled: [] }; G.texList.push(i); G.texId.set(t, i); } else G.dropped.textures++; } } catch (e) {} return t; });
        wrap('activeTexture', (o) => function (u) { try { G.unit.set(this, u - 33984); } catch (e) {} return o.call(this, u); });
        wrap('bindTexture', (o) => function (target, t) { try { let units = G.bound.get(this); if (!units) G.bound.set(this, units = {}); const i = t ? G.texId.get(t) : null; units[(G.unit.get(this) || 0) + '|' + target] = i || null; if (i && i.target == null) i.target = target; } catch (e) {} return o.call(this, target, t); });
        const upload = (gl, target, level, ifmt, w, h, fmt, type, src) => { const i = boundTex(gl, target); if (!i) return; if (level === 0) { if (w != null) i.w = w; if (h != null) i.h = h; i.internalFormat = ifmt; i.format = fmt; i.type = type; i.source = srcKind(src); i.uploads++; } else i.levels = Math.max(i.levels, level); };
        wrap('texImage2D', (o) => function (target, level, ifmt) { try { const a = arguments;
          if (a.length >= 8 && typeof a[3] === 'number' && typeof a[4] === 'number') upload(this, target, level, ifmt, a[3], a[4], a[6], a[7], a.length > 8 ? a[8] : null);
          else { const [w, h] = srcSize(a[5]); upload(this, target, level, ifmt, w, h, a[3], a[4], a[5]); } } catch (e) {} return o.apply(this, arguments); });
        wrap('texImage3D', (o) => function (target, level, ifmt, w, h) { try { upload(this, target, level, ifmt, w, h, arguments[7], arguments[8], arguments[9]); } catch (e) {} return o.apply(this, arguments); });
        wrap('texStorage2D', (o) => function (target, levels, ifmt, w, h) { try { const i = boundTex(this, target); if (i) { i.w = w; i.h = h; i.internalFormat = ifmt; i.source = i.source || 'storage'; i.levels = levels; } } catch (e) {} return o.apply(this, arguments); });
        wrap('texSubImage2D', (o) => function (target) { try { const i = boundTex(this, target); if (i) { i.updates++; const a = arguments, src = a.length >= 9 ? a[8] : a[6]; if (!i.source || i.source === 'storage' || i.source === 'empty') i.source = srcKind(src); } } catch (e) {} return o.apply(this, arguments); });
        wrap('framebufferTexture2D', (o) => function (target, att, textarget, t, level) { try { if (target !== 36008 && t) { const i = G.texId.get(t), id = G.curFb.get(this); if (i && id) { i.fb = id; const f = G.fbList[id - 1]; f.ctx = ctxOf(this); if (f.tex.indexOf(i.id) < 0 && f.tex.length < 8) f.tex.push(i.id); f.w = i.w; f.h = i.h; } } } catch (e) {} return o.apply(this, arguments); });
      }
      const inst = (o) => function () { try { G.instanced++; const c = G.cur.get(this); if (c) c.inst++; } catch (e) {} return o.apply(this, arguments); };
      wrap('drawArraysInstanced', inst); wrap('drawElementsInstanced', inst);
      wrap('vertexAttribDivisor', (o) => function (i, d) { if (d) G.divisor++; return o.call(this, i, d); });
      wrap('getExtension', (o) => function (name) { const x = o.call(this, name); try {
        if (x && /ANGLE_instanced_arrays/i.test(name) && !G.extW.has(x)) { G.extW.add(x); const gl = this;
          for (const f of ['drawArraysInstancedANGLE', 'drawElementsInstancedANGLE']) { const of = x[f]; if (typeof of === 'function') x[f] = function () { G.instanced++; const c = G.cur.get(gl); if (c) c.inst++; if (CFG.scan) { try { const a = arguments; drawn(gl, f === 'drawArraysInstancedANGLE' ? { mode: a[0], first: a[1], count: a[2], inst: a[3] } : { mode: a[0], count: a[1], type: a[2], offset: a[3], inst: a[4] }); } catch (e) {} } return of.apply(this, arguments); }; }
          const od = x.vertexAttribDivisorANGLE; if (typeof od === 'function') x.vertexAttribDivisorANGLE = function (i, d) { if (d) G.divisor++; try { if (CFG.scan && G.vaoState) { const v = G.vaoState(gl); (v.div || (v.div = {}))[i] = d; v.ver++; } } catch (e) {} return od.apply(this, arguments); }; }
        if (x && CFG.scan && /OES_vertex_array_object/i.test(name) && !G.extW.has(x)) { G.extW.add(x); const gl = this, ob = x.bindVertexArrayOES; if (typeof ob === 'function') x.bindVertexArrayOES = function (a) { try { G.curVao.set(gl, a || null); } catch (e) {} return ob.apply(this, arguments); }; }
      } catch (e) {} return x; });
    }
    /** When a canvas last drew (frame key) and in how many frames it drew. */
    W.glCanvas = () => ({ k: G.canvasK == null ? -1 : G.canvasK, frames: G.canvasFrames || 0, contexts: G.ctxs.length });
    /** The contents of the small buffers (<= 256 KB), once per content hash, base64: one JSON string (session tail, series glBuffers). */
    W.glBuffers = () => JSON.stringify(G.bufStore);
    /** Everything read from the WebGL calls (session tail): contexts, programs with sources and uniform lists, counters. */
    W.glInfo = () => ({
      contexts: G.ctxs.map((c, i) => { const el = c.canvas && c.canvas.nodeType === 1 ? c.canvas : null; let end = null; if (CFG.scan && el) { try { end = placeOf(el); } catch (e) {} }
        return { id: i, webgl2: c.v2, el: el ? idOf(el) : null, offscreen: !el, width: c.canvas ? c.canvas.width : null, height: c.canvas ? c.canvas.height : null, ...(CFG.scan ? { place: { firstDraw: G.places[i] || null, end } } : {}) }; }),
      // ints: every int / sampler a program set (a value set once is no key in the rows: the recorder's int rule)
      programs: G.progs.map((p) => { const pre = 'p' + p.id + '|', ints = {}; for (const k in intFirst) if (k.startsWith(pre)) ints[k.slice(pre.length)] = intFirst[k]; if (p.ints) Object.assign(ints, p.ints);
        return { id: p.id, ctx: p.ctx, vs: p.vs, fs: p.fs, vsLen: p.vsLen, fsLen: p.fsLen, links: p.links, uses: p.uses, instancedDraws: p.inst, deleted: p.deleted, uniforms: p.uniforms || listU(p), ...(CFG.scan ? { ints, attributes: Object.values(attrsOf(p)) } : {}) }; }),
      ...(CFG.scan ? { transferred: (W.xfer || []).map((el) => ({ el: idOf(el), width: el.width, height: el.height })), geometries: G.geoms.slice(), buffers: G.bufs.map((b) => ({ id: b.id, ctx: b.ctx, target: b.target, size: b.size, usage: b.usage, hash: b.hash, ...(b.hashes.length > 1 ? { hashes: b.hashes.slice() } : {}), uploads: b.uploads, updates: b.updates, url: b.url, kept: b.kept, ...(b.notKept ? { notKept: b.notKept } : {}) })), arrays: Object.keys(G.arrs).filter((k) => !/\]$/.test(k) || /\[0\]$/.test(k)).length } : {}),
      counters: { frames: G.frame, framebufferBinds: G.fbBinds, framebuffers: G.fbN, instancedDraws: G.instanced, attribDivisors: G.divisor, multi: G.multi, setFrames: G.setFrames, dropped: G.dropped, maxKeys: MAXK, maxMatrices: MAXM, maxObjects: MAXO, objectSlots: OBJ_SLOTS },
      // descriptions only, never pixels: size, format, where it came from, which target it is, who samples it
      textures: G.texList.map((t) => ({ id: t.id, ctx: t.ctx, target: t.target, w: t.w, h: t.h, internalFormat: t.internalFormat, format: t.format, type: t.type, source: t.source, uploads: t.uploads, updates: t.updates, levels: t.levels, fb: t.fb, sampled: t.sampled.slice() })),
      targets: G.fbList.map((f) => ({ id: f.id, ctx: f.ctx, tex: f.tex.slice(), w: f.w, h: f.h })),
      // the composite states draws used (row.glb names them by id): GL enums as numbers
      states: G.states.map((x) => ({ id: x.id, blend: x.blend && { eq: x.blend.eq.slice(), src: x.blend.src.slice(), dst: x.blend.dst.slice() }, depth: Object.assign({}, x.depth), cull: x.cull, scissor: x.scissor, colorMask: x.colorMask.slice() })),
    });
  }
  W.sampling = true;
  const rowEnc = rowEncoder();
  if (CFG.rowTee) W.teeRows = [];
  // a document back from the page cache keeps this runtime, but the rows between went to another one: start a new chain
  addEventListener('pageshow', (e) => { if (e.persisted) rowEnc.reset(); });
  W.sample = (T) => {
    if (!W.sampling) return;
    const t0 = RPN();
    discover();
    if (W.selQ && W.selQ.length) W.noteSelectors();
    const v = {};
    for (const [id, w] of W.watch) { if (!w.el.isConnected) continue; try { v[id] = W.channelsOf(w.el, id); } catch (e) { err('sample: ' + e.message); } }
    const row = { k: W.frameKey(), T, sy: scrollY, sx: scrollX, v };
    if (W.glT) { const G = W.glT; G.frame++; if (G.keys) row.gl = Object.assign({}, G.vals); if (G.mkeys) row.glm = Object.assign({}, G.mats);
      if (CFG.scan && G.ctxs.length) { row.gld = G.draws; G.draws = {}; G.seq = 0; row.glb = G.blends; G.blends = {}; row.glu = G.under; G.under = {}; for (const sk in G.since) if (sk.endsWith(':0')) delete G.since[sk]; if (G.okeys) row.glo = Object.assign({}, G.objs);
        if (G.akeys) row.gla = Object.assign({}, G.arrs); if (G.skeys) row.gls = Object.assign({}, G.slots); row.glg = G.gdraw; G.gdraw = {}; } }
    if (window.__WR_PROBE) { try { row.probe = window.__WR_PROBE(); } catch (e) { err('probe: ' + e.message); } }
    if (window.__WR_PIX) { try { row.pix = window.__WR_PIX.read(); } catch (e) { err('pix: ' + e.message); } }   // X4 canvas pixel channel
    const wire = rowEnc.row(row); W.rows.push(wire);
    if (W.noteRow) W.noteRow(wire);
    if (W.teeRows) W.teeRows.push(row);   // o.rowTee: the full row as well, to prove the delta chain against it
    W.c.sampleMs += RPN() - t0;
  };
  W.drain = (what) => { const o = {}; for (const k of what) { o[k] = W[k]; W[k] = []; } return o; };
  // Page data leaves as one JSON string: Playwright walks a returned object value by value, and that walk over rows was the
  // whole cost of a big page. A site's Array.prototype.toJSON (old Prototype.js) would rewrite what JSON.stringify writes,
  // so any such hook is taken off for the call and put back.
  W.stringify = (x) => {
    const kept = [];
    for (const P of [Object.prototype, Array.prototype, String.prototype, Number.prototype, Boolean.prototype]) { const d = GOPD(P, 'toJSON'); if (d && d.configurable) { delete P.toJSON; kept.push([P, d]); } }
    try { return JS(x); } finally { for (const [P, d] of kept) DP(P, 'toJSON', d); }
  };
  W.drainRows = () => { const s = W.stringify(W.rows); W.rows = []; return s; };
  W.rowsReset = () => rowEnc.reset();
  W.elDescs = (from = 0) => els.slice(from).map((e, i) => desc(e) + (pseudoOf.get(i + from) || ''));
  // A selector that matches exactly this element (look prints it for --el; a bare "div" from the descriptor matches
  // every div). Order: the id; the descriptor's own tag.class selector when it is unique; else :nth-of-type steps up to
  // the nearest ancestor with an id or a unique tag.class selector, or body. Every candidate is checked with
  // querySelectorAll (exactly one match, this element). null when none is unique (disconnected, or > 12 levels deep).
  const descSel = (e) => e.localName + (e.id ? '#' + CSS.escape(e.id) : '') + [...e.classList].filter(c => !/^svelte-/.test(c)).slice(0, 3).map(c => '.' + CSS.escape(c)).join('');
  const qAll = (s) => { try { return document.querySelectorAll(s); } catch (e) { return []; } };
  const only = (s, e) => { const l = qAll(s); return l.length === 1 && l[0] === e; };
  W.selectorOf = (e) => {
    if (!e || e.nodeType !== 1 || !e.isConnected) return null;
    if (e.id && only('#' + CSS.escape(e.id), e)) return '#' + CSS.escape(e.id);
    const own = descSel(e); if (only(own, e)) return own;
    const steps = []; let cur = e;
    for (let d = 0; d < 12 && cur && cur.parentElement; d++) {
      const p = cur.parentElement; const same = [...p.children].filter(c => c.localName === cur.localName);
      steps.unshift(cur.localName + (same.length > 1 ? `:nth-of-type(${same.indexOf(cur) + 1})` : ''));
      const tail = steps.join(' > ');
      if (p === document.body || p === document.documentElement) { const s = p.localName + ' > ' + tail; return only(s, e) ? s : null; }
      if (p.id) { const s = '#' + CSS.escape(p.id) + ' > ' + tail; if (only(s, e)) return s; }
      const ps = descSel(p); if (ps !== p.localName) { const s = ps + ' > ' + tail; if (only(s, e)) return s; }
      cur = p;
    }
    return null;
  };
  /**
   * [id, unique selector | null, how many elements the descriptor's own selector matches NOW, 1 when the node left the
   * page] per element id. A node removed before the take ended (a loader, a hydration or re-render that rebuilt the
   * markup) has no unique selector, but its descriptor selector may still match its successors: counted all the same.
   */
  W.selectors = (ids) => ids.map((id) => { const e = els[id]; if (!e) return [id, null, 0, 1];
    const ps = pseudoOf.get(id) || '';
    if (!e.isConnected) { let n = 0; try { n = qAll(descSel(e)).length; } catch (x) {} return [id, (W.firstSel && W.firstSel.get(id)) || null, n, 1]; }
    let s = null; try { s = W.selectorOf(e); } catch (x) {} return [id, s && s + ps, qAll(descSel(e)).length, 0]; });

  // Scan: the selector of each watched element, read in the first sample after it joined, while it is on the page. A node gone
  // by the end of the take keeps this one, so it has one key at rest and in a test (W.selectors). Once per element.
  if (CFG.scan) {
    W.firstSel = new Map(); W.selQ = [];
    W.noteSelectors = () => {
      const t0 = RPN();
      for (const id of W.selQ) {
        const w = W.watch.get(id); if (!w) continue;
        let s = null; try { s = W.selectorOf(w.el); } catch (x) {}
        W.firstSel.set(id, s && s + (pseudoOf.get(id) || ''));
      }
      W.selQ.length = 0;
      W.c.selMs = (W.c.selMs || 0) + RPN() - t0; W.c.selN = W.firstSel.size;
    };
  }

  // ---------------------------------------------------------------- D3 read-back floor (planted values, own element)
  W.readbackFloor = () => {
    let host, cs; const res = {};
    const fresh = () => { if (host) host.remove(); host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-9999px;top:0;width:10px;height:10px;margin:0;border:0;padding:0';
      (document.body || document.documentElement).appendChild(host); cs = getComputedStyle(host); };
    const vals = []; let s = 12345; for (let i = 0; i < 64; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; vals.push(s / 0x7fffffff); }
    const run = (name, write, read, scale) => { fresh(); let mx = 0; for (const u of vals) { const x = u * scale; write(x); const y = read(); mx = Math.max(mx, Math.abs(y - x)); } res[name] = { maxAbsErr: mx, n: vals.length, range: scale }; };
    run('opacity', x => host.style.opacity = x, () => +cs.opacity, 1);
    run('translateX(px)', x => host.style.transform = `translateX(${x}px)`, () => new DOMMatrixReadOnly(cs.transform).m41, 1000);
    run('scale', x => host.style.transform = `scale(${x})`, () => new DOMMatrixReadOnly(cs.transform).a, 2);
    run('rotate(deg)', x => host.style.transform = `rotate(${x}deg)`, () => { const m = new DOMMatrixReadOnly(cs.transform); return Math.atan2(m.b, m.a) * 180 / Math.PI; }, 170);
    run('translate-prop(px)', x => host.style.translate = `${x}px`, () => parseFloat(cs.translate), 1000);
    run('border-radius(px)', x => host.style.borderRadius = `${x}px`, () => parseFloat(cs.borderTopLeftRadius), 100);
    run('filter-blur(px)', x => host.style.filter = `blur(${x}px)`, () => parseFloat(/blur\(([-\d.e+]+)px\)/.exec(cs.filter)[1]), 20);
    run('clip-inset(%)', x => host.style.clipPath = `inset(${x}%)`, () => parseFloat(/inset\(([-\d.e+]+)%/.exec(cs.clipPath)[1]), 50);
    run('--var(unregistered)', x => host.style.setProperty('--wr-planted', String(x)), () => parseFloat(cs.getPropertyValue('--wr-planted')), 1);
    run('left(px)', x => host.style.left = `${x}px`, () => host.getBoundingClientRect().x, 1000);
    host.remove();
    return res;
  };

  // ---------------------------------------------------------------- rt lane: post-frame sampler on real frames
  if (CFG.lane === 'rt') {
    const mc2 = new MessageChannel(); let pendTs = null; W.rtK = 0; W.rtDt = [];
    let lastTs = null;
    mc2.port1.onmessage = () => { const ts = pendTs; pendTs = null; W.sample(ts); };
    const seenA = new WeakSet();
    const loop = (ts) => {
      W.rtK++; if (lastTs != null && W.rtDt.length < 2e5) W.rtDt.push(ts - lastTs); lastTs = ts;
      pendTs = ts; mc2.port2.postMessage(0);
      if (CFG.births) for (const a of document.getAnimations()) { if (seenA.has(a) || !(a.timeline instanceof DocumentTimeline)) continue; const stt = a.startTime; if (stt == null) continue; seenA.add(a); W.birth(a, stt); }
      RAF(loop);
    };
    if (CFG.rtPhase === 'raf') {
      // Deterministic "recorder first" phase: page rAF callbacks are queued by us and run inside our one real rAF
      // callback, right after the sample, with a microtask checkpoint after each (as browsers do). Without this the
      // order flips whenever a page loop restarts from an event (measured: S4 golden steps 1-2 vs step 0).
      const q = new Map(); let qid = 1;
      window.requestAnimationFrame = (cb) => { const id = qid++; q.set(id, cb); return id; };
      window.cancelAnimationFrame = (id) => { q.delete(id); };
      const loop2 = async (ts) => {
        W.rtK++; if (lastTs != null && W.rtDt.length < 2e5) W.rtDt.push(ts - lastTs); lastTs = ts;
        RAF(loop2);
        W.sample(ts);
        if (CFG.births) for (const a of document.getAnimations()) { if (seenA.has(a) || !(a.timeline instanceof DocumentTimeline)) continue; const stt = a.startTime; if (stt == null) continue; seenA.add(a); W.birth(a, stt); }
        const cbs = [...q.values()]; q.clear();
        for (const cb of cbs) { try { cb(ts); } catch (e) { err('raf cb: ' + (e && e.message)); } await null; }
      };
      RAF(loop2);
    } else RAF(loop);
    W.pin = () => 0;
    return;
  }

  // ---------------------------------------------------------------- hx: timeline override, pin, accessors
  try { Object.defineProperty(document.timeline, 'currentTime', { configurable: true, get: () => performance.now() }); } catch (e) { err('timeline override: ' + e.message); }
  const P = Animation.prototype;
  const orig = { pause: P.pause, play: P.play, reverse: P.reverse, finish: P.finish, updatePlaybackRate: P.updatePlaybackRate,
    ct: Object.getOwnPropertyDescriptor(P, 'currentTime'), pr: Object.getOwnPropertyDescriptor(P, 'playbackRate'),
    st: Object.getOwnPropertyDescriptor(P, 'startTime'), ps: Object.getOwnPropertyDescriptor(P, 'playState') };
  const ST = new WeakMap();
  const st = (a) => { let s = ST.get(a); if (!s) { s = { local: 0, rate: 1, paused: false, seen: false, finished: false, pend: false, lastT: null }; ST.set(a, s); } return s; };
  // Advance one animation's local time to "now" at its current rate before the page changes its playback, so a
  // control call that lands between pins (a timer at exactly T) takes effect at that instant, not one frame early.
  const adv = (a, s) => { const now = performance.now(); if (s.seen && !s.pend && !s.finished && !s.paused && s.lastT != null && !cssPaused(a)) s.local += (now - s.lastT) * s.rate; s.lastT = now; };
  const endOf = (a) => { try { return a.effect ? a.effect.getComputedTiming().endTime : Infinity; } catch (e) { return Infinity; } };
  P.pause = function () { W.c.pagePause++; const s = st(this); adv(this, s); s.paused = true; };
  P.play = function () {
    W.c.pagePlay++; const s = st(this);
    if (orig.ps.get.call(this) === 'idle') { ST.delete(this); return orig.play.call(this); }   // restarted after cancel: re-born at the next pin
    if (s.paused) s.lastT = performance.now();
    s.paused = false;
    if (s.finished) { s.lastT = performance.now(); const end = endOf(this); if (s.rate > 0 && s.local >= end) s.local = 0; else if (s.rate < 0 && s.local <= 0) s.local = end; s.finished = false; }
  };
  P.reverse = function () { W.c.pageReverse++; const s = st(this); adv(this, s); s.rate = -s.rate; s.paused = false; s.finished = false; try { orig.pr.set.call(this, s.rate); } catch (e) {} };
  P.finish = function () { W.c.pageFinish++; const s = st(this); s.finished = true; s.local = s.rate >= 0 ? endOf(this) : 0; return orig.finish.call(this); };
  P.updatePlaybackRate = function (r) { W.c.pageRate++; const s = st(this); adv(this, s); s.rate = r; try { orig.pr.set.call(this, r); } catch (e) {} };
  Object.defineProperty(P, 'playbackRate', { configurable: true, get() { return ST.has(this) ? st(this).rate : orig.pr.get.call(this); }, set(v) { W.c.pageRate++; const s = st(this); adv(this, s); s.rate = v; orig.pr.set.call(this, v); } });
  Object.defineProperty(P, 'currentTime', { configurable: true, get() { return orig.ct.get.call(this); },
    set(v) { W.c.pageCT++; const s = st(this); if (v != null) { s.local = v; s.seen = true; s.finished = false; s.pend = false; s.lastT = performance.now(); } orig.ct.set.call(this, v); } });
  Object.defineProperty(P, 'startTime', { configurable: true,
    get() { const s = ST.get(this); if (!s || !s.seen) return orig.st.get.call(this); if (s.paused || s.finished) return null; return performance.now() - s.local / (s.rate || 1); },
    set(v) {
      W.c.pageStartTime++; const s = st(this); if (v == null) { orig.st.set.call(this, v); return; }
      if (!s.seen && CFG.births) W.birth(this, performance.now());
      s.seen = true; s.paused = false; s.finished = false; s.pend = false; s.local = (performance.now() - v) * s.rate; s.lastT = performance.now(); orig.pause.call(this); orig.ct.set.call(this, s.local);
    } });
  Object.defineProperty(P, 'playState', { configurable: true, get() {
    const s = ST.get(this); const real = orig.ps.get.call(this);
    if (!s || !s.seen || real === 'idle') return real; return s.finished ? 'finished' : s.paused ? 'paused' : 'running'; } });
  const cssPausedCache = new Map();
  const cssPaused = (a) => {
    if (!(window.CSSAnimation && a instanceof CSSAnimation)) return false;
    const t = a.effect && a.effect.target; if (!t) return false;
    let cs = cssPausedCache.get(t); if (!cs) { const c = getComputedStyle(t); cs = { names: c.animationName.split(', '), states: c.animationPlayState.split(', ') }; cssPausedCache.set(t, cs); }
    const i = cs.names.indexOf(a.animationName); return (cs.states[i] || cs.states[0]) === 'paused';
  };
  // phase 'post': pin after the real settle frame. Animations first seen there were created by real tasks (events, IO,
  // network); with birthRule 'next' they start at the NEXT virtual frame (the browser's "starts on the next frame" rule).
  W.pin = (Tov, phase) => {
    const T = Tov != null ? Tov : performance.now(); cssPausedCache.clear();
    let n = 0;
    for (const a of document.getAnimations()) {
      if (!(a.timeline instanceof DocumentTimeline)) continue;          // scroll/view timelines follow the recorder-owned scroll
      const s = st(a); n++;
      const end = endOf(a);
      if (!s.seen) {
        s.seen = true; s.local = (s.rate < 0 && isFinite(end)) ? end : 0; s.lastT = T; s.pend = (phase === 'post' && CFG.birthRule === 'next');
        // 'next' rule: the start is the next virtual frame's time (frameT(k+1)), which is not T + dt under a stall (R5)
        if (CFG.births) W.birth(a, s.pend ? frameT(V.k + 1) : T);
      } else if (s.pend) { if (T > s.lastT) { s.pend = false; s.lastT = T; } }
      else { if (!s.finished && !s.paused && !cssPaused(a) && s.lastT != null) s.local += (T - s.lastT) * s.rate; s.lastT = T; }
      if (s.finished) continue;
      if (isFinite(end) && ((s.rate > 0 && s.local >= end) || (s.rate < 0 && s.local <= 0))) {
        s.local = s.rate > 0 ? end : 0; s.finished = true; W.c.finishedByPin++;
        try { orig.pr.set.call(a, s.rate); orig.finish.call(a); } catch (e) { err('finish: ' + e.message); }
        continue;
      }
      if (W.scan && !s.paused && a.effect && a.effect.pseudoElement) W.scan.signal('pseudo', V.k);
      orig.pause.call(a); orig.ct.set.call(a, s.local);
    }
    W.c.pinned = n;
    return n;
  };

  // ---------------------------------------------------------------- hx virtual clock on an integer frame grid
  const V = W.V = { k: 0, t0: CFG.t0 || 0, dt: CFG.dt, now: CFG.t0 || 0, dateEpoch: CFG.dateEpoch, timers: new Map(), tid: 1, rafs: new Map(), rid: 1, seq: 1 };
  // X1 (M2): optional deterministic stall schedule {every, ms}: frame k is a stall frame of `ms` when k % every == 0
  // (k > 0), still an integer-frame grid: T_k = round6(T0 + k*dt + floor(k/every)*(ms - dt)), never accumulated.
  const ST_ = CFG.stall && CFG.stall.every > 0 ? CFG.stall : null;
  const frameT = (k) => r6(V.t0 + k * V.dt + (ST_ ? Math.floor(k / ST_.every) * (ST_.ms - V.dt) : 0));
  W.frameT = frameT;
  // busy-wait guard (corpus F19): a page spinning on the frozen virtual clock (`while (Date.now() - t0 < ms) {}`) never ends.
  // After SPIN same-value reads in one frame the reading creeps +1 ms (count based, deterministic); it is absorbed when the frame moves on.
  const SPIN = 20000; let spLast = NaN, spN = 0, spOff = 0;
  const spin = (raw) => {
    if (raw === spLast) { if (++spN >= SPIN) { spN = 0; spOff += 1; W.c.spinTicks = (W.c.spinTicks || 0) + 1; } }
    else { if (spLast === spLast) spOff = Math.max(0, spOff - (raw - spLast)); spLast = raw; spN = 0; }
    return raw + spOff;
  };
  performance.now = () => spin(V.now);
  const dateNow = () => CFG.dateInteger ? Math.floor(V.dateEpoch + spin(V.now)) : V.dateEpoch + spin(V.now);
  const FD = function (...args) { if (!new.target) return new OD(dateNow()).toString(); return args.length ? new OD(...args) : new OD(dateNow()); };
  FD.prototype = OD.prototype; FD.now = dateNow; FD.parse = OD.parse; FD.UTC = OD.UTC;
  window.Date = FD;
  window.setTimeout = (cb, ms, ...a) => { const id = V.tid++; V.timers.set(id, { due: r6(V.now + Math.max(0, +ms || 0)), cb, a, every: null, seq: V.seq++ }); return id; };
  window.setInterval = (cb, ms, ...a) => { const id = V.tid++; const every = Math.max(1, +ms || 0); V.timers.set(id, { due: r6(V.now + every), cb, a, every, seq: V.seq++ }); return id; };
  window.clearTimeout = window.clearInterval = (id) => { V.timers.delete(id); };
  window.requestAnimationFrame = (cb) => { const id = V.rid++; V.rafs.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { V.rafs.delete(id); };
  const call = (cb, args) => { try { if (typeof cb === 'function') cb(...args); else (0, eval)(String(cb)); } catch (e) { err('cb: ' + (e && e.message)); } };
  const nextTimer = (target) => { let best = null; for (const [id, t] of V.timers) if (t.due <= target && (!best || t.due < best[1].due || (t.due === best[1].due && t.seq < best[1].seq))) best = [id, t]; return best; };
  const yieldNow = async () => { if (CFG.yieldMode === 'macro') await macro(); else if (CFG.yieldMode === 'micro') await null; };
  // One virtual frame: timers (macrotask yield after each) -> now = T_k -> pin -> rAF callbacks (microtask
  // checkpoint after each) -> pin. The Node side then runs one real frame (events, IO, scroll) and the post-pin.
  W.vstep = async () => {
    const target = frameT(V.k + 1); let nt = 0;
    for (;;) {
      const nx = nextTimer(target); if (!nx) break; const [id, t] = nx; V.now = Math.max(V.now, t.due);
      if (t.every) { t.due = r6(t.due + t.every); t.seq = V.seq++; } else V.timers.delete(id);
      nt++; call(t.cb, t.a); await yieldNow();
    }
    V.k++; V.now = target; W.pin();
    const cbs = [...V.rafs.values()]; V.rafs.clear();
    for (const cb of cbs) { call(cb, [V.now]); if (CFG.yieldMode !== 'none') await null; }
    W.pin(); W.c.timers += nt; W.c.rafs += cbs.length; W.c.steps++;
    return V.k;
  };
  // Input settle (A2): an input given between virtual frames (scrollTo, wheel, mouse move) has effects that the browser
  // dispatches in its next REAL rendering update (scroll events, IntersectionObserver, hover). Without this, whether
  // that update ran before the next virtual frame or inside its settle depended on Node round-trip time, so the page's
  // reaction landed one frame earlier or later at random (measured on a real site: 1 take in 6). Running one real settle
  // here, at the current virtual time, puts every such reaction before the next virtual frame, in every take.
  let busy = 0;   // > 0 while a virtual frame or an input settle runs (they pin themselves)
  W.flush = async () => { busy++; try { await W.realFrame(); W.pin(null, 'post'); } finally { busy--; } return V.k; };
  // full step used by the driver: virtual frame, real settle, post-pin, sample
  W.step = async (doSample) => { busy++; try { await W.vstep(); await W.realFrame(); W.pin(null, 'post'); } finally { busy--; } if (doSample) W.sample(V.now); return V.k; };
  W.steps = async (n, doSample) => { for (let i = 0; i < n; i++) await W.step(doSample); return V.k; };
  // ---------------------------------------------------------------- scan: what moved, the control set, W.quiet (DESIGN 3.3)
  if (CFG.scan && scanTracker) {
    const Q = W.scan = scanTracker();
    W.noteRow = (wire) => {
      const x = wire.x, G = W.glT;
      Q.row(wire, G && x && ((x.gl && x.gl !== 0) || (x.glm && x.glm !== 0)) ? Object.assign({}, G.vals, G.mats) : null);
    };
    // what no row can see: a draw on a visible 2D canvas, a mutated attribute of a visible SVG (Lottie writes attributes)
    const drew = new WeakMap();
    const noteCanvas = (c) => { const k = V.k; if (!c || drew.get(c) === k) return; drew.set(c, k); try { if (c.isConnected && onScreen(c)) Q.signal('canvas', k); } catch (e) {} };
    const C2 = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
    if (C2) for (const fn of ['fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'putImageData']) {
      const o = C2[fn]; if (typeof o === 'function') C2[fn] = function (...a) { noteCanvas(this.canvas); return o.apply(this, a); };
    }
    new MutationObserver((list) => {
      let told = false;
      for (const r of list) {
        const t = r.target; if (!(t instanceof SVGElement)) continue;
        try { if (!told && onScreen(t.ownerSVGElement || t)) { Q.signal('svg', V.k); told = true; } } catch (e) {}
        noteAttr(t, r.attributeName);
      }
    }).observe(document, { attributes: true, subtree: true });
    // Discovery (DESIGN 3.6): SVG attributes. `transform`, `opacity`, `fill`, `stroke` and the dash offset already reach the computed
    // style, so the element only has to join the moving set. A Lottie writes hundreds of nodes per frame, so one <svg> gives at most
    // SVG_WATCH elements (W.c.svgOver counts the rest, and its pictures still run on the svg signal).
    const SVG_WATCH = 16, IN_STYLE = new Set(['transform', 'opacity', 'fill', 'stroke', 'stroke-dashoffset']);
    const svgCount = new WeakMap(), svgLeft = new WeakSet(), attrs = W.attrsOf = new Map(), shapes = new Map();
    const noteAttr = (t, name) => {
      if (!name || name === 'style' || name === 'class') return;   // W.mut has those
      let id = elIds.get(t);
      if (id == null || !W.watch.has(id)) {
        const root = t.ownerSVGElement || t, n = svgCount.get(root) || 0;
        if (n >= SVG_WATCH) { if (!svgLeft.has(t)) { svgLeft.add(t); W.c.svgOver = (W.c.svgOver || 0) + 1; } return; }
        svgCount.set(root, n + 1); id = idOf(t); watch(t, 'attr');
      }
      if (IN_STYLE.has(name) || !/^[A-Za-z][\w:-]{0,40}$/.test(name)) return;
      if (W.gsapHook && W.gsapHook.attrs === 'core' && name !== 'd') return;   // the 5 % stop of DESIGN 3.6
      let s = attrs.get(id); if (!s) attrs.set(id, (s = new Set())); s.add(name);
    };
    // A morph has no number of its own and its path text is far too long for a row: the channel is the mean distance of its
    // coordinates from the first shape seen, which runs from 0 to the full change as the morph plays.
    const NUMS = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
    const shapeValue = (id, s) => {
      let c = shapes.get(id);
      if (c && c.s === s) return c.v;
      const n = (s.match(NUMS) || []).slice(0, 4000).map(Number);
      if (!c) { shapes.set(id, (c = { s, v: 0, base: n })); return 0; }
      let sum = 0; const m = Math.min(n.length, c.base.length); for (let i = 0; i < m; i++) sum += Math.abs(n[i] - c.base[i]);
      c.s = s; c.v = n.length === c.base.length ? (m ? r6(Math.round((sum / m) * 100) / 100) : 0) : Math.abs(n.length - c.base.length);
      return c.v;
    };
    W.attrChannels = (el, id, names, o) => {
      for (const n of names) {
        const s = el.getAttribute(n); if (s == null) continue;
        if (n === 'd' || n === 'points') { o['ren:--svg-' + n] = shapeValue(id, s); continue; }
        const v = parseFloat(s); o['ren:--svg-' + n] = Number.isFinite(v) && String(v) === s.trim() ? v : s.slice(0, 80);
      }
    };
    // Discovery: text that keeps changing, a scramble or a typewriter. One write is content, a second is motion. A text set by
    // replacing its node is a childList change, not characterData. At most TEXT_WATCH elements a document.
    const TEXT_WATCH = 400, TEXT_MAX = 120, textSeen = new WeakMap(), chars = W.charsOf = new Set();
    W.charsText = (el) => String(el.textContent).slice(0, TEXT_MAX).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');
    new MutationObserver((list) => {
      for (const r of list) {
        const t = r.type === 'characterData' ? r.target.parentElement : r.target;
        if (!t || t.nodeType !== 1 || t.childElementCount > 8) continue;
        if (r.type === 'childList') { let text = false; for (const n of r.addedNodes) if (n.nodeType === 3) text = true; if (!text) continue; }
        const n = (textSeen.get(t) || 0) + 1; textSeen.set(t, n);
        if (n < 2) continue;
        const id = idOf(t); if (chars.has(id)) continue;
        if (chars.size >= TEXT_WATCH) { W.c.textOver = (W.c.textOver || 0) + 1; continue; }
        chars.add(id); watch(t, 'text');
      }
    }).observe(document, { characterData: true, childList: true, subtree: true });
    // what turns the gate off for the take: a picture that changes with no row and no signal. The media clock runs on real time.
    const played = new Set();
    try { const PL = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function (...a) { if (this instanceof HTMLVideoElement) played.add(this); return PL.apply(this, a); }; } catch (e) {}
    const rolling = (v) => !v.paused && !v.ended && v.readyState >= 2;
    let off = null;
    const opaque = () => {
      if (off) return off;
      for (const v of document.querySelectorAll('video')) if (rolling(v) && onScreen(v)) return (off = 'video');
      for (const v of played) if (!v.isConnected && rolling(v)) return (off = 'video');   // a texture, drawn by a canvas
      for (const c of W.xfer || []) if (c.isConnected && onScreen(c)) return (off = 'worker-canvas');
      for (const f of document.querySelectorAll('iframe')) {
        const src = f.getAttribute('src') || 'about:blank', o = originOf(src);
        if (o && o !== 'null' && o !== location.origin && !/^(about|data|blob|javascript):/i.test(src) && onScreen(f)) return (off = 'cross-origin-frame');
      }
      return null;
    };
    W.controlStart = () => Q.controlStart();
    W.controlStop = () => Q.controlStop();
    W.controlClear = () => Q.controlClear();
    W.partStart = () => { Q.part(V.k, V.tid); if (W.gsapHook) W.gsapHook.born.length = 0; };
    /** At rest for this part: n still frames outside the control set, no finite animation left, no timer armed since the input. */
    W.quiet = (n) => {
      const k = V.k;
      if (Q.still(k) < n) return false;
      for (const a of document.getAnimations()) {
        if (!(a.timeline instanceof DocumentTimeline)) continue;
        if (!isFinite(endOf(a))) continue;
        const s = ST.get(a);
        if (s && (s.finished || s.paused)) continue;
        if (cssPaused(a)) continue;
        const t = a.effect && a.effect.target, id = t ? elIds.get(t) : null;
        if (id != null && Q.inControl(id)) continue;
        return false;
      }
      const from = Q.partTid();
      for (const [id, t] of V.timers) if (!t.every && id >= from) return false;   // an interval has no end to wait for
      return !(W.gsapHook && W.gsapHook.pending((id) => Q.inControl(id)));   // GSAP's delays live in its rAF ticker, which the timers above cannot see
    };
    /** One read per frame for the frame recorder: where the page is, whether a picture is due, and W.quiet(n) when asked. */
    W.shotInfo = (n) => ({ k: V.k, T: performance.now(), sx: scrollX, sy: scrollY, moved: Q.moved(V.k), off: opaque(), quiet: n ? W.quiet(n) : null });
  }

  // Between virtual frames (the driver's round trip, a network or page-idle wait, slow on a busy machine or a slow server)
  // real frames keep running. An animation the page starts in a real task then (a promise after a fetch or a font, an
  // event) would play on real time and can even finish before the next virtual frame pins it, and is then never seen
  // (measured: 2 s of network latency lost a load intro of 9 elements). Every real frame outside a virtual frame pins,
  // so such an animation is held at its start and starts on the virtual clock, whatever the wait lasted.
  const between = () => { if (!busy) { try { W.pin(null, 'post'); } catch (e) { err('pin between frames: ' + (e && e.message)); } } RAF(between); };
  RAF(between);
}

/**
 * Scan: what the wire rows say moved, and when this part last changed. Self-contained, serialised into the page like rowEncoder,
 * and run directly by the unit tests. A control window (nothing touched) teaches which elements and GL uniforms move by
 * themselves; until controlClear they ask for no picture and do not hold W.quiet. Keys are element ids and uniform keys.
 */
export function scanTracker() {
  const NEVER = -1e9;
  const sig = { canvas: NEVER, svg: NEVER, pseudo: NEVER };
  let changedK = NEVER, scrollK = NEVER, partK = NEVER, tid = 0, sy = null, sx = null;
  let ctl = null, learning = false, ctlSig = { canvas: false, svg: false };
  const seenGl = new Map();
  const eq = (a, b) => {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const touch = (key, k) => { if (learning) ctl.add(key); else if (!ctl || !ctl.has(key)) changedK = k; };
  return {
    /** One wire row; gl = every uniform value now, only on a row whose uniforms changed. */
    row(w, gl) {
      const k = w.k;
      if (sy != null && (w.sy !== sy || w.sx !== sx)) scrollK = k;
      sy = w.sy; sx = w.sx;
      if (gl) for (const key of Object.keys(gl)) { const had = seenGl.has(key); if (had && eq(seenGl.get(key), gl[key])) continue; seenGl.set(key, gl[key]); if (had) touch('gl:' + key, k); }
      if (w.r) return;   // the start of a chain sends everything: no change in itself
      if (w.e) for (let i = 0; i < w.e.length; i++) touch(w.e[i][0], k);
      if (w.g) for (let i = 0; i < w.g.length; i++) touch(w.g[i], k);
    },
    signal(name, k) { sig[name] = k; if (learning && name in ctlSig) ctlSig[name] = true; },
    controlStart() { ctl = new Set(); ctlSig = { canvas: false, svg: false }; learning = true; },
    controlStop() { learning = false; },
    controlClear() { ctl = null; learning = false; ctlSig = { canvas: false, svg: false }; },
    part(k, nextTid) { partK = k; tid = nextTid; },
    partTid() { return tid; },
    inControl(id) { return !!ctl && ctl.has(id); },
    /** A picture is due: something changed in this frame or the one before (a canvas and a pseudo-element have no control set). */
    moved(k) { return k - Math.max(changedK, scrollK, sig.canvas, sig.svg, sig.pseudo) < 2; },
    /** Frames since this part's input or its last change, whichever is later. */
    still(k) { return k - Math.max(changedK, partK, ctlSig.canvas ? NEVER : sig.canvas, ctlSig.svg ? NEVER : sig.svg); },
  };
}

/** Script text for addInitScript. */
export function inpageSource(cfg) {
  return `(${wrRuntime.toString()})(${JSON.stringify(cfg)}, ${rowEncoder.toString()}${cfg.scan ? `, ${scanTracker.toString()}` : ''});`;
}
