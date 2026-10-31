// Solves the y1 control value of cubic-bezier(.34, y1, .64, 1) for a target overshoot (fraction of the amplitude).
import { bezierOvershoot } from '../core.js';
for (const target of (process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [0.05, 0.065, 0.085, 0.10, 0.115])) {
  let lo = 1, hi = 2;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (bezierOvershoot([0.34, m, 0.64, 1]) < target) lo = m; else hi = m; }
  console.log(target, (lo + hi) / 2, bezierOvershoot([0.34, +((lo + hi) / 2).toFixed(3), 0.64, 1]));
}
