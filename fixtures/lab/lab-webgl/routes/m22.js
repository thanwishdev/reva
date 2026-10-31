// M22 two stages: a per-frame smoothed driver is written to a custom property; the element's own CSS transition
// follows it. The second stage is declared in the page, the first is code.
import { parseParams, quant, clamp, lerp1 } from '../core.js';

const P = parseParams('m22', location.hash);
const el = document.querySelector('.b0');
el.style.transition = `transform ${P.durMs}ms cubic-bezier(${P.ease.join(', ')})`;
let d = 0;

function frame() {
  const g = clamp(scrollY, 0, P.max) * P.gain;
  d = lerp1(d, g, P.alpha);
  if (Math.abs(g - d) < P.snap) d = g;
  el.style.setProperty('--d', String(quant(d, P.write)));
  requestAnimationFrame(frame);
}
addEventListener('go', () => requestAnimationFrame(frame), { once: true });
