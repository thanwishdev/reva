// M14b the same scene painted with the 2D canvas API: floor lines and two discs at CPU-projected positions.
import { parseParams, CAM, project, springConsts, springI7, cameraTarget } from '../core.js';

const P = parseParams('m14b', location.hash);
const cv = document.querySelector('.cv');
const ctx = cv.getContext('2d');

function draw(angle) {
  ctx.fillStyle = 'rgb(8, 10, 15)'; ctx.fillRect(0, 0, CAM.W, CAM.H);
  ctx.strokeStyle = 'rgb(60, 68, 90)'; ctx.lineWidth = 1; ctx.beginPath();
  for (let i = -4; i <= 4; i++) {
    let a = project([i, 0, -4], angle), b = project([i, 0, 4], angle); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    a = project([-4, 0, i], angle); b = project([4, 0, i], angle); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  for (const m of Object.values(CAM.markers)) {
    const p = project(m.pos, angle);
    ctx.fillStyle = `rgb(${m.rgb.join(', ')})`; ctx.beginPath(); ctx.arc(p.x, p.y, CAM.markerPx / 2, 0, Math.PI * 2); ctx.fill();
  }
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
