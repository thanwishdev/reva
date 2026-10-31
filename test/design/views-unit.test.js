// Stage D3/D4 pure helpers: media / container evaluator (three-valued), srcset parsing, declared -> computed property
// coverage, continuous vs discrete changes, components on a synthetic table, DTCG values and the value comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evalMedia, evalCondition, mediaEnv } from '../../src/design/media.js';
import { parseSrcset, covers, continuous, components, urlsIn } from '../../src/design/views.js';
import { dtcgValue, sameValue, compareVars, parseVarBlock, tokenName } from '../../src/design/dtcg.js';

test('media evaluator: legacy, range, em, types, not/or, unknown features', () => {
  const e = w => mediaEnv({ w, h: 900 });
  assert.equal(evalMedia('(min-width: 600px)', e(599)), false);
  assert.equal(evalMedia('(min-width: 600px)', e(600)), true);
  assert.equal(evalMedia('(width <= 400px)', e(400)), true);
  assert.equal(evalMedia('(width <= 400px)', e(401)), false);
  assert.equal(evalMedia('(width > 600px)', e(600)), false);
  assert.equal(evalMedia('(601px <= width <= 1511px)', e(1511)), true);
  assert.equal(evalMedia('(601px <= width <= 1511px)', e(1512)), false);
  assert.equal(evalMedia('(width >= 641px) and (width <= 1000px)', e(800)), true);
  assert.equal(evalMedia('(width >= 48rem)', e(767)), false);
  assert.equal(evalMedia('(width >= 48rem)', e(768)), true);
  assert.equal(evalMedia('screen and (max-width: 700px)', e(700)), true);
  assert.equal(evalMedia('print', e(700)), false);
  assert.equal(evalMedia('not all and (min-width: 600px)', e(500)), true);
  assert.equal(evalMedia('(width <= 1000px), (device-width <= 500px)', e(1200)), false);
  assert.equal(evalMedia('(prefers-color-scheme: dark)', e(800)), false);
  // D-CORPUS-1: the default env is normal motion (the gate replays no-preference); reduce stays an explicit option
  assert.equal(evalMedia('(prefers-reduced-motion: reduce)', e(800)), false);
  assert.equal(evalMedia('(prefers-reduced-motion: no-preference)', e(800)), true);
  assert.equal(evalMedia('(prefers-reduced-motion: reduce)', mediaEnv({ w: 800, h: 900, reducedMotion: 'reduce' })), true);
  assert.equal(evalMedia('(hover: hover) and (pointer: fine)', e(800)), true);
  assert.equal(evalMedia('(hover: hover)', mediaEnv({ w: 390, h: 844, touch: true })), false);
  assert.equal(evalMedia('(min-resolution: 2dppx)', mediaEnv({ w: 390, h: 844, dpr: 3 })), true);
  assert.equal(evalMedia('(orientation: portrait)', mediaEnv({ w: 390, h: 844 })), true);
  assert.equal(evalMedia('(some-future-feature: on)', e(800)), null);
  assert.equal(evalMedia('(some-future-feature: on), (min-width: 1px)', e(800)), true, 'or with a known true');
  assert.equal(evalMedia('', e(800)), true);
  assert.equal(evalCondition('(min-width: 420px)', { w: 358, h: null }, 'container'), false);
  assert.equal(evalCondition('(min-width: 420px)', { w: 567, h: null }, 'container'), true);
  assert.equal(evalCondition('(height > 100px)', { w: 567, h: null }, 'container'), null, 'block size of an inline-size container is unknown');
  assert.equal(evalCondition('style(--x: 1)', { w: 567 }, 'container'), null);
});

test('srcset, url() extraction, declared coverage, continuous changes', () => {
  assert.deepEqual(parseSrcset('/a.png 1x, /b.png 2x'), [{ url: '/a.png', d: '1x' }, { url: '/b.png', d: '2x' }]);
  assert.deepEqual(parseSrcset('/a.png 480w,/b.png 960w').map(x => x.d), ['480w', '960w']);
  assert.deepEqual(parseSrcset('/only.png').map(x => x.url), ['/only.png']);
  assert.deepEqual(urlsIn('url("a.svg"), linear-gradient(red, blue), url(b.png)'), ['a.svg', 'b.png']);
  assert.deepEqual(urlsIn('url(#clip)'), []);
  assert.ok(covers('padding-inline', 'padding-left') && covers('padding', 'padding-top') && covers('gap', 'row-gap') && covers('grid-template-columns', 'grid-template-columns'));
  assert.ok(!covers('padding', 'margin-top') && !covers('grid-template-columns', 'grid-template-rows'));
  assert.equal(continuous('276.5px 276.5px', '277.5px 277.5px'), true);
  assert.equal(continuous('567px', '276.5px 276.5px'), false, 'one track -> two tracks is a breakpoint');
  assert.equal(continuous('block', 'flex'), false);
  assert.equal(continuous('auto', '12px'), false);
});

test('components: family by base rules, variants by shape + rule-id set, parts', () => {
  // body > [card(h2) card.featured(h2) card(h2)] ; rules: 0 `*`, 1 `.card`, 2 `.card.featured`, 3 `.card h2`
  const R = [
    { id: 0, t: 'style', sel: '*', spec: [[0, 0, 0]] }, { id: 1, t: 'style', sel: '.card', spec: [[0, 1, 0]] },
    { id: 2, t: 'style', sel: '.card.featured', spec: [[0, 2, 0]] }, { id: 3, t: 'style', sel: '.card h2', spec: [[0, 1, 1]] },
  ];
  const els = [{ k: 'html', r: [0] }, { k: 'html/body[1]', pi: 0, r: [0] }];
  const card = (n, feat) => { const i = els.length; els.push({ k: `html/body[1]/div[${n}]`, pi: 1, r: feat ? [0, 1, 2] : [0, 1] }); els.push({ k: `html/body[1]/div[${n}]/h2[1]`, pi: i, r: [0, 3] }); return { t: 'div', i, c: [{ t: 'h2', i: i + 1, c: ['T'] }] }; };
  const kids = [card(1, false), card(2, true), card(3, false)];
  const table = { rules: R, els, docs: [{ i: 0, tree: { t: 'html', i: 0, c: [{ t: 'body', i: 1, c: kids }] } }] };
  const c = components(table).components;
  const cards = c.find(x => x.name === 'div .card');
  assert.equal(cards.instances, 3);
  assert.deepEqual(cards.variants.map(v => v.instances), [2, 1]);
  assert.deepEqual(cards.variants[1].extraRules.map(r => r.sel), ['.card.featured']);
  const h2 = c.find(x => x.name === 'h2 .card h2');
  assert.equal(h2.partOf, cards.id);
  assert.ok(!c.some(x => x.tag === 'body' || x.tag === 'html'));
});

test('DTCG values: aliases, references, typed literals, lossless fallbacks', () => {
  const names = new Map([['--brand', 'brand'], ['--gap', 'gap']]);
  assert.deepEqual(dtcgValue('var(--brand)', names), { $value: '{brand}' });
  assert.deepEqual(dtcgValue('calc(var(--gap) * 2)', names), { $value: 'calc({gap} * 2)' });
  assert.deepEqual(dtcgValue('var(--gap, 4px)', names), { $value: 'var(--gap, 4px)' }, 'fallback cannot be an alias');
  assert.deepEqual(dtcgValue('var(--other)', names), { $value: 'var(--other)' }, 'unknown / other-context var stays CSS');
  assert.deepEqual(dtcgValue('#0a7f5c', names).$value.hex, '#0a7f5c');
  assert.equal(dtcgValue('rgb(0 0 0 / .15)', names).$value.alpha, 0.15);
  assert.deepEqual(dtcgValue('oklch(70% .1 150)', names), { $value: 'oklch(70% .1 150)' }, 'no lossy conversion');
  assert.deepEqual(dtcgValue('1.25rem', names), { $type: 'dimension', $value: { value: 1.25, unit: 'rem' } });
  assert.deepEqual(dtcgValue('.8', names), { $type: 'number', $value: 0.8 });
  assert.deepEqual(dtcgValue('cubic-bezier(.2, 0, 0, 1)', names), { $type: 'cubicBezier', $value: [0.2, 0, 0, 1] });
  assert.deepEqual(dtcgValue('200ms', names), { $value: '200ms' }, 'duration objects are not read by the CSS converters: kept as CSS');
  assert.equal(tokenName('--space-0.5'), 'space-0_5');
  assert.ok(sameValue('#0A7F5C', '#0a7f5c') && sameValue('rgb(0 0 0 / .15)', 'rgba(0, 0, 0, 0.15)') && sameValue('cubic-bezier(.24, 1, .4, 1)', 'cubic-bezier(0.24, 1, 0.4, 1)'));
  assert.ok(!sameValue('16px', '1rem') && !sameValue('#000', '#001'));
  assert.deepEqual(parseVarBlock(':root {\n  --a: 1px;\n  --b: calc(var(--a) * 2);\n  --e: ;\n}'), { '--a': '1px', '--b': 'calc(var(--a) * 2)', '--e': '' });
  const c = compareVars({ '--a': '1px', '--b': 'x' }, { '--a': '1px', '--c': 'y' });
  assert.equal(c.equal, 1); assert.equal(c.bad.length, 2);
});
