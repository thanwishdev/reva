// What a scan take reads in the page, without a browser: the real recorder runtime and init hook, serialised as the session does it, run in
// a vm over a stub DOM. It proves the code is self-contained and what each reader does. A real page is the sealed run's job.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { inpageSource } from '../src/record/inpage.js';
import { DECLARED_INIT, restSource } from '../src/record/declared.js';
import { rowDecoder } from '../src/record/rowcodec.js';

const stubClasses = `
  class DocumentTimeline {} class ScrollTimeline {} class Animation {} class CSSStyleDeclaration { setProperty() {} }
  class HTMLElement {} class SVGElement extends HTMLElement {} class HTMLCanvasElement {} class HTMLMediaElement { play() {} } class HTMLVideoElement extends HTMLMediaElement {}
  class Event { get timeStamp() { return 1; } } class DOMMatrixReadOnly { constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.m41 = 0; this.m42 = 0; this.m43 = 0; } }
  class WebGLRenderingContext {} for (const m of ['createShader','shaderSource','createProgram','attachShader','detachShader','linkProgram','deleteProgram','useProgram','getUniformLocation','uniform1f','uniform2f','uniform3f','uniform4f','uniform1fv','uniform2fv','uniform3fv','uniform4fv','uniformMatrix3fv','uniformMatrix4fv','uniform1i','uniform2i','uniform1iv','bindFramebuffer','drawArraysInstanced','drawElementsInstanced','vertexAttribDivisor','getExtension','getProgramParameter','getActiveUniform','drawArrays','drawElements','drawRangeElements','createTexture','activeTexture','bindTexture','texImage2D','texImage3D','texStorage2D','texSubImage2D','framebufferTexture2D','enable','disable','blendEquation','blendEquationSeparate','blendFunc','blendFuncSeparate','depthMask','depthFunc','cullFace','colorMask','clear','createBuffer','bindBuffer','bufferData','bufferSubData','vertexAttribPointer','enableVertexAttribArray','disableVertexAttribArray','bindVertexArray','getActiveAttrib','getAttribLocation']) WebGLRenderingContext.prototype[m] = function (p, n) { return m === 'createProgram' || m === 'createTexture' || m === 'createBuffer' ? {} : m === 'getUniformLocation' ? { n } : null; };
  Object.assign(globalThis, { DocumentTimeline, ScrollTimeline, Animation, CSSStyleDeclaration, HTMLElement, SVGElement, HTMLCanvasElement, HTMLMediaElement, HTMLVideoElement, Event, DOMMatrixReadOnly, WebGLRenderingContext });
`;
function world(cfg = { scan: true }) {
  const observers = [], anims = [], stub = { getAnimations: () => anims, timeline: {}, querySelectorAll: () => [], documentElement: {} };
  const sb = { console, performance: { now: () => 0, bind() { return () => 0; } }, Date, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, addEventListener() {}, MessageChannel: class { port1 = {}; port2 = { postMessage() {} }; }, innerWidth: 1000, innerHeight: 800, scrollX: 0, scrollY: 0, document: stub,
    getComputedStyle: () => ({ transform: 'none', translate: 'none', scale: 'none', rotate: 'none', opacity: '1', fontWeight: '400', fontStretch: '100%', fontVariationSettings: 'normal', borderTopLeftRadius: '0px', clipPath: 'none', filter: 'none', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', fill: 'black', stroke: 'none', strokeDashoffset: '0', width: '10px', height: '10px', getPropertyValue: () => '' }),
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe(t, o) { this.o = o; } }, location: { origin: 'http://x', href: 'http://x/' }, btoa };
  sb.performance.now = () => 0; sb.window = sb; sb.top = sb; sb.self = sb;
  vm.createContext(sb); vm.runInContext(stubClasses, sb);
  vm.runInContext(inpageSource({ lane: 'hx', dt: 1000 / 60, t0: 0, dateEpoch: 0, births: true, maxElements: 1e9, discover: true, glTap: true, ...cfg }), sb);
  if (cfg.scan) vm.runInContext(DECLARED_INIT, sb);
  const fire = (rec) => { for (const o of observers) { const o2 = o.o || {}; if (rec.type === 'attributes' ? o2.attributes && !o2.attributeFilter : o2[rec.type]) o.cb([rec]); } };
  const svg = (tag = 'path', attrs = {}, root = null) => { const e = vm.runInContext('new SVGElement()', sb); Object.assign(e, { nodeType: 1, tagName: tag, localName: tag, isConnected: true, ownerSVGElement: root, classList: [], attrs, style: null, childElementCount: 0, firstChild: null, nextSibling: null, textContent: '', getAttribute: (n) => attrs[n] ?? null, getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10, right: 10, bottom: 10, left: 0, top: 0 }), getAnimations: () => [] }); return e; };
  return { sb, W: sb.__WR, fire, svg, anims, stub, gl: () => vm.runInContext('new WebGLRenderingContext()', sb) };
}
const glSetup = (w, name) => { const g = w.gl(), p = g.createProgram(); return { g, p, loc: g.getUniformLocation(p, name) }; };

test('the runtime and the hook serialise and run on their own', () => {
  const { W, sb } = world();
  assert.ok(W.gsapHook, 'the hook found the runtime');
  assert.equal(typeof W.attrChannels, 'function');
  assert.ok(vm.runInContext("Object.getOwnPropertyDescriptor(Object.prototype, 'gsap')", sb), 'the setter waits for GSAP');
  assert.equal(vm.runInContext('({}).gsap', sb), undefined);
  assert.equal(vm.runInContext("Object.keys({}).length + JSON.stringify({ a: 1 }).length", sb), 7);
});

test('a look take has none of it', () => {
  const { W, sb } = world({ scan: false });
  assert.equal(W.attrsOf, undefined); assert.equal(W.charsOf, undefined); assert.equal(W.gsapHook, undefined);
  assert.equal(vm.runInContext("Object.getOwnPropertyDescriptor(Object.prototype, 'gsap')", sb), undefined);
  assert.doesNotMatch(inpageSource({ lane: 'hx' }), /scanTracker\(\) \{/, 'no tracker in the look source');
});

test('the setter steps aside: a plain data property, on any object, once', () => {
  const { W, sb } = world();
  assert.equal(vm.runInContext('const o = {}; o.gsap = 5; o.gsap + (Object.keys(o).length * 10)', sb), 15, 'an ordinary assignment stays ordinary');
  assert.equal(W.gsapHook.core, null);
  vm.runInContext("'use strict'; const f = Object.freeze({}); f.gsap = 1; globalThis.frozenLeft = f.gsap;", sb);
  assert.equal(sb.frozenLeft, undefined, 'a frozen object stays as it was');
  vm.runInContext(`
    const mk = (name) => { const tw = { name, _d: 1, parent: null, vars: {}, targets() { return this.t; }, duration() { return this._d; }, delay() { return 0; }, repeat() { return 0; }, yoyo() { return false; }, paused() { return false; }, totalProgress() { return this.p || 0; } }; return tw; };
    const root = { paused() { return false; }, parent: null };
    const make = (t, v) => { const w = mk('t'); w.t = Array.isArray(t) ? t : [t]; w.parent = root; w._d = v.duration ?? 0.5; w.vars = v; made.push(w); return w; };
    globalThis.made = [];
    class Tl { constructor() { this.parent = root; this.vars = {}; } to(t, v) { this._r = make(t, v); this._r.parent = this; return this; } recent() { return this._r; } paused() { return false; } }
    globalThis.fake = { version: '3.12.5', globalTimeline: root, parseEase: (n) => (n === 'power1.out' ? globalThis.pw : null), defaults: () => ({ ease: 'power1.out' }), core: { Timeline: Tl, Tween: {} },
      to: make, from: (t, v) => make(t, v), fromTo: (t, f, v) => make(t, v), set: (t, v) => make(t, { ...v, duration: 0 }), timeline: () => new Tl(), delayedCall: (s) => make([], { duration: s }) };
    globalThis.bag = {}; bag.gsap = fake;
    globalThis.el = { nodeType: 1 };
    fake.to(el, { x: 40, duration: 0.6, ease: 'power3.out', delay: 0.1, scrollTrigger: { start: 'top 80%', scrub: 1 } });
    fake.fromTo(el, { y: 0 }, { y: 9, duration: 1 });
    fake.set(el, { x: 1 });
    fake.timeline().to(el, { opacity: 0, duration: 0.2 });
    fake.to(42, { v: 1, duration: 1 });
  `, sb);
  assert.equal(W.gsapHook.core, sb.fake, 'caught at birth');
  assert.equal(sb.bag.gsap, sb.fake, 'the page got its value');
  assert.equal(vm.runInContext("Object.getOwnPropertyDescriptor(Object.prototype, 'gsap')", sb), undefined, 'and the setter is gone');
  const log = [...W.gsapHook.log];
  assert.equal(log.length, 3, 'a set, and a tween on no element, leave no row');
  assert.deepEqual(JSON.parse(JSON.stringify(log[0])).ids, [W.idOf(sb.el)]);
  assert.equal(log[0].ease, 'power3.out'); assert.equal(log[0].dur, 0.6);
  assert.equal(log[0].st.start, 'top 80%'); assert.equal(log[0].st.scrub, 1);
  assert.equal(log[1].m, 'fromTo'); assert.equal(log[1].ease, 'power1.out', 'an ease left out is the default');
  assert.equal(log[1].from.y, 0); assert.equal(log[2].inTl, true);
  W.drain(['declared']);
  assert.equal(W.gsapHook.log.length, 0, 'the log leaves with the drain');
});

test('W.quiet waits for a GSAP tween in its delay, not for a loop or what moves by itself', () => {
  const { W, sb } = world();
  W.partStart(); W.V.k += 30;
  assert.equal(W.quiet(18), true);
  const H = W.gsapHook, tw = (o = {}) => ({ parent: { paused: () => false, parent: null }, repeat: () => 0, totalProgress: () => 0, paused: () => false, targets: () => [], ...o });
  H.born.push(tw({ repeat: () => -1 }), tw({ totalProgress: () => 1 }), tw({ parent: null }), tw({ paused: () => true }), tw({ scrollTrigger: {} }));
  H.pending = vm.runInContext('(f) => f', sb)(H.pending);
  assert.equal(W.quiet(18), true, 'a loop, a finished, a killed, a paused and a scroll-held tween hold nothing');
  H.born.push(tw());
  assert.equal(W.quiet(18), false, 'a tween yet to end does');
  W.partStart();
  assert.equal(H.born.length, 0, 'a new part starts from nothing');
});

test('GL: arrays by element, mat3 by column, an int only once it changes', () => {
  const w = world(); const G = w.W.glT;
  const a = glSetup(w, 'uColors[0]'); a.g.uniform3fv(a.loc, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([...G.vals['p1|uColors[2]']], [7, 8, 9]);
  assert.equal(G.dropped.arrays.length, 0);
  const m = glSetup(w, 'uv'); m.g.uniformMatrix3fv(m.loc, false, [1, 0, 0, 0, 1, 0, 3, 4, 1]);
  assert.deepEqual([...G.vals['p2|uv[2]']], [3, 4, 1]);
  const i = glSetup(w, 'uMode'); i.g.uniform1i(i.loc, 2); i.g.uniform1i(i.loc, 2);
  assert.equal('p3|uMode' in G.vals, false, 'a sampler slot takes no key');
  i.g.uniform1i(i.loc, 3);
  assert.equal(G.vals['p3|uMode'], 3);
  const big = glSetup(w, 'big'); big.g.uniform1fv(big.loc, new Array(65).fill(1));
  assert.equal(G.dropped.arrays.length, 0, 'past 64 it is kept by element (gla), not dropped');
  assert.equal(G.arrs['p4|big[64]'][0], 1);
});

test('GL scan: a mat4 array (bones) by element, the same bones in a second program named by the first, changed elements only on the wire', () => {
  const w = world(); const { W } = w, G = W.glT, g = w.gl();
  const p1 = g.createProgram(), p2 = g.createProgram(), b1 = g.getUniformLocation(p1, 'uBones[0]'), b2 = g.getUniformLocation(p2, 'uBones[0]');
  const bones = (t) => Array.from({ length: 41 * 16 }, (_, i) => (i % 16 === 12 && i < 32 ? t : i % 5 === 0 ? 1 : 0));
  W.rtK = 1; g.uniformMatrix4fv(b1, false, new Float32Array(bones(0))); g.uniformMatrix4fv(b2, false, new Float32Array(bones(0))); W.sample(1000 / 60);
  const dec = rowDecoder(), r1 = dec(JSON.parse(JSON.stringify(W.rows.at(-1))));
  assert.equal(Object.keys(r1.gla).filter((k) => k.startsWith('p1|uBones[')).length, 41);
  assert.equal(r1.gla['p2|uBones'], '=p1|uBones', 'the same values: one copy');
  // frame 2: bone 0 and 1 move along x; only they go on the wire
  W.rtK = 2; g.uniformMatrix4fv(b1, false, new Float32Array(bones(0.5))); g.uniformMatrix4fv(b2, false, new Float32Array(bones(0.5))); W.sample(2000 / 60);
  const wire = W.rows.at(-1).x.gla, r2 = dec(JSON.parse(JSON.stringify(W.rows.at(-1))));
  assert.equal(wire[0].length, 4, 'a patch of two elements (index, value) x 2');
  assert.deepEqual([r2.gla['p1|uBones[0]'][12], r2.gla['p1|uBones[1]'][12], r2.gla['p1|uBones[2]'][12]], [0.5, 0.5, 0]);
});

test('GL scan: a value set per draw keeps one slot per set; a geometry per draw; small buffers kept by hash; ints set once are told', () => {
  const w = world(); const { W, sb } = w, G = W.glT, g = w.gl(), proto = vm.runInContext('WebGLRenderingContext.prototype', sb);
  proto.getProgramParameter = (p, q) => (q === 35721 ? 1 : 0); proto.getActiveAttrib = () => ({ name: 'position', type: 35665, size: 1 }); proto.getAttribLocation = () => 0;
  const p = g.createProgram(), op = g.getUniformLocation(p, 'opacity'), mode = g.getUniformLocation(p, 'uMode');
  const buf = g.createBuffer(); g.bindBuffer(34962, buf); g.bufferData(34962, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 35044);
  g.vertexAttribPointer(0, 3, 5126, false, 12, 0); g.enableVertexAttribArray(0); g.uniform1i(mode, 2);
  W.rtK = 1; g.useProgram(p);
  for (const o of [1, 0.5, 0.25]) { g.uniform1f(op, o); g.drawArrays(4, 0, 3); }
  W.sample(1000 / 60);
  const r = rowDecoder()(JSON.parse(JSON.stringify(W.rows.at(-1))));
  assert.deepEqual([r.gls['p1|opacity#0'], r.gls['p1|opacity#1'], r.gls['p1|opacity#2']], [1, 0.5, 0.25]);
  assert.deepEqual(r.glg.p1, [1, 1, 1], 'one geometry, drawn three times: one id per draw, in draw order');
  const info = JSON.parse(JSON.stringify(W.glInfo()));
  assert.deepEqual(info.geometries[0], { id: 1, program: 'p1', mode: 4, count: 3, instances: 0, attribs: [{ name: 'position', glslType: 'vec3', location: 0, size: 3, type: 5126, normalized: false, stride: 12, offset: 0, buffer: 1, bufferBytes: 36, hash: info.buffers[0].hash }] });
  assert.deepEqual([info.buffers[0].size, info.buffers[0].kept, info.buffers[0].usage], [36, true, 35044]);
  assert.equal(Buffer.from(JSON.parse(W.glBuffers())[info.buffers[0].hash], 'base64').length, 36);
  assert.deepEqual(info.programs[0].ints, { uMode: 2 });
});

test('GL passes: draws per program and frame into which target, object matrices of every program, texture descriptions (no pixels)', () => {
  const w = world(); const { W, sb } = w, G = W.glT, g = w.gl(), proto = vm.runInContext('WebGLRenderingContext.prototype', sb);
  const p1 = g.createProgram(), p2 = g.createProgram();
  proto.getProgramParameter = (p) => (p === p2 ? 2 : 0);   // p2 has two samplers
  proto.getActiveUniform = (p, i) => ({ name: i ? 'tImg' : 'tMap', type: 35678, size: 1 });
  const img = vm.runInContext('new (class HTMLImageElement { constructor() { this.naturalWidth = 64; this.naturalHeight = 32; } })()', sb);
  // p1 draws twice into a 512 x 256 target; p2 reads that target (unit 0) and an image (unit 1) onto the canvas
  W.rtK = 1;
  g.useProgram(p1);
  const rt = g.createTexture(); g.bindTexture(3553, rt); g.texImage2D(3553, 0, 6408, 512, 256, 0, 6408, 5121, null);
  const fb = {}; g.bindFramebuffer(36160, fb); g.framebufferTexture2D(36160, 36064, 3553, rt, 0);
  g.drawArrays(4, 0, 6); g.drawArrays(4, 0, 6);
  const tex = g.createTexture(); g.activeTexture(33985); g.bindTexture(3553, tex); g.texImage2D(3553, 0, 6408, 6408, 5121, img);
  g.bindFramebuffer(36160, null); g.useProgram(p2);
  g.uniform1i(g.getUniformLocation(p2, 'tMap'), 0); g.uniform1i(g.getUniformLocation(p2, 'tImg'), 1);
  g.drawArrays(4, 0, 6);
  // matrices: a model matrix of any program is an object matrix; a camera-like key stays in glm as before
  g.uniformMatrix4fv(g.getUniformLocation(p1, 'modelMatrix'), false, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1 + 0.2, 2, 3, 1]);
  g.uniformMatrix4fv(g.getUniformLocation(p1, 'projectionMatrix'), false, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]);
  W.sample(1000 / 60);
  const dec = rowDecoder(), row = dec(JSON.parse(JSON.stringify(W.rows.at(-1))));
  assert.deepEqual(row.gld, { p1: [2, 0, 1], p2: [1, 1, 0] }, 'p1 drew twice into target 1 first, p2 once onto the canvas');
  assert.equal(Object.keys(G.draws).length, 0, 'counts are per frame');
  assert.deepEqual(row.glo['p1|modelMatrix'].slice(12), [0.3, 2, 3, 1], '7 significant digits');
  assert.ok('p1|projectionMatrix' in G.mats && !('p1|projectionMatrix' in G.objs));
  // a program that draws two objects sets its matrix twice a frame: object 0 and object 1, by draw order
  W.rtK = 3; g.uniformMatrix4fv(g.getUniformLocation(p2, 'modelMatrix'), false, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]); g.uniformMatrix4fv(g.getUniformLocation(p2, 'modelMatrix'), false, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 0, 0, 1]);
  assert.deepEqual([G.objs['p2|modelMatrix'][12], G.objs['p2|modelMatrix#1'][12]], [5, 7]);
  W.rtK = 4; W.sample(2000 / 60);
  assert.deepEqual(dec(JSON.parse(JSON.stringify(W.rows.at(-1)))).gld, {}, 'a frame with no draw: no program drew');
  const info = JSON.parse(JSON.stringify(W.glInfo()));   // as the session reads it: out of the page as JSON
  assert.deepEqual(info.targets, [{ id: 1, ctx: 0, tex: [1], w: 512, h: 256 }]);
  const [t1, t2] = info.textures;
  assert.deepEqual([t1.w, t1.h, t1.source, t1.fb, t1.sampled], [512, 256, 'empty', 1, ['p2|tMap']]);
  assert.deepEqual([t2.w, t2.h, t2.source, t2.fb, t2.sampled, t2.uploads], [64, 32, 'image', null, ['p2|tImg'], 1]);
  assert.ok(!JSON.stringify(info.textures).includes('naturalWidth'), 'a description, never the source object');
});

test('GL composite state: per frame, per program, the blend / depth / cull state it drew with, held until a call changes it', () => {
  const w = world(); const { W } = w, g = w.gl();
  const scene = g.createProgram(), ink = g.createProgram(), glow = g.createProgram();
  const dec = rowDecoder(), last = () => dec(JSON.parse(JSON.stringify(W.rows.at(-1))));
  // frame 1: the scene opaque with depth, the ink alpha over it (three.js NormalBlending), a glow additive with no depth write
  W.rtK = 1;
  g.enable(2929); g.enable(2884); g.useProgram(scene); g.drawElements(4, 6, 5123, 0); g.drawElements(4, 6, 5123, 0);
  g.disable(2929); g.enable(3042); g.blendEquation(32774); g.blendFuncSeparate(770, 771, 1, 771); g.useProgram(ink); g.drawArrays(4, 0, 6);
  g.enable(2929); g.depthMask(false); g.blendFunc(770, 1); g.useProgram(glow); g.drawArrays(4, 0, 6);
  W.sample(1000 / 60);
  const r1 = last();
  assert.deepEqual(r1.glb, { p1: 1, p2: 2, p3: 3 }, 'one state id per program');
  // frame 2: nothing changes: same ids, and the wire sends one 0 for them
  W.rtK = 2; g.useProgram(scene); g.disable(3042); g.depthMask(true); g.drawElements(4, 6, 5123, 0); g.enable(3042); g.blendFuncSeparate(770, 771, 1, 771); g.disable(2929); g.useProgram(ink); g.drawArrays(4, 0, 6); g.enable(2929); g.depthMask(false); g.blendFunc(770, 1); g.useProgram(glow); g.drawArrays(4, 0, 6);
  W.sample(2000 / 60);
  assert.equal(W.rows.at(-1).x.glb, 0, 'held: the same states cost one 0');
  // frame 3: the ink draws twice, once alpha over, once with blending off: both ids, in order
  W.rtK = 3; g.clear(16640); g.useProgram(ink); g.disable(2929); g.depthMask(true); g.blendFuncSeparate(770, 771, 1, 771); g.drawArrays(4, 0, 6); g.disable(3042); g.drawArrays(4, 0, 6);
  W.sample(3000 / 60);
  const r3 = last(); assert.deepEqual(r3.glb, { p2: [2, 4] }); assert.deepEqual(r3.glu, {}, 'first after the clear: over nothing');
  // drawn over: frame 1, the ink and the glow over the scene, the glow over the ink; frame 3, the ink alone after a clear
  assert.deepEqual(r1.glu, { p2: [1], p3: [1, 2] });
  const st = JSON.parse(JSON.stringify(W.glInfo())).states;
  assert.deepEqual(st[0], { id: 1, blend: null, depth: { test: true, write: true, func: 513 }, cull: 1029, scissor: false, colorMask: [1, 1, 1, 1] });
  assert.deepEqual(st[1].blend, { eq: [32774, 32774], src: [770, 1], dst: [771, 771] }); assert.equal(st[1].depth.test, false);
  assert.deepEqual([st[2].blend.src, st[2].blend.dst, st[2].depth], [[770, 770], [1, 1], { test: true, write: false, func: 513 }]);
  assert.equal(st.length, 4, 'a state seen again is not stored again');
  assert.deepEqual([st[3].blend, st[3].depth.test], [null, false], 'blending off: its factors do not make a new state');
});

test('GL on a look take stays as it was', () => {
  const w = world({ scan: false }); const G = w.W.glT;
  const a = glSetup(w, 'u'); a.g.uniform3fv(a.loc, [1, 2, 3, 4, 5, 6]);
  assert.equal(Object.keys(G.vals).length, 0); assert.deepEqual([...G.dropped.arrays], ['p1|u']);
});

test('SVG: a mutated attribute joins the moving set, a morph reads as distance from its first shape', () => {
  const w = world(), { W, fire, svg } = w, root = svg('svg');
  const p = svg('path', { d: 'M0 0 L10 10' }, root);
  fire({ type: 'attributes', target: p, attributeName: 'd' });
  const id = W.idOf(p);
  assert.ok(W.watch.has(id));
  assert.equal(W.channelsOf(p, id)['ren:--svg-d'], 0);
  p.attrs.d = 'M0 0 L20 30';
  assert.equal(W.channelsOf(p, id)['ren:--svg-d'], 7.5, '(10 + 20) / 4');
  const c = svg('circle', { r: '4', cx: 'auto' }, root);
  fire({ type: 'attributes', target: c, attributeName: 'r' }); fire({ type: 'attributes', target: c, attributeName: 'cx' }); fire({ type: 'attributes', target: c, attributeName: 'transform' });
  const o = W.channelsOf(c, W.idOf(c));
  assert.equal(o['ren:--svg-r'], 4); assert.equal(o['ren:--svg-cx'], 'auto'); assert.equal('ren:--svg-transform' in o, false, 'the computed transform has it');
  for (let i = 0; i < 30; i++) fire({ type: 'attributes', target: svg('path', {}, root), attributeName: 'd' });
  assert.equal(W.c.svgOver, 16, '16 elements per svg, the rest counted');
});

test('text: one write is content, the second is motion', () => {
  const w = world(), { W, fire, svg } = w, e = svg('span'); e.textContent = 'ab\u0007c'; e.childElementCount = 0;
  const node = { nodeType: 3, parentElement: e };
  fire({ type: 'characterData', target: node, addedNodes: [] });
  assert.equal(W.watch.has(W.idOf(e)), false);
  fire({ type: 'childList', target: e, addedNodes: [{ nodeType: 3 }] });
  assert.ok(W.watch.has(W.idOf(e)));
  assert.equal(W.channelsOf(e, W.idOf(e))['ren:chars'], 'abc', 'no control characters');
  const f = svg('div'); fire({ type: 'childList', target: f, addedNodes: [{ nodeType: 1 }] }); fire({ type: 'childList', target: f, addedNodes: [{ nodeType: 1 }] });
  assert.equal(W.charsOf.has(W.idOf(f)), false, 'elements added are no text');
});

test('a pseudo-element gets its own id, a scroll timeline its birth, once', () => {
  const w = world(), { W, sb, svg, anims } = w, host = svg('div');
  const scroll = vm.runInContext('new ScrollTimeline()', sb), doc = vm.runInContext('new DocumentTimeline()', sb);
  const effect = (o = {}) => ({ target: host, getTiming: () => ({ delay: 0, duration: 100, easing: 'linear' }), getKeyframes: () => [], ...o });
  anims.push({ effect: effect({ pseudoElement: '::after' }), timeline: doc, constructor: { name: 'CSSAnimation' } }, { effect: effect(), timeline: scroll, constructor: { name: 'CSSAnimation' } });
  W.discover(); W.discover();
  assert.equal(W.births.length, 1); assert.equal(W.births[0].timeline, 'ScrollTimeline');
  const ids = [...W.watch.keys()], ps = ids.find((i) => W.pseudoOf.get(i) === '::after');
  assert.ok(ps != null && ps !== W.idOf(host)); assert.ok(W.watch.has(W.idOf(host)), 'the host stays');
  const o = W.channelsOf(host, ps);
  assert.equal(o['ren:bw'], 10); assert.equal(o['ren:bx'], 0, 'framed by its host');
});

test('the read at rest is one expression that reads the caught object', () => {
  const src = restSource();
  assert.doesNotThrow(() => new vm.Script(src));
  assert.match(src, /H\.core/); assert.match(src, /gsap-rest/);
});
