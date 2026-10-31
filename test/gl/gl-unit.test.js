// WebGL light, no browser: matrix decoding (camera), technique heuristics over shader source, channel naming, clocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeProjection, decodeView, isRigid, matrixRole } from '../../src/analysis/gl/camera.js';
import { techniqueOf, techniqueSummary, stripComments } from '../../src/analysis/gl/technique.js';
import { glNames, parseKey, glSeriesOf, cameraKeys } from '../../src/analysis/gl/channels.js';
import { clockOf, unsettledAtEnd, programHash, subjectOf } from '../../src/look/gl.js';
import { channelWord } from '../../src/look/words.js';

const persp = (fovDeg, aspect, n, f) => { const t = 1 / Math.tan(fovDeg * Math.PI / 360); return [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]; };
const ortho = (l, r, b, t, n, f) => [2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1];
const sub = (a, b) => a.map((x, i) => x - b[i]); const nrm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lookAt = (eye, c, up = [0, 1, 0]) => { const z = nrm(sub(eye, c)), x = nrm(cross(up, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]; };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('projection: perspective fov / aspect / near / far decode exactly (float32 too); orthographic; garbage is null', () => {
  for (const [fov, asp, n, f] of [[45, 16 / 9, 0.1, 100], [75, 1, 0.01, 2000], [20, 0.5, 1, 50]]) {
    const d = decodeProjection(Array.from(new Float32Array(persp(fov, asp, n, f))));
    assert.equal(d.kind, 'perspective'); near(d.fovDeg, fov, 1e-4, 'fov'); near(d.aspect, asp, 1e-5, 'aspect'); near(d.near, n, n * 1e-3, 'near'); near(d.far, f, f * 2e-2, 'far'); assert.equal(d.offAxis, false);
  }
  const o = decodeProjection(ortho(-4, 4, -3, 3, 0.1, 10));
  assert.equal(o.kind, 'orthographic'); near(o.width, 8, 1e-9, 'w'); near(o.height, 6, 1e-9, 'h'); near(o.near, 0.1, 1e-9, 'n'); near(o.far, 10, 1e-9, 'f');
  assert.equal(decodeProjection([1, 2, 3]), null);
  assert.equal(decodeProjection(lookAt([1, 2, 3], [0, 0, 0])), null, 'a view matrix is not a projection');
});

test('view: camera position and rotation from a lookAt view matrix; a scaled or combined matrix is not decoded', () => {
  const v = decodeView(lookAt([3, 2, 5], [0, 0, 0]));
  near(v.x, 3, 1e-9, 'x'); near(v.y, 2, 1e-9, 'y'); near(v.z, 5, 1e-9, 'z');
  const t = decodeView([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2, -6, 1]);
  assert.deepEqual([t.x, t.y, t.z, t.rxDeg, t.ryDeg, t.rzDeg], [0, 2, 6, 0, 0, 0]);
  // yaw 30 degrees about y: camera world rotation ry = 30
  const a = 30 * Math.PI / 180; const R = [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
  // view = inverse(camera world) = R^T (rotation only)
  const view = [R[0], R[4], R[8], 0, R[1], R[5], R[9], 0, R[2], R[6], R[10], 0, 0, 0, 0, 1];
  near(decodeView(view).ryDeg, 30, 1e-9, 'yaw');
  assert.equal(decodeView([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]), null, 'scaled');
  const mvp = persp(45, 1, 0.1, 100); assert.equal(isRigid(mvp), false);
  assert.equal(matrixRole('projectionMatrix', persp(45, 1, 0.1, 100)), 'projection');
  assert.equal(matrixRole('uMatrix', persp(45, 1, 0.1, 100)), 'projection', 'perspective shape whatever the name');
  assert.equal(matrixRole('viewMatrix', lookAt([0, 0, 5], [0, 0, 0])), 'view');
  assert.equal(matrixRole('modelViewMatrix', lookAt([0, 0, 5], [0, 0, 0])), 'modelView');
  assert.equal(matrixRole('uMVP', persp(45, 1, 0.1, 100)), 'combined');
  assert.equal(matrixRole('uModel', lookAt([0, 0, 5], [0, 0, 0])), 'other');
});

test('technique: fbm, simplex, raymarch, vertex displacement, textures, instancing, render-to-texture; comments do not count', () => {
  const fbm = techniqueOf({ vs: 'attribute vec3 position; void main(){ gl_Position = vec4(position, 1.0); }',
    fs: 'uniform float uTime; uniform sampler2D uMap; float snoise(vec2 p){return p.x;} float fbm(vec2 p){float v=0.;for(int i=0;i<4;i++){v+=snoise(p);p*=2.0;}return v;} void main(){ gl_FragColor = texture2D(uMap, vec2(fbm(vec2(uTime)))) + texture2D(uMap, vec2(0.)); }',
    uniforms: [{ name: 'uTime', type: 'float', size: 1 }, { name: 'uMap', type: 'sampler2D', size: 1 }] }, { framebuffers: 1, framebufferBinds: 4 });
  const ids = fbm.map((x) => x.id);
  for (const id of ['fbm', 'simplex', 'textures', 'time', 'screen-pass', 'render-to-texture']) assert.ok(ids.includes(id), `${id} in ${ids}`);
  assert.ok(fbm.every((x) => x.label === 'derived' && x.evidence), 'every item is derived and carries its evidence');
  assert.equal(techniqueSummary(fbm, { framebuffers: 1 }), 'fbm noise, simplex noise, 1 texture, full-screen pass, time uniform, 2 passes');
  assert.match(fbm.find((x) => x.id === 'textures').text, /^1 texture bound .*, 2 texture reads/);
  const rm = techniqueOf({ fs: 'float sdSphere(vec3 p, float r){return length(p)-r;} float map(vec3 p){return sdSphere(p,1.);} void main(){ vec3 ro=vec3(0.), rd=vec3(0.,0.,1.); float t=0.; for(int i=0;i<64;i++){ float d=map(ro+rd*t); t+=d; } gl_FragColor=vec4(t); }' });
  assert.ok(rm.some((x) => x.id === 'raymarch'));
  const disp = techniqueOf({ vs: 'uniform float uTime; attribute vec3 position; float noise(vec3 p){return 0.;} void main(){ vec3 pos = position; pos.z += noise(position + uTime); gl_Position = vec4(pos, 1.); }', fs: 'void main(){}' });
  assert.ok(disp.some((x) => x.id === 'vertex-displacement'), JSON.stringify(disp.map((x) => x.id)));
  const inst = techniqueOf({ vs: '#version 300 es\nin vec3 position; void main(){ gl_Position = vec4(position + float(gl_InstanceID), 1.); gl_PointSize = 2.0; }', fs: '' });
  assert.ok(inst.some((x) => x.id === 'instancing') && inst.some((x) => x.id === 'points'));
  assert.ok(techniqueOf({ vs: '', fs: '', instancedDraws: 3 }).some((x) => x.id === 'instancing'));
  const commented = techniqueOf({ fs: '// float fbm(vec2 p) { return snoise(p); }\n/* raymarch: for (;;) map(p) */ void main(){ gl_FragColor = vec4(1.); }' });
  assert.deepEqual(commented, [], 'commented-out code is not a technique');
  assert.equal(stripComments('a // b\nc /* d */ e').replace(/\s+/g, ' ').trim(), 'a c e');
});

test('channels: program-keyed names, identical copies merged, different values split, unsafe names never printed', () => {
  assert.deepEqual(parseKey('p3|uTime'), { prog: 3, name: 'uTime', raw: 'uTime' });
  assert.equal(parseKey('p1|u_a[2].b').name, 'u_a[2].b');
  assert.equal(parseKey('p1|bad name\u001b[31m').name, null);
  const vals = { 'p1|cameraPosition': [1, 2], 'p2|cameraPosition': [1, 2], 'p1|uT': [0, 1], 'p2|uT': [5, 6], 'p1|x y': [1] };
  const names = glNames(Object.keys(vals), (k) => vals[k]);
  assert.equal(names.get('p1|cameraPosition'), 'cameraPosition'); assert.equal(names.get('p2|cameraPosition'), null, 'identical copy merged');
  assert.equal(names.get('p1|uT'), 'uT@p1'); assert.equal(names.get('p2|uT'), 'uT@p2');
  assert.equal(names.get('p1|x y'), 'uniform#1');
  const rows = [0, 1, 2].map((i) => ({ T: i * 10, gl: { 'p1|uP': i / 2, 'p1|uC': [1, i, 3] }, glm: { 'p1|projectionMatrix': persp(45, 1.5, 0.1, 100), 'p1|viewMatrix': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5 - i, 1] } }));
  const s = glSeriesOf(rows);
  assert.deepEqual(s.get('gl|gl:uP').y, [0, 0.5, 1]); assert.deepEqual(s.get('gl|gl:uC.y').y, [0, 1, 2]);
  near(s.get('gl|gl:camera.fov').y[0], 45, 1e-9, 'fov'); assert.deepEqual(s.get('gl|gl:camera.z').y, [5, 6, 7]);
  assert.deepEqual(cameraKeys(rows), { projection: 'p1|projectionMatrix', view: 'p1|viewMatrix', viewRole: 'view', roles: { 'p1|projectionMatrix': 'projection', 'p1|viewMatrix': 'view' } });
  assert.equal(channelWord('gl:uP'), 'uniform uP'); assert.equal(channelWord('gl:camera.fov'), 'camera fov (°)');
  assert.equal(subjectOf('gl:uC.y'), 'uniform uC'); assert.equal(subjectOf('gl:camera.z'), 'camera position'); assert.equal(subjectOf('gl:camera.ry'), 'camera rotation');
});

test('clock: a uniform rising linearly with page time for the whole take; a linear tween that ends, or a wave, is not', () => {
  const T = Array.from({ length: 240 }, (_, i) => i * 1000 / 120);
  assert.equal(clockOf(T, T.map((t) => t / 1000), 2000).perSecond.toFixed(6), '1.000000');
  assert.equal(+clockOf(T, T.map((t) => 3 + 0.25 * t / 1000), 2000).perSecond.toFixed(6), 0.25);
  assert.equal(clockOf(T, T.map((t) => Math.min(1, t / 1000)), 2000), null, 'linear tween with a plateau');
  assert.equal(clockOf(T, T.map((t) => Math.sin(t / 300)), 2000), null, 'a wave');
  assert.equal(clockOf(T.slice(0, 60), T.slice(0, 60).map((t) => t), 2000), null, 'only part of the take');
  assert.equal(programHash('a', 'b'), programHash('a', 'b')); assert.notEqual(programHash('a', 'b'), programHash('ab', '')); assert.match(programHash('a', 'b'), /^[0-9a-f]{12}$/);
});

test('clock: a stray first value then a straight line is a clock (blackhole uTime); a delayed linear ramp that fills the take is not', () => {
  const T = Array.from({ length: 244 }, (_, i) => (i + 1) * 50 / 3);   // 60 Hz, 4.07 s
  const stray = T.map((t) => (t < 160 ? 0.0167 : t / 1000));
  const c = clockOf(T, stray, 4050); assert.ok(c, 'stray head then a clock');
  assert.equal(+c.perSecond.toFixed(4), 1);
  assert.equal(clockOf(T, T.map((t) => Math.min(2.6, Math.max(0, (t - 166) / 1000))), 4050), null, 'delayed linear ramp that stops: a ramp');
  assert.equal(clockOf(T, T.map((t) => Math.max(0, (t - 500) / 1000)), 4050), null, 'delayed ramp whose head sits on its own line: a delay, not a stray value');
});

test('unsettledAtEnd: a slow loop cut by the take is open; a tween that settled is not', () => {
  const T = Array.from({ length: 244 }, (_, i) => (i + 1) * 50 / 3);
  const P = 28560;
  assert.equal(unsettledAtEnd(T, T.map((t) => 0.8 * Math.cos(2 * Math.PI * t / P)), 4050), true, 'cos with a 28.56 s period seen for 4 s');
  assert.equal(unsettledAtEnd(T, T.map((t) => 0.5 * Math.sin(2 * Math.PI * t / P)), 4050), true);
  const e = (x) => 1 - Math.pow(1 - x, 3);
  assert.equal(unsettledAtEnd(T, T.map((t) => e(Math.min(1, t / 1400))), 4050), false, 'tween that settled at 1400 ms');
  assert.equal(unsettledAtEnd(T, T.map(() => 1), 4050), false, 'constant');
});

test('camera: a view matrix still at identity is not a camera at the origin when a later row places the camera', () => {
  const P = persp(40, 4 / 3, 0.1, 100); const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const V = lookAt([3, 4, 10], [3, 4, 0]);
  const rows = [{ glm: { 'p1|projectionMatrix': P, 'p1|viewMatrix': I } }, { glm: { 'p1|projectionMatrix': P, 'p1|viewMatrix': I } }, { glm: { 'p1|projectionMatrix': P, 'p1|viewMatrix': V } }, { glm: { 'p1|projectionMatrix': P, 'p1|viewMatrix': V } }];
  const s = glSeriesOf(rows);
  assert.deepEqual(s.get('gl|gl:camera.x').y.map((v) => +v.toFixed(6)), [3, 3]);
  assert.deepEqual(s.get('gl|gl:camera.z').idx, [2, 3], 'identity rows left out');
  // a camera that really is at the origin for the whole take stays at the origin
  const s0 = glSeriesOf([{ glm: { 'p1|projectionMatrix': P, 'p1|viewMatrix': I } }, { glm: { 'p1|projectionMatrix': P, 'p1|viewMatrix': I } }]);
  assert.deepEqual(s0.get('gl|gl:camera.x').y, [0, 0]);
});
