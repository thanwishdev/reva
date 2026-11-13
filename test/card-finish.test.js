// The launch finish batch (T4 part F, 11 Nov 2026): the Site line about a hidden consent banner (U1), numbers in sentences a person
// would read as broken (U4), and a recorded move's error measured, not guessed, with an honest label when it is large (U5). No browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { consentLine, siteWords } from '../src/scan/words.js';
import { backOnce, clauseOf, reduceTrack, sentenceOf, spanWords } from '../src/scan/moves/intent.js';
import { recipeOf } from '../src/scan/moves/close.js';
import { moveStatus, ROUGH_PCT } from '../src/scan/moves/contract.js';
import { trustOf } from '../src/scan/moves/rank.js';
import { proofOf } from '../src/export/move.js';

test('Site: one line names the hidden consent banner, where, what was lifted and what was pressed; nothing when none', () => {
  assert.equal(consentLine(undefined), null);
  assert.equal(consentLine({ hidden: [], unlocked: [] }), null);
  assert.equal(consentLine({ hidden: [{ page: 'a', how: 'backdrop', text: '' }] }), null, 'a backdrop alone is no banner');
  const text = 'We use cookies to analyze site performance and deliver personalized content.';
  const line = consentLine({ hidden: [{ page: 'a', how: 'words', platform: null, text, rejected: null }, { page: 'b', how: 'words', platform: null, text, rejected: null }] }, 2);
  assert.equal(line, 'While recording, REVA hid a cookie-consent banner (“We use cookies to analyze site performance and…”) on every page, so its motion is not in the moves; nothing in it was pressed.');
  const one = consentLine({ hidden: [{ page: 'a', how: 'platform', platform: 'OneTrust', text: 'We value your privacy', rejected: 'Reject all' }, { page: 'a', how: 'backdrop', text: '' }], unlocked: [{ undid: ['overflow', 'fixed'] }, { undid: ['inert'] }] }, 3);
  assert.match(one, /the site's OneTrust cookie banner \(“We value your privacy”\) on 1 of 3 pages, and lifted the scroll lock, the frozen page and the dimmed backdrop it put on the page/);
  assert.match(one, /it pressed only “Reject all”, never Accept\.$/);
  // control characters from the page never reach the card
  assert.ok(!/[\u0000-\u001f]/.test(consentLine({ hidden: [{ page: 'a', how: 'words', text: 'Cookies\u0007 here\nnow' }] })));
});

test('Site: siteWords carries the consent line into coverage, and leaves coverage alone without one', () => {
  const ledger = { version: 1, rows: [] };
  const scan = { url: 'https://example.com/', pages: [{ id: 'home', url: 'https://example.com/' }], consent: { hidden: [{ page: 'https://example.com/', how: 'words', text: 'We use cookies' }] } };
  assert.match(siteWords(scan, ledger).coverage.consent, /^While recording, REVA hid a cookie-consent banner/);
  assert.equal(siteWords({ ...scan, consent: undefined }, ledger).coverage?.consent, undefined);
});

test('a scale past 3 times its size is said by its two sizes, never as 420 % or 1800 %', () => {
  assert.equal(clauseOf({ family: 'scale', property: 'scaleY', from: 1, to: 1, peak: 5.2 }), 'scales up from 1 to 5.2 and back');
  assert.equal(clauseOf({ family: 'scale', property: 'scaleY', from: 0.1, to: 0.86 }), 'scales up from 0.1 to 0.86');
  assert.equal(clauseOf({ family: 'scale', property: 'scale', from: 1, to: 1.06 }), 'scales up 6 %');
  assert.equal(clauseOf({ family: 'scale', property: 'scale', from: 1, to: 0.25 }), 'scales down 75 %');
});

test('clauses that go and come back say the return once, and what stays follows', () => {
  assert.equal(backOnce(['drops 138 px and back', 'slides left 122 px and back', 'scales down 75 % and back']), 'drops 138 px, slides left 122 px and scales down 75 %, then returns');
  assert.equal(backOnce(['rise 5 px and back', 'fade to 60 % and back'], { many: true }), 'rise 5 px and fade to 60 %, then return');
  assert.equal(backOnce(['drops 5 px and back', 'fades in']), null);
  assert.equal(backOnce(['rises 58 px and back', 'slides right 27 px and back', 'rounds', 'scales up 24 % and back']), 'rises 58 px, slides right 27 px and scales up 24 %, then returns, and rounds');
  assert.equal(backOnce(['drops 5 px and back']), null);
  const law = { class: 'keyframes', ms: 450, delayMs: 0 };
  const g = { name: 'Block', count: 3, law, changes: [{ family: 'move', property: 'y', from: 0, to: 0, peak: 138 }, { family: 'move', property: 'x', from: 0, to: 0, peak: -122 }, { family: 'scale', property: 'scale', from: 1, to: 1, peak: 0.25 }] };
  const r = recipeOf(g);
  assert.equal((r.match(/and back/g) || []).length, 0, r);
  assert.match(r, /each one drops 138 px, slides left 122 px and scales down 75 %, then returns, replayed from the recording over 0\.45 s\./);
  const s = sentenceOf({ kind: 'touch', trigger: { kind: 'press' } }, [{ ...g, count: 1, name: 'Block' }]);
  assert.equal((s.match(/and back/g) || []).length, 0, s);
});

test('no "0 s": a change inside half a frame is said to happen at once, in the sentence and the recipe', () => {
  assert.equal(spanWords(3), ', at once');
  assert.equal(spanWords(600), ', 0.6 s');
  const g = { name: 'Box', count: 1, law: { class: 'tween', ms: 2, delayMs: 0, key: 'linear' }, changes: [{ family: 'fade', property: 'opacity', from: 0, to: 1 }] };
  const s = sentenceOf({ kind: 'change' }, [g]);
  assert.ok(!/\b0 s\b/.test(s), s);
  assert.match(s, /at once\.$/);
  assert.match(recipeOf(g), /fades in, at once\./);
});

test('a recorded track: the error is measured on every frame, and a jagged one keeps 24 keys instead of collapsing to 2', () => {
  const xs = Array.from({ length: 780 }, (_, i) => (i * 1000) / 60);
  const jagged = xs.map((_, i) => 0.1 + 0.8 * Math.abs(Math.sin(i * 0.7) * Math.sin(i * 0.13)));
  const r = reduceTrack(xs, jagged);
  assert.equal(r.keys.length, 24, 'the cap, not 2');
  // the stated error is what the kept keys really miss, not a bound of 1 % x 1.3^n (66.54, 86.5, 112.46 before)
  assert.ok(![51.19, 66.54, 86.5, 112.46].includes(r.errorPct), String(r.errorPct));
  assert.ok(r.errorPct <= 100, String(r.errorPct));
  const smooth = reduceTrack(xs, xs.map((x) => Math.sin(x / 2000)));
  assert.ok(smooth.errorPct <= 1, String(smooth.errorPct));
});

test('a move reproduced roughly says so, with no confident number, and is no highlight', () => {
  const rough = { kind: 'touch', proof: { source: 'sampled', errorPct: ROUGH_PCT + 30 }, time: { ms: 900 }, instances: [] };
  const st = moveStatus(rough);
  assert.match(st.line, /^Reproduced roughly/);
  assert.ok(!/\d+(\.\d+)? %/.test(st.line + st.note), st.line);
  assert.equal(st.rough, true);
  assert.match(moveStatus({ proof: { source: 'fitted', errorPct: 13.8, frames: 37 } }).line, /^Reproduced roughly/);
  assert.match(moveStatus({ proof: { source: 'fitted', errorPct: 0.4, frames: 37 } }).line, /within 0\.40? %/);
  assert.match(proofOf({ source: 'sampled', errorPct: 66 }).word, /roughly/);
  assert.equal(proofOf({ source: 'sampled', errorPct: 2 }).word, 'Recorded frame by frame. No simple curve fits, so the code replays it');
  assert.equal(trustOf(rough).top, false);
  assert.equal(trustOf({ kind: 'open', proof: { source: 'fitted', errorPct: 1 }, time: { ms: 0 }, curve: { kind: 'steps' }, instances: [] }).top, false, 'an instant is no highlight');
  assert.equal(trustOf({ kind: 'load', proof: { source: 'fitted', errorPct: 1 }, time: { ms: 600 }, curve: { kind: 'tween' }, instances: [] }).top, true);
});
