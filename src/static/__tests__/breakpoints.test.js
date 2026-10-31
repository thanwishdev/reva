import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepWidths, classifyFluid, signature, bisectEdges, explainEdges } from '../breakpoints.js';

test('sweepWidths: regular steps, end point, extra probes, sorted unique', () => {
  const w = sweepWidths({ from: 320, to: 400, step: 40, extra: [359, 360, 361, 5000] });
  assert.deepEqual(w, [320, 359, 360, 361, 400]);
});

test('bisectEdges finds exact edges, incl. two edges in one interval and a third state', async () => {
  // states: <=600 A, 601..700 B, >=701 C
  const sigAt = async w => (w <= 600 ? 'A' : w <= 700 ? 'B' : 'C');
  const e = await bisectEdges(sigAt, 560, 760, 'A', 'C');
  assert.deepEqual(e, [{ lastOld: 600, firstNew: 601 }, { lastOld: 700, firstNew: 701 }]);
  const one = await bisectEdges(async w => (w < 860 ? 'x' : 'y'), 600, 1000, 'x', 'y');
  assert.deepEqual(one, [{ lastOld: 859, firstNew: 860 }]);
  assert.deepEqual(await bisectEdges(async () => 'a', 1, 100, 'a', 'a'), []);
});

test('classifyFluid: continuous value is fluid, a single step is not', () => {
  const widths = [100, 200, 300, 400, 500, 600];
  const snaps = new Map(widths.map(w => [w, [[1, `${w / 10}px`, w < 350 ? 'row' : 'col'], [2, 'same', 'same']]]));
  const fluid = classifyFluid(widths, snaps);
  assert.ok(fluid.has('1|1'));        // width-like: changes in every interval
  assert.ok(!fluid.has('1|2'));       // one change: a breakpoint
  assert.ok(!fluid.has('2|1'));
  const sig = w => signature(snaps.get(w), fluid);
  assert.equal(sig(100), sig(300));   // fluid width masked
  assert.notEqual(sig(300), sig(400)); // the real change shows
});

test('explainEdges: exact match explains; near does not; unexplained declared edge is listed', () => {
  const measured = [{ lastOld: 860, firstNew: 861 }, { lastOld: 1200, firstNew: 1201 }, { lastOld: 1500, firstNew: 1501 }];
  const q = [
    { query: '(max-width: 860px)', source: 'css', file: 's.css', edges: [{ lastOld: 860, firstNew: 861 }] },
    { query: '(min-width: 1201px)', source: 'js-matchMedia', edges: [{ lastOld: 1200, firstNew: 1201 }] },
    { query: '(min-width: 1502px)', source: 'css', edges: [{ lastOld: 1501, firstNew: 1502 }] },
    { query: '(min-width: 2000px)', source: 'css', edges: [{ lastOld: 1999, firstNew: 2000 }] },
  ];
  const r = explainEdges(measured, q);
  assert.equal(r.explained[0].explainedBy[0].query, '(max-width: 860px)');
  assert.equal(r.explained[1].explainedBy[0].source, 'js-matchMedia');
  assert.equal(r.explained[2].explainedBy.length, 0);
  assert.equal(r.explained[2].near.length, 1);
  assert.equal(r.declaredWithoutMeasuredEffect.length, 2);
});
