// look --el: pseudo-elements, nodes the page builds late, and the real-time start-up wait. Own fixture (fixtures/look/el-lane.html,
// localhost, no site data); every value is known by construction (see the comment in the page). Lane D of the REVA v1 push.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveFixture } from '../helpers.js';
import { runLook, quietBeforeStart } from '../../src/look/index.js';
import { parseAim, splitSelectorList, selectorFromDesc } from '../../src/look/select.js';
import { descMatch } from '../../src/analysis/fit/declared.js';

let srv;
test.before(async () => { srv = await serveFixture('look'); });
test.after(async () => { await srv.close(); });
const look = (o) => runLook({ input: `${srv.origin}/el-lane.html`, write: false, design: false, ...o });
const chans = (m) => m.records.map((x) => x.target.channel);

test('parseAim: a pseudo-element splits off the host selector; lists, escapes and :is() commas stay whole', () => {
  assert.deepEqual(parseAim('.nav a::after'), { selectors: ['.nav a'], pseudos: ['::after'], hasPseudo: true });
  assert.deepEqual(parseAim('.a::before, .b'), { selectors: ['.a', '.b'], pseudos: ['::before', null], hasPseudo: true });
  assert.deepEqual(parseAim('li:after'), { selectors: ['li'], pseudos: ['::after'], hasPseudo: true }, 'the one-colon legacy form is normalised');
  assert.deepEqual(parseAim('::before'), { selectors: ['*'], pseudos: ['::before'], hasPseudo: true });
  const plain = parseAim(':is(.a, .b) > i'); assert.equal(plain.hasPseudo, false); assert.deepEqual(plain.selectors, [':is(.a, .b) > i']);
  assert.equal(parseAim('.md\\:after').hasPseudo, false, 'an escaped colon is part of a class name');
  assert.deepEqual(splitSelectorList('a[title="x, y"], b:not(.c, .d)'), ['a[title="x, y"]', 'b:not(.c, .d)']);
  assert.equal(selectorFromDesc('DIV.pulse::after'), 'div.pulse::after');
  assert.equal(selectorFromDesc('A::after'), 'a::after');
});

test('descMatch: a pseudo-element descriptor matches the same pseudo of the same host (classes may differ), never its host or another pseudo', () => {
  assert.equal(descMatch('DIV.cursor.is-big::before', 'DIV.cursor::before'), true);
  assert.equal(descMatch('DIV.cursor::before', 'DIV.cursor'), false);
  assert.equal(descMatch('DIV.cursor::before', 'DIV.cursor::after'), false);
  assert.equal(descMatch('DIV.cursor.is-big', 'DIV.cursor'), true, 'plain descriptors are unchanged');
});

test('hover --el "sel::after": the underline transition is read exactly (450 ms, its bezier, scale x 0 -> 1) and only sx moves', async () => {
  const r = await look({ action: 'hover', el: '.u::after' });
  assert.equal(r.status, 'motion'); assert.equal(r.take.aimMatches, 1);
  const m = r.motions[0];
  assert.equal(m.desc, 'A.u::after'); assert.equal(m.selector, 'a.u::after');
  const t = m.lines.map((l) => l.text).join(' | ');
  assert.match(t, /CSS transition: 450 ms \[exact\], cubic-bezier\(0\.19, 1, 0\.22, 1\) \[exact\], scale x 0 → 1/, t);
  // scaleX(0) has a zero determinant: the y scale must not read as a step 0 -> 1 on the first frame of the hover
  assert.deepEqual(chans(m), ['ren:sx'], chans(m).join(','));
});

test('hover --el "sel::before": an opacity transition on a pseudo-element (300 ms ease-in-out, 0 -> 1)', async () => {
  const r = await look({ action: 'hover', el: '.dot::before' });
  const t = r.motions.map((m) => m.lines.map((l) => l.text).join(' | ')).join(' ;; ');
  assert.match(t, /CSS transition: 300 ms \[exact\], ease-in-out \[exact\], opacity 0 → 1/, t);
});

test('load --el "sel::after": a CSS animation on a pseudo-element (800 ms, the bezier on its keyframes)', async () => {
  const r = await look({ action: 'load', el: '.pulse::after' });
  const t = r.motions.map((m) => m.lines.map((l) => l.text).join(' | ')).join(' ;; ');
  assert.match(t, /CSS animation: 800 ms \[exact\], cubic-bezier\(0\.4, 0, 0\.2, 1\) \[exact\]/, t);
  assert.match(t, /scale x 0 → 1/, t);
});

test('a scale that overshoots through zero stays one scale (sx < 0), not "rotate 180 and flip y"', async () => {
  const r = await look({ action: 'hover', el: '.flip::after' });
  const m = r.motions[0]; assert.ok(m, r.warnings.join(' | '));
  assert.deepEqual(chans(m), ['ren:sx'], chans(m).join(','));
  assert.match(m.lines.map((l) => l.text).join(' | '), /CSS transition: 600 ms \[exact\], cubic-bezier\(0\.3, 1\.5, 0\.7, 1\.5\) \[exact\], scale x 1 → 0/);
});

test('load --el on nodes the page builds 1500 ms after load: all six letters are found and their entrance is fitted', async () => {
  const r = await look({ action: 'load', el: '#split .ch' });
  assert.equal(r.take.aimMatches, 6); assert.equal(r.status, 'motion');
  const m = r.motions[0]; assert.equal(m.count, 6);
  assert.match(m.lines.map((l) => l.text).join(' | '), /600 ms/);
});

test('scroll --el on rows built 2200 ms after load: the look waits for them (they exist when the wheel starts)', async () => {
  const r = await look({ action: 'scroll', el: '#rows .row' });
  assert.ok(r.ready && r.ready.ok && r.ready.virtualMs >= 2200, JSON.stringify(r.ready));
  assert.equal(r.take.aimMatches, 5); assert.equal(r.status, 'motion');
  const m = r.motions[0]; assert.equal(m.count, 5);
  assert.match(m.lines.map((l) => l.text).join(' | '), /Scroll-linked.*opacity 0 \[fitted\] → 1 \[fitted\].*linear/);
});

test('scroll --el that matches nothing is not held for ever: the wait is bounded (5 s of page time) and the miss is reported', async () => {
  const r = await look({ action: 'scroll', el: '#nothing-here .row' });
  assert.equal(r.take.aimMatches, 0); assert.ok(r.errors.some((e) => /no element matches --el/.test(e)), r.errors.join(' | '));
  assert.ok(r.ready && r.ready.virtualMs < 12000, JSON.stringify(r.ready));
});

test('quietBeforeStart: waits until the document is complete, no request is in flight and no long task ran for quietMs; bounded by maxMs', async () => {
  const st = [{ done: false, idle: 1e9 }, { done: true, idle: 10 }, { done: true, idle: 400 }, { done: true, idle: 800 }, { done: true, idle: 1200 }];
  let i = 0; const S = { evRetry: async () => st[Math.min(i++, st.length - 1)] };
  const r = await quietBeforeStart(S, { pending: () => 0, quietMs: 60, maxMs: 5000 });
  assert.equal(r.ok, true); assert.ok(i >= 4, `polled ${i} times`);
  // requests in flight keep it waiting until the bound
  const busy = await quietBeforeStart({ evRetry: async () => ({ done: true, idle: 1e9 }) }, { pending: () => 2, quietMs: 20, maxMs: 150 });
  assert.equal(busy.ok, false); assert.ok(busy.wallMs >= 150);
});
