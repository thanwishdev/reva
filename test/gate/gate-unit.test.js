// Stage G gate: the parts that need no browser (test points, value compare, element compare, blobs, mutants, audit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { testPoints } from '../../src/gate/points.js';
import { sameValue, compareSnapshots } from '../../src/gate/compare.js';
import { largestBlob, pixelVerdict, PM_THRESHOLD, MAX_BLOB } from '../../src/gate/pixels.js';
import { makeMutants, mutationSites } from '../../src/gate/mutate.js';
import { auditSources } from '../../src/gate/audit.js';

test('testPoints: captured + t-1/t+1 of every edge + per-band randoms + one height change per class', () => {
  const captured = [{ cls: 'D', w: 1280, h: 800 }, { cls: 'M', w: 390, h: 800 }];
  const pts = testPoints({ captured, edges: [600, 960], range: { from: 320, to: 1600 }, perBand: 2, seed: 3 });
  const ids = new Set(pts.map(p => p.id));
  assert.equal(pts.filter(p => p.kind === 'captured').length, 2);
  for (const w of [599, 601, 959, 961]) assert.ok(pts.some(p => p.w === w && p.kind === 'heldout-edge'), `edge point ${w}`);
  assert.ok(pts.some(p => p.kind === 'heldout-height' && p.w === 1280 && p.h === 600));
  assert.ok(pts.filter(p => p.kind === 'heldout-band').length >= 4);
  assert.equal(ids.size, pts.length, 'no duplicate points');
  for (const p of pts) if (p.kind !== 'captured') assert.ok(!(p.w === 1280 && p.h === 800) && !(p.w === 390 && p.h === 800), 'held-out never equals a captured point');
  assert.equal(pts.find(p => p.w === 599).cls, 'M', 'nearest captured class');
  assert.deepEqual(testPoints({ captured, edges: [600, 960], range: { from: 320, to: 1600 }, perBand: 2, seed: 3 }), pts, 'seeded = repeatable');
});

test('sameValue: px tolerance only for px numbers; colours, alphas, keywords exact; matrix linear part 1e-5', () => {
  assert.ok(sameValue('height', '1321.81px', '1321.8px'));
  assert.ok(!sameValue('height', '1321.81px', '1321.85px'));
  assert.ok(!sameValue('color', 'rgb(10, 20, 30)', 'rgb(11, 20, 30)'));
  assert.ok(!sameValue('opacity', '0.8', '0.81'));
  assert.ok(!sameValue('background-color', 'rgba(0, 0, 0, 0.5)', 'rgba(0, 0, 0, 0.51)'));
  assert.ok(!sameValue('display', 'block', 'flex'));
  assert.ok(sameValue('transform', 'matrix(1, 0, 0, 1, 0.285586, 0.24975)', 'matrix(1, 0, 0, 1, 0.285547, 0.24975)'));
  assert.ok(!sameValue('transform', 'matrix(0.99, 0.1, -0.1, 0.99, 0, 0)', 'matrix(0.9901, 0.1, -0.1, 0.99, 0, 0)'));
});

const snap = (els) => {
  const pl = [], vt = [];
  const I = (arr, v) => { let i = arr.indexOf(v); if (i < 0) { i = arr.length; arr.push(v); } return i; };
  return { pl, vt, els: els.map(e => ({ k: e.k, b: e.b, t: e.t || '', f: e.f || '', s: Object.entries(e.s).flatMap(([p, v]) => [I(pl, p), I(vt, v)]), ...(e.live ? { live: 1 } : {}) })) };
};

test('compareSnapshots: names every miss (box, prop, text, font, missing, extra) and skips declared live regions', () => {
  const a = snap([{ k: 'html', b: [0, 0, 100, 100], s: { color: 'rgb(0, 0, 0)' } }, { k: 'html/body[1]', b: [0, 0, 100, 50], t: 'Hi', f: 'X:2', s: { color: 'rgb(0, 0, 0)' } }, { k: 'html/body[1]/i[1]', b: [0, 0, 1, 1], s: {}, live: true }, { k: 'html/body[1]/p[1]', b: [0, 0, 1, 1], s: {} }]);
  assert.equal(compareSnapshots(a, a).pass, true);
  const b = snap([{ k: 'html', b: [0, 0.4, 100, 100], s: { color: 'rgb(0, 0, 0)' } }, { k: 'html/body[1]', b: [0, 0.6, 100, 50], t: 'Ho', f: 'Y:2', s: { color: 'rgb(0, 0, 1)' } }, { k: 'html/body[1]/i[1]', b: [9, 9, 9, 9], s: {}, live: true }, { k: 'html/body[1]/q[1]', b: [0, 0, 1, 1], s: {} }]);
  const r = compareSnapshots(a, b);
  assert.equal(r.pass, false);
  assert.deepEqual(r.byKind, { box: 1, text: 1, font: 1, prop: 1, 'element-missing': 1, 'element-extra': 1 });
  assert.equal(r.live, 1);
  assert.equal(r.byProp.color, 1);
});

test('largestBlob is 8-connected and pixelVerdict applies cap and blob limit', () => {
  const w = 10, h = 10, m = new Uint8Array(w * h);
  m[0] = 1; m[11] = 1; m[22] = 1; // diagonal chain = one blob of 3
  m[99] = 1;
  assert.equal(largestBlob(m, w, h).area, 3);
  assert.ok(PM_THRESHOLD <= 0.03 && MAX_BLOB === 64);
  assert.equal(pixelVerdict({ diffPx: 5, blob: { area: 5 } }, 5).pass, true);
  assert.equal(pixelVerdict({ diffPx: 6, blob: { area: 5 } }, 5).pass, false);
  assert.equal(pixelVerdict({ diffPx: 65, blob: { area: 65 } }, 1000).pass, false);
});

test('makeMutants: 20 distinct real changes across inline declarations, pseudo rules and font families', () => {
  const decl = i => `color:rgb(${i}, 2, 3);width:${100 + i}px;display:block;position:relative;opacity:1;font-weight:400;margin-top:${i}px;font-family:&quot;F&quot;, sans;`;
  const html = `<html><head><style data-wr-gen>@font-face { font-family: "F"; src: url("http://x/f.ttf"); }\n[data-wr-k="1"]::before{color:rgb(1, 2, 3);margin-top:0px;}\n[data-wr-k="2"]::marker{color:rgb(4, 5, 6);margin-top:0px;}</style></head><body>${Array.from({ length: 12 }, (_, i) => `<p style="${decl(i)}">x</p>`).join('')}</body></html>`;
  assert.ok(!mutationSites(html).some(s => s.where === '::marker' && s.prop === 'margin-top'), '::marker ignores margins: never a site');
  const ms = makeMutants(html, 20, 1, { usedFamilies: ['"F", sans'] });
  assert.equal(ms.length, 20);
  assert.equal(new Set(ms.map(m => m.html)).size, 20, 'all distinct');
  for (const m of ms) assert.notEqual(m.html, html);
  assert.ok(ms.some(m => m.desc.startsWith('@font-face')) && ms.some(m => m.desc.startsWith('::')));
  assert.ok(ms.every(m => !/-> $/.test(m.desc)));
  assert.deepEqual(makeMutants(html, 20, 1, { usedFamilies: ['"F", sans'] }).map(m => m.desc), ms.map(m => m.desc), 'seeded');
});

test('auditSources fails on any trace of the original sheets, inline styles, scripts or CSS/JS requests', () => {
  const sources = { rules: ['.card { color: red; padding: 4px; }'], inline: ['display: none; color: blue'] };
  const clean = { html: '<html><head><style data-wr-gen>@font-face { font-family: "F"; }</style></head><body style="color:rgb(0, 0, 0);"></body></html>' };
  assert.equal(auditSources(sources, clean, { requests: [{ type: 'image', url: 'x' }], jsDisabled: true }).pass, true);
  const dirty = { html: '<html><head><link rel="stylesheet" href="a.css"><style>.card { color: red; padding: 4px; }</style><script>1</script></head><body style="display: none; color: blue"></body></html>' };
  const r = auditSources(sources, dirty, { requests: [{ type: 'stylesheet', url: 'a.css' }], jsDisabled: false });
  assert.equal(r.pass, false);
  assert.deepEqual(r.issues.map(i => i.kind).sort(), ['foreign-style', 'js-enabled', 'link-stylesheet', 'network', 'original-inline-style', 'original-rule-text', 'script-tag']);
});

test('audit (D1b): CSP-blocked scripts count as no JS; inline handlers and javascript: URLs are issues', () => {
  const sources = { rules: [], inline: [] };
  const load = { requests: [], scriptsBlocked: "csp: script-src 'none'" };
  assert.equal(auditSources(sources, { html: '<p>ok</p>' }, load).pass, true);
  assert.deepEqual(auditSources(sources, { html: '<p>ok</p>' }, { requests: [] }).issues.map(i => i.kind), ['js-enabled']);
  const bad = auditSources(sources, { html: '<img src="a.png" onerror="x()"><a href="javascript:void 0">a</a>' }, load);
  assert.deepEqual(bad.issues.map(i => i.kind), ['script-handler', 'script-handler']);
});
