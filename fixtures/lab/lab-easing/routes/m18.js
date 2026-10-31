// List-style layout change played as First-Last-Invert-Play: measure, change the layout, apply the inverse transform,
// then animate it away. WAAPI and rAF implementations; a second call while it runs restarts from the current state.
import { easeFn, tweenAt, M18_GEO as G } from '../core.js';
import { $, params, css, ready } from '../pagekit.js';

const P = params('m18');
const box = (s) => `left: ${s.x}px; top: ${s.y}px; width: ${s.w}px; height: ${s.h}px;`;
css(`#b0 { ${box(G.A)} } #c.s #b0 { ${box(G.B)} }`);
const el = $('b0'), c = $('c');
const ease = easeFn(P.bz);
const bz = `cubic-bezier(${P.bz.join(', ')})`;
let anim = null, raf = 0, tw = null;

function inverse(d, k) {          // k = 1 at the inverted state, 0 at rest
  return `translate(${d.dx * k}px, ${d.dy * k}px) scale(${1 + (d.sx - 1) * k}, ${1 + (d.sy - 1) * k})`;
}
function stop() {
  if (anim) { anim.cancel(); anim = null; }
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  tw = null;
  el.style.transform = '';
}
function flip() {
  const first = el.getBoundingClientRect();
  stop();
  c.classList.toggle('s');
  const last = el.getBoundingClientRect();
  const d = { dx: first.left - last.left, dy: first.top - last.top, sx: first.width / last.width, sy: first.height / last.height };
  if (P.impl === 'waapi') {
    anim = el.animate([{ transform: inverse(d, 1) }, { transform: 'none' }], { duration: P.D, easing: bz, fill: 'both' });
  } else {
    el.style.transform = inverse(d, 1);
    tw = { from: 1, to: 0, D: P.D, ease, t0: null };
    const loop = () => {
      raf = 0;
      const now = performance.now();
      if (tw.t0 == null) tw.t0 = now;
      const r = tweenAt(tw, now);
      el.style.transform = r.done ? '' : inverse(d, r.v);
      if (!r.done) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }
}
window.__go = flip;
ready();
