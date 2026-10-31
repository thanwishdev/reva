import { M05, VH } from '../core.js';
import { params, writer, loop } from './lib.js';
const p = params(M05.defaults);
const sec = document.getElementById('m');
sec.style.top = M05.SECTION_Y + 'px';
sec.style.height = M05.SECTION_H + 'px';
const put = writer(document.getElementById('c'));
const st = M05.init();
let armed = false;
new IntersectionObserver((es) => { for (const e of es) armed = e.isIntersecting; }, { rootMargin: '200% 0px' }).observe(sec);
addEventListener('wheel', (e) => {
  const r = M05.wheel(st, p, { dy: e.deltaY, now: performance.now(), sy: scrollY, armed });
  if (r.prevent) e.preventDefault();
}, { passive: false });
loop((now) => {
  const o = M05.frame(st, p, now);
  put('--m', String(o.m));
  put('--f', String(o.f));
  if (o.pinTo != null && scrollY !== o.pinTo) scrollTo({ top: o.pinTo, behavior: 'instant' });
});
