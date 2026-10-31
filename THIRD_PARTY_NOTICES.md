# Third-party notices

REVA is licensed `MIT OR Apache-2.0` (PLAN H3). This file lists third-party code that is **vendored (copied) into
this repository**, with its licence and upstream, and the separate dependencies the project installs.

## Vendored code

Each entry records upstream, version, licence, files and where the licence text lives.

| Component | Upstream | Licence | Files in this repository | Licence text |
|---|---|---|---|---|
| understudy 0.3.0 (`@amabush/understudy`) | https://github.com/Amir-Abushanab/understudy | MIT, Copyright (c) 2026 understudy contributors | `src/analysis/fit/vendor/understudy/{optimize,bezier,spring,cluster}.js`, ported from `src/analyze/*.ts` (TypeScript types removed; the upstream path and sha256 are recorded in each file header; local changes marked `REVA:`) | `src/analysis/fit/vendor/understudy/LICENSE` |
| simplify-js 1.2.4 | https://github.com/mourner/simplify-js (npm `simplify-js@1.2.4`) | BSD-2-Clause, Copyright (c) 2017 Vladimir Agafonkin | `src/analysis/fit/vendor/simplify-js/simplify.js` | `src/analysis/fit/vendor/simplify-js/LICENSE` |
| Lenis 1.3.26 | https://github.com/darkroomengineering/lenis (npm `lenis@1.3.26`, tarball sha256 f8930e6b3e26a88f7ccd9ec45f1a11c85d2118cd14673b304204d59e49a68415, npm shasum 2262e4fa3de7b7085aea82a64e204b234711d24d) | MIT, Copyright (c) 2024 darkroom.engineering | `fixtures/lab/lab-scroll/vendor/lenis.mjs` = `dist/lenis.mjs`, unmodified (own fixture page M09 only; never shipped as REVA code) | `fixtures/lab/lab-scroll/vendor/LICENSE-lenis` |

Not vendored (decided in D-M2-1): Motion `cubic-bezier.ts` and bezier-easing (our own `src/analysis/oracles.js` is
used); gabros20 `rec.js` (the M1 recorder is an own rewrite).

## Separate dependencies (installed, not copied)

| Package | Version | Licence | Use |
|---|---|---|---|
| playwright-core | 1.60.0 (exact pin) | Apache-2.0 | browser automation library; launched only with explicit Chrome for Testing / headless-shell paths |
| pixelmatch | 8.0.0 (exact pin) | ISC | pixel check of the design-capture gate (`src/gate/pixels.js`, threshold 0.03, anti-aliased pixels counted) |
| pngjs | 7.0.0 (exact pin) | MIT | PNG decode/encode for the gate's pixel check and heatmaps |
| style-dictionary | 5.5.5 (exact pin, **devDependency**: tests only, never imported by `src/`) | Apache-2.0 | independent DTCG reader for the D4 token round trip (`test/design/sd-roundtrip.js`: DTCG -> CSS custom properties compared with the captured values). Its 108 transitive dev packages: MIT 69, Apache-2.0 26, BSD-3-Clause 3, BlueOak-1.0.0 5 (glob, lru-cache, minimatch, minipass, path-scurry: permissive, OSI-approved), ISC 2, 0BSD 1 (tslib) |
| dembrandt | 0.39.2 | MIT | optional static-layer hints (M4), run as a separate subprocess from `<data root>/tools/dembrandt/` (default `~/.reva/tools/dembrandt/`, or `REVA_DEMBRANDT`), attached over CDP to our own launched test browser; not installed by `npm install` and not copied |

Browsers (Chrome for Testing 147.0.7727.57, chrome-headless-shell) are downloaded by `reva doctor --install` from the
Chrome for Testing public bucket into `~/.reva/browsers/` (sha256-checked), outside this repository, and are not redistributed.
