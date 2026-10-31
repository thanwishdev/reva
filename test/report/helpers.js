import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const loadFix = (n) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.fit.json`), 'utf8'));
export const NOW = '2026-10-15T00:00:00.000Z';

const pv = (value, provenance, extra = {}) => ({ value, provenance, ...extra });
/** A hand-made fit result shaped like reva.fitresult/0 (src/analysis/fit/index.js), for cases the lab fixtures lack. */
export function synthFit(over = {}) {
  const base = (desc, channel, extra = {}) => ({
    schema: 'reva.motion/0', target: { el: 1, desc, channel, untrusted_content: true }, attribution: { label: 'time-driven', provenance: 'inferred', evidence: 'no input precedes motion' },
    tier: 'fitted', class: 'tween', model: { family: 'bezier', params: { t0: pv(100, 'fitted', { unit: 'ms', ci95: [99, 101] }), D: pv(400, 'fitted', { unit: 'ms', ci95: [399, 401] }) }, integrator: null, law: 'time-based', valid_at: { frame_ms: 8.33, refresh_hz: 120 } },
    derived: { t10: 20, t50: 90, t90: 250 }, fit: { n: 100, rms: 0.01, nrmse: 0.001, sigma_floor: 0.01, explain_bar: 0.05, bic: -100, holdout: { method: 'last-30%', rms: 0.01, pass: true } },
    runnerUp: null, rejected: [], ambiguity: null, replay: null, unknowns: [], flags: [], evidence: { takes: ['aaaa111122223333'], location: { kind: 'time_range', range: [0, 800] } }, ...extra,
  });
  return {
    schema: 'reva.fitresult/0', takes: { primary: 'aaaa111122223333', probe: null, idle: null }, env: { lane: 'hx', dtMs: 8.33, rateHz: 120, stride: 1, probeDtMs: null }, flags: [],
    records: [
      base('DIV.hero', 'ren:tx'),
      base('DIV.hero', 'ren:opacity', { tier: 'unexplained', class: 'unknown', model: { family: 'unexplained', params: {}, integrator: null, law: null, valid_at: null }, replay: { linear: [{ tol: 0.01, stops: 24, css: 'linear(0 0%, 1 100%)', durationMs: 380 }] }, unknowns: [{ id: 'unk_unexplained', reason: 'no family explains', probe: 'more takes' }] }),
      base('CANVAS.cv', '*', { tier: 'not_applicable', class: 'not_applicable', model: { family: null, params: {} }, derived: {}, fit: {}, unknowns: [{ id: 'unk_canvas_content', reason: 'canvas drawing is not visible to DOM channels', probe: 'record the pixel channel' }] }),
    ],
    stagger: [], pins: [{ el: 2, desc: 'DIV#pin', start_px: 400, end_px: null, start: pv(400, 'measured'), end: { value: null, interval: [2300, null], provenance: 'unknown' }, heldFrom_px: 1500, heldTo_px: 2300, provenance: 'measured' }],
    statics: { count: 3, sample: [{ key: 'a|b', desc: 'DIV.s', ch: 'ren:ty', coverage: 'not observed moving in these takes' }] }, pruned: [], unknowns: [], ...over,
  };
}
