# specimens/time

Generated, content-free, seekable specimens of the Fixture Lab's time-based mechanisms (own parameters, no site material).
Regenerate with `node src/specimens/time/gen.js lab`; `manifest.json` lists every specimen (route, tracks, engines, kinds, digest) and every
lab item that did **not** become a specimen, with the reason. The test suite fails if these files are stale.

Each `<id>/` holds `index.html` (self-contained page, `window.seek(t)`, see `src/specimens/time/README.md`) and `spec.json`.
Ids: `<route>-<integrator|law|zeta>-<trace>` for springs and inertia (`m07-i1h16-p1000`, `m08-z0.42-v0`, `m10-dt-fast`), `<route>-<variant>`
for the easing group (`m19-retarget`, `m18-single`, `m06-go`).

| route | mechanism | engine |
|---|---|---|
| m06 | six staggered CSS keyframe animations with a hold (declared start 12 + 30 i ms) | css |
| m07, m07x | timer-retargeted spring, integrators i1(16 / 2 / 1 ms), i4, i5, i6, i7 (+ out-of-set verlet, i1(5 ms)) | js |
| m08 | analytic spring, zeta in {0.25, 0.42, 0.6, 1, 1.5}, rest / retarget / initial velocity | js |
| m10 | inertia coast, per-frame and dt-aware friction | js |
| m12 | stagger (CSS), rAF count-up, quantised typing ramp | css, js |
| m15 | SMIL-style sawtooth loop | js |
| m16e, m16f | ease-out and back-out bezier tweens (negatives for "spring") | js |
| m18 | FLIP, WAAPI single (four transform channels on one box) and interrupted (chain) | waapi, js |
| m19 | rAF tween with sub-frame onset: timer, click, retarget-from-current (chain) | js |

Not covered here (listed in the manifest): m11 (scroll-driven view timeline) and m17 (View Transitions) belong to other parts; the
pointer-driven drag leg of m10 is not a time motion.

The lab set is made from the lab's **truth**, so the specimens are the lab pages' mechanisms rebuilt from known parameters: the scorer can
record them with the same recorder, lane and rate as the lab takes and compare. Specimens built from a site's fit records are site-derived
and never go into this folder (they go to REVA's data root, `~/.reva` by default).
