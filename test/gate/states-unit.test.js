// Stage D2 pure helpers: state plan (set cover over state rules), JS candidates per component, coverage reasons,
// screenshot clip, structural replay plan. No browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statePairs, planCssStates, coverStates, planJsStates, clipFor, stateCoverage, jsCoverage } from '../../src/gate/states.js';
import { structureAt } from '../../src/gate/scriptowned.js';

const table = {
  rules: [
    { id: 0, t: 'style', sel: '.btn:hover' }, { id: 1, t: 'style', sel: '.card:hover h2' }, { id: 2, t: 'style', sel: '.btn:focus-visible' },
    { id: 3, t: 'style', sel: '.x:popover-open' }, { id: 4, t: 'style', sel: '.btn:hover::before' },
  ],
  els: [{ k: 'html/body[1]/button[1]', st: [0, 2], pe: { '~before': [4] } }, { k: 'html/body[1]/article[1]/h2[1]', st: [1] }, { k: 'html/body[1]/div[1]', st: [3] }],
};

test('statePairs lists st and ~pseudo-element candidates', () => {
  const p = statePairs(table);
  assert.equal(p.length, 5);
  assert.deepEqual(p.find(x => x.rid === 4), { rid: 4, sel: '.btn:hover::before', k: 'html/body[1]/button[1]', pe: 'before' });
});

test('planCssStates groups rules by target + pseudo-classes, covers all, lists unforceable', () => {
  const B = 'html/body[1]/button[1]', A = 'html/body[1]/article[1]';
  const resolved = [
    { rid: 0, k: B, targets: [{ k: B, pc: ['hover'] }] }, { rid: 4, k: B, targets: [{ k: B, pc: ['hover'] }] },
    { rid: 2, k: B, targets: [{ k: B, pc: ['focus-visible'] }] }, { rid: 1, k: A + '/h2[1]', targets: [{ k: A, pc: ['hover'] }] },
    { rid: 3, k: 'html/body[1]/div[1]', targets: [{ k: 'html/body[1]/div[1]', pc: ['popover-open'] }] },
  ];
  const plan = planCssStates(table, resolved, { visibleKeys: new Set([A, B]) });
  assert.equal(plan.states.length, 3);
  assert.deepEqual(plan.states[0].rules.sort(), [0, 4], 'largest state first');
  assert.deepEqual(plan.unforceable, { 3: ['popover-open'] });
  assert.deepEqual(plan.uncovered, []);
  const capped = planCssStates(table, resolved, { max: 1 });
  assert.deepEqual(capped.uncovered.sort(), [1, 2]);
});

test('coverStates picks the fewest states', () => {
  const m = new Map([['a', { rules: new Set([1, 2]) }], ['b', { rules: new Set([2, 3]) }], ['c', { rules: new Set([1, 2, 3]) }]]);
  assert.deepEqual(coverStates(m).chosen, ['c']);
});

test('planJsStates: one representative per component, harness only for uncontrolled dialogs/popovers', () => {
  const c = [
    { k: 'a', how: 'aria-expanded', sig: 'aria-expanded|button||face', label: 'Preview 1', visible: true },
    { k: 'b', how: 'aria-expanded', sig: 'aria-expanded|button||face', label: 'Preview 2', visible: true },
    { k: 'h', how: 'tab', sig: 'tab|a|tab|tab', label: 'Hidden tab', visible: false },
    { k: 'd', how: 'dialog', sig: 'dialog|dialog||sb', label: 'Terms', visible: false, harness: true },
  ];
  const p = planJsStates(c);
  assert.deepEqual(p.states.map(s => [s.k, s.sameComponent.length, !!s.harness]), [['a', 1, false], ['d', 0, true]]);
  assert.deepEqual(p.states[0].actions, [{ click: 'a' }]);
  assert.match(p.states[1].actions[0].eval, /showModal\(\)$/);
  assert.equal(p.skipped[0].why, 'no visible enabled member');
});

test('clipFor spans changed elements and targets, full width, clamped', () => {
  const snap = (els, docH = 2000) => ({ vw: 800, vh: 600, docH, pl: ['color'], vt: ['red', 'blue'], els });
  const a = snap([{ k: 'x', b: [0, 100, 50, 20], t: '', s: [0, 0] }, { k: 'y', b: [0, 900, 50, 20], t: '', s: [0, 0] }]);
  const b = snap([{ k: 'x', b: [0, 100, 50, 20], t: '', s: [0, 0] }, { k: 'y', b: [0, 900, 50, 20], t: '', s: [0, 1] }]);
  assert.deepEqual(clipFor(a, b, ['x']), { x: 0, y: 76, width: 800, height: 868 });
  assert.deepEqual(clipFor(a, a, []), { x: 0, y: 0, width: 800, height: 600 });
});

test('structureAt: text and inserted nodes replay from recorded output; unrecorded ones stay excluded', () => {
  const swP = { els: {
    'html/body[1]/ul[1]': { childList: { cur: 'li,li,li', html: '<li>a</li><li>b</li><li>c</li>' } },
    'html/body[1]/p[1]': { text: { cur: 'new text' } },
  } };
  const own = [
    { k: 'html/body[1]/ul[1]/li[3]', how: 'inserted', names: {} }, { k: 'html/body[1]/ul[1]/li[1]', how: 'written', names: { text: {} } },
    { k: 'html/body[1]/p[1]', how: 'written', names: { text: {} } }, { k: 'html/body[1]/div[9]', how: 'removed', names: {} },
  ];
  const { replay, rest } = structureAt(own, swP);
  assert.deepEqual(replay, [{ k: 'html/body[1]/ul[1]', html: '<li>a</li><li>b</li><li>c</li>' }, { k: 'html/body[1]/p[1]', text: 'new text' }]);
  assert.deepEqual(rest.map(e => e.k), ['html/body[1]/div[9]'], 'li[1] text is under the replayed list');
});

test('stateCoverage: exercised or a reason for every state rule', () => {
  const t = { coverage: { unused: [
    { id: 0, sel: '.btn:hover', why: ['state'] }, { id: 5, sel: '.ghost:hover', why: ['state', 'no-element'] },
    { id: 6, sel: '.x:hover', why: ['media-inactive', 'state'] }, { id: 3, sel: '.x:popover-open', why: ['state'] },
    { id: 7, sel: '.m[aria-expanded="true"]', why: ['state'] }, { id: 8, sel: '.grid', why: ['media-inactive'] },
  ] } };
  const plan = { css: { unforceable: { 3: ['popover-open'] }, unresolved: {}, uncovered: [], states: [] } };
  const c = stateCoverage(t, plan, new Map([[0, new Set(['c1'])]]));
  assert.equal(c.stateRules, 5);
  assert.equal(c.exercised, 1);
  const why = Object.fromEntries(c.rows.map(r => [r.id, r.reason || r.status]));
  assert.equal(why[0], 'exercised');
  assert.match(why[5], /dead CSS/);
  assert.match(why[6], /condition inactive/);
  assert.match(why[3], /not forceable/);
  assert.match(why[7], /attribute/);
});

test('planJsStates: listener candidates (D2b) get the input their listener needs, after ARIA/HTML ones', () => {
  const c = (k, how, sig, extra = {}) => ({ k, how, sig: `${how}|${sig}`, label: k, visible: true, disabled: false, harness: false, ...extra });
  const cands = [
    c('html/body[1]/button[1]', 'aria-expanded', 'button||menu'),
    c('html/body[1]/div[1]', 'listener:click', 'div||swatch', { events: ['click'] }),
    c('html/body[1]/div[2]', 'listener:click', 'div||swatch', { events: ['pointerdown'] }),
    c('html/body[1]/span[1]', 'listener:hover', 'span||tip', { events: ['mouseenter'] }),
    c('html/body[1]/input[1]', 'listener:key', 'input||q', { events: ['keydown'] }),
    c('html/body[1]/i[1]', 'listener:focus', 'i||f', { events: ['focusin'], visible: false }),
  ];
  const p = planJsStates(cands, { max: 3 });
  assert.deepEqual(p.states.map(s => [s.how, s.actions]), [
    ['aria-expanded', [{ click: 'html/body[1]/button[1]' }]],
    ['listener:click', [{ click: 'html/body[1]/div[1]' }]],
    ['listener:hover', [{ hover: 'html/body[1]/span[1]' }]],
  ]);
  assert.equal(p.states[1].sameComponent.length, 1, 'one representative per component');
  assert.deepEqual(p.states[1].events, ['click']);
  assert.deepEqual(p.skipped.map(s => s.why), ['cap 3', 'no visible enabled member']);
  const p2 = planJsStates(cands.slice(4, 5), { max: 3 });
  assert.deepEqual(p2.states[0].actions, [{ focus: 'html/body[1]/input[1]' }, { press: 'Enter' }]);
  // coverage: exercised, skipped, excluded and delegated listeners all listed with a source and a reason
  p.listeners = { scanned: 40, candidates: 5, excluded: [{ k: 'html/body[1]/a[1]', sig: 'listener:click|a||nav', events: ['click'], reason: 'navigates (a[href=/x])' }], delegated: { document: ['click', 'keydown'] } };
  const cov = jsCoverage(p);
  assert.equal(cov.exercised, 3);
  assert.equal(cov.rows, 7);
  assert.deepEqual(cov.bySource, { 'aria/html': { exercised: 1 }, listener: { exercised: 2, 'cap 3': 1, 'no visible enabled member': 1, 'navigates': 1, 'listener on document/window': 1 } });
  assert.ok(cov.list.filter(r => r.status !== 'exercised').every(r => r.reason));
});
