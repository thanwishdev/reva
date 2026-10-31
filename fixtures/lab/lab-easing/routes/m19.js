// rAF tween with a sub-frame onset: started by a timer (due time is not on the frame grid), by a click, and
// retargeted from the current value by a second click while it runs.
import { easeFn } from '../core.js';
import { $, params, setVar, makeTweener, ready } from '../pagekit.js';

const P = params('m19');
const el = $('b0');
setVar(el, '--v', P.from);
const tw = makeTweener(el, '--v', P.write);
tw.cur = P.from;

$('c').addEventListener('click', () => {
  if (tw.active()) tw.start(tw.cur, P.to2, P.D2, easeFn(P.ease));      // retarget from the current value
  else tw.start(P.from, P.to, P.D, easeFn(P.ease));
});
window.__go = () => { setTimeout(() => tw.start(P.from, P.to, P.D, easeFn(P.ease)), P.delay); };
ready();
