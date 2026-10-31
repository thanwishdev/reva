# Fixture Lab, group A: lab-easing

Own fixture pages with known truth for declared and time-based motion: CSS and WAAPI easing, keyframe holds, scroll
timelines, stagger, count-up and typing, SMIL, view transitions, FLIP, rAF tweens with a sub-frame onset, and two
negatives for "not a spring". Design: `docs/design/M2-fitter.md` section 11; thresholds: `docs/DECISIONS.md`
D-M2-2 (G1-4 section 8 + Amendment 1). Every parameter is this lab's own; no value from a captured site is used
(`test/core.test.js` checks this against a private list of banned values when `REVA_BANNED_VALUES` is set).

Public-safe: nothing here comes from a real site (H2). The pages never see the truth.

## Routes

| Id | Mechanism | Driver | Traces | Truth class |
|---|---|---|---|---|
| m06 | `@property` number animated by keyframes with a flat segment (hold), per-segment bezier, six elements 12 + 30 i ms apart; grid cell 5 is the no-hold control | one-shot trigger, then time | go | declared (css) |
| m11 | CSS `view()` timeline element and a WAAPI `ViewTimeline` twin, same range and easing | scroll | sweep, reversal, gap | declared (css, waapi), scroll map |
| m12 | six CSS animations with delays from a custom property (orders dom, reverse, column), rAF count-up (easeOutCubic), typing counter, all started by an IntersectionObserver | scroll, then time | go | declared (css), tween, ramp |
| m15 | SMIL `<animate>` on `cx`, started by `beginElement()` after a delay (optionally `calcMode=spline`) | one-shot trigger, then time | go | declared (smil), observable as periodic |
| m17 | same-document view transition, two named groups (one resizes), root left out | one-shot trigger | go | declared (view-transition) |
| m18 | FLIP of one box (move + resize): WAAPI and rAF variants; a second call mid-flight restarts from the current state | one-shot trigger | single, interrupted | declared (flip) / tween |
| m19 | rAF tween, named ease: started by a timer whose due time is off the frame grid, by a click, or retargeted from the current value | timer, click | timer, click, retarget | tween (named) |
| m16e | negative: long ease-out tween (expo, quint, quart, cubic) | one-shot trigger | go | tween, not a spring |
| m16f | negative: back-out bezier with 5.5 to 11.5 percent overshoot | one-shot trigger | go | tween, not a spring |

Cells (route x 5 parameter vectors x traces) = 70, as registered in D-M2-2 A1.4. `routes.json` lists pages, drivers,
watch lists, parameter grids (full objects), confirmation boxes (`box`), traces, regimes and metric ids.
It is generated: `node tools/gen-traces.mjs` (also writes `traces/`); `node tools/gen-truth.mjs` writes `truth/` for review.

## Files

- `core.js` pure math shared by pages and refsim (easing, tween step, quantisation `write`, stagger order, geometry, defaults, grids).
- `pagekit.js` DOM helpers for pages only. `routes/<id>.html|js` the pages (parameters from `#p=<base64url JSON>`).
- `refsim.mjs` `simulate(routeId, params, ctx)`: the values the page writes and the values a browser renders, per frame of an
  actual or planned take, plus declared events. `ctx` = `{frames: [{k, T, sy, sx}], inputs, marks, variant}`; `marks` and
  `variant` are extra to the design's `{frames, inputs, viewport}` (see "Semantics" below).
- `truth.mjs` `truth(routeId, params, regime, {trace | ctx, variant})` -> `reva.labtruth/0` (items, attribution,
  stagger, metrics), `planCtx` (a trace played symbolically on a regime's frame grid), `REGIMES`, `frameT`.
- `traces/<id>.<variant>.json` recorder scenarios (`boot`, `actions`); `routes.json`; `truth/` (generated sample).
- `tools/` server and recording harness (`harness.mjs`), parity (`parity.mjs`, `parity-cli.mjs`, `sweep-parity.mjs`),
  generators, `solve-overshoot.mjs`. `test/` core, truth, blind, parity (browser) tests.

## Semantics that refsim reproduces (checked by `test/parity.test.js`)

- A trigger is a recorder mark followed by an `eval` (or a `scrollTo`): a real task after frame k at virtual time T_k.
  The mark's `k`/`T` are the exact trigger instant, so refsim needs `ctx.marks` (and the `scrollTo` entries of `inputLog`).
- A CSS/WAAPI animation created in such a task starts at T_(k+1); one created in a timer (due d) starts at the first frame
  T >= d; an rAF tween started in a timer has `t0 = d` exactly (a sub-frame onset of 0 to one frame); started in a real task
  it has `t0 = T_k` and its first value lands in frame k+1.
- Scroll and view timelines are not born (the recorder pins document-timeline animations only); their value is a function of
  `scrollY`. The declared layer reads them through the `snapshot` action at the start of every trace.
- View transition (measured on the recorder): the update callback runs in the real frame of step k+1 (the live element is in
  the new layout in row k+1), the pseudo-element animations are born at T_(k+2). They run on pseudo-elements, which the
  channel sampler does not read, so the evidence is the declared layer (ten animations for two groups: group, fade-in,
  fade-out and two plus-lighter each).
- SMIL has its own clock, which `hx` cannot step. The m15 page pauses the SMIL timeline and sets its current time from
  `performance.now()` on every frame, and sets it again right before `beginElement()`, so begin = the timer's due time.
  A real SMIL page recorded under `hx` runs on real time (measured: an un-shimmed `<animate>` advanced about 16.7 ms of animation time per 8.333 ms virtual frame at 120 Hz, and its samples are not repeatable).
- Tolerance: `max |rendered - refsim| <= max(2 x floor, 1e-9)`; floors from the take's planted-value measurement (translateX
  5.2e-4 px, scale 5.0e-6, rotate 3.3e-5 deg, opacity 5.0e-7), bounding boxes 1/64 px, registered number property 5e-7
  (measured, `registered-number-floor.json`), driver channels (custom properties as written) exact.

## Run

```
node --test --test-concurrency=1 "fixtures/lab/lab-easing/test/*.test.js"   # everything (the parity test records about 40 takes)
node fixtures/lab/lab-easing/tools/parity-cli.mjs m19 120 timer
node fixtures/lab/lab-easing/tools/sweep-parity.mjs 120,60 all 5   # every grid cell, reports to the private out root
```

Reports: `~/.reva/out/m2/parity/lab-easing/`.
