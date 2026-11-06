// The move model on synthetic pages: stored takes and an arrive take must read the same, each motion lands where SYNTH_TRUTH says,
// every run lands in one bucket. Third-party data stays out of the repo, so the stored-site check lives with the night run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { easeOut, synthSite, synthTake, SYNTH_TRUTH } from './helpers/synthtake.js';
import { BUCKETS, indexProblems, moveFileProblems, MOVE_ID, tallyProblems } from '../src/scan/moves/contract.js';
import { buildMoves, builtWith, LAWS_FILE, problemsOf, writeMoves } from '../src/scan/moves/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-moves-'));
const built = new Map();
function site(form) {
  if (!built.has(form)) { const root = tmp(); synthSite(root, { form }); built.set(form, { root, b: buildMoves(root) }); }
  return built.get(form);
}
const docsOf = (b, kinds) => [...b.files.values()].filter((d) => b.index.moves.some((m) => m.id === d.id && kinds.includes(m.kind)));
const has = (b, kinds, desc) => docsOf(b, kinds).some((d) => d.groups.some((g) => g.elements.includes(desc)));
const nowhere = (b, desc) => ![...b.files.values()].some((d) => d.groups.some((g) => g.elements.includes(desc)));

for (const form of ['stored', 'arrive']) {
  test(`${form}: every motion lands where the truth says`, () => {
    const { b } = site(form);
    for (const d of SYNTH_TRUTH.load) assert.ok(has(b, ['load'], d), `load ${d}`);
    for (const d of SYNTH_TRUTH.ambient) assert.ok(has(b, ['ambient'], d), `ambient ${d}`);
    for (const d of SYNTH_TRUTH.scroll) assert.ok(has(b, ['scroll'], d), `scroll ${d}`);
    for (const d of SYNTH_TRUTH.scrollUp) assert.ok(has(b, ['scroll-up'], d), `scroll-up ${d}`);
    for (const d of SYNTH_TRUTH.touch) assert.ok(has(b, ['touch'], d), `touch ${d}`);
    for (const d of SYNTH_TRUTH.open) assert.ok(has(b, ['open'], d), `open ${d}`);
    for (const d of SYNTH_TRUTH.menuTouch) assert.ok(has(b, ['touch'], d), `inside ${d}`);
    for (const d of SYNTH_TRUTH.change) assert.ok(has(b, ['change'], d), `change ${d}`);
    for (const d of SYNTH_TRUTH.cursor) assert.ok(has(b, ['cursor'], d), `cursor ${d}`);
  });

  test(`${form}: what is no move stays out of the moves`, () => {
    const { b } = site(form);
    for (const d of [...SYNTH_TRUTH.rideAlong, ...SYNTH_TRUTH.clocked, ...SYNTH_TRUTH.belowNoise]) assert.ok(nowhere(b, d), d);
    assert.ok(!has(b, ['touch', 'open', 'change'], 'DIV.cursor'), 'a cursor is no reaction');
    assert.ok(!has(b, ['cursor'], 'SPAN.tip'), 'a tooltip that never moved is no cursor');
  });

  test(`${form}: every run lands in exactly one bucket, and the buckets add up`, () => {
    const { b } = site(form);
    assert.deepEqual(tallyProblems(b.index.tally), []);
    assert.equal(b.stats.unplaced, 0);
    assert.equal(BUCKETS.reduce((a, k) => a + b.index.tally[k], 0), b.index.tally.runs);
    assert.ok(b.index.tally.rideAlong > 0 && b.index.tally.clocked > 0 && b.index.tally.belowNoise > 0 && b.index.tally.inMoves > 0);
  });

  test(`${form}: the files hold what the contract asks at stage moves`, () => {
    const { b } = site(form);
    assert.deepEqual(problemsOf(b), []);
    assert.deepEqual(indexProblems(b.index, { stage: 'moves' }), []);
    for (const d of b.files.values()) { assert.deepEqual(moveFileProblems(d, { stage: 'moves' }), []); assert.ok(MOVE_ID.test(d.id)); }
    for (const m of b.index.moves) assert.ok(m.sentence.endsWith('.') && m.name.length > 2, m.name);
  });
}

test('both forms give the same moves', () => {
  const kinds = (b) => b.index.moves.map((m) => m.kind).sort();
  const a = site('stored').b, c = site('arrive').b;
  assert.deepEqual(kinds(c).filter((k) => k !== 'cursor'), kinds(a).filter((k) => k !== 'cursor'));
  const lead = (b) => new Set(b.index.moves.filter((m) => ['load', 'scroll', 'touch', 'open', 'change'].includes(m.kind)).map((m) => m.id));
  assert.deepEqual([...lead(c)].sort(), [...lead(a)].sort());
});

test('a rerun on the same takes gives the same ids', () => {
  const { root, b } = site('stored');
  assert.deepEqual(buildMoves(root).index.moves.map((m) => m.id), b.index.moves.map((m) => m.id));
});

test('a touch move holds its parts and its instances', () => {
  const { b } = site('stored');
  const card = docsOf(b, ['touch']).find((d) => d.groups.some((g) => g.elements.includes('A.card')));
  const entry = b.index.moves.find((m) => m.id === card.id);
  assert.equal(entry.n, 2, 'two members, one tile');
  assert.equal(entry.trigger.kind, 'hover');
  assert.ok(card.instances[0].marks.in != null && card.instances[0].marks.out != null);
  const cta = docsOf(b, ['touch']).find((d) => d.groups.some((g) => g.elements.includes('BUTTON.cta')));
  const parts = b.index.moves.find((m) => m.id === cta.id).trigger.parts.map((p) => p.kind);
  assert.ok(parts.includes('press') && parts.includes('hover'), 'a press has a place even though the frame plays the hover');
});

test('a parallax is linked, a reveal is triggered, each in its own group', () => {
  const { b } = site('stored');
  const group = (d) => docsOf(b, ['scroll']).flatMap((x) => x.groups).find((g) => g.elements.includes(d));
  assert.equal(group('IMG.parallax').scrollKind, 'linked');
  assert.equal(group('P.reveal').scrollKind, 'triggered');
});

test('writeMoves leaves the index, one file per move, and the fit its work list', () => {
  const { b } = site('stored'), out = tmp();
  const w = writeMoves(out, b);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'moves.json'), 'utf8')).schema, 'reva.moves/1');
  assert.equal(fs.readdirSync(path.join(out, 'moves')).length, w.files);
  const laws = JSON.parse(fs.readFileSync(path.join(out, LAWS_FILE), 'utf8')).laws;
  assert.equal(laws.length, w.laws);
  for (const l of laws) { assert.ok(l.sample.length >= 1 && l.sample.length <= 9); assert.ok(l.groups.length >= 1); assert.ok(l.sample[0].take); }
});

test('a phone recording pairs with desktop, and a phone-only move says so', () => {
  const root = tmp();
  synthSite(root, { form: 'stored', viewport: 'desktop' });
  synthSite(root, { form: 'stored', viewport: 'phone' });
  const b = buildMoves(root);
  assert.deepEqual(problemsOf(b), []);
  const card = docsOf(b, ['touch']).find((d) => d.groups.some((g) => g.elements.includes('A.card')));
  assert.equal(b.index.moves.find((m) => m.id === card.id).phone.status, 'same');
  assert.ok(card.instances.some((i) => i.viewport === 'phone'));
  assert.deepEqual(b.index.site.viewports, ['desktop', 'phone']);
});

test('a recorded desktop with no phone says not-recorded, never "does not happen"', () => {
  for (const m of site('stored').b.index.moves) assert.equal(m.phone.status, 'not-recorded');
});

test('a new document inside a test: what ran after it is a load, not a reaction', () => {
  const root = tmp();
  const t = synthTake({ name: 'opens-0', frames: 300 });
  const id = 'a.x~bb0001:click';
  t.mark(`${id}:open`, 100).mark('boot-done', 4).phase(`${id}:open`, 100, 299).pointer('mousePressed', 10, 10, 100);
  const old = t.el('DIV.old', { selector: 'div.old', box: [0, 0, 400, 400] });
  t.ramp(old, 'ren:opacity', { k0: 110, k1: 130, from: 1, to: 0, ease: easeOut });
  const fresh = t.el('DIV.fresh', { selector: 'div.fresh', box: [0, 0, 400, 400] });
  t.ramp(fresh, 'ren:ty', { k0: 200, k1: 240, from: 40, to: 0, ease: easeOut });
  t.newDocument(150);
  t.write(root);
  fs.writeFileSync(path.join(root, 'takes', 'desktop', 'opens.unit.json'), JSON.stringify({ ok: true, tests: [{ id, pattern: 'a.x~bb0001', take: 'opens-0', navigated: 'https://synth.test/x' }], names: ['opens-0'] }));
  const b = buildMoves(root);
  assert.ok(has(b, ['change'], 'DIV.old'), 'the exit is the change');
  assert.ok(!has(b, ['change'], 'DIV.fresh'), 'the next page arriving is not');
  assert.ok(b.index.tally.newDocument >= 1);
});

test('builtWith reads the probes first and leaves implied libraries out', () => {
  const look = { gsap: { found: true, version: '3.12.5' }, lenis: { found: false }, libraries: { list: [{ name: 'GSAP', status: 'detected', version: { value: '3.12.5', provenance: 'measured' } }, { name: 'React', status: 'detected', implied: true }, { name: 'three.js', status: 'detected', version: { value: 'r158', provenance: 'measured' } }, { name: 'Rive', status: 'maybe' }] } };
  assert.deepEqual(builtWith(look), [{ name: 'GSAP', version: '3.12.5', via: 'read' }, { name: 'three.js', version: 'r158', via: 'read' }]);
  assert.deepEqual(builtWith(null), []);
  // a page that draws WebGL says so near the front: its engine when probable in the bundle, raw WebGL when none is read (a skinned-mesh WebGL site, 6 Nov)
  const glSite = { gsap: { found: true, version: '3.12.5' }, libraries: { list: [{ name: 'three.js', status: 'probable' }] } };
  assert.deepEqual(builtWith(glSite, { webgl: true }).map((x) => x.name), ['GSAP', 'three.js']);
  assert.deepEqual(builtWith({ gsap: { found: true }, lenis: { found: true } }, { webgl: true }).map((x) => x.name), ['GSAP', 'WebGL', 'Lenis']);
  assert.deepEqual(builtWith(null, { webgl: true }).map((x) => x.name), ['WebGL']);
});
