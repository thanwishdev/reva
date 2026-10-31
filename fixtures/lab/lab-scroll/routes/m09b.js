import { M09B } from '../core.js';
import { params, writer, loop } from './lib.js';
const p = params(M09B.defaults);
const put = writer(document.getElementById('c'));
const st = M09B.init();
addEventListener('wheel', (e) => { e.preventDefault(); M09B.wheel(st, p, e.deltaY); }, { passive: false });
let lastY = 0;
loop(() => {
  const o = M09B.frame(st, p);
  if (o.y !== lastY) { lastY = o.y; scrollTo({ top: o.y, behavior: 'instant' }); }
  put('--y', String(o.y));
});
