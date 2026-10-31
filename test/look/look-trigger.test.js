// look trigger search and the scroll stall driver, end to end on fixtures/look-trigger (localhost only; synthetic).
// Known by construction (see the fixture):
//   #box     in a closed <dialog>; only button.open opens it (no aria link); spring omega 9, zeta 0.7
//   lanes    a snapper holds each wheel gesture back after a 300 px commit until the wheel is quiet for 320 ms
//   #late    at the bottom: translateX = (scrollY - 4200) / 4
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveFixture } from '../helpers.js';
import { runLook, wheelStep, WHEEL_STALL } from '../../src/look/index.js';
import { stateChanged, restChanged, declaredReaction } from '../../src/look/select.js';

const near = (a, b, rel) => Math.abs(a - b) <= rel * Math.abs(b);
const pv = (rec, k) => rec.model.params[k] && rec.model.params[k].value;
let srv;
test.before(async () => { srv = await serveFixture('look-trigger'); });
test.after(async () => { await srv.close(); });
const look = (o) => runLook({ input: srv.origin + '/', write: false, design: false, ...o });

test('click aimed at an element in a closed dialog: the opener is found and the spring is read', async () => {
  const r = await look({ action: 'click', el: '#box' });
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  const ts = r.action.triggerSearch;
  assert.ok(Array.isArray(ts) && ts.length, JSON.stringify(r.action));
  assert.equal(ts[0].status, 'hidden');
  assert.match(ts[0].chosen.on, /button\.open/);
  assert.match(r.action.on, /button\.open/);
  const m = r.motions[0]; assert.ok(m, 'box motion');
  const sp = m.records.find((x) => x.model.family === 'spring');
  assert.ok(sp, m.records.map((x) => x.model.family).join(','));
  assert.ok(near(pv(sp, 'omega'), 9, 0.03) && near(pv(sp, 'zeta'), 0.7, 0.03), `ω ${pv(sp, 'omega')} ζ ${pv(sp, 'zeta')}`);
});

test('scroll past a lane snapper: the wheel pauses at each held gesture, goes on to the bottom and reads #late', async () => {
  const r = await look({ action: 'scroll', el: '#late' });
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.ok(r.action.pauses >= 3, JSON.stringify(r.action));
  assert.equal(r.action.stop, 'bottom', JSON.stringify(r.action));
  const m = r.motions[0]; assert.ok(m, 'late motion');
  assert.ok(m.channels.includes('ren:tx'), m.channels.join(','));
});

test('wheel step and stall settings; state comparison ignores nothing that matters', () => {
  assert.equal(wheelStep(20000), 100); assert.equal(wheelStep(3000), 50); assert.equal(wheelStep(600), 40); assert.equal(wheelStep(null), 100);
  assert.ok(WHEEL_STALL.pauseMs >= 400 && WHEEL_STALL.maxPauses >= 2);
  const s = (o) => ({ n: 1, els: [{ shown: true, own: '1|none', size: '10,10', box: '0,0', run: 0, ...o }] });
  assert.equal(stateChanged(s({}), s({})).changed, false);
  assert.equal(stateChanged(s({}), s({ own: '0.5|none' })).own, true);
  assert.equal(stateChanged(s({}), s({ shown: false })).shown, true);
  assert.equal(stateChanged({ n: 0, els: [] }, s({})).created, true);
});

// covered.html: .t is shown but a transparent .scrim covers it; .card:hover moves .t (CSS transition 600 ms). The plain
// hover must run first: probing controls before it (the menu button) would cover the page and lose the motion.
test('hover on a target under a transparent scrim: the plain hover runs first and reads the CSS transition', async () => {
  const r = await runLook({ input: srv.origin + '/covered.html', write: false, design: false, action: 'hover', el: '.t' });
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.equal(r.status, 'motion', JSON.stringify(r.action));
  assert.equal(r.action.triggerSearch, undefined, JSON.stringify(r.action));
  const rec = r.motions[0].records[0];
  assert.equal(rec.model.family, 'declared:css');
  assert.equal(pv(rec, 'duration'), 600);
  assert.match(String(pv(rec, 'easing')), /cubic-bezier\(0\.2, 0\.7, 0\.3, 1\)/);
});

// a search that finds nothing has clicked around the page (the menu is open): the measured take starts again from a
// fresh page with the search off
test('a trigger search that finds nothing restarts from a fresh page', async () => {
  const r = await runLook({ input: srv.origin + '/covered.html', write: false, design: false, action: 'click', el: '.badge' });
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  const ts = r.action.triggerSearch;
  assert.ok(Array.isArray(ts) && ts.length === 1, JSON.stringify(r.action));
  assert.equal(ts[0].chosen, null); assert.equal(ts[0].restarted, true);
  assert.ok(ts[0].tried.some((t) => /burger/.test(t.selector)), JSON.stringify(ts[0].tried));
});

// virtual.html: scrollY never moves (wheel prevented, content translated); the stall rule must not stop the wheel
test('virtual scroller: the wheel goes on until the aimed element has left, not stopped as stalled', async () => {
  const r = await runLook({ input: srv.origin + '/virtual.html', write: false, design: false, action: 'scroll', el: '#t' });
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.equal(r.action.stop, 'until', JSON.stringify(r.action));
  assert.equal(r.action.virtualScroll, true);
  assert.ok(r.action.wheels >= 60, JSON.stringify(r.action));
  assert.ok(r.motions[0] && r.motions[0].channels.includes('ren:by'), JSON.stringify(r.motions.map((m) => m.channels)));
});

// reveal.html: .link is transparent when the page is ready (a load fade with a 1800 ms delay). It is a reveal, not a
// hidden target: look waits for it, then hovers .link itself and reads its transition (no control is credited)
test('a transparent target is a pending reveal: look waits for it and the plain hover reads the transition', async () => {
  const r = await runLook({ input: srv.origin + '/reveal.html', write: false, design: false, action: 'hover', el: '.link' });
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.equal(r.action.on, null, JSON.stringify(r.action));
  assert.ok(!r.action.triggerSearch, JSON.stringify(r.action.triggerSearch));
  assert.ok(r.action.revealWait && r.action.revealWait.status !== 'hidden', JSON.stringify(r.action));
  const rec = r.motions[0] && r.motions[0].records[0]; assert.ok(rec, JSON.stringify(r.motions));
  assert.equal(rec.model.family, 'declared:css');
  assert.equal(pv(rec, 'duration'), 300);
});

// clickonly.html: hovering .card does nothing until button.live is clicked. The search must return the button as
// `after` (click it first, then hover the card), never as the hover trigger
test('hover look: a control that changes the target only on click is clicked first (after), never hovered (on)', async () => {
  const r = await runLook({ input: srv.origin + '/clickonly.html', write: false, design: false, action: 'hover', el: '.card' });
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  const ts = r.action.triggerSearch; assert.ok(Array.isArray(ts) && ts.length, JSON.stringify(r.action));
  assert.ok(ts[0].chosen && /button\.live/.test(ts[0].chosen.after || ''), JSON.stringify(ts));
  assert.equal(ts[0].chosen.on, undefined, JSON.stringify(ts));
  assert.match(r.action.after || '', /button\.live/);
  assert.equal(r.action.on, null);
  const rec = r.motions[0] && r.motions[0].records.find((x) => x.model.family === 'declared:css');
  assert.ok(rec, JSON.stringify(r.motions.map((m) => m.records.map((x) => x.model.family))));
  assert.equal(pv(rec, 'duration'), 400);
});

// underline.html: the hover grows a background-size underline (no sampled channel); the declared transition it started
// is the reaction, so no control is searched for (button.cta would change the link on click)
test('a hover that starts a declared transition on the target is a reaction: no trigger search', async () => {
  const r = await runLook({ input: srv.origin + '/underline.html', write: false, design: false, action: 'hover', el: '.u' });
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.equal(r.action.triggerSearch, undefined, JSON.stringify(r.action));
  assert.equal(r.action.on, null);
  assert.ok(r.action.reaction && /background-size/.test(r.action.reaction.declared), JSON.stringify(r.action));
});

// matches.html: the first .go is aria-current and ignores clicks; the look tries the other matches (fresh page each)
test('click with no reaction on the first match: another match of --el is tried before other controls', async () => {
  const r = await runLook({ input: srv.origin + '/matches.html', write: false, design: false, action: 'click', el: '.go' });
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.ok(r.action.otherMatches && r.action.otherMatches.chosen, JSON.stringify(r.action));
  assert.equal(r.action.triggerSearch, undefined, JSON.stringify(r.action));
  assert.ok(r.motions.length >= 1, JSON.stringify(r.motions));
  const rec = r.motions[0].records.find((x) => x.model.family === 'declared:css');
  assert.ok(rec && pv(rec, 'duration') === 300, JSON.stringify(r.motions[0].records.map((x) => [x.model.family, pv(x, 'duration')])));
});

test('rest and declared-reaction rules (pure)', () => {
  const s = (o) => ({ n: 1, els: [{ shown: true, inf: false, own: '1|none', size: '10,10', box: '0,0', run: 0, ...o }] });
  assert.equal(restChanged(s({}), s({})), false);
  assert.equal(restChanged(s({}), s({ own: '1|matrix(1,0,0,1,0,2)' })), true);
  assert.equal(restChanged(s({ inf: true }), s({ inf: true, own: '1|rotate' })), false, 'an endless loop never blocks rest');
  assert.equal(restChanged(s({ inf: true }), s({ inf: true, shown: false })), true);
  const births = [{ type: 'CSSTransition', name: 'background-size', tgt: 'A', T: 1650 }, { type: 'CSSAnimation', name: 'spin', tgt: 'SPAN.x::after', T: 900 }];
  assert.equal(declaredReaction(births, ['A'], 1633).name, 'background-size');
  assert.equal(declaredReaction(births, ['A'], 1700), null, 'before the action does not count');
  assert.equal(declaredReaction(births, ['SPAN.x'], 800).name, 'spin', 'a pseudo-element of the target counts');
  assert.equal(declaredReaction([{ type: 'Animation', name: 'waapi', tgt: 'A', T: 1650 }], ['A'], 1600), null);
});
