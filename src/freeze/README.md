# src/freeze: the freeze stage (PLAN M4)

> Research module REVA was built with, used on REVA's own fixture pages. It is not a command of the published `reva`
> (whose live reads go through the robots.txt and wall checks in `src/safety`), and it has no such checks of its own.

`freeze(config, {outDir})` records an offline-replayable copy of a target:

1. **record** each viewport class with Playwright `recordHar` (telemetry blocked, `Math.random` seeded, scroll sweep, declared clicks / extra URLs)
2. **sanitise** (`sanitize.js`): drop status -1/0 and blocked entries (trap 2), keep response AND request-body files (trap 3), redact secrets, dedupe
3. **URL completion** (`complete.js`): read the code in the recording, expand URL templates whose holes have a literal domain, list the rest as `unknown` (trap 1)
4. **replay check** (`verify.js`, `misslog.js`): DNS disabled, catch-all route that logs every miss (trap 4); GET misses feed the next round
5. **archive** (`build.js`): sanitised HARs, `files/`, `manifest.json` (provenance per entry), `SHA256SUMS`, `ARCHIVE.SHA256SUMS`, `target.json` for `src/replay`

`check.js` re-verifies an archive (shasum, manifest vs files vs HAR, known-URL list, offline replay). `report.js` is the freeze section of report v2.
A non-local start URL is refused unless `allowLive` / `--allow-live` (an explicit opt-in, with permission to record the site).
Tests: `node --test --test-concurrency=1 src/freeze/test/` (unit tests need no browser). Fixture: `fixtures/freeze-site/`.
