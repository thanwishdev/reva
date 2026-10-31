// Behaviour-based fallback for library detection.
//
// When a bundle is hand-minified, tree-shaken to nothing recognisable, or the library is loaded from somewhere we did not
// scan, signatures cannot name it. Recorded behaviour can still say which FAMILY of mechanism is running. It cannot name
// the library: a lerp scroll, a damped spring or an expo.out tween is the same function whichever code produced it. So this
// module returns families with candidate libraries and says what it cannot separate (H6: unmeasured stays unknown).
//
// Input (all optional; every field comes from a recording, none from a regex over source):
//   scrollResponse  { samples:[{t, y}], inputEndT?, frameMs? }  scroll position after ONE driver-owned wheel impulse
//   animations      [{easing:string, ...}]                       declared easing strings from getAnimations()/getKeyframes()
//   fits            [{model:string, target?:'scroll'|string, params?, residual?}]  fitter output (M2)
//   webgl           { continuousDrawing:boolean }                canvas with a WebGL context drawn on every frame
import { FAMILIES } from './signatures.js';

const LENIS_DEFAULT_LERP = 0.1; // documented default of Lenis 1.x (`lerp` option)

/**
 * Fit the tail of a scroll impulse response with an exponential approach  r(t) = r0 * exp(-(t - t0) / tau).
 * Returns {model, ...}: 'exp-approach' | 'instant' | 'other' | 'insufficient'.
 */
export function classifyScrollResponse(resp) {
  const frameMs = resp?.frameMs ?? 1000 / 60;
  const all = (resp?.samples || []).filter(s => Number.isFinite(s.t) && Number.isFinite(s.y)).sort((a, b) => a.t - b.t);
  if (all.length < 8) return { model: 'insufficient', reason: `${all.length} samples (need >= 8)` };
  const t0 = resp.inputEndT ?? all[0].t;
  const tail = all.filter(s => s.t >= t0);
  if (tail.length < 8) return { model: 'insufficient', reason: `${tail.length} samples after the input ended (need >= 8)` };
  const yEnd = tail[tail.length - 1].y;
  const last = tail.slice(-3);
  if (Math.max(...last.map(s => s.y)) - Math.min(...last.map(s => s.y)) > 1) return { model: 'insufficient', reason: 'trace did not settle (last 3 samples differ by > 1 px)' };
  const r0 = yEnd - tail[0].y;
  if (!(Math.abs(r0) > 4)) return { model: 'insufficient', reason: 'less than 4 px of motion after the input ended' };
  const sign = Math.sign(r0);
  // remaining distance, only while it is well above the pixel/rounding floor and before the settle point
  const pts = [];
  for (const s of tail.slice(0, -1)) {
    const r = (yEnd - s.y) * sign;
    if (r > Math.abs(r0) * 0.02 && r > 1.5) pts.push({ x: s.t - t0, y: Math.log(r) });
  }
  const settleIdx = tail.findIndex(s => Math.abs(yEnd - s.y) <= 1);
  const settleMs = settleIdx < 0 ? null : tail[settleIdx].t - t0;
  if (settleMs !== null && settleMs <= 2 * frameMs) return { model: 'instant', settleMs, reason: 'position reached its final value within 2 frames of the input ending' };
  if (pts.length < 6) return { model: 'insufficient', reason: `${pts.length} usable decay points (need >= 6)` };
  const n = pts.length; const mx = pts.reduce((a, p) => a + p.x, 0) / n; const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; }
  const slope = sxy / sxx; const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  if (!(slope < 0)) return { model: 'other', r2, reason: 'remaining distance does not decay' };
  const tau = -1 / slope;
  const perFrame = 1 - Math.exp(-frameMs / tau);
  if (r2 < 0.98) return { model: 'other', r2, tauMs: tau, reason: `exponential fit R^2 ${r2.toFixed(3)} < 0.98` };
  return { model: 'exp-approach', r2, tauMs: tau, perFrameFactor: perFrame, frameMs, settleMs, points: n,
    matchesLenisDefaultLerp: Math.abs(perFrame - LENIS_DEFAULT_LERP) < 0.02 };
}

const FIT_FAMILY = [
  [/spring/i, 'js-spring'],
  [/ema|lerp|exp-?approach|dt-?damp/i, 'smooth-scroll', (f) => f.target === 'scroll'],
  [/expo|power|ease|bezier|tween|quad|cubic|quart|quint|sine|circ|back|elastic/i, 'js-tween'],
];

function linearStops(easing) {
  const m = /^linear\((.*)\)$/s.exec(String(easing).trim());
  return m ? m[1].split(',').length : 0;
}

/** Returns {families:[{family, status, provenance, evidence, candidates, can_not_separate}], notes:[]}. */
export function analyseBehaviour(b) {
  const out = []; const notes = [];
  if (!b || typeof b !== 'object') return { families: out, notes };
  const add = (family, evidence) => out.push({
    family, status: 'behaviour-hint', provenance: 'inferred', evidence,
    candidates: [...FAMILIES[family].candidates], can_not_separate: FAMILIES[family].can_not_separate,
  });

  if (b.scrollResponse) {
    const c = classifyScrollResponse(b.scrollResponse);
    if (c.model === 'exp-approach' && c.tauMs >= 40 && c.tauMs <= 1500) add('smooth-scroll', { kind: 'scroll-response', ...c });
    else notes.push({ kind: 'scroll-response', ...c, note: c.model === 'exp-approach' ? 'tau outside 40..1500 ms; not reported as smooth scroll' : 'no smooth-scroll family reported' });
  }
  const stops = (b.animations || []).map(a => ({ a, n: linearStops(a.easing) })).filter(x => x.n >= 8);
  if (stops.length) add('generated-easing', { kind: 'declared-easing', count: stops.length, maxStops: Math.max(...stops.map(x => x.n)) });
  const seen = new Set();
  for (const f of b.fits || []) {
    for (const [re, family, cond] of FIT_FAMILY) {
      if (re.test(f.model || '') && (!cond || cond(f))) {
        const key = `${family}|${f.model}|${f.target ?? ''}`;
        if (!seen.has(key)) { seen.add(key); add(family, { kind: 'fit', model: f.model, target: f.target ?? null, params: f.params ?? null, residual: f.residual ?? null }); }
        break;
      }
    }
  }
  if (b.webgl?.continuousDrawing === true) add('webgl-render-loop', { kind: 'webgl', continuousDrawing: true });
  // one entry per family: merge evidence so the report lists each family once
  const merged = [];
  for (const f of out) {
    const hit = merged.find(m => m.family === f.family);
    if (hit) hit.evidence = [].concat(hit.evidence, f.evidence); else merged.push(f);
  }
  return { families: merged, notes };
}
