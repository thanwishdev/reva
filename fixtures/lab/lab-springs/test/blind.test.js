// Group B blindness: a recorded lab take carries none of the route id, parameter names or string parameter values, and the
// lab server refuses the truth files. One cell per route family at R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, routes, loadJson, recordCell, leaks } from './harness.mjs';

test('takes of the lab pages leak no route id, parameter name or string value; the server refuses truth files', async () => {
  const srv = await serve();
  try {
    for (const rel of ['/truth/m07.json', '/truth.mjs', '/refsim.mjs', '/routes.json', '/traces/m07.p400.json', '/cell.mjs', '/gen.mjs']) {
      const r = await fetch(srv.origin + rel); assert.equal(r.status, 403, rel);
    }
    for (const [id, variant, tn] of [['m07', 'i4', 'p400'], ['m08', 'analytic', 'v0'], ['m10', 'dt', 'still']]) {
      const route = routes().find(r => r.id === id), v = route.codeVariants.find(c => c.id === variant);
      const { take, merged } = await recordCell(srv.origin, route, v.default, loadJson(route.traces[tn]), { rate: 60 });
      assert.deepEqual(leaks(take, route, merged, tn), [], `${id}/${variant}/${tn} leaked`);
      assert.deepEqual(take.els, ['DIV.b0']);
      assert.deepEqual(Object.keys(take.escapes || {}), []);
    }
  } finally { await srv.close(); }
});
