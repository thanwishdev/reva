import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDeclared, declaredPart, checkConsistency, splitWs } from '../cdpcss.js';

const prop = (name, value, line = 1, extra = {}) => ({ name, value, important: false, implicit: false, disabled: false, range: { startLine: line - 1, startColumn: 0, endLine: line - 1, endColumn: 9 }, text: `${name}: ${value};`, ...extra });
const rule = (selector, props, sheetId = 's1', origin = 'regular') => ({ rule: { origin, selectorList: { text: selector }, style: { styleSheetId: sheetId, cssProperties: props } }, matchingSelectors: [0] });
const sheets = { s1: { file: 'a.css' }, s2: { file: 'b.css' } };

test('pickDeclared: later rule wins, !important beats a later normal rule, inline beats rules, UA ignored', () => {
  const m = { matchedCSSRules: [rule('p', [prop('font-size', '16px')], 's1', 'user-agent'), rule('.a', [prop('font-size', '19px !important', 3, { important: true })]), rule('.b', [prop('font-size', '20px', 9)], 's2')], inherited: [] };
  assert.deepEqual({ ...pickDeclared(m, 'font-size', sheets), selector: undefined }, { name: 'font-size', value: '19px', important: true, file: 'a.css', line: 3, selector: undefined, via: 'rule' });
  const m2 = { matchedCSSRules: [rule('.a', [prop('color', 'red')]), rule('.b', [prop('color', 'blue', 4)], 's2')], inlineStyle: { styleSheetId: undefined, cssProperties: [prop('color', 'green', 1)] } };
  assert.equal(pickDeclared(m2, 'color', sheets).value, 'green'); assert.equal(pickDeclared(m2, 'color', sheets).via, 'inline-style');
  const m3 = { matchedCSSRules: [rule('.a', [prop('color', 'red')]), rule('.b', [prop('color', 'blue', 4)], 's2')] };
  assert.equal(pickDeclared(m3, 'color', sheets).file, 'b.css');
});
test('pickDeclared: implicit longhand expansions and disabled declarations are not "declared"; shorthand covers its longhands', () => {
  const m = { matchedCSSRules: [rule('.c', [prop('padding', '4px 8px'), { name: 'padding-top', value: '4px' }, prop('margin-top', '1px', 2, { disabled: true })])] };
  const w = pickDeclared(m, 'padding-top', sheets); assert.equal(w.name, 'padding'); assert.equal(w.value, '4px 8px');
  assert.equal(pickDeclared(m, 'margin-top', sheets), null);
});
test('pickDeclared: inheritance is only followed for inherited properties', () => {
  const m = { matchedCSSRules: [], inherited: [{ matchedCSSRules: [rule('body', [prop('color', 'navy'), prop('padding-top', '9px')])] }] };
  assert.equal(pickDeclared(m, 'color', sheets).via, 'inherited');
  assert.equal(pickDeclared(m, 'padding-top', sheets), null);
});
test('declaredPart: box shorthands expand per side; unknown shorthands are not isolated', () => {
  assert.deepEqual(declaredPart('padding-top', 'padding', 'var(--s) 32px'), { text: 'var(--s)', exact: true });
  assert.deepEqual(declaredPart('padding-left', 'padding', 'var(--s) 32px'), { text: '32px', exact: true });
  assert.deepEqual(declaredPart('padding-bottom', 'padding', '1px 2px 3px'), { text: '3px', exact: true });
  assert.deepEqual(declaredPart('border-bottom-right-radius', 'border-radius', '8px 16px 24px 4px'), { text: '24px', exact: true });
  assert.deepEqual(declaredPart('border-top-width', 'border', '2px solid #c00'), { text: '2px', exact: true });
  assert.deepEqual(declaredPart('border-top-color', 'border', '2px solid #c00'), { text: '#c00', exact: true });
  assert.deepEqual(declaredPart('row-gap', 'gap', '4px 9px'), { text: '4px', exact: true });
  assert.equal(declaredPart('font-size', 'font', 'italic 12px/1.5 serif').exact, false);
  assert.deepEqual(splitWs('var(--a, 1px) 2px rgb(0 0 0 / 50%)'), ['var(--a, 1px)', '2px', 'rgb(0 0 0 / 50%)']);
});
test('checkConsistency: agrees, disagrees, and says unchecked instead of guessing', () => {
  assert.equal(checkConsistency('font-size', '2.5rem', '40px', { rootFontPx: 16 }).result, 'consistent');
  assert.equal(checkConsistency('font-size', '2.5rem', '41px', { rootFontPx: 16 }).result, 'inconsistent');
  assert.equal(checkConsistency('font-size', '1.2em', '19.2px', { parentFontSizePx: 16, fontSizePx: 19.2 }).result, 'consistent');
  assert.equal(checkConsistency('line-height', '1.15', '46px', { fontSizePx: 40 }).result, 'consistent');
  assert.equal(checkConsistency('letter-spacing', '-0.02em', '-0.8px', { fontSizePx: 40 }).result, 'consistent');
  assert.equal(checkConsistency('padding-top', 'var(--s)', '24px', { vars: { '--s': '24px' } }).result, 'consistent');
  assert.equal(checkConsistency('padding-top', 'var(--s)', '25px', { vars: { '--s': '24px' } }).result, 'inconsistent');
  assert.equal(checkConsistency('padding-top', 'var(--unknown)', '25px', { vars: {} }).result, 'unchecked');
  assert.equal(checkConsistency('color', '#1a2b3c', 'rgb(26, 43, 60)').result, 'consistent');
  assert.equal(checkConsistency('color', '#1a2b3c', 'rgb(26, 43, 61)').result, 'consistent'); // 1/255 rounding tolerance
  assert.equal(checkConsistency('color', '#1a2b3c', 'rgb(200, 43, 60)').result, 'inconsistent');
  assert.equal(checkConsistency('color', 'oklch(0.5 0.1 120)', 'oklch(0.5 0.1 120)').result, 'consistent');
  assert.equal(checkConsistency('font-weight', 'bold', '700').result, 'consistent');
  assert.equal(checkConsistency('font-family', '"WR Plant Sans", Helvetica', '"WR Plant Sans", Helvetica, sans-serif').result, 'consistent');
  assert.equal(checkConsistency('box-shadow', '0 2px 4px rgba(0,0,0,.2), inset 0 1px 0 #fff', 'rgba(0, 0, 0, 0.2) 0px 2px 4px 0px, rgb(255, 255, 255) 0px 1px 0px 0px inset').result, 'consistent');
  assert.equal(checkConsistency('box-shadow', '0 3px 4px rgba(0,0,0,.2)', 'rgba(0, 0, 0, 0.2) 0px 2px 4px 0px').result, 'inconsistent');
  assert.equal(checkConsistency('font-size', 'calc(1rem + 2px)', '18px', { rootFontPx: 16 }).result, 'unchecked');
  assert.equal(checkConsistency('letter-spacing', '0.01em', '0.17px', { via: 'inherited', fontSizePx: 33 }).result, 'unchecked'); // resolved on the ancestor
});
