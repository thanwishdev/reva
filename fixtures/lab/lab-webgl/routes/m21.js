// M21 restarted tween on scroll: every change of the scroll-derived target starts a new tween from the current value.
import { parseParams, quant, clamp, expoOut, tweenAt } from '../core.js';

const P = parseParams('m21', location.hash);
const el = document.querySelector('.b0');
const tw = { from: 0, to: 0, t0: 0, dur: P.durMs, ease: expoOut };
let v = 0;

addEventListener('scroll', () => {
  const to = clamp(scrollY, 0, P.max) * P.gain;
  if (to === tw.to) return;
  const now = performance.now();
  tw.from = tweenAt(tw, now); tw.to = to; tw.t0 = now;
}, { passive: true });

function frame(now) {
  v = tweenAt(tw, now);
  el.style.setProperty('--v', String(quant(v, P.write)));
  requestAnimationFrame(frame);
}
addEventListener('go', () => { tw.t0 = performance.now(); requestAnimationFrame(frame); }, { once: true });
