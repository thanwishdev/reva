// A declared transform of several functions (.card:hover { transform: translateY(-8px) scale(1.03) }) is exported whole:
// a per-channel export wrote scaleX / scaleY only, dropped the translateY and still said "as declared".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportRecord, combineCss, canonicalTransform, declaredTransform } from '../../src/export/index.js';
import { formatLook } from '../../src/look/cli.js';

const birth = (from, to) => ({ type: 'CSSTransition', name: 'transform', delay: 0, duration: 300, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  keyframes: [{ offset: 0, easing: 'linear', transform: from }, { offset: 1, easing: 'linear', transform: to }] });
const rec = (channel, from = 'none', to = 'translateY(-8px) scale(1.03)') => ({
  target: { el: 1, channel, desc: 'DIV.card' }, tier: 'declared',
  model: { family: 'declared:css', params: { duration: { value: 300, provenance: 'declared' }, easing: { value: 'cubic-bezier(0.34, 1.56, 0.64, 1)', provenance: 'declared' }, keyframeValues: { value: [1, 1.03], provenance: 'measured' } } },
  declared: { kind: 'css', births: [birth(from, to)] },
});

test('canonicalTransform: allowlisted functions with numeric arguments only', () => {
  assert.equal(canonicalTransform('translateY(-8px) scale(1.03)'), 'translateY(-8px) scale(1.03)');
  assert.equal(canonicalTransform(' none '), 'none');
  assert.equal(canonicalTransform('rotate(45DEG)'), 'rotate(45deg)');
  for (const bad of ['scale(1) url(x)', 'translateY(calc(1px))', 'evil(1)', 'scale(1);color:red', 'scale(1)/*', 'scale()', '']) assert.equal(canonicalTransform(bad), null, bad);
});

test('a declared transform of several functions: css, gsap and motion write the whole value, as declared', () => {
  const r = exportRecord(rec('ren:sx'), { to: ['css', 'gsap', 'motion'] });
  const by = Object.fromEntries(r.exports.map((x) => [x.lib, x]));
  assert.match(by.css.code, /\.el \{ transform: none; transition: transform 300ms cubic-bezier\(0\.34, 1\.56, 0\.64, 1\); \}\n\.el\.to \{ transform: translateY\(-8px\) scale\(1\.03\); \}/);
  assert.doesNotMatch(by.css.code, /scaleX/);
  assert.match(by.gsap.code, /\{ transform: "none" \}, \{ transform: "translateY\(-8px\) scale\(1\.03\)"/);
  assert.match(by.motion.code, /transform: \["none", "translateY\(-8px\) scale\(1\.03\)"\]/);
  assert.equal(by.css.accuracy.label, 'exact');
  assert.ok(r.notes.some((n) => /whole declared transform/.test(n)));
  // the channel's own single function stays the per-channel export (unchanged behaviour)
  assert.equal(declaredTransform(rec('ren:ty', 'none', 'translateY(-8px)'), 'translateY'), null);
  assert.ok(declaredTransform(rec('ren:sx', 'none', 'scale(1.03)'), 'scaleX'));
  // page text outside the grammar: no whole value, the per-channel export as before
  assert.equal(declaredTransform(rec('ren:sx', 'none', 'scale(1.03) var(--x)'), 'scaleX'), null);
});

test('combineCss writes a whole declared transform once for all the channels it covers', () => {
  const parts = ['ren:sx', 'ren:sy'].map((id) => ({ el: 1, id, decl: exportRecord(rec(id), { to: ['css'] }).exports[0].decl }));
  const c = combineCss(parts);
  assert.equal(c.code, '.el { transform: none; transition: transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1); }\n.el.to { transform: translateY(-8px) scale(1.03); }');
});

test('look --code css: the channels of one element print as one rule; the same snippet for two channels prints once', () => {
  const exp = (id) => { const r = exportRecord(rec(id), { to: ['css', 'gsap'] }); return { channel: id, t0: 875, exports: r.exports.map((x) => ({ ...x, match: { word: 'as declared' } })) }; };
  const look = { source: { kind: 'url', url: 'http://x.test/', live: false }, action: { do: 'hover', el: '.card' }, timing: { totalMs: 1000 }, take: { frames: 10, rate: 120, watched: 1 },
    errors: [], warnings: [], motions: [{ rank: 1, desc: 'DIV.card', lines: [], unknowns: [], covered: [], exports: [exp('ren:sx'), exp('ren:sy')] }], others: [] };
  const txt = formatLook(look, { code: ['css', 'gsap'] });
  assert.equal((txt.match(/^ {3}-- css /gm) || []).length, 1, txt);
  assert.match(txt, /-- css · ren:sx \+ ren:sy · as declared \(one rule for these channels\)/);
  assert.match(txt, /\.el\.to \{ transform: translateY\(-8px\) scale\(1\.03\); \}/);
  assert.equal((txt.match(/^ {3}-- gsap /gm) || []).length, 1, txt);
  assert.match(txt, /-- gsap · ren:sx \+ ren:sy · as declared/);
  assert.doesNotMatch(txt, /scaleX\(1\.03\)/);
});
