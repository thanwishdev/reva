// look --do scroll end to end on fixtures/look/scrub-native.html (plain JS, localhost only, no library, no site data): a
// page that scrolls natively, a scrubbed timeline whose child ends before the trigger range does (a real page's rail), and a
// time tween the scroll only starts. Values are known by construction (see the comment in the page). D-SCROLLBUDGET-1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveFixture } from '../helpers.js';
import { runLook } from '../../src/look/index.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;
let srv, r;
test.before(async () => { srv = await serveFixture('look'); r = await runLook({ input: srv.origin + '/scrub-native.html', write: false, design: false, action: 'scroll' }); });
test.after(async () => { await srv.close(); });
const motion = (sel) => r.motions.find((m) => m.selector === sel);
const recOf = (m, ch) => m && m.records.find((x) => x.target.channel === ch);

test('scrubbed timeline: restarted expo.out of 1000 ms on the clamped progress, the child map inside the trigger range', () => {
  const m = motion('#tl'); assert.ok(m, r.motions.map((x) => x.selector).join(','));
  const tx = recOf(m, 'ren:tx'); assert.equal(tx.tier, 'fitted', JSON.stringify(tx.unknowns)); assert.equal(tx.class, 'restarted tween');
  assert.equal(tx.model.scrub && tx.model.scrub.kind, 'scrubbed timeline');
  assert.ok(near(tx.model.params.L.value, 1000, 30), `L ${tx.model.params.L.value}`);
  assert.ok(near(tx.model.map.b, -2400, 5) && near(tx.model.map.a, 0, 2), JSON.stringify(tx.model.map));
  // a dense sweep trades a frame of lag against one wheel step (100 px) of both corners: the interval says so
  assert.ok(near(tx.model.map.s0_px, 1000, 210) && near(tx.model.map.s1_px - tx.model.map.s0_px, 2700, 20), JSON.stringify(tx.model.map));
  assert.ok(near(tx.model.scrub.range_px[1] - tx.model.map.s1_px, 300, 20), JSON.stringify(tx.model.scrub));
  assert.ok(m.lines.some((l) => /GSAP scrub (1|1\.0\d*|0\.99\d*) s/.test(l.text) && /scrubbed timeline/.test(l.text)), m.lines.map((l) => l.text).join(' | '));
});

test('a tween the scroll only starts is a time tween, and no driver search is spent on it', () => {
  const m = motion('#pop'); assert.ok(m, r.motions.map((x) => x.selector).join(','));
  const sx = recOf(m, 'ren:sx'); assert.equal(sx.tier, 'fitted', JSON.stringify(sx.unknowns)); assert.equal(sx.class, 'tween');
  assert.ok(near(sx.model.params.D.value, 900, 20), JSON.stringify(sx.model.params.D));
  assert.ok(!(sx.flags || []).some((f) => f.id === 'driver_search_cut'), JSON.stringify(sx.flags));
});

test('nothing left unknown; the fit stays inside the look budget', () => {
  assert.deepEqual(r.unknowns.map((u) => `${u.desc}|${u.channel}`), []);
  assert.ok(!(r.fit.flags || []).some((f) => /budget/.test(f.id)), JSON.stringify(r.fit.flags));
});
