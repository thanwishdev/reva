// Planted-defect and perturbation variants of a specimen spec, for the scorer's gates (M3 DONE WHEN: every planted defect is
// marked different beyond the self-band; the perturbation ladder is monotone). A variant is a deep copy of the spec with ONE
// edit and a new id; the page is re-emitted from the edited spec, so the variant is as runnable and seekable as the original.
import { emitHtml } from './emit.js';
import { easeKey } from './core.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
export function withEdit(spec, name, edit) {
  const s = clone(spec);
  s.id = `${spec.id}~${name}`;
  s.variantOf = { id: spec.id, edit: name };
  edit(s);
  return { spec: s, html: emitHtml(s) };
}

const SWAP = { smoothstep: 'easeInOutCubic', smootherstep: 'easeInOutQuart', linear: 'easeInOutQuad', easeinoutcubic: 'smoothstep', easeoutcubic: 'easeOutQuad', easeinoutquad: 'smoothstep' };
const smoothers = (s) => s.mechanisms.filter((m) => m.kind === 'scroll-driven' && m.smoothing.law !== 'none');

/** Another easing of the same family on every scroll map (an "easing swap"). */
export const easingSwap = (spec) => withEdit(spec, 'easing-swap', (s) => {
  for (const m of s.mechanisms) if (m.kind === 'scroll-driven') { m.map.shape = SWAP[easeKey(m.map.shape) || 'linear'] || 'smoothstep'; m.map.bezier = null; }
});
/** Per-frame EMA <-> dt-aware damp calibrated at the specimen's frame period: identical at that rate, different at another (60 vs 120 Hz). */
export const rateSwap = (spec) => withEdit(spec, 'rate-swap', (s) => {
  const dt = s.frameMs / 1000;
  for (const m of smoothers(s)) {
    const sm = m.smoothing;
    if (sm.law === 'ema') { sm.lambda = -Math.log(1 - sm.alpha) / dt; delete sm.alpha; sm.law = 'dtdamp'; }
    else if (sm.law === 'dtdamp') { sm.alpha = 1 - Math.exp(-sm.lambda * dt); delete sm.lambda; sm.law = 'ema'; }
  }
});
/** All motion removed: every channel is constant at its rest value. */
export const noMotion = (spec) => withEdit(spec, 'no-motion', (s) => {
  for (const m of s.mechanisms) for (const c of m.channels) { c.k0 += 0; c.k1 = 0; }
  s.pins = []; for (const m of s.mechanisms) if (m.kind === 'flip') m.D = 1e-6;
});
/** One mechanism skipped entirely (a mask-skip analogue: a whole driven element stays at rest). */
export const dropMechanism = (spec, i = 0) => withEdit(spec, `drop-${i}`, (s) => { s.mechanisms[i].channels.forEach((c) => { c.k1 = 0; }); });

/** Scale one numeric parameter of mechanism i by (1 + rel): the perturbation ladder (1 %, 10 %, ...). `path` e.g. 'smoothing.alpha', 'map.s1', 'dur'. */
export function perturb(spec, i, path, rel) {
  return withEdit(spec, `${path}${rel >= 0 ? '+' : ''}${(rel * 100).toFixed(1)}pct@m${i}`, (s) => {
    const keys = path.split('.'); let o = s.mechanisms[i];
    for (const k of keys.slice(0, -1)) o = o[k];
    const last = keys[keys.length - 1];
    if (typeof o[last] !== 'number') throw new Error(`perturb: ${path} of mechanism ${i} is not a number`);
    o[last] *= 1 + rel;
  });
}

export const PLANTED_DEFECTS = { easingSwap, rateSwap, noMotion, dropMechanism };
