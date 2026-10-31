// L7 fix (var() shorthands): the authored-text parser behind fromSource read an escaped character as syntax, so a
// Tailwind sheet (`.content-\[\'\'\]`, `.max-w-\[calc\(100\%-2rem\)\]`) or a `\`-continued data URL failed as
// `unterminated` and every var() shorthand of that sheet stayed lossy (12 of the local deep archives' sheets). The block
// tree is read through inPageRuleTable's `parseOnly` hook (the same in-page code the capture runs). No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inPageRuleTable } from '../../src/static/ruletable.js';

globalThis.location ??= { href: 'https://x.test/' };
const blocks = css => inPageRuleTable({ parseOnly: css }).blocks;

test('parseBlocks: escaped quotes, brackets, braces and line continuations are identifier characters', () => {
  const css = [
    ".content-\\[\\'\\'\\]{--tw-content:'';content:var(--tw-content)}",
    '.max-w-\\[calc\\(100\\%-2rem\\)\\]{max-width:calc(100% - 2rem)}',
    '.a\\{b{color:red}',
    '@font-face{font-family:x;src:url(data:font/woff;base64,\\\nd09GRg)}',
    '@media (min-width:600px){.m{transition:all .6s var(--ease)}}',
    '.last{x:1}',
  ].join('\n');
  const b = blocks(css);
  assert.equal(b.length, 6);
  assert.equal(b[0].pre, ".content-\\[\\'\\'\\]");
  assert.equal(b[0].body, "--tw-content:'';content:var(--tw-content)");
  assert.equal(b[1].pre, '.max-w-\\[calc\\(100\\%-2rem\\)\\]');
  assert.equal(b[2].pre, '.a\\{b');
  assert.equal(b[2].body, 'color:red');
  assert.equal(b[3].pre, '@font-face');
  assert.equal(b[4].kids[0].body, 'transition:all .6s var(--ease)');
  assert.equal(b[5].pre, '.last');
});

test('parseBlocks: unchanged on plain CSS (strings, comments, nesting flag)', () => {
  const b = blocks('/* c } */ a[title="}{"]{content:"}"} .p{color:red;.q{color:blue}} @layer x;');
  assert.deepEqual(b.map(x => x.pre), ['a[title="}{"]', '.p', '@layer x']);
  assert.equal(b[1].nested, true);
  assert.equal(b[2].leaf, true);
});
