// GSAP / ScrollTrigger declared values (26 Oct, S12; AUDIT §4). A site that animates with GSAP declares every tween's
// duration, delay, ease, repeat and its scroll trigger in JavaScript; the motion fits measure the same tweens from the
// rendered samples. This module reads the declared side and joins it with the fits:
//   probe   a READ-ONLY in-page read (libdetect rule, src/libdetect/probe.js:1-6: it never writes to the page, never
//           patches anything; it only calls GSAP's own getters) of gsap.globalTimeline.getChildren(true, true, true) and
//           ScrollTrigger.getAll(), in its own archive replay per class through the gate's openSession (fake clock paused
//           at load, so load-time tweens are still in the timeline), read once after `load` and once after the gate's
//           sweep (scroll-created tweens), and the two reads unioned by key. Written by the motion step to motion/gsap.json.
//   join    the fit step matches each declared tween x animated prop with the fitted records of the same element
//           (descMatch, src/analysis/fit/declared.js) and channel (x->tx, y->ty, scale->sx/sy, rotation->rz, opacity...),
//           and writes motion/fits/gsap-match.json: duration delta, ease agreement (max |delta| over 64 samples, easeAt),
//           status matched / partly-checked / disagrees / no-fit. The fits themselves are never changed or seeded.
// GSAP is often bundled without a global (no window.gsap): then nothing can be read without patching the page, and the
// file says so (`why`), with the evidence that GSAP is there (archive signatures, element `_gsap` caches).
import fs from 'node:fs';
import path from 'node:path';
import { descMatch } from '../analysis/fit/declared.js';
import { NAMED, easeAt } from '../analysis/fit/eases.js';
import { cubicBezier } from '../analysis/oracles.js';
import { LIBRARIES } from '../libdetect/signatures.js';

export const GSAP_PROBE_VERSION = 'gsap-probe-1';
export const GSAP_SCHEMA = 'reva.gsap/1';
export const MATCH_SCHEMA = 'reva.gsap-match/1';
/** Probe caps: tweens + timelines, targets listed per tween, scroll triggers, elements scanned for `_gsap`. */
export const CAPS = { tweens: 3000, targets: 40, triggers: 500, elements: 30000 };
/** Join tolerances: duration within max(one frame of the take, DUR_REL_TOL x declared); ease max |delta| <= EASE_TOL (of the
 *  0..1 progress range) over EASE_SAMPLES samples; scroll range ends within max(2 px, 1 % of the range). */
export const DUR_REL_TOL = 0.02, EASE_TOL = 0.02, EASE_SAMPLES = 64, RANGE_REL_TOL = 0.01, RANGE_MIN_PX = 2;

/** The motion recorder's element descriptor (src/record/inpage.js `desc`, same text: test/corpus/gsap-probe.test.js), so a
 *  declared target and a fitted record name an element the same way (`tag#id.classes`, 3 classes, controls stripped). */
const descOf = (e) => !e ? null : (e.tagName + (e.id ? '#' + e.id : '') + (e.classList && e.classList.length ? '.' + [...e.classList].filter(c => !/^svelte-/.test(c)).slice(0, 3).join('.') : '')).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');
export const DESC_SOURCE = descOf.toString();

/** GSAP ease names the probe can name a parsed ease function by (gsap.parseEase(name) is a lookup in GSAP's ease map). */
export const EASE_NAMES = ['none', 'linear', ...['power1', 'power2', 'power3', 'power4', 'sine', 'expo', 'circ', 'back', 'elastic', 'bounce', 'power0'].flatMap(f => [`${f}.out`, `${f}.in`, `${f}.inOut`])];

// ---------------------------------------------------------------- in-page (serialised; must stay self-contained)
/* eslint-disable no-undef */
function gsapProbeInPage(desc, C) {
  const out = { probe: C.version, found: false, via: null, version: null, versions: [], expandos: 0, gsap2: false, tweens: [], scrollTriggers: [], truncated: false, errors: [], why: null };
  const clean = (v, n = 160) => String(v).replace(/[^\w .:,'()/-]/g, '').slice(0, n);
  const err = (where, e) => { if (out.errors.length < 20) out.errors.push(where + ': ' + clean(e && e.message || e)); };
  const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const get = (o, m) => { try { return o && typeof o[m] === 'function' ? o[m]() : undefined; } catch (e) { return undefined; } };
  const NUMV = /^(?:[-+*/]=)?[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:px|%|deg|rad|turn|em|rem|vw|vh|vmin|vmax)?$/i;
  const val = (v) => typeof v === 'number' ? fin(v) : typeof v === 'string' ? (v.length <= 40 && NUMV.test(v.trim()) ? v.trim() : 'string') : typeof v === 'function' ? 'function' : v == null ? null : Array.isArray(v) ? 'array' : typeof v;
  const ID = /^[\w-]{1,60}$/;
  const sid = (v) => (typeof v === 'string' ? (ID.test(v) ? v : 'string') : typeof v === 'number' ? fin(v) : null);
  const EASE = /^[a-z][a-z0-9]{0,20}(?:\.(?:in|out|inout|easein|easeout|easeinout|easenone))?(?:\([-+0-9.,\s]{0,40}\))?$/i;
  const SPEC = /^[a-z0-9%+\-=.\s]{1,40}$/i;
  const TOGGLE = /^(?:(?:play|pause|resume|reset|restart|complete|reverse|none)\s+){3}(?:play|pause|resume|reset|restart|complete|reverse|none)$/;
  try {
    const els = document.querySelectorAll('*'); const n = Math.min(els.length, C.caps.elements);
    for (let i = 0; i < n; i++) { try { if (Object.prototype.hasOwnProperty.call(els[i], '_gsap')) out.expandos++; } catch (e) { /* host object */ } }
  } catch (e) { err('expandos', e); }
  try { const v = window.gsapVersions; if (Array.isArray(v)) out.versions = v.filter(x => typeof x === 'string' && /^\d+\.\d+\.\d+$/.test(x)).slice(0, 8); } catch (e) { err('gsapVersions', e); }
  let g = null;
  try { const x = window.gsap; if (x && x.globalTimeline && typeof x.globalTimeline.getChildren === 'function') { g = x; out.via = 'window.gsap'; } } catch (e) { err('window.gsap', e); }
  if (!g) try { const x = window.GreenSockGlobals && window.GreenSockGlobals.gsap; if (x && x.globalTimeline && typeof x.globalTimeline.getChildren === 'function') { g = x; out.via = 'GreenSockGlobals.gsap'; } } catch (e) { err('GreenSockGlobals', e); }
  if (!g) {
    try { out.gsap2 = !!(window.TweenMax || window.TweenLite) && !window.gsap; } catch (e) { /* ignore */ }
    out.why = out.gsap2 ? 'GSAP 2 (TweenMax / TweenLite) globals: not read by this probe (GSAP 3 API only)'
      : out.expandos || out.versions.length ? 'GSAP runs on this page (' + out.expandos + ' element _gsap caches, versions ' + (out.versions.join(' ') || 'none') + ') but no global exposes it (bundled build): its declared values cannot be read without patching the page'
        : 'no GSAP global on this page';
    return out;
  }
  out.found = true;
  try { out.version = typeof g.version === 'string' && /^\d+\.\d+\.\d+/.test(g.version) ? g.version.slice(0, 20) : null; } catch (e) { err('version', e); }
  const root = g.globalTimeline;
  // ease function -> GSAP name (parseEase of a plain name is a lookup in GSAP's ease map: no ease is created)
  const easeName = new Map();
  for (const nm of C.easeNames) { try { const f = typeof g.parseEase === 'function' ? g.parseEase(nm) : null; if (typeof f === 'function' && !easeName.has(f)) easeName.set(f, nm); } catch (e) { /* unknown name */ } }
  const easeOf = (c) => {
    let v; try { v = c.vars && c.vars.ease; } catch (e) { v = undefined; }
    if (typeof v === 'string') { const t = v.trim(); return EASE.test(t) ? { name: t, source: 'vars' } : { name: null, source: 'vars', note: 'not an ease name' }; }
    let f = typeof v === 'function' ? v : null; let src = f ? 'vars-function' : 'parsed';
    if (!f) { try { f = typeof c._ease === 'function' ? c._ease : null; } catch (e) { f = null; } }
    if (f && easeName.has(f)) return { name: easeName.get(f), source: src };
    return { name: null, source: f ? src : 'none', note: f ? 'a custom ease function (CustomEase or a page function)' : 'no ease (a timeline, or none set)' };
  };
  const RESERVED = new Set(C.reserved);
  let kids = [];
  try { kids = root.getChildren(true, true, true) || []; } catch (e) { err('getChildren', e); }
  if (kids.length > C.caps.tweens) { out.truncated = true; kids = kids.slice(0, C.caps.tweens); }
  const keyOf = new Map(); const seen = new Map();
  const r6 = (x) => (x == null ? null : Math.round(x * 1e6) / 1e6);
  for (const c of kids) {
    try {
      const tl = typeof c.getChildren === 'function';
      const vars = c.vars || {};
      let targets = [];
      if (!tl) { try { const t = typeof c.targets === 'function' ? c.targets() : []; targets = Array.isArray(t) ? t : []; } catch (e) { targets = []; } }
      const descs = targets.slice(0, C.caps.targets).map(t => (t && t.nodeType === 1 ? desc(t) : t && t.nodeType ? '#node' : 'object'));
      const props = {};
      let kind = tl ? 'timeline' : 'to';
      if (!tl) {
        let keys = []; try { keys = Object.keys(vars); } catch (e) { keys = []; }
        const runBack = !!vars.runBackwards, startAt = vars.startAt && typeof vars.startAt === 'object' ? vars.startAt : null;
        kind = Array.isArray(vars.keyframes) || (vars.keyframes && typeof vars.keyframes === 'object') ? 'keyframes' : runBack ? 'from' : startAt ? 'fromTo' : 'to';
        for (const k of keys) {
          if (RESERVED.has(k) || k.length > 40) continue;
          const v = vars[k];
          if ((k === 'css' || k === 'attr') && v && typeof v === 'object') { for (const k2 of Object.keys(v).slice(0, 40)) props[k + '.' + k2] = { to: val(v[k2]) }; continue; }
          if (runBack) props[k] = { from: val(v), to: 'current' };
          else props[k] = startAt ? { from: startAt[k] === undefined ? 'current' : val(startAt[k]), to: val(v) } : { to: val(v) };
        }
      }
      const parent = c.parent;
      const parentKey = !parent || parent === root ? 'root' : keyOf.get(parent) || 'unlisted';
      const st = fin(get(c, 'startTime')), dur = fin(get(c, 'duration'));
      const base = [parentKey, tl ? 'tl' : 'tw', sid(vars.id) ?? '', r6(st), r6(dur), r6(fin(get(c, 'delay'))), descs.join(','), Object.keys(props).join(',')].join('|');
      const nth = (seen.get(base) || 0) + 1; seen.set(base, nth);
      const key = base + '#' + nth; keyOf.set(c, key);
      let scale = 1; for (let a = c; a; a = a.parent) { const ts = fin(get(a, 'timeScale')); if (ts) scale *= ts; }
      // position in each ancestor timeline (its local time) and that timeline's duration: a tween inside a scrubbed
      // timeline covers [start, end] / duration of the trigger's scroll range
      const within = [];
      let s = st, e = st == null ? null : st + (fin(get(c, 'totalDuration')) ?? 0) / (fin(get(c, 'timeScale')) || 1);
      for (let a = c; a && a.parent && a.parent !== root && within.length < 8; a = a.parent) {
        const P = a.parent; within.push({ key: keyOf.get(P) || 'unlisted', start: r6(s), end: r6(e), duration: fin(get(P, 'duration')) });
        const ps = fin(get(P, 'startTime')), pts = fin(get(P, 'timeScale')) || 1;
        s = s == null || ps == null ? null : ps + s / pts; e = e == null || ps == null ? null : ps + e / pts;
      }
      out.tweens.push({ key, type: tl ? 'timeline' : 'tween', gsapId: sid(vars.id), parent: parentKey, kind,
        startTime: st, duration: dur, totalDuration: fin(get(c, 'totalDuration')), delay: fin(get(c, 'delay')), repeat: fin(get(c, 'repeat')),
        repeatDelay: fin(get(c, 'repeatDelay')), yoyo: !!get(c, 'yoyo'), timeScale: fin(get(c, 'timeScale')), scale: r6(scale),
        paused: !!get(c, 'paused'), reversed: !!get(c, 'reversed'), progress: fin(get(c, 'progress')),
        ease: tl ? null : easeOf(c), stagger: vars.stagger == null ? null : typeof vars.stagger === 'number' ? fin(vars.stagger) : typeof vars.stagger,
        props, targets: descs, targetCount: targets.length, within, scrollTrigger: null, _st: c.scrollTrigger || null });
    } catch (e) { err('tween', e); }
  }
  let ST = null;
  try { ST = window.ScrollTrigger || (g.core && typeof g.core.globals === 'function' && g.core.globals().ScrollTrigger) || null; } catch (e) { err('ScrollTrigger', e); }
  if (ST && typeof ST.getAll === 'function') {
    let all = []; try { all = ST.getAll() || []; } catch (e) { err('getAll', e); }
    if (all.length > C.caps.triggers) { out.truncated = true; all = all.slice(0, C.caps.triggers); }
    const stKey = new Map(); const seenSt = new Map();
    for (const t of all) {
      try {
        const v = t.vars || {};
        const spec = (x) => (typeof x === 'string' ? (SPEC.test(x) ? x : 'string') : typeof x === 'number' ? fin(x) : x == null ? null : typeof x);
        const anim = t.animation ? keyOf.get(t.animation) || 'unlisted' : null;
        const trig = t.trigger && t.trigger.nodeType === 1 ? desc(t.trigger) : null;
        const base = ['st', sid(v.id) ?? '', trig ?? '', spec(v.start) ?? '', spec(v.end) ?? '', anim ?? ''].join('|');
        const nth = (seenSt.get(base) || 0) + 1; seenSt.set(base, nth);
        const key = base + '#' + nth; stKey.set(t, key);
        const ta = typeof v.toggleActions === 'string' && TOGGLE.test(v.toggleActions.trim()) ? v.toggleActions.trim() : v.toggleActions == null ? null : 'string';
        out.scrollTriggers.push({ key, gsapId: sid(v.id), trigger: trig, start: fin(t.start), end: fin(t.end), startSpec: spec(v.start), endSpec: spec(v.end),
          scrub: v.scrub === true ? true : typeof v.scrub === 'number' ? fin(v.scrub) : v.scrub ? 'other' : false,
          pin: t.pin && t.pin.nodeType === 1 ? desc(t.pin) : v.pin ? 'yes' : null, toggleActions: ta, animation: anim,
          once: !!v.once, snap: v.snap == null ? null : typeof v.snap, isActive: !!t.isActive, progress: fin(t.progress), direction: fin(t.direction) });
      } catch (e) { err('trigger', e); }
    }
    for (const tw of out.tweens) { if (tw._st) tw.scrollTrigger = stKey.get(tw._st) || 'unlisted'; }
  } else if (ST == null) out.scrollTriggerMissing = true;
  for (const tw of out.tweens) delete tw._st;
  return out;
}
/* eslint-enable no-undef */

/** Keys of a tween's vars that are GSAP options, not animated properties. */
export const RESERVED_VARS = ['duration', 'delay', 'ease', 'repeat', 'repeatDelay', 'repeatRefresh', 'yoyo', 'yoyoEase', 'stagger', 'onComplete', 'onCompleteParams',
  'onStart', 'onStartParams', 'onUpdate', 'onUpdateParams', 'onRepeat', 'onRepeatParams', 'onReverseComplete', 'onReverseCompleteParams', 'onInterrupt',
  'callbackScope', 'paused', 'reversed', 'immediateRender', 'lazy', 'overwrite', 'id', 'data', 'inherit', 'runBackwards', 'startAt', 'scrollTrigger',
  'keyframes', 'defaults', 'smoothChildTiming', 'autoRemoveChildren', 'parent', 'modifiers', 'snap', 'force3D', 'autoRound', 'onToggle', 'onEnter', 'onLeave',
  'onEnterBack', 'onLeaveBack', 'easeEach', 'invalidateOnRefresh', 'fastScrollEnd', 'preventOverlaps', 'endArray', 'motionPath', 'clearProps', 'transformOrigin', 'svgOrigin'];

/** The probe as one page.evaluate() expression (string: nothing of Node crosses into the page). */
export function buildGsapProbeSource() {
  const C = { version: GSAP_PROBE_VERSION, caps: CAPS, easeNames: EASE_NAMES, reserved: RESERVED_VARS };
  return `(${gsapProbeInPage.toString()})(${DESC_SOURCE}, ${JSON.stringify(C)})`;
}

// ---------------------------------------------------------------- ease names (GSAP -> exact function)
const POW = { power0: 1, linear: 1, none: 1, power1: 2, quad: 2, power2: 3, cubic: 3, power3: 4, quart: 4, power4: 5, quint: 5, strong: 5 };
const IN = {
  sine: () => (p) => (p === 1 ? 1 : 1 - Math.cos((p * Math.PI) / 2)),
  expo: () => (p) => (p ? 2 ** (10 * (p - 1)) : 0),
  circ: () => (p) => 1 - Math.sqrt(1 - p * p),
  back: (s = 1.70158) => (p) => (p ? p * p * ((s + 1) * p - s) : 0),
};
const NOT_EXACT = new Set(['elastic', 'bounce', 'steps', 'rough', 'slow', 'exposcale', 'custom', 'customease', 'custombounce', 'customwiggle']);
/**
 * A GSAP ease string -> {name, fn} with fn the exact GSAP curve, or {name, fn: null, why}. GSAP defines every family by its
 * `in` curve: out(p) = 1 - in(1 - p), inOut(p) = p < .5 ? in(2p) / 2 : 1 - in(2(1 - p)) / 2; a name without a direction is
 * `.out`; legacy names (Power2.easeOut, Linear.easeNone) are read too. power0..4 = linear, quad, cubic, quart, quint.
 * Elastic, bounce, steps, rough, slow and custom eases are not compared (no exact form here): fn null.
 */
export function gsapEase(s) {
  if (typeof s !== 'string' || !s.trim()) return { name: null, fn: null, why: 'no ease name' };
  const t = s.trim();
  const m = /^([a-z][a-z0-9]*)(?:\.([a-z]+))?(?:\(([^()]*)\))?$/i.exec(t);
  if (!m) return { name: t, fn: null, why: 'not a GSAP ease name' };
  const fam = m[1].toLowerCase(); let dir = (m[2] || 'out').toLowerCase().replace(/^ease/, '');
  if (dir === 'none') dir = 'out';
  if (!['in', 'out', 'inout'].includes(dir)) return { name: t, fn: null, why: `unknown direction .${m[2]}` };
  const args = m[3] != null && m[3].trim() !== '' ? m[3].split(',').map(x => Number(x.trim())) : [];
  if (args.some(x => !Number.isFinite(x))) return { name: t, fn: null, why: 'ease parameters are not numbers' };
  if (NOT_EXACT.has(fam)) return { name: t, fn: null, why: `${fam} eases are not compared (no exact form in the tool)` };
  let inFn;
  if (POW[fam] === 1) { if (args.length) return { name: t, fn: null, why: 'a power ease takes no parameter' }; return { name: 'none', fn: (p) => p }; }
  if (POW[fam]) { const n = POW[fam]; if (args.length) return { name: t, fn: null, why: 'a power ease takes no parameter' }; inFn = (p) => p ** n; }
  else if (IN[fam]) { if (args.length && fam !== 'back') return { name: t, fn: null, why: `${fam} takes no parameter` }; inFn = IN[fam](...args); }
  else return { name: t, fn: null, why: `unknown ease family ${m[1]}` };
  const out = (p) => 1 - inFn(1 - p);
  const fn = dir === 'in' ? inFn : dir === 'out' ? out : (p) => (p < 0.5 ? inFn(p * 2) / 2 : 1 - inFn((1 - p) * 2) / 2);
  const canon = `${fam}.${dir === 'inout' ? 'inOut' : dir}${args.length ? `(${args.join(',')})` : ''}`;
  return { name: canon, fn };
}

/** Largest |a(p) - b(p)| over n evenly spaced p in [0, 1] (both clamped with easeAt). */
export function easeMaxDelta(a, b, n = EASE_SAMPLES) {
  let m = 0; for (let i = 0; i < n; i++) { const p = i / (n - 1); m = Math.max(m, Math.abs(easeAt(a, p) - easeAt(b, p))); } return m;
}

/** Fit channels a GSAP property drives (the recorder's `ren:` / `drv:` channel names without the prefix). */
export const PROP_CHANNELS = { x: ['tx'], xPercent: ['tx'], y: ['ty'], yPercent: ['ty'], scale: ['sx', 'sy'], scaleX: ['sx'], scaleY: ['sy'],
  rotation: ['rz'], rotate: ['rz'], rotationZ: ['rz'], rotateZ: ['rz'], skewX: ['skx'], opacity: ['opacity'], autoAlpha: ['opacity'], alpha: ['opacity'] };
const chanOf = (ch) => String(ch || '').replace(/^(ren|drv):/, '');

// ---------------------------------------------------------------- archive evidence + probe run (Node)
const BINARY = /\.(png|jpe?g|gif|webp|avif|svgz|ico|bmp|mp4|webm|mov|m4v|mp3|m4a|ogg|wav|flac|woff2?|ttf|otf|eot|glb|gltf|bin|ktx2|basis|hdr|exr|wasm|zip|gz|br|zst|pdf)$/i;
/** libdetect's strong GSAP signatures (weight >= 4: GreenSockGlobals, gsapVersions, the core API option names, the banner). */
function gsapSignatures() {
  const lib = LIBRARIES.find(l => l.id === 'gsap');
  return (lib?.signatures || []).filter(s => s.w >= 4 && s.role !== 'usage');
}
/**
 * Does the archive hold a GSAP build? Scans every non-binary archive file (<= 30 MB) for libdetect's strong GSAP
 * signatures; the probe (a browser replay per class) runs only when one is found. Read-only.
 * @returns {{present:boolean, files:number, bytes:number, hits:string[]}}
 */
export function archiveGsapEvidence(filesDir, { maxBytes = 30e6 } = {}) {
  const sigs = gsapSignatures(); const hits = new Set(); let files = 0, bytes = 0;
  const walk = (d) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.isFile() || BINARY.test(e.name)) continue;
      let st; try { st = fs.statSync(f); } catch { continue; } if (st.size > maxBytes) continue;
      let buf; try { buf = fs.readFileSync(f); } catch { continue; }
      files++; bytes += buf.length;
      if (!buf.includes('gsap') && !buf.includes('GSAP') && !buf.includes('GreenSock') && !buf.includes('lagSmoothing')) continue;
      const text = buf.toString('latin1');
      for (const s of sigs) {
        if (s.s ? text.includes(s.s) : s.all ? s.all.every(x => text.includes(x)) : s.re ? s.re.test(text) : false) hits.add(s.id);
      }
    }
  };
  walk(filesDir);
  return { present: hits.size > 0, files, bytes, hits: [...hits].sort() };
}

const msg = (e) => String(e && e.message || e).split('\n')[0].slice(0, 200);
async function readProbe(page, src) {
  const r = await page.evaluate(src);
  if (!r || r.probe !== GSAP_PROBE_VERSION) throw new Error('gsap probe returned an unexpected result');
  return r;
}

/**
 * Run the probe for each class in its own gate replay (src/gate/run.js openSession: archive replay, paused fake clock,
 * settle, sweep). Read after `load` (afterLoad hook) and after the sweep. parallel: classes at once (the motion step
 * holds the resource lease for its second browser). Returns {A: {reads:[...], error?}, E: ...}.
 */
export async function probeGsapClasses(target, classes, { parallel = false, log = () => {}, gate = null } = {}) {
  const G = gate || await import('../gate/run.js');
  const site = G.archiveSite(target);
  const src = buildGsapProbeSource();
  const one = async (cls) => {
    const t0 = Date.now(); let load = null, s = null;
    try {
      s = await G.openSession(site, cls, { afterLoad: async (h) => { load = await readProbe(h.page, src); return true; } });
      const sweep = await readProbe(s.h.page, src);
      log(`gsap probe ${cls}: ${sweep.found ? `${sweep.tweens.length} tweens/timelines, ${sweep.scrollTriggers.length} triggers after the sweep` : sweep.why} (${Date.now() - t0} ms)`);
      return [cls, { reads: [{ at: 'load', ...load }, { at: 'sweep', ...sweep }], wallMs: Date.now() - t0 }];
    } catch (e) {
      log(`gsap probe ${cls} FAILED ${msg(e)}`);
      return [cls, { reads: load ? [{ at: 'load', ...load }] : [], error: msg(e), wallMs: Date.now() - t0 }];
    } finally { if (s) await s.h.close().catch(() => {}); }
  };
  const res = [];
  if (parallel) res.push(...await Promise.all(classes.map(one)));
  else for (const c of classes) res.push(await one(c));
  return Object.fromEntries(res);
}

/**
 * The gsap.json document from per-class reads (pure): tweens and triggers unioned over the reads by key (first read wins;
 * `seenAt` lists the reads that saw it), ids `<cls>-t<n>` / `<cls>-st<n>` in order of first appearance.
 */
export function gsapDoc(perClass, { evidence = null } = {}) {
  const classes = {};
  for (const [cls, pc] of Object.entries(perClass || {})) {
    const reads = pc.reads || [];
    const tw = new Map(), st = new Map();
    for (const r of reads) {
      for (const t of r.tweens || []) { if (tw.has(t.key)) tw.get(t.key).seenAt.push(r.at); else tw.set(t.key, { ...t, seenAt: [r.at] }); }
      for (const t of r.scrollTriggers || []) { if (st.has(t.key)) st.get(t.key).seenAt.push(r.at); else st.set(t.key, { ...t, seenAt: [r.at] }); }
    }
    const tId = new Map([...tw.keys()].map((k, i) => [k, `${cls}-t${i + 1}`]));
    const sId = new Map([...st.keys()].map((k, i) => [k, `${cls}-st${i + 1}`]));
    const ref = (m, k) => (k == null ? null : k === 'root' ? 'root' : m.get(k) || 'unlisted');
    const tweens = [...tw.values()].map(t => ({ ...t, id: tId.get(t.key), parent: ref(tId, t.parent), scrollTrigger: ref(sId, t.scrollTrigger), within: (t.within || []).map(w => ({ ...w, key: ref(tId, w.key) })) }));
    const triggers = [...st.values()].map(t => ({ ...t, id: sId.get(t.key), animation: ref(tId, t.animation) }));
    const last = reads.at(-1) || {};
    const anyFound = reads.find(r => r.found);
    classes[cls] = {
      found: !!anyFound, via: anyFound?.via ?? null, version: anyFound?.version ?? last.version ?? null, versions: last.versions || [], expandos: Math.max(0, ...reads.map(r => r.expandos || 0)),
      why: anyFound ? null : (last.why || null), truncated: reads.some(r => r.truncated), scrollTriggerMissing: !!anyFound && reads.every(r => !r.found || r.scrollTriggerMissing),
      reads: reads.map(r => ({ at: r.at, found: !!r.found, tweens: (r.tweens || []).length, scrollTriggers: (r.scrollTriggers || []).length, errors: r.errors || [] })),
      tweens, scrollTriggers: triggers, ...(pc.error ? { error: pc.error } : {}), ...(pc.wallMs != null ? { wallMs: pc.wallMs } : {}),
    };
  }
  const vals = Object.values(classes);
  return {
    schema: GSAP_SCHEMA, probe: GSAP_PROBE_VERSION, found: vals.some(c => c.found), archive: evidence,
    note: 'Declared GSAP values read from the page (read-only probe; gsap.globalTimeline.getChildren + ScrollTrigger.getAll), after load and after the gate sweep, per viewport class. Times in seconds as GSAP declares them; start/end in px. Targets, triggers and pins are page-derived descriptors (untrusted text).',
    untrusted: ['classes.*.tweens[].targets', 'classes.*.scrollTriggers[].trigger', 'classes.*.scrollTriggers[].pin'],
    classes,
  };
}

/** gsap.json when the archive holds no GSAP build (no browser run). */
export function gsapAbsentDoc(evidence) {
  return { schema: GSAP_SCHEMA, probe: GSAP_PROBE_VERSION, found: false, archive: evidence, why: 'no GSAP build in the archive files (libdetect strong signatures: GreenSockGlobals, gsapVersions, the core API option names, the banner); probe not run', classes: {} };
}

// ---------------------------------------------------------------- join with the fits (pure)
const pv = (p) => (p == null ? { v: null, withheld: false } : p.value != null ? { v: p.value, withheld: false } : p.withheld_value != null ? { v: p.withheld_value, withheld: true } : { v: null, withheld: false });
/** A fitted record's time tween: {durationMs, t0, fn, ease, withheld} or null (not a time tween). Declared CSS / WAAPI records
 *  (declared:*) are explained by CSS or WAAPI births, so they are never GSAP's. */
export function fittedTween(rec) {
  const fam = rec?.model?.family || ''; const P = rec?.model?.params || {};
  let fn = null, ease = null;
  const m = /^named:([A-Za-z.-]+)$/.exec(fam);
  if (m) { if (!NAMED[m[1]]) return null; fn = NAMED[m[1]].fn; ease = m[1]; }
  else if (fam === 'bezier') { const b = ['x1', 'y1', 'x2', 'y2'].map(k => pv(P[k])); if (b.some(x => x.v == null)) return null; fn = cubicBezier(...b.map(x => x.v)); ease = `cubic-bezier(${b.map(x => +x.v.toFixed(4)).join(', ')})`; }
  else if (fam === 'ramp') { fn = (p) => p; ease = 'linear'; }
  else return null;
  const D = pv(P.D), t0 = pv(P.t0);
  if (D.v == null) return null;
  const bw = fam === 'bezier' && ['x1', 'y1', 'x2', 'y2'].some(k => pv(P[k]).withheld);
  return { durationMs: D.v, t0: t0.v, fn, ease, withheld: D.withheld || bw };
}
/** A fitted record's scroll map: {s0, s1, fn, ease} or null. */
export function fittedScroll(rec) {
  const map = rec?.model?.map; if (!map) return null;
  const shape = map.shape || map.shapeCandidate || null;
  const fn = shape === 'linear' ? (p) => p : shape && NAMED[shape] ? NAMED[shape].fn : null;
  return { s0: Number.isFinite(map.s0_px) ? map.s0_px : null, s1: Number.isFinite(map.s1_px) ? map.s1_px : null, fn, ease: shape, family: rec.model.family };
}

/** Declared scroll range (px) of a tween on a scrubbing trigger: the trigger's own animation, or its part of the trigger's timeline. */
function scrubRange(t, trigById) {
  const own = t.scrollTrigger && trigById.get(t.scrollTrigger);
  if (own && own.scrub) return own.start != null && own.end != null ? { st: own, s0: own.start, s1: own.end } : { st: own, s0: null, s1: null };
  for (const w of t.within || []) {
    const st = [...trigById.values()].find(x => x.animation === w.key && x.scrub);
    if (!st) continue;
    if (st.start == null || st.end == null || !(w.duration > 0) || w.start == null || w.end == null) return { st, s0: null, s1: null };
    const L = st.end - st.start;
    return { st, s0: st.start + L * (w.start / w.duration), s1: st.start + L * (w.end / w.duration) };
  }
  return null;
}

/**
 * Join motion/gsap.json with the fits of the same run (pure).
 * @param {object} doc  gsap.json
 * @param {object} fitsByTake  {takeName: fit.json}; a take's class is its name's prefix (`A-load` -> A)
 * @returns {object} gsap-match.json
 */
export function joinGsapFits(doc, fitsByTake) {
  const recsOf = {};
  for (const [take, f] of Object.entries(fitsByTake || {})) {
    const cls = take.split('-')[0];
    for (const r of f?.records || []) if (r?.target?.desc && r.target.channel) (recsOf[cls] ||= []).push({ take, r });
  }
  const entries = [];
  for (const [cls, c] of Object.entries(doc?.classes || {})) {
    if (!c.found) continue;
    const trigById = new Map((c.scrollTriggers || []).map(s => [s.id, s]));
    for (const t of c.tweens || []) {
      if (t.type !== 'tween') continue;
      const ease = gsapEase(t.ease?.name);
      const scale = t.scale || 1;
      // a negative accumulated timeScale only reverses the direction of play: the same time takes the same duration
      const mag = Math.abs(scale);
      const declMs = Number.isFinite(t.duration) ? (t.duration * 1000) / mag : null;
      const scrub = scrubRange(t, trigById);
      for (const prop of Object.keys(t.props || {})) {
        const chans = PROP_CHANNELS[prop] || null;
        for (const desc of [...new Set(t.targets || [])].slice(0, 10)) {
          const e = { cls, tween: t.id, desc, prop, channels: chans,
            declared: { durationMs: declMs, delayMs: Number.isFinite(t.delay) ? (t.delay * 1000) / mag : null, ease: ease.name ?? t.ease?.name ?? null, easeSource: t.ease?.source ?? null,
              repeat: t.repeat, yoyo: t.yoyo, kind: t.kind, ...(scale !== 1 ? { timeScale: scale, ...(scale < 0 ? { directionAtProbe: 'reversed' } : {}) } : {}), ...(scrub ? { scrub: scrub.st.scrub, trigger: scrub.st.id, scrollPx: [scrub.s0, scrub.s1] } : {}) } };
          if (t.kind === 'keyframes') { entries.push({ ...e, status: 'no-fit', why: 'a keyframes tween (per-keyframe eases and durations) is not compared' }); continue; }
          if (!chans) { entries.push({ ...e, status: 'no-fit', why: `GSAP property ${prop} has no motion channel here` }); continue; }
          if (!desc || desc === 'object' || desc === '#node') { entries.push({ ...e, status: 'no-fit', why: 'the target is not an element' }); continue; }
          const looping = !scrub && isLoop(t);
          // a looping percent tween is compared by speed on the driver's own percent channel (`transform`, the inline translate in %)
          const wantCh = looping && PERCENT_PROPS.has(prop) ? ['transform'] : chans;
          const cands = (recsOf[cls] || []).filter(x => wantCh.includes(chanOf(x.r.target.channel)) && descMatch(x.r.target.desc, desc));
          entries.push(scrub ? judgeScroll(e, cands, ease, scrub) : looping ? judgeLoop(e, cands, ease, declMs, t.props[prop]) : judgeTime(e, cands, ease, declMs));
        }
      }
    }
  }
  const count = (k) => entries.filter(x => x.status === k).length;
  return {
    schema: MATCH_SCHEMA, probe: doc?.probe ?? null, gsapFound: !!doc?.found,
    tolerances: { durationMs: `max(one frame of the take, ${DUR_REL_TOL} x declared)`, easeMaxDelta: EASE_TOL, easeSamples: EASE_SAMPLES, scrollPx: `max(${RANGE_MIN_PX}, ${RANGE_REL_TOL} x range)` },
    summary: { entries: entries.length, matched: count('matched'), partlyChecked: count('partly-checked'), disagrees: count('disagrees'), noFit: count('no-fit') },
    // disagreements that carry a diagnosis (`diagnosis` on the entry; their status stays `disagrees`) and those that do not
    diagnosed: { fitTie: entries.filter(x => x.status === 'disagrees' && x.diagnosis === 'fit-tie').length, unexplained: entries.filter(x => x.status === 'disagrees' && !x.diagnosis).length },
    note: 'One entry per declared GSAP tween x animated property x target element. matched: everything checkable agrees; partly-checked: what could be checked agrees, `unchecked` names the rest; disagrees: `why` names what; no-fit: no fitted record of that element and channel. The fits are not changed by this file.',
    entries,
  };
}

function judgeTime(e, cands, ease, declMs) {
  const tw = cands.map(x => ({ x, f: fittedTween(x.r) })).filter(y => y.f);
  if (!tw.length) return { ...e, status: 'no-fit', why: cands.length ? `${cands.length} fitted record(s) on this element and channel, none a time tween` : 'no fitted record of this element and channel' };
  const score = (y) => (declMs == null ? 0 : Math.abs(y.f.durationMs - declMs));
  const withEase = (y) => (ease.fn ? easeMaxDelta(ease.fn, y.f.fn) : null);
  tw.sort((a, b) => score(a) - score(b) || (withEase(a) ?? 0) - (withEase(b) ?? 0));
  const best = tw[0]; const f = best.f;
  const frame = best.x.r.model?.valid_at?.frame_ms || 1000 / 60;
  const dDur = declMs == null ? null : f.durationMs - declMs;
  const tolDur = declMs == null ? null : Math.max(frame, DUR_REL_TOL * declMs);
  const dEase = withEase(best);
  const checked = [], unchecked = [], bad = [];
  if (dDur == null) unchecked.push('duration (not declared as a number)'); else { checked.push('duration'); if (Math.abs(dDur) > tolDur) bad.push(`duration ${Math.round(f.durationMs)} ms fitted vs ${Math.round(declMs)} ms declared (tolerance ${Math.round(tolDur)} ms)`); }
  if (dEase == null) unchecked.push(`ease (${ease.why || 'unknown'})`); else { checked.push('ease'); if (dEase > EASE_TOL) bad.push(`ease ${ease.name} vs fitted ${f.ease}: max |delta| ${dEase.toFixed(4)} > ${EASE_TOL}`); }
  const status = bad.length ? 'disagrees' : !checked.length ? 'no-fit' : unchecked.length ? 'partly-checked' : 'matched';
  const alt = bad.length ? fitTie(best.x.r, ease, declMs, tolDur) : null;
  return { ...e, match: { take: best.x.take, el: best.x.r.target.el ?? null, desc: best.x.r.target.desc, channel: best.x.r.target.channel, family: best.x.r.model.family, durationMs: f.durationMs, t0Ms: f.t0, ease: f.ease, withheld: f.withheld, frameMs: frame },
    candidates: tw.length, durationDeltaMs: dDur, durationTolMs: tolDur, easeMaxDelta: dEase, checked, unchecked, status, ...(bad.length ? { why: bad.join('; ') } : {}),
    ...(alt ? { fitAlternative: alt, ...(alt.explains ? { diagnosis: 'fit-tie' } : {}) } : {}) };
}

/** Is the fitted record's runner-up the declared curve? When the fitter's two best families are statistically tied (BIC within
 *  2) and the runner-up is exactly the declared ease with a duration inside the tolerance, the disagreement is the fitter's
 *  tie-break, not the page: the entry keeps `disagrees` and carries `diagnosis: 'fit-tie'` with this evidence. */
export const TIE_BIC = 2, TIE_EASE_EXACT = 1e-6;
function fitTie(rec, ease, declMs, tolDur) {
  const ru = rec?.runnerUp; const m = /^named:(.+)$/.exec(ru?.family || '');
  if (!m || !NAMED[m[1]] || !ease.fn || declMs == null) return null;
  const Dv = ru.params?.D; const D = typeof Dv === 'number' ? Dv : Dv?.value;
  if (!Number.isFinite(D) || !Number.isFinite(ru.bic) || !Number.isFinite(rec.fit?.bic)) return null;
  const bicDelta = ru.bic - rec.fit.bic, easeDelta = easeMaxDelta(ease.fn, NAMED[m[1]].fn);
  const within = Math.abs(D - declMs) <= tolDur;
  return { family: ru.family, durationMs: D, durationDeltaMs: D - declMs, durationWithinTol: within, easeMaxDelta: easeDelta, bicDelta, rms: ru.rms ?? null, winnerRms: rec.fit.rms ?? null,
    explains: within && easeDelta <= TIE_EASE_EXACT && Math.abs(bicDelta) <= TIE_BIC };
}

// ---- looping tweens (repeat != 0): the fitted D of a window is not the cycle
const PERCENT_PROPS = new Set(['xPercent', 'yPercent']);
const isLoop = (t) => Number.isFinite(t.repeat) && t.repeat !== 0 && t.kind !== 'keyframes';
const numOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:px|%)?$/.test(v.trim()) ? parseFloat(v) : null);
/** A fitted straight ramp's slope in channel units per second, or null. */
function rampSpeed(rec) {
  if (rec?.model?.family !== 'ramp') return null; const P = rec.model.params || {};
  const a = pv(P.from).v, b = pv(P.to).v, D = pv(P.D).v;
  return a == null || b == null || !(D > 0) ? null : { perS: (b - a) / (D / 1000), from: a, to: b, durationMs: D, t0Ms: pv(P.t0).v };
}
/**
 * A tween that repeats (repeat -1 marquee, yoyo loops) runs for as long as the take lasts: the fitted record is a window of it
 * (a ramp whose D is where the window ends), so D says nothing about the declared cycle. What both sides measure is the speed:
 * |to - from| per declared cycle second vs the fitted ramp's slope (same units: % on the driver's `transform` channel for
 * xPercent / yPercent, px for x / y), and, for a linear ease, that the window is straight. The direction is not compared: a
 * negative accumulated timeScale at probe time is the page flipping the playhead (scroll-direction marquee), not the rate.
 */
function judgeLoop(e, cands, ease, declMs, pr) {
  const rs = cands.map(x => ({ x, f: rampSpeed(x.r) })).filter(y => y.f);
  if (!rs.length) return { ...e, status: 'no-fit', why: cands.length ? `${cands.length} fitted record(s) on this element and channel, none a straight ramp (a repeating tween is compared by speed)` : 'no fitted record of this element and channel' };
  const a = numOf(pr?.from), b = numOf(pr?.to);
  const declPerS = a != null && b != null && declMs > 0 ? Math.abs(b - a) / (declMs / 1000) : null;
  rs.sort((p, q) => (declPerS == null ? 0 : Math.abs(Math.abs(p.f.perS) - declPerS) - Math.abs(Math.abs(q.f.perS) - declPerS)) || q.f.durationMs - p.f.durationMs);
  const best = rs[0], f = best.f;
  const checked = [], unchecked = [], bad = [];
  const dRel = declPerS ? (Math.abs(f.perS) - declPerS) / declPerS : null;
  if (declPerS == null) unchecked.push('speed (the declared from / to are not both numbers)');
  else { checked.push('speed'); if (Math.abs(dRel) > DUR_REL_TOL) bad.push(`speed ${Math.abs(f.perS).toFixed(4)}/s fitted vs ${declPerS.toFixed(4)}/s declared (tolerance ${DUR_REL_TOL * 100} %)`); }
  // a straight window of a linear tween is straight; a window of any other ease is a piece of the curve
  if (ease.fn && ease.name === 'none') checked.push('ease (linear)'); else unchecked.push(`ease (a repeating tween with ${ease.name ?? 'an unknown ease'}: the fitted window is a piece of the cycle)`);
  const status = bad.length ? 'disagrees' : !checked.length ? 'no-fit' : unchecked.length ? 'partly-checked' : 'matched';
  return { ...e, match: { take: best.x.take, el: best.x.r.target.el ?? null, desc: best.x.r.target.desc, channel: best.x.r.target.channel, family: 'ramp', windowDurationMs: f.durationMs, t0Ms: f.t0Ms, from: f.from, to: f.to, speedPerS: f.perS },
    candidates: rs.length, declaredSpeedPerS: declPerS, speedRelDelta: dRel, notCompared: 'cycle duration (the fitted ramp is a window of a repeating tween)', checked, unchecked, status, ...(bad.length ? { why: bad.join('; ') } : {}) };
}

function judgeScroll(e, cands, ease, scrub) {
  const sc = cands.map(x => ({ x, f: fittedScroll(x.r) })).filter(y => y.f);
  if (!sc.length) return { ...e, status: 'no-fit', why: cands.length ? `${cands.length} fitted record(s) on this element and channel, none a scroll map (the tween scrubs with the scroll)` : 'no fitted record of this element and channel' };
  const off = (y) => (scrub.s0 == null || y.f.s0 == null || y.f.s1 == null ? 0 : Math.abs(y.f.s0 - scrub.s0) + Math.abs(y.f.s1 - scrub.s1));
  sc.sort((a, b) => off(a) - off(b));
  const best = sc[0]; const f = best.f;
  const checked = [], unchecked = [], bad = [];
  if (scrub.s0 == null || f.s0 == null || f.s1 == null) unchecked.push('scroll range (not known on both sides)');
  else { checked.push('scroll range'); const tol = Math.max(RANGE_MIN_PX, RANGE_REL_TOL * Math.abs(scrub.s1 - scrub.s0)); const d0 = f.s0 - scrub.s0, d1 = f.s1 - scrub.s1; if (Math.abs(d0) > tol || Math.abs(d1) > tol) bad.push(`scroll range ${Math.round(f.s0)}..${Math.round(f.s1)} px fitted vs ${Math.round(scrub.s0)}..${Math.round(scrub.s1)} px declared (tolerance ${tol.toFixed(1)} px)`); }
  const dEase = ease.fn && f.fn ? easeMaxDelta(ease.fn, f.fn) : null;
  if (typeof scrub.st.scrub === 'number') unchecked.push(`ease (scrub ${scrub.st.scrub} s smooths the scroll: the fitted map is not the bare ease)`);
  else if (dEase == null) unchecked.push(`ease (${ease.fn ? `fitted map shape ${f.ease ?? 'unknown'}` : ease.why || 'unknown'})`);
  else { checked.push('ease'); if (dEase > EASE_TOL) bad.push(`ease ${ease.name} vs fitted map ${f.ease}: max |delta| ${dEase.toFixed(4)} > ${EASE_TOL}`); }
  const status = bad.length ? 'disagrees' : !checked.length ? 'no-fit' : unchecked.length ? 'partly-checked' : 'matched';
  return { ...e, match: { take: best.x.take, el: best.x.r.target.el ?? null, desc: best.x.r.target.desc, channel: best.x.r.target.channel, family: f.family, scrollPx: [f.s0, f.s1], ease: f.ease },
    candidates: sc.length, easeMaxDelta: typeof scrub.st.scrub === 'number' ? null : dEase, checked, unchecked, status, ...(bad.length ? { why: bad.join('; ') } : {}) };
}

/**
 * Fit step: join <runDir>/motion/gsap.json with <runDir>/motion/fits/*.fit.json, write motion/fits/gsap-match.json.
 * Returns the summary, or null when the run has no gsap.json (a run made before the probe existed: nothing is written).
 */
export function writeGsapMatch(runDir) {
  const gf = path.join(runDir, 'motion', 'gsap.json');
  if (!fs.existsSync(gf)) return null;
  const doc = JSON.parse(fs.readFileSync(gf, 'utf8'));
  const fdir = path.join(runDir, 'motion', 'fits');
  const fits = {};
  let names = []; try { names = fs.readdirSync(fdir).filter(f => f.endsWith('.fit.json')).sort(); } catch { /* no fits */ }
  for (const n of names) { try { fits[n.replace(/\.fit\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(fdir, n), 'utf8')); } catch { /* unreadable fit: its take is not joined */ } }
  const m = joinGsapFits(doc, fits);
  fs.mkdirSync(fdir, { recursive: true });
  fs.writeFileSync(path.join(fdir, 'gsap-match.json'), JSON.stringify(m, null, 1));
  return { gsapFound: m.gsapFound, ...m.summary };
}
