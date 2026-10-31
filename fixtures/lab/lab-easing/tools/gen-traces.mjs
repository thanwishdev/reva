// Writes traces/<route>.<variant>.json (recorder scenario action lists) and routes.json. Run: node tools/gen-traces.mjs
// Trace rules (design section 11): step inputs sit on the 100 ms grid; every take starts with a 400 ms hold after boot,
// so the first input is at T >= 400 ms; a 'go' mark records the exact virtual instant of each trigger.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, GRIDS, BOXES } from '../core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = { width: 1280, height: 800 };
const boot = { until: 'window.__ready === true' };
const go = (name = 'go', src = '__go()') => [{ mark: name }, { eval: src }];
const CLICK = "document.getElementById('c').dispatchEvent(new MouseEvent('click', { bubbles: true }))";
const lead = [{ hold: 400 }, { snapshot: 'start' }];     // the snapshot reads the declared layer (scroll/view timelines are not born)

const dense = (from, to, px) => [{ denseSweep: { from, to, px, framesPerPos: 2 } }];
const steps = (ys, holds) => ys.flatMap((y, i) => [{ scrollTo: y }, { hold: holds[i] }]);

const T = {
  m06: { go: [...lead, ...go(), { hold: 2800 }] },
  m11: {
    sweep: [...lead, ...dense(700, 1500, 10), { hold: 300 }],
    reversal: [...lead, ...steps([700, 1000, 900, 1300, 1100, 1500, 1200], [300, 300, 300, 300, 300, 300, 600])],
    gap: [...lead, ...steps([700, 900, 1100, 1300, 1500], [300, 900, 300, 1000, 600])],
  },
  m12: { go: [...lead, { mark: 'go' }, { scrollTo: 1000 }, { hold: 2800 }] },
  m15: { go: [...lead, ...go(), { hold: 5600 }] },
  m17: { go: [...lead, ...go(), { hold: 1800 }] },
  m18: {
    single: [...lead, ...go(), { hold: 1600 }],
    interrupted: [...lead, ...go(), { hold: 300 }, ...go('go2'), { hold: 1600 }],
  },
  m19: {
    timer: [...lead, ...go(), { hold: 2400 }],
    click: [...lead, ...go('go', CLICK), { hold: 2400 }],
    retarget: [...lead, ...go('go', CLICK), { hold: 300 }, ...go('go2', CLICK), { hold: 2400 }],
  },
  m16e: { go: [...lead, ...go(), { hold: 2600 }] },
  m16f: { go: [...lead, ...go(), { hold: 2000 }] },
};
// the eval of a click trace dispatches directly (pointer/click actions arrive with recorder extension X3)

const WATCH = {
  m06: { selectors: ['#b0', '#b1', '#b2', '#b3', '#b4', '#b5'], computedVars: ['--e'] },
  m11: { selectors: ['#b0', '#b1'] },
  m12: { selectors: ['#b0', '#b1', '#b2', '#b3', '#b4', '#b5', '#n', '#t'] },
  m15: { selectors: ['#b0'] },
  m17: { selectors: ['#b0', '#b1'] },
  m18: { selectors: ['#b0'] },
  m19: { selectors: ['#b0'] },
  m16e: { selectors: ['#b0'] },
  m16f: { selectors: ['#b0'] },
};
const META = {
  m06: { driver: 'time', truthClass: 'declared', metrics: ['m06.visible_onset', 'm06.declared_vs_visible', 'm06.segment_bezier', 'm06_m12.stagger', 'class'] },
  m11: { driver: 'scroll', truthClass: 'declared', metrics: ['m11.declared_range', 'm11.measured_range', 'm11.css_waapi_parity', 'class'] },
  m12: { driver: 'scroll', truthClass: 'declared', metrics: ['m06_m12.stagger', 'm12.onset', 'm12.countup', 'class'] },
  m15: { driver: 'time', truthClass: 'declared', metrics: ['m15.smil_duration_begin', 'class'] },
  m17: { driver: 'time', truthClass: 'declared', metrics: ['m17.detected', 'm17.declared_timing', 'm17.group_geometry', 'class'] },
  m18: { driver: 'time', truthClass: 'declared', metrics: ['m18.detected', 'm18.layout_delta', 'm18.timing', 'm18.retarget', 'class'] },
  m19: { driver: 'time', truthClass: 'tween', metrics: ['m19.onset', 'm19.duration', 'm19.easing', 'm19.retarget', 'class'] },
  m16e: { driver: 'time', truthClass: 'tween', metrics: ['m16.negative', 'class'] },
  m16f: { driver: 'time', truthClass: 'tween', metrics: ['m16.negative', 'class'] },
};

fs.mkdirSync(path.join(root, 'traces'), { recursive: true });
const routes = [];
for (const id of Object.keys(DEFAULTS)) {
  const traces = {};
  for (const [variant, actions] of Object.entries(T[id])) {
    const file = `traces/${id}.${variant}.json`;
    const spec = { schema: 'reva.labtrace/0', route: id, variant, viewport: VIEW, seed: 1, boot, actions };
    fs.writeFileSync(path.join(root, file), JSON.stringify(spec, null, 1) + '\n');
    traces[variant] = file;
  }
  routes.push({ id, page: `routes/${id}.html`, driver: META[id].driver, engine: 'chs', params: { default: DEFAULTS[id], grid: GRIDS[id].map((g) => ({ ...DEFAULTS[id], ...g })) }, box: BOXES[id],
    traces, regimes: ['R2', 'R3', 'R4', 'R5'], watch: WATCH[id], truthClass: META[id].truthClass, metrics: META[id].metrics });
}
fs.writeFileSync(path.join(root, 'routes.json'), JSON.stringify({ schema: 'reva.labroutes/0', group: 'lab-easing', viewport: VIEW, routes }, null, 1) + '\n');
console.log('wrote', routes.length, 'routes,', routes.reduce((n, r) => n + Object.keys(r.traces).length, 0), 'traces');
