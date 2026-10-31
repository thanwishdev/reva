// Generates routes.json and traces/*.json for group B (run: node fixtures/lab/lab-springs/gen.mjs). The route table
// is data; this file is the single place where the parameter grids, code variants and trace lengths are chosen.
// Own parameters only (design M2-fitter.md 11): the sets below are G1-4 7.2 values or invented here, never a site's numbers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const A = 200;                          // amplitude, px
const BOOT = { until: "document.readyState === 'complete'" };
const common = { viewport: { width: 1280, height: 800 }, seed: 1, scene: { selectors: ['.b0'] }, boot: BOOT };

// ---- M07 / M07x parameter sets: (k, c, m) canonical, zeta ~ 0.42 / 0.87 / 1.5; I4 in native per-frame units (kf, cf)
const SETS = {
  a: { k: 200, c: 12, m: 1 },        // omega0 14.1, zeta 0.424
  b: { k: 240, c: 16, m: 0.35 },     // omega0 26.2, zeta 0.873
  c: { k: 100, c: 30, m: 1 },        // omega0 10.0, zeta 1.5
};
const NATIVE = {                     // per 60 Hz frame; poles chosen for zeta 0.42 / 0.87 / 1.5 at omega 0.24 / 0.22 / 0.16 rad per frame
  a: { kf: 0.052, cf: 0.183 },
  b: { kf: 0.04, cf: 0.318 },
  c: { kf: 0.02, cf: 0.381 },
};
const vec = (integrator, set) => ({ integrator, ...(integrator === 'i4' ? NATIVE[set] : SETS[set]), A, write: 'full' });
const M07_IDS = ['i1h16', 'i1h2', 'i1h1', 'i4', 'i5', 'i6', 'i7'];
const M07X_IDS = ['verlet', 'i1h5'];

const variants = (ids, sets, drawFor) => ids.map(id => ({
  id, default: vec(id, sets[0]), grid: sets.map(s => vec(id, s)), draw: drawFor(id),
}));
const drawCanon = (omega0, zeta, m) => ({ kind: 'omega-zeta-m', omega0, zeta, m, rule: 'k = m*omega0^2, c = 2*zeta*m*omega0; redraw while the vector is not valid (see cell.mjs isValid)' });
const drawNative = () => ({ kind: 'native-pole', omega_per_frame: [0.16, 0.24], zeta: [0.42, 1.5], rule: 'poles z = exp(-zeta*w +- i*w*sqrt(1-zeta^2)) per 60 Hz frame; kf, cf from the characteristic polynomial; 3 decimals' });

const metricsM07 = ['M07/integrator-identified', 'M07/wrong-confident', 'M07/replay-nrmse', 'M07/kc-rel-error', 'M07/analytic-flag', 'class'];
const routes = [
  {
    id: 'm07', page: 'm07.html', driver: 'time', engine: 'chs', codeVariantKey: 'integrator',
    codeVariants: variants(M07_IDS, ['a', 'b', 'c'], id => (id === 'i4' ? drawNative() : drawCanon([10, 26.2], [0.42, 1.5], [0.35, 1]))),
    traces: { p1000: 'traces/m07.p1000.json', p400: 'traces/m07.p400.json' },
    regimes: ['R2', 'R3', 'R4', 'R5', 'R6'], watch: { selectors: ['.b0'], computedVars: [], glUniforms: [], pixelKeys: [] },
    truthClass: 'spring', metrics: metricsM07,
  },
  {
    id: 'm07x', page: 'm07x.html', driver: 'time', engine: 'chs', codeVariantKey: 'integrator', outOfFitterSet: true,
    codeVariants: variants(M07X_IDS, ['a', 'b'], () => drawCanon([10, 26.2], [0.42, 0.873], [0.35, 1])),
    traces: { p1000: 'traces/m07x.p1000.json' },
    regimes: ['R2', 'R3', 'R4', 'R5', 'R6'], watch: { selectors: ['.b0'], computedVars: [], glUniforms: [], pixelKeys: [] },
    truthClass: 'spring', metrics: ['M07/wrong-confident', 'confident-wrong'],
  },
  {
    id: 'm08', page: 'm08.html', driver: 'time', engine: 'chs', codeVariantKey: null,
    note: 'G1-4 lists the driver as click; X3 (CDP click) has not landed, so a page timer starts the motion. Same page, same truth.',
    codeVariants: [{
      id: 'analytic',
      default: { omega0: 13, zeta: 0.42, A, write: 'full' },
      grid: [[0.25, 14], [0.42, 13], [0.6, 16], [1.0, 12], [1.5, 10]].map(([zeta, omega0]) => ({ omega0, zeta, A, write: 'full' })),
      draw: { kind: 'omega-zeta', omega0: [10, 16], zeta: [0.25, 1.5] },
    }],
    traces: { rest: 'traces/m08.rest.json', retarget: 'traces/m08.retarget.json', v0: 'traces/m08.v0.json' },
    regimes: ['R2', 'R3', 'R4', 'R5', 'R6'], watch: { selectors: ['.b0'], computedVars: [], glUniforms: [], pixelKeys: [] },
    truthClass: 'spring', metrics: ['M08/omega-zeta-rel-error', 'M08/overshoot', 'M08/settle', 'class'],
  },
  {
    id: 'm10', page: 'm10.html', driver: 'pointer', engine: 'chs', codeVariantKey: 'law',
    note: 'The pointer path is replayed by page timers that dispatch synthetic pointer events (same handlers a real pointer would hit); drive:"external" in params turns that off for CDP input once X3 lands.',
    codeVariants: [
      { id: 'frame', default: { law: 'frame', friction: 0.94, write: 'full' }, grid: [0.9, 0.94, 0.97].map(friction => ({ law: 'frame', friction, write: 'full' })), draw: { kind: 'range', friction: [0.9, 0.97] } },
      { id: 'dt', default: { law: 'dt', friction: 0.95, write: 'full' }, grid: [0.92, 0.95].map(friction => ({ law: 'dt', friction, write: 'full' })), draw: { kind: 'range', friction: [0.92, 0.95] } },
    ],
    traces: { fast: 'traces/m10.fast.json', slow: 'traces/m10.slow.json', still: 'traces/m10.still.json' },
    regimes: ['R2', 'R3', 'R4', 'R5', 'R6'], watch: { selectors: ['.b0'], computedVars: [], glUniforms: [], pixelKeys: [] },
    truthClass: 'friction', metrics: ['M10/friction-rel-error', 'M10/stopping-distance', 'M09/law-class', 'M16/no-momentum', 'class'],
  },
];
for (const r of routes) {
  r.params = { default: r.codeVariants[0].default, grid: r.codeVariants.flatMap(v => v.grid) };
  r.cells = { paramVectors: r.params.grid.length, traces: Object.keys(r.traces).length, total: r.params.grid.length * Object.keys(r.traces).length };
}

// ---- traces: page schedule (merged into params as the page's `sched`/`path`) + recorder actions
const holds = { m07: 6200, m07x: 6200, m08: 3600 };
const traces = [];
const mk = (route, id, page, hold, note) => traces.push({ file: `traces/${route}.${id}.json`, body: { id, route, note, page, ...common, actions: [{ eval: "window.dispatchEvent(new Event('go'))" }, { mark: 'go' }, { hold }, { mark: 'end' }] } });
mk('m07', 'p1000', { sched: 'p1000' }, holds.m07, 'retarget every 1000 ms: levels 1, 0, 1 at 500, 1500, 2500 ms after the first frame');
mk('m07', 'p400', { sched: 'p400' }, holds.m07, 'retarget every 400 ms: levels 1, 0, 1, 0, 1, 0 at 500 .. 2500 ms; each retarget lands mid-motion');
mk('m07x', 'p1000', { sched: 'p1000' }, holds.m07x, 'as m07.p1000');
mk('m08', 'rest', { sched: 'rest' }, holds.m08, 'from rest to level 1 at 500 ms');
mk('m08', 'retarget', { sched: 'retarget' }, holds.m08, 'level 1 at 500 ms, level 0.3 at 1000 ms (velocity continuity at the retarget)');
mk('m08', 'v0', { sched: 'v0' }, holds.m08, 'level 1 at 500 ms with an initial velocity of -2.5 A/s (away from the target)');
mk('m10', 'fast', { path: 'fast' }, 7000, 'drag 0.6 px/ms, release at 905 ms with a last-100-ms velocity of 0.6 px/ms');
mk('m10', 'slow', { path: 'slow' }, 6000, 'drag 0.25 px/ms, release at 905 ms');
mk('m10', 'still', { path: 'still' }, 1800, 'drag then stop at 800 ms, release at 1100 ms: zero release velocity, no momentum expected');

fs.mkdirSync(path.join(ROOT, 'traces'), { recursive: true });
for (const t of traces) fs.writeFileSync(path.join(ROOT, t.file), JSON.stringify(t.body, null, 1) + '\n');
fs.writeFileSync(path.join(ROOT, 'routes.json'), JSON.stringify(routes, null, 1) + '\n');
const cells = routes.reduce((a, r) => a + r.cells.total, 0);
console.log(`routes.json: ${routes.length} routes, ${cells} cells (expected 76); traces: ${traces.length}`);
