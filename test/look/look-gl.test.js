// WebGL light end to end on known-truth raw-WebGL fixtures (fixtures/look/gl-*.html; localhost only, no library, no
// internet). Planted values on uniforms and camera matrices are read back through look within stated tolerances.
// REVA_GL_REPORT=<file> also writes the planted vs measured values as JSON (for the run report).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { serveFixture } from '../helpers.js';
import { runLook } from '../../src/look/index.js';
import { formatLook } from '../../src/look/cli.js';
import { buildCardHtml } from '../../src/card/build.js';
import { webglRow } from '../../src/mcp/reva.js';
import { motionsOf } from '../../src/mcp/analysis.js';

let srv; const report = [];
test.before(async () => { srv = await serveFixture('look'); });
test.after(async () => { await srv.close(); if (process.env.REVA_GL_REPORT) fs.writeFileSync(process.env.REVA_GL_REPORT, JSON.stringify(report, null, 1)); });
const look = (page, o) => runLook({ input: `${srv.origin}/${page}`, write: false, design: false, libs: false, ...o });
const P = (rec, k) => rec.model.params[k] && rec.model.params[k].value;
const within = (got, want, tol, what) => { report.push({ what, want, got, tol }); assert.ok(Math.abs(got - want) <= tol, `${what}: measured ${got}, planted ${want}, tolerance ${tol}`); };
const recOf = (r, ch) => r.gl.records.find((x) => x.target.channel === ch && x.tier === 'fitted');

test('(a) uniform tween on load: cubic-bezier(0.4, 0, 0.2, 1), 1400 ms, from 300 ms; shader source and hash in look.json, never in the text', async () => {
  const r = await look('gl-tween.html', { action: 'load' });
  assert.equal(r.ok, true, r.warnings.join('; '));
  const rec = recOf(r, 'gl:uProgress'); assert.ok(rec, 'uProgress fitted');
  assert.match(rec.model.family, /^bezier/);
  within(P(rec, 'D'), 1400, 1400 * 0.03, 'tween D (ms)');
  within(P(rec, 'x1'), 0.4, 0.05, 'tween x1'); within(P(rec, 'y1'), 0, 0.05, 'tween y1'); within(P(rec, 'x2'), 0.2, 0.05, 'tween x2'); within(P(rec, 'y2'), 1, 0.05, 'tween y2');
  within(rec.derived.t0, 300, 17, 'tween onset (ms after first frame)');
  const txt = formatLook(r);
  assert.match(txt, /WebGL uniform uProgress: 0 → 1 \[measured\], Tween, cubic-bezier\(0\.4, 0, 0\.2, 1\) \[fitted\], 1400 ms \[fitted\]/, txt);
  assert.match(txt, /\(1 uniform did not change during the take: not motion, left out\)/, 'uTint is constant');
  assert.ok(!/gl_FragColor/.test(txt), 'shader source never printed to the terminal');
  const p = r.gl.programs[0];
  assert.match(p.fragment.source, /uniform float uProgress/); assert.match(p.vertex.source, /gl_Position/); assert.match(p.hash, /^[0-9a-f]{12}$/);
  assert.deepEqual(p.uniforms.map((u) => `${u.type} ${u.name}`).sort(), ['float uProgress', 'vec3 uTint']);
  assert.equal(r.gl.contexts.length, 1); assert.equal(r.gl.contexts[0].webgl2, false);
  // card: the uniform is a motion item with the same plot model; the shader panel holds the escaped source, collapsed
  const html = buildCardHtml({ ...r, dir: null });
  assert.ok(html.includes('uniform float uProgress'), 'source in the card data');
  assert.ok(html.includes('"isGl":true'), 'gl motion item'); assert.ok(html.includes('function glHTML'));
  // MCP: a small webgl block, every page-named line untrusted; the gl motion entry carries the fitted record
  const row = webglRow(r.gl); const j = JSON.stringify(row);
  assert.ok(j.length < 4000, `webgl block ${j.length} bytes`); assert.ok(!/gl_FragColor/.test(j), 'no sources over MCP look');
  assert.equal(row.lines[0].text.untrusted_content, true);
  const ms = motionsOf(r); assert.ok(ms.some((m) => m.mid === 'gl' && m.entry.records.length === 1));
});

test('(b) uniform spring on click: omega 12 rad/s, zeta 0.4; one line (the settling tail is not a motion of its own)', async () => {
  const r = await look('gl-spring.html', { action: 'click', on: '#gl' });
  const recs = r.gl.records.filter((x) => x.target.channel === 'gl:uPress' && x.tier === 'fitted');
  const rec = recs[0]; assert.ok(rec, 'uPress fitted'); assert.equal(rec.model.family, 'spring');
  within(P(rec, 'omega'), 12, 12 * 0.03, 'spring omega (rad/s)'); within(P(rec, 'zeta'), 0.4, 0.02, 'spring zeta');
  const lines = r.gl.lines.filter((l) => l.subject === 'uniform uPress');
  assert.equal(lines.length, 1, lines.map((l) => l.text).join('\n'));
  assert.match(lines[0].text, /^WebGL uniform uPress: 0 → 1 \[measured\], Spring, clearly bouncy .*ω 12 rad\/s \[fitted\], ζ 0\.4 \[fitted\]/);
});

test('(c) scroll-linked uniform: linear over the scroll range 300 → 1500 px', async () => {
  const r = await look('gl-scroll.html', { action: 'scroll' });
  const rec = recOf(r, 'gl:uScroll'); assert.ok(rec, 'uScroll fitted');
  assert.match(rec.model.family, /scroll map/); assert.equal(rec.model.map.shape, 'linear');
  within(rec.model.map.s0_px, 300, 15, 'scroll map start (px)'); within(rec.model.map.s1_px, 1500, 15, 'scroll map end (px)');
  within(rec.model.map.a, 0, 0.01, 'scroll map from'); within(rec.model.map.a + rec.model.map.b, 1, 0.01, 'scroll map to');
  assert.match(formatLook(r), /WebGL uniform uScroll: Scroll-linked \(scrubbed\): 0 \[fitted\] → 1 \[fitted\] while the page scrolls 300 px \[fitted\] → 1500 px \[fitted\], linear/);
});

test('(d) uTime is a clock (1.0 per second), the constant uColor is dropped, the shader reads as fbm noise with 1 texture [derived]', async () => {
  const r = await look('gl-clock.html', { action: 'load' });
  assert.equal(r.gl.clocks.length, 1); assert.equal(r.gl.clocks[0].name, 'uTime');
  within(r.gl.clocks[0].perSecond, 1, 0.001, 'clock rate (per second)');
  assert.equal(r.gl.records.length, 0, 'a clock is not fitted as a tween');
  assert.equal(r.gl.constants.uniforms, 1);
  const txt = formatLook(r);
  assert.match(txt, /WebGL uniform uTime: a clock, 1 per second \[fitted\]/);
  assert.match(txt, /WebGL shader p1 \(vertex 1 lines, fragment 8 lines\): fbm noise, 1 texture, full-screen pass, time uniform \[derived\]/);
  assert.equal(r.status, 'motion');
  // the canvas element fades in (a DOM motion): its content line says the WebGL was read, not "not visible"
  assert.match(txt, /CANVAS#gl/); assert.match(txt, /drawn with WebGL: read from the page's WebGL calls \(shaders, uniforms, camera: see the WebGL lines\)/);
  assert.ok(!/not visible to DOM channels/.test(txt), txt);
});

test('(e) camera: fov 45°, aspect 4:3 [measured]; position (0, 0, 8) → (0, 2, 4), 1200 ms, ease [fitted], as one line', async () => {
  const r = await look('gl-camera.html', { action: 'load' });
  const c = r.gl.camera; assert.ok(c && c.projection && c.view);
  within(c.projection.fovDeg, 45, 0.01, 'camera fov (deg)'); within(c.projection.aspect, 4 / 3, 1e-4, 'camera aspect');
  within(c.projection.near, 0.1, 1e-3, 'camera near'); within(c.projection.far, 100, 2, 'camera far');
  within(c.view.z, 8, 1e-4, 'camera start z'); within(c.view.y, 0, 1e-4, 'camera start y');
  for (const ch of ['gl:camera.y', 'gl:camera.z']) {
    const rec = recOf(r, ch); assert.ok(rec, `${ch} fitted`);
    within(P(rec, 'D'), 1200, 1200 * 0.03, `${ch} tween D (ms)`); within(rec.derived.t0, 200, 17, `${ch} onset (ms)`);
    if (/^bezier/.test(rec.model.family)) { within(P(rec, 'x1'), 0.25, 0.05, `${ch} x1`); within(P(rec, 'y1'), 0.1, 0.05, `${ch} y1`); within(P(rec, 'x2'), 0.25, 0.05, `${ch} x2`); within(P(rec, 'y2'), 1, 0.05, `${ch} y2`); }
    else assert.equal(rec.model.family, 'named:ease');
  }
  const txt = formatLook(r);
  assert.match(txt, /WebGL camera: perspective, fov 45° \[measured\], aspect 1\.333 \[measured\], near 0\.1 \/ far 100 \[measured\]/);
  assert.match(txt, /WebGL camera position: y 0 → 2, z 8 → 4 \[measured\], Tween, (ease|cubic-bezier\(0\.25, 0\.1, 0\.25, 1\)) \[fitted\], 1200 ms \[fitted\]/, txt);
  assert.ok(!/camera\.x|camera rotation:/.test(txt), 'x and the rotation do not move: no line');
});

// (f) real three.js output through the generic path (no three.js hook). Needs the CDN (jsDelivr): skipped offline.
const cdnUp = async () => { try { const r = await fetch('https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js', { method: 'HEAD', signal: AbortSignal.timeout(5000) }); return r.ok; } catch { return false; } };
test('(f) three.js 0.186.1: PerspectiveCamera fov 50 and a z tween, a ShaderMaterial uniform tween, read engine-agnostically', async (t) => {
  if (process.env.REVA_OFFLINE || !(await cdnUp())) { t.skip('three.js CDN not reachable (offline)'); return; }
  const r = await look('gl-three.html', { action: 'load', allowCdn: true });
  const c = r.gl.camera;
  within(c.projection.fovDeg, 50, 0.01, 'three.js camera fov (deg)'); within(c.projection.aspect, 4 / 3, 1e-4, 'three.js camera aspect');
  assert.equal(c.view.role, 'modelView', 'ShaderMaterial without viewMatrix: the model-view matrix, said so');
  const z = recOf(r, 'gl:camera.z'); assert.ok(z, 'camera z fitted');
  within(P(z, 'D'), 1000, 30, 'three.js camera z tween D (ms)'); within(z.derived.t0, 200, 17, 'three.js camera onset (ms)');
  within(P(z, 'x1'), 0.33, 0.05, 'three.js camera x1'); within(P(z, 'y1'), 1, 0.05, 'three.js camera y1'); within(P(z, 'x2'), 0.68, 0.05, 'three.js camera x2'); within(P(z, 'y2'), 1, 0.05, 'three.js camera y2');
  const u = recOf(r, 'gl:uMix'); assert.ok(u, 'uMix fitted');
  within(P(u, 'D'), 800, 24, 'three.js uMix tween D (ms)'); within(u.derived.t0, 500, 17, 'three.js uMix onset (ms)');
  within(P(u, 'x1'), 0.4, 0.05, 'three.js uMix x1'); within(P(u, 'x2'), 0.2, 0.05, 'three.js uMix x2');
  assert.match(formatLook(r), /WebGL camera: perspective, fov 50° \[measured\]/);
});

test('(g) a context made 6.5 s after load is still read by a load look; a clock that starts after a stray first value is a clock; a loop longer than the take is not a tween', async () => {
  const r = await look('gl-late.html', { action: 'load' });
  assert.equal(r.ok, true, r.warnings.join('; '));
  assert.equal(r.gl.contexts.length, 1, 'late context captured');
  assert.equal(r.gl.clocks.length, 1); assert.equal(r.gl.clocks[0].name, 'uTime');
  within(r.gl.clocks[0].perSecond, 1, 0.005, 'late clock rate (per second)');
  const txt = formatLook(r);
  assert.ok(!/uniform uTime: .*Spring/.test(txt), txt);
  // uLight: x = 0.8 cos(2 pi t / 28.56 s), y = 0.5 sin(...): the part seen is said as unsettled, with the values seen
  const l = r.gl.lines.find((x) => x.kind === 'unsettled' && /uLight/.test(x.subject));
  assert.ok(l, `uLight reads as a part of a slower motion\n${txt}`);
  assert.deepEqual(l.channels.sort(), ['gl:uLight.x', 'gl:uLight.y']);
  assert.ok(!r.gl.records.some((x) => /uLight/.test(x.target.channel)), 'no fitted tween on uLight');
});

test('(h) a view matrix still at identity before the camera is placed is not a camera at the origin: position (3, 4, 10), fov 40', async () => {
  const r = await look('gl-placed.html', { action: 'load' });
  const v = r.gl.camera.view;
  within(v.x, 3, 0.001, 'camera x'); within(v.y, 4, 0.001, 'camera y'); within(v.z, 10, 0.001, 'camera z');
  within(r.gl.camera.projection.fovDeg, 40, 0.01, 'camera fov');
  const txt = formatLook(r);
  assert.match(txt, /WebGL camera position \(3, 4, 10\)/, txt);
  assert.ok(!/Instant change: 0 → 4/.test(txt), 'no fake jump from the unplaced camera');
});
