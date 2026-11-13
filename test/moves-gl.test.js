// WebGL inside a move: a page change whose screen is a shader pass. The uniforms that change in the move's window join its spec, fitted
// like DOM channels; a time uniform that only ticks is left out and said so. Synthetic site, known truth, no browser.
//   truth: u_progress 0 -> 1 over 144 frames (2.4 s), easeInOut cubic, from 17 frames after the click; u_time = page time in seconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthSite, synthTake, easeInOut } from './helpers/synthtake.js';
import { buildMoves, writeMoves } from '../src/scan/moves/index.js';
import { fitMoves } from '../src/scan/moves/fit.js';
import { withWorkerRows, cadenceWords, clockAt, drawEventsOf, drawsOf, geometryOf, passesOf, GL_LEFT, glChannelsIn, glClocksOf, glLeads, programValuesOf, segmentsOf, tickKind, withObjectPositions } from '../src/scan/moves/glmove.js';
import { sentenceOf } from '../src/scan/moves/intent.js';
import { agentPrompt } from '../src/export/move.js';

const K = 106, ON = K + 17, LEN = 144;
const progress = (k) => (k < ON ? 0 : k >= ON + LEN ? 1 : +easeInOut((k - ON) / LEN).toFixed(6));
/** synthSite's change take, with a full-screen canvas whose shader pass runs the change. */
function glChange(root) {
  const ch = synthTake({ name: 'change-0', frames: 340 });
  ch.mark('boot-done', 4).mark('change', K).mark('change-end', K + 198).phase('change', K, K + 197).pointer('mousePressed', 800, 60, K);
  const exit = ch.el('DIV.exit', { selector: 'div.exit', box: [0, 0, 1440, 900], fixed: true });
  ch.ramp(exit, 'ren:ty', { k0: K + 12, k1: K + 60, from: 900, to: 0, ease: easeInOut }).ramp(exit, 'ren:ty', { k0: K + 90, k1: K + 138, from: 0, to: -900, ease: easeInOut });
  const cv = ch.el('CANVAS', { selector: 'canvas#gl', box: [0, 0, 1440, 900], fixed: true });
  ch.uniform('p1|u_progress', progress).uniform('p1|u_time', (k) => +(k / 60).toFixed(6)).uniform('p1|u_center', () => [0.5, 0.25]).uniform('p1|u_color', () => [1, 0.5, 0]);
  // passes: p3 draws the scene into target 1, p1 (the ink) reads it and a noise image onto the canvas, p2 (a title) draws only from ON + 40
  // and its text moves left 3 units over 60 frames from ON + 50
  ch.draws((k) => ({ p3: [1, 0, 1], p1: [1, 1, 0], ...(k >= ON + 40 ? { p2: [6, 2, 0] } : {}) }));
  const mv = (x) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0.5, -5, 1];
  const proj = [1.25, 0, 0, 0, 0, 2, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2002, 0];   // a perspective camera: f 2, aspect 1.6
  ch.objects((k) => ({ 'p2|modelViewMatrix': mv(k < ON + 50 ? 0 : k >= ON + 110 ? -3 : +(-3 * easeInOut((k - ON - 50) / 60)).toFixed(6)), 'p2|projectionMatrix': proj }));
  const textures = [{ id: 1, ctx: 0, target: 3553, w: 1440, h: 900, source: 'empty', uploads: 1, updates: 0, levels: 0, fb: 1, sampled: ['p1|u_scene'] }, { id: 2, ctx: 0, target: 3553, w: 256, h: 256, source: 'image', uploads: 1, updates: 0, levels: 0, fb: null, sampled: ['p1|u_noise'] }];
  // composite: the scene opaque with depth (1), the ink alpha over (2, three.js NormalBlending), the title additive, no depth write (3)
  ch.blends((k) => ({ p3: 1, p1: 2, ...(k >= ON + 40 ? { p2: 3 } : {}) }));
  // the title is drawn over the ink on the canvas; the ink is first on the canvas (the scene is in its own target)
  ch.unders((k) => (k >= ON + 40 ? { p2: [1] } : {}));
  const states = [{ id: 1, blend: null, depth: { test: true, write: true, func: 515 }, cull: 1029, scissor: false, colorMask: [1, 1, 1, 1] },
    { id: 2, blend: { eq: [32774, 32774], src: [770, 1], dst: [771, 771] }, depth: { test: false, write: true, func: 515 }, cull: null, scissor: false, colorMask: [1, 1, 1, 1] },
    { id: 3, blend: { eq: [32774, 32774], src: [770, 770], dst: [1, 1] }, depth: { test: true, write: false, func: 515 }, cull: null, scissor: false, colorMask: [1, 1, 1, 1] }];
  ch.canvas(cv, { states, textures, targets: [{ id: 1, ctx: 0, tex: [1], w: 1440, h: 900 }], programs: [{ id: 1, ctx: 0, uses: 300, vs: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fs: 'uniform float u_progress; uniform float u_time; float noise(vec2 p){ return 0.0; } void main(){ gl_FragColor = vec4(noise(vec2(u_progress, u_time))); }', uniforms: [{ name: 'u_progress', type: 'float', size: 1 }, { name: 'u_time', type: 'float', size: 1 }, { name: 'u_center', type: 'vec2', size: 1 }, { name: 'u_color', type: 'vec3', size: 1 }, { name: 'u_unset', type: 'float', size: 1 }], ints: {} }] });
  ch.write(root);
}

test('a change move gets the shader pass that runs it: u_progress fitted at 2.4 s, leading; u_time left out as a clock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-gl-'));
  try {
    synthSite(root, { form: 'stored' }); glChange(root);
    writeMoves(root, buildMoves(root, { viewports: ['desktop'] }));
    await fitMoves(root, { workers: 0 });
    const index = JSON.parse(fs.readFileSync(path.join(root, 'moves.json'), 'utf8'));
    const m = index.moves.find((x) => x.kind === 'change' && x.instances?.[0]?.take === 'change-0');
    assert.ok(m, `a change move on change-0: ${index.moves.map((x) => `${x.kind}/${x.take}`).join(', ')}`);
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'moves', `${m.id}.json`), 'utf8'));
    const g = doc.groups.find((x) => x.layer === 'gl' && x.lead.channel === 'gl:u_progress');
    assert.ok(g, `a gl:u_progress group: ${doc.groups.map((x) => x.lead?.channel).join(', ')}`);
    assert.equal(g.provenance, 'fitted');
    assert.equal(g.law.class, 'tween');
    assert.ok(Math.abs(g.law.ms - 2400) <= 2400 * 0.03, `fitted ${g.law.ms} ms, planted 2400 ms`);
    assert.deepEqual([g.changes[0].from, g.changes[0].to], [0, 1]);
    assert.equal(g.gl.cover, 1);
    assert.ok(!doc.groups.some((x) => (x.channels || []).includes('gl:u_time')), 'u_time is no group');
    assert.ok(doc.glLeft.list.some((x) => x.channel === 'gl:u_time' && x.why === GL_LEFT.clock), JSON.stringify(doc.glLeft));
    // the clock is data: its program, rate per second and its value when the move starts (u_time = k / 60 s)
    const clock = doc.glClocks.find((x) => x.uniform === 'u_time');
    assert.equal(clock.program, 'p1'); assert.ok(Math.abs(clock.rate - 1) < 1e-3, `rate ${clock.rate}`);
    const T0 = doc.instances[0].T0; assert.ok(Math.abs(clock.origin - T0 / 1000) <= 1 / 60 + 1e-6, `origin ${clock.origin} at T0 ${T0}`);
    // the largest visible layer leads: the group, the words, the timing and the agent's spec
    assert.equal(doc.groups[0].lead.channel, 'gl:u_progress');
    assert.match(m.sentence, /^Between pages a full-screen WebGL layer \(a noise function\) runs u_progress 0 → 1 over 2\.4 s/);
    assert.match(doc.timing, /^24\d\d ms/);
    const spec = JSON.parse(/Spec \(JSON\): (.*)/.exec(doc.prompt)[1]);
    assert.equal(spec.groups[0].layer, 'WebGL'); assert.equal(spec.groups[0].program, 'p1');
    assert.deepEqual(Object.keys(spec.clocks[0]), ['uniform', 'program', 'ratePerSecond', 'originAtStart', 'counts']); assert.equal(spec.clocks[0].originAtStart, clock.origin); assert.equal(spec.clocks[0].counts, 'second');
    // every value p1 reads is in the spec: u_center and u_color set once (never moving, so no group), u_progress and u_time animated
    const p1 = spec.programs.find((x) => x.programs.includes('p1'));
    assert.deepEqual(p1.set, { u_center: [0.5, 0.25], u_color: [1, 0.5, 0] });
    assert.equal(p1.animated.u_progress.as, 'group WebGL u_progress'); assert.equal(p1.animated.u_time.as, 'clock');
    assert.deepEqual(p1.defaults, ['u_unset'], 'a uniform the page never sets reads GL\'s default');
    // its shader source stays in the move file, one copy; the prompt points to it by program, hash and JSON path
    const sh = spec.shaders.find((x) => x.programs.includes('p1')); assert.equal(sh.hash, p1.source); assert.equal(sh.file, `moves/${m.id}.json`);
    const at = doc.glSources.findIndex((x) => x.hash === sh.hash); assert.equal(sh.fs, `glSources[${at}].fs`); assert.match(doc.glSources[at].fs, /uniform float u_progress/);
    assert.doesNotMatch(doc.prompt, /uniform float u_progress|void main/, 'no page code in the prompt');
    // the title's program starts drawing inside the window: a switch of the drawn set, at its time
    assert.deepEqual(spec.programSwitches.atStart, ['p1', 'p3']);
    const sw = spec.programSwitches.events.find((e) => e.starts.includes('p2')); assert.ok(sw && Math.abs(sw.atMs - ((ON + 40) * 1000 / 60 - doc.instances[0].T0)) <= 17, JSON.stringify(spec.programSwitches));
    // the canvas: its element and box at the move's start
    assert.deepEqual([spec.canvases[0].selector, spec.canvases[0].box], ['canvas#gl', [0, 0, 1440, 900]]);
    assert.ok(!/gl:u_progress|u_progress/.test(doc.code.css), 'no CSS claims to set a uniform');
    // the pass graph, in drawing order: the scene into a target, the ink reading it onto the canvas, the title from ON + 40
    const ms = (k) => Math.round(((k - K) * 1000) / 60 * 10) / 10 - Math.round((doc.instances[0].T0 - (K * 1000) / 60) * 10) / 10;
    assert.deepEqual(doc.glPasses.map((x) => [x.program, x.into.join()]), [['p3', 'target 1 (1440x900)'], ['p1', 'canvas'], ['p2', 'canvas']]);
    assert.deepEqual(doc.glPasses[1].reads.map((r) => [r.uniform, r.kind, r.from?.join() ?? null]), [['u_scene', 'render target', 'p3'], ['u_noise', 'noise', null]]);
    const title = doc.glPasses[2]; assert.equal(title.drawn.length, 1); assert.ok(Math.abs(title.drawn[0][0] - ms(ON + 40)) <= 17, `the title draws from ${title.drawn[0][0]} ms, planted ${ms(ON + 40)}`);
    assert.ok(g.gl.drawn[0][0] <= 0, 'the ink draws from before the move');
    // the title's text moves: its object matrix is a channel of its program, fitted like a uniform
    // ...and with its program's projection it is on the screen: x 720 -> 180 px (x -3 at z -5, f 2, aspect 1.6)
    const text = doc.groups.find((x) => x.layer === 'gl' && /modelViewMatrix\.(position|screen)/.test(x.lead.channel));
    assert.ok(text, `a position group: ${doc.groups.filter((x) => x.layer === 'gl').map((x) => x.lead.channel).join(', ')}`);
    assert.equal(text.gl.program, 'p2'); assert.deepEqual([text.changes[0].property, text.changes[0].from, text.changes[0].to, text.changes[0].unit], ['modelViewMatrix.screen.x', 720, 180, 'px']);
    assert.ok(text.changes.some((c) => c.property === 'modelViewMatrix.position.x' && c.to === -3), 'the 3D position rides along in the same group');
    assert.equal(doc.groups.filter((x) => x.layer === 'gl' && x.gl.program === 'p2').length, 1, 'one group per object');
    assert.equal(glLeads(text), false, 'an object is a part of the layer, never its lead');
    const z = text.changes.find((c) => c.property === 'modelViewMatrix.position.x');
    assert.ok(z.follows || (z.keys?.length >= 2 && Number.isFinite(z.keysT0)), 'a component off the law keeps its own stops');
    assert.ok(text.channels.some((c) => /inView/.test(c)) || !text.changes.some((c) => /inView/.test(c.property)), 'in view is a channel of the object when it changes');
    assert.equal(text.law.class, 'tween'); assert.ok(Math.abs(text.law.ms - 1000) <= 40, `text ${text.law.ms} ms, planted 1000`);
    // how each pass shows over the one under it
    assert.deepEqual(doc.glPasses.map((x) => [x.program, x.blend, x.over.join(), x.depth]), [['p3', 'replaces', '', 'depth LEQUAL, writes'], ['p1', 'alpha over', '', 'no depth test'], ['p2', 'additive over', 'p1', 'depth LEQUAL, no write']]);
    assert.equal(doc.glPasses[0].shows, 'replaces what target 1 (1440x900) held (first since its clear)'); assert.equal(doc.glPasses[0].cull, 'back');
    assert.equal(doc.glPasses[2].shows, 'additive over p1 on the canvas (depth-tested: the nearer wins)');
    assert.deepEqual(doc.glPasses[1].factors, { equation: 'ADD / ADD', src: 'SRC_ALPHA / ONE', dst: 'ONE_MINUS_SRC_ALPHA / ONE_MINUS_SRC_ALPHA' });
    assert.deepEqual([spec.passes[2].blend, spec.passes[2].over, spec.passes[2].shows], ['additive over', ['p1'], 'additive over p1 on the canvas (depth-tested: the nearer wins)']);
    assert.equal(spec.passes.length, 3); assert.deepEqual(spec.passes[1].reads[0], { uniform: 'u_scene', kind: 'render target', size: '1440x900', from: ['p3'] });
    assert.ok(Math.abs(g.delayMs - (ON - (K + 12)) * (1000 / 60)) <= 34, `the pass starts after the DOM: ${g.delayMs} ms`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a clock: rate from the frames it rose, origin held while its program is not drawn, run back when no sample is earlier', () => {
  const T = [0, 100, 200, 300, 400, 500], held = [1, 1, 1, 1.3, 1.4, 1.5];   // held at 1 until 250 ms, then 1 per second
  assert.deepEqual(clockAt(T, held, T.slice(2), held.slice(2), 210), { rate: 1, origin: 1, at: 210, sampledAt: 200 });
  const ms = [5000, 5016.7, 5033.3, 5050], T2 = [16.7, 33.3, 50, 66.7];   // a millisecond clock with no sample before T0 = 0
  const c = clockAt(T2, ms, T2, ms, 0); assert.ok(Math.abs(c.rate - 1000) < 5 && c.extrapolated && Math.abs(c.origin - 4983.3) < 1, JSON.stringify(c));
  const rows = Array.from({ length: 200 }, (_, k) => ({ k, T: (k * 1000) / 60, sy: 0, v: {}, gl: { 'p3|uTime': k / 60, 'p7|u_time': 40 + k / 60 } }));
  const clocks = glClocksOf(glChannelsIn(rows, { T0: 2000, T1: 2500 }));
  assert.deepEqual(clocks.map((x) => [x.program, x.uniform, Math.round(x.origin * 1000) / 1000]), [['p3', 'uTime', 2], ['p7', 'u_time', 42]]);
});

test('an object on the screen: its origin in px, and in view only inside the camera\'s near and far planes', () => {
  // three.js perspective, fov 33.4 deg, near 1, far 2201.2 (a 3D portfolio site); the text flies in from z -2500 to -1500
  const f = 1 / Math.tan((33.4 / 2) * Math.PI / 180), n = 1, F = 2201.2, P = [f / 1.6, 0, 0, 0, 0, f, 0, 0, 0, 0, -(F + n) / (F - n), -1, 0, 0, -2 * F * n / (F - n), 0];
  const mv = (x, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1];
  const rows = [-2500, -2210, -2190, -1500].map((z, i) => ({ k: i, T: i * 16.7, v: {}, gl: {}, glo: { 'p22|modelViewMatrix': mv(z === -1500 ? -208 : 0, z), 'p22|projectionMatrix': P } }));
  const out = withObjectPositions(rows, { width: 1440, height: 900 });
  assert.deepEqual(out.map((r) => r.gl['p22|modelViewMatrix.inView']), [0, 0, 1, 1]);
  assert.deepEqual(out[0].gl['p22|modelViewMatrix.screen'], [720, 450]);
  assert.ok(Math.abs(out[3].gl['p22|modelViewMatrix.screen'][0] - 511.5) < 2, `x ${out[3].gl['p22|modelViewMatrix.screen'][0]}`);
  assert.equal(withObjectPositions([{ k: 0, T: 0, v: {}, gl: { a: 1 } }])[0].gl.a, 1, 'rows without object matrices are as they were');
});

test('a uniform that was already moving before the move is ambient, not the move', () => {
  const rows = Array.from({ length: 300 }, (_, k) => ({ k, T: (k * 1000) / 60, sy: 0, v: {}, gl: { 'p1|uWave': Math.sin(k / 9), 'p1|uStep': k >= 150 ? 1 : 0 } }));
  const c = glChannelsIn(rows, { T0: 2000, T1: 4000 });
  assert.equal(c.find((x) => x.ch === 'gl:uWave').status, 'ambient');
  assert.equal(c.find((x) => x.ch === 'gl:uStep').status, 'step');
  // a fluid that follows the pointer: its force moves with uMouse, so neither is the move's; three.js's camera copies are not either
  const at = (k) => (k < 150 ? 0 : Math.min(1, (k - 150) / 20));
  const more = rows.map((r, k) => ({ ...r, gl: { ...r.gl, 'p2|uMouse': at(k) * 300, 'p2|uForce': at(k), 'p3|cameraPosition': [0, 0, 5 - at(k)], 'p5|cameraPosition': [0, 0, 6 - at(k)], 'p4|uReveal': at(k) } }));
  const by = Object.fromEntries(glChannelsIn(more, { T0: 2000, T1: 4000 }).map((c) => [c.ch, c.status]));
  assert.equal(by['gl:uMouse'], 'pointer'); assert.equal(by['gl:uForce'], 'pointer');
  assert.equal(by['gl:cameraPosition@p3.z'], 'derived'); assert.equal(by['gl:cameraPosition@p5.z'], 'derived'); assert.equal(by['gl:uReveal'], 'motion');
  assert.deepEqual(segmentsOf([0, 1, 2, 3, 9, 10], [0, 0, 1, 1, 1, 2], { restMs: 2 }).map((s) => [s.i0, s.i1]), [[1, 2], [4, 5]]);
});

test('a new page state is data in the spec, never the motion of a change', () => {
  const groups = [
    { name: 'Wrap', count: 9, state: 'new page', provenance: 'fitted', law: { class: 'steps', ms: 0, delayMs: 0 }, changes: [{ property: 'color', family: 'colour', from: 'rgb(0, 0, 0)', to: 'rgb(9, 9, 9)', unit: '' }] },
    { name: 'Menu', count: 4, provenance: 'declared', law: { class: 'tween', ms: 1000, delayMs: 0 }, changes: [{ property: 'x', family: 'move', from: 0, to: -590, unit: 'px' }] },
  ];
  assert.equal(sentenceOf({ kind: 'change', trigger: { kind: 'page' } }, groups), 'Between pages, 4 menus slide left 590 px, 1 s.');
  const spec = JSON.parse(/Spec \(JSON\): (.*)/.exec(agentPrompt({ name: 'x', sentence: 'x', trigger: { kind: 'page' }, groups }))[1]);
  assert.equal(spec.groups[0].is, 'new page state, set at once: not a motion');
  assert.equal(spec.groups[0].law, undefined);
  assert.deepEqual(spec.groups[0].changes[0], { property: 'color', from: 'rgb(0, 0, 0)', to: 'rgb(9, 9, 9)', unit: '' });
});

test('a clock says what it counts: page time, a step per frame (uTime +0.016), or a step per draw (uTime, every 2 of 3 frames)', () => {
  const F = 1000 / 60, T = Array.from({ length: 30 }, (_, i) => 5000 + i * F);
  assert.deepEqual(tickKind(T, T.map((t) => t / 1000)), { per: 'second' });
  assert.deepEqual(tickKind(T, T.map((_, i) => Math.fround(0.016 * i))), { per: 'frame', step: 0.016, frameMs: 16.667 });
  const Td = T.filter((_, i) => i % 3 !== 2);
  assert.deepEqual(tickKind(Td, Td.map((_, i) => 0.01 * i)), { per: 'draw', step: 0.01 });
  assert.deepEqual(tickKind(Td, Td.map((t) => t / 1000)), { per: 'second' });
});

test('a value set while its program was hidden is a jump at its next draw, never a motion; the drawn set changing is an event', () => {
  const F = 1000 / 60, rows = [];
  // p7 draws frames 0-29, not 30-89, again from 90; its uTime is set (held) while hidden and jumps 0.5 -> 3 at frame 90
  for (let i = 0; i < 140; i++) rows.push({ k: i, T: 1000 + i * F, gl: { 'p7|uMix': i < 30 ? 0.5 : 3 }, gld: { p1: [1, 0, 0], ...(i < 30 || i >= 90 ? { p7: [1, 1, 0] } : {}) } });
  const ch = glChannelsIn(rows, { T0: 1000, T1: 1000 + 139 * F });
  assert.equal(ch.filter((c) => c.ch === 'gl:uMix').length, 0, JSON.stringify(ch.map((c) => [c.ch, c.status])));
  assert.equal(segmentsOf([0, 16, 500, 516], [0, 0, 3, 3]).length, 0);
  const ev = drawEventsOf(rows, { T0: 1000, Tend: 1000 + 139 * F });
  assert.deepEqual(ev.atStart, ['p1', 'p7']);
  assert.deepEqual(ev.events.map((e) => [Math.round(e.atMs), e.starts, e.stops]), [[500, [], ['p7']], [1500, ['p7'], []]]);
  // the values it reads count only while it draws: uMix is 0.5 then 3, both drawn, so it is animated, never 'set'
  const v = programValuesOf(rows, { draws: new Map([['p1', {}], ['p7', {}]]), T0: 1000, Tend: 1000 + 139 * F });
  assert.deepEqual(v.find((x) => x.programs.includes('p7')).animated.uMix, { from: 0.5, to: 3, values: 2, as: 'changes in the window' });
});

test('a move whose largest layer is a canvas no uniform of which leads says so first (a hover over a three.js scene)', () => {
  const g = { name: 'Paragraph', count: 11, changes: [{ property: 'opacity', from: 1, to: 0, channel: 'ren:opacity', unit: '' }], law: { class: 'tween', ms: 650 } };
  const s = sentenceOf({ kind: 'touch', trigger: { kind: 'hover' }, glLayer: { cover: 1, engine: 'three.js', switchAtMs: 1000 } }, [g]);
  // the program switch stays in the spec (programSwitches), out of the sentence (11 Nov)
  assert.match(s, /^On hover a full-screen WebGL layer \(three\.js\) keeps drawing; /);
  assert.doesNotMatch(s, /switches programs/);
  assert.match(sentenceOf({ kind: 'touch', trigger: { kind: 'hover' }, glLayer: { cover: 0.6, engine: null } }, [g]), /a WebGL layer over 60 % of the screen keeps drawing; /);
  const two = sentenceOf({ kind: 'touch', trigger: { kind: 'hover' }, glLayer: { cover: 1, engine: null } }, [{ ...g, part: 'press' }, { ...g, name: 'Logo', part: 'hover' }]);
  assert.match(two, /^Over a full-screen WebGL layer that keeps drawing: on press /);
  assert.doesNotMatch(sentenceOf({ kind: 'touch', trigger: { kind: 'hover' }, glLayer: { cover: 0.2 } }, [g]), /WebGL/);
});

test('skinned motion is in the data: bones that change while the program draws, per-draw slots, the geometry drawn (a skinned head, 6 Nov)', () => {
  const F = 1000 / 60, rows = [];
  const bone = (x) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  for (let i = 0; i < 30; i++) rows.push({ k: i, T: 1000 + i * F, gld: { p40: [1, 0, 0], p41: [1, 1, 0] }, glg: { p40: 3 },
    gla: { 'p40|uBones[0]': bone(0), 'p40|uBones[1]': bone(i / 30), 'p41|uBones': '=p40|uBones' }, gls: { 'p40|opacity#0': 1, 'p40|opacity#1': 0.5 } });
  const v = programValuesOf(rows, { draws: new Map([['p40', {}], ['p41', {}]]), T0: 1000, Tend: 1000 + 29 * F });
  const a = v.find((x) => x.programs.includes('p40')).arrays.uBones;
  assert.deepEqual([a.elements, a.of, a.changedElements, a.changedFrames], [2, 'mat4', 1, 29]);
  assert.ok(Math.abs(a.maxDelta - 1 / 30) < 1e-6);
  assert.equal(v.find((x) => x.programs.includes('p41')).arrays.uBones.sameAs, 'p40');
  assert.deepEqual(v.find((x) => x.programs.includes('p40')).perDraw.opacity.slots, [1, 0.5]);
  const gl = { geometries: [{ id: 3, program: 'p40', mode: 4, count: 3000, indexType: 5123, indexOffset: 0, indexBuffer: 2, instances: 0, attribs: [{ name: 'position', glslType: 'vec3', location: 0, size: 3, type: 5126, normalized: false, stride: 0, offset: 0, buffer: 1 }] }],
    buffers: [{ id: 1, size: 5e6, hash: 'ab:5000000', url: 'https://x/head.glb', kept: false }, { id: 2, size: 6000, hash: 'cd:6000', kept: true }] };
  const g = geometryOf(rows, gl, { T0: 1000, Tend: 1000 + 29 * F }).list[0];
  assert.deepEqual([g.mode, g.count, g.frames, g.index.bytes, g.index.kept, g.attribs[0].url, g.attribs[0].kept], ['TRIANGLES', 3000, 30, 6000, true, 'https://x/head.glb', false]);
});

test('a page that skips frames on its own: the pass says it draws 2 of every 3 frames, one stretch, and its clock counts draws', () => {
  const F = 1000 / 60, rows = [];
  for (let i = 0; i < 60; i++) rows.push({ k: i, T: 1000 + i * F, gld: { p1: [1, 0, 0], ...(i % 3 !== 2 ? { p10: [1, 1, 2] } : {}) } });
  const passes = passesOf(drawsOf(rows), { textures: [], targets: [{ id: 2, w: 1440, h: 900 }] }, 1000);
  const p10 = passes.find((p) => p.program === 'p10');
  assert.equal(p10.drawn.length, 1); assert.ok(Math.abs(p10.cadence - 2 / 3) < 0.02, String(p10.cadence)); assert.match(p10.skips, /^draws 2 of every 3 frames/);
  assert.equal(passes.find((p) => p.program === 'p1').cadence, undefined);
  assert.equal(cadenceWords(0.5).slice(0, 23), 'draws 1 of every 2 fram');
});

test('a worker\'s WebGL rows join the page\'s on their frames: values held, draws on their own frame (workergl.js)', () => {
  const rows = [0, 1, 2, 3].map((k) => ({ k, T: k * 1000 / 60, gl: { 'p1|a': 1 }, gld: { p1: [1, 0, 0] } }));
  const w = [{ w: 0, k: 1, T: 1000 / 60, gl: { 'p1001|uP': 0.1, 'p1001|uC': [1, 0, 0] }, gld: { p1001: [1, 0, 0] } }, { w: 0, k: 3, T: 50, gl: { 'p1001|uP': 0.3 }, gld: { p1001: [1, 0, 0] } }];
  const out = withWorkerRows(rows, w);
  assert.deepEqual(out.map((r) => r.gl['p1001|uP'] ?? null), [null, 0.1, 0.1, 0.3]);
  assert.deepEqual(out.map((r) => !!r.gld.p1001), [false, true, false, true], 'frame 2: the worker did not draw');
  assert.deepEqual(out[2].gl['p1001|uC'], [1, 0, 0]); assert.equal(out[0], rows[0], 'a row before the worker is as it was');
});

test('a time uniform that steps per draw is a clock, not a motion (uTime +1/60 a draw, drawn 2 of 3 frames)', () => {
  const F = 1000 / 60, rows = []; let t = 0;
  for (let i = 0; i < 60; i++) { const drew = i % 3 !== 2; if (drew) t += 1 / 60; rows.push({ k: i, T: 1000 + i * F, gl: { 'p10|uTime': +t.toFixed(7) }, gld: drew ? { p10: [1, 0, 2] } : {} }); }
  const ch = glChannelsIn(rows, { T0: 1000 + 20 * F, T1: 1000 + 59 * F });
  const c = ch.find((x) => x.ch === 'gl:uTime'); assert.equal(c.status, 'clock'); assert.equal(c.clock.per, 'draw');
});
