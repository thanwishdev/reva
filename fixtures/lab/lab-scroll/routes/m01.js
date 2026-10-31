import { M01 } from '../core.js';
import { params, block, writer, loop } from './lib.js';
const p = params(M01.defaults);
const mark = block('t', p.o, 40, 'width:40px');
const put = writer(document.getElementById('c'));
loop(() => {
  const r = M01.frame(p, mark.getBoundingClientRect().top);
  put('--p', String(r.p));
});
