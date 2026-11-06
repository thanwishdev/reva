// Rank and the top section (DESIGN 2.7). A first setting [J]: the owner's eye is the test, so it stays one small file.
import { noticeOf } from '../../look/rank.js';
import { RANK, rankScore } from './contract.js';

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
