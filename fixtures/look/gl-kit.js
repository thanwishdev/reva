// Raw WebGL fixture kit (no library, no network): a small canvas, one program, a draw every frame. Known-truth pages
// (gl-*.html) plant values on uniforms and camera matrices; test/look/look-gl.test.js reads them back through look.
window.glKit = function glKit({ vs, fs, width = 400, height = 300, setup, frame }) {
  const c = document.createElement('canvas'); c.width = width; c.height = height; c.id = 'gl';
  c.style.cssText = `display:block;width:${width}px;height:${height}px;margin:40px`;
  document.body.appendChild(c);
  const gl = c.getContext('webgl'); window.__glOk = !!gl; if (!gl) return null;
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  gl.useProgram(p);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(p, 'position'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(p, n);
  const ctx = { gl, p, U, canvas: c };
  if (setup) setup(ctx);
  let t0 = null;
  const loop = (now) => { if (t0 == null) t0 = now; frame(ctx, now - t0, now); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 6); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  return ctx;
};
// cubic-bezier(x1, y1, x2, y2) as CSS defines it: solve x(s) = t by Newton then bisection, return y(s)
window.cubicBezier = function (x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (s) => ((ax * s + bx) * s + cx) * s, Y = (s) => ((ay * s + by) * s + cy) * s, dX = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (t) => { if (t <= 0) return 0; if (t >= 1) return 1; let s = t;
    for (let i = 0; i < 8; i++) { const e = X(s) - t; if (Math.abs(e) < 1e-7) return Y(s); const d = dX(s); if (Math.abs(d) < 1e-6) break; s -= e / d; }
    let lo = 0, hi = 1; s = t; while (hi - lo > 1e-7) { if (X(s) < t) lo = s; else hi = s; s = (lo + hi) / 2; } return Y(s); };
};
window.FLAT_VS = 'attribute vec3 position; void main() { gl_Position = vec4(position, 1.0); }';
