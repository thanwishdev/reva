// Generates traces/<route>.<variant>.json (recorder scenario action lists, design §11). Run: node tools/gen-traces.mjs
// Pointer x stays below 1000 px: Chrome serialises a computed matrix to 6 significant digits, so a translate of
// 1000 px or more would be rendered 10x coarser than the read-back floor the recorder measures (D3, range 1000).
// Rules: every trace starts with the start signal ("go", which also stamps a mark so refsim knows the page's time
// origin) and a 400 ms hold, so the first input lands at T >= 400 ms after the page started. All holds are multiples
// of 100 ms (frame boundaries of 120, 60 and 30 Hz coincide on that grid). Pointer inputs are scenario `eval`
// dispatches until the recorder gets S.pointer (X3); each is followed by a mark `ptr:<x>,<y>` so the frame and time
// of the input are known (refsim reads them back).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'traces');
const VIEWPORT = { width: 1280, height: 800 };
const go = () => [{ eval: "window.dispatchEvent(new Event('go'))" }, { mark: 'go' }, { hold: 400 }];
const ptr = (x, y) => [{ eval: `window.dispatchEvent(new PointerEvent('pointermove', { clientX: ${x}, clientY: ${y} }))` }, { mark: `ptr:${x},${y}` }];
const sc = (y) => [{ scrollTo: y }];
const hold = (ms) => [{ hold: ms }];
const seq = (...parts) => parts.flat();

const T = {
  m13: {
    steps: seq(go(), ptr(900, 120), hold(2400), ptr(200, 600), hold(2400)),
    reversal: seq(go(), ptr(960, 700), hold(500), ptr(300, 100), hold(400), ptr(800, 500), hold(2400)),
    gaps: seq(go(), ptr(600, 200), hold(2400), ptr(950, 650), hold(800), ptr(150, 400), hold(1600)),
  },
  m14: {
    steps: seq(go(), sc(800), hold(2600), sc(200), hold(2600)),
    reversal: seq(go(), sc(900), hold(1000), sc(100), hold(2600)),
    gaps: seq(go(), sc(600), hold(2600), sc(1000), hold(800), sc(500), hold(2200)),
  },
  m14b: { steps: seq(go(), sc(800), hold(2600), sc(200), hold(2600)) },
  m16a: { steps: seq(go(), sc(600), hold(1200), sc(0), hold(1200)) },
  m16b: { steps: seq(go(), sc(600), hold(1200), sc(0), hold(1200)) },
  m16c: { steps: seq(go(), sc(400), hold(2400), sc(0), hold(2400)) },
  m16d: { steps: seq(go(), sc(400), hold(800), sc(0), hold(800)) },
  m20: {
    steps: seq(go(), sc(900), hold(800), sc(0), hold(1200), sc(1000), hold(900), sc(300), hold(1800)),
    holds: seq(go(), sc(900), hold(3300), sc(0), hold(3300)),
    idle: seq(go(), hold(3300)),
  },
  m21: {
    // two completed tweens of different amplitude per trace: a restarted expo.out and a dt-damp with a snap ε are the
    // same curve except for the completion, which an expo.out reaches at L whatever the amplitude while an ε snap
    // fires at L·log2(A/ε)/10; equal amplitudes (the first traces: 600 → 0) cannot separate them (D-M2-9)
    steps: seq(go(), sc(600), hold(2000), sc(500), hold(2000)),
    reversal: seq(go(), sc(600), hold(300), sc(200), hold(2000), sc(260), hold(2000)),
  },
  m22: {
    steps: seq(go(), sc(700), hold(2800), sc(0), hold(2800)),
    reversal: seq(go(), sc(700), hold(500), sc(100), hold(400), sc(600), hold(2800)),
  },
};

fs.mkdirSync(dir, { recursive: true });
let n = 0;
for (const [route, variants] of Object.entries(T)) {
  for (const [variant, actions] of Object.entries(variants)) {
    fs.writeFileSync(path.join(dir, `${route}.${variant}.json`), JSON.stringify({ route, variant, viewport: VIEWPORT, boot: {}, actions }, null, 1) + '\n');
    n++;
  }
}
console.log(`wrote ${n} traces to ${dir}`);
