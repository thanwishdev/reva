// Same-document view transition with two named groups that move (and one that resizes) between two layout states.
// Group durations and easings are set through the ::view-transition-group rules; the root is left out of the snapshot.
import { cssBezier, M17_GEO as G } from '../core.js';
import { $, params, css, ready } from '../pagekit.js';

const P = params('m17');
const ez = (e) => (Array.isArray(e) ? cssBezier(e) : e);
const box = (s) => `left: ${s.x}px; top: ${s.y}px; width: ${s.w}px; height: ${s.h}px;`;
css(`:root { view-transition-name: none; }
#b0 { ${box(G.g0.A)} view-transition-name: g0; } #c.s #b0 { ${box(G.g0.B)} }
#b1 { ${box(G.g1.A)} view-transition-name: g1; } #c.s #b1 { ${box(G.g1.B)} }
::view-transition-group(g0) { animation-duration: ${P.d0}ms; animation-timing-function: ${ez(P.e0)}; }
::view-transition-group(g1) { animation-duration: ${P.d1}ms; animation-timing-function: ${ez(P.e1)}; }
`);
window.__go = () => { document.startViewTransition(() => { $('c').classList.toggle('s'); }); };
ready();
