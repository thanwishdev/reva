// look: the page's declared Lenis options (page-scroll smoothing), read once with a read-only in-page probe (never writes to
// the page, never patches, window own data properties only, depth 1, capped; same rules as src/look/gsap.js). A bundled
// Lenis kept in a closure (no global) reads nothing: look.json "lenis" says why, and the fitted smoothing stays the answer.
// Choice: the probe always runs (one page.evaluate, <= 1 s, after the action when the page is settled and lazy inits are done);
// the html.lenis class is only evidence, never an instance.
//   lerp mode    Lenis v1 moves animatedScroll by damp(x, y, lambda = lerp * 60, dt) = x + (y - x) * (1 - exp(-lambda * dt)),
//                a first-order follow with tau = 1 / lambda = 1 / (60 * lerp) s (lerp 0.1 -> 166.7 ms), frame-rate independent.
//   duration     with `duration` (and no lerp) Lenis runs a fixed-length easing tween per wheel step: no tau to compare.
import { CONTROL_CHARS } from '../report/untrusted.js';

export const LENIS_PROBE_VERSION = 'lenis-probe-1';
export const TAU_TOL = 0.10;   // declared vs fitted time constant: within 10 % = agreement

/** In-page expression source (self-contained; returns plain primitives only). */
export function buildLenisProbeSource() {
  const probe = function () {
    const CAP = { keys: 3000, objs: 400, sub: 60 };
    const OPT = ['lerp', 'duration', 'easing', 'smoothWheel', 'wheelMultiplier', 'touchMultiplier', 'orientation', 'gestureOrientation', 'infinite', 'syncTouch', 'autoRaf', 'smoothTouch', 'syncTouchLerp', 'normalizeWheel'];
    // data properties only: a getter on a page object could run page code
    const data = (o, k) => { try { const d = Object.getOwnPropertyDescriptor(o, k); return d && 'value' in d ? d.value : undefined; } catch (e) { return undefined; } };
    const has = (o, k) => { try { return k in o; } catch (e) { return false; } };
    const isObj = (v) => v !== null && (typeof v === 'object' || typeof v === 'function');
    const shape = (o) => {
      if (!isObj(o) || typeof o === 'function') return false;
      const op = data(o, 'options'); if (!isObj(op)) return false;
      const hasOpt = ['lerp', 'duration', 'smoothWheel', 'wheelMultiplier', 'orientation', 'syncTouch'].some((k) => data(op, k) !== undefined);
      let ctor = ''; try { ctor = String(o.constructor && o.constructor.name); } catch (e) { /* */ }
      const hasState = ['animatedScroll', 'targetScroll', 'isSmooth', 'isScrolling'].some((k) => has(o, k));
      return hasOpt && (hasState || ctor === 'Lenis');
    };
    const out = { probe: 'lenis-probe-1', found: false, via: null, version: null, options: null, evidence: {}, scanned: 0 };
    try { out.evidence.htmlClass = document.documentElement.classList.contains('lenis'); } catch (e) { /* */ }
    let inst = null, via = null, n = 0;
    for (const k of ['lenis', '__lenis', 'lenisInstance', 'smoothScroll', 'smoother', 'scroller', 'app']) { const v = data(window, k); if (shape(v)) { inst = v; via = 'window.' + k; break; } }
    if (!inst) {
      const keys = Object.getOwnPropertyNames(window).slice(0, CAP.keys); let objs = 0;
      outer: for (const k of keys) {
        const v = data(window, k); if (!isObj(v) || typeof v === 'function' || v === window || (typeof Node !== 'undefined' && v instanceof Node)) continue;
        if (++objs > CAP.objs) break; n++;
        if (shape(v)) { inst = v; via = 'window.' + k; break; }
        let sub; try { sub = Object.getOwnPropertyNames(v).slice(0, CAP.sub); } catch (e) { continue; }
        for (const s of sub) { const w = data(v, s); if (isObj(w) && typeof w !== 'function' && shape(w)) { inst = w; via = 'window.' + k + '.' + s; break outer; } }
      }
    }
    out.scanned = n;
    const gv = data(window, 'lenisVersion'); if (typeof gv === 'string') out.version = gv.slice(0, 20);
    if (!inst) return out;
    out.found = true; out.via = via;
    const op = data(inst, 'options'); const o = {};
    for (const k of OPT) {
      const v = data(op, k); if (v === undefined) continue;
      if (typeof v === 'function') { let s = ''; try { s = Function.prototype.toString.call(v); } catch (e) { /* */ } o[k] = { fn: true, name: String(v.name || '').slice(0, 40), src: s.slice(0, 200) }; }
      else if (typeof v === 'number' || typeof v === 'boolean' || v === null) o[k] = v;
      else if (typeof v === 'string') o[k] = v.slice(0, 40);
    }
    out.options = o;
    if (!out.version) { try { const v = data(inst, 'version') ?? (inst.constructor ? data(inst.constructor, 'version') : undefined); if (typeof v === 'string') out.version = v.slice(0, 20); } catch (e) { /* */ } }
    return out;
  };
  return `(${probe.toString()})()`;
}

let SRC = null;
const msg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
/** One probe read ({at, ...read} or {at, found:false, error}); never throws. Bounded by `timeoutMs` (~1 s). */
export async function readLenis(page, at, { timeoutMs = 1000 } = {}) {
  const t0 = Date.now(); let timer = null;
  try {
    SRC ||= buildLenisProbeSource();
    const r = await Promise.race([page.evaluate(SRC), new Promise((_, no) => { timer = setTimeout(() => no(new Error(`lenis probe took over ${timeoutMs} ms`)), timeoutMs); })]);
    if (!r || r.probe !== LENIS_PROBE_VERSION) throw new Error('lenis probe returned an unexpected result');
    return { at, ...r, ms: Date.now() - t0 };
  } catch (e) { return { at, found: false, error: msg(e), ms: Date.now() - t0 }; } finally { clearTimeout(timer); }
}

const clean = (s, n) => String(s ?? '').replace(CONTROL_CHARS, ' ').trim().slice(0, n);
const KNOWN_EASE = [[/1\.001\s*-\s*(?:Math\.pow\(\s*2\s*,\s*-\s*10\s*\*|\(?\s*2\s*\*\*\s*\(?\s*-\s*10\s*\*)/, 'expoOut (Lenis default: min(1, 1.001 - 2^(-10 t)))']];
/** An easing option -> {name, known, src}: a Lenis default is named; any other function keeps `function` + its source (untrusted, capped 200). */
export function easingName(e) {
  if (!e || !e.fn) return null;
  const src = clean(e.src, 200);
  for (const [re, name] of KNOWN_EASE) if (re.test(src)) return { name, known: true, src };
  return { name: 'function', known: false, src };
}
const numOr = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const boolOr = (v) => (typeof v === 'boolean' ? v : null);
/** Lenis lerp -> time constant in ms: tau = 1 / (60 * lerp) s (damp lambda = lerp * 60). */
export const lerpToTauMs = (lerp) => (lerp > 0 ? 1000 / (60 * lerp) : null);
const sig = (x) => String(Math.round(x * 100) / 100);

/** Pure: a raw probe read -> look.json "lenis" {found, via, version, options, mode, tauMs, why}. Never throws. */
export function lookLenis(read) {
  const base = { probe: LENIS_PROBE_VERSION, found: false, via: null, version: null, options: null, mode: null, tauMs: null, why: null };
  if (!read) return { ...base, why: 'not read' };
  if (read.error) return { ...base, why: clean(read.error, 200) };
  const ev = { htmlClass: !!(read.evidence && read.evidence.htmlClass) };
  const version = typeof read.version === 'string' ? clean(read.version, 20) || null : null;
  if (!read.found || !read.options) return { ...base, version, evidence: ev, why: ev.htmlClass ? 'Lenis runs (html.lenis class) but its instance is in a closure or bundle: no global to read without patching the page' : 'no Lenis instance reachable from window' };
  const r = read.options; const o = {};
  for (const k of ['lerp', 'duration', 'wheelMultiplier', 'touchMultiplier', 'syncTouchLerp']) { const v = numOr(r[k]); if (v != null) o[k] = v; }
  for (const k of ['smoothWheel', 'syncTouch', 'infinite', 'autoRaf', 'smoothTouch', 'normalizeWheel']) { const v = boolOr(r[k]); if (v != null) o[k] = v; }
  for (const k of ['orientation', 'gestureOrientation']) if (typeof r[k] === 'string') o[k] = clean(r[k], 20);
  const ez = easingName(r.easing); if (ez) o.easing = ez;
  // a lerp in (0, 1) is the smoothing law (Lenis ignores duration/easing then); duration-based only without one
  const mode = o.lerp != null && o.lerp > 0 && o.lerp < 1 ? 'lerp' : o.duration != null ? 'duration' : null;
  return { ...base, found: true, via: clean(read.via, 80), version, options: o, mode, tauMs: mode === 'lerp' ? lerpToTauMs(o.lerp) : null, evidence: ev };
}

/** `Lenis declared: lerp 0.1, wheelMultiplier 1, smoothWheel true [exact]` (or duration + easing); null when nothing was read. */
export function lenisDeclaredText(l) {
  if (!l || !l.found || !l.options) return null;
  const o = l.options; const p = [];
  if (l.mode === 'duration') { p.push(`duration ${o.duration} s`); if (o.easing) p.push(`easing ${o.easing.known ? o.easing.name : `function ${JSON.stringify(o.easing.src)}`}`); }
  else if (o.lerp != null) p.push(`lerp ${o.lerp}`);
  if (o.wheelMultiplier != null) p.push(`wheelMultiplier ${o.wheelMultiplier}`);
  if (o.touchMultiplier != null && o.touchMultiplier !== 2) p.push(`touchMultiplier ${o.touchMultiplier}`);
  if (o.smoothWheel != null) p.push(`smoothWheel ${o.smoothWheel}`);
  if (o.syncTouch) p.push('syncTouch true');
  if (o.infinite) p.push('infinite true');
  if (o.orientation && o.orientation !== 'vertical') p.push(`orientation ${o.orientation}`);
  return `Lenis declared${l.version ? ` ${l.version}` : ''}: ${p.join(', ')} [exact]`;
}

/**
 * Pure: the declared tau against the fitted one (ms). {state: 'agrees'|'disagrees'|'n/a', text}. lerp mode only; a duration-based
 * Lenis has no time constant. smoothWheel false: the declared smoothing is off, so a fitted smoothing disagrees by kind.
 */
export function compareLenisTau(l, fittedTauMs) {
  if (!l || !l.found) return null;
  const o = l.options || {}; const fit = numOr(fittedTauMs);
  if (o.smoothWheel === false) return fit == null ? { state: 'agrees', text: 'smoothWheel is false: the wheel is not smoothed (the fit saw no smoothing: agrees)' } : { state: 'disagrees', text: `smoothWheel is false (wheel not smoothed) but the fit found smoothing, tau ${sig(fit)} ms: disagrees` };
  if (l.mode !== 'lerp' || l.tauMs == null) return { state: 'n/a', text: l.mode === 'duration' ? 'duration-based (a fixed-length easing per wheel step): no time constant to compare' : 'no lerp declared' };
  const d = l.tauMs;
  if (fit == null) return { state: 'n/a', text: `lerp ${o.lerp} = tau ${sig(d)} ms (1 / (60 x lerp)); no fitted tau to compare` };
  const rel = Math.abs(fit - d) / d; const eq = `lerp ${o.lerp} = tau ${sig(d)} ms (1 / (60 x lerp)) vs fitted ${sig(fit)} ms`;
  return rel <= TAU_TOL ? { state: 'agrees', rel, text: `${eq}: agrees (${Math.round(rel * 100)} % apart)` } : { state: 'disagrees', rel, text: `${eq}: disagrees (${Math.round(rel * 100)} % apart, over ${Math.round(TAU_TOL * 100)} %)` };
}

/** The fitted time constant (ms) of the page line (look.json page.lines[0] kind smoothing), or null. */
export function fittedTauMs(page) {
  const l = page && page.lines && page.lines[0]; if (!l || l.kind !== 'smoothing') return null;
  const v = (l.values || []).find((x) => x.name === 'tau'); return v && Number.isFinite(v.value) ? v.value : null;
}

/** The printed lines under the "Page scroll:" line: the declared values and the comparison with the fit. */
export function lenisPageLines(l, page) {
  const t = lenisDeclaredText(l); if (!t) return [];
  const c = compareLenisTau(l, fittedTauMs(page));
  return [`   ${t}`, ...(c ? [`   Lenis vs fit: ${c.text}`] : [])];
}
/** One short line for the libraries section (found, but no scroll look taken). */
export function lenisLibLine(l) { const t = lenisDeclaredText(l); return t ? `${t.replace('Lenis declared', 'Lenis (read from the page)')}${l.tauMs != null ? `; tau ${sig(l.tauMs)} ms` : ''}` : null; }
