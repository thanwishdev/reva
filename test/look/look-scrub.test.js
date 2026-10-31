// look --do scroll end to end on fixtures/look/scrub.html (plain JS, localhost only, no library, no site data): a page
// that owns its scroll (Lenis-like smoothing, every wheel prevented), a scrub:true map, a sticky pin with a sliding rail,
// and a scrub 0.5 (restarted expo.out) follower. Values are known by construction (see the comment in the page).
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveFixture } from '../helpers.js';
import { runLook } from '../../src/look/index.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;
let srv, r;
test.before(async () => { srv = await serveFixture('look'); r = await runLook({ input: srv.origin + '/scrub.html', write: false, design: false, action: 'scroll' }); });
test.after(async () => { await srv.close(); });
const motion = (sel) => r.motions.find((m) => m.selector === sel);
const recOf = (m, ch) => m && m.records.find((x) => x.target.channel === ch);

test('page line: the smooth scroller, tau 166.7 ms (Lenis lerp 0.1)', () => {
  assert.ok(r.page, 'page line');
  assert.match(r.page.lines[0].text, /^Smooth follow of the scroll, time constant 166\.\d ms \[fitted\], = lerp 0\.(1|0999\d) \[fitted\]/);
});

test('scrub: true on a page-owned scroll: linear map of the scroll offset with exact ends', () => {
  const m = motion('#ht'); assert.ok(m, r.motions.map((x) => x.selector).join(','));
  const ty = recOf(m, 'ren:ty'); assert.match(ty.model.family, /^scroll map \(linear\)/);
  assert.equal(ty.model.driver.kind, 'scroll'); assert.equal(ty.model.driver.pageOwned, true);
  assert.ok(near(ty.model.map.b, -180, 0.5) && near(ty.model.map.s1_px, 900, 1), JSON.stringify(ty.model.map));
  const op = recOf(m, 'ren:opacity'); assert.ok(near(op.model.map.a, 1, 1e-3) && near(op.model.map.a + op.model.map.b, 0.2, 1e-3), JSON.stringify(op.model.map));
  assert.ok(m.lines.some((l) => /^Scroll-linked \(scrubbed\): y 0 \[fitted\] → -180 \[fitted\] while the page scrolls \(the page moves its own scroll/.test(l.text)), m.lines.map((l) => l.text).join(' | '));
});

test('pin + rail: the rail map runs over the pin range and the pin edges are measured', () => {
  const m = motion('#rail'); assert.ok(m, r.motions.map((x) => x.selector).join(','));
  const tx = recOf(m, 'ren:tx'); assert.match(tx.model.family, /^scroll map \(linear\)/);
  assert.ok(near(tx.model.map.s0_px, 1500, 1) && near(tx.model.map.s1_px, 3900, 1) && near(tx.model.map.b, -2000, 0.5), JSON.stringify(tx.model.map));
  const pin = recOf(m, 'ren:by'); assert.ok(pin, m.channels.join(',')); assert.match(pin.model.family, /^pin/);
  assert.ok(near(pin.model.pin.start.value, 1500, 1) && near(pin.model.pin.end.value, 3900, 1), JSON.stringify(pin.model.pin));
  assert.equal(m.channels[0], 'ren:tx', 'the own channel is fitted before the pin box');
});

test('scrub 0.5: first-order follow of the scroll offset, tau = 500 / (10 ln 2) ms, read as GSAP scrub 0.5', () => {
  const m = motion('#scr'); assert.ok(m, r.motions.map((x) => x.selector).join(','));
  const tx = recOf(m, 'ren:tx'); assert.equal(tx.tier, 'fitted'); assert.equal(tx.model.driver.kind, 'scroll');
  assert.ok(near(tx.model.params.tau_ms.value, 72.13, 1.5), `tau ${tx.model.params.tau_ms.value}`);
  assert.ok(m.lines.some((l) => /GSAP scrub 0\.5\d* s/.test(l.text)), m.lines.map((l) => l.text).join(' | '));
});

test('nothing left unknown; the fit stays inside the look budget', () => {
  assert.deepEqual(r.unknowns.map((u) => `${u.desc}|${u.channel}`), []);
  assert.ok(!(r.fit.flags || []).some((f) => /budget/.test(f.id)), JSON.stringify(r.fit.flags));
});
