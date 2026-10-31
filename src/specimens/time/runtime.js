// Page runtime of a time specimen. Inlined into the page next to the kernel (`pageRuntime.toString()`), so this function
// must be self-contained: no imports, no outer references. It builds the neutral stage from the spec, plays it live and
// exposes the seek contract.
//
// Contract `reva.specimen/0` (what the scorer and the skill rely on):
//   window.seek(t)             t in ms on the specimen timeline (0 = the anchor frame). Synchronous, deterministic, pure in
//                              (spec, t, frameMs): stops live play, writes every track, returns {t, values}.
//   window.__specimen          {schema, id, durationMs, frameMs, tracks, spec, play(fromMs), pause(), seek, values(t, o),
//                               series(trackId, times)}  - values()/series() do not touch the DOM.
//   start                      live play starts on the `go` window event (the recorder's post-boot signal, like the lab
//                              pages) or, with `#auto` in the URL hash, on the first animation frame. The first frame
//                              after the start is the anchor (t = 0); later frames use their real timestamps.
//   `#t=<ms>`                  seek to t at load (static render, e.g. for a screenshot strip); `#frame=<ms>` overrides the
//                              nominal seek grid.
// Banned inside specimens (beatapi / HyperFrames discipline): Date.now, free-running timers, unseeded random.
export function pageRuntime(K, SPEC) {
  'use strict';
  const doc = document;
  const stage = doc.getElementById('s');
  const hash = String(location.hash || '');
  const hashNum = (name) => { const m = new RegExp('[#&]' + name + '=(-?[0-9.]+)').exec(hash); return m ? +m[1] : null; };
  let frameMs = hashNum('frame') || SPEC.timeline.frameMs;

  // ---- elements
  const els = SPEC.elements.map((e) => {
    const d = doc.createElement('div');
    d.id = e.id; d.className = 'b';
    d.style.left = e.x + 'px'; d.style.top = e.y + 'px'; d.style.width = e.w + 'px'; d.style.height = e.h + 'px';
    stage.appendChild(d);
    return d;
  });
  const elOf = (tr) => els[tr.el];
  const tfState = SPEC.elements.map(() => ({ tx: 0, ty: 0, rz: 0, sx: 1, sy: 1, written: '' }));
  const TF = { tx: 1, ty: 1, rz: 1, sx: 1, sy: 1 };

  // ---- var -> property mappings (one stylesheet, built from the spec)
  const rules = [];
  const mapRule = {
    tx: (n) => 'transform:translateX(calc(var(' + n + ',0) * 1px))', ty: (n) => 'transform:translateY(calc(var(' + n + ',0) * 1px))',
    rz: (n) => 'transform:rotate(calc(var(' + n + ',0) * 1deg))', sx: (n) => 'transform:scaleX(var(' + n + ',1))', sy: (n) => 'transform:scaleY(var(' + n + ',1))',
    opacity: (n) => 'opacity:var(' + n + ',1)', w: (n) => 'width:calc(var(' + n + ',56) * 1px)', h: (n) => 'height:calc(var(' + n + ',56) * 1px)',
  };
  const registered = new Set();
  for (const tr of SPEC.tracks) {
    if (tr.channel !== 'var') continue;
    if (tr.mapTo && mapRule[tr.mapTo]) rules.push('#' + SPEC.elements[tr.el].id + '{' + mapRule[tr.mapTo](tr.name) + '}');
    if (tr.impl !== 'js' && !registered.has(tr.name)) { registered.add(tr.name); rules.push('@property ' + tr.name + '{syntax:"<number>";inherits:false;initial-value:' + K.restOf(tr.motion) + '}'); }
  }
  if (rules.length) { const st = doc.createElement('style'); st.textContent = rules.join('\n'); doc.head.appendChild(st); }

  // ---- writers
  const fmt = (v) => String(+v.toFixed(9));
  function composeTf(i) {
    const s = tfState[i], parts = SPEC.elements[i].tf;                   // parts: which components this element uses
    const out = [];
    if (parts.tx || parts.ty) out.push('translate(' + fmt(s.tx) + 'px,' + fmt(s.ty) + 'px)');
    if (parts.rz) out.push('rotate(' + fmt(s.rz) + 'deg)');
    if (parts.sx || parts.sy) out.push('scale(' + fmt(s.sx) + ',' + fmt(s.sy) + ')');
    return out.join(' ');
  }
  function write(tr, v) {
    const el = elOf(tr);
    if (tr.channel === 'var') { el.style.setProperty(tr.name, fmt(v)); return; }
    if (tr.channel === 'opacity') { el.style.opacity = fmt(v); return; }
    if (tr.channel === 'w') { el.style.width = fmt(v) + 'px'; return; }
    if (tr.channel === 'h') { el.style.height = fmt(v) + 'px'; return; }
    if (TF[tr.channel]) {
      const s = tfState[tr.el]; s[tr.channel] = v;
      const str = composeTf(tr.el);
      if (str !== s.written) { s.written = str; el.style.transform = str; }
    }
  }
  const lastVal = SPEC.tracks.map(() => null);
  function put(tr, v) { if (lastVal[tr.i] === v) return; lastVal[tr.i] = v; write(tr, v); }

  // ---- declared (css / waapi) tracks: the engine runs them, seek pauses them
  const PROP = {
    tx: (v) => ['transform', 'translateX(' + fmt(v) + 'px)'], ty: (v) => ['transform', 'translateY(' + fmt(v) + 'px)'], rz: (v) => ['transform', 'rotate(' + fmt(v) + 'deg)'],
    sx: (v) => ['transform', 'scaleX(' + fmt(v) + ')'], sy: (v) => ['transform', 'scaleY(' + fmt(v) + ')'], opacity: (v) => ['opacity', fmt(v)],
    w: (v) => ['width', fmt(v) + 'px'], h: (v) => ['height', fmt(v) + 'px'],
  };
  const propOf = (tr, v) => (tr.channel === 'var' ? [tr.name, fmt(v)] : PROP[tr.channel](v));
  function framesOf(m) {
    if (m.kind === 'keyframes') return m;
    return { kind: 'keyframes', startMs: m.startMs, durationMs: m.durationMs, iterations: 1, direction: 'normal', fill: 'both', easingScope: 'segment', easing: null,
      frames: [{ offset: 0, value: m.from, easing: m.ease }, { offset: 1, value: m.to }] };
  }
  // A declared animation exists from its birth on (motion.birthMs, default 0): before that the element shows its unanimated value.
  // Animations are created when the specimen reaches their birth (live) or when seek() lands at/after it; their effect delay is
  // measured from the birth, so animation time = specimen time - birth.
  const RANK = { tx: 0, ty: 1, rz: 2, sx: 3, sy: 4 };
  const anims = new Map();           // track.i -> Animation
  let cssCount = 0;
  const birthOf = (tr) => tr.motion.birthMs || 0;
  const declared = [];               // filled below, after tracks are numbered
  function kfsOf(tr) {
    const m = framesOf(tr.motion);
    const kfs = m.frames.map((f) => {
      const [prop, val] = propOf(tr, f.value);
      const e = f.easing !== undefined && f.easing !== null ? K.cssEasing(f.easing) : (m.easingScope === 'effect' || !m.easing ? 'linear' : K.cssEasing(m.easing));
      return { offset: f.offset, [prop]: val, easing: e || 'linear' };
    });
    const timing = { duration: m.durationMs, delay: m.startMs - birthOf(tr), iterations: m.iterations == null ? 1 : m.iterations, direction: m.direction || 'normal', fill: m.fill || 'both',
      easing: m.easingScope === 'effect' && m.easing ? K.cssEasing(m.easing) || 'linear' : 'linear' };
    return { kfs, timing };
  }
  const cssName = new Map();         // track.i -> @keyframes name (rules are written once)
  function cssRule(tr) {
    if (cssName.has(tr.i)) return cssName.get(tr.i);
    const { kfs } = kfsOf(tr), name = 'k' + (cssCount++);
    const sheet = doc.createElement('style');
    sheet.textContent = '@keyframes ' + name + '{' + kfs.map((k) => (k.offset * 100) + '%{' + Object.keys(k).filter((x) => x !== 'offset' && x !== 'easing').map((x) => x + ':' + k[x]).join(';') + ';animation-timing-function:' + k.easing + '}').join('') + '}';
    doc.head.appendChild(sheet); cssName.set(tr.i, name); return name;
  }
  /**
   * Make the set of existing declared animations match specimen time t: tracks born at or before t exist, the others do not.
   * live: new animations get startTime = anchor + birth. seek (anchorTs null): every existing animation is paused at t - birth.
   */
  function syncDeclared(t, anchorTs) {
    const byEl = new Map();
    for (const tr of declared) {
      const want = t >= birthOf(tr) - 1e-5;
      const has = anims.has(tr.i);
      if (tr.impl === 'waapi') {
        if (want && !has) { const { kfs, timing } = kfsOf(tr); const a = elOf(tr).animate(kfs, { ...timing, composite: TF[tr.channel] ? 'add' : 'replace' }); anims.set(tr.i, a); if (anchorTs != null) a.startTime = anchorTs + birthOf(tr); }
        else if (!want && has) { anims.get(tr.i).cancel(); anims.delete(tr.i); }
      } else {
        const list = byEl.get(tr.el) || []; byEl.set(tr.el, list); if (want) list.push(tr);
      }
    }
    for (const [i, list] of byEl) {
      const el = els[i];
      const names = list.map((tr) => { const { timing } = kfsOf(tr); return cssRule(tr) + ' ' + timing.duration + 'ms linear ' + timing.delay + 'ms ' + (timing.iterations === Infinity ? 'infinite' : timing.iterations) + ' ' + timing.direction + ' ' + timing.fill; });
      const comp = list.map((tr) => (TF[tr.channel] ? 'add' : 'replace'));
      const sig = names.join(',') + '|' + comp.join(',');
      if (el.dataset && el.__sig === sig) continue;
      el.__sig = sig;
      el.style.animation = names.join(',');
      el.style.animationComposition = comp.join(',');
      const all = el.getAnimations();
      for (const tr of list) {
        if (anims.has(tr.i) && anims.get(tr.i).effect && all.includes(anims.get(tr.i))) continue;
        const a = all.find((q) => q.animationName === cssName.get(tr.i));
        if (a) { anims.set(tr.i, a); if (anchorTs != null) a.startTime = anchorTs + birthOf(tr); }
      }
      for (const tr of declared) if (tr.el === i && tr.impl === 'css' && !list.includes(tr)) anims.delete(tr.i);
    }
  }

  // ---- state
  const tracks = SPEC.tracks.map((t, i) => { t.i = i; return t; });
  for (const t of tracks.filter((x) => x.impl !== 'js').sort((x, y) => (RANK[x.channel] ?? 9) - (RANK[y.channel] ?? 9) || x.i - y.i)) declared.push(t);
  const js = tracks.filter((t) => t.impl === 'js');
  let live = false, raf = 0, anchor = null, sims = null;
  // declared (css / waapi) tracks write nothing inline: an inline value would be added to the animation's (composite add)
  const restAll = () => { for (const tr of tracks) if (tr.impl === 'js') put(tr, K.valueAt(tr.motion, 0, { frameMs })); };
  const valuesAt = (t, o) => { const out = {}; for (const tr of tracks) out[tr.id] = K.valueAt(tr.motion, t, { frameMs: (o && o.frameMs) || frameMs }); return out; };

  function seek(t, o) {
    if (o && o.frameMs) frameMs = o.frameMs;
    live = false; if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (declared.length) {
      syncDeclared(t, null);
      for (const tr of declared) { const a = anims.get(tr.i); if (a) { a.pause(); a.currentTime = t - birthOf(tr); } }
    }
    for (const tr of tracks) if (tr.impl === 'js') put(tr, K.valueAt(tr.motion, t, { frameMs }));
    const vals = valuesAt(t);
    return { t, values: vals };
  }

  function frame(ts) {
    if (!live) return;
    raf = requestAnimationFrame(frame);
    if (anchor == null) {
      anchor = ts; sims = new Map();
      for (const tr of js) if (K.isFrameBased(tr.motion)) sims.set(tr.i, K.makeSim(tr.motion));
    }
    const t = ts - anchor;
    if (declared.length) syncDeclared(t, anchor);
    for (const tr of js) {
      const sim = sims.get(tr.i);
      put(tr, sim ? sim.frame(t) : K.valueAt(tr.motion, t, { frameMs }));
    }
    if (t > SPEC.timeline.durationMs + 1000 && !SPEC.timeline.hasLoop) { live = false; cancelAnimationFrame(raf); raf = 0; }
  }
  function play() {
    if (live) return;
    live = true; anchor = null; sims = null;
    for (const a of anims.values()) { try { a.cancel(); } catch (e) {} }
    anims.clear();
    for (const tr of tracks) if (tr.impl === 'css') { elOf(tr).style.animation = ''; elOf(tr).style.animationComposition = ''; elOf(tr).__sig = null; }
    raf = requestAnimationFrame(frame);
  }
  const pause = () => { live = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } };

  const api = {
    schema: 'reva.specimen/0', id: SPEC.id, durationMs: SPEC.timeline.durationMs, get frameMs() { return frameMs; }, spec: SPEC,
    tracks: tracks.map((t) => ({ id: t.id, el: SPEC.elements[t.el].id, channel: t.channel, name: t.name || null, kind: t.motion.kind, impl: t.impl })),
    seek, play, pause, values: valuesAt,
    series: (id, times) => K.series(tracks.find((t) => t.id === id).motion, times),
  };
  window.__specimen = api;
  window.seek = seek;
  restAll();
  const t0 = hashNum('t');
  if (t0 != null) seek(t0);
  else if (/[#&]auto\b/.test(hash)) play();
  else window.addEventListener('go', play, { once: true });
}
