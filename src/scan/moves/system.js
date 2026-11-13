// The site's motion system: the few rules most of its moves follow, in plain sentences and as tokens to copy (6 Nov review, "if only one
// thing": the card had the numbers and never said the recipe). One vote per move class, as site.feel counts, so forty cards do not
// outvote the hero; a move that is no motion a person sees (notMove, a consent banner) and a canvas do not vote. Every share says what
// it is a share of. Nothing here is guessed: a rule with too few votes is left out, never filled in.
import { round } from '../../export/curves.js';
import { easeTexts, leadGroup } from '../../export/move.js';
import { curveFamily } from './feel.js';
import { clauseOf, isMeasured } from './intent.js';

const ARRIVE = new Set(['load', 'gate', 'scroll', 'scroll-up']), POINTER = new Set(['touch', 'open']);
const MIN_VOTES = 3, MAIN_SHARE = 0.3, TOGETHER_FRAMES_MS = 20, TOGETHER_SHARE = 0.6, START_SPREAD_MAX = 30, LATER_MAX_MS = 2000;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const quantile = (s, q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
const secs = (ms) => `${round(ms / 1000, ms < 1000 ? 2 : 1)} s`;
/** Every duration REVA writes as a rule is a multiple of 10 ms: what a person types (344 ms read as 340 ms; the move keeps its own). */
export const ms10 = (ms) => (Number.isFinite(ms) ? Math.round(ms / 10) * 10 : ms);
const listed = (l) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const top = (map) => [...map].sort((a, b) => b[1].n - a[1].n || String(a[0]).localeCompare(String(b[0])))[0] ?? null;

/** How a lead's ease is known, in the words of the card's proof labels. */
function sourceOf(g) {
  if (g.provenance === 'declared') return g.law?.via === 'gsap' ? 'gsap' : 'css';
  if (g.law?.snapped) return 'site';
  return 'measured';
}
const SOURCE_WORD = { css: "declared in the site's CSS", gsap: "declared in the site's GSAP", site: "the site's own declared ease, matched on the recording", measured: 'measured from the recording' };

/** The most used ease of a set of leads: its text, the law that carries it, how it is known, and its share of the leads that have an ease. */
function easeOfSet(leads) {
  const by = new Map(); let n = 0;
  for (const g of leads) {
    const name = curveFamily(g.law); if (!name) continue; n++;
    const e = by.get(name) || by.set(name, { n: 0, law: g.law, sources: new Map(), ms: [] }).get(name);
    e.n++; const s = sourceOf(g); e.sources.set(s, (e.sources.get(s) || 0) + 1);
    if (g.law.ms > 0 && g.law.class !== 'map' && (isMeasured(g) || !g.provenance)) e.ms.push(g.law.ms);
  }
  const t = top(by); if (!t || n < 1) return null;
  const [name, e] = t, source = [...e.sources].sort((a, b) => b[1] - a[1])[0][0];
  // a declared source wins when any vote has it: the site wrote this ease down somewhere
  const best = e.sources.has('css') ? 'css' : e.sources.has('gsap') ? 'gsap' : e.sources.has('site') ? 'site' : source;
  // the duration this ease runs at, as its own votes have it: an ease and its time are one rule (the site's 200 ms ease-in-out)
  return { text: name, n: e.n, of: n, share: round(e.n / n, 2), source: best, ms: e.ms.length ? ms10(median(e.ms)) : null, law: e.law };
}

/** A clause of a rise by a number of px: the votes on how far say the number, so the shapes vote without it. */
const RISE_CLAUSE = /^rise [\d.]+ px$/;
/**
 * The most common way arrivals change, in plural clauses ("rise 20 px", "fade in"), and how many arrivals do exactly that. How far
 * they rise is its own vote, one per arrival lead on its own y (fit.js ownEnds): the most common distance, and the next one when it has
 * at least half as many votes ("14 rise 20 px, 9 rise 50 px": one element's 20 px is no rule for the 75 that rise 50, 11 Nov).
 */
export function arrivalShape(leads) {
  const by = new Map(), rises = new Map();
  for (const g of leads) {
    const y = (g.changes || []).find((c) => c.family === 'move' && (c.property === 'y' || c.part === 'y') && typeof c.from === 'number' && typeof c.to === 'number' && c.peak == null && !c.back);
    const up = y && y.to < y.from ? round(Math.abs(y.to - y.from), 1) : null;
    if (up >= 1) rises.set(up, (rises.get(up) || 0) + 1);
    const said = [...new Set((g.changes || []).filter((c) => c.peak == null && !c.back).map((c) => clauseOf(c, { many: true, screen: g.screen })).filter(Boolean).map((c) => (RISE_CLAUSE.test(c) ? 'rise' : c)))].slice(0, 3);
    if (!said.length) continue;
    const k = said.join(' and '), e = by.get(k) || by.set(k, { n: 0, said }).get(k); e.n++;
  }
  const t = top(by); if (!t) return null;
  const votes = [...rises].sort((a, b) => b[1] - a[1] || a[0] - b[0]), rise = votes[0]?.[0] ?? null, riseN = votes[0]?.[1] ?? 0;
  const alt = votes[1] && votes[1][1] * 2 >= riseN ? { px: votes[1][0], n: votes[1][1] } : null;
  // two distances that both hold: the shape says "rise", the sentence says both with their counts
  const said = t[1].said.map((c) => (c === 'rise' && rise != null && !alt ? `rise ${rise} px` : c));
  return { said, n: t[1].n, of: leads.length, rise, riseN, ...(alt ? { riseAlt: alt } : {}) };
}

/**
 * @param {object} index  moves.json, after the fit and siteMoves
 * @param {Map<string, object>} docs  move id -> moves/<id>.json
 * @param {object|null} feel  site.feel (its scroll part: smoothing, Lenis)
 * @returns {object|null} site.system; null when fewer than three moves have a law
 */
export function systemOf(index, docs, feel = null) {
  const moves = index.moves.filter((m) => !m.notMove && !m.consent && m.viewport !== 'phone');
  const leadOf = (m) => { const d = docs.get(m.id); const g = d?.groups?.length ? leadGroup(d.groups) : null; return g?.law && g.layer !== 'gl' ? g : null; };
  const rows = moves.map((m) => ({ m, g: leadOf(m) })).filter((x) => x.g);
  if (rows.length < MIN_VOTES) return null;
  // times and travel come from measured parts only (ZD, intent.js isMeasured): a recorded window may be a jump's
  const timed = (list) => list.filter(({ g }) => ['tween', 'spring', 'keyframes'].includes(g.law.class) && g.law.ms > 0 && (isMeasured(g) || !g.provenance)).map(({ g }) => g.law.ms);
  const all = timed(rows).sort((a, b) => a - b);
  const arrive = rows.filter(({ m }) => ARRIVE.has(m.kind)), pointer = rows.filter(({ m }) => POINTER.has(m.kind));
  const arriveMs = timed(arrive), pointerMs = timed(pointer);
  const tempo = all.length >= MIN_VOTES ? {
    fast: ms10(quantile(all, 0.25)), typical: ms10(quantile(all, 0.5)), slow: ms10(quantile(all, 0.75)), n: all.length,
    arrive: arriveMs.length >= 2 ? ms10(median(arriveMs)) : null, arriveN: arriveMs.length,
    pointer: pointerMs.length >= 2 ? ms10(median(pointerMs)) : null, pointerN: pointerMs.length,
  } : null;
  const ease = easeOfSet(rows.map((x) => x.g));
  const arriveEase = easeOfSet(arrive.map((x) => x.g)), pointerEase = easeOfSet(pointer.map((x) => x.g));
  const shapeOf = arrive.filter(({ g }) => isMeasured(g) || !g.provenance);
  const shape = shapeOf.length >= MIN_VOTES ? arrivalShape(shapeOf.map((x) => x.g)) : null;

  // stagger: one vote per staggered group, and what the staggered things were (letters, words, items)
  const steps = new Map(); let staggered = 0; const units = new Map();
  for (const { m } of rows) for (const g of docs.get(m.id)?.groups || []) {
    if (!(g.stagger?.ms > 0)) continue; staggered++;
    const s = Math.round(g.stagger.ms / 10) * 10 || g.stagger.ms, e = steps.get(s) || steps.set(s, { n: 0 }).get(s); e.n++;
    const u = g.split?.unit ?? 'item'; units.set(u, (units.get(u) || 0) + 1);
  }
  const st = top(steps);
  const stagger = st && staggered >= 2 ? { ms: st[0], n: st[1].n, of: staggered, split: [...units.keys()].filter((u) => u !== 'item') } : null;

  // overlap: in a move with several parts, do the later parts wait? The delay each later part starts after the first (fit.js delayMs)
  let multi = 0, together = 0; const later = [], ratio = [];
  for (const { m } of arrive) {
    const gs = (docs.get(m.id)?.groups || []).filter((g) => g.law && g.layer !== 'gl' && g.part !== 'out' && g.part !== 'close');
    if (gs.length < 2) continue; multi++;
    const d = gs.map((g) => g.delayMs || 0), lead = gs[0];
    if (Math.max(...d) <= TOGETHER_FRAMES_MS) together++;
    else for (const x of d) if (x > TOGETHER_FRAMES_MS) { later.push(x); if (lead.law?.ms > 0) ratio.push(x / lead.law.ms); }
  }
  const overlap = multi >= MIN_VOTES ? { moves: multi, together, laterMs: later.length ? Math.round(median(later)) : null, beforeEnd: ratio.length ? ratio.filter((r) => r < 1).length / ratio.length : null } : null;

  // scroll: played once as it comes into view, or tied to the scroll; where on the screen the start sits
  const sc = rows.filter(({ m }) => m.kind === 'scroll');
  const linked = sc.filter(({ m, g }) => m.trigger?.kind === 'scroll-linked' || g.law.class === 'map').length, triggered = sc.length - linked;
  const starts = sc.filter(({ m }) => m.trigger?.kind === 'scroll-triggered').map(({ m }) => /(\d+)%/.exec(m.trigger?.scroll?.start || '')?.[1]).filter(Boolean).map(Number);
  // where the top of a part sits when it starts: one number when most starts agree within 5 %, the middle half of them otherwise
  const ss = [...starts].sort((a, b) => a - b), startPct = ss.length ? median(ss) : null, near = ss.filter((p) => Math.abs(p - startPct) <= 5).length;
  const startRange = ss.length >= 4 ? [quantile(ss, 0.25), quantile(ss, 0.75)] : null;
  // a start is a rule only when the starts agree: most within 5 %, or the middle half within 30 % of the screen (starts spread from 1 to 74 %: no rule)
  const startFirm = ss.length > 0 && (near / ss.length >= 0.5 || (startRange && startRange[1] - startRange[0] <= START_SPREAD_MAX));
  const scroll = sc.length ? { triggered, linked, startPct: startFirm ? startPct : null, startShare: ss.length ? round(near / ss.length, 2) : null, ...(startRange && startFirm ? { startRange } : {}), smoothed: feel?.scroll?.kind === 'smoothed' ? { by: feel.scroll.by ?? null, lagMs: feel.scroll.lagMs ?? null } : null, wheel: feel?.scroll?.kind === 'wheel-consumed' } : null;

  const system = { tempo, ease, arrive: arriveEase, pointer: pointerEase, shape, stagger, overlap, scroll };
  system.sentences = sentencesOf(system);
  system.tokens = tokensOf(system, index.site?.host ?? null);
  // the laws were only for the tokens: moves.json keeps the ease's text, count and source
  for (const k of ['ease', 'arrive', 'pointer']) if (system[k]) { const { law, ...rest } = system[k]; system[k] = rest; }
  return system;
}

const smooth = (x) => `Scrolling is smoothed${x.by ? ` by ${x.by}` : ''}${x.lagMs ? `, and the page settles about ${x.lagMs} ms after the wheel stops` : ''}`;
/** Plain sentences, each one rule, in the order a person builds: time, curve, shape, order, overlap, scroll. */
export function sentencesOf(s) {
  const out = [];
  const t = s.tempo, num = (ms) => String(round(ms / 1000, ms < 1000 ? 2 : 1));
  const a = s.arrive && s.arrive.of >= MIN_VOTES && s.arrive.share >= MAIN_SHARE ? s.arrive : null;
  const main = a ?? (s.ease && s.ease.share >= MAIN_SHARE && s.ease.of >= MIN_VOTES ? s.ease : null);
  const p = s.pointer && s.pointer.of >= 2 && s.pointer.share >= MAIN_SHARE && (!main || s.pointer.text !== main.text) ? s.pointer : null;
  // five sentences at most, each one rule a person builds with: time, curve, shape, order, scroll (6 Nov review; no data stuffing)
  const ptrMs = p?.ms ?? t?.pointer ?? null;
  if (t) {
    const range = t.fast === t.slow ? secs(t.fast) : `${num(t.fast)} to ${secs(t.slow)}`;
    const parts = [t.arrive ? `things arrive in ${secs(a?.ms ?? t.arrive)}` : null, ptrMs ? `hovers and clicks answer in ${secs(ptrMs)}` : null].filter(Boolean);
    out.push(`Most motion takes ${range}${parts.length ? `: ${parts.join(', and ')}` : ''}.`);
  }
  if (main || p) {
    const easeWord = (e) => (e.text === 'spring' ? 'a spring' : e.text);
    const first = main ? `${a ? 'Arrivals ease' : 'Most moves ease'} on ${easeWord(main)}, ${SOURCE_WORD[main.source]} (${main.n} of ${main.of})` : null;
    const second = p ? `${first ? 'hovers and clicks' : 'Hovers and clicks ease'} on ${easeWord(p)} (${p.n} of ${p.of})` : null;
    out.push(`${[first, second].filter(Boolean).join('; ')}.`);
  }
  if (s.shape && s.shape.n >= 2) {
    const alt = s.shape.riseAlt, how = alt ? `: ${s.shape.riseN} rise ${s.shape.rise} px, ${alt.n} rise ${alt.px} px` : '';
    out.push(`${s.shape.n * 2 >= s.shape.of ? 'Most arrivals' : `${s.shape.n} of ${s.shape.of} arrivals`} ${listed(s.shape.said)}${how}.`);
  }
  const order = [];
  if (s.stagger) order.push(`Items in a group arrive one by one, ${s.stagger.ms} ms apart${s.stagger.split.length ? `, and text is split into ${listed(s.stagger.split.map((u) => `${u}s`))} first` : ''}.`);
  const o = s.overlap;
  if (o) {
    if (o.together >= TOGETHER_SHARE * o.moves) order.push(`The parts of an arrival start together (${o.together} of ${o.moves}).`);
    // a wait of seconds is a sequence (a loader, then the page), not a rule of how parts overlap
    else if (o.laterMs != null && o.laterMs <= LATER_MAX_MS) order.push(`Later parts start about ${secs(o.laterMs)} after the first${o.beforeEnd >= 0.5 ? ', while it is still moving' : ', once it has finished'}.`);
  }
  if (order.length) out.push(order.join(' '));
  const sc = s.scroll;
  if (sc && (sc.triggered || sc.linked)) {
    const at = sc.startPct == null ? ' as it comes into view' : sc.startShare >= 0.5 || !sc.startRange ? ` as its top reaches ${sc.startShare >= 0.5 ? '' : 'about '}${sc.startPct} % of the screen` : ` as its top reaches ${sc.startRange[0]} to ${sc.startRange[1]} % of the screen, ${sc.startPct} % in the middle`;
    const parts = [];
    if (sc.triggered) parts.push(`On scroll, ${sc.triggered === 1 ? 'one move plays' : 'each move plays'} once${at}`);
    if (sc.linked) parts.push(`${count(sc.linked, 'move follows', 'moves follow')} the scroll itself`);
    if (sc.smoothed) parts.push(smooth(sc.smoothed).replace(/^S/, 's'));
    out.push(`${parts.join('; ')}.`);
  } else if (sc?.smoothed) out.push(`${smooth(sc.smoothed)}.`);
  if (sc?.wheel) out.push('The wheel drives a scene, and the document itself does not scroll.');
  return out;
}

const ms2s = (ms) => round(ms10(ms) / 1000, 2);
/** The scroll start the tokens use, and the run of starts behind it when the sentence gives one. */
const scrollNote = (sc) => (sc?.startRange && sc.startPct != null && !(sc.startShare >= 0.5) ? `starts run ${sc.startRange[0]}-${sc.startRange[1]} %` : null);
/** The rules as code to paste: CSS custom properties, GSAP defaults, a Motion config. Only the rules the sentences say. */
export function tokensOf(s, host = null) {
  const main = s.arrive?.law ? s.arrive : s.ease, e = main ? easeTexts(main.law) : null, p = s.pointer && s.pointer.text !== main?.text ? easeTexts(s.pointer.law) : null;
  const t = s.tempo, head = `${host ? `${host} ` : ''}motion, read by REVA`;
  const dur = ms10(main?.ms ?? t?.arrive ?? t?.typical ?? null), hoverMs = ms10((p && s.pointer.ms) || t?.pointer || null), rise = s.shape?.rise ?? null, st = s.stagger?.ms ?? null;
  const alt = s.shape?.riseAlt, riseNote = alt ? `${alt.n} of ${s.shape.of} arrivals rise ${alt.px} px` : null, scrollAt = scrollNote(s.scroll);
  const css = [`/* ${head} */`, ':root {'];
  if (e && !e.spring) css.push(`  --motion-ease: ${e.css};`);
  if (p && !p.spring) css.push(`  --motion-ease-pointer: ${p.css};`);
  // one literal per duration: a time equal to one written above it is that token (600 ms slow and arrive: arrive is var(--motion-duration-slow))
  const durations = [];
  const duration = (name, ms) => { if (!(ms > 0)) return; const same = durations.find((x) => x.ms === ms); css.push(`  --${name}: ${same ? `var(--${same.name})` : `${ms}ms`};`); if (!same) durations.push({ name, ms }); };
  if (t) { duration('motion-duration-fast', ms10(t.fast)); duration('motion-duration', ms10(t.typical)); duration('motion-duration-slow', ms10(t.slow)); }
  if (t?.arrive) duration('motion-duration-arrive', ms10(t.arrive));
  if (hoverMs) duration('motion-duration-pointer', hoverMs);
  if (st) css.push(`  --motion-stagger: ${st}ms;`);
  if (rise) css.push(`  --motion-rise: ${rise}px;${riseNote ? ` /* ${riseNote} */` : ''}`);
  css.push('}');
  if (e?.spring) css.push('/* The main motion is a spring: CSS has no spring curve, so it has no ease here. */');

  const gsap = [`// ${head}`];
  const plugin = e?.plugin || p?.plugin;
  if (plugin) gsap.push('gsap.registerPlugin(CustomEase);');
  if (e) gsap.push(`const ease = ${e.gsap};`);
  if (p) gsap.push(`const pointerEase = ${p.gsap};`);
  gsap.push(`gsap.defaults({ ${[dur ? `duration: ${ms2s(dur)}` : null, e ? 'ease' : null].filter(Boolean).join(', ')} });`);
  const extra = [st ? `stagger: ${ms2s(st)}` : null, rise ? `rise: ${rise}${riseNote ? ` /* ${riseNote} */` : ''}` : null, hoverMs ? `pointer: { duration: ${ms2s(hoverMs)}${p ? ', ease: pointerEase' : ''} }` : null, s.scroll?.startPct != null ? `scrollStart: "top ${s.scroll.startPct}%"` : null].filter(Boolean);
  if (extra.length) gsap.push(`export const motion = { ${extra.join(', ')} };${scrollAt && s.scroll?.startPct != null ? `   // ${scrollAt}` : ''}`);

  const mo = [`// ${head}`];
  if (e) mo.push(e.spring ? `export const transition = ${e.motion};` : `export const transition = { ${dur ? `duration: ${ms2s(dur)}, ` : ''}ease: ${e.motion} };`);
  else if (dur) mo.push(`export const transition = { duration: ${ms2s(dur)} };`);
  if (hoverMs) mo.push(p?.spring ? `export const pointer = ${p.motion};` : `export const pointer = { duration: ${ms2s(hoverMs)}${p ? `, ease: ${p.motion}` : ''} };`);
  if (st) mo.push(`export const stagger = ${ms2s(st)};   // delay: stagger(${ms2s(st)})`);
  if (rise) mo.push(`export const rise = ${rise};   // y: [${rise}, 0]${riseNote ? `; ${riseNote}` : ''}`);
  if (s.scroll?.startPct != null) mo.push(`export const inViewMargin = "0px 0px -${100 - s.scroll.startPct}% 0px";   // starts at ${s.scroll.startPct} % of the screen${scrollAt ? `; ${scrollAt}` : ''}`);
  return { css: css.join('\n'), gsap: gsap.join('\n'), motion: mo.join('\n') };
}
