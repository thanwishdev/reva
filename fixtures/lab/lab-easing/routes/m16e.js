// Negative control: a long ease-out tween that looks like a decaying motion but is time-based and not a spring.
import { easeFn } from '../core.js';
import { $, params, setVar, makeTweener, ready } from '../pagekit.js';

const P = params('m16e');
const el = $('b0');
setVar(el, '--v', P.from);
const tw = makeTweener(el, '--v', P.write);
window.__go = () => tw.start(P.from, P.to, P.D, easeFn(P.ease));
ready();
