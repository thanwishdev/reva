// look on its edge cases, own fixtures only (fixtures/look/*.html, localhost; no site data, no internet): readiness
// before the action, the retry and "no-motion", the moving-set cap with on-screen priority, per-group stagger, and
// planned channels that end with no record (each must be reported, never dropped silently).
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveFixture } from '../helpers.js';
import { runLook } from '../../src/look/index.js';
import { formatLook, noCodeStacks } from '../../src/look/cli.js';

const near = (a, b, rel) => Math.abs(a - b) <= rel * Math.abs(b);
const pv = (rec, k) => rec.model.params[k] && rec.model.params[k].value;
let srv;
test.before(async () => { srv = await serveFixture('look'); });
test.after(async () => { await srv.close(); });
const look = (page, o) => runLook({ input: `${srv.origin}/${page}`, write: false, design: false, ...o });

test('readiness: a hover listener wired by a script that arrives 1.2 s after "load" is waited for (no retry needed)', async () => {
  const r = await look('late.html', { action: 'hover', el: '#late' });
  assert.equal(r.ready && r.ready.ok, true, JSON.stringify(r.ready));
  assert.ok(r.ready.wallMs >= 1000, `waited for the late bundle (${r.ready.wallMs} ms wall)`);
  assert.equal(r.ok, true); assert.equal(r.status, 'motion'); assert.equal(r.take.net.misses, null);
  assert.equal(r.action.retried, undefined, 'the first hover was seen');
  const tw = r.motions[0].records.find((x) => x.target.channel === 'ren:ty');
  assert.ok(tw && tw.tier !== 'unknown', r.motions[0].records.map((x) => `${x.target.channel}:${x.model.family}`).join(','));
  assert.ok(near(pv(tw, 'D'), 300, 0.03), `D ${pv(tw, 'D')}`);
});

test('an aimed element that never reacts: retried once, then no-motion, ok:false, with a warning', async () => {
  const r = await look('late.html', { action: 'hover', el: '#dead' });
  assert.equal(r.status, 'no-motion'); assert.equal(r.ok, false);
  assert.ok(r.action.retried && /no --el element changed/.test(r.action.retried.why), JSON.stringify(r.action));
  assert.ok(r.warnings.some((w) => /did not change during the hover/.test(w)), r.warnings.join(' | '));
  assert.ok(r.warnings.some((w) => /repeated after the page settled again/.test(w)), r.warnings.join(' | '));
  assert.match(formatLook(r), /No motion found on the chosen element\(s\) during this hover \(see the warnings above\)/);
});

test('moving-set cap (top-N, capPolicy viewport): distinct elements counted, on-screen newcomers evict off-screen ones', async () => {
  const r = await look('cap.html', { action: 'load', maxElements: 5, top: 1 });
  assert.deepEqual(r.take.capped, { cap: 5, notSampled: 4, evicted: 3 }, JSON.stringify(r.take.capped));
  assert.equal(r.take.watched, 5);
  assert.ok(r.warnings.some((w) => /more moving elements than the 5 watched \(4 not sampled, 3 off-screen ones swapped/.test(w)), r.warnings.join(' | '));
  const nearM = r.motions.find((m) => m.desc === 'DIV.near');
  assert.ok(nearM && nearM.count === 3, r.motions.map((m) => `${m.desc}×${m.count}`).join(','));
  assert.equal(nearM.selector, 'div.near', 'the class selector matches exactly the three');
});

test('two interleaved staggered groups: each stagger counts only its own members', async () => {
  const r = await look('groups.html', { action: 'load', top: 2 });
  const dot = r.motions.find((m) => m.desc === 'DIV.dot'), bar = r.motions.find((m) => m.desc === 'DIV.bar');
  assert.ok(dot && bar, r.motions.map((m) => m.desc).join(','));
  assert.equal(dot.count, 3); assert.equal(bar.count, 4);
  assert.ok(dot.stagger && bar.stagger, 'both folded with a stagger');
  assert.match(dot.stagger.text, /^Stagger: 3 of 3 start one after another, every 100 ms/, dot.stagger.text);
  assert.match(bar.stagger.text, /^Stagger: 4 of 4 start one after another, every 70 ms/, bar.stagger.text);
  const own = (m) => new Set(m.stagger.group.members.map((x) => +String(x).split('|')[0]));
  assert.ok([...own(dot)].every((id) => dot.ids.includes(id)), 'dot stagger members are dots');
  assert.ok([...own(bar)].every((id) => bar.ids.includes(id)), 'bar stagger members are bars');
});

test('planned channels with no record are reported: an equivalent-forms transform switch, an unread filter change', async () => {
  const r = await look('forms.html', { action: 'load', el: '#forms' });
  const m = r.motions[0];
  assert.ok(m.records.some((x) => x.target.channel === 'ren:opacity'), 'the real motion is fitted');
  assert.ok(!m.records.some((x) => /transform$/.test(x.target.channel)), 'no record for the transform string (no fake 3 -> 0 step)');
  const tf = r.unknowns.find((u) => u.channel === 'drv:transform');
  assert.ok(tf, JSON.stringify(r.unknowns));
  assert.equal(tf.kind, 'below noise'); assert.match(tf.reason, /switches between equivalent forms .*translate3d\(0px, 0px, 0px\).*: the rendered transform does not change, not motion/);
  const fl = r.unknowns.find((u) => u.channel === 'ren:filter');
  assert.ok(fl && fl.reason && /4px/.test(fl.reason) && /12px/.test(fl.reason), JSON.stringify(r.unknowns));
  const text = formatLook(r);
  assert.doesNotMatch(text, /Instant change: 3 → 0/);
  // "not motion" lines are noise by default (one summary line); --verbose prints them (recheck item 16)
  assert.doesNotMatch(text, /switches between equivalent forms/); assert.match(text, /changed form but not on screen: not motion; --verbose shows them/);
  assert.match(formatLook(r, { verbose: true }), /switches between equivalent forms/);
});

test('a perspective zoom (3D, m34 / m44 only) is motion: fitted, never "equivalent forms" / below noise', async () => {
  const r = await look('persp.html', { action: 'load', el: '#p' });
  assert.equal(r.status, 'motion'); assert.equal(r.take.net.misses, null);
  const tw = r.motions[0].records.find((x) => x.target.channel === 'drv:transform');
  assert.ok(tw && tw.model.family === 'named:easeOutCubic', r.motions[0].records.map((x) => `${x.target.channel}:${x.model.family}`).join(','));
  assert.ok(near(pv(tw, 'D'), 800, 0.03), `D ${pv(tw, 'D')}`);
  assert.ok(!r.unknowns.some((u) => u.kind === 'below noise'), JSON.stringify(r.unknowns));
  const ren = r.unknowns.find((u) => u.channel === 'ren:transform');
  assert.ok(ren && /changes in m34, m44 \(perspective: a 3D zoom\)/.test(ren.reason), JSON.stringify(r.unknowns));
  assert.doesNotMatch(formatLook(r), /equivalent forms/);
  // the same change as a CSS transition: no fitted model on the matrix, said honestly (not "not motion")
  const c = await look('persp.html', { action: 'load', el: '#cssp' });
  assert.equal(c.status, 'motion');
  assert.ok(c.unknowns.length && c.unknowns.every((u) => u.kind !== 'below noise'), JSON.stringify(c.unknowns));
  assert.doesNotMatch(formatLook(c), /equivalent forms|not motion/);
});

test('moving nodes replaced before the take ends (hydration): the successors\' selector, with the reason', async () => {
  const r = await look('gone.html', { action: 'load' });
  const m = r.motions.find((x) => x.desc === 'DIV.tile.in');
  assert.ok(m && m.count === 4, r.motions.map((x) => `${x.desc}×${x.count}`).join(','));
  assert.equal(m.selector, 'div.tile.in'); assert.equal(m.selectorGone, true);
  assert.equal(m.selectorWhy, 'the original nodes were replaced; this matches their successors');
  assert.match(formatLook(r), /DIV\.tile\.in ×4 {3}\(div\.tile\.in: the original nodes were replaced; this matches their successors\)/);
  // the printed selector reproduces the motion
  const a = await look('gone.html', { action: 'load', el: m.selector });
  const ty = a.motions.flatMap((x) => x.records).find((x) => x.target.channel === 'ren:ty');
  // the tiles' own CSS transition (siblings share the descriptor) is the declared law: its duration exactly; a fit says D
  assert.ok(ty && near(pv(ty, 'D') ?? pv(ty, 'duration'), 500, 0.03), JSON.stringify(a.motions.map((x) => x.lines.map((l) => l.text))));
});

test('top-N on the same page twice: the same action time, ranks and selectors (network holds virtual time); --pick by key', async () => {
  const once = async () => {
    const r = await look('steady.html', { action: 'hover', on: '720,450' });
    return { r, sig: { frames: r.take.frames, ready: r.ready && [r.ready.ok, r.ready.virtualMs], rows: r.motions.map((m) => [m.rank, m.desc, m.selector, m.weightShare.toFixed(6)]) } };
  };
  const a = await once(), b = await once();
  assert.deepEqual(b.sig, a.sig);
  assert.ok(a.r.take.netGate && a.r.take.netGate.waitedMs >= 400, `virtual time waited for the late script (${JSON.stringify(a.r.take.netGate)})`);
  // the preloader played out before the hover: the hover's own motion is ranked, not the loader
  assert.deepEqual(a.r.motions.map((m) => m.selector), ['#card', 'div.dot'], JSON.stringify(a.sig));
  assert.ok(!/--pick, rank/.test(formatLook(a.r)), 'no --pick rank printed as a fallback');
  // --pick by a stable key (the printed selector)
  const p = await look('steady.html', { action: 'hover', on: '720,450', pick: 'div.dot' });
  assert.equal(p.action.picked.desc, 'DIV.dot'); assert.equal(p.action.picked.key, 'div.dot');
  assert.equal(p.motions.length, 1); assert.equal(p.motions[0].count, 3);
});

test('a cancel (AbortSignal) closes the browser and fails the look fast with code "cancelled"', async () => {
  const ac = new AbortController(); const t0 = Date.now();
  setTimeout(() => ac.abort(), 400);
  await assert.rejects(look('late.html', { action: 'hover', el: '#late', signal: ac.signal }), (e) => e.code === 'cancelled');
  assert.ok(Date.now() - t0 < 15000, `stopped in ${Date.now() - t0} ms`); // wide: launch time under load counts too; the claim is the rejection
});

test('a local URL by loopback IP (127.0.0.1) opens like localhost; names and other IPs still go nowhere', async () => {
  const r = await runLook({ input: `http://127.0.0.1:${srv.port}/late.html`, write: false, design: false, action: 'hover', el: '#late' });
  assert.equal(r.status, 'motion'); assert.equal(r.take.net.misses, null);
  const { launchBrowser } = await import('../../src/browser/launch.js');
  const { OFFLINE_ARGS } = await import('../../src/replay/target.js'); const { LOCAL_ARGS } = await import('../../src/look/index.js');
  const h = await launchBrowser({ args: [...OFFLINE_ARGS, ...LOCAL_ARGS] }); // the session's order: sinkhole, then the look's args
  try {
    await h.page.goto(`http://127.0.0.1:${srv.port}/late.html`);
    const out = await h.page.evaluate(async () => Promise.all(['http://example.com/', 'http://10.255.255.1/'].map((u) => fetch(u, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked'))));
    assert.deepEqual(out, ['blocked', 'blocked']);
  } finally { await h.close(); }
});

test('CLI usage errors: --pick 0 / 1.5 / out of range and an invalid --el are one line, never a stack or a silent top-N (recheck items 11, 12)', async () => {
  const { runLookCommand } = await import('../../src/look/cli.js');
  const errs = []; const err0 = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const url = `${srv.origin}/index.html`;
    assert.equal(await runLookCommand({ _: ['look', url], pick: '0' }), 2); assert.match(errs.at(-1), /a rank starts at 1/);
    assert.equal(await runLookCommand({ _: ['look', url], pick: '1.5' }), 2); assert.match(errs.at(-1), /whole number/);
    assert.equal(await runLookCommand({ _: ['look', url], el: 'div[' }), 2); assert.equal(errs.at(-1), '--el "div[" is not a valid CSS selector');
    assert.equal(await runLookCommand({ _: ['look', url], pick: '99' }), 1); assert.match(errs.at(-1), /^look --pick: no entry ranked 99: ranks 1-\d+ exist in this run/);
    assert.ok(!errs.some((e) => /\n\s+at /.test(e)), 'no stack trace');
  } finally { console.error = err0; }
});

test('a moving element with no class or id: the printed selector is a DOM path (:nth-of-type) that aims at it again (recheck item 15)', async () => {
  const top = await look('paths.html', { action: 'load' });
  const m = top.motions[0]; assert.ok(m, top.status);
  assert.match(String(m.selector), /:nth-of-type\(2\)/, String(m.selector)); assert.equal(m.selectorMatches, 1);
  const tw = (r) => r.motions[0].records.find((x) => x.target.channel === 'ren:tx');
  const again = await look('paths.html', { action: 'load', el: m.selector });
  assert.equal(again.status, 'motion'); assert.equal(again.motions.length, 1);
  assert.ok(tw(top) && tw(again), 'both runs fit x'); assert.ok(near(pv(tw(again), 'duration') ?? pv(tw(again), 'D'), 600, 0.03));
});

test('a page that grows while it is scrolled: the page height is recorded and the text warns that scroll-linked values depend on it (recheck item 6)', async () => {
  const r = await look('grow.html', { action: 'scroll', n: 30 });
  assert.ok(r.action.pageHeight && r.action.pageHeight.start > 0, JSON.stringify(r.action.pageHeight));
  assert.ok(r.action.pageHeight.end > r.action.pageHeight.start, JSON.stringify(r.action.pageHeight));
  assert.ok(r.warnings.some((w) => /the page grew from \d+ to \d+ px during the scroll .* can differ between runs/.test(w)), r.warnings.join(' | '));
  assert.match(formatLook(r), /· page \d+ px tall/);
});

// ---- recording rate for a URL: the corpus rule (60 Hz when one canvas covers more than 30 % of the viewport) ----
test('rate: a canvas over the page records at 60 Hz, said in look.json; a small canvas and an explicit --rate keep their rate', async () => {
  {
    const base = { write: false, design: false, action: 'load', el: '#box' };
    const big = await runLook({ ...base, input: srv.origin + '/canvas-big.html' });
    assert.equal(big.take.rate, 60, 'big canvas -> 60 Hz');
    assert.ok(big.take.rateRule && big.take.rateRule.from === 120 && big.take.rateRule.canvasCover >= 0.99, JSON.stringify(big.take.rateRule));
    assert.equal(big.ok, true, big.errors.join(' '));
    assert.match(formatLook(big), /at 60 Hz \(a canvas covers 100 % of the viewport, so 60 Hz, not 120\)/);
    const small = await runLook({ ...base, input: srv.origin + '/canvas-big.html?small=1' });
    assert.equal(small.take.rate, 120); assert.equal(small.take.rateRule, null);
    const forced = await runLook({ ...base, input: srv.origin + '/canvas-big.html', rate: 120 });
    assert.equal(forced.take.rate, 120, 'the caller chose the rate'); assert.equal(forced.take.rateRule, null);
  }
});

// ---- paint-only motion (colour / background / shadow): declared by the page, not sampled ----
test('declared only: a colour hover transition is reported exact (timing, easing, end values), not "no motion"', async () => {
  const r = await look('colorhover.html', { action: 'hover', el: '#cta' });
  assert.equal(r.ok, true, JSON.stringify(r.warnings)); assert.equal(r.status, 'motion');
  assert.equal(r.motions.length, 0, 'nothing sampled moved');
  assert.equal(r.declaredOnly.length, 1, JSON.stringify(r.declaredOnly));
  const d = r.declaredOnly[0];
  assert.equal(d.kind, 'css-transition'); assert.equal(d.desc, 'A#cta'); assert.equal(d.selector, '#cta'); assert.equal(d.durationMs, 200); assert.equal(d.easing, 'ease-in-out'); assert.equal(d.label, 'exact');
  const bg = d.properties.find((p) => p.prop === 'background-color');
  assert.deepEqual([bg.from, bg.to], ['rgb(1, 114, 173)', 'rgb(2, 101, 154)']);
  assert.ok(d.properties.some((p) => p.prop === 'border-color' && p.to === 'rgb(2, 101, 154)'), 'four sides folded into border-color: ' + d.properties.map((p) => p.prop));
  assert.match(d.css, /^transition: background-color 200ms ease-in-out, /);
  assert.ok(!r.warnings.some((w) => /did not change/.test(w)), r.warnings.join(' | '));
  const text = formatLook(r, { code: ['css'] });
  assert.match(text, /CSS transition: background-color rgb\(1, 114, 173\) → rgb\(2, 101, 154\).*200 ms \[exact\], ease-in-out \[exact\]/);
  assert.doesNotMatch(text, /No motion found/);
});

test('declared only: an element with no transition is still "no motion"; a transform motion is not duplicated', async () => {
  const none = await look('colorhover.html', { action: 'hover', el: '#plain' });
  assert.equal(none.declaredOnly.length, 0); assert.equal(none.status, 'no-motion'); assert.equal(none.ok, false);
  const tf = await look('index.html', { action: 'hover', el: '#btn' });
  assert.equal(tf.declaredOnly.length, 0, 'a scale transition is sampled and fitted, not declared-only');
});

test('status: elements that were all moving before the action are not "motion" (ok false, nothing to report)', async () => {
  // an ambient spinner runs from the first frame; a hover on empty space caused nothing: top-N lists only what the hover
  // caused, so the result is no-motion (it was ok:true with an empty list when `moved` counted the spinner)
  const r = await look('ambient.html', { action: 'hover', on: '5,5' });
  assert.equal(r.motions.length, 0, r.motions.map((m) => m.desc).join(','));
  assert.equal(r.ok, false); assert.equal(r.status, 'no-motion');
  assert.ok((r.alreadyMoving || []).length >= 1, 'the spinner is listed apart');
});

test('hover: the page\'s own load tween running while the tool hovers is not the hover result (said in one line)', async () => {
  const r = await look('intro.html', { action: 'hover', el: '#intro' });
  assert.equal(r.motions.length, 0, r.motions.map((m) => m.lines.map((l) => l.text).join('/')).join(' | '));
  assert.equal(r.notFromAction.length, 1); assert.match(r.notFromAction[0].lines[0].why, /page load/);
  assert.equal(r.ok, false);
  const text = formatLook(r);
  assert.match(text, /^No change on hover seen for #intro during the take\.$/m);
  assert.doesNotMatch(text, /plays on its own time/);
  // a real hover reaction on the same page is still reported
  const h = await look('intro.html', { action: 'hover', el: '#real' });
  assert.equal(h.notFromAction.length, 0); assert.ok(h.motions.length && h.ok, 'real hover kept');
});

test('--code: every requested stack with no output gets one plain line', async () => {
  const r = await look('intro.html', { action: 'hover', el: '#real' });
  const t = formatLook(r, { code: ['css', 'lenis', 'raf'] });
  assert.match(t, /^lenis: no code \(this motion is not page-scroll smoothing\)$/m);
  assert.doesNotMatch(t, /^css: no code/m, 'css printed code');
  assert.equal(noCodeStacks(r, ['lenis']).length, 1);
  assert.deepEqual(noCodeStacks({ motions: [], action: { do: 'hover' } }, ['gsap']).map((x) => x.why), ['no motion to write code for']);
});
