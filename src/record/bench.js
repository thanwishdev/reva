// Stepper bench check (A6 "bench page control <= 1 frame, .finished fires"), own fixture fixtures/bench.
// Same analytic model as the W2G1-2 bench analysis: page-side pause/play, playbackRate and reverse on linear WAAPI loops.
import { cubicBezier, clamp01, springClosed } from '../analysis/oracles.js';

export function analyseBench(rows, log, els) {
  const id = (name) => els.findIndex(d => d && d.startsWith('DIV#' + name));
  const ix = Object.fromEntries(['ctl', 'rate', 'rev', 'wa', 'tr', 'js', 'ema'].map(n => [n, id(n)]));
  const tx = (r, n) => { const v = r.v[ix[n]]; return v ? v['ren:tx'] : null; };
  const t0 = log.t0; const S = rows.filter(r => r.T > t0 + 1e-6 && tx(r, 'ctl') != null);
  const Tb = S[0].T;
  const eTr = cubicBezier(.42, 0, .58, 1), eWa = cubicBezier(0.34, 1.56, 0.64, 1);
  const err = { ctl: [], rate: [], rev: [], wa: [], tr: [], js: [] };
  for (const s of S) {
    const tau = s.T - Tb;
    const aP = t0 + 300 - Tb, aR = t0 + 600 - Tb; const loc = tau <= aP ? tau : tau <= aR ? aP : tau - (aR - aP);
    { const e = tx(s, 'ctl') - (loc % 1000) / 10; err.ctl.push(Math.abs(e) > 50 ? 100 - Math.abs(e) : e); }
    const aRate = t0 + 200 - Tb; err.rate.push(tx(s, 'rate') - Math.min(100, (tau <= aRate ? tau : aRate + 2 * (tau - aRate)) / 10));
    const aRev = t0 + 400 - Tb; err.rev.push(tx(s, 'rev') - Math.max(0, (tau <= aRev ? tau : aRev - (tau - aRev))) / 10);
    if (tau <= 800) err.wa.push(tx(s, 'wa') - 300 * eWa(clamp01(tau / 800)));
    err.tr.push(tx(s, 'tr') - 400 * eTr(clamp01(tau / 1000)));
    err.js.push(tx(s, 'js') - 500 * springClosed(170, 26, 1, (s.T - t0) / 1000));
  }
  const maxErr = Object.fromEntries(Object.entries(err).map(([k, v]) => [k, +Math.max(...v.map(Math.abs)).toFixed(4)]));
  const ev = Object.fromEntries(log.events.map(([n, t]) => [n, +t.toFixed(3)]));
  return { n: S.length, maxErr, events: ev, finishedFired: 'wafin' in ev, micro: log.micro.join(','), rafmicro: log.rafmicro.join(',') };
}
