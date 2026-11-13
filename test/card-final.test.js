import test from 'node:test';
import assert from 'node:assert/strict';
import { cardIndex } from '../src/card/moves.js';

const inst = (page, viewport) => ({ page, viewport });
const mv = (id, extra = {}) => ({ id, name: id, instances: [inst('p1', 'desktop')], ...extra });
const index = {
  site: { host: 'example.com', url: 'https://example.com', pages: [{ id: 'p1', label: 'Home' }], viewports: ['desktop', 'phone'] },
  moves: [mv('a'), mv('b', { same: 'a' }), mv('c', { notMove: true }), mv('d', { consent: true }), mv('e'), mv('f', { same: 'gone', notMove: true })],
};

test('cardIndex counts every record: on the card, folded into a pattern, kept off', () => {
  const r = cardIndex(index).records;
  assert.deepEqual(r, { all: 6, offCard: 3, folded: 1, onCard: 2 });
  assert.equal(r.onCard + r.folded + r.offCard, index.moves.length);
});

test('cardIndex: a repeat whose pattern is off the card is a tile of its own', () => {
  const ix = { ...index, moves: [mv('x', { same: 'nope' }), mv('y')] };
  assert.deepEqual(cardIndex(ix).records, { all: 2, offCard: 0, folded: 0, onCard: 2 });
});
