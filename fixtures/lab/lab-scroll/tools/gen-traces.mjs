// Generates traces/<id>.<variant>.json deterministically (run: node tools/gen-traces.mjs).
// Every trace starts with a 500 ms hold (first input at T >= 500 ms); step inputs and holds are multiples of 100 ms so
// both rates see the same input in ms on the 100 ms common grid (design section 7). A wheel event costs one frame in hx.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jumps = (ys, hold) => ys.flatMap(y => [{ scrollTo: y }, { hold }]);
const sweep = (from, to, px, tail) => [{ scrollTo: from }, { hold: 100 }, { denseSweep: { from, to, px, framesPerPos: 1 } }, { hold: tail }];
const wheel = (dy, n = 1) => ({ wheel: { dy, n } });

const d2 = C.M02.defaults, r2 = C.M02.range(d2);
const d3 = C.M03.defaults, e3 = C.M03.enterRange(d3), x3 = C.M03.exitRange(d3);
const g4 = C.M04.geom(C.M04.defaults);
const T = {
  m01: {
    speed: ['Fast dense sweep (7 px per frame) up and back; the map is read from every position, nothing is smoothed.', sweep(0, 1000, 7, 300)],
    reversal: ['Jumps with reversals mid-way, short holds.', jumps([500, 250, 700, 150, 900, 40, 620], 300)],
    gap: ['Jumps with idle gaps of 800 ms.', jumps([200, 450, 800, 1000, 60], 800)],
  },
  m02: {
    speed: ['Dense sweep through the map range and back, then a long tail so the smoothing settles.', sweep(700, 1400, 10, 1500)],
    reversal: ['Jumps with reversals before the response has settled.', jumps([1000, 1250, 1100, 1350, 900, 1300], 300).concat([{ hold: 500 }])],
    gap: ['Jump-and-trace: step responses with idle gaps of 800 ms, one past the end of the range, one back below the start; the last gap is 3000 ms so the full-scale step settles even for the slowest alpha at 30 Hz.', jumps([880, 1040, 1200, 1340], 800).concat([{ scrollTo: 780 }, { hold: 3000 }])],
  },
  m03: {
    speed: ['Dense sweeps through the exit range and the enter range, down and up.', [
      { scrollTo: 600 }, { hold: 100 }, { denseSweep: { from: 600, to: 1000, px: 10, framesPerPos: 1 } }, { hold: 600 },
      { scrollTo: 2050 }, { hold: 100 }, { denseSweep: { from: 2050, to: 2470, px: 10, framesPerPos: 1 } }, { hold: 1000 }]],
    reversal: ['Down and up with reversals inside both ranges.', jumps([700, 900, 750, 1000, 2200, 2050, 2350, 2150, 1000], 300).concat([{ hold: 300 }])],
    gap: ['Step responses with idle gaps through both ranges and back.', jumps([800, 1100, 2250, 2500, 2000, 700], 700)],
  },
  m04: {
    speed: ['Dense sweep over the whole pinned range and back (crosses every hysteresis edge in both directions).', sweep(380, 2450, 10, 1000)],
    reversal: ['Jumps through the tab range with reversals around the hysteresis edges.', jumps([1500, 1700, 1850, 1700, 1500, 1900, 2150, 1950, 2300, 2200], 200).concat([{ hold: 600 }])],
    gap: ['Step responses with idle gaps through the scrub range, the tab range, past the pin and back to the top.', jumps([650, 1000, 1400, 1800, 2200, 2500, 300], 600)],
  },
  m05: {
    plain: ['Scroll to the latch zone, one wheel down, wait for the tween, one wheel up, wait; then a wheel outside the latch zone (armed, not latched) that the page lets through.', [
      { scrollTo: 3100 }, { hold: 500 }, wheel(120), { hold: 900 }, wheel(-120), { hold: 900 }, { scrollTo: 1000 }, { hold: 300 }, wheel(120), { hold: 300 }]],
    retarget: ['Wheel down, the opposite wheel 200 ms later (retarget from the current value), down again, then a wheel at rest that the page lets through.', [
      { scrollTo: 3100 }, { hold: 500 }, wheel(120), { hold: 200 }, wheel(-120), { hold: 800 }, wheel(120), { hold: 800 }, wheel(120), { hold: 300 }]],
    burst: ['Same-direction wheels while a tween runs (swallowed, no restart), then opposite wheels in quick succession.', [
      { scrollTo: 3100 }, { hold: 500 }, wheel(120), { hold: 100 }, wheel(120), { hold: 100 }, wheel(-120), { hold: 100 }, wheel(120), { hold: 1200 }, { scrollTo: 100 }, { hold: 300 }, wheel(120), { hold: 300 }]],
  },
  m09: null, m09b: null,
};
const wheelTraces = {
  speed: ['Six wheel events on consecutive frames, then idle.', [{ hold: 500 }, wheel(60, 6), { hold: 1800 }].slice(1)],
  reversal: ['Two deltas down, a larger one up before the first has settled, then a wheel up that overshoots the top (target clamps to 0) and one more at the top.', [wheel(160), { hold: 300 }, wheel(160), { hold: 200 }, wheel(-200), { hold: 1800 }, wheel(-400), { hold: 1500 }, wheel(-100), { hold: 300 }]],
  gap: ['Three deltas with gaps, then idle.', [wheel(120), { hold: 300 }, wheel(120), { hold: 300 }, wheel(120), { hold: 1800 }]],
};
T.m09 = wheelTraces; T.m09b = wheelTraces;

/** { 'm02.gap.json': text, ... } */
export function buildTraces() {
  const out = {};
  for (const [route, variants] of Object.entries(T)) {
    for (const [variant, [note, actions]] of Object.entries(variants)) {
      const doc = { schema: 'reva.labtrace/0', route, variant, note, actions: [{ hold: 500 }, ...actions] };
      out[`${route}.${variant}.json`] = JSON.stringify(doc, null, 1) + '\n';
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(root, 'traces'), { recursive: true });
  for (const [name, text] of Object.entries(buildTraces())) fs.writeFileSync(path.join(root, 'traces', name), text);
  console.log('ranges', JSON.stringify({ m02: r2, m03: { e3, x3 }, m04: g4 }));
}
