// Generates routes.json (design §11). The parameter grids live here; the page defaults live in core.js (DEFAULTS).
// Run: node tools/gen-routes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAM } from '../core.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// chrome-headless-shell without these flags draws into canvases that read back as all-zero (WebGL and 2D alike, measured);
// with them both are CPU-rasterised by SwiftShader and deterministic. Every canvas route gets them.
const GL_ARGS = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'];
const REG = ['R2', 'R3', 'R4', 'R5'];
const KEYS = Object.entries(CAM.markers).map(([key, m]) => ({ key, rgb: m.rgb, tol: 110 }));
const doc = (page, extra) => ({ id: page, page: `routes/${page}.html`, engine: 'chs', regimes: REG, ...extra });

const ROUTES = [
  doc('m13', {
    driver: 'pointer', docHeight: null, launchArgs: [],
    params: { grid: [
      { law: 'frame', alpha: 0.10 }, { law: 'frame', alpha: 0.06 }, { law: 'frame', alpha: 0.18 },
      { law: 'dt', lambda: 6 }, { law: 'dt', lambda: 12 },
    ] },
    traces: ['steps', 'reversal', 'gaps'], watch: { selectors: ['.b0'] },
    truthClass: 'first-order smoothing', metrics: ['class', 'law', 'alpha_per_frame', 'tau_at_T', 'attribution'],
  }),
  doc('m14', {
    driver: 'scroll', docHeight: 3000, launchArgs: GL_ARGS,
    params: { grid: [
      { mode: 'spring', zeta: 0.45, lag: 0.8 }, { mode: 'spring', zeta: 0.7, lag: 0.8 }, { mode: 'spring', zeta: 0.45, lag: 0.55 },
      { mode: 'spring', zeta: 0.7, lag: 1.1 }, { mode: 'orbit', orbitRate: 0.0005 },
    ] },
    traces: ['steps', 'reversal', 'gaps'],
    watch: { selectors: ['.cv'], glUniforms: ['u_a'], pixelKeys: KEYS },
    truthClass: 'spring', metrics: ['class', 'pixel_nrmse', 'dom_not_applicable', 'attribution'],
  }),
  doc('m14b', {
    driver: 'scroll', docHeight: 3000, launchArgs: GL_ARGS,
    params: { grid: [
      { mode: 'spring', zeta: 0.45, lag: 0.8 }, { mode: 'spring', zeta: 0.7, lag: 0.8 }, { mode: 'spring', zeta: 0.45, lag: 0.55 },
      { mode: 'spring', zeta: 0.7, lag: 1.1 }, { mode: 'spring', zeta: 0.58, lag: 0.65 },
    ] },
    traces: ['steps'], watch: { selectors: ['.cv'], pixelKeys: KEYS },
    truthClass: 'not_applicable', metrics: ['pixel_nrmse', 'dom_not_applicable'],
  }),
  doc('m16a', {
    driver: 'scroll', docHeight: 2400, launchArgs: [],
    params: { grid: [
      { x: 120, y: 60, opacity: 1 }, { x: 300, y: 40, opacity: 0.6 }, { x: 50, y: 200, opacity: 1 },
      { x: 640, y: 90, opacity: 0.8 }, { x: 15, y: 10, opacity: 0.35 },
    ] },
    traces: ['steps'], watch: { selectors: ['.b0', '.b1'] },
    truthClass: 'static', negative: { accept: ['static'], forbid: ['spring', 'first-order smoothing', 'tween', 'ramp', 'step', 'scroll map'] },
    metrics: ['negative', 'false_spring', 'false_ema'],
  }),
  doc('m16b', {
    driver: 'time', docHeight: 2400, launchArgs: [],
    params: { grid: [
      { seed: 11, base: 200, amp: 6 }, { seed: 23, base: 240, amp: 9 }, { seed: 37, base: 300, amp: 4 },
      { seed: 52, base: 160, amp: 12 }, { seed: 68, base: 260, amp: 16 },
    ] },
    traces: ['steps'], watch: { selectors: ['.b0'] },
    truthClass: 'unknown', negative: { accept: ['unknown', 'unexplained'], forbid: ['spring', 'first-order smoothing', 'tween', 'ramp', 'step', 'static', 'scroll map'] },
    metrics: ['negative', 'false_spring', 'false_ema'],
  }),
  doc('m16c', {
    driver: 'scroll', docHeight: 2400, launchArgs: [],
    params: { grid: [{ speed: 300 }, { speed: 150 }, { speed: 240 }, { speed: 450 }, { speed: 600 }] },
    traces: ['steps'], watch: { selectors: ['.b0'] },
    truthClass: 'ramp', negative: { accept: ['ramp', 'unknown'], forbid: ['spring', 'first-order smoothing', 'tween'] },
    metrics: ['negative', 'false_spring', 'false_ema'],
  }),
  doc('m16d', {
    driver: 'scroll', docHeight: 2400, launchArgs: [],
    params: { grid: [{ amp: 140 }, { amp: 60 }, { amp: 90 }, { amp: 200, threshold: 150 }, { amp: 260, threshold: 250 }] },
    traces: ['steps'], watch: { selectors: ['.b0'] },
    truthClass: 'step', negative: { accept: ['step', 'unknown'], forbid: ['spring', 'first-order smoothing', 'tween', 'ramp'] },
    metrics: ['negative', 'false_spring', 'false_ema'],
  }),
  doc('m20', {
    driver: 'scroll+time', docHeight: 3000, launchArgs: [],
    params: { grid: [{}] },
    traces: ['steps', 'holds', 'idle'], watch: { selectors: ['.e0', '.e1', '.e2', '.e3'] },
    truthClass: 'mixed', metrics: ['class', 'attribution'],
  }),
  doc('m21', {
    driver: 'scroll', docHeight: 2400, launchArgs: [],
    params: { grid: [{ durMs: 750 }, { durMs: 300 }, { durMs: 450 }, { durMs: 1050 }, { durMs: 1400 }] },
    traces: ['steps', 'reversal'], watch: { selectors: ['.b0'] },
    truthClass: 'restarted tween', metrics: ['class', 'law', 'step_response_duration'],
  }),
  doc('m22', {
    driver: 'scroll', docHeight: 2400, launchArgs: [],
    params: { grid: [
      { alpha: 0.16, durMs: 420, ease: [0.31, 0.12, 0.18, 0.97] }, { alpha: 0.07, durMs: 520, ease: [0.31, 0.12, 0.18, 0.97] },
      { alpha: 0.11, durMs: 300, ease: [0.17, 0.8, 0.33, 0.98] }, { alpha: 0.24, durMs: 560, ease: [0.4, 0.05, 0.2, 0.95] },
      { alpha: 0.33, durMs: 380, ease: [0.31, 0.12, 0.18, 0.97] },
    ] },
    traces: ['steps', 'reversal'], watch: { selectors: ['.b0'] },
    truthClass: 'composite', metrics: ['class', 'driver_alpha', 'transition_timing'],
  }),
];

for (const r of ROUTES) {
  r.params.default = r.params.grid[0];
  r.params = { default: r.params.default, grid: r.params.grid };
  r.traces = Object.fromEntries(r.traces.map((v) => [v, `traces/${r.id}.${v}.json`]));
}
fs.writeFileSync(path.join(root, 'routes.json'), JSON.stringify(ROUTES, null, 1) + '\n');
const cells = ROUTES.reduce((n, r) => n + r.params.grid.length * Object.keys(r.traces).length, 0);
console.log(`routes.json: ${ROUTES.length} routes, ${cells} cells`);
