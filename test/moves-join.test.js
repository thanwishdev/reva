// Declared values into moves, and the Lottie reader. Synthetic sites and files only: no third-party data, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { synthTake, easeOut } from './helpers/synthtake.js';
import { buildMoves, writeMoves } from '../src/scan/moves/index.js';
import { fitMoves } from '../src/scan/moves/fit.js';
import { channelsOf, easeOfName, gapOf, joinDeclared, judge, readDeclared, tweensFor } from '../src/scan/moves/join.js';
import { animationOf, lottieList, readDotLottie, readLottie, writeLottie } from '../src/scan/lottie.js';
import { GAPS, indexProblems, moveFileProblems, moveStatus } from '../src/scan/moves/contract.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-g6-'));
const quart = (p) => 1 - (1 - p) ** 4;   // GSAP's power3.out
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** A page with one load motion on power3.out over 36 frames, fitted; `decl` goes in as the take's declared series. */
async function site(decl, { ease = quart, channel = 'ren:ty' } = {}) {
  const root = tmp(), t = synthTake({ name: 'load', frames: 300 });
  const a = t.el('DIV.a', { selector: 'div.a', box: [0, 0, 400, 300], base: { [channel]: 40, 'ren:opacity': 1 } });
  t.ramp(a, channel, { k0: 20, k1: 56, from: 40, to: 0, ease });
  t.mark('load-complete', 4).phase('load', 1, 300); t.write(root);
  writeMoves(root, buildMoves(root, { viewports: ['desktop'] }));
  await fitMoves(root, { workers: 0 });
  const laws = read(path.join(root, 'moves-laws.json')).laws, el = laws[0].sample[0].el;
  if (decl) addDeclared(root, 'load', decl(el));
  return { root, el, index: () => read(path.join(root, 'moves.json')) };
}
function addDeclared(root, take, rows) {
  const dir = path.join(root, 'takes', 'desktop', take), f = path.join(dir, 'take.json'), t = read(f), text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const d = crypto.createHash('sha256').update(text).digest('hex'), file = `series/${d}.jsonl`;
  fs.writeFileSync(path.join(dir, file), text);
  t.series = { ...t.series, declared: { digest: d, file, format: 'jsonl', n: rows.length, provenance: 'declared' } };
  fs.writeFileSync(f, JSON.stringify(t));
}
const birth = (over) => ({ label: 'gsap-births', k: 30, n: 0, list: [], version: '3.12.5', gsap: [over] });
const tween = (el, o = {}) => ({ m: 'to', props: { y: 0 }, ease: 'power3.out', st: null, k: 20, T: 333, ids: [Number(el)], n: 1, off: null, dur: 0.6, delay: 0, rep: 0, yoyo: false, inTl: false, ...o });
const fileOf = (root, id) => read(path.join(root, 'moves', `${id}.json`));

test('channels and ease names', () => {
  assert.deepEqual(channelsOf('y'), ['ren:ty']);
  assert.deepEqual(channelsOf('yPercent'), ['ren:ty']);
  assert.deepEqual(channelsOf('scale'), ['ren:sx', 'ren:sy']);
  assert.deepEqual(channelsOf('backgroundColor'), ['ren:bg']);
  assert.deepEqual(channelsOf('--p'), ['ren:--p']);
  assert.deepEqual(channelsOf('onFoo'), []);
  assert.equal(easeOfName('power3.out').key, 'easeOutQuart');
  assert.equal(easeOfName('none').key, 'linear');
  assert.equal(easeOfName('elastic.out(1,0.3)'), null);
  assert.equal(easeOfName('reva'), null);
});

test('a tween holds a group only when its curve reproduces the frames', () => {
  const dots = Array.from({ length: 37 }, (_, i) => [i * (1000 / 60), quart(i / 36)]);
  assert.ok(gapOf(quart, dots, 600) < 0.5);
  assert.equal(judge(tween(1), dots, 600).checked, true);
  assert.equal(judge(tween(1, { ease: 'power1.in' }), dots, 600), null, 'a wrong ease');
  assert.equal(judge(tween(1, { dur: 0.3 }), dots, 600), null, 'a run longer than its tween');
  assert.equal(judge(tween(1, { rep: -1 }), dots, 600), null, 'a loop');
  assert.deepEqual(judge(tween(1, { ease: 'elastic.out(1,0.3)' }), dots, 600), { checked: false, ms: 600, ease: 'elastic.out(1,0.3)' }, 'no exact form: noted, not taken');
  assert.equal(tweensFor([tween(4), tween(5, { props: { x: 1 } }), tween(4, { keyframes: true })], '4', 'ren:ty').length, 1);
  assert.equal(tweensFor([tween(4)], '5', 'ren:ty').length, 0);
});

test('the site\'s own GSAP becomes the law, the proof and the code', async () => {
  const { root, el, index } = await site((id) => [birth(tween(id)), { label: 'gsap-rest', k: 60, n: 0, list: [], rest: { found: true, version: '3.12.5', tweens: [], scrollTriggers: [] }, lottie: [] }]);
  const before = index().moves[0];
  assert.equal(before.proof.source, 'fitted');
  assert.equal(readDeclared(path.join(root, 'takes', 'desktop', 'load')).tweens.length, 1);
  const r = joinDeclared(root);
  assert.deepEqual(r.problems, []);
  assert.equal(r.groups, 1); assert.equal(r.moves, 1); assert.equal(r.gsap.version, '3.12.5'); assert.equal(r.gsap.tweens, 1);
  const idx = index(), m = idx.moves[0], doc = fileOf(root, m.id), g = doc.groups[0];
  assert.equal(m.proof.source, 'declared'); assert.equal(m.proof.word, "From the site's own GSAP"); assert.equal(m.proof.via, 'gsap');
  assert.ok(m.proof.errorPct < 3, `error ${m.proof.errorPct}`);
  assert.equal(g.provenance, 'declared'); assert.equal(g.law.via, 'gsap'); assert.equal(g.law.ms, 600); assert.equal(g.law.named, 'power3.out');
  assert.equal(g.gsap.ease, 'power3.out');
  assert.match(doc.code.gsap, /power3\.out/); assert.match(doc.code.gsap, /duration: 0\.6/);
  assert.equal(m.curve.name, 'power3.out'); assert.equal(m.time.ms, 600);
  assert.ok(g.curve.length >= 2 && g.curve.at(-1)[1] === 1);
  assert.equal(idx.site.built.find((b) => b.name === 'GSAP').version, '3.12.5');
  assert.deepEqual(moveFileProblems(doc), []); assert.deepEqual(indexProblems(idx, { stage: 'fit' }), []);
  assert.match(fs.readFileSync(path.join(root, 'moves', `${m.id}.js`), 'utf8'), /own GSAP|"gsap"/, 'the card reads the same');
  void el;
});

test('a move the join rebuilds keeps its WebGL clocks and passes in the agent spec', async () => {
  const { root, index } = await site((id) => [birth(tween(id)), { label: 'gsap-rest', k: 60, n: 0, list: [], rest: { found: true, version: '3.12.5', tweens: [], scrollTriggers: [] }, lottie: [] }]);
  const id = index().moves[0].id, f = path.join(root, 'moves', `${id}.json`), doc = read(f);
  doc.glClocks = [{ uniform: 'u_time', program: 'p1', rate: 1, origin: 13.1 }];
  doc.glPasses = [{ program: 'p1', order: 0, drawsPerFrame: 1, frames: 60, into: ['canvas'], drawn: [[0, 1000]], reads: [], blend: 'alpha over', depth: 'no depth test', over: ['p2'], shows: 'alpha over p2 on the canvas' }];
  fs.writeFileSync(f, JSON.stringify(doc));
  joinDeclared(root);
  const pr = fileOf(root, id).prompt, a = pr.indexOf('Spec (JSON): ') + 13, spec = JSON.parse(pr.slice(a, pr.indexOf('\n', a) > 0 ? pr.indexOf('\n', a) : undefined));
  assert.equal(spec.clocks[0].originAtStart, 13.1);
  assert.deepEqual([spec.passes[0].blend, spec.passes[0].over, spec.passes[0].shows], ['alpha over', ['p2'], 'alpha over p2 on the canvas']);
});

test('a law read from the site\'s own GSAP clears the fit\'s "no simple curve fits": proof and gap never contradict', async () => {
  const { root, index } = await site((id) => [birth(tween(id))]);
  // the fit called the lead a recording (a 3D portfolio site, one move): its gap stays behind when GSAP explains the lead
  const f = path.join(root, 'moves.json'), idx0 = index(); idx0.moves[0].gap = GAPS.noLaw; fs.writeFileSync(f, JSON.stringify(idx0));
  assert.match(indexProblems(idx0, { stage: 'fit' }).join(), /no curve fits/, 'the contract sees the contradiction');
  const r = joinDeclared(root), m = index().moves[0];
  assert.deepEqual(r.problems, []);
  assert.equal(m.proof.source, 'declared'); assert.equal(m.gap, null);
  const st = moveStatus(m);
  assert.equal(st.key, 'exact'); assert.equal(st.reason, null); assert.equal(st.clip, null);
  assert.ok(!/fits|cannot|could not/.test(JSON.stringify(st)), 'no cannot-fit words on a declared move');
});

test('nothing declared, or a tween that does not fit: the move stays as measured', async () => {
  const a = await site(null), before = fs.readFileSync(path.join(a.root, 'moves.json'), 'utf8');
  const r = joinDeclared(a.root);
  assert.equal(r.gsap.found, false); assert.equal(r.moves, 0); assert.equal(fs.readFileSync(path.join(a.root, 'moves.json'), 'utf8'), before, 'byte for byte');
  const b = await site((id) => [birth(tween(id, { ease: 'power1.in' }))]);
  const s = joinDeclared(b.root), m = b.index().moves[0];
  assert.equal(s.groups, 0); assert.equal(m.proof.source, 'fitted'); assert.equal(s.gsap.found, true);
});

test('an ease the tool has no form for is said beside the measured law', async () => {
  const { root, index } = await site((id) => [birth(tween(id, { ease: 'elastic.out(1,0.3)' }))]);
  const r = joinDeclared(root), m = index().moves[0], g = fileOf(root, m.id).groups[0];
  assert.equal(r.groups, 0); assert.equal(r.noted, 1);
  assert.equal(m.proof.source, 'fitted'); assert.equal(g.provenance, 'fitted');
  assert.equal(g.gsap.ease, 'elastic.out(1,0.3)', 'the declared words stay beside the law'); assert.equal(g.gsap.ms, 600);
});

test('a declared stagger and scroll trigger reach the move', async () => {
  const { root, index } = await site((id) => [birth(tween(id, { off: [0, 0.04], st: { start: 'top 80%', end: 'top 20%', scrub: false } }))]);
  joinDeclared(root);
  const g = fileOf(root, index().moves[0].id).groups[0];
  assert.equal(g.gsap.stagger, 40); assert.equal(g.gsap.scrollTrigger.start, 'top 80%');
});

// ---------------------------------------------------------------- Lottie
const LOTTIE = { v: '5.7', fr: 30, ip: 0, op: 60, w: 100, h: 100, nm: 'Icon\u0007', assets: [{ id: 'c', layers: [{ ty: 4, nm: 'inner', ks: { s: { a: 1, k: [{ t: 0, s: [0, 0], o: { x: [0.3], y: [0] }, i: { x: [0.7], y: [1] } }, { t: 30, s: [100, 100] }] } }, shapes: [{ ks: { a: 1, k: [{ t: 0 }] } }] }] }],
  layers: [{ ty: 0, nm: 'comp', ks: { o: { a: 1, k: [{ t: 0, s: [0] }, { t: 15, s: [100] }] }, r: { a: 0, k: 0 } } }] };
/** A stored .lottie: one file, no compression. */
function zipOf(name, body) {
  const n = Buffer.from(name), b = Buffer.from(body), head = Buffer.alloc(30), cen = Buffer.alloc(46), end = Buffer.alloc(22), crc = zlib.crc32(b);
  head.writeUInt32LE(0x04034b50, 0); head.writeUInt32LE(crc, 14); head.writeUInt32LE(b.length, 18); head.writeUInt32LE(b.length, 22); head.writeUInt16LE(n.length, 26);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(b.length, 20); cen.writeUInt32LE(b.length, 24); cen.writeUInt16LE(n.length, 28);
  const local = Buffer.concat([head, n, b]), dir = Buffer.concat([cen, n]);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, dir, end]);
}
function archive() {
  const dir = tmp(); fs.mkdirSync(path.join(dir, 'files'));
  const put = (n, b) => fs.writeFileSync(path.join(dir, 'files', n), b);
  put('a.lottie', zipOf('animations/one.json', JSON.stringify(LOTTIE))); put('b.json', JSON.stringify(LOTTIE)); put('c', JSON.stringify(LOTTIE)); put('d.json', '{"layers":"no"}'); put('e.lottie', ''); put('f.lottie', 'not a zip'); put('g.json', '{"plain":1}');
  const e = (n, url, contentType) => ({ url, path: `files/${n}`, contentType });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ entries: [e('a.lottie', 'https://x.test/a.lottie?v=1', 'application/zip'), e('b.json', 'https://x.test/b.json', 'application/json'), e('c', 'https://x.test/api/c', 'application/json; charset=utf-8'), e('d.json', 'https://x.test/d.json', ''), e('e.lottie', 'https://x.test/e.lottie', ''), e('f.lottie', 'https://x.test/f.lottie', ''), e('g.json', 'https://x.test/g.json', ''), { url: 'https://x.test/h.png', path: 'files/h.png' }] }));
  return dir;
}

test('a Lottie reduces to timing: precomps in, names clean, keys in milliseconds', () => {
  const a = animationOf(LOTTIE, 'one');
  assert.equal(a.ms, 2000); assert.equal(a.name, 'Icon'); assert.equal(a.layerCount, 2);
  assert.deepEqual(a.layers[0].tracks.opacity.map((k) => k.ms), [0, 500]);
  assert.deepEqual(a.layers[1].tracks.scale[0].out, [0.3, 0]);
  assert.equal(a.layers[1].animatedShapes, 1);
});

test('the archive: .lottie, JSON by content, and every failure in a line', () => {
  const dir = archive(), doc = readLottie(dir);
  assert.deepEqual(doc.files.map((f) => f.kind), ['lottie', 'json', 'json']);
  assert.equal(doc.files[0].animations[0].id, 'one');
  assert.deepEqual(doc.skipped.map((s) => s.url.split('/').pop()), ['e.lottie', 'f.lottie']);
  assert.equal(doc.skipped[0].why, 'empty body');
  assert.equal(readDotLottie(path.join(dir, 'files', 'a.lottie')).length, 1);
  const list = lottieList(doc);
  assert.equal(list[0].file, 'a.lottie'); assert.equal(list[0].ms, 2000);
  const out = tmp();
  assert.deepEqual(writeLottie(dir, out), { files: 3, animations: 3, skipped: 2 });
  assert.equal(read(path.join(out, 'lottie.json')).schema, 'reva.lottie/1');
  assert.deepEqual(readLottie(tmp()), { schema: 'reva.lottie/1', files: [], skipped: [] }, 'no manifest, nothing');
});

test('a file one element loads joins its move; the rest is listed for the site', async () => {
  const { root, index } = await site(() => [{ label: 'gsap-rest', k: 1, n: 0, list: [], rest: { found: false }, lottie: [{ url: 'https://x.test/a.lottie?v=1', selector: 'div.a' }] }]);
  writeLottie(archive(), root);
  const r = joinDeclared(root), idx = index(), m = idx.moves[0], doc = fileOf(root, m.id);
  assert.equal(r.lottie, 1);
  assert.equal(m.proof.word, "From the site's Lottie file"); assert.equal(m.proof.source, 'declared'); assert.equal(m.time.ms, 2000);
  assert.equal(doc.lottie.fr, 30); assert.equal(idx.site.lottie.length, 3);
});

test('a morph keeps its run and stays out of the code', async () => {
  const { root, index } = await site(null, { channel: 'ren:--svg-d', ease: easeOut });
  const before = fileOf(root, index().moves[0].id);
  assert.ok(before.groups[0].changes.some((c) => String(c.property).startsWith('--svg-') || String(c.channel).startsWith('ren:--svg-')), JSON.stringify(before.groups[0].changes));
  const r = joinDeclared(root), m = index().moves[0], doc = fileOf(root, m.id);
  assert.equal(r.morphs, 1);
  assert.deepEqual(doc.groups[0].changes, []);
  assert.doesNotMatch(doc.code.css + doc.code.gsap, /--svg-/);
  assert.ok(doc.notes.some((n) => /shape itself/.test(n))); assert.match(m.gap, /shape itself/);
});
