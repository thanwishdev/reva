// What a move's words say against what the screen shows (5 Nov /world mock): nested counter-moves, changes under what the eye sees,
// out-and-back tracks, odd percents, and moves that are no motion at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenOf } from '../src/scan/moves/group.js';
import { changeOf, clauseOf, notAMove, NOT_A_MOVE, sentenceOf } from '../src/scan/moves/intent.js';
import { cardIndex } from '../src/card/moves.js';
import { plainSentence } from '../src/scan/moves/name.js';

const view = { name: 'change-2' };
const run = (id, own, box, boxEnd, o = {}) => ({ id, key: `#e${id}`, view, doc: 0, k0: 822, k1: 882, lead: 'ren:tx', leadPart: null, from: 0, to: own, box, boxEnd, sy0: 0, sy1: 0, ...o });

test('screenOf: an inner element moving against its parent reads as what the screen shows (a menu on a 3D portfolio site)', () => {
  const inner = run(66, -590.391, [850, 0, 590, 900], [850, 0, 590, 900]), outer = run(70, 590.391, [850, 0, 590, 900], [1440, 0, 590, 900]);
  assert.deepEqual(screenOf([inner, outer], inner), { axis: 'x', px: 590, counter: true });
  // a plain slide: the screen agrees with the transform, so nothing is added
  const plain = run(1, -100, [500, 0, 50, 50], [400, 0, 50, 50]);
  assert.equal(screenOf([plain], plain), null);
  // another document or another take is not the same screen
  assert.equal(screenOf([inner, { ...outer, view: { name: 'change-2' } }], inner), null);
  assert.equal(screenOf([inner, { ...outer, doc: 1 }], inner), null);
  // y is read in page px: a box that rides a scroll did not move on its own
  const scrolled = run(3, -40, [0, 500, 10, 10], [0, 300, 10, 10], { lead: 'ren:ty', sy0: 0, sy1: 160 });
  assert.equal(screenOf([scrolled], scrolled), null);
});

test('the sentence follows the screen: the menu wipes right, it does not slide left', () => {
  const g = { name: 'Menu', count: 4, screen: { axis: 'x', px: 590.39, counter: true }, changes: [{ property: 'x', channel: 'ren:tx', family: 'move', unit: 'px', from: 0, to: -590.39 }], law: { class: 'tween', ms: 1000 } };
  assert.equal(sentenceOf({ kind: 'change' }, [g]), 'Between pages the menus wipe right 590.4 px, 1 s.');
  assert.equal(sentenceOf({ kind: 'change' }, [{ ...g, screen: undefined }]), 'Between pages the menus slide left 590.4 px, 1 s.');
  assert.equal(clauseOf(g.changes[0], { screen: { axis: 'x', px: -20, counter: false } }), 'slides left 20 px');
});

const track = (channel, family, y, raw = y) => ({ channel, family, part: '', T: y.map((_, i) => i * 16.7), y, sy: y.map(() => 0), raw, amp: Math.max(...y) - Math.min(...y) });
test('clauses: nothing under what the eye sees, out and back, odd percents, text and variables', () => {
  // a 1 px tall link that rises 17.5 px is not "1747 %"
  const c = changeOf(track('ren:ty', 'move', [0, -8, -17.5]), { box: [0, 0, 120, 1.0017] });
  assert.equal(c.percent, undefined); assert.equal(clauseOf(c), 'rises 17.5 px');
  // a 100 % rise of its own height stays a percent
  assert.equal(clauseOf(changeOf(track('ren:ty', 'move', [72.9, 30, 0]), { box: [0, 0, 100, 72.9] })), 'rises 100 %');
  assert.equal(clauseOf(changeOf(track('ren:opacity', 'fade', [0, 0.02, 0.04]))), null);
  assert.equal(clauseOf(changeOf(track('ren:opacity', 'fade', [0, 0.8, 0.01]))), 'flashes in and out');
  assert.equal(clauseOf(changeOf(track('ren:opacity', 'fade', [0.4, 0.7, 1]))), 'fades from 40 % to 100 %');
  assert.equal(clauseOf(changeOf(track('ren:sy', 'scale', [1, 1.002, 1.003]))), null);
  assert.equal(clauseOf(changeOf(track('ren:sy', 'scale', [1, 0.9, 1]))), 'scales down 10 % and back');
  assert.equal(clauseOf(changeOf(track('ren:ty', 'move', [0, -20, -0.5]))), 'rises 20 px and back');
  assert.equal(clauseOf(changeOf(track('ren:rz', 'rotate', [90, 90.2, 90.1]))), null);
  assert.equal(clauseOf({ property: 'text', channel: 'ren:text', family: 'text', from: 1, to: 2 }), 'counts up 1 → 2');
  assert.equal(clauseOf({ property: 'text', channel: 'ren:chars', family: 'text', from: 'ab', to: 'xy' }), 'scrambles its letters');
  assert.equal(clauseOf({ property: 'text', channel: 'ren:chars', family: 'text', from: 'ab', to: 'ab', back: true }), 'scrambles its letters and settles');
  assert.equal(clauseOf({ property: '--gradient-rotation', channel: 'ren:--gradient-rotation', family: 'var', from: 40.6, to: 381.29 }), 'runs --gradient-rotation 40.6 → 381.3');
  assert.equal(clauseOf({ property: '--x"><b>', channel: 'ren:--x', family: 'var', from: 0, to: 1 }), 'runs a CSS variable 0 → 1');
  // a change written before the fit has its channel: its family is read from it, never "moves"
  assert.equal(clauseOf({ property: 'opacity', channel: 'ren:opacity', from: 1, to: 0 }), 'fades out');
  assert.equal(clauseOf({ property: 'wght', channel: 'ren:wght', from: 400, to: 700 }), 'changes weight 400 → 700');
  assert.equal(clauseOf({ property: 'odd', from: 0, to: 1 }), null);
  assert.equal(clauseOf({ property: 'color', channel: 'ren:color', family: 'colour', from: 'rgb(0, 0, 0)', to: 'rgb(0, 0, 0)' }), null);
});

test('notAMove: a new page state or nothing visible is no move; a WebGL layer or a group without values is never judged', () => {
  const state = { name: 'Count', state: 'new page', changes: [{ property: 'text', channel: 'ren:text', family: 'text', from: 1, to: 2 }] };
  const faint = { name: 'Box', changes: [{ property: 'opacity', channel: 'ren:opacity', family: 'fade', from: 0, to: 0.03 }] };
  const real = { name: 'Box', changes: [{ property: 'opacity', channel: 'ren:opacity', family: 'fade', from: 0, to: 1 }] };
  assert.equal(notAMove([state]), NOT_A_MOVE.state);
  assert.equal(notAMove([state, faint]), NOT_A_MOVE.unseen);
  assert.equal(notAMove([state, real]), null);
  assert.equal(notAMove([faint, { name: 'Seen', changes: [] }]), null);
  assert.equal(notAMove([faint, { name: 'WebGL u_progress', layer: 'gl', changes: [{ property: 'u_progress', family: 'uniform', from: 0, to: 0.01 }] }]), null);
  assert.equal(notAMove([{ ...real, part: 'out' }]), null);
  // a counter-move that the screen shows is seen even when the transform alone would be read as a slide
  assert.equal(notAMove([{ name: 'Menu', screen: { axis: 'x', px: 590, counter: true }, changes: [{ property: 'x', channel: 'ren:tx', family: 'move', from: 0, to: -590 }] }]), null);
});

test('the card leaves a move that is not a move out; moves.json keeps it', () => {
  const m = (id, extra = {}) => ({ id, kind: 'change', name: id, sentence: 's', instances: [{ page: 'home', viewport: 'desktop' }], trigger: {}, curve: {}, proof: {}, ...extra });
  const index = { site: { pages: [{ id: 'home' }] }, groups: [], top: [], moves: [m('a'), m('b', { notMove: NOT_A_MOVE.state })] };
  assert.deepEqual(cardIndex(index).moves.map((x) => x.id), ['a']);
  assert.equal(index.moves.length, 2);
});

test('the sentence before the fit says how a text changes, never just "changes its text"', () => {
  const g = (lead) => ({ lead: { lead, fams: ['text'], desc: 'H2.heading', key: 'h2', from: 0, to: 1 }, count: 1, frames: 30, runs: [] });
  assert.doesNotMatch(plainSentence({ kind: 'touch', groups: [g('ren:chars')], parts: ['hover'], viewport: { width: 1440, height: 900 } }), /its text/);
  assert.match(plainSentence({ kind: 'touch', groups: [g('ren:text')], parts: ['hover'], viewport: { width: 1440, height: 900 } }), /counts/);
});
