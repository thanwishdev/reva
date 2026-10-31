import test from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, toHex } from '../color.js';
import { parseShadowList, splitTopLevel } from '../shadow.js';
import { Ledger, assertTagged, measured, declared, inferred } from '../prov.js';

test('parseColor: legacy rgb/rgba and hex are exact', () => {
  assert.deepEqual(parseColor('rgb(26, 43, 60)'), { r: 26, g: 43, b: 60, a: 1, space: 'srgb', exact: true });
  assert.equal(toHex(parseColor('rgba(0, 0, 0, 0.5)')), '#00000080');
  assert.equal(toHex(parseColor('#C0392B')), '#c0392b');
});
test('parseColor: oklch/oklab convert and are flagged inexact; unsupported spaces return null', () => {
  assert.equal(toHex(parseColor('oklch(1 0 0)')), '#ffffff');
  assert.equal(toHex(parseColor('oklch(0 0 0)')), '#000000');
  assert.equal(toHex(parseColor('oklch(0.62796 0.25768 29.234)')), '#ff0000'); // sRGB red in OKLCH (Ottosson)
  assert.equal(parseColor('oklch(0.5 0.1 120)').exact, false);
  assert.equal(parseColor('color(display-p3 1 0 0)'), null);
  assert.equal(parseColor('lab(50 40 20)'), null);
});
test('shadows: top-level comma split keeps colour functions whole; inset + spread parsed', () => {
  const l = parseShadowList('rgba(0, 0, 0, 0.2) 0px 2px 4px 0px, rgb(255, 255, 255) 0px 1px 0px 0px inset');
  assert.equal(l.length, 2);
  assert.deepEqual(l[0], { inset: false, x: 0, y: 2, blur: 4, spread: 0, color: 'rgba(0, 0, 0, 0.2)' });
  assert.equal(l[1].inset, true);
  assert.equal(parseShadowList('none'), null);
  assert.deepEqual(splitTopLevel('a(1,2) b, c'), ['a(1,2) b', 'c']);
  assert.equal(parseShadowList('rgba(0, 0, 0, 0.5) 1px 2px 3px', { text: true })[0].spread, null);
});
test('ledger dedupes and tagged values enforce H6', () => {
  const L = new Ledger();
  L.add('unk_a', 'r', 'p'); L.add('unk_a', 'r', 'p'); L.add('unk_a', 'r', 'p', 'x');
  assert.equal(L.list().length, 2);
  assert.ok(assertTagged(measured(1)));
  assert.throws(() => assertTagged({ value: 1 }));
  assert.throws(() => assertTagged(declared(1)));
  assert.throws(() => assertTagged(inferred(1)));
  assert.throws(() => assertTagged({ value: null, provenance: 'unknown' }));
});

