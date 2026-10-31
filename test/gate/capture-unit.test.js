// Stage D1 pure helpers: renderer, var() graph, rule-usage alignment, coverage reasons, compact computed,
// usage merge, oracle excuses, canonical inline audit, table mutants. No browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRebuild, declText, tableMutants } from '../../src/gate/rebuild.js';
import { varGraph, attachUsage, coverageReport, decodeComputed, mergeUsage, enclosingPrelude } from '../../src/static/ruletable.js';
import { compareSnapshots } from '../../src/gate/compare.js';
import { auditSources } from '../../src/gate/audit.js';

// a small hand-made table: doc with one sheet, a media group, keyframes, @property, layer statement, an @import
// wrapper, a shadow root with its own sheet and a same-origin iframe document
function table() {
  const rules = [
    { id: 0, t: 'layer-statement', sheet: 0, names: ['base', 'ui'], ctx: [] },
    { id: 1, t: 'style', sheet: 0, sel: ':root', d: [['--brand', '#0a7f5c'], ['--gap', 'calc(var(--unit) * 2)']], seq: 0, ctx: [] },
    { id: 2, t: 'style', sheet: 0, sel: '.a', d: [['color', 'var(--brand)'], ['margin', '0px auto', 1]], seq: 1, ctx: [] },
    { id: 3, t: 'media', sheet: 0, head: '@media (min-width: 600px)', cond: '(min-width: 600px)', active: false, c: [4], ctx: [] },
    { id: 4, t: 'style', sheet: 0, sel: '.a', d: [['display', 'grid'], ['grid-template-columns', 'repeat(2, 1fr)']], seq: 2, ctx: [3] },
    { id: 5, t: 'style', sheet: 0, sel: '.a:hover', d: [['color', 'red']], seq: 3, ctx: [] },
    { id: 6, t: 'keyframes', sheet: 0, head: '@keyframes spin', name: 'spin', frames: [{ key: '0%', d: [['transform', 'rotate(0deg)']] }, { key: '100%', d: [['transform', 'rotate(360deg)']] }], ctx: [] },
    { id: 7, t: 'property', sheet: 0, name: '--unit', syntax: '<length>', inherits: false, initial: '8px', ctx: [] },
    { id: 8, t: 'import', sheet: 0, href: 'x.css', media: 'print', layer: 'base', supports: null, c: [9], ctx: [] },
    { id: 9, t: 'style', sheet: 1, sel: '.p', d: [['color', 'black']], seq: 0, ctx: [8] },
    { id: 10, t: 'style', sheet: 0, sel: '.ghost', d: [['color', 'blue']], seq: 4, ctx: [] },
    { id: 11, t: 'style', sheet: 2, sel: '.b', d: [['padding', '4px']], seq: 0, ctx: [] },
    { id: 12, t: 'container', sheet: 0, head: '@container (min-width: 420px)', c: [13], ctx: [] },
    { id: 13, t: 'style', sheet: 0, sel: '.a', d: [['gap', 'var(--gap)']], seq: 5, ctx: [12] },
    { id: 14, t: 'style', sheet: 3, sel: 'body', d: [['margin', '0px']], seq: 0, ctx: [] },
  ];
  const sheets = [{ sid: 0, scope: 'd0', rules: [0, 1, 2, 3, 5, 6, 7, 8, 10, 12] }, { sid: 1, scope: 'd0', rules: [9], href: 'x.css' }, { sid: 2, scope: 'd0s1', rules: [11] }, { sid: 3, scope: 'd1', rules: [14] }];
  const tree = { t: 'html', i: 0, a: [['lang', 'en']], c: [{ t: 'body', i: 1, c: [
    { t: 'div', i: 2, a: [['class', 'a']], s: [['--o', '1'], ['left', '89.08068783068784%']], c: ['Hi & <you>'] },
    { t: 'pre', i: 3, c: ['\nline'] },
    { t: 'x-badge', i: 4, sr: { scope: 'd0s1', mode: 'open', sheets: [2], c: [{ t: 'span', i: 5, a: [['class', 'b']], c: ['star'] }] }, c: [] },
    { t: 'iframe', i: 6, a: [['src', '/f.html']], fr: 1, c: [] },
    { t: 'img', i: 7, a: [['src', '/a.png']] },
  ] }] };
  const ftree = { t: 'html', i: 8, c: [{ t: 'body', i: 9, c: ['in frame'] }] };
  const els = [{ k: 'html', r: [1] }, { k: 'html/body[1]', pi: 0 }, { k: 'html/body[1]/div[1]', pi: 1, r: [2], st: [5] }, { k: 'html/body[1]/pre[1]', pi: 1 }, { k: 'html/body[1]/x-badge[1]', pi: 1 }, { k: 'html/body[1]/x-badge[1]#s/span[1]', pi: 4, r: [11] }, { k: 'html/body[1]/iframe[1]', pi: 1 }, { k: 'html/body[1]/img[1]', pi: 1 }, { k: 'html/body[1]/iframe[1]#f/html', pi: 6 }, { k: 'html/body[1]/iframe[1]#f/html/body[1]', pi: 8, r: [14] }];
  els[1].r = [];
  return {
    v: 1, rules, sheets, els,
    docs: [{ i: 0, url: 'http://x/', scope: 'd0', quirks: false, head: { viewport: 'width=device-width', base: null }, sheets: [0], tree }, { i: 1, url: 'http://x/f.html', scope: 'd1', quirks: true, head: {}, sheets: [3], tree: ftree }],
    computed: { pl: ['color', 'display', 'padding-top'], vt: ['rgb(0, 0, 0)', 'block', 'rgb(10, 127, 92)', 'inline', '4px'], els: [{ d: [0, 0, 1, 1], full: 1 }, { d: [] }, { d: [0, 2] }, { d: [] }, { d: [1, 3] }, { d: [2, 4] }, { d: [1, 3] }, { d: [1, 3] }, { d: [0, 0, 1, 1], full: 1 }, { d: [] }] },
  };
}

test('renderer emits CSS and DOM from the table only, in its own compact form', () => {
  const { html, frames } = renderRebuild(table());
  assert.ok(html.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style data-wr-gen>'));
  assert.match(html, /@layer base,ui;/);
  assert.match(html, /:root\{--brand:#0a7f5c;--gap:calc\(var\(--unit\) \* 2\)\}/);
  assert.match(html, /\.a\{color:var\(--brand\);margin:0px auto!important\}/);
  assert.match(html, /@media \(min-width: 600px\)\{\.a\{display:grid;grid-template-columns:repeat\(2, 1fr\)\}\}/);
  assert.match(html, /@keyframes spin\{0%\{transform:rotate\(0deg\)\}100%\{transform:rotate\(360deg\)\}\}/);
  assert.match(html, /@property --unit\{syntax:"<length>";inherits:false;initial-value:8px\}/);
  assert.match(html, /@layer base\{@media print\{\.p\{color:black\}\}\}/, '@import becomes wrapped rules (no request)');
  assert.match(html, /<div class="a" style="--o:1;left:89\.08068783068784%">Hi &amp; &lt;you&gt;<\/div>/);
  assert.match(html, /<pre>\n\nline<\/pre>/, 'leading newline of <pre> survives re-parsing');
  assert.match(html, /<x-badge><template shadowrootmode="open"><style data-wr-gen>\.b\{padding:4px\}<\/style><span class="b">star<\/span><\/template><\/x-badge>/);
  assert.match(html, /<img src="\/a\.png">/);
  assert.ok(!/<script|<link/i.test(html));
  assert.equal(Object.keys(frames)[0], 'http://x/f.html');
  assert.ok(frames['http://x/f.html'].startsWith('<html><head>'), 'quirks document gets no doctype');
  assert.equal(declText([['a', '1', 1], ['b', '2']]), 'a:1!important;b:2');
});

test('var() graph: definitions, dependencies, users, undefined refs', () => {
  const g = varGraph(table());
  assert.deepEqual(g.vars['--gap'].deps, ['--unit']);
  assert.deepEqual(g.vars['--brand'].usedBy, [{ rule: 2, prop: 'color' }]);
  assert.deepEqual(g.vars['--gap'].usedBy, [{ rule: 13, prop: 'gap', ctx: undefined }].map(({ ctx, ...x }) => x));
  assert.deepEqual(g.vars['--o'].defs, [{ el: 2, value: '1' }]);
  assert.deepEqual(g.undefinedRefs, ['--unit'], '--unit comes from @property only (initial value), no declaration');
});

test('rule usage: used-only CDP entries align to rules; prelude entries skipped; odd == 2n+1', () => {
  const text = '.a{color:red}\n@media (min-width:1px){.b:nth-child(odd){color:blue}}\n.c{x:y}\n.a{z:1}';
  const T = { rules: [
    { id: 0, t: 'style', sheet: 0, sel: '.a', seq: 0 }, { id: 1, t: 'style', sheet: 0, sel: '.b:nth-child(2n+1)', seq: 1, ctx: [4] },
    { id: 2, t: 'style', sheet: 0, sel: '.c', seq: 2 }, { id: 3, t: 'style', sheet: 0, sel: '.a', seq: 3 }, { id: 4, t: 'media', head: '@media (min-width: 1px)' }] };
  const at = s => text.indexOf(s);
  const usage = [
    { startOffset: at('.a{color'), endOffset: at('.a{color') + 13, used: true },
    { startOffset: at('(min-width'), endOffset: at('(min-width') + 13, used: true },
    { startOffset: at('.b:'), endOffset: at('.b:') + 30, used: true },
    { startOffset: at('.a{z'), endOffset: text.length, used: true }];
  const m = attachUsage(T, [{ sid: 0, text, usage }]);
  assert.deepEqual(m, { used: 3, unused: 1, orphans: 0, orphanSample: [], ctxFallback: 0, sheetsMapped: 1 });
  assert.deepEqual(T.rules.slice(0, 4).map(r => r.used), [true, true, false, true]);
});

test('rule usage: duplicate selectors align by enclosing group (used rule in an active @media, unused twin in an inactive one)', () => {
  // a real site: `.f` in @media (width<=860px) (inactive) came before `.f` in @media (prefers-reduced-motion:reduce) (used)
  const text = '.f{a:1}@media (width<=860px){.f{b:2}}@media (prefers-reduced-motion:reduce){.f{c:3}}';
  const T = { rules: [
    { id: 0, t: 'style', sheet: 0, sel: '.f', seq: 0 }, { id: 1, t: 'media', head: '@media (width <= 860px)' },
    { id: 2, t: 'style', sheet: 0, sel: '.f', seq: 1, ctx: [1] }, { id: 3, t: 'media', head: '@media (prefers-reduced-motion: reduce)' },
    { id: 4, t: 'style', sheet: 0, sel: '.f', seq: 2, ctx: [3] }] };
  const at = s => text.indexOf(s);
  const usage = [{ startOffset: at('.f{a'), endOffset: at('.f{a') + 7, used: true }, { startOffset: at('.f{c'), endOffset: at('.f{c') + 7, used: true }];
  const m = attachUsage(T, [{ sid: 0, text, usage }]);
  assert.equal(m.ctxFallback, 0);
  assert.deepEqual([0, 2, 4].map(i => T.rules[i].used), [true, false, true]);
  assert.equal(enclosingPrelude(text, at('.f{b')), '@media(width<=860px)');
  assert.equal(enclosingPrelude(text, at('.f{a')), '');
});

test('coverage report: every unused rule with its reasons; transient rules listed', () => {
  const T = table();
  for (const r of T.rules) if (r.t === 'style') r.used = [1, 2, 11, 14].includes(r.id);
  T.rules[10].used = true; // .ghost applied during the session but matches nothing now
  const c = coverageReport(T);
  const why = Object.fromEntries(c.unused.map(u => [u.sel + '|' + u.ctx, u.why]));
  assert.deepEqual(why['.a|@media (min-width: 600px)'], ['media-inactive']);
  assert.deepEqual(why['.a:hover|'], ['state']);
  assert.deepEqual(why['.a|@container (min-width: 420px)'], ['container']);
  assert.deepEqual(why['.p|@import x.css'], ['no-element']);
  assert.deepEqual(c.transient.map(x => x.sel), ['.ghost']);
  assert.equal(c.unusedCount, 4);
});

test('compact computed decodes through the parent chain; a frame root is full', () => {
  const T = table();
  assert.deepEqual(Object.fromEntries(decodeComputed(T, 2)), { color: 'rgb(10, 127, 92)', display: 'block' });
  assert.deepEqual(Object.fromEntries(decodeComputed(T, 5)), { color: 'rgb(0, 0, 0)', display: 'inline', 'padding-top': '4px' });
  assert.deepEqual(Object.fromEntries(decodeComputed(T, 9)), { color: 'rgb(0, 0, 0)', display: 'block' });
});

test('usage merge from a tracked replay aligns by scope/sheet/order and checks selectors', () => {
  const A = table(), B = table();
  for (const r of B.rules) if (r.t === 'style') r.used = r.id % 2 === 0;
  B.rules[13].sel = '.changed';
  const m = mergeUsage(A, B);
  assert.equal(m.selMismatch, 1);
  assert.equal(A.rules[2].used, true);
  assert.equal(A.rules[5].used, false);
  assert.ok(A.coverage && Array.isArray(A.coverage.unused));
});

test('oracle excuses are counted and listed, never silently dropped', () => {
  const snap = v => ({ pl: ['overlay', 'color'], vt: ['auto', 'none', 'red', 'blue'], els: [{ k: 'html', b: [0, 0, 10, 10], t: '', s: [0, v, 1, 2] }] });
  const r0 = compareSnapshots(snap(0), snap(1));
  assert.equal(r0.pass, false);
  const r1 = compareSnapshots(snap(0), snap(1), { excuse: [{ k: /^html$/, prop: 'overlay', why: 'top layer (D2)' }] });
  assert.equal(r1.pass, true);
  assert.deepEqual(r1.excused, [{ k: 'html', kind: 'prop', prop: 'overlay', a: 'auto', b: 'none', why: 'top layer (D2)' }]);
});

test('audit: an original inline style already in canonical form is counted, a reformatted copy is an issue', () => {
  const load = { requests: [], jsDisabled: true };
  const a = auditSources({ rules: [], inline: ['--o-face:0', 'color: red; margin: 0'] }, { html: '<p style="--o-face:0"></p><p style="color: red; margin: 0"></p>' }, load);
  assert.equal(a.canonicalInline, 1);
  assert.equal(a.pass, false);
  assert.equal(a.issues[0].kind, 'original-inline-style');
});

test('table mutants: winning declarations only, each re-rendered artifact differs', () => {
  const T = table();
  const base = renderRebuild(T).html;
  const ms = tableMutants(T, 5, 1);
  assert.ok(ms.length >= 1);
  for (const m of ms) assert.notEqual(m.html, base, m.desc);
  assert.equal(renderRebuild(T).html, base, 'mutation leaves the table unchanged');
  assert.ok(ms.some(m => /rule 11 \.b padding: 4px -> 6px/.test(m.desc)), ms.map(m => m.desc).join(' | '));
});
