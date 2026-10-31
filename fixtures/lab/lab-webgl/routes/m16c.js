// M16c constant-velocity chase: the value moves toward the scroll-derived target at a fixed speed and stops there.
import { parseParams, clamp, slewStep } from '../core.js';

const P = parseParams('m16c', location.hash);
const el = document.querySelector('.b0');
let x = 0, last = 0;

function frame(now) {
  const dt = now - last; last = now;
  const g = clamp(scrollY, 0, P.max) * P.gain;
  x = slewStep(x, g, P.speed, dt);
  el.style.setProperty('--x', String(x));
  requestAnimationFrame(frame);
}
addEventListener('go', () => { last = performance.now(); requestAnimationFrame(frame); }, { once: true });
