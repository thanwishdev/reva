# libdetect — motion-library detection (M4 part, PLAN §7 P4 "bundle-signature detection only")

Names which motion/scroll/3D libraries a site ships and, when no signature matches, which *family* of mechanism its recorded
behaviour shows. Text in, JSON out; no network, no browser except the optional read-only probe.

```
detectLibraries({ modules, scriptUrls, dom, behaviour, skipped }) -> reva.libdetect/1
librariesSection(result)   -> report-v2 static section {id:'static.motion-libraries', data, markdown}
runProbe(page)             -> dom evidence (own page load, not inside a motion take)
loadModules([paths])       -> {modules, skipped}   files, dirs, source maps (sourcesContent expanded)
node src/libdetect/cli.js <file|dir> ... [--json] [--out <file outside the repo>] [--dom probe.json] [--behaviour b.json]
```

* **Evidence, not verdicts.** Library = `inferred`. Version = `declared` (literal / CDN URL), `measured` (live global) or
  `unknown` with a reason; conflicting literals stay `unknown` with the candidates. `firing` is `observed` only with run-time
  traces (a global, a `_gsap` expando, `html.lenis`); bundle code alone is `unknown` + an `unk_libdetect_firing_*` ledger entry.
* **No absence claims.** `coverage.state` is `partial`/`empty`; `not_detected` lists what was not found, never "absent".
* **Scoring.** Distinct signatures add up: 5 definitive, 4 strong, 3 medium, 2 weak, 1 trace; >=5 detected, 3-4 probable, 1-2 hint.
  Signatures are string literals / property names / class names (what minifiers keep), table in `signatures.js`.
  A plugin that is `detected` implies its host (ScrollTrigger -> GSAP), flagged `implied`.
* **Calibration.** `calibration.state` is `calibrated` only for libraries checked against a real build (GSAP, ScrollTrigger, Lenis,
  Motion, three.js, lottie-web: see `test/libdetect/calibration.test.js`). The rest are `api-literals-only` and say so in the report.
* **Behaviour fallback** (`behaviour.js`): scroll impulse response -> exponential approach (tau, per-frame factor), `linear()`
  easing strings, fitter model names, WebGL draw loop. It yields families with candidates and `can_not_separate`; it can only
  corroborate (+2) a library that already has other evidence, never create one.
* **Site-derived output** (scans of a real site's bundles) goes outside the repo, for example under `~/.reva` (H2); the CLI refuses `--out` in the repo.

## Merge points for the integrator
* Report v2: M3's report builder should call `librariesSection(detectLibraries(...))` and `attachToReport(report, section)`
  (or push the section into its own static list). Report v1 did not exist when this was written.
* CLI: `reva libdetect` -> `main(argv)` from `src/libdetect/cli.js`.
* Freeze/static pipeline: feed `modules` from the archive's JS/CSS/HTML (+ `.map`), `dom` from `runProbe` in the static session,
  `behaviour` from the M2 fitter output / a wheel-impulse scroll take.
