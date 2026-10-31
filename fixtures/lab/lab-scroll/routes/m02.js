import { M02, fmt } from '../core.js';
import { params, block, writer, loop } from './lib.js';
const p = params(M02.defaults);
const watched = block('t', M02.BOTTOM - 600, 600, 'width:40px');
const put = writer(document.getElementById('c'));
const st = M02.init();
loop(() => {
  M02.frame(st, p, watched.getBoundingClientRect().bottom);
  put('--e', fmt(st.cur, p.write));
});
