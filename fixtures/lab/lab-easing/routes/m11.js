// Scroll-driven animation twins: a CSS view() timeline element (#b0) and the same animation built with a WAAPI
// ViewTimeline (#b1), both over the same range and easing, side by side at the same scroll position.
import { cssBezier, easeFn, M11_GEO as G } from '../core.js';
import { $, params, css, ready } from '../pagekit.js';

const P = params('m11');
const ez = Array.isArray(P.ease) ? cssBezier(P.ease) : P.ease;
css(`@keyframes k1 { from { opacity: 0.15; transform: translateX(0px); } to { opacity: 1; transform: translateX(${P.amp}px); } }
#b0, #b1 { top: ${G.Y}px; height: ${G.H}px; }
#b0 { left: 100px; animation: k1 linear both; animation-timeline: view(); animation-range: contain ${P.r0}% contain ${P.r1}%; animation-timing-function: ${ez}; }
#b1 { left: 700px; }
`);
const el = $('b1');
const tl = new ViewTimeline({ subject: el, axis: 'block' });
el.animate(
  [{ opacity: 0.15, transform: 'translateX(0px)' }, { opacity: 1, transform: `translateX(${P.amp}px)` }],
  { timeline: tl, rangeStart: { rangeName: 'contain', offset: CSS.percent(P.r0) }, rangeEnd: { rangeName: 'contain', offset: CSS.percent(P.r1) },
    easing: ez, fill: 'both', duration: 'auto' });
ready();
