// M16d one-frame-delayed step: the output is a two-level function of the scroll position, one frame late.
import { parseParams } from '../core.js';

const P = parseParams('m16d', location.hash);
const el = document.querySelector('.b0');
let pending = 0;

function frame() {
  el.style.setProperty('--x', String(pending));
  pending = scrollY > P.threshold ? P.amp : 0;
  requestAnimationFrame(frame);
}
addEventListener('go', () => requestAnimationFrame(frame), { once: true });
