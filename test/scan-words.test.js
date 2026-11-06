// The Site sentences of a v2 ledger (DESIGN 4.5, 5.6): written from what the rows prove, every number recomputable from coverage.json.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/scan/ledger.js';
import { siteWords, REASON_CLASSES } from '../src/scan/words.js';
import { addRows, mediaRow, workerRow, frameRow, canvasRow } from '../src/scan/rows.js';

const U = (p) => `https://a.test${p}`;

/** A whole small site: 12 listed pages, 5 recorded on two screens, the rest not, with one row of each kind of loss. */
function wholeSite() {
  const l = new Ledger({ version: 2 });
  const rec = ['/', '/work', '/work/one', '/about', '/contact'];
  for (const p of rec) {
    l.add({ unit: 'page', id: U(p), page: U(p), status: 'captured', evidence: { take: 't' } });
    for (const v of ['desktop', 'phone']) l.add({ unit: 'viewport', id: v, page: U(p), viewport: v, status: 'captured', evidence: {} });
  }
  l.add({ unit: 'page', id: U('/news/1'), page: U('/news/1'), status: 'predicted-same', basis: 'same template as /news/0' });
  l.add({ unit: 'page', id: U('/news/2'), page: U('/news/2'), status: 'duplicate-of', duplicateOf: U('/news/0'), proof: 'signature' });
  l.add({ unit: 'page', id: U('/login'), page: U('/login'), status: 'blocked', reason: 'the page asks for a login' });
  l.add({ unit: 'page', id: U('/shop'), page: U('/shop'), status: 'limit', name: 'pages', value: 5 });
  for (let i = 0; i < 41; i++) l.add({ unit: 'move', id: `m-${i}`, page: U('/'), viewport: 'desktop', status: 'captured', evidence: { clip: `c${i}.mp4` } });
  for (let i = 0; i < 3; i++) l.add({ unit: 'move', id: `p-${i}`, page: U('/'), viewport: 'desktop', status: 'partial', evidence: {}, read: 'pictures', notRead: [{ what: 'the shader', why: 'raw GL' }] });
  for (const v of ['desktop', 'phone']) l.add({ unit: 'pattern', id: 'all', page: U('/'), viewport: v, status: 'captured', evidence: {} });
  addRows(l, [
    mediaRow({ id: 'hero', page: U('/'), viewport: 'desktop', stored: false }),
    workerRow({ id: 'w', page: U('/'), viewport: 'desktop' }),
    frameRow({ id: 'embed', page: U('/'), viewport: 'desktop', crossOrigin: true }),
    canvasRow({ id: 'c', page: U('/'), viewport: 'desktop', context: '2d', evidence: { draws: 2 } }),
  ]);
  l.add({ unit: 'request', id: 'x.test', page: U('/'), status: 'refused', rule: '249 requests: a file of another site' });
  l.add({ unit: 'request', id: 'y.test', page: U('/'), status: 'refused', rule: '83 requests: a file of another site', reason: '83 requests: a file of another site' });
  return l;
}

test('a whole site: the lead says what the rows prove and every number matches coverage.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-words-test-'));
  const f = path.join(dir, 'coverage.json');
  wholeSite().write(f);
  const ledger = Ledger.read(f);   // the words are made from what is on disk
  const w = siteWords({ url: U('/'), map: { listed: 12, templates: 3 } }, ledger);
  assert.equal(w.lead[0], '5 of 12 pages recorded. 7 pages were not opened.');
  assert.equal(w.coverage.line, 'Recorded 5 of 12 pages on desktop and phone. 7 pages were not opened.');
  assert.match(w.lead[1], /^Desktop and phone: 41 moves recorded frame by frame, 3 more moves seen with part of the values not read\.$/);
  assert.match(w.lead[2], /^2 interactive parts tested with hover, focus and press, 1 repeat matched an earlier one by shape only and was not recorded again\.$/);
  // recompute every number from the file
  const rows = JSON.parse(fs.readFileSync(f, 'utf8')).rows;
  assert.equal(rows.filter((r) => r.unit === 'page' && r.status === 'captured').length, 5);
  assert.equal(new Set(rows.filter((r) => r.unit === 'move' && r.status === 'captured').map((r) => r.id)).size, 41);
  assert.equal(new Set(rows.filter((r) => r.unit === 'move' && r.status === 'partial').map((r) => r.id)).size, 3);
  assert.equal(rows.filter((r) => r.unit === 'pattern' && r.status === 'captured').length, 2);
  // the pages that were not opened, as paths
  assert.deepEqual(w.coverage.notOpened.sort(), ['/login', '/news/1', '/news/2', '/shop']);
});

test('reasons come in the five classes, folded, with no ledger word in a sentence', () => {
  const w = siteWords({ url: U('/'), map: { listed: 12 } }, wholeSite());
  const byClass = Object.fromEntries(w.coverage.reasons.map((r) => [r.class, r.words]));
  assert.ok(Object.keys(byClass).every((c) => REASON_CLASSES.includes(c)));
  assert.deepEqual(Object.keys(byClass), ['rule', 'limit', 'broke', 'impossible']);   // notBuilt only when a row names it
  assert.ok(byClass.rule.includes('A file the page asked for: 332 requests: a file of another site'));
  assert.ok(byClass.rule.some((x) => /login/.test(x)));
  assert.ok(byClass.broke.some((x) => /Video or audio, desktop: the video file was not stored/.test(x)));
  assert.ok(byClass.impossible.some((x) => /another site's page inside this one/.test(x)));
  assert.ok(byClass.impossible.some((x) => /the shader: raw GL \(3 of them\)/.test(x)));
  const all = [...w.lead, ...w.missing, w.coverage.line].join('\n');
  for (const word of ['duplicate-of', 'not-reached', 'predicted-same', 'captured', 'opaque', 'partial', 'refused']) assert.ok(!all.includes(word), `"${word}" reached a person`);
  assert.deepEqual(w.missing, Object.values(byClass).flat());
});

test('a row can name its own class', () => {
  const l = new Ledger({ version: 2 });
  l.add({ unit: 'page', id: U('/'), page: U('/'), status: 'captured', evidence: {} });
  l.add({ unit: 'fit', id: 'summary', viewport: 'desktop', status: 'limit', name: 'drag', value: 'not built', class: 'notBuilt', reason: 'dragging is not tested yet' });
  const w = siteWords({ url: U('/') }, l);
  assert.deepEqual(w.coverage.reasons, [{ class: 'notBuilt', words: ['Curve fitting, desktop: dragging is not tested yet'] }]);
});

test('one page, one screen, no moves: short and true', () => {
  const l = new Ledger({ version: 2 });
  l.add({ unit: 'page', id: U('/'), page: U('/'), status: 'captured', evidence: {} });
  l.add({ unit: 'viewport', id: 'phone', page: U('/'), viewport: 'phone', status: 'captured', evidence: {} });
  const w = siteWords({ url: U('/') }, l);
  assert.equal(w.lead[0], 'One page recorded.');
  assert.equal(w.lead[1], 'Phone: no moves recorded.');
  assert.equal(w.coverage.line, 'Recorded one page on phone.'.replace('one page', '1 page'));
  assert.deepEqual(w.missing, []);
  assert.deepEqual(w.coverage.notOpened, []);
});

test('one page not opened reads in the singular', () => {
  const l = new Ledger({ version: 2 });
  l.add({ unit: 'page', id: U('/'), page: U('/'), status: 'captured', evidence: {} });
  const w = siteWords({ url: U('/'), map: { listed: 2 } }, l);
  assert.equal(w.lead[0], '1 of 2 pages recorded. 1 page was not opened.');
});

test('a v1 ledger keeps the old sentences until the scan writes v2', () => {
  const l = new Ledger();
  l.add({ unit: 'page', id: U('/'), page: U('/'), status: 'captured', evidence: {} });
  l.add({ unit: 'moving-element', id: '.a', page: U('/'), viewport: 'desktop', status: 'captured' });
  const w = siteWords({ url: U('/'), map: { listed: 1028, templates: 7 } }, l);
  assert.match(w.lead[0], /the other 1,027 are the same 7 templates/);
  assert.match(w.lead[1], /1 moving element/);
  assert.equal(w.coverage, undefined);
});
