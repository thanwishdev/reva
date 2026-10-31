# Scroll specimens (M3, part "specimens-scroll")

Content-free, seekable pages that rebuild the **scroll-linked, wheel-, pointer- and trigger-driven** mechanisms of motion records.
A specimen is not a copy of a site: it holds boxes, a tall empty document and the numbers of one record (PLAN H4: timing grammar,
never a showpiece). Folders: code in `src/specimens/scroll/`, generated lab specimens in `specimens/scroll/`.

| Kind | Mechanism (what the page runs) | Driver | Record input |
|---|---|---|---|
| `scroll-driven` | `x = S(clamp01((scrollY - s0) / (s1 - s0)))` for `S` in linear / smoothstep / smootherstep / ease{In,Out,InOut}{Quad,Cubic,Quart,Quint,Sine,Expo,Circ,Back} / free cubic-bezier, then one smoother: none, per-frame EMA (+ snap), dt-aware damp (`1 - exp(-lambda dt)`), asymmetric EMA (snap on rise = `alphaUp 1`), restarted tween (expo.out, power2/3.out). Channels are affine maps of `x` (custom properties, optionally quantised `toFixed(3/2)`, and rendered `tx ty sx sy opacity`). | scroll offset | scroll map, first-order / asymmetric smoothing, restarted tween |
| `hysteresis` | staircase index with separate up / down edges in px | scroll offset | `staircase-hysteresis`, fitted `hysteresis.bands` |
| pins | `position: sticky` box inside a runway of `end - start + viewport` px | scroll offset | `pin` records, `result.pins` |
| `wheel-smooth` | wheel swallowed, target accumulated, position smoothed (dt-aware damp or per-frame lerp) and written with `scrollTo(round(y))` | wheel | smoothing records with `attribution: wheel` |
| `wheel-latch` | latched section: a wheel tick starts a 0 <-> 1 tween (retarget from current), wheel swallowed, scroll held | wheel + scroll | tween with a `latch` description |
| `inertia` | drag follows the pointer; release velocity over the last 100 ms; `v *= friction` per frame (or `friction^(60 dt)`) | pointer | `friction` records |
| `flip` | First-Last-Invert-Play on a two-state layout, WAAPI (`impl: waapi`) or rAF tween; a second trigger restarts from the current rect | trigger | `declared` `flip` records |
| `view-transition` | `document.startViewTransition` with named groups, per-group duration / timing function | trigger | `declared` `view-transition` records |

Not covered: `animation-timeline: scroll()` declared timelines (lab M11), springs / tweens that are purely time-based (the time-family
specimens), WebGL. Records of those classes land in `spec.skipped` with a reason.

Schema `reva.specimen.scroll/0` (the time specimens use `reva.specimen.time/0`). Inertia overlaps with the time specimens'
`friction` track on purpose: this one starts from the pointer drag and derives the release velocity from the input, the time specimen
starts the coast at the release state.

## Build

```js
import { buildScrollSpecimen, writeSpecimen, simulate, inputFromTake } from './index.js';
const { spec, html } = buildScrollSpecimen(records, { id, docHeight, frameMs, input, source });
writeSpecimen(dir, built, { site: true });   // site-derived input: refuses to write inside the repo (PLAN H2)
scrollSpecimensFromFit(fitResult, opts);     // integration entry: { specs: [{spec, html}], skipped, claimed }
```

`node src/specimens/scroll/build-lab.js [labRoot] [outDir]` regenerates `specimens/scroll/` from the lab truth (deterministic).
`variants.js` makes the scorer's planted defects (`easingSwap`, `rateSwap`, `noMotion`, `dropMechanism`) and the perturbation ladder
(`perturb(spec, i, 'smoothing.alpha', 0.01)`) as runnable specimens.

`records` is any mix of Fixture Lab truth items (`reva.labtruth/0`) and fitted records (`reva.motion/0`, or a whole fit
result with `pins`). Nothing is filled silently (H6): a parameter the record flags unknown is used from its withheld value only as a
**placeholder** (`spec.unknowns[].placeholder`, `spec.placeholders`), every default the builder adds is an `spec.assumptions` entry, every
record without a rebuildable model is in `spec.skipped` with a reason. `spec.channelMap` pairs each source channel
(`"<selector>|<channel>"`) with the specimen channel (`"b0|drv:--v0"`); `compare: false` marks synthetic visual channels that have no source.
Site selectors and names live only in `spec.json`, never in the page's DOM.

## Page contract (what the scorer and the recorder rely on)

* `window.specimen.ready === true` once the initial state is written (`spec.boot.until`). Subjects are `#b0, #b1 ...` (`spec.scene.selectors`).
* **Live** (default): every rAF reads `window.scrollY`, wheel and pointer events arrive through real listeners, so the recorder's own
  input driver (`scrollTo`, CDP wheel, pointer) drives the specimen exactly as it drove the source. Custom properties are written with
  `style.setProperty` (the recorder's `drv:--v*` channels), rendered channels through an inline `transform` / `opacity`.
* `window.specimen.go()` triggers FLIP / view transitions (`eval` it from a scenario after `{mark: 'go'}`);
  `window.specimen.script(input, base)` schedules the pointer events and triggers of an input description at their page times
  (`#auto` in the URL hash does it for `spec.input`).
* **Seek**: `await window.seek(t_ms[, {input}])` puts the page into the state the specimen has at virtual time `t` on the frame grid
  (`spec.frameMs`, or `input.frames`), by deterministic replay of an input description, and returns `{t, k, T, channels, aux, scrollTo, vt}`.
  The page scrolls to the replayed offset (pins!). View-transition animations are paused at `t - start`. `window.specimen.live()` returns to
  live mode. `window.specimen.readDom()` reads the rendered values back from the DOM.
* Input description: `{frames?: [{k, T, sy}], scroll?: [{T, sy}], wheel: [{T, dy}], pointer: [{T, type: down|move|up, x}], triggers: [{T}]}`.
  An event at `T` is handled before the first frame whose time is greater than `T` (hx: an input dispatched at frame k's time lands
  before frame k + 1). `spec.input` is the scenario of the source (`planInput(actions)` mirrors the recorder's action semantics);
  `inputFromTake(take)` builds it from a recorded take, `actionsFromInput(input)` makes recorder actions from the trigger / pointer part.
* The simulator (`simulate(spec, input)`) and the page's `seek` run the same `Replayer` from `core.js` (inlined into the page).

## Verified against

`parity.js` records each lab specimen with the M1 recorder (hx, 120 Hz) and compares the compared channels with the lab's own
`refsim` on the specimen take's frames and inputs: max |difference| 0 to 1e-16 on every driver channel of M01-M05, M09, M09b (rendered
channels within the recorder's read-back floor); FLIP M18 against refsim (interrupted second segment included) and the view-transition
births of M17 against the lab's expectation; inertia M10 against the closed-form stopping distance; the dt-aware damp against its closed form
at 120 and 60 Hz. Rates checked: 120 and 60 Hz `hx` (the recorder of this tree has no 30 Hz / stall regime yet); the `rt` lane is not run here
(attended only). The lab is only read.
