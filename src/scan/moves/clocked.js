// Control sets and timers (DESIGN 2.4 steps 3 and 4). A control window is a stretch of a test where nothing was touched, so what starts
// in it was not caused by the test. Both rules apply to touch windows only: an open or a close is allowed to run past a timer.
import { framesOf, MODEL, selectorGroup } from './contract.js';

/** Keys already moving in each test's own control window, per test. Per test, not per take: a leave that bleeds into the next test's window must not poison the element for the whole take. */
export function controlSets(runs, wins) {
  const out = new Map();
  for (const w of wins) if (w.part === 'control') out.set(w.id, new Set(runs.filter((r) => r.k0 < w.to && r.k1 >= w.from).map((r) => r.key)));
  return out;
}

/** A law group, coarse: lead, families, length in thirds of a frame count, tag. */
export const clockKey = (r) => `${r.lead}|${r.fams.join('+')}|${Math.round((r.k1 - r.k0) / 3)}|${String(r.desc).split('.')[0]}`;

/** Law groups with a run that STARTS inside any control window of the take. */
export function onsetClocked(runs, wins, own) {
  const out = new Set();
  for (const w of wins) if (w.part === 'control') for (const r of runs) if (own(r) && r.k0 >= w.from && r.k0 < w.to) out.add(clockKey(r));
  return out;
}

/** A reaction answers at a fixed delay, a timer does not: selector groups seen in 3+ tests whose lag spreads over 300 ms. */
export function lagClocked(reactions) {
  const lags = new Map();
  for (const m of reactions) {
    if (m.kind !== 'touch') continue;
    const by = new Map();
    for (const r of m.runs) { const g = selectorGroup(r.key), c = by.get(g); if (c == null || r.rel < c) by.set(g, r.rel); }
    for (const [k, v] of by) (lags.get(k) || lags.set(k, []).get(k)).push(v);
  }
  const out = new Set(), spread = framesOf(MODEL.lagSpreadMs);
  for (const [k, a] of lags) { if (a.length < MODEL.lagSpreadTests) continue; a.sort((x, y) => x - y); if (a[a.length - 1] - a[0] > spread) out.add(k); }
  return out;
}
