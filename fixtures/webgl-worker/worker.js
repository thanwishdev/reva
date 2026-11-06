self.onmessage = (e) => {
  const gl = e.data.canvas.getContext('webgl2');
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }'));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float; uniform float uTime; uniform float uProgress; uniform vec3 uColor; out vec4 o; void main(){ o = vec4(uColor * uProgress, 1.0) + 0.0 * uTime; }'));
  gl.linkProgram(p); gl.useProgram(p);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(0);
  const uT = gl.getUniformLocation(p, 'uTime'), uP = gl.getUniformLocation(p, 'uProgress'), uC = gl.getUniformLocation(p, 'uColor');
  gl.uniform3f(uC, 1, 0.5, 0.25);
  let n = 0;
  const frame = (t) => { n++; gl.uniform1f(uT, t / 1000); gl.uniform1f(uP, Math.min(1, Math.max(0, (n - 10) / 60))); gl.drawArrays(gl.TRIANGLES, 0, 3); if (n === 5) self.postMessage('drawn'); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
};
