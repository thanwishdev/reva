// Linked or triggered (DESIGN 2.4 step 9): a value tied to scroll comes back the same way it went. Compare the value against scrollY on
// the way down and the way up, at the best shift of up to 240 px: a smoothed page reads a little behind, and that is no trigger.
import { MODEL } from './contract.js';

const SHIFT_STEP = 24;

/** The down curve as a lookup: value at scrollY by linear interpolation. Points sorted by scrollY, equal ones averaged. */
function curveOf(points) {
  const by = new Map();
  for (const [sy, v] of points) { const e = by.get(sy) || by.set(sy, [0, 0]).get(sy); e[0] += v; e[1]++; }
  const p = [...by].map(([sy, [t, n]]) => [sy, t / n]).sort((a, b) => a[0] - b[0]);
  return (sy) => {
    if (!p.length || sy < p[0][0] || sy > p[p.length - 1][0]) return null;
    let lo = 0, hi = p.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m][0] <= sy) lo = m; else hi = m; }
    const [x0, y0] = p[lo], [x1, y1] = p[hi];
    return x1 === x0 ? y0 : y0 + ((y1 - y0) * (sy - x0)) / (x1 - x0);
  };
}

/**
 * @param {Array<[number,number]>} down  [scrollY, value] on the way down
 * @param {Array<[number,number]>} up    the same on the way up
 * @returns {'linked'|'triggered'} no way back at all means triggered: the value stayed where the first pass left it
 */
export function scrollKindOf(down, up) {
  if (!down?.length || !up?.length) return 'triggered';
  const vs = [...down, ...up].map((p) => p[1]), range = Math.max(...vs) - Math.min(...vs);
  if (!(range > 0)) return 'triggered';
  const at = curveOf(down), limit = MODEL.hysteresisShare;
  for (let shift = -MODEL.hysteresisShiftPx; shift <= MODEL.hysteresisShiftPx; shift += SHIFT_STEP) {
    const errs = [];
    for (const [sy, v] of up) { const d = at(sy + shift); if (d != null) errs.push(Math.abs(d - v)); }
    if (errs.length < Math.max(3, 0.5 * up.length)) continue;
    errs.sort((a, b) => a - b);
    if (errs[errs.length >> 1] / range <= limit) return 'linked';
  }
  return 'triggered';
}

/** A run that never rested at the bottom of the page holds both ways: the turn is where scrollY peaks. */
function bothWays(points) {
  let top = 0;
  points.forEach((p, i) => { if (p[0] > points[top][0]) top = i; });
  return [points.slice(0, top + 1), points.slice(top + 1)];
}

/** A group's verdict: its elements vote, up to 6 of them. */
export function moveScrollKind(runs, back) {
  const backBy = new Map();
  for (const r of back || []) if (r.points) (backBy.get(r.id) || backBy.set(r.id, []).get(r.id)).push(...r.points);
  const seen = new Set();
  let linked = 0, n = 0;
  for (const r of runs) {
    if (seen.has(r.id) || !r.points || n >= 6) continue;
    seen.add(r.id); n++;
    const down = [], up = [...(backBy.get(r.id) || [])];
    for (const q of runs) { if (q.id !== r.id || !q.points) continue; const [a, b] = bothWays(q.points); down.push(...a); up.push(...b); }
    if (scrollKindOf(down, up) === 'linked') linked++;
  }
  return n && linked * 2 >= n ? 'linked' : 'triggered';
}
