// look on fixtures/look/animation-evidence.html (localhost only; own fixture, known by construction there): an animation
// object born on the aimed element gives the exact law, ahead of fitted laws, in hover and load looks alike.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveFixture } from '../helpers.js';
import { runLook } from '../../src/look/index.js';

let srv;
test.before(async () => { srv = await serveFixture('look'); });
test.after(async () => { await srv.close(); });
const look = (o) => runLook({ input: `${srv.origin}/animation-evidence.html`, write: false, design: false, ...o });
const linesOf = (r) => r.motions.flatMap((m) => m.lines);

test('hover a magnetic button: the transform transition a script retargets every frame is stated exactly (600 ms, the runtime linear() curve, scale 1 → 1.04)', async () => {
  const r = await look({ action: 'hover', el: '#mag' });
  const ls = linesOf(r);
  const tr = ls.filter((l) => /^CSS transition: 600 ms \[exact\], linear\(0 0%/.test(l.text));
  assert.ok(tr.length >= 1, ls.map((l) => l.text.slice(0, 120)).join(' | '));
  assert.match(tr[0].text, /scale 1 → 1\.04 \[exact\]/);
  assert.match(tr[0].text, /restarted \d+ times as its target changed/);
  assert.ok(!ls.some((l) => /^composite:/.test(l.text)), 'no bare composite line');
});

test('load, sibling SVG sparkles on one @keyframes rule: the CSS animation (2000 ms, infinite) is read, not a piecewise fit', async () => {
  const r = await look({ action: 'load', el: '.spark' });
  const ls = linesOf(r);
  assert.ok(ls.some((l) => /^CSS animation: 2000 ms \[exact\].*repeats infinite/.test(l.text)), ls.map((l) => l.text.slice(0, 120)).join(' | '));
  assert.ok(!ls.some((l) => /piecewise/.test(l.text)), 'no piecewise line');
});

test('load, a steps() typing reveal on clip-path: one Web Animation law with steps(12), not a run of instant changes', async () => {
  const r = await look({ action: 'load', el: '#typed' });
  const ls = linesOf(r);
  assert.ok(ls.some((l) => /^Web Animation: 620 ms \[exact\], steps\(12\) \[exact\]/.test(l.text)), ls.map((l) => l.text.slice(0, 120)).join(' | '));
  assert.ok(!ls.some((l) => /^Instant change/.test(l.text)), 'no instant-change lines');
});

test('load, reveals built paused and played later: the Web Animation (700 ms, its curve) is the law', async () => {
  const r = await look({ action: 'load', el: '.line' });
  const ls = linesOf(r);
  assert.ok(ls.some((l) => /^Web Animation: 700 ms \[exact\], cubic-bezier\(0\.16, 1, 0\.3, 1\) \[exact\]/.test(l.text)), ls.map((l) => l.text.slice(0, 120)).join(' | '));
});
