import { M04 } from '../core.js';
import { params, writer, loop } from './lib.js';
const p = params(M04.defaults);
const g = M04.geom(p);
const r = document.getElementById('r');
r.style.top = M04.RY + 'px';
r.style.height = g.runway + 'px';
const putK = writer(document.getElementById('k'));
const putC = writer(document.getElementById('c'));
const st = M04.init();
loop(() => {
  const o = M04.frame(st, p, r.getBoundingClientRect().top);
  putK('--s', o.sText);
  putK('--y', o.yText);
  putK('--o', o.oText);
  putC('--i', String(o.i));
});
