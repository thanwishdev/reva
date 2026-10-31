# Static layer (M4 part "static")

> Research module REVA was built with, used on REVA's own fixture pages. It is not a command of the published `reva`
> (whose live reads go through the robots.txt and wall checks in `src/safety`), and it has no such checks of its own.

Tokens, declared sources, breakpoints, fonts/SVG inventory and accessibility structure of a page, every value tagged
`declared | measured | inferred | unknown` (PLAN H6) with an unknowns ledger. Wraps existing tools; builds only breakpoint
detection (HO d9).

```
node src/static/run.js <url> [--out DIR] [--engine cft|chs] [--no-dembrandt] [--allow-live]
```
`localhost` / `file:` only. Anything else is refused unless `--allow-live` (an explicit opt-in; PLAN M4 stop-and-ask). Output goes
outside the repo (`<out root>/static/<id>`, H2): `static.json` (summary-first record), `series/` (content-addressed element
rows + styles per variant, dembrandt raw JSON), `scripts/` (JS saved byte-exact for `src/libdetect`), `static-section.json`,
`static-report.md`.

## Pieces
| File | Role |
|---|---|
| `extract.js` | one browser session of its own (`src/browser/launch.js`): variants -> settle -> computed styles -> declared layer -> forced states -> fonts -> a11y; then the breakpoint sweep |
| `inpage.js` | functions run inside the page; read-only (the only write is a non-enumerable matchMedia query log) |
| `tokens.js` | pure aggregation: typography (incl. letter-spacing, line-height), spacing, colours, shadows, radii, layout boxes |
| `cdpcss.js` | declared layer through the CDP CSS domain: cascade winner per property with file:line, media queries of all sheets (cross-origin included), forced `:hover`/`:focus`, platform fonts; consistency check so a wrong declared value is never reported |
| `breakpoints.js` | width sweep + layout signature + binary search; `explainEdges` matches every measured edge to a declared query / hooked `matchMedia()` call or lists it `unknown` |
| `dembrandt.js` | dembrandt 0.39.2 subprocess in its OWN browser session (CDP to our throwaway CfT, `--no-headed-fallback`); output = hints (`inferred`, `hint:true`) |
| `report.js` | report section + `mergeStaticSection(reportV1, section)` = the merge point for M3 (report v1 does not exist yet) |
| `prov.js`, `color.js`, `shadow.js`, `props.js` | provenance vocabulary + ledger, colour parsing (oklch/oklab/rgb), shadow parsing, property lists |

## Design choices (for docs/DECISIONS.md)
- **Declared = the engine's own CSS model, not a regex.** Winning declarations come from CDP `CSS.getMatchedStylesForNode`
  (cascade order, `!important`, inline style, inherited properties only), media queries from `CSS.getMediaQueries`
  (reads cross-origin sheets, which the CSSOM cannot), and the width edge of every query is evaluated by the engine itself:
  a hidden iframe is resized one pixel at a time and `matchMedia(query).matches` is read, so range syntax
  (`width <= 480px`), `em` units, `and/or/not` need no parser of ours.
- **Computed value = measured, declaration text = declared, derived numbers = inferred.** A declared source is attached
  only after `checkConsistency` agrees with the computed value; `inconsistent` drops it (ledger `unk_declared_inconsistent`),
  `unchecked` keeps it with `verified:false` and a note. `letter-spacing: normal` stays the string `normal`
  (the em value 0 is `inferred`); `line-height: normal` is `inferred` from the box of a text-only block or `unknown`.
- **Settling without touching styles:** `document.fonts.ready`, then `finish()` of finite and `cancel()` of infinite
  CSS animations/transitions (a transition read mid-flight would report an interpolated value), then two frames.
  No stylesheet is injected (dembrandt does inject one, hence its own session).
- **Breakpoints:** coarse sweep (step 40 px, 320-1920) plus probes at t-1, t, t+1 of every declared edge, signature =
  hash of discrete computed properties of every element (+ grid track count, wrap flags). Cells that change in >= 3
  consecutive steps are *fluid* and masked (and `height` of elements whose `width` is fluid, which is text wrapping);
  edges where only wrap flags change are tagged `reflow` (`inferred`). Binary search finds the exact pixel; a third state
  inside an interval is handled. Limits (ledger): fluid-only breakpoints and states that revert inside one step are
  invisible; JS gates that only read `innerWidth` come out `unknown` (the matchMedia hook catches the other kind).
- **Variants:** desktop 1440, tablet 920, mobile 390 (touch emulation -> `pointer: coarse`), dark and reduced-motion
  at 1440 (tokens + document height + a11y hash only). Forced `:hover`/`:focus` on up to 40 interactive elements, desktop only.
- **Safety:** non-local requests are aborted by a route guard registered before anything else and counted
  (`environment.blockedExternalRequests`); `offlineReplay` + `prepare(context)` lets the freeze/replay harness install its
  HAR routes after the guard, so an archive miss is aborted and counted instead of reaching the network.

## Integrator notes
- `reva static` -> `import { main } from './static/index.js'`.
- `npm test` glob is `test/**/*.test.js`; these tests live in `src/static/__tests__/` (run
  `node --test --test-concurrency=1 "src/static/__tests__/*.test.js"`) - add that path to the glob or add a shim in `test/`.
- Report v2: `mergeStaticSection(reportV1, buildStaticSection(record))` once M3's report object exists.
- Motion-library detection (P4) is `src/libdetect`; this layer hands it `scripts/`.
- Static run on the ARCH archive: call `extractStatic({ url, offlineReplay: true, prepare: ctx => ctx.routeFromHAR(...),
  launchArgs: ['--host-resolver-rules=...'] })` (not done here: ARCH replay belongs to the freeze part).
