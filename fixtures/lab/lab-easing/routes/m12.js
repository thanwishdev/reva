// Delay-staggered CSS animations (delays from a custom property), a rAF count-up and a typing counter, all started
// when the container first enters the viewport (IntersectionObserver).
import { cssBezier, easeFn, staggerIndex, M12_GEO as G } from '../core.js';
import { $, params, css, setVar, ready } from '../pagekit.js';

const P = params('m12');
let rules = `@keyframes k1 { from { opacity: 0; transform: translateY(${G.rise}px); } to { opacity: 1; transform: translateY(0px); } }
.b { transform: translateY(${G.rise}px); }
#c.go .b { animation: k1 ${P.du}ms ${cssBezier(P.bz)} both; animation-delay: calc(var(--i) * ${P.step}ms); }
`;
for (let i = 0; i < G.cols * G.rows; i++) {
  const r = Math.floor(i / G.cols), c = i % G.cols;
  rules += `#b${i} { left: ${80 + c * 150}px; top: ${120 + r * 90}px; --i: ${staggerIndex(P.order, i, G.cols, G.rows)}; }\n`;
}
css(rules);

const count = $('n'), typed = $('t');
setVar(count, '--c', 0);
setVar(typed, '--n', 0);
const ease = easeFn('easeOutCubic');
function run() {
  $('c').classList.add('go');
  const t0 = performance.now();
  const loop = () => {
    const now = performance.now();
    const p = Math.min(1, (now - t0) / P.cD);
    const v = P.N * ease(p);
    setVar(count, '--c', v);
    count.textContent = String(Math.round(v));
    const n = Math.min(P.text.length, Math.floor((now - t0) / P.char));
    setVar(typed, '--n', n);
    typed.textContent = P.text.slice(0, n);
    if (p < 1 || n < P.text.length) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
const io = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) { io.disconnect(); run(); }
});
io.observe($('c'));
ready();
