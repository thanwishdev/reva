// Known truth for the rule-table capture: a shorthand with var() followed by a longhand of the same family
// (`transition: transform 1.2s var(--e); transition-delay: ...`) is not serialisable by the engine's CSSOM (its longhands
// read back empty). The capture takes the declarations from the authored text (inline <style> and linked sheet) so the
// transition survives; a rule the engine CAN serialise is untouched. Browser test, ~5 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '../../src/browser/launch.js';
import { inPageRuleTable } from '../../src/static/ruletable.js';

const ORIGIN = 'http://wr-sh.test';
const CSS_LINK = `.l { display:inline-block; transform: translateY(150%);
  transition: transform 1.2s var(--e) ;transition-delay: calc(var(--c)*.03s) }`;
const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="/s.css"><style>
:root{--e:cubic-bezier(.5,0,.3,1);--c:2}
.a>span{display:block;transition:transform 1.2s var(--e);transition-delay:calc(var(--c)*.03s)}
.b{transition:transform 1.2s var(--e);color:red}
.c{transition:opacity 2s ease}
.p:before{content:'';transition:scale 1.2s var(--e);transition-delay:.3s}
.m{mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:k 1s var(--e) forwards}
.d{transform:translateZ(0);transition:transform 1.8s var(--e);transition-delay:calc(var(--c)*.06s + .15s)}
</style></head><body><div class="a"><span>x</span></div><i class="b l">b</i><p class="c">c</p><u class="d">d</u><b class="p">p</b><s class="m">m</s></body></html>`;

test('shorthand with var() overridden by a longhand keeps its authored declaration', { timeout: 60000 }, async () => {
  const h = await launchBrowser({ engine: 'chs', context: { viewport: { width: 400, height: 300 } } });
  try {
    await h.context.route(`${ORIGIN}/**`, r => {
      const u = new URL(r.request().url());
      if (u.pathname === '/s.css') return r.fulfill({ status: 200, contentType: 'text/css', body: CSS_LINK });
      return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE });
    });
    await h.page.goto(`${ORIGIN}/`);
    const T = await h.page.evaluate(inPageRuleTable, {});
    const decl = sel => T.rules.find(r => r.t === 'style' && r.sel === sel)?.d;
    const has = (d, p) => d.find(x => x[0] === p);
    for (const sel of ['.a > span', '.l', '.d', '.p::before']) {
      const d = decl(sel);
      assert.ok(d, sel);
      assert.ok(!d.some(x => x[1] === ''), `${sel} has an empty declaration: ${JSON.stringify(d)}`);
      assert.match(has(d, 'transition')[1].replace(/\s+/g, ' ').trim(), /^(transform|scale) 1\.[28]s var\(--e\)$/);
      assert.match(has(d, 'transition-delay')[1], /^(calc\(var\(--c\)\s*\*\s*\.0[36]s|0?\.3s)/);
    }
    // a block the engine serialises lossy (single mask-composite over two mask layers) AND holds a pending var() shorthand
    // elsewhere: the authored declarations are taken, so every layer keeps its composite
    {
      const d = decl('.m');
      assert.ok(d.some(x => x[0] === 'mask-composite' && x[1] === 'exclude'), JSON.stringify(d));
      const got = await h.page.evaluate(d => { const el = document.createElement('i'); document.body.append(el); el.style.cssText = d.map(([p, v]) => `${p}:${v}`).join(';'); return getComputedStyle(el).maskComposite + '|' + getComputedStyle(document.querySelector('.m')).maskComposite; }, d);
      const [a, b] = got.split('|'); assert.equal(a, b);
    }
    assert.deepEqual(decl('.b'), [['transition', 'transform 1.2s var(--e)'], ['color', 'red']], 'engine-serialisable rule untouched');
    assert.deepEqual(decl('.c'), [['transition', 'opacity 2s']]);
    // round trip: the recorded declarations, applied to a fresh element, give the original computed transition
    const ok = await h.page.evaluate(d => {
      const el = document.createElement('span'); document.body.append(el);
      el.style.cssText = d.map(([p, v]) => `${p}:${v}`).join(';');
      const o = getComputedStyle(document.querySelector('.a > span'));
      const n = getComputedStyle(el);
      return ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'].every(p => n.getPropertyValue(p) === o.getPropertyValue(p));
    }, decl('.a > span'));
    assert.equal(ok, true);
  } finally { await h.close?.(); await h.browser?.close?.(); }
});

// Two rules with ONE selector whose declarations differ only inside var(): the engine reads every longhand back as ''
// in both, so a re-parse cannot tell their authored blocks apart. Each rule must get its own block (by position), and a
// sheet whose rule count does not match its source (here an at-rule the engine drops) must fall back and count as lossy.
async function tableOf(html, css) {
  const h = await launchBrowser({ engine: 'chs', context: { viewport: { width: 400, height: 300 } } });
  try {
    await h.context.route(`${ORIGIN}/**`, r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
    await h.page.goto(`${ORIGIN}/`);
    return await h.page.evaluate(inPageRuleTable, {});
  } finally { await h.close?.(); await h.browser?.close?.(); }
}
const dec = (T, sel) => T.rules.filter(r => r.t === 'style' && r.sel === sel).map(r => r.d);
const trans = d => d.find(x => x[0] === 'transition')?.[1];

test('same selector in @media and at top level: each rule keeps its own authored value', { timeout: 60000 }, async () => {
  const T = await tableOf(`<!doctype html><style>
@media (max-width:100px){.a{transition:color 9s var(--f);transition-delay:1s}}
.a{transition:transform 1s var(--e);transition-delay:1s}
</style><div class="a">x</div>`);
  const [m, top] = dec(T, '.a');
  assert.equal(trans(m), 'color 9s var(--f)');
  assert.equal(trans(top), 'transform 1s var(--e)');
  assert.equal(T.lossy, 0);
});

test('two same-selector rules in one sheet differing only inside var()', { timeout: 60000 }, async () => {
  const T = await tableOf(`<!doctype html><style>
.a{transition:color 9s var(--f);transition-delay:1s}
.b{color:red}
.a{transition:transform 1s var(--e);transition-delay:1s}
</style><div class="a">x</div>`);
  const [first, second] = dec(T, '.a');
  assert.equal(trans(first), 'color 9s var(--f)');
  assert.equal(trans(second), 'transform 1s var(--e)');
});

test('source has a statement the engine drops: the kept rules still map exactly (L7 F2), nothing lossy', { timeout: 60000 }, async () => {
  const T = await tableOf(`<!doctype html><style>
@wr-unknown-at-rule { x{y:z} }
.a{transition:color 9s var(--f);transition-delay:1s}
</style><div class="a">x</div>`);
  const [d] = dec(T, '.a');
  assert.equal(trans(d), 'color 9s var(--f)', JSON.stringify(d));
  assert.ok(!d.some(x => x[1] === ''), JSON.stringify(d));
  assert.equal(T.lossy, 0);
});
