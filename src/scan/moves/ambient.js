// What counts as own motion, and what keeps moving at rest (DESIGN 2.3, 2.4 step 2).
import { MODEL } from './contract.js';
import { idleWindow } from './takeview.js';

/** A box-only run is own motion only when the element was touched: otherwise a parent carried it (2.3). */
export const isOwn = (r) => !r.boxOnly || r.wrote || r.born;
export const isNoise = (r) => !r.boxOnly && r.amp < MODEL.noisePx && !!r.lead && r.lead !== 'box';

/**
 * Ambient set A. A key is ambient when it KEEPS moving at rest: at least two runs in the idle window, or a run reaching its last 30
 * frames, or a run starting 2 s or more into it. One finite run that ends earlier is the tail of the load, not a loop.
 * @returns {{keys:Set<string>, runs:object[]}}
 */
export function ambientSet(P) {
  const w = idleWindow(P), keys = new Set(), runs = [];
  if (!w) return { keys, runs };
  const by = new Map();
  for (const r of w.view.runs) {
    if (!isOwn(r) || isNoise(r) || r.k1 < w.from + 6 || r.k0 > w.last) continue;
    (by.get(r.key) || by.set(r.key, []).get(r.key)).push(r);
  }
  for (const [k, l] of by) {
    const keeps = l.length >= MODEL.ambientMinRuns || l.some((r) => r.k1 >= w.last - MODEL.ambientTailFrames) || l.some((r) => r.k0 >= w.from + MODEL.ambientLateFrames)
      || l.some((r) => onTimer(r, w.view.runs));
    if (keeps) { keys.add(k); runs.push(...l); }
  }
  return { keys, runs };
}

/**
 * A timer longer than the idle window: one run of the key falls in the window, and over the whole take the same run (lead, about
 * its length) comes back on a steady beat, at least `ambientBeatRuns` times, through load, idle, scroll and sweep alike. Input
 * does not keep a beat across those phases; a clock does. Without it the idle rule above reads such a loop by phase luck: a marketing site's
 * carousel (every 324 frames, a 240-frame window) was ambient when the window opened at frame 426 and not when it opened at 546,
 * 2 s later, as the settle before it can take on a loaded machine (6 Nov, golden pit-02).
 */
export function onTimer(r0, all) {
  const len = (r) => r.k1 - r.k0, d0 = len(r0);
  const alike = all.filter((r) => r.key === r0.key && r.lead === r0.lead && isOwn(r) && !isNoise(r) && Math.abs(len(r) - d0) <= Math.max(3, MODEL.ambientBeatLen * d0))
    .sort((a, b) => a.k0 - b.k0);
  const i = alike.indexOf(r0);
  if (i < 0 || alike.length < MODEL.ambientBeatRuns) return false;
  // the beat through r0: the gap to its nearest alike neighbour, then every run on that beat, either side
  const gaps = [i > 0 ? r0.k0 - alike[i - 1].k0 : Infinity, i < alike.length - 1 ? alike[i + 1].k0 - r0.k0 : Infinity];
  const beat = Math.min(...gaps);
  if (!Number.isFinite(beat) || beat < MODEL.ambientBeatMin) return false;
  const tol = Math.max(3, MODEL.ambientBeatTol * beat);
  let n = 1;
  for (const dir of [-1, 1]) {
    let at = r0.k0;
    for (;;) {
      const next = alike.find((r) => Math.abs((r.k0 - at) - dir * beat) <= tol);
      if (!next) break;
      n++; at = next.k0;
    }
  }
  return n >= MODEL.ambientBeatRuns;
}
