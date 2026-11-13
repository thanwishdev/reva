// S8 on a synthetic page: laws, the law check, sampled keyframes, proof and sentences, with a known truth. No browser, no site.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthSite, synthTake, easeOut } from './helpers/synthtake.js';
import { buildMoves, writeMoves } from '../src/scan/moves/index.js';
import { fitMoves, fitExemplar, checkTake, lawOf, moveScript, writeClipT0, GAPS } from '../src/scan/moves/fit.js';
import { evaluator, holds, lawError, pickInstances } from '../src/scan/moves/lawcheck.js';
import { changesOf, percentOfBox, readTracks, reduceTrack, sentenceOf, snap } from '../src/scan/moves/intent.js';
import { feelOf } from '../src/scan/moves/feel.js';
import { indexProblems, moveFileProblems } from '../src/scan/moves/contract.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-g2-'));
const twoHovers = (root) => {
  const t = synthTake({ name: 'load', frames: 300 });
  const a = t.el('DIV.a', { selector: 'div.a', box: [0, 0, 100, 100], base: { 'ren:ty': 40, 'ren:opacity': 0 } }), b = t.el('DIV.b', { selector: 'div.b', box: [200, 0, 100, 100], base: { 'ren:ty': 80 } }), c = t.el('DIV.c', { selector: 'div.c', box: [400, 0, 100, 100], base: { 'ren:ty': 40 } });
  t.ramp(a, 'ren:ty', { k0: 20, k1: 56, from: 40, to: 0, ease: easeOut }).ramp(a, 'ren:opacity', { k0: 20, k1: 56, from: 0, to: 1, ease: easeOut });
  t.ramp(b, 'ren:ty', { k0: 100, k1: 136, from: 80, to: 0, ease: easeOut });
  t.ramp(c, 'ren:ty', { k0: 200, k1: 236, from: 40, to: 0, ease: (p) => (p < 0.5 ? 0 : (p - 0.5) * 2) });
  t.mark('load-complete', 4).phase('load', 1, 300); t.write(root);
  return { dir: path.join(root, 'takes', 'desktop', 'load'), a, b, c };
};
const sample = (el, k0, k1) => ({ page: 'home', viewport: 'desktop', take: 'load', el, key: `div.${el}`, k0, k1, T0: (k0 * 1000) / 60, T1: (k1 * 1000) / 60 });

test('intent values: round when the recording allows, raw kept', () => {
  assert.equal(snap(1.0602, 0.0602), 1.06);
  assert.equal(snap(39.97, 40), 40);
  assert.equal(snap(0.1365, 0.2), 0.135);
  assert.equal(percentOfBox(72.9, 72.9), 100);
  assert.equal(percentOfBox(30, 72.9), null);
  const rows = Array.from({ length: 20 }, (_, i) => ({ T: i * 16, sy: 0, v: { 3: { 'ren:ty': 72.9 - i * 3.8368, 'ren:sx': 1 + i * 0.003, 'ren:sy': 1 + i * 0.003, 'ren:bx': 4 } } }));
  const tr = readTracks(rows, 3, { T0: 0, T1: 400 });
  assert.deepEqual(tr.map((x) => x.channel), ['ren:ty', 'ren:sx', 'ren:sy'], 'own channels only, widest first');
  const ch = changesOf(tr, { box: [0, 0, 100, 72.9] });
  assert.deepEqual(ch.map((c) => c.property), ['y', 'scale']);
  assert.deepEqual(ch[0].percent, { from: 100, to: 0 });
  assert.equal(ch[1].raw.to, 1.057);
});

test('a recorded curve reduces to at most 24 points', () => {
  const xs = Array.from({ length: 200 }, (_, i) => i * 16), ys = xs.map((x) => Math.sin(x / 40) * 100);
  const { keys } = reduceTrack(xs, ys);
  assert.ok(keys.length <= 24 && keys.length >= 3);
  assert.deepEqual(keys[0], [0, 0]);
});

test('a fit finds the ease, and a channel on the same law follows it', () => {
  const root = tmp(), { dir, a } = twoHovers(root);
  const r = fitExemplar({ dir, s: sample(a, 20, 56), lead: 'ren:ty' });
  assert.equal(r.provenance, 'fitted');
  assert.equal(r.law.class, 'tween');
  assert.ok(Math.abs(r.law.ms - 600) < 40, `duration ${r.law.ms}`);
  assert.equal(r.law.named, 'power2.out');
  const y = r.changes.find((c) => c.property === 'y'), o = r.changes.find((c) => c.property === 'opacity');
  assert.equal(y.from, 40); assert.equal(y.to, 0);
  assert.equal(o.follows, true);
  assert.ok(r.errorPct < 5); assert.ok(r.dots.length && r.curve.length <= 64);
});

test('the law check: the same law at another size holds, another curve does not', () => {
  const root = tmp(), { dir, a, b, c } = twoHovers(root);
  const r = fitExemplar({ dir, s: sample(a, 20, 56), lead: 'ren:ty' });
  const item = (el, k0, k1, i) => ({ lawId: 1, i, s: sample(el, k0, k1), rec: r.rec, x0: r.x0, ref: { T0: r.T0, sy0: r.sy0 }, axis: r.axis, channel: 'ren:ty' });
  const out = checkTake({ dir, items: [item(b, 100, 136, 0), item(c, 200, 236, 1)] });
  assert.ok(out[0].errorPct < 5, `same law ${out[0].errorPct}`);
  assert.ok(out[1].errorPct > 5, `other law ${out[1].errorPct}`);
});

test('a one-frame jump is an instant change, and a channel below noise stays out of the code', () => {
  const root = tmp(), t = synthTake({ name: 'load', frames: 120 });
  const e = t.el('DIV.j', { selector: 'div.j', box: [0, 0, 100, 100], base: { 'ren:opacity': 0.2 } });
  t.ramp(e, 'ren:opacity', { k0: 40, k1: 40, from: 0.2, to: 1 }).ramp(e, 'ren:rz', { k0: 40, k1: 41, from: 0, to: 0.01 });
  t.mark('load-complete', 4).phase('load', 1, 120); t.write(root);
  const dir = path.join(root, 'takes', 'desktop', 'load'), T = Math.round((40 * 1000 / 60) * 100) / 100;
  const r = fitExemplar({ dir, s: { el: e, k0: 40, k1: 40, T0: T, T1: T }, lead: 'ren:opacity' });
  assert.equal(r.law.class, 'steps');
  assert.deepEqual(r.changes.map((c) => c.property), ['opacity']);
  assert.equal(r.changes[0].to, 1);
});

test('ends round by the travel, not by the width of the trip', () => {
  const ch = changesOf([{ channel: 'ren:tx', family: 'move', T: [0, 1, 2], y: [175.844, 300, 176.5], raw: [175.844, 300, 176.5], sy: [0, 0, 0], amp: 124 }]);
  assert.equal(ch[0].from, 175.85); assert.equal(ch[0].to, 176.5);
});

test('what no law fits ships as keyframes and says so', () => {
  const root = tmp(), t = synthTake({ name: 'load', frames: 200 });
  const e = t.el('DIV.w', { selector: 'div.w', box: [0, 0, 100, 100] });
  t.ramp(e, 'ren:ty', { k0: 30, k1: 110, fn: (p) => Math.round(Math.sin(p * 19) * 37 + Math.cos(p * 7) * 11) });
  t.mark('load-complete', 4).phase('load', 1, 200); t.write(root);
  const r = fitExemplar({ dir: path.join(root, 'takes', 'desktop', 'load'), s: sample(e, 30, 110), lead: 'ren:ty' });
  assert.equal(r.provenance, 'sampled'); assert.equal(r.law.class, 'keyframes');
  assert.ok(r.law.points.length <= 24); assert.ok(r.changes[0].keys.length >= 3);
});

test('a law with no one curve is unchecked, never passed', () => {
  assert.equal(evaluator({ model: { family: 'step', params: {} } }), null);
  assert.equal(lawError(null, { T: [1, 2, 3], y: [1, 2, 3], sy: [0, 0, 0] }), null);
  assert.equal(holds(null), false);
  const runs = Array.from({ length: 30 }, (_, i) => ({ i }));
  assert.equal(pickInstances(runs, runs[0]).length, 8);
  assert.ok(!pickInstances(runs, runs[0]).includes(runs[0]));
});

test('sentences read as a person says them', () => {
  const g = (name, changes, o = {}) => ({ name, changes, law: { class: 'tween', ms: 600 }, ...o });
  const up = { property: 'scale', family: 'scale', from: 1, to: 1.06 }, slide = { property: 'x', family: 'move', from: 12, to: 0 }, fade = { property: 'opacity', family: 'fade', from: 0, to: 1 };
  assert.equal(sentenceOf({ kind: 'touch', trigger: { kind: 'hover' } }, [g('Image', [up]), g('Label', [slide, fade])]), 'On hover the image scales up 6 % and the label slides left 12 px and fades in, 0.6 s.');
  assert.equal(sentenceOf({ kind: 'load', trigger: { kind: 'load' } }, [g('Word', [{ property: 'y', family: 'move', from: 40, to: 0 }], { count: 8 })]), 'On load, 8 words rise 40 px, 0.6 s.');
  assert.equal(sentenceOf({ kind: 'touch', trigger: { kind: 'hover' } }, [g('Card', [{ property: 'y', family: 'move', from: 0, to: -4 }], { part: 'hover' }), g('Card', [{ property: 'y', family: 'move', from: -4, to: 0 }], { part: 'press' })]), 'On hover it rises 4 px; on press it drops 4 px.');
  assert.equal(sentenceOf({ kind: 'scroll', trigger: {} }, [{ name: 'Picture', changes: [{ property: 'y', family: 'move', from: 0, to: -120 }], law: { class: 'map' } }]), 'As you scroll it rises 120 px, tied to scroll.');
  assert.equal(sentenceOf({ kind: 'load', trigger: {} }, []), null);
});

test('feel: one vote per move, and every share says of what', () => {
  const m = (ms, named, st = null) => ({ kind: 'load', groups: [{ law: { class: 'tween', ms, named }, stagger: st }] });
  const f = feelOf([m(400, 'power3.out', { ms: 40 }), m(600, 'power3.out', { ms: 42 }), m(900, 'power2.inOut'), { kind: 'ambient', groups: [{ law: { class: 'tween', ms: 9000 } }] }], { scroll: { mode: 'smoothed', lagMs: 110 }, smoother: 'Lenis' });
  assert.deepEqual(f.duration, { p25: 400, p50: 600, p75: 900, unit: 'ms', n: 3 });
  assert.deepEqual(f.curve, { name: 'power3.out', share: 0.67, n: 3 });
  assert.equal(f.stagger.ms, 40); assert.equal(f.scroll.by, 'Lenis');
  assert.equal(f.sentences[0], 'Most things take 0.4 to 0.9 s on an ease-out.');
  assert.deepEqual(feelOf([]).sentences, []);
});

test('S8 end to end on a synthetic site', async () => {
  const root = tmp();
  synthSite(root, { form: 'stored' });
  writeMoves(root, buildMoves(root, { viewports: ['desktop'] }));
  const r = await fitMoves(root, { workers: 0 });
  assert.deepEqual(r.problems, []);
  const index = JSON.parse(fs.readFileSync(path.join(root, 'moves.json'), 'utf8'));
  assert.deepEqual(indexProblems(index, { stage: 'fit' }), []);
  assert.ok(index.moves.length > 5);
  for (const m of index.moves) {
    assert.ok(m.proof && m.curve && m.time, m.id);
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'moves', `${m.id}.json`), 'utf8'));
    assert.deepEqual(moveFileProblems(doc, { stage: 'fit' }), []);
    if (m.proof.source !== 'seen') { assert.ok(doc.code.css && doc.code.gsap && doc.code.motion, m.name); assert.match(doc.prompt, /^Rebuild this motion/); assert.ok(doc.timing); } else assert.ok(m.gap, m.name);
    assert.ok(fs.readFileSync(path.join(root, 'moves', `${m.id}.js`), 'utf8').startsWith('window.__move('));
    assert.doesNotMatch(JSON.stringify(doc), /"pts":|"place":/, 'working fields stay out of the file');
  }
  const card = index.moves.find((m) => m.kind === 'touch' && /card/i.test(m.name));
  assert.ok(card, 'a card hover'); assert.match(card.sentence, /^On hover/);
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'moves', `${card.id}.json`), 'utf8'));
  assert.match(doc.code.gsap, /pointerleave/, 'a hover plays back when its leave has no law of its own');
  const cta = index.moves.find((m) => m.kind === 'touch' && /button/i.test(m.name));
  const ctaDoc = JSON.parse(fs.readFileSync(path.join(root, 'moves', `${cta.id}.json`), 'utf8'));
  assert.deepEqual(ctaDoc.groups.map((g) => g.part ?? 'in').sort(), ['in', 'out', 'press'], 'hover, press and leave are told apart');
  assert.match(ctaDoc.code.gsap, /pointerdown/); assert.match(ctaDoc.code.css, /:active/);
  assert.ok(r.ledger.length === 1 && r.ledger[0].viewport === 'desktop' && r.ledger[0].fitted > 0);
  assert.ok(index.site.feel.duration.n > 0);
  writeClipT0(root, { [card.id]: 0 });
  const after = JSON.parse(fs.readFileSync(path.join(root, 'moves', `${card.id}.json`), 'utf8'));
  assert.ok(after.groups.some((g) => Number.isFinite(g.clipT0)));
});

test('the same site in worker threads gives the same laws', async () => {
  const one = tmp(), two = tmp();
  for (const d of [one, two]) { synthSite(d, { form: 'stored' }); writeMoves(d, buildMoves(d, { viewports: ['desktop'] })); }
  await fitMoves(one, { workers: 0 }); await fitMoves(two, { workers: 2 });
  const laws = (d) => JSON.parse(fs.readFileSync(path.join(d, 'moves.json'), 'utf8')).moves.map((m) => [m.id, m.proof.source, m.curve.kind, m.curve.name]);
  assert.deepEqual(laws(two), laws(one));
});

test('a page-level move carries its reason', () => {
  assert.ok(GAPS.canvas.startsWith('This scene is drawn on a canvas.'));
  assert.match(moveScript('m-1', { a: '</script>' }), /\\u003c\/script/);
});

test('a spring keeps a start speed the fit withheld, or its code runs late of its own law', () => {
  const rec = { model: { family: 'spring', params: { omega: { value: 15 }, zeta: { value: 0.8 }, v0: { withheld_value: 200 }, target: { withheld_value: 100 } } } };
  const law = lawOf(rec, { span: 500, x0: 0 }, []);
  assert.equal(law.class, 'spring'); assert.equal(law.v0, 200); assert.equal(law.v0n, 2);
});

test('page scroll feel: a smoothed page with no fitted smoothing is still smoothed, never "the document does not scroll"', async () => {
  const { pageScrollFeel } = await import('../src/scan/moves/fit.js');
  // the 13 Nov showcase scan (a Lenis page): the law said smoothed, the lag went to windowMs because no smoothing was fitted
  const lenisPage = { id: 'm-01d9801f', kind: 'page-scroll', time: { delayMs: 0, staggerMs: null, count: 1, windowMs: 200 }, pageScroll: { mode: 'smoothed', lagMs: 200 } };
  assert.deepEqual(pageScrollFeel(lenisPage), { mode: 'smoothed', lagMs: null });
  const f = feelOf([], { scroll: pageScrollFeel(lenisPage), smoother: 'Lenis' });
  assert.equal(f.scroll.kind, 'smoothed');
  assert.ok(!f.sentences.some((s) => /does not scroll/.test(s)), f.sentences.join(' | '));
  // a fitted smoothing keeps its time; a page whose document never moved stays wheel-consumed
  assert.deepEqual(pageScrollFeel({ ...lenisPage, time: { ms: 830 } }, new Map([['m-01d9801f', { tauMs: 166 }]])), { mode: 'smoothed', lagMs: null });
  assert.deepEqual(pageScrollFeel({ ...lenisPage, time: { ms: 300 } }), { mode: 'smoothed', lagMs: 300 });
  assert.deepEqual(pageScrollFeel({ id: 'x', kind: 'page-scroll', time: {}, pageScroll: { mode: 'wheel-consumed', lagMs: null } }), { mode: 'wheel-consumed', lagMs: null });
  assert.equal(pageScrollFeel(null), null);
});
