// Vendored from understudy 0.3.0 (@amabush/understudy, https://github.com/Amir-Abushanab/understudy),
// src/analyze/cluster.ts (sha256 cdacf6f5ac12dca39af8f47c5cabafab17e45a1ee68771b537574d8e8ce180bc).
// MIT License, Copyright (c) 2026 understudy contributors — full text in ./LICENSE.
// Port: TypeScript types removed; logic unchanged. REVA uses it to group onsets into stagger candidates;
// the direction/order decision (which understudy does not make) is in ../../stagger.js.
/**
 * Stagger recovery. Cluster animation start timestamps, and within a cluster ask whether the inter-arrival deltas
 * are consistent. Two guards: a floor (sub-frame deltas collapse into one beat) and a variance gate.
 */

const DEFAULTS = { floorMs: 16, maxGroupGapMs: 600, cvThreshold: 0.35 };

/**
 * @param {{id:string, startT:number}[]} events
 * @param {{floorMs?:number, maxGroupGapMs?:number, cvThreshold?:number}} [options]
 */
export function recoverStagger(events, options = {}) {
  const { floorMs, maxGroupGapMs, cvThreshold } = { ...DEFAULTS, ...options };
  if (events.length < 2) return [];

  const sorted = [...events].sort((a, b) => a.startT - b.startT);

  // Partition into groups: a gap larger than maxGroupGap starts a new group.
  const groups = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].startT - sorted[i - 1].startT;
    if (gap > maxGroupGapMs) {
      groups.push(current);
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  groups.push(current);

  const clusters = [];
  for (const group of groups) {
    if (group.length < 2) continue;

    // Collapse near-simultaneous starts (delta < floor) into single beats.
    const beatTimes = [];
    let beatAccum = [group[0].startT];
    for (let i = 1; i < group.length; i++) {
      const t = group[i].startT;
      const beatMean = beatAccum.reduce((a, b) => a + b, 0) / beatAccum.length;
      if (t - beatMean < floorMs) {
        beatAccum.push(t);
      } else {
        beatTimes.push(beatAccum.reduce((a, b) => a + b, 0) / beatAccum.length);
        beatAccum = [t];
      }
    }
    beatTimes.push(beatAccum.reduce((a, b) => a + b, 0) / beatAccum.length);

    const deltas = [];
    for (let i = 1; i < beatTimes.length; i++) deltas.push(beatTimes[i] - beatTimes[i - 1]);

    if (deltas.length === 0) continue; // all one beat: parallel, not staggered

    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : Number.POSITIVE_INFINITY;

    clusters.push({
      startT: group[0].startT,
      size: group.length,
      beats: beatTimes.length,
      intervalMs: round(mean, 1),
      cv: round(cv, 3),
      deltas: deltas.map((d) => round(d, 1)),
      memberIds: group.map((e) => e.id),
      beatTimes: beatTimes.map((t) => round(t, 1)),
      confident: deltas.length >= 2 && cv < cvThreshold && mean >= floorMs,
    });
  }

  return clusters;
}

function round(v, places) {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
