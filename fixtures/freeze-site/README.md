# freeze-site: own fixture for the freeze command

Public-safe, nothing taken from a real site. `node fixtures/freeze-site/server.js [port]` serves it by hand;
the tests start it on a random port. Two virtual hosts share one port: `site.fixture.test` and `telemetry.fixture.test`.
They resolve only through the recording-time Chromium host rule `MAP *.fixture.test 127.0.0.1` (`config.js`);
replay runs with every name unresolvable and with the server stopped.

| Trap (SYN §7.4) | Where | What it does to a naive freeze |
|---|---|---|
| 1 JS-built URLs | `public/app.js`: `imgUrl(slug, w)`, `heroUrl(k)`, `loadTab(id)`, CSS `url()` in `style.css` | a load + scroll never requests `*-320`/`*-960` both, `hero-night`, `tab-b/c`; a later replay that clicks a tab misses |
| 2 blocked telemetry | `telemetry.fixture.test` script, image, POST | recorded as status -1, a naive replay stalls and `load` never fires |
| 3 a POST body | `POST /api/consent` answers only to the exact body | a sanitiser that drops `postData._file` turns it into a miss |
| 4 silent misses | `/api/flags.json` fetched after 1.2 s, every failure swallowed | a missing entry leaves no visible error; only the catch-all logs it |

`known-urls.json` is the planted truth for the code-derived URL check (every URL the code can build, with the status the
server answers; `omega-960` is a planted 404). `templateUnknown` lists the templates a static pass must not guess.
