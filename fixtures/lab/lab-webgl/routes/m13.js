// M13 pointer follow. The follower chases the last pointer position once per page frame.
import { parseParams, quant, followStep } from '../core.js';

const P = parseParams('m13', location.hash);
const el = document.querySelector('.b0');
const g = { x: 0, y: 0 };
const s = { x: 0, y: 0 };
let last = 0;

addEventListener('pointermove', (e) => { g.x = e.clientX; g.y = e.clientY; });

function frame(now) {
  const dt = now - last; last = now;
  followStep(s, g, P, dt);
  el.style.setProperty('--x', String(quant(s.x, P.write)));
  el.style.setProperty('--y', String(quant(s.y, P.write)));
  requestAnimationFrame(frame);
}
addEventListener('go', () => { last = performance.now(); requestAnimationFrame(frame); }, { once: true });
