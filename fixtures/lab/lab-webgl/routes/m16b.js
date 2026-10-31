// M16b seeded jitter: one pseudo-random offset per page frame, no memory, no relation to any input.
import { parseParams, mulberry32 } from '../core.js';

const P = parseParams('m16b', location.hash);
const el = document.querySelector('.b0');
const rand = mulberry32(P.seed);

function frame() {
  el.style.setProperty('--x', String(P.base + P.amp * (2 * rand() - 1)));
  requestAnimationFrame(frame);
}
addEventListener('go', () => requestAnimationFrame(frame), { once: true });
