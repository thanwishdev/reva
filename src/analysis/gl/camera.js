// Camera from 4x4 matrix uniforms (WebGL light), engine-agnostic. Matrices are column-major as WebGL takes them
// (transpose already applied by the recorder). Everything here is decoded from the numbers the page sent to the GPU:
// "measured". A matrix that is not the expected shape is not guessed at: null.
const D = 180 / Math.PI;
const near0 = (x, e = 1e-4) => Math.abs(x) < e;

/**
 * Perspective or orthographic projection -> {kind, fovDeg, aspect, near, far, offAxis} | {kind:'orthographic', width,
 * height, near, far} | null. Perspective (gl-matrix / three.js / glm form): m[11] = -1, m[15] = 0, m[5] = 1/tan(fov/2).
 */
export function decodeProjection(m) {
  if (!Array.isArray(m) || m.length < 16 || !m.every(Number.isFinite)) return null;
  const offDiag = [1, 2, 3, 4, 6, 7, 12, 13].every((i) => near0(m[i], 1e-6));
  if (near0(m[11] + 1) && near0(m[15]) && offDiag && m[0] > 0 && m[5] > 0) {
    const A = m[10], B = m[14];
    const near = Math.abs(A - 1) > 1e-9 ? B / (A - 1) : null, far = Math.abs(A + 1) > 1e-9 ? B / (A + 1) : Infinity;
    return { kind: 'perspective', fovDeg: 2 * Math.atan(1 / m[5]) * D, aspect: m[5] / m[0], near, far: Number.isFinite(far) && far > 0 ? far : Infinity, offAxis: !(near0(m[8], 1e-6) && near0(m[9], 1e-6)) };
  }
  if (near0(m[3], 1e-6) && near0(m[7], 1e-6) && near0(m[11], 1e-6) && near0(m[15] - 1, 1e-6) && [1, 2, 4, 6, 8, 9].every((i) => near0(m[i], 1e-6)) && m[0] !== 0 && m[5] !== 0 && m[10] !== 0) {
    // orthographic: m[10] = -2/(far-near), m[14] = -(far+near)/(far-near)
    const fmn = -2 / m[10]; const fpn = -m[14] * fmn;
    return { kind: 'orthographic', width: 2 / m[0], height: 2 / m[5], near: (fpn - fmn) / 2, far: (fpn + fmn) / 2 };
  }
  return null;
}

/** Is the upper 3x3 a rotation (orthonormal, det +1) and the bottom row (0,0,0,1)? */
export function isRigid(m, tol = 2e-3) {
  if (!Array.isArray(m) || m.length < 16 || !m.every(Number.isFinite)) return false;
  if (!(near0(m[3], 1e-6) && near0(m[7], 1e-6) && near0(m[11], 1e-6) && near0(m[15] - 1, 1e-6))) return false;
  const c = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (Math.abs(dot(c[i], c[j]) - (i === j ? 1 : 0)) > tol) return false;
  const det = c[0][0] * (c[1][1] * c[2][2] - c[2][1] * c[1][2]) - c[1][0] * (c[0][1] * c[2][2] - c[2][1] * c[0][2]) + c[2][0] * (c[0][1] * c[1][2] - c[1][1] * c[0][2]);
  return det > 0;
}

/**
 * View matrix (world -> camera) -> camera position and rotation in world space: {x, y, z, rxDeg, ryDeg, rzDeg} (Euler
 * XYZ, the three.js default order) | null when the matrix is not a rigid transform (a scaled model-view, a combined MVP).
 */
export function decodeView(m) {
  if (!isRigid(m)) return null;
  const t = [m[12], m[13], m[14]];
  // R[r][c] = m[c*4 + r]; camera position p = -R^T t
  const p = [0, 1, 2].map((i) => -(m[i * 4] * t[0] + m[i * 4 + 1] * t[1] + m[i * 4 + 2] * t[2]));
  // camera world rotation Rw = R^T: Rw[r][c] = m[r*4 + c]
  const w = (r, c) => m[r * 4 + c];
  const m13 = Math.max(-1, Math.min(1, w(0, 2)));
  const ry = Math.asin(m13); let rx, rz;
  if (Math.abs(m13) < 0.9999999) { rx = Math.atan2(-w(1, 2), w(2, 2)); rz = Math.atan2(-w(0, 1), w(0, 0)); } else { rx = Math.atan2(w(2, 1), w(1, 1)); rz = 0; }
  const z0 = (v) => (Math.abs(v) < 1e-9 ? 0 : v);
  return { x: z0(p[0]), y: z0(p[1]), z: z0(p[2]), rxDeg: z0(rx * D), ryDeg: z0(ry * D), rzDeg: z0(rz * D) };
}

/**
 * The role of a 4x4 matrix uniform from its name and value: 'projection' | 'view' | 'modelView' | 'combined' | 'other'.
 * Names are the main signal (projectionMatrix, uProjection, viewMatrix, uView, modelViewMatrix, uMVP); a value with the
 * perspective shape is a projection whatever its name.
 */
export function matrixRole(name, m) {
  const n = String(name || '');
  const proj = decodeProjection(m);
  if (/mvp|viewproj|projview|view_?projection|projection_?view/i.test(n)) return 'combined';
  if (proj && (proj.kind === 'perspective' || /proj/i.test(n))) return 'projection';
  if (/model_?view/i.test(n)) return isRigid(m) ? 'modelView' : 'other';
  if (/view|cam/i.test(n) && !/proj/i.test(n)) return isRigid(m) ? 'view' : 'other';
  return 'other';
}
