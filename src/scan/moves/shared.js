// Shared followers (DESIGN 2.4 step 7): keys that show up in a large share of a page's tests answer the pointer or a timer, not the thing
// tested. They leave every reaction set, then get sorted by what they do. Calling them all a cursor named a carousel "cursor" on a large marketing site.
import { MODEL, selectorGroup } from './contract.js';

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const CELL_PX = 8, MIN_PLACES = 3, CLOSE_PX = 24, MIN_OUTSIDE = 2;

/** Keys in at least max(4, 25 % of the windows) of a page's touch and open windows. */
export function sharedKeys(windows) {
  const freq = new Map();
  for (const m of windows) for (const k of new Set(m.runs.map((r) => r.key))) freq.set(k, (freq.get(k) || 0) + 1);
  const lim = Math.max(MODEL.sharedMinWindows, MODEL.sharedShare * windows.length);
  return new Set([...freq].filter(([, c]) => c >= lim).map(([k]) => k));
}

/** The last pointer position at or before K. */
export function pointerAt(view, K) {
  const list = view.ptr ??= view.input.filter((e) => e.kind === 'mouseMoved' && Number.isFinite(e.k)).sort((a, b) => a.k - b.k);
  let lo = 0, hi = list.length - 1, hit = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].k <= K) { hit = list[mid]; lo = mid + 1; } else hi = mid - 1; }
  return hit;
}

/** Where a key settled against the pointer, over its runs. */
function pointerRead(runs) {
  const places = new Set(), ds = [];
  for (const r of runs) {
    if (!r.boxEnd || !r.boxEnd.every(Number.isFinite)) continue;
    const p = pointerAt(r.view, r.k1);
    if (!p) continue;
    const x = r.boxEnd[0] + r.boxEnd[2] / 2, y = r.boxEnd[1] + r.boxEnd[3] / 2;
    places.add(`${Math.round(x / CELL_PX)},${Math.round(y / CELL_PX)}`);
    ds.push(Math.hypot(x - p.x, y - p.y));
  }
  return { places: places.size, near: median(ds) };
}

/**
 * Keys that follow the pointer. The element must have moved between tests, and its box must settle within 120 px of the pointer: real
 * cursors sit 0-71 px away, a carousel thousands. That alone also passes a tooltip placed beside the thing hovered, so the cursor itself
 * must move by its own channels. Parts of it that only scale or fade ride on it, and pass once one such element exists.
 * @param {Map<string,object[]>} byKey  each key's runs, each run with `view`
 * @returns {Set<string>}
 */
export function pointerFollowers(byKey) {
  const reads = [...byKey].map(([k, rs]) => ({ k, rs, ...pointerRead(rs) })).filter((x) => x.near != null && x.near <= MODEL.cursorPx);
  const isLead = (x) => (x.places >= MIN_PLACES || (x.places >= 2 && x.near <= CLOSE_PX)) && x.rs.filter((r) => r.fams.includes('move')).length * 2 >= x.rs.length;
  if (!reads.some(isLead)) return new Set();
  return new Set(reads.filter((x) => x.places >= MIN_PLACES || isLead(x)).map((x) => x.k));
}

/**
 * One run of the pointer sweep travels with the pointer: while the pointer crossed at least `cursorPx` on an axis, the element's centre
 * covered at least half of that crossing on that axis. Its rows hold only the first box, the last and their union, so the union, less
 * the element's own size, is the path of its centre. On the stored sites cursors and their parts cover 0.67-1.15 of the sweep, while a
 * carousel crossing the screen covers 0.02-0.06 of it across, and a hover that wakes as the pointer passes covers 0-0.22.
 * The pointer is near a hover as it wakes, so a distance test alone named six hovers of a large marketing site "follows the pointer".
 */
export function sweepFollows(r) {
  if (!r.view || !r.union || !r.boxEnd || ![...r.union, ...r.boxEnd].every(Number.isFinite)) return false;
  const p0 = pointerAt(r.view, r.k0), ps = r.view.ptr.filter((e) => e.k >= r.k0 && e.k <= r.k1);
  if (p0) ps.push(p0);
  if (ps.length < 2) return false;
  const span = (f) => Math.max(...ps.map(f)) - Math.min(...ps.map(f));
  const axes = [[span((p) => p.x), r.union[2] - r.boxEnd[2]], [span((p) => p.y), r.union[3] - r.boxEnd[3]]].filter(([p]) => p >= MODEL.cursorPx);
  return axes.length > 0 && axes.every(([p, c]) => c >= SWEEP_COVER * p);
}
const SWEEP_COVER = 0.5;

/** Runs of `keys` outside any test: they start in a control window or between tests. A leave that bleeds into a control window starts earlier, so it does not count. */
export function outsideTests(keys, starts) {
  const out = new Map();
  for (const r of starts) if (keys.has(r.key)) out.set(r.key, (out.get(r.key) || 0) + 1);
  return new Set([...out].filter(([, n]) => n >= MIN_OUTSIDE).map(([k]) => k));
}

/** Followers of one sort, by selector group and families: one move each, the tests it answered as targets. */
export function groupFollowers(runs) {
  const by = new Map();
  for (const r of runs) { const g = `${selectorGroup(r.key).slice(0, 60)}|${r.fams.join('+')}`; (by.get(g) || by.set(g, []).get(g)).push(r); }
  return [...by];
}
