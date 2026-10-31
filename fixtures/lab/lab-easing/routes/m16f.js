// Negative control: a back-out cubic-bezier tween (overshoot 5 to 12 percent). The shape overshoots like an
// under-damped spring, but it is a time-based tween with a fixed duration.
import { easeFn } from '../core.js';
import { $, params, setVar, makeTweener, ready } from '../pagekit.js';

const P = params('m16f');
const el = $('b0');
setVar(el, '--v', P.from);
const tw = makeTweener(el, '--v', P.write);
window.__go = () => tw.start(P.from, P.to, P.D, easeFn(P.bz));
ready();
