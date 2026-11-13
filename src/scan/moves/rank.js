// Rank and the top section (DESIGN 2.7). A first setting [J]: the owner's eye is the test, so it stays one small file.
import { noticeOf } from '../../look/rank.js';
import { RANK, ROUGH_PCT, rankScore } from './contract.js';

const STRONG_SHARE = 0.2;
const onScreen = (box, vp) => { if (!box) return 0; const w = Math.min(box[0] + box[2], vp.width) - Math.max(box[0], 0), h = Math.min(box[1] + box[3], vp.height) - Math.max(box[1], 0); return w > 0 && h > 0 ? w * h : 0; };

/** elementStats' shape, as far as noticeOf reads it, from a run. */
function member(r, vp) {
  const box = r.box && r.box.every(Number.isFinite) ? { x: r.box[0], y: r.box[1], w: r.box[2], h: r.box[3] } : null;
  const u = r.union && r.union.every(Number.isFinite) ? r.union : r.box;
  const ms = ((r.k1 - r.k0 + 1) * 1000) / 60, fade = r.lead === 'ren:opacity';
  return { box, areaOn: onScreen(u, vp), disp: Math.max(0, r.amp), movingMs: ms, movingOnMs: onScreen(u, vp) > 0 ? ms : 0, weight: r.amp > 0 || r.boxOnly ? 1 : 0, syFirst: r.sy0, moving: r.channels, opMax: fade ? Math.max(r.from ?? 1, r.to ?? 1) : 1, opStart: fade ? r.from ?? 1 : 1, opEnd: fade ? r.to ?? 1 : 1 };
}

/** Notice of one group: its members from one instance, largest first. */
export function noticeOfGroup(g, viewport, action) {
  const seen = new Set(), members = [];
  for (const r of [g.lead, ...g.runs]) { if (seen.has(r.id) || members.length >= 24) continue; seen.add(r.id); members.push(member(r, viewport)); }
  return noticeOf({ members, desc: g.lead.desc, viewport, action });
}

/** @returns {{score:number, why:string[], lead:object}} the class's score and its lead group */
export function rankClass({ kind, groups, n, viewport }) {
  const action = kind.startsWith('scroll') ? 'scroll' : kind === 'load' ? 'load' : 'hover';
  let best = null, bestN = null;
  for (const g of groups) { const nt = noticeOfGroup(g, viewport, action); if (!best || nt.score > bestN.score) { best = g; bestN = nt; } }
  if (!best) return { score: 0, why: [], lead: null };
  return { score: Math.round(rankScore(bestN.score, kind, groups.length, n) * 100) / 100, why: bestN.why.slice(0, 3), lead: best };
}

// ---------------------------------------------------------------- trust (6 Nov review: the top move was a carousel running off-screen)
/** A hover or click answer longer than this is likely something else running while the pointer was there (a ticker, a carousel). */
export const LONG_POINTER_MS = 2000;
/** Below this share of its box on the screen, a pointer move's answer mostly happens where nobody sees it. */
const ON_SCREEN_MIN = 0.25;
const SCREEN = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const POINTER = new Set(['touch', 'open']);
/** Weight by how the values are known: a declared value is what a person wants to copy, a recording is the least usable. */
const PROOF_WEIGHT = { declared: 1.2, fitted: 1, sampled: 0.7 };

/**
 * What the fit learnt that the first rank could not know: how long a pointer move runs, whether its answer is on the screen, how its
 * values are known. Returns a factor for the score, a doubt the card shows, and whether the move may be a highlight.
 * @param {{kind:string, time?:{ms?:number}, proof?:{source?:string}, instances?:{viewport:string, box:number[]|null}[], notMove?:string, consent?:string}} m
 * @returns {{factor:number, doubt:string|null, top:boolean, why:string|null}}
 */
export function trustOf(m) {
  let factor = PROOF_WEIGHT[m.proof?.source] ?? 1, doubt = null, top = true, why = null;
  const valueless = !m.proof || !['declared', 'fitted', 'sampled'].includes(m.proof.source);
  if (valueless) { top = false; why = 'no values were read'; }
  if (m.notMove || m.consent) top = false;
  // an instant change has nothing to watch, and code that replays only roughly is no showcase (11 Nov, U4 and U5: a 0 ms
  // "Background, opens" among one site's highlights); both stay in the list with their own words
  if (!valueless && (m.curve?.kind === 'steps' || m.time?.ms === 0)) { top = false; why = why ?? 'instant: nothing to watch'; }
  if (Number.isFinite(m.proof?.errorPct) && m.proof.errorPct > ROUGH_PCT) { top = false; why = why ?? 'reproduced roughly'; }
  if (POINTER.has(m.kind)) {
    const ms = m.time?.ms ?? m.time?.windowMs ?? 0;
    if (ms > LONG_POINTER_MS) { factor *= 0.25; top = false; why = 'long for a pointer move'; doubt = `It runs ${ms >= 10000 ? Math.round(ms / 1000) : Math.round(ms / 100) / 10} s, long for a ${m.kind === 'open' ? 'click' : 'hover'}: it may be something that runs on its own while the pointer was there.`; }
    const inst = (m.instances || []).find((i) => i.viewport === 'desktop' && i.box) || (m.instances || []).find((i) => i.box);
    if (inst) {
      const scr = SCREEN[inst.viewport] || SCREEN.desktop, b = inst.box, area = Math.max(1, b[2] * b[3]);
      const w = Math.min(b[0] + b[2], scr.width) - Math.max(b[0], 0), h = Math.min(b[1] + b[3], scr.height) - Math.max(b[1], 0);
      const share = w > 0 && h > 0 ? (w * h) / area : 0;
      if (share < ON_SCREEN_MIN) { factor *= 0.3; top = false; why = why ?? 'mostly off the screen'; doubt = doubt ?? `Most of what moves, ${Math.round((1 - share) * 100)} % of it, is off the screen, so the clip shows little of it.`; }
    }
  }
  return { factor, doubt, top, why };
}

/**
 * The rank once the fit is done: every move's score times its trust factor, the list sorted again, the highlights from the moves that
 * may be one. Changes `index` in place (moves, groups, top); a doubt is kept on the move for the card.
 */
export function rerank(index) {
  for (const m of index.moves) {
    const t = trustOf(m), base = m.rank?.base ?? m.rank?.score ?? 0;
    m.rank = { ...m.rank, base, score: Math.round(base * t.factor * 100) / 100, ...(t.why ? { lowered: t.why } : {}) };
    if (!t.why) delete m.rank.lowered;
    if (t.doubt) m.doubt = t.doubt; else delete m.doubt;
    m.rank.top = t.top;
  }
  index.moves.sort((a, b) => b.rank.score - a.rank.score || a.id.localeCompare(b.id));
  const order = new Map(index.moves.map((m, i) => [m.id, i]));
  for (const g of index.groups || []) g.moves.sort((a, b) => order.get(a) - order.get(b));
  index.top = topOf(index.moves.filter((m) => m.viewport !== 'phone' && m.rank.top !== false));
  return index;
}

/**
 * Best 6-12, at most 3 from one library group, at least 1 from each of Arriving, Scrolling, Hover and press, Between pages when they have any.
 * Fewer than 6 moves means no top section.
 * @param {Array<{id:string, group:string, rank:{score:number}}>} list
 * @returns {string[]} ids, best first
 */
export function topOf(list) {
  if (list.length < RANK.topMin) return [];
  const sorted = [...list].sort((a, b) => b.rank.score - a.rank.score || a.id.localeCompare(b.id));
  const best = sorted[0].rank.score, out = [], per = new Map();
  const add = (m) => { out.push(m); per.set(m.group, (per.get(m.group) || 0) + 1); };
  for (const g of RANK.topMustHave) { const m = sorted.find((x) => x.group === g); if (m) add(m); }
  for (const m of sorted) {
    if (out.length >= RANK.topMax) break;
    if (out.includes(m) || (per.get(m.group) || 0) >= RANK.topPerGroup) continue;
    if (out.length >= RANK.topMin && m.rank.score < STRONG_SHARE * best) break;
    add(m);
  }
  return out.sort((a, b) => b.rank.score - a.rank.score || a.id.localeCompare(b.id)).map((m) => m.id);
}
