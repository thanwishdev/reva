// M20 four writers on one page: scroll-smoothed, timer-retargeted, a 1 Hz tick, and a tween started by an observer.
import { parseParams, quant, clamp, lerp1, springI1, easeOutQuart, tweenAt } from '../core.js';

const P = parseParams('m20', location.hash);
const $ = (s) => document.querySelector(s);
const e0 = $('.e0'), e1 = $('.e1'), e2 = $('.e2'), e3 = $('.e3');

const s0 = { x: 0, v: 0 };                 // timer-retargeted spring state
let q = 0, g1 = 0, tick = 0, last = 0;
const tw = { from: 0, to: 0, t0: 0, dur: P.tweenMs, ease: easeOutQuart };
let inView = false;

new IntersectionObserver((list) => {
  for (const en of list) {
    if (en.isIntersecting === inView) continue;
    inView = en.isIntersecting;
    const now = performance.now();
    tw.from = tweenAt(tw, now); tw.to = inView ? P.tweenAmp : 0; tw.t0 = now;
  }
}).observe($('.s0'));

function frame(now) {
  const dt = now - last; last = now;
  const g0 = clamp(scrollY, 0, P.scrollMax) * P.scrollGain;
  q = lerp1(q, g0, P.alpha);
  if (Math.abs(g0 - q) < P.snap) q = g0;
  springI1(s0, g1, P.k, P.c, dt, P.hMs);
  if (Math.abs(s0.v) < 0.01 && Math.abs(s0.x - g1) < 0.001) { s0.x = g1; s0.v = 0; }
  e0.style.setProperty('--q', String(quant(q, P.write)));
  e1.style.setProperty('--s', String(quant(s0.x, P.write)));
  e3.style.setProperty('--z', String(quant(tweenAt(tw, now), P.write)));
  requestAnimationFrame(frame);
}
addEventListener('go', () => {
  last = performance.now();
  setInterval(() => { g1 = (g1 === 0 ? P.amp1 : 0); }, 1000);
  setTimeout(() => setInterval(() => {
    tick++;
    e2.style.setProperty('--w', String(tick % 2));
    e2.classList.toggle('on');
  }, 1000), P.tickOffsetMs);
  requestAnimationFrame(frame);
}, { once: true });
