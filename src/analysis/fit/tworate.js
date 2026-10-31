// Two-frame-rate class test and the stall test (design §7, G1-4 §8.4).

/** Smoothing law from α at two rates (per-frame ⇔ α invariant ±5 %; dt-aware ⇔ τ invariant ±5 %). */
export function smoothingLaw(a, b) {
  // a, b: {alpha, dtMs}
  const ratio = Math.max(a.dtMs, b.dtMs) / Math.min(a.dtMs, b.dtMs);
  if (!(ratio >= 1.5)) return { law: 'unknown', reason: `frame periods differ by ${ratio.toFixed(3)}× (< 1.5×): inside the ±5 % band`, probe: 'record the probe at a rate ≥ 1.5× apart (R2 ↔ R3)' };
  const tau = (x) => -x.dtMs / Math.log(1 - Math.min(0.999999, x.alpha));
  const ra = Math.abs(a.alpha / b.alpha - 1), rt = Math.abs(tau(a) / tau(b) - 1);
  const evidence = { alpha: [a.alpha, b.alpha], tau_ms: [tau(a), tau(b)], dtMs: [a.dtMs, b.dtMs], alphaRatioDev: ra, tauRatioDev: rt };
  if (ra <= 0.05 && rt > 0.05) return { law: 'per-frame', evidence };
  if (rt <= 0.05 && ra > 0.05) return { law: 'dt-aware', evidence };
  if (ra <= 0.05 && rt <= 0.05) return { law: 'unknown', reason: 'both invariant (rates too close)', evidence };
  return { law: 'time-based, non-LTI', evidence, reason: 'neither α nor τ invariant: report the step-response durations per rate' };
}

/**
 * Curve class from two takes (design §7): overlay on the ms grid (primary's time-based model at the probe's times)
 * and on the frame grid (probe sample j vs primary sample onset+j).
 * @param {object} a {T, y, onsetIdx, model(T)->y, dtMs}   primary
 * @param {object} b {T, y, onsetIdx, dtMs}               probe
 */
export function curveClass(a, b, explainBar) {
  const ratio = Math.max(a.dtMs, b.dtMs) / Math.min(a.dtMs, b.dtMs);
  if (!(ratio >= 1.5)) return { cls: 'unknown', reason: `frame periods differ by ${ratio.toFixed(3)}× (< 1.5×)` };
  // ms grid: the primary's model at the probe's times, over the primary's observed range, allowing a constant shift
  // (takes whose triggers are not on the common 100 ms grid start at different clock times)
  // compare inside the primary's moving range only: where a motion stops between two frames, the end is not observed
  const lo = a.T[Math.max(0, a.onsetIdx - 1)], hi = a.T[a.endIdx ?? a.T.length - 1];
  const dms = (sh) => { let s = 0, n = 0; const pm = a.model(b.T.map((t) => t + sh)); for (let i = 0; i < b.T.length; i++) { const t = b.T[i] + sh; if (t < lo || t > hi) continue; s += (pm[i] - b.y[i]) ** 2; n++; } return n >= 4 ? Math.sqrt(s / n) : Infinity; };
  const sh0 = (a.T[a.onsetIdx] - b.T[b.onsetIdx]); let x0 = sh0 - 2 * Math.max(a.dtMs, b.dtMs), x1 = sh0 + 2 * Math.max(a.dtMs, b.dtMs);
  for (let it = 0; it < 60; it++) { const m1 = x0 + (x1 - x0) / 3, m2 = x1 - (x1 - x0) / 3; if (dms(m1) <= dms(m2)) x1 = m2; else x0 = m1; }
  const shift = (x0 + x1) / 2; const Dms = Math.min(dms(shift), dms(0));
  // frame grid: probe sample j vs primary sample onset + j (onset alignment ±1 frame)
  let Dframe = Infinity;
  for (const off of [-1, 0, 1]) { let sf = 0, nf = 0; for (let j = 0; b.onsetIdx + j < b.y.length && a.onsetIdx + off + j < a.y.length; j++) { if (a.onsetIdx + off + j < 0) continue; sf += (b.y[b.onsetIdx + j] - a.y[a.onsetIdx + off + j]) ** 2; nf++; } if (nf >= 4) Dframe = Math.min(Dframe, Math.sqrt(sf / nf)); }
  const evidence = { D_ms: Dms, D_frame: Dframe, shiftMs: shift, explainBar };
  if (Dms <= explainBar && !(Dframe <= explainBar)) return { cls: 'time-based', evidence };
  if (Dframe <= explainBar && !(Dms <= explainBar)) return { cls: 'per-frame', evidence };
  if (Dms <= explainBar && Dframe <= explainBar) return { cls: 'unknown', reason: 'both overlays explain', evidence };
  return { cls: 'unknown', evidence, reason: 'neither overlay explains (fixed substep, dt cap or a non-LTI curve): integrator identification decides for springs' };
}

/** Stall test (R5, single take): per-frame EMA vs dt-damp likelihood on a take with stalls inside moving frames. */
export function stallLaw(ema, dtdamp, stallsInMotion) {
  if (!stallsInMotion) return null;
  if (!ema || !dtdamp) return null;
  const dL = ema.L - dtdamp.L;
  if (dL <= -10) return { law: 'per-frame', dL, evidence: 'stall' };
  if (dL >= 10) return { law: 'dt-aware', dL, evidence: 'stall' };
  return { law: 'unknown', dL, reason: 'stall present but ΔL < 10' };
}
