// look end to end on our own fixture (fixtures/look, localhost only; no site data, no internet): every action, aim mode
// and the ranked mode. The fixture's motions are known by construction (see the comment in fixtures/look/index.html).
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveFixture } from '../helpers.js';
import { runLook } from '../../src/look/index.js';
import { formatLook } from '../../src/look/cli.js';

const near = (a, b, rel) => Math.abs(a - b) <= rel * Math.abs(b);
const pv = (rec, k) => rec.model.params[k] && rec.model.params[k].value;
let srv;
test.before(async () => { srv = await serveFixture('look'); });
test.after(async () => { await srv.close(); });
const look = (o) => runLook({ input: srv.origin + '/', write: false, design: false, ...o });

test('load, aimed at a repeated element: one folded entry, stagger 60 ms, easeOutCubic 500 ms', async () => {
  const r = await look({ action: 'load', el: '.word' });
  assert.equal(r.ok, true); assert.equal(r.take.net.misses, null);
  assert.equal(r.take.frameClock && r.take.frameClock.keepalive, true, 'keepalive recorded in the take provenance');
  assert.equal(r.motions.length, 1);
  const m = r.motions[0]; assert.equal(m.kind, 'group'); assert.equal(m.count, 8);
  assert.ok(m.stagger, 'stagger folded'); assert.ok(near(m.stagger.group.interval.value, 60, 0.02), `interval ${m.stagger.group.interval.value}`);
  const tw = m.records.find((x) => x.model.family === 'named:easeOutCubic');
  assert.ok(tw, m.records.map((x) => x.model.family).join(',')); assert.ok(near(pv(tw, 'D'), 500, 0.01));
  assert.ok(m.lines.some((l) => /^Tween, easeOutCubic \(= GSAP power2\.out\) \[fitted\], 500 ms \[fitted\]$/.test(l.text)), m.lines.map((l) => l.text).join(' | '));
  assert.ok(!m.channels.includes('drv:transform') && !m.channels.includes('ren:transform'), 'string mirrors not fitted');
  assert.match(formatLook(r), /Stagger: 8 of 8 start one after another, every 60 ms \[fitted\], constant step, in dom order/);
});

test('hover: CSS transition read as declared (exact), one line for scale x/y', async () => {
  const r = await look({ action: 'hover', el: '#btn' });
  const m = r.motions[0];
  assert.ok(m.records.every((x) => x.tier === 'declared'), m.records.map((x) => x.tier).join(','));
  assert.equal(m.lines.length, 1);
  assert.equal(m.lines[0].text, 'CSS transition: 150 ms [exact], ease [exact], scale 1 → 1.1 [exact]');
  assert.equal(m.lines[0].trigger, 'reacts to the pointer');
  assert.ok(m.exports.some((e) => e.exports.some((x) => x.lib === 'css' && /150ms/.test(x.code) && x.accuracy.label === 'exact')));
});

test('click: spring ω 12, ζ 0.4 recovered; scroll: scrubbed map read in one wheel pass that stops early', async () => {
  const c = await look({ action: 'click', el: '#box' });
  const sp = c.motions[0].records.find((x) => x.model.family === 'spring');
  assert.ok(sp, c.motions[0].records.map((x) => x.model.family).join(','));
  assert.ok(near(pv(sp, 'omega'), 12, 0.01) && near(pv(sp, 'zeta'), 0.4, 0.01), `ω ${pv(sp, 'omega')} ζ ${pv(sp, 'zeta')}`);
  assert.match(c.motions[0].lines[0].text, /^Spring, clearly bouncy \(overshoots 25\.\d+ % \[fitted\]\)/);
  const s = await look({ action: 'scroll', el: '#track' });
  const map = s.motions[0].records.find((x) => /^scroll map/.test(x.model.family));
  assert.ok(map, s.motions[0].records.map((x) => x.model.family).join(','));
  assert.ok(near(map.model.map.s0_px, 400, 0.01) && near(map.model.map.s1_px, 1200, 0.01) && near(map.model.map.b, -800, 0.01), JSON.stringify(map.model.map));
  assert.ok(s.action.wheels < 200, `wheel stopped early (${s.action.wheels})`);
});

test('no --el: the top elements by visual weight, folded, each with lines', async () => {
  const r = await look({ action: 'load', top: 3 });
  assert.ok(r.motions.length >= 2 && r.motions.length <= 3);
  const descs = r.motions.map((m) => m.desc);
  assert.ok(descs.some((d) => d.startsWith('DIV#hero')), descs.join(','));   // 'DIV#hero.in': the class is set before it moves
  assert.ok(descs.includes('SPAN.word'), descs.join(','));
  const hero = r.motions.find((m) => m.desc.startsWith('DIV#hero'));
  assert.match(hero.lines[0].text, /^CSS transition: 600 ms \[exact\], cubic-bezier\(0\.22, 1, 0\.36, 1\) \[exact\]/);
  assert.equal(r.motions.find((m) => m.desc === 'SPAN.word').count, 8);
});
