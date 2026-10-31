// M14 raw WebGL scene: a checker floor and two coloured markers seen by a camera that orbits the Y axis.
// The camera angle is a uniform. It is driven by scroll through a dt-capped spring, or by the wall clock.
import { parseParams, CAM, springConsts, springI7, cameraTarget } from '../core.js';

const P = parseParams('m14', location.hash);
const cv = document.querySelector('.cv');
const gl = cv.getContext('webgl', { alpha: false, antialias: false });

const fl = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const L = (a) => `vec3(${a.map(fl).join(', ')})`;
const foc = 1 / Math.tan(CAM.fovY / 2);
const VS = `
attribute vec3 a_p; attribute vec3 a_c; attribute float a_s;
uniform float u_a; uniform float u_k;
varying vec3 v_c;
void main() {
  vec3 eye = vec3(${fl(CAM.dist)} * sin(u_a), ${fl(CAM.height)}, ${fl(CAM.dist)} * cos(u_a));
  vec3 f = normalize(${L(CAM.look)} - eye);
  vec3 r = normalize(cross(f, vec3(0.0, 1.0, 0.0)));
  vec3 u = cross(r, f);
  vec3 d = a_p - eye;
  vec3 v = vec3(dot(d, r), dot(d, u), dot(d, f));
  float zc = (v.z * ${fl(CAM.far + CAM.near)} - ${fl(2 * CAM.far * CAM.near)}) / ${fl(CAM.far - CAM.near)};
  gl_Position = vec4(v.x * ${fl(foc / (CAM.W / CAM.H))}, v.y * ${fl(foc)}, zc, v.z);
  gl_PointSize = a_s;
  v_c = a_c;
}`;
const FS = `
precision highp float;
varying vec3 v_c; uniform float u_k;
void main() {
  float a = 1.0;
  if (u_k > 0.5) { a = clamp((1.0 - length(gl_PointCoord - vec2(0.5)) * 2.0) * 10.0, 0.0, 1.0); }
  gl_FragColor = vec4(v_c, a);
}`;
function shader(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
const pr = gl.createProgram();
gl.attachShader(pr, shader(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, shader(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(pr); gl.useProgram(pr);
const uA = gl.getUniformLocation(pr, 'u_a'), uK = gl.getUniformLocation(pr, 'u_k');

// floor: 8 x 8 quads on y = 0, two tones
const fv = [];
for (let i = -4; i < 4; i++) for (let j = -4; j < 4; j++) {
  const c = (i + j) & 1 ? [0.10, 0.12, 0.16] : [0.15, 0.17, 0.22];
  for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 0], [1, 1], [0, 1]]) fv.push(i + di, 0, j + dj, ...c, 1);
}
const mk = Object.values(CAM.markers).flatMap((m) => [...m.pos, ...m.rgb.map((c) => c / 255), CAM.markerPx]);
const buf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW); return b; };
const bFloor = buf(fv), bMark = buf(mk);
const attr = (name, size, off) => { const l = gl.getAttribLocation(pr, name); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 28, off * 4); };
function bind(b) { gl.bindBuffer(gl.ARRAY_BUFFER, b); attr('a_p', 3, 0); attr('a_c', 3, 3); attr('a_s', 1, 6); }
gl.viewport(0, 0, CAM.W, CAM.H);
gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

function draw(angle) {
  gl.clearColor(0.03, 0.04, 0.06, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform1f(uA, angle);
  gl.uniform1f(uK, 0); bind(bFloor); gl.drawArrays(gl.TRIANGLES, 0, fv.length / 7);
  gl.uniform1f(uK, 1); bind(bMark); gl.drawArrays(gl.POINTS, 0, mk.length / 7);
}
draw(0);

const sp = springConsts(P.zeta, P.lag);
const s = { x: 0, v: 0 };
let last = 0, start = 0;
function frame(now) {
  const dt = now - last; last = now;
  let angle;
  if (P.mode === 'orbit') angle = (Date.now() - start) * P.orbitRate;
  else {
    const g = cameraTarget(P, scrollY);
    springI7(s, g, sp.k, sp.c, dt, P.capMs);
    if (Math.abs(s.v) < P.snapV && Math.abs(s.x - g) < P.snapX) { s.x = g; s.v = 0; }
    angle = s.x;
  }
  draw(angle);
  requestAnimationFrame(frame);
}
addEventListener('go', () => { last = performance.now(); start = Date.now(); requestAnimationFrame(frame); }, { once: true });
