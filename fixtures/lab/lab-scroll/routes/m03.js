import { M03, fmt } from '../core.js';
import { params, block, writer, loop } from './lib.js';
const p = params(M03.defaults);
const a = block('a', M03.BOTTOM_A - 500, 500, 'width:40px');
const b = block('b', M03.BOTTOM_B - 500, 500, 'width:40px');
const put = writer(document.getElementById('c'));
const st = M03.init();
loop(() => {
  M03.frame(st, p, a.getBoundingClientRect().bottom, b.getBoundingClientRect().bottom);
  put('--a', fmt(st.a, p.write));
  put('--b', fmt(st.b, p.write));
  put('--p', fmt(Math.max(st.a, st.b), p.write));
});
