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
export function wrRuntime(CFG) {
  if (window.__WR) return;
  const isTop = (() => { try { return window.top === window; } catch { return false; } })();
  const RAF = window.requestAnimationFrame.bind(window);
  const RPN = performance.now.bind(performance);
  const RST = window.setTimeout.bind(window);
  const RIC0 = window.requestIdleCallback ? window.requestIdleCallback.bind(window) : null;   // native, before the page or the escape wrapper replaces it
  const OD = Date;
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
  wrapCtor('Worker', 'worker', 'a Worker has its own clock (performance.now, timers, rAF); hx steps only the top document');
  wrapCtor('SharedWorker', 'shared-worker', 'a SharedWorker has its own clock; hx steps only the top document');
  wrapCtor('OffscreenCanvas', 'offscreen-canvas', 'OffscreenCanvas can render from a worker clock that hx does not control');
  try {
    const T = HTMLCanvasElement.prototype.transferControlToOffscreen;
    if (T) HTMLCanvasElement.prototype.transferControlToOffscreen = function (...a) { escape('offscreen-canvas', 'canvas control moved off the main thread; frames come from a clock hx does not control'); return T.apply(this, a); };
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
    if (d && d.get) Object.defineProperty(Event.prototype, 'timeStamp', { configurable: true, get() { if (CFG.lane === 'hx') escape('event-timestamp', 'Event.timeStamp is real time; velocity trackers that read it see real, not virtual, deltas'); return d.get.call(this); } });
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
    try { kf = a.effect.getKeyframes().slice(0, 12).map(f => { const o = {}; for (const [k, v] of Object.entries(f)) if (k !== 'computedOffset') o[k] = typeof v === 'string' ? v.slice(0, 120) : v; return o; }); } catch (e) {}
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
    if (W.watch.size < cap || (why === 'selector' && CFG.capPolicy) || evictFor(el)) { W.watch.set(id, { el, why }); over.delete(id); return; }
    if (over.size < 1e6) over.add(id); W.c.watchOverflow = over.size;
  };
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
  const discover = () => {
    if (CFG.aim) { aimDiscover(); return; }
    if (CFG.discover === false) return;
    for (const a of document.getAnimations()) { const t = a.effect && a.effect.target; if (t) watch(t, 'animation'); }
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
    if (!ps) { const n = leadNum(el); if (n != null) o['ren:text'] = n; }
    if (ps) {   // a pseudo-element: no rect, no inline style; its size comes from the computed style when it is a number of px
      const w = parseFloat(cs.width), h = parseFloat(cs.height); if (Number.isFinite(w)) o['ren:bw'] = w; if (Number.isFinite(h)) o['ren:bh'] = h;
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
      dropped: { keys: [], arrays: [], matrices: [], programs: 0 }, multi: {}, setFrames: {}, last: {}, frame: 0, fbs: new WeakSet(), fbN: 0, fbBinds: 0, instanced: 0, divisor: 0, cur: new WeakMap(), extW: new WeakSet() };
    const MAXK = CFG.glMaxKeys || 96, MAXM = 8, MAXSRC = 200000, MAXP = 64, MAXU = 160;
    const TY = { 5126: 'float', 35664: 'vec2', 35665: 'vec3', 35666: 'vec4', 5124: 'int', 35667: 'ivec2', 35668: 'ivec3', 35669: 'ivec4', 5125: 'uint', 35670: 'bool', 35674: 'mat2', 35675: 'mat3', 35676: 'mat4',
      35678: 'sampler2D', 35679: 'sampler3D', 35680: 'samplerCube', 35682: 'sampler2DShadow', 36289: 'sampler2DArray', 36298: 'isampler2D', 36306: 'usampler2D' };
    const noteOnce = (list, k) => { if (list.length < 40 && !list.includes(k)) list.push(k); };
    const ctxOf = (gl) => { let c = G.ctxIdx.get(gl); if (c == null) { c = G.ctxs.length; G.ctxs.push({ gl, canvas: gl.canvas, v2: !!(window.WebGL2RenderingContext && gl instanceof WebGL2RenderingContext) }); G.ctxIdx.set(gl, c); } return c; };
    const same = (a, b) => { if (typeof a === 'number' || typeof b === 'number') return a === b; if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
    const listU = (p) => { const out = []; try { const gl = p.gl; const n = gl.getProgramParameter(p.p, gl.ACTIVE_UNIFORMS) || 0;
      for (let i = 0; i < Math.min(n, MAXU); i++) { const u = gl.getActiveUniform(p.p, i); if (u) out.push({ name: u.name, type: TY[u.type] || String(u.type), size: u.size }); }
      if (n > MAXU) out.push({ name: '…', type: 'more', size: n - MAXU }); } catch (e) { return null; } return out; };
    // per-frame bookkeeping (page frame key): a uniform set to two different values in one frame is set per draw (one
    // value per object), so its last value is not the uniform's motion
    const store = (bag, key, v) => {
      const fk = W.frameKey();
      if (G.last[key] === fk) { if (!same(bag[key], v)) G.multi[key] = (G.multi[key] || 0) + 1; }
      else { G.last[key] = fk; G.setFrames[key] = (G.setFrames[key] || 0) + 1; }
      bag[key] = v;
    };
    const putF = (L, data, off, len, n) => {
      if (data == null) return;
      const key = L.key;
      let v;
      if (n === 0) v = Number(data);
      else { off = off || 0; const total = len || (data.length - off); if (total > n) { noteOnce(G.dropped.arrays, key); return; } v = Array.prototype.slice.call(data, off, off + n).map(Number); if (v.length === 1) v = v[0]; }
      if (!(key in G.vals)) { if (G.keys >= MAXK) { noteOnce(G.dropped.keys, key); return; } G.keys++; }
      store(G.vals, key, v);
    };
    const camName = (nm) => /proj|view|cam|mvp/i.test(nm) && !/normal|shadow|light|bone|tex|uv|inverse|inv[A-Z_]/.test(nm);
    const putM = (L, transpose, data, off) => {
      if (!data || data.length < 16) return;
      off = off || 0; let m = Array.prototype.slice.call(data, off, off + 16).map(Number); if (m.length < 16) return;
      if (transpose) m = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15].map((i) => m[i]);
      const key = L.key;
      if (!(key in G.mats)) {
        const persp = Math.abs(m[11] + 1) < 1e-6 && Math.abs(m[15]) < 1e-6;
        if (!camName(L.name) && !persp) return;
        if (G.mkeys >= MAXM) { noteOnce(G.dropped.matrices, key); return; } G.mkeys++;
      }
      store(G.mats, key, m);
    };
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
      wrap('uniformMatrix4fv', (o) => function (loc, tr, data, off) { try { const L = loc && G.locs.get(loc); if (L) putM(L, tr, data, off); } catch (e) {} return o.apply(this, arguments); });
      wrap('bindFramebuffer', (o) => function (t, fb) { try { if (fb) { G.fbBinds++; if (!G.fbs.has(fb)) { G.fbs.add(fb); G.fbN++; } } } catch (e) {} return o.call(this, t, fb); });
      const inst = (o) => function () { try { G.instanced++; const c = G.cur.get(this); if (c) c.inst++; } catch (e) {} return o.apply(this, arguments); };
      wrap('drawArraysInstanced', inst); wrap('drawElementsInstanced', inst);
      wrap('vertexAttribDivisor', (o) => function (i, d) { if (d) G.divisor++; return o.call(this, i, d); });
      wrap('getExtension', (o) => function (name) { const x = o.call(this, name); try {
        if (x && /ANGLE_instanced_arrays/i.test(name) && !G.extW.has(x)) { G.extW.add(x); const gl = this;
          for (const f of ['drawArraysInstancedANGLE', 'drawElementsInstancedANGLE']) { const of = x[f]; if (typeof of === 'function') x[f] = function () { G.instanced++; const c = G.cur.get(gl); if (c) c.inst++; return of.apply(this, arguments); }; }
          const od = x.vertexAttribDivisorANGLE; if (typeof od === 'function') x.vertexAttribDivisorANGLE = function (i, d) { if (d) G.divisor++; return od.apply(this, arguments); }; }
      } catch (e) {} return x; });
    }
    /** Everything read from the WebGL calls (session tail): contexts, programs with sources and uniform lists, counters. */
    W.glInfo = () => ({
      contexts: G.ctxs.map((c, i) => { const el = c.canvas && c.canvas.nodeType === 1 ? c.canvas : null; return { id: i, webgl2: c.v2, el: el ? idOf(el) : null, offscreen: !el, width: c.canvas ? c.canvas.width : null, height: c.canvas ? c.canvas.height : null }; }),
      programs: G.progs.map((p) => ({ id: p.id, ctx: p.ctx, vs: p.vs, fs: p.fs, vsLen: p.vsLen, fsLen: p.fsLen, links: p.links, uses: p.uses, instancedDraws: p.inst, deleted: p.deleted, uniforms: p.uniforms || listU(p) })),
      counters: { frames: G.frame, framebufferBinds: G.fbBinds, framebuffers: G.fbN, instancedDraws: G.instanced, attribDivisors: G.divisor, multi: G.multi, setFrames: G.setFrames, dropped: G.dropped, maxKeys: MAXK, maxMatrices: MAXM },
    });
  }
  W.sampling = true;
  W.sample = (T) => {
    if (!W.sampling) return;
    const t0 = RPN();
    discover();
    const v = {};
    for (const [id, w] of W.watch) { if (!w.el.isConnected) continue; try { v[id] = W.channelsOf(w.el, id); } catch (e) { err('sample: ' + e.message); } }
    const row = { k: W.frameKey(), T, sy: scrollY, sx: scrollX, v };
    if (W.glT) { const G = W.glT; G.frame++; if (G.keys) row.gl = Object.assign({}, G.vals); if (G.mkeys) row.glm = Object.assign({}, G.mats); }
    if (window.__WR_PROBE) { try { row.probe = window.__WR_PROBE(); } catch (e) { err('probe: ' + e.message); } }
    if (window.__WR_PIX) { try { row.pix = window.__WR_PIX.read(); } catch (e) { err('pix: ' + e.message); } }   // X4 canvas pixel channel
    W.rows.push(row);
    W.c.sampleMs += RPN() - t0;
  };
  W.drain = (what) => { const o = {}; for (const k of what) { o[k] = W[k]; W[k] = []; } return o; };
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
    if (!e.isConnected) { let n = 0; try { n = qAll(descSel(e)).length; } catch (x) {} return [id, null, n, 1]; }
    let s = null; try { s = W.selectorOf(e); } catch (x) {} return [id, s && s + ps, qAll(descSel(e)).length, 0]; });

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
  // Between virtual frames (the driver's round trip, a network or page-idle wait, slow on a busy machine or a slow server)
  // real frames keep running. An animation the page starts in a real task then (a promise after a fetch or a font, an
  // event) would play on real time and can even finish before the next virtual frame pins it, and is then never seen
  // (measured: 2 s of network latency lost a load intro of 9 elements). Every real frame outside a virtual frame pins,
  // so such an animation is held at its start and starts on the virtual clock, whatever the wait lasted.
  const between = () => { if (!busy) { try { W.pin(null, 'post'); } catch (e) { err('pin between frames: ' + (e && e.message)); } } RAF(between); };
  RAF(between);
}

/** Script text for addInitScript. */
export function inpageSource(cfg) {
  return `(${wrRuntime.toString()})(${JSON.stringify(cfg)});`;
}
