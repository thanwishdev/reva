import Lenis from '../vendor/lenis.mjs';
import { M09 } from '../core.js';
import { params, writer, loop } from './lib.js';
const p = params(M09.defaults);
// keep the library's class names off <html>: the recorder stores element descriptors
Lenis.prototype.updateClassName = function () {};
Lenis.prototype.cleanUpClassName = function () {};
const sc = new Lenis({ lerp: p.lerp, wheelMultiplier: p.mult, smoothWheel: true, autoRaf: false });
const put = writer(document.getElementById('c'));
loop((now) => {
  sc.raf(now);
  put('--y', String(sc.animatedScroll));
});
