// Vendored from understudy 0.3.0 (@amabush/understudy, https://github.com/Amir-Abushanab/understudy),
// src/analyze/spring.ts (sha256 d23281c490d0a657ff400ed5f18ae7f53b1f6f2ae2f801c7d86a89af68de44a4).
// MIT License, Copyright (c) 2026 understudy contributors — full text in ./LICENSE.
// Port: TypeScript types removed; logic unchanged.
// REVA uses only `springStepResponse` and the overshoot-based (ω, ζ) initial guess as one multi-start seed.
// It does NOT use `detectsOvershoot`/`fitSpring` as a class gate: the 5 % overshoot gate mislabels a back-out bezier
// as a spring (S3 §2.4); class decisions are made by likelihood in ../../select.js.
import { nelderMead } from './optimize.js';

const OVERSHOOT_THRESHOLD = 0.05; // 5% past target before we call it a spring

/** Normalized unit-step response of an underdamped second-order system (0 -> 1), `t` in seconds. */
export function springStepResponse(omega, zeta, t) {
  if (t <= 0) return 0;
  const z = Math.min(0.999, Math.max(0.001, zeta));
  const omegaD = omega * Math.sqrt(1 - z * z);
  const decay = Math.exp(-z * omega * t);
  return 1 - decay * (Math.cos(omegaD * t) + ((z * omega) / omegaD) * Math.sin(omegaD * t));
}

/** True if the progress samples {t, p} pass their target and then settle back near it. */
export function detectsOvershoot(samples) {
  if (samples.length < 4) return false;
  const maxP = Math.max(...samples.map((s) => s.p));
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const tail = sorted.slice(-3);
  const settles = tail.every((s) => Math.abs(s.p - 1) < 0.12);
  return maxP > 1 + OVERSHOOT_THRESHOLD && settles;
}

/** Data-driven (ω, ζ) initial guess from overshoot and time of first peak (understudy's seed). */
export function springSeed(samples) {
  const seconds = [...samples].sort((a, b) => a.t - b.t).map((s) => ({ t: s.t / 1000, p: s.p }));
  const maxP = Math.max(...seconds.map((s) => s.p));
  const overshoot = maxP - 1;
  const lnOS = Math.log(Math.max(overshoot, 1e-3));
  const zeta0 = Math.min(0.95, Math.max(0.05, -lnOS / Math.sqrt(Math.PI * Math.PI + lnOS * lnOS)));
  const peak = seconds.reduce((best, s) => (s.p > best.p ? s : best), seconds[0]);
  const tPeak = peak.t > 0 ? peak.t : 0.1;
  const omegaD0 = Math.PI / tPeak;
  const omega0 = omegaD0 / Math.sqrt(1 - zeta0 * zeta0);
  return { omega0, zeta0, overshoot };
}

/** understudy's spring fit (kept for reference/tests; not used for class decisions). */
export function fitSpring(samples) {
  if (!detectsOvershoot(samples)) return null;
  const seconds = [...samples].sort((a, b) => a.t - b.t).map((s) => ({ t: s.t / 1000, p: s.p }));
  const { omega0, zeta0, overshoot } = springSeed(samples);
  const objective = (params) => {
    const [omega, zeta] = params;
    if (omega <= 0 || zeta <= 0 || zeta >= 1) return Number.POSITIVE_INFINITY;
    let sse = 0;
    for (const s of seconds) {
      const err = springStepResponse(omega, zeta, s.t) - s.p;
      sse += err * err;
    }
    return sse;
  };
  const result = nelderMead(objective, [omega0, zeta0], { initialStep: 0.2, maxIterations: 800 });
  const [omega, zeta] = result.x;
  const mass = 1;
  const stiffness = omega * omega * mass;
  const damping = 2 * zeta * omega * mass;
  const residual = Math.sqrt(result.fx / seconds.length);
  return {
    stiffness: round(stiffness, 1), damping: round(damping, 1), mass, naturalFrequency: round(omega, 3),
    dampingRatio: round(zeta, 3), overshoot: round(overshoot, 3), residual: round(residual, 4),
  };
}

function round(v, places) {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
