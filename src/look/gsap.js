// look: the page's declared GSAP tweens, read with the corpus probe (src/corpus/gsap.js: read-only, GSAP's own getters,
// nothing written to the page) once after load and once after the action, unioned (gsapDoc) and joined with the look's
// fits (joinGsapFits). A motion whose record matches a declared tween prints the declared values ([exact]) and its gsap
// code is the page's declaration ("as declared"); a disagreement prints both and keeps the fit. A bundled GSAP (no
// window.gsap) reads nothing: look.json "gsap" says why, and nothing is printed.
import { buildGsapProbeSource, gsapDoc, joinGsapFits, GSAP_PROBE_VERSION } from '../corpus/gsap.js';

let SRC = null;
const msg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
/** One probe read ({at, ...read} or {at, error}); never throws. Bounded by `timeoutMs` (the look's cost cap: ~1 s). */
export async function readGsap(page, at, { timeoutMs = 1000 } = {}) {
  const t0 = Date.now(); let timer = null;
  try {
    SRC ||= buildGsapProbeSource();
    const r = await Promise.race([page.evaluate(SRC), new Promise((_, no) => { timer = setTimeout(() => no(new Error(`gsap probe took over ${timeoutMs} ms`)), timeoutMs); })]);
    if (!r || r.probe !== GSAP_PROBE_VERSION) throw new Error('gsap probe returned an unexpected result');
    return { at, ...r, ms: Date.now() - t0 };
  } catch (e) { return { at, found: false, error: msg(e), ms: Date.now() - t0 }; } finally { clearTimeout(timer); }
}

const LIVE = new Set(['matched', 'partly-checked', 'disagrees']);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
/**
 * Pure: the reads + the look's fit records -> look.json "gsap" {found, version, via, why, tweens, scrollTriggers, summary,
 * entries} (entries: the matched / partly-checked / disagrees joins, compact; no-fit ones are only counted) and the doc
 * (for the declared props of a tween). cls: the look's class key (a '-' would break the join's take-name prefix).
 */
export function lookGsap(reads, records, cls = 'A') {
  const k = String(cls || 'A').replace(/-/g, '_');
  const doc = gsapDoc({ [k]: { reads: (reads || []).filter((r) => !r.error), ...(reads || []).some((r) => r.error) ? { error: reads.find((r) => r.error).error } : {} } });
  const c = doc.classes[k] || {};
  const ms = (reads || []).reduce((s, r) => s + (r.ms || 0), 0);
  const base = { probe: doc.probe, found: !!c.found, version: c.version ?? null, via: c.via ?? null, ms, reads: (reads || []).map((r) => ({ at: r.at, found: !!r.found, ...(r.error ? { error: r.error } : {}) })) };
  if (!c.found) return { gsap: { ...base, why: c.why || (reads || []).find((r) => r.error)?.error || 'no GSAP global on this page', expandos: c.expandos || 0 }, doc };
  const m = joinGsapFits(doc, { [`${k}-look`]: { records: records || [] } });
  const entries = m.entries.filter((e) => LIVE.has(e.status)).map((e) => ({
    tween: e.tween, desc: e.desc, prop: e.prop, status: e.status, declared: e.declared,
    el: e.match?.el ?? null, channel: e.match?.channel ?? null,
    fitted: e.match ? { family: e.match.family, durationMs: r3(e.match.durationMs ?? e.match.windowDurationMs), ease: e.match.ease ?? null, ...(e.match.scrollPx ? { scrollPx: e.match.scrollPx } : {}), ...(e.match.speedPerS != null ? { speedPerS: r3(e.match.speedPerS) } : {}) } : null,
    checked: e.checked || [], unchecked: e.unchecked || [], ...(e.why ? { why: e.why } : {}), ...(e.diagnosis ? { diagnosis: e.diagnosis } : {}),
  }));
  return { gsap: { ...base, why: null, tweens: (c.tweens || []).filter((t) => t.type === 'tween').length, timelines: (c.tweens || []).filter((t) => t.type === 'timeline').length,
    scrollTriggers: (c.scrollTriggers || []).length, truncated: !!c.truncated, summary: m.summary, tolerances: m.tolerances, entries }, doc };
}

const sec = (ms) => `${r3(ms / 1000)} s`;
/** The declared values of one join entry in words: `duration 0.9 s, ease power2.out, delay 0.2 s`. */
export function declaredWords(d) {
  const p = [];
  if (d.scrub != null) p.push(`scrubbed with the scroll${typeof d.scrub === 'number' ? ` (smoothed ${d.scrub} s)` : ''}${d.scrollPx && d.scrollPx[0] != null ? ` over ${Math.round(d.scrollPx[0])}..${Math.round(d.scrollPx[1])} px` : ''}`);
  else if (Number.isFinite(d.durationMs)) p.push(`duration ${sec(d.durationMs)}`);
  if (d.ease) p.push(`ease ${d.ease}`);
  if (d.scrub == null && Number.isFinite(d.delayMs) && d.delayMs > 0) p.push(`delay ${sec(d.delayMs)}`);
  if (Number.isFinite(d.repeat) && d.repeat !== 0) p.push(`repeat ${d.repeat}${d.yoyo ? ', yoyo' : ''}`);
  if (d.timeScale != null) p.push(`timeScale ${d.timeScale}`);
  return p.join(', ');
}
/** The printed line of one entry: declared values [exact], and for a disagreement what the fit says instead. */
export function gsapLineText(e) {
  const head = `GSAP declared${e.prop ? ` (${e.prop})` : ''}: ${declaredWords(e.declared)} [exact]`;
  if (e.status === 'disagrees') return `${head}: disagrees with the fit (${e.why || 'see look.json "gsap"'}${e.diagnosis === 'fit-tie' ? '; the fit\'s runner-up is the declared curve' : ''})`;
  return e.status === 'partly-checked' ? `${head} (fit agrees on ${e.checked.join(', ')}; not checked: ${e.unchecked.join(', ')})` : head;
}

const LIT = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:px|%|deg|rad|turn|em|rem|vw|vh|vmin|vmax)?$/i;
const lit = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && LIT.test(v) ? JSON.stringify(v) : null);
/** The page's own declaration as a gsap snippet (to / from / fromTo, declared duration, delay, ease, repeat), or null when a
 *  value is not a literal the probe could read (a function, a relative "+=", a keyword) or the tween scrubs. */
export function declaredGsapCode(t, prop) {
  const pr = t && t.props && t.props[prop]; if (!pr || t.scrollTrigger || !['to', 'from', 'fromTo'].includes(t.kind)) return null;
  const from = pr.from === 'current' ? 'current' : pr.from == null ? null : lit(pr.from), to = pr.to === 'current' ? 'current' : lit(pr.to);
  const key = /^[A-Za-z_$][\w$]*$/.test(prop) ? prop : JSON.stringify(prop);
  const opts = [Number.isFinite(t.duration) ? `duration: ${r3(t.duration)}` : null, t.delay > 0 ? `delay: ${r3(t.delay)}` : null, t.ease && t.ease.name ? `ease: ${JSON.stringify(t.ease.name)}` : null,
    Number.isFinite(t.repeat) && t.repeat !== 0 ? `repeat: ${t.repeat}` : null, t.repeat && t.yoyo ? 'yoyo: true' : null].filter(Boolean).join(', ');
  if (t.kind === 'to' && to && to !== 'current') return `gsap.to(el, { ${key}: ${to}, ${opts} });`;
  if (t.kind === 'from' && from && from !== 'current') return `gsap.from(el, { ${key}: ${from}, ${opts} });`;
  if (t.kind === 'fromTo' && from && to && from !== 'current' && to !== 'current') return `gsap.fromTo(el, { ${key}: ${from} }, { ${key}: ${to}, ${opts} });`;
  return null;
}

/**
 * Pure: put the joins on the motions (mutates them). Each motion gets `gsap` (its entries + the printed text, one per
 * declared tween x property); on its lead's channel a matched / partly-checked tween's gsap export becomes the page's
 * declaration ("as declared"; the fitted snippet is kept under `fitted`). A disagreement leaves the fit export as it is.
 */
export function attachGsap(motions, g, doc) {
  if (!g || !g.found || !(g.entries || []).length) return motions;
  const tw = new Map(Object.values((doc && doc.classes) || {}).flatMap((c) => (c.tweens || []).map((t) => [t.id, t])));
  for (const m of motions || []) {
    const ids = new Set((Array.isArray(m.ids) && m.ids.length ? m.ids : [m.lead]).map(String));
    const seen = new Set(); const mine = [];
    for (const e of g.entries) { const k = `${e.tween}|${e.prop}`; if (e.el == null || !ids.has(String(e.el)) || seen.has(k)) continue; seen.add(k); mine.push(e); }
    if (!mine.length) continue;
    m.gsap = mine.map((e) => ({ tween: e.tween, prop: e.prop, status: e.status, channel: e.channel, text: gsapLineText(e) }));
    for (const e of mine) {
      if (e.status === 'disagrees' || String(e.el) !== String(m.lead)) continue;
      const code = declaredGsapCode(tw.get(e.tween), e.prop); if (!code) continue;
      const it = (m.exports || []).find((x) => x.channel === e.channel); if (!it || it.exports.some((x) => x.form === 'declared-gsap')) continue;
      const i = it.exports.findIndex((x) => x.lib === 'gsap'); const old = i >= 0 ? it.exports[i] : null;
      const x = { lib: 'gsap', form: 'declared-gsap', code, accuracy: { label: 'exact' }, note: `the page's own GSAP tween ${e.tween} (read from the page; the fit ${e.status === 'matched' ? 'agrees' : `agrees on ${e.checked.join(', ')}`})`,
        match: { word: 'as declared', why: null }, ...(old ? { fitted: { code: old.code, match: old.match } } : {}) };
      if (i >= 0) it.exports[i] = x; else it.exports.push(x);
    }
  }
  return motions;
}
