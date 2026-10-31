// Pairing spec and protocol constants for the scorer fixture (own parameters, public-safe).
export const SPEC = { mechanisms: [
  { id: 'duration', arms: ['response'], pairs: ['#cs|ren:tx'] },     // CSS transition (duration ladder)
  { id: 'spring-k', arms: ['response'], pairs: ['#sp|ren:tx'] },     // closed-form spring (k ladder)
  { id: 'lag', arms: ['response'], pairs: ['#lg|ren:tx'] },          // delayed tween (lag ladder)
  { id: 'hold', arms: ['response'], pairs: ['#hd|ren:tx'] },         // keyframes with a hold (hold-fraction ladder)
  { id: 'alpha', arms: ['response'], pairs: ['#em|ren:tx'] },        // per-frame EMA on scroll (alpha ladder)
  { id: 'map', pairs: ['#mp|ren:sx'] },                              // pure scroll map (both arms)
  { id: 'mask', pairs: ['#mk|ren:clipPath', '#fd|ren:opacity'] },    // mask then fade (both arms)
] };
/** Ladder parameters and their reference values (page.js defaults). */
export const LADDER_KEYS = { D: 560, k: 170, L: 90, h: 0.35, alpha: 0.15 };
export const LADDER = [-20, -10, -5, -2, -1, 1, 2, 5, 10, 20];
/** Sampler phases in frames (G1-4 §8.3.1: 0..T/2 in 4 steps). */
export const PHASES = [0, 0.125, 0.25, 0.375, 0.5];
/** Planted defects and the mechanisms each must be caught in (W2G1-3 defect set). */
export const DEFECTS = {
  ease: ['map', 'duration'],
  hz60: ['alpha'],
  maskskip: ['mask'],
  none: ['duration', 'spring-k', 'lag', 'hold', 'alpha', 'map', 'mask'],
};
