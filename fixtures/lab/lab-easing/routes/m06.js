// A registered number property animated by keyframes with a flat segment (a "hold") before the visible motion, a
// per-segment cubic-bezier, and six elements started 12 + 30*i ms apart. Consumers map the property to transform and
// opacity through calc(). hold = 0 is the no-hold control.
import { cssBezier, M06_MAP as M } from '../core.js';
import { $, params, css, ready } from '../pagekit.js';

const P = params('m06');
const h = Math.round(P.hold * 100000) / 1000;                 // percent with 3 decimals
const kf = P.hold > 0
  ? `0% { --e: 0; } ${h}% { --e: 0; animation-timing-function: ${cssBezier(P.bz)}; } 100% { --e: 1; }`
  : `0% { --e: 0; animation-timing-function: ${cssBezier(P.bz)}; } 100% { --e: 1; }`;
let rules = `@keyframes k1 { ${kf} }
.b { transform: translateX(calc(var(--e) * ${M.tx}px)) rotate(calc(var(--e) * ${M.rot}deg)); opacity: calc(${M.opA} + var(--e) * ${1 - M.opA}); }
#c.on .b { animation: k1 ${P.D}ms linear both; }
`;
for (let i = 0; i < P.n; i++) rules += `#b${i} { top: ${60 + i * 100}px; --d: ${P.base + i * P.step}; } #c.on #b${i} { animation-delay: calc(var(--d) * 1ms); }\n`;
css(rules);
window.__go = () => { $('c').classList.add('on'); };
ready();
