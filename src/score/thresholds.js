// Provisional perceptual units for layer 2 of the score (S3 §10.3-10.4, W2G2-3 §2.2 and §6).
//
// Until the owner runs the JND kit (skipped for now), layer 2 uses W2G2-3's two MODEL observers, built from literature
// anchors. They are inference, not data: every number here is provenance `inferred`, confidence low (S3 §10.4).
//   strict (velocity-sensitive) observer: a change is seen when any cue reaches 1:
//     |Δt50| / DL(t50), |Δt90| / DL(t90)  (DL = Rammsayer duration discrimination, log-log fit),
//     |Δ peak velocity| / 7 %,  lag / 55 ms (Deber indirect drag).
//   lenient (timing-only) observer: the same without the velocity and latency cues.
// Verdict rule (S3 §10.4): pass below half the strict JND; fail above the lenient JND; needs-owner in between.
// The pooled score is in strict-JND units (see pool.js). Rows without a literature anchor are inferred from the
// §10.4 table and say so.

/** Rammsayer et al. 2015 (SYN §5.6): DL 30.1 ms at 50 ms, 206.4 ms at 1000 ms; log-log fit between the anchors. */
export const RAMMSAYER = { t1: 50, dl1: 30.1, t2: 1000, dl2: 206.4 };
const SLOPE = Math.log(RAMMSAYER.dl2 / RAMMSAYER.dl1) / Math.log(RAMMSAYER.t2 / RAMMSAYER.t1);

/**
 * Duration discrimination threshold (ms) for an interval of t ms. Not extrapolated outside the measured 50-1000 ms
 * range (below 50 ms the 50 ms value is used; above 1000 ms the 1000 ms value): no data says how DL behaves there.
 */
export function durationDL(t) {
  const tc = Math.min(RAMMSAYER.t2, Math.max(RAMMSAYER.t1, Math.abs(t)));
  return RAMMSAYER.dl1 * Math.pow(tc / RAMMSAYER.t1, SLOPE);
}

/** Lag JND by input kind (Deber et al. CHI 2015; W2G2-3 §6 lag rows). `time` = a programmatic trigger: onset timing. */
export const LAG = {
  scroll: { jnd: 55, pass: 30, fail: 88, source: 'Deber indirect drag 55 ms; W2G2-3 §6 trackpad row (pass 30, fail 88)' },
  wheel: { jnd: 55, pass: 30, fail: 88, source: 'as scroll' },
  pointer: { jnd: 55, pass: 30, fail: 88, source: 'Deber indirect drag (mouse/trackpad)' },
  touch: { jnd: 11, pass: 5, fail: 11, source: 'Deber direct drag 11 ms; W2G2-3 §6 touch row' },
  time: { jnd: null, source: 'no input to lag behind: onset timing, judged with the duration DL of the lag itself' },
};

export const VELOCITY = { jnd: 0.07, source: 'speed Weber fraction (W2G2-3 strict observer uses 7 %)' };
/** Scroll range position (W2G2-3 §6): pass below 0.027-0.032 vh, fail above 0.106-0.149 vh. Strict end for pass, lenient end for fail. */
export const RANGE_VH = { jnd: 0.054, pass: 0.027, fail: 0.149, source: 'W2G2-3 §6 scroll range row (strict JND = 2 x pass 0.027 vh)' };
/** Curve shape, max |Δ progress| (W2G2-3 §6 entrance curve row: pass 0.011, fail 0.174). Used for map shape and amplitude. */
export const CURVE = { jnd: 0.022, pass: 0.011, fail: 0.174, source: 'W2G2-3 §6 entrance-curve row (strict JND = 2 x pass 0.011), inferred for map shape' };

export const PROVISIONAL = {
  provenance: 'inferred', confidence: 'low',
  note: 'model observers from literature anchors (W2G2-3), not owner data; layer 2 is provisional until the JND kit runs',
};

/**
 * Strict-JND unit for a cue difference, and the lenient fail limit (null = the lenient observer ignores this cue).
 * @param {string} cue  lag | t50 | t90 | peakVel | rangeShiftVh | mapShape | amplitude
 * @param {object} ctx  {kind, srcValue} — srcValue is the source's own cue value (ms for timing cues)
 */
export function unitFor(cue, ctx = {}) {
  switch (cue) {
    case 'lag': {
      const L = LAG[ctx.kind] || LAG.scroll;
      if (L.jnd == null) { const dl = durationDL(ctx.srcValue ?? 0); return { jnd: dl, pass: dl / 2, fail: dl, source: 'Rammsayer DL of the onset time (programmatic trigger)' }; }
      return { jnd: L.jnd, pass: L.pass, fail: L.fail, source: L.source };
    }
    case 't50': case 't90': {
      const dl = durationDL(ctx.srcValue ?? 0);
      return { jnd: dl, pass: dl / 2, fail: dl, source: `Rammsayer DL at ${cue} = ${(ctx.srcValue ?? 0).toFixed(1)} ms` };
    }
    case 'peakVel': return { jnd: VELOCITY.jnd, pass: VELOCITY.jnd / 2, fail: null, source: VELOCITY.source };
    case 'rangeShiftVh': return { jnd: RANGE_VH.jnd, pass: RANGE_VH.pass, fail: RANGE_VH.fail, source: RANGE_VH.source };
    case 'mapShape': case 'amplitude': return { jnd: CURVE.jnd, pass: CURVE.pass, fail: CURVE.fail, source: CURVE.source };
    default: return null;   // layer-1-only cue (t10, t99, overshoot, crossings, nrmse, maxAbs): no perceptual anchor
  }
}
