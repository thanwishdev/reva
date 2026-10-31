// An SMIL <animate> started with beginElement() after a delay. SMIL has its own clock that a virtual-clock recorder
// cannot step, so the page pauses the SMIL timeline and sets its current time from performance.now() on every frame
// (the same animation, driven from the page clock). Rendering reads back through the bounding box.
import { cssBezier, M15_GEO as G } from '../core.js';
import { $, params, ready } from '../pagekit.js';

const P = params('m15');
const svg = $('s'), a = $('a0'), dot = $('b0');
dot.setAttribute('cx', String(P.from));
a.setAttribute('from', String(P.from));
a.setAttribute('to', String(P.to));
a.setAttribute('dur', P.dur + 'ms');
a.setAttribute('repeatCount', 'indefinite');
if (P.spline) { a.setAttribute('calcMode', 'spline'); a.setAttribute('keyTimes', '0;1'); a.setAttribute('keySplines', P.spline.join(' ')); }
svg.pauseAnimations();
const sync = () => { svg.setCurrentTime(performance.now() / 1000); };
const frame = () => { sync(); requestAnimationFrame(frame); };
requestAnimationFrame(frame);
window.__go = () => { setTimeout(() => { sync(); a.beginElement(); }, P.delay); };
ready();
