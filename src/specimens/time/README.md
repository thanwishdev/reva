# Time specimens (M3, part "specimens-time")

Content-free, seekable rebuilds of **time-based mechanisms** (CSS / WAAPI easing, springs with their integrator, stagger,
loops, inertia, retargeted tweens), generated from fit records (`reva.motion/0`) or from Fixture Lab truth
(`reva.labtruth/0`). A specimen is one self-contained HTML page: neutral boxes, no text, no network, no `Date.now`,
no timers, no random (beatapi / HyperFrames discipline, PLAN M3).

```
node src/specimens/time/gen.js lab                              # the committed lab set -> specimens/time/<id>/{index.html,spec.json} + manifest.json
node src/specimens/time/gen.js fit <fit.json> --out <dir> [--id p] [--impl js|auto] [--birth identity] [--ranges '{"ren:tx":{"from":0,"to":300}}']
                                                                # site-derived: <dir> must be outside the repo (PLAN H2); the writer refuses otherwise
node --test --test-concurrency=1 "src/specimens/time/test/*.test.js"
```

## The page contract (`reva.specimen/0`)

| | |
|---|---|
| `window.seek(t)` | `t` in ms on the specimen timeline (0 = the anchor frame). Synchronous, deterministic, a pure function of `(spec, t, frameMs)`: stops live play, writes every track, returns `{t, values}`. Order and repetition do not matter. |
| `window.__specimen` | `{schema, id, durationMs, frameMs, tracks, spec, play(), pause(), seek, values(t, {frameMs}), series(trackId, times)}`. `values()` / `series()` do not touch the DOM; `series` advances a spring / friction over an explicit frame list (stalls included). |
| live play | starts on the `go` window event (the recorder's post-boot signal, as the lab pages) or at once with `#auto`. The first animation frame after the start is the anchor (`t = 0`); later frames use their real timestamps, so a spring integrates the same dt the page saw. |
| `#t=<ms>` / `#frame=<ms>` | render that state at load / override the nominal seek grid (default the spec's `frameMs`, 1000/120). |

Seek of a **discrete spring or friction** (frame-based, state depends on the frames it was advanced over) integrates over the nominal grid
`k * frameMs` and finishes with one remainder step to `t`. Live play and `series()` use the real frame times.

## Spec (`spec.json`, `reva.specimen.time/0`)

`{schema, id, origin: lab|site, source, timeline: {frameMs, refreshHz, leadMs, sourceShiftMs, durationMs, hasLoop}, viewport, elements, tracks, notes, digest}`.

* **Time:** spec time = source time + `sourceShiftMs` (a whole number of frames, so the frame phase of discrete integrators is kept); the first onset lands near `leadMs` (500 ms).
* **Tracks:** `{id, el, channel: tx|ty|rz|sx|sy|opacity|w|h|var, name?, mapTo?, impl: js|waapi|css, motion, provenance, assumptions?, label}`.
  A `var` track writes a custom property (`drv:--x` in the recorder) that a stylesheet rule maps to `mapTo` (default `tx`, flagged as an assumption).
* **Motions** (`kernel.js`): `tween`, `chain` (retargeted tweens), `keyframes` (CSS/WAAPI semantics, loops, SMIL sawtooth), `spring`
  (integrators `i6` analytic, `i1` substep h ms, `i4` frame-unit native kf/cf, `i5` RK4, `i7` capped Euler, `verlet`), `friction`
  (per-frame or dt-aware law), `step`, `ticks`. A declared tween / keyframes motion may carry `birthMs` + `base`: the animation does not exist before its birth (the element shows its identity value). This is set only where the identity is evidenced (a FLIP record) or when asked (`--birth identity` / `opts.birth`); otherwise the animation fills backwards from t = 0.
* **Engines:** `impl: waapi|css` hands a declared motion to the browser (`Element.animate`, `@keyframes`), `seek` pauses it at `t - birth`;
  `js` is the kernel writing inline styles. Transform channels of one element concatenate (`composite: add`) only inside one engine; mixed engines get their own box.

## Provenance (PLAN H6)

Nothing is filled silently. A value that is not in the input is listed in the track's `assumptions` with the reason (range, start position,
variable mapping, bounding-box channels, an unidentified integrator, reproduction-only springs). Records that cannot become a specimen
are returned in `skipped` with the reason (no model, scroll/document-driven, unsupported channel) and written to `manifest.json`.
`tier: unknown` springs are rebuilt only when the fitter marked them `valid_for_reproduction_only` (withheld analytic omega, zeta); they carry
`provenance.reproductionOnly`.

## Fit-record mismatches found while building this (read-only observations of M2)

1. Settled tween / ramp records carry no `from` / `to` (only t0, D, ease). The amplitude is recovered from `derived.peakVelocity` and the ease
   (`inferred`, listed under `assumptions`), else the specimen is normalised 0..1 (`unknown`). Recommendation: always emit `from` / `to` as `fitted`.
2. Friction records carry `v0` but not the start position x0 (assumed 0, listed). Spring `ren:` records next to a `drv:` record are redundant and dropped.
3. SMIL records carry no from/to (normalised 0..1). Bounding-box channels (`ren:bx|by|bw|bh`) have no base geometry in the record: they are
   reproduced by `tx|ty|w|h` (shape only) and dropped when the transform channels of the same element carry the same motion.
4. Declared WAAPI keyframes of a FLIP have `offset: null` (computed keyframes): treated as evenly spaced. `declared.kind` can be `flip`.
5. Lab truth is not in the fit-record format (`cells[].regimes[R].items` for springs, flat `items` for the easing group); `normalize.js`
   adapts both to the same mechanisms.

## Verification

Verify loop (src/verify/, 15 Oct): every committed time specimen recorded next to its lab source with one recorder and scored: 45/45 pass
(provisional), spring replay NRMSE_t <= 1.7e-12. It found one kernel bug: a chain part that starts exactly on a frame showed one frame
late (`chainAt` had no 1e-6 ms grid tolerance); fixed and the set regenerated.


`test/` holds 40+ tests: kernel == the lab's independent simulators (every integrator, three parameter sets, regular and stalled frames),
== the fitter's `simulate()`; truth t10/t50/t90/t99 reproduced (164 fractions); seek DOM == kernel on every lab specimen (shuffled and
repeated); the hx recorder's live recording of the specimens == kernel and == the lab's `refsim` (NRMSE <= 3e-9 vs the registered 0.005);
synthetic loops (css, waapi, js), ticks, stagger, chain, births. The lab/fitter references are READ-ONLY (`REVA_LAB_ROOT` or the main tree) and the tests skip when they are absent.
