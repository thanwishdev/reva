// reva compare: comparePair on look.json-shaped fixtures (unit tests only; no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePair, formatCompare, judgeTime, judgeValue, COMPARE_TOL } from '../../src/compare/index.js';
import { compareHtml } from '../../src/compare/card.js';
import { compareRows } from '../../src/compare/tool.js';

// a declared CSS animation record (as look.json writes it): duration, delay, easing and keyframe values are exact
const declared = (el, channel, { duration = 900, delay = 150, easing = 'cubic-bezier(0.22, 1, 0.36, 1)', kf = [32, 0] } = {}) => ({
  schema: 'reva.motion/0', target: { el, desc: 'x', channel }, tier: 'declared', class: 'declared',
  model: { family: 'declared:css', params: { duration: { value: duration, provenance: 'declared', unit: 'ms' }, delay: { value: delay, provenance: 'declared', unit: 'ms' },
    easing: { value: easing, provenance: 'declared' }, keyframeValues: { value: kf, provenance: 'declared' } } },
  derived: { t0: 8.3 + delay, visibleOnset: 8.3 + delay },
});
// a fitted spring record
const spring = (el, { omega = 13.24, zeta = 0.545, t0 = 300 } = {}) => ({
  schema: 'reva.motion/0', target: { el, desc: 'dot', channel: 'ren:tx' }, tier: 'fitted', class: 'spring',
  model: { family: 'spring', params: { t0: { value: t0, provenance: 'fitted' }, omega: { value: omega, provenance: 'fitted' }, zeta: { value: zeta, provenance: 'fitted' }, x0: { value: 120, provenance: 'fitted' }, target: { value: 0, provenance: 'fitted' } } },
  derived: { t0 },
});
const motion = (rank, desc, selector, records, extra = {}) => ({ rank, kind: 'element', desc, selector, lead: records[0].target.el, count: 1, weightShare: 1 / (rank + 1), channels: [...new Set(records.map((r) => r.target.channel))], lines: [], records, ...extra });
const look = (motions, url = 'http://localhost:1/a.html') => ({ schema: 'reva.look/0', status: 'ok', source: { kind: 'url', url }, action: { do: 'load', el: null, on: null }, motions });

const pageA = () => look([
  motion(1, 'H1', 'h1', [declared(1, 'ren:ty'), declared(1, 'ren:opacity', { kf: [0, 1] })]),
  motion(2, 'P.lede', 'p.lede', [declared(2, 'ren:opacity', { duration: 700, delay: 450, easing: 'ease-out', kf: [0, 1] })]),
  motion(3, 'DIV#dot.dot', '#dot', [spring(3)]),
]);

test('identical looks: every motion the same', () => {
  const c = comparePair(pageA(), pageA());
  assert.equal(c.counts.pairs, 3); assert.equal(c.counts.same, 3); assert.equal(c.verdict, 'same');
  assert.equal(c.headline, 'B moves like A: all 3 motions the same');
  for (const p of c.pairs) for (const ch of p.channels) {
    assert.equal(ch.verdict, 'same');
    if (ch.values.curve) assert.equal(ch.values.curve.maxDiff, 0);
  }
  assert.match(c.lines[0], /^H1 \(h1\): the same: same timing \(starts \+158 ms, 900 ms\), same curve, same values$/);
  assert.match(c.lines[2], /\[both fitted\]$/);   // the spring is fitted on both sides, and the line says so
});

test('a delay shifted by 120 ms: different, with the right number; 20 ms: close', () => {
  const B = pageA(); B.motions[1].records = [declared(2, 'ren:opacity', { duration: 700, delay: 570, easing: 'ease-out', kf: [0, 1] })];
  const c = comparePair(pageA(), B);
  const p = c.pairs.find((x) => x.a.selector === 'p.lede');
  assert.equal(p.verdict, 'different');
  assert.equal(p.channels[0].values.start.diff, 120);
  assert.equal(p.channels[0].values.duration.verdict, 'same');
  assert.match(p.line, /B starts 120 ms later \(\+458 ms → \+578 ms/);
  assert.equal(c.counts.same, 2); assert.equal(c.counts.different, 1);
  assert.equal(c.headline, 'B does not move like A yet: 2 of 3 motions the same, 1 different');

  const B2 = pageA(); B2.motions[1].records = [declared(2, 'ren:opacity', { duration: 700, delay: 470, easing: 'ease-out', kf: [0, 1] })];
  const p2 = comparePair(pageA(), B2).pairs.find((x) => x.a.selector === 'p.lede');
  assert.equal(p2.verdict, 'close'); assert.equal(p2.channels[0].values.start.diff, 20);
});

test('a different curve is found numerically, not from the easing string', () => {
  const B = pageA(); B.motions[0].records = [declared(1, 'ren:ty', { easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' }), declared(1, 'ren:opacity', { kf: [0, 1], easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' })];
  const p = comparePair(pageA(), B).pairs[0];
  assert.equal(p.verdict, 'different');
  assert.ok(p.channels[0].values.curve.maxDiff > COMPARE_TOL.curve.close);
  assert.match(p.line, /same timing.*curve differs (at the start|in the middle) \(up to \d+ % of the travel\)/);
  assert.equal((p.line.match(/curve differs/g) || []).length, 1);   // y and opacity differ the same way: said once
  // the same curve written another way (named vs its cubic-bezier) is the same
  const B2 = pageA(); B2.motions[1].records = [declared(2, 'ren:opacity', { duration: 700, delay: 450, easing: 'cubic-bezier(0, 0, 0.58, 1)', kf: [0, 1] })];
  assert.equal(comparePair(pageA(), B2).pairs[1].verdict, 'same');
});

test('a missing motion is only in A; an extra one only in B', () => {
  const B = pageA(); B.motions.splice(2, 1);
  B.motions.push(motion(4, 'SPAN.badge', '.badge', [declared(4, 'ren:sx', { kf: [0.8, 1] })]));
  const c = comparePair(pageA(), B);
  assert.equal(c.counts.onlyA, 1); assert.equal(c.onlyA[0].selector, '#dot');
  assert.equal(c.counts.onlyB, 1); assert.equal(c.onlyB[0].selector, '.badge');
  assert.ok(c.lines.includes('DIV#dot.dot (#dot): only in A (B has no matching motion)'));
  assert.equal(c.headline, 'B does not move like A yet: 2 of 3 motions the same, 1 only in A, 1 only in B');
});

test('a rebuild with other selectors is paired by start order and visual weight', () => {
  const B = pageA(); B.motions[2] = motion(3, 'DIV.ball', '.ball', [spring(9, { omega: 11 })]);
  const c = comparePair(pageA(), B);
  const p = c.pairs.find((x) => x.a.selector === '#dot');
  assert.equal(p.b.selector, '.ball'); assert.equal(p.pairedBy, 'start order and visual weight');
  assert.notEqual(p.verdict, 'same');
  assert.match(p.line, /B settles \d+ ms later/);
});

test('end values: px within 1 is the same, 5 px is different; labels kept per side', () => {
  const B = pageA(); B.motions[0].records = [declared(1, 'ren:ty', { kf: [32.6, 0] }), declared(1, 'ren:opacity', { kf: [0, 1] })];
  assert.equal(comparePair(pageA(), B).pairs[0].verdict, 'same');
  const B2 = pageA(); B2.motions[0].records = [declared(1, 'ren:ty', { kf: [40, 0] }), declared(1, 'ren:opacity', { kf: [0, 1] })];
  const p = comparePair(pageA(), B2).pairs[0];
  assert.equal(p.channels[0].values.from.verdict, 'different'); assert.equal(p.channels[0].values.from.labels.a, 'exact');
  assert.match(p.line, /y starts from 40 px in B, 32 px in A/);
});

test('tolerances: one frame at 120 Hz or 3 %', () => {
  assert.equal(judgeTime(900, 908), 'same'); assert.equal(judgeTime(900, 925), 'same');   // 3 % of 925 = 27.8 ms
  assert.equal(judgeTime(100, 110), 'close'); assert.equal(judgeTime(100, 160), 'different');
  assert.equal(judgeValue('ren:opacity', 1, 0.995), 'same'); assert.equal(judgeValue('ren:opacity', 1, 0.9), 'different');
});

test('text, card and MCP rows render from one comparison; page text is escaped / marked untrusted', () => {
  const A = pageA(); A.motions[0].desc = 'H1<script>';
  const c = comparePair(A, pageA());
  assert.match(formatCompare(c), /^REVA compare · load/);
  const html = compareHtml(c);
  assert.ok(!html.includes('<script>')); assert.match(html, /<svg/); assert.match(html, /class="b"/);
  const rows = compareRows(c);
  assert.equal(rows.pairs.length, 3); assert.equal(rows.pairs[0].line.untrusted_content, true);
});

test('MCP tool: looks at A then B through the look tool (never together), compares, writes compare.json', async () => {
  const { compareTool } = await import('../../src/compare/tool.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-compare-'));
  const env = { ...process.env, REVA_OUT: out, REVA_HOME: out };
  const B = pageA(); B.motions[1].records = [declared(2, 'ren:opacity', { duration: 700, delay: 570, easing: 'ease-out', kf: [0, 1] })];
  const calls = []; let running = 0;
  const lookTool = { name: 'look', async run(args, ctx) {
    running++; assert.equal(running, 1); calls.push(args); await new Promise((r) => setTimeout(r, 5)); running--;
    const id = `fake_${calls.length}`; fs.mkdirSync(path.join(out, 'look', id), { recursive: true });
    fs.writeFileSync(path.join(out, 'look', id, 'look.json'), JSON.stringify(calls.length === 1 ? pageA() : B));
    assert.equal(typeof ctx.runLook, 'function');
    return { data: { analysis: id } };
  } };
  try {
    await assert.rejects(compareTool.run({ a: {}, b: { fixture: 'demo' } }, { env, lookTool }), /a: give exactly one/);
    const res = await compareTool.run({ a: { fixture: 'demo' }, b: { url: 'http://localhost:9/b.html' }, interaction: 'load', card: true }, { env, lookTool, runLook: async () => ({}) });
    assert.deepEqual(calls.map((c) => c.fixture || c.url), ['demo', 'http://localhost:9/b.html']);
    assert.ok(calls.every((c) => c.design === false && c.interaction === 'load'));
    assert.equal(res.headline, 'B does not move like A yet: 2 of 3 motions the same, 1 different');
    assert.equal(res.stats.different, 1);
    assert.ok(res.artifacts.every((x) => fs.existsSync(x.path)));
    assert.ok(Buffer.byteLength(JSON.stringify(res.data)) < 12000);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
