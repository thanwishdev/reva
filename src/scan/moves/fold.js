// Fold moves into move classes, one tile each (DESIGN 2.4 steps 11, 12). A fold never deletes: every instance stays with its page,
// viewport, take and time, and the rows stay on disk.
import { MODEL, selectorGroup } from './contract.js';

const overlap = (a, b) => { let n = 0; for (const k of a) if (b.has(k)) n++; return n; };
/** The share is of the LARGER set: against the smaller one a 6-key nav change vanished into a 180-key scroll band. */
export const keysOverlap = (a, b) => overlap(a, b) >= MODEL.foldOverlap * Math.max(a.size, b.size);

/**
 * @param {object[]} moves  summarised moves of one viewport, in page order
 * @returns {object[]} classes: { vp, kind, sig, keys, m, how }
 */
export function foldViewport(moves) {
  const reps = [];
  for (const m of moves) {
    const sig = `${m.kind}|${m.lcTop.slice().sort((a, b) => a - b).join(',')}`;
    const hit = reps.find((q) => q.kind === m.kind && (q.sig === sig || keysOverlap(m.keys, q.keys)));
    if (hit) { hit.m.push(m); hit.how[hit.sig === sig ? 'law' : 'keys']++; continue; }
    reps.push({ vp: m.vp, kind: m.kind, sig, keys: new Set(m.keys), m: [m], how: { law: 0, keys: 0 } });
  }
  return reps;
}

/** A phone class meets the desktop class of the same kind with the most keys in common, at the fold's overlap. Selector groups, since members differ in number. */
export function pairViewports(desktop, phone) {
  const pairs = new Map(), taken = new Set();
  const groups = (c) => new Set([...c.keys].map(selectorGroup));
  const dg = desktop.map((c) => ({ c, g: groups(c) }));
  for (const p of phone) {
    const pg = groups(p);
    let best = null, bestN = 0;
    for (const { c, g } of dg) { if (c.kind !== p.kind || taken.has(c)) continue; const n = overlap(pg, g); if (n > bestN && keysOverlap(pg, g)) { best = c; bestN = n; } }
    if (best) { pairs.set(best, p); taken.add(best); }
  }
  return pairs;
}
