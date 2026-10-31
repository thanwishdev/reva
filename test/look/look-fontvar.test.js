// Variable-font motion end to end on our own fixture (fixtures/look/fontvar.html; localhost only, no font file, no internet):
// a hover transition, a font-weight transition, @keyframes on two axes and a script-driven scroll weight are recorded as
// font-axis channels and reported in plain words ('font weight 300 → 800'), with the page's own timing read as exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveFixture } from '../helpers.js';
import { runLook } from '../../src/look/index.js';
import { formatLook } from '../../src/look/cli.js';

let srv;
test.before(async () => { srv = await serveFixture('look'); });
test.after(async () => { await srv.close(); });
const look = (o) => runLook({ input: srv.origin + '/fontvar.html', write: false, design: false, ...o });
const travels = (m) => m.lines.flatMap((l) => (l.travel || []).map((t) => t.text));

test('hover: font-variation-settings transition -> wght channel, 600 ms ease-out, "font weight 300 → 800"', async () => {
  const r = await look({ action: 'hover', el: '#h' });
  assert.equal(r.ok, true);
  const m = r.motions[0];
  assert.deepEqual(m.channels, ['ren:wght'], 'the weight is the only channel (a fixed-width box does not reflow)');
  assert.match(m.lines[0].text, /^Tween, ease-out \[fitted\], 600 ms \[fitted\]$/);
  assert.deepEqual(travels(m), ['font weight 300 → 800']);
  // the declared line: timing exact; the end values Chrome does not expose for this property are measured, not exact
  const d = r.declaredOnly[0];
  assert.equal(d.durationMs, 600); assert.equal(d.easing, 'ease-out');
  assert.deepEqual(d.properties.map((p) => [p.prop, p.axis, p.from, p.to, p.source]), [['font-variation-settings', 'wght', 300, 800, 'measured']]);
  const txt = formatLook(r);
  assert.match(txt, /font weight 300 → 800 \[fitted\]/);
  assert.match(txt, /CSS transition: font weight 300 → 800 \[fitted\] · 600 ms \[exact\], ease-out \[exact\]/);
  assert.ok(!/normal → normal/.test(txt), 'no "normal → normal"');
});

test('hover: font-weight transition is a font weight channel too', async () => {
  const r = await look({ action: 'hover', el: '#fw' });
  const m = r.motions[0];
  assert.deepEqual(m.channels, ['ren:wght']);
  assert.match(m.lines[0].text, /^Tween, (ease-in-out|bezier|cubic)/i, m.lines[0].text);
  assert.equal(travels(m)[0], 'font weight 300 → 800', 'the hover in; the way back is its own line');
  const d = r.declaredOnly[0];
  assert.equal(d.durationMs, 600);
  assert.deepEqual(d.properties.map((p) => [p.prop, p.axis, p.from, p.to]), [['font-weight', 'wght', 300, 800]], 'font-weight keyframes are numbers: exact');
});

test('load: @keyframes on wght and wdth -> two channels, exact end values from the keyframes', async () => {
  const r = await look({ action: 'load', el: '#k' });
  const m = r.motions[0];
  assert.deepEqual([...m.channels].sort(), ['ren:wdth', 'ren:wght']);
  assert.deepEqual(travels(m).sort(), ['font weight 200 → 900', 'font width 75% → 125%']);
  const d = r.declaredOnly[0];
  assert.equal(d.kind, 'css-animation'); assert.equal(d.durationMs, 1000);
  assert.deepEqual(d.properties.map((p) => [p.axis, p.from, p.to, p.source || 'page']).sort(), [['wdth', 75, 125, 'page'], ['wght', 200, 900, 'page']]);
  assert.match(formatLook(r), /CSS animation: font weight 200 → 900; font width 75% → 125% · 1000 ms \[exact\]/);
});

test('scroll: a script-driven weight is recorded as a channel and reported in words (the scroll-map numbers are not asserted here)', async () => {
  const r = await look({ action: 'scroll', el: '#s' });
  const m = r.motions[0];
  assert.ok(m, 'the element is reported as moving');
  assert.ok(m.channels.includes('ren:wght'), m.channels.join(','));
  assert.ok(!m.channels.includes('ren:bw'), 'no box-width proxy');
  const txt = formatLook(r);
  assert.match(txt, /font weight/);
  assert.ok(!/ren:wght/.test(txt), 'channel id never printed');
  // the page sets weight = 100 + 800 * min(1, scrollY / 1500): a native scroll with one hold at each end gives two settled pairs, which
  // every map shape fits, so the per-frame pairs decide: linear, 100 -> 900 over 0 -> 1500 px (the start is not identified)
  assert.match(txt, /font weight 100 \[fitted\] → 900 \[fitted\] while the page scrolls 0 px \[unknown\] → 1500 px \[fitted\], linear/, txt);
  assert.ok(!/-\d{4,}/.test(m.lines.map((l) => l.text).join(' ')), 'no six-figure negative extrapolation');
});
