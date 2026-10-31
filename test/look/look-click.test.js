// look --do click end to end on fixtures/look-click (localhost only; no site data). Known by construction (see the fixture):
//   #go     hover 200 ms ease scale 1 -> 1.05 | press 100 ms ease scale -> 0.9 | release 200 ms | the click scrolls the page
//           0 -> 1200 px with a script tween, easeInOutCubic, 900 ms
//   #open   builds #panel (spring omega 9, zeta 0.7) and #pbtn; #pbtn click: spring omega 12, zeta 0.4
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveFixture } from '../helpers.js';
import { runLook, transitionTravel } from '../../src/look/index.js';
import { formatLook } from '../../src/look/cli.js';
import { describeElement } from '../../src/look/words.js';
import { notFromAction } from '../../src/look/select.js';

const near = (a, b, rel) => Math.abs(a - b) <= rel * Math.abs(b);
const pv = (rec, k) => rec.model.params[k] && rec.model.params[k].value;
let srv;
test.before(async () => { srv = await serveFixture('look-click'); });
test.after(async () => { await srv.close(); });
const look = (o) => runLook({ input: srv.origin + '/', write: false, design: false, ...o });

test('click that scrolls the page: the page row carries the scroll tween (900 ms easeInOutCubic), no element rides it', async () => {
  const r = await look({ action: 'click', el: '#go' });
  assert.ok(r.page, 'a page row');
  const l = r.page.lines[0];
  assert.equal(l.kind, 'tween', l.text);
  const rec = r.page.records[0];
  assert.ok(near(pv(rec, 'D'), 900, 0.02), `D ${pv(rec, 'D')}`);
  assert.match(l.text, /^Tween, easeInOutCubic/);
  assert.match(formatLook(r), /Page scroll after the click \(the click scrolls the page\): Tween, easeInOutCubic/);
  assert.equal(r.status, 'motion');
});

test('click press: hover 200 ms, press 100 ms and release 200 ms are three exact lines, each says which phase it starts on', async () => {
  const r = await look({ action: 'click', el: '#go' });
  const m = r.motions.find((x) => /BUTTON#go/.test(x.desc));
  assert.ok(m, r.motions.map((x) => x.desc).join(','));
  const tr = m.lines.filter((x) => x.kind === 'declared');
  assert.equal(tr.length, 3, m.lines.map((x) => x.text).join(' | '));
  assert.deepEqual(tr.map((x) => x.values[0].value), [200, 100, 200]);
  assert.deepEqual(tr.map((x) => x.trigger), ['starts on hover, before the press', 'starts on press (button held down)', 'starts on release (the click)']);
  assert.match(tr[1].text, /^CSS transition: 100 ms \[exact\], ease \[exact\], scale 1\.05 → 0\.9 \[exact\]$/);
  assert.match(tr[0].text, /scale 1 → 1\.05 \[exact\]$/);
});

test('click with --on: an element that only exists after the click (#panel) is reached in one look', async () => {
  const r = await look({ action: 'click', on: '#open', el: '#panel' });
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  const m = r.motions[0]; assert.ok(m, 'panel motion');
  const sp = m.records.find((x) => x.model.family === 'spring');
  assert.ok(sp, m.records.map((x) => x.model.family).join(','));
  assert.ok(near(pv(sp, 'omega'), 9, 0.03) && near(pv(sp, 'zeta'), 0.7, 0.03), `ω ${pv(sp, 'omega')} ζ ${pv(sp, 'zeta')}`);
});

test('--after: click #open first, then click #pbtn (absent at load) and read its spring (omega 12, zeta 0.4)', async () => {
  const r = await look({ action: 'click', after: '#open', el: '#pbtn' });
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.equal(r.action.after, '#open');
  const m = r.motions[0]; assert.ok(m, 'pbtn motion');
  const sp = m.records.find((x) => x.model.family === 'spring');
  assert.ok(sp, m.records.map((x) => x.model.family).join(','));
  assert.ok(near(pv(sp, 'omega'), 12, 0.02) && near(pv(sp, 'zeta'), 0.4, 0.02), `ω ${pv(sp, 'omega')} ζ ${pv(sp, 'zeta')}`);
  assert.match(formatLook(r), /click #pbtn after clicking #open/);
});

test('--after needs an action to follow it; an unknown selector is a usage error', async () => {
  await assert.rejects(look({ action: 'load', after: '#open' }), /--after/);
  await assert.rejects(look({ action: 'click', after: 'a[', el: '#go' }), /not a valid CSS selector/);
});

test('transitionTravel names only what differs between two keyframes', () => {
  assert.deepEqual(transitionTravel({ transform: 'translateY(-3px) scale(1)' }, { transform: 'translateY(-3px) scale(0.96)' }), { text: 'scale 1 → 0.96', channels: ['ren:sx', 'ren:sy'] });
  assert.equal(transitionTravel({ transform: 'scale(1)' }, { transform: 'scale(1)' }), null);
  assert.equal(transitionTravel({ opacity: '0' }, { opacity: '1' }).text, 'opacity 0 → 1');
  assert.equal(transitionTravel({ transform: 'none' }, { transform: 'scale(1.05)' }).text, 'scale 1 → 1.05');
});

test('a friction record (a glide that keeps a fixed share of its distance each frame) reads as a smooth follow with its time constant', () => {
  // measured on a real glide: friction 0.90484 per 60 Hz frame = exp(-1/10), a 166.7 ms time constant (Lenis lerp 0.1)
  const rec = { schema: 'reva.motion/0', target: { el: 0, desc: 'HTML', channel: 'ren:by' }, attribution: { label: 'pointer', provenance: 'inferred' }, tier: 'fitted', class: 'friction',
    model: { family: 'friction:per-frame', params: { friction: { value: 0.9048442497764999, provenance: 'fitted', unit: null, ci95: [0.90483, 0.90486] }, v0: { value: -229, provenance: 'fitted', unit: 'value/frame' } }, valid_at: { frame_ms: 16.6667, refresh_hz: 60 } }, derived: { t0: 2200 } };
  const [l] = describeElement([rec], { oneRate: 60 });
  assert.equal(l.kind, 'smoothing');
  assert.match(l.text, /^Smooth follow of .*time constant 166\.7 ms \[fitted\].*closes 9\.5\d+ % \[fitted\] of the gap each 60 Hz frame/);
});

test('notFromAction: a click handler that runs at the release (1 s after the hover began) still counts when it plays on its own time', () => {
  const line = { trigger: 'plays on its own time', t0: 1200 };
  assert.ok(notFromAction(line, 300, 'click'), 'measured from the first input it is 900 ms late');
  assert.equal(notFromAction(line, 300, 'click', undefined, 1000), null, '200 ms after the release: within the lag');
  assert.equal(notFromAction({ trigger: 'starts on press (button held down)', t0: 700 }, 300, 'click'), null);
});
