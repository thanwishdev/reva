// REVA export — named-ease tables per library. Each emitted ease is evaluated from the same formula the library
// uses, so accuracy is measured against the fitted (Penner / CSS) function rather than assumed.
import { NAMED, CSS_BEZIERS } from '../analysis/fit/eases.js';
import { cubicBezier } from '../analysis/oracles.js';

export { NAMED, CSS_BEZIERS, cubicBezier };

/** easings.net cubic-bezier approximations of the Penner eases (CSS has no native Penner eases). */
export const EASINGS_NET_BEZIER = {
  easeInSine: [0.12, 0, 0.39, 0], easeOutSine: [0.61, 1, 0.88, 1], easeInOutSine: [0.37, 0, 0.63, 1],
  easeInQuad: [0.11, 0, 0.5, 0], easeOutQuad: [0.5, 1, 0.89, 1], easeInOutQuad: [0.45, 0, 0.55, 1],
  easeInCubic: [0.32, 0, 0.67, 0], easeOutCubic: [0.33, 1, 0.68, 1], easeInOutCubic: [0.65, 0, 0.35, 1],
  easeInQuart: [0.5, 0, 0.75, 0], easeOutQuart: [0.25, 1, 0.5, 1], easeInOutQuart: [0.76, 0, 0.24, 1],
  easeInQuint: [0.64, 0, 0.78, 0], easeOutQuint: [0.22, 1, 0.36, 1], easeInOutQuint: [0.83, 0, 0.17, 1],
  easeInExpo: [0.7, 0, 0.84, 0], easeOutExpo: [0.16, 1, 0.3, 1], easeInOutExpo: [0.87, 0, 0.13, 1],
  easeInCirc: [0.55, 0, 1, 0.45], easeOutCirc: [0, 0.55, 0.45, 1], easeInOutCirc: [0.85, 0, 0.15, 1],
  easeInBack: [0.36, 0, 0.66, -0.56], easeOutBack: [0.34, 1.56, 0.64, 1], easeInOutBack: [0.68, -0.6, 0.32, 1.6],
};

// GSAP 3 core eases: each family defines easeIn; out = 1 − in(1 − p); inOut = p < .5 ? in(2p)/2 : 1 − in(2(1 − p))/2.
const GSAP_IN = {
  power1: (p) => p ** 2, power2: (p) => p ** 3, power3: (p) => p ** 4, power4: (p) => p ** 5,
  sine: (p) => (p === 1 ? 1 : 1 - Math.cos((p * Math.PI) / 2)),
  expo: (p) => (p ? 2 ** (10 * (p - 1)) : 0),
  circ: (p) => -(Math.sqrt(1 - p * p) - 1),
  back: (p) => p * p * (2.70158 * p - 1.70158),
};
export function gsapEase(name) {
  if (name === 'none') return (p) => p;
  const [fam, dir] = name.split('.'); const f = GSAP_IN[fam]; if (!f) return null;
  if (dir === 'in') return f;
  if (dir === 'out') return (p) => 1 - f(1 - p);
  return (p) => (p < 0.5 ? f(p * 2) / 2 : 1 - f((1 - p) * 2) / 2);
}
const GSAP_FAM = { quad: 'power1', cubic: 'power2', quart: 'power3', quint: 'power4', sine: 'sine', expo: 'expo', circ: 'circ', back: 'back' };
const GSAP_DIR = { in: 'in', out: 'out', inOut: 'inOut' };
/** Penner name (easeOutCubic) -> GSAP name (power2.out), or null. */
export function gsapNameFor(name) {
  const n = NAMED[name]; if (!n || n.kind !== 'penner') return null;
  return `${GSAP_FAM[n.family]}.${GSAP_DIR[n.dir]}`;
}

// Motion accepts an easing function; the emitted source is evaluated (new Function) for the accuracy check.
const C1 = 1.70158, C2 = C1 * 1.525, C3 = C1 + 1;
const PENNER_SRC = {
  sine: { in: '1 - Math.cos((p * Math.PI) / 2)', out: 'Math.sin((p * Math.PI) / 2)', inOut: '-(Math.cos(Math.PI * p) - 1) / 2' },
  expo: { in: 'p === 0 ? 0 : 2 ** (10 * p - 10)', out: 'p === 1 ? 1 : 1 - 2 ** (-10 * p)', inOut: 'p === 0 ? 0 : p === 1 ? 1 : p < 0.5 ? 2 ** (20 * p - 10) / 2 : (2 - 2 ** (-20 * p + 10)) / 2' },
  circ: { in: '1 - Math.sqrt(1 - p * p)', out: 'Math.sqrt(1 - (p - 1) ** 2)', inOut: 'p < 0.5 ? (1 - Math.sqrt(1 - (2 * p) ** 2)) / 2 : (Math.sqrt(1 - (-2 * p + 2) ** 2) + 1) / 2' },
  back: { in: `${C3} * p ** 3 - ${C1} * p * p`, out: `1 + ${C3} * (p - 1) ** 3 + ${C1} * (p - 1) ** 2`,
    inOut: `p < 0.5 ? ((2 * p) ** 2 * (${C2 + 1} * 2 * p - ${C2})) / 2 : ((2 * p - 2) ** 2 * (${C2 + 1} * (p * 2 - 2) + ${C2}) + 2) / 2` },
};
const POW_N = { quad: 2, cubic: 3, quart: 4, quint: 5 };
/** JS source of a Penner ease as an arrow function `(p) => …`, or null. */
export function pennerSource(name) {
  const n = NAMED[name]; if (!n || n.kind !== 'penner') return null;
  const k = POW_N[n.family];
  if (k) return `(p) => ${n.dir === 'in' ? `p ** ${k}` : n.dir === 'out' ? `1 - (1 - p) ** ${k}` : `p < 0.5 ? ${2 ** (k - 1)} * p ** ${k} : 1 - (-2 * p + 2) ** ${k} / 2`}`;
  return `(p) => ${PENNER_SRC[n.family][n.dir]}`;
}
export const evalSource = (src) => new Function(`return (${src});`)();

/** Scroll-map shape name (from the fitter) -> {fn, name} where name is a NAMED key or a special shape. */
export function shapeFn(shape) {
  if (!shape || shape === 'linear') return { fn: (u) => u, kind: 'linear' };
  if (shape === 'smoothstep') return { fn: (u) => u * u * (3 - 2 * u), kind: 'smoothstep', bezier: [1 / 3, 0, 2 / 3, 1] };   // 3u²−2u³ is exactly this bezier
  if (shape === 'smootherstep') return { fn: (u) => u * u * u * (u * (u * 6 - 15) + 10), kind: 'smootherstep' };
  if (NAMED[shape]) return { fn: NAMED[shape].fn, kind: 'named', name: shape };
  return null;
}
