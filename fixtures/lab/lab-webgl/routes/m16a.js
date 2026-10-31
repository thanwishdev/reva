// M16a nothing moves. Values are written once when the page starts; scrolling does not touch the page.
import { parseParams } from '../core.js';

const P = parseParams('m16a', location.hash);
addEventListener('go', () => {
  const a = document.querySelector('.b0'), b = document.querySelector('.b1');
  a.style.setProperty('--x', String(P.x));
  a.style.setProperty('--y', String(P.y));
  a.style.setProperty('--o', String(P.opacity));
  b.style.setProperty('--x', String(P.x * 2));
}, { once: true });
