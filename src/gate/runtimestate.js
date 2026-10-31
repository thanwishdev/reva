// Runtime style state (corpus stage S3). The rule table (src/static/ruletable.js) reads every CSSOM rule, adopted and
// shadow sheet and inline style, but three kinds of style state never reach the CSSOM:
//   1. custom properties registered from JS (`CSS.registerProperty`): no rule exists, yet the registration changes the
//      computed value of that property on EVERY element (typed initial value, inheritance). Measured on real sites:
//      the largest source of missed values (tens of thousands of elements on one page).
//   2. fonts added from JS (`new FontFace(...)` + `document.fonts.add`): not in any sheet, and an ArrayBuffer source
//      has no URL at all (measured: a text line laid out 20% narrower in a fallback font).
//   3. WAAPI effect values (`Element.animate`, Motion/Framer): an animation's output sits at the animation cascade
//      level, not in the DOM, a rule or the style attribute.
// This file holds the in-page side: an init script that records (1) and the sources of (2) as the page creates them,
// and a collector that reads all three at the captured point. The rebuild re-creates them from OUR data only
// (runtimeemit.js: @property, @font-face, frozen declarations); the site's scripts never run there.
//
// The recorder is installed in every ORIGINAL session (as scriptWriteRecorder is), so noise and identity measure that
// it does not perturb the page. It is deliberately small: a wrapper around CSS.registerProperty (same call, same
// throw, recorded only on success) and a Proxy around the FontFace constructor (same prototype, `instanceof`, name
// and subclassing via new.target; it only remembers the constructor's source argument). WAAPI needs no hook: the
// collector reads `document.getAnimations()` and each effect's declared timing + keyframes, the same reader the
// motion recorder uses (src/record/inpage.js `declOf`, kept field-compatible), as C-PLAN-v2-CHECK §2 asks.

/** In-page init script. Self-contained (serialised by addInitScript). */
export function runtimeStateRecorder() {
  if (window.__wrRT) return;
  const R = { props: [], src: new WeakMap(), fontBytes: 0, fontDropped: 0, errors: 0 };
  try { Object.defineProperty(window, '__wrRT', { value: R, enumerable: false }); } catch { return; }
  // first script frame (url:line:col) of the call: the same provenance the D1b script-write recorder keeps
  const where = () => {
    const L = String(new Error().stack || '').split('\n');
    for (let i = 1; i < L.length; i++) { const m = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/.exec(L[i]); if (m) return `${m[1]}:${m[2]}:${m[3]}`; }
    return '';
  };
  // 1. CSS.registerProperty: call through first, so an invalid or duplicate registration throws exactly as before
  //    and is not recorded
  try {
    const reg = window.CSS && window.CSS.registerProperty;
    if (typeof reg === 'function') {
      const wrapped = { registerProperty(def) {
        const r = reg.apply(this, arguments);
        try {
          R.props.push({ name: String(def.name), syntax: def.syntax === undefined ? '*' : String(def.syntax), inherits: !!def.inherits,
            initialValue: def.initialValue === undefined ? null : String(def.initialValue), at: where() });
        } catch { R.errors++; }
        return r;
      } }.registerProperty;
      Object.defineProperty(window.CSS, 'registerProperty', { value: wrapped, writable: true, configurable: true, enumerable: true });
    }
  } catch { R.errors++; }
  // 2. FontFace(family, source, descriptors): remember the source per face. A string source is kept as text with the
  //    base URL it resolves against; a binary source is copied (the page may transfer or reuse its buffer), capped.
  const CAP = 48 * 1024 * 1024;
  try {
    const FF = window.FontFace;
    if (typeof FF === 'function') {
      const P = new Proxy(FF, { construct(t, args, nt) {
        const face = Reflect.construct(t, args, nt);
        try {
          const s = args[1]; const rec = { at: where() };
          if (typeof s === 'string' || (s && typeof s === 'object' && !(s instanceof ArrayBuffer) && !ArrayBuffer.isView(s))) { rec.kind = 'url'; rec.text = String(s).slice(0, 8000); rec.base = document.baseURI; }
          else if (s) {
            const u = s instanceof ArrayBuffer ? new Uint8Array(s) : new Uint8Array(s.buffer, s.byteOffset, s.byteLength);
            rec.kind = 'buffer'; rec.n = u.byteLength;
            if (R.fontBytes + u.byteLength <= CAP) { rec.bytes = u.slice(); R.fontBytes += u.byteLength; } else { rec.dropped = true; R.fontDropped++; }
          }
          R.src.set(face, rec);
        } catch { R.errors++; }
        return face;
      } });
      Object.defineProperty(window, 'FontFace', { value: P, writable: true, configurable: true, enumerable: false });
    }
  } catch { R.errors++; }
}

/**
 * In-page, at the captured point: everything the rebuild needs to re-create the runtime state. Self-contained.
 * Returns {v, recorder, props[], fonts[], waapi[], skipped{}}; binary font sources come back as base64 (`b64`).
 * WAAPI: only script animations (not CSSAnimation / CSSTransition, which come from rules already in the table).
 * `frozen` = the computed value of every animated property on the target NOW (the animation's output, or whatever
 * beats it in the cascade): the static rebuild re-creates the moment, `decl` keeps how it moves (motion data).
 */
export function collectRuntimeState() {
  const R = window.__wrRT;
  const out = { v: 1, recorder: !!R, props: [], fonts: [], waapi: [], skipped: { waapiNoTarget: 0, waapiUnmapped: 0, waapiNotInEffect: 0, fontDropped: 0, fontUnknownSource: 0, frames: 0 } };
  if (R) out.props = R.props.slice();
  if (R) { out.recorderErrors = R.errors; out.skipped.fontDropped = R.fontDropped; }
  // ---------- fonts added from JS (document.fonts iterates CSS-connected faces first, then added ones in order)
  const absUrls = (v, base) => v.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g, (m, a, b, c) => {
    const u = a ?? b ?? c;
    if (!u || /^(data:|#)/i.test(u)) return m;
    try { return `url(${JSON.stringify(new URL(u, base).href)})`; } catch { return m; }
  });
  const b64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  if (R && document.fonts) {
    for (const f of document.fonts) {
      const s = R.src.get(f);
      if (!s) continue; // CSS-connected (@font-face, already in the rule table) or created before the recorder
      const rec = { family: f.family, style: f.style, weight: f.weight, stretch: f.stretch, unicodeRange: f.unicodeRange, featureSettings: f.featureSettings,
        display: f.display, status: f.status, at: s.at };
      for (const k of ['ascentOverride', 'descentOverride', 'lineGapOverride', 'sizeAdjust']) if (typeof f[k] === 'string') rec[k] = f[k];
      if (s.kind === 'url') rec.src = absUrls(s.text, s.base);
      else if (s.kind === 'buffer' && s.bytes) { rec.b64 = b64(s.bytes); rec.n = s.n; }
      else if (s.kind === 'buffer') { rec.dropped = true; rec.n = s.n; }
      else { out.skipped.fontUnknownSource++; continue; }
      out.fonts.push(rec);
    }
  }
  // registrations and fonts are per document: same-origin iframes are counted, not captured (the corpus misses were
  // all in the main document)
  for (const fr of document.querySelectorAll('iframe')) { try { const w = fr.contentWindow; if (w && w.__wrRT && (w.__wrRT.props.length)) out.skipped.frames++; } catch {} }
  // ---------- WAAPI (script animations), declared timing + keyframes as in src/record/inpage.js declOf
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const keyOf = el => { const parts = []; for (let e = el; e; ) { if (e === document.documentElement) { parts.unshift('html'); return parts.join('/'); } const p = e.parentElement; if (!p) return null; let n = 0; for (const c of p.children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === e.localName) n++; if (c === e) break; } parts.unshift(`${e.localName}[${n}]`); e = p; } return null; };
  const kebab = p => (p === 'cssFloat' ? 'float' : p === 'cssOffset' ? 'offset' : p.startsWith('--') ? p : p.replace(/^webkit(?=[A-Z])/, '-webkit').replace(/[A-Z]/g, c => '-' + c.toLowerCase()));
  const timelineKind = a => { const t = a.timeline; if (!t) return 'none'; if (t instanceof DocumentTimeline) return 'document'; return t.constructor ? t.constructor.name : 'other'; };
  const isCss = a => (window.CSSAnimation && a instanceof CSSAnimation) || (window.CSSTransition && a instanceof CSSTransition);
  for (const a of document.getAnimations ? document.getAnimations() : []) {
    if (isCss(a)) continue;
    const eff = a.effect, tgt = eff && eff.target;
    if (!tgt) { out.skipped.waapiNoTarget++; continue; }
    const k = keyOf(tgt);
    if (!k) { out.skipped.waapiUnmapped++; continue; }
    let tm = {}, ct = {}, kf = [];
    try { tm = eff.getTiming(); } catch {}
    try { ct = eff.getComputedTiming(); } catch {}
    try { kf = eff.getKeyframes().slice(0, 50).map(f => { const o = {}; for (const [p, v] of Object.entries(f)) if (p !== 'computedOffset') o[p] = typeof v === 'string' ? v.slice(0, 400) : v; return o; }); } catch {}
    let pe = null; try { pe = eff.pseudoElement || null; } catch {}
    const rec = { k, name: a.id || 'waapi', type: a.constructor.name, timeline: timelineKind(a), playState: a.playState, currentTime: typeof a.currentTime === 'number' ? a.currentTime : null, playbackRate: a.playbackRate,
      decl: { delay: tm.delay, endDelay: tm.endDelay, duration: tm.duration, easing: String(tm.easing || ''), iterations: tm.iterations, iterationStart: tm.iterationStart, direction: tm.direction, fill: tm.fill,
        composite: eff.composite, keyframes: kf }, progress: ct.progress ?? null, provenance: 'declared' };
    if (pe) rec.pseudoElement = String(pe);
    const props = new Set();
    for (const f of kf) for (const p of Object.keys(f)) if (!['offset', 'easing', 'composite'].includes(p)) props.add(kebab(p));
    if (ct.progress == null) { out.skipped.waapiNotInEffect++; rec.frozen = null; }
    else { const cs = getComputedStyle(tgt, pe); rec.frozen = {}; for (const p of props) { const v = cs.getPropertyValue(p); if (v !== '') rec.frozen[p] = v; } }
    out.waapi.push(rec);
  }
  return out;
}
