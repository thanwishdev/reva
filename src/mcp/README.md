# src/mcp: one contract for the CLI and the MCP server

`contract.js` holds every tool; `reva.js` the **public** REVA v1 surface; `server.js` serves the public surface over MCP (stdio,
hand-written JSON-RPC, no SDK dependency, D-M3-mcp-1); `cli.js` derives CLI flags from the same input schemas.
`runTool(name, args, ctx)` is the only execution path, so validation, guards and result shape are identical on both faces.

## Public surface (REVA v1, listed by `reva mcp`)
Flow: `look` -> `motions` / `design` -> `code` / `curve` / `card` / `unknowns` (the old names analyze / export / series / specimen are hidden aliases: callable, not listed) (11 tools: the 7 of plan item 1.4 + `design`, `compare`, `scan_moves`, `scan_move`; the contract test checks the list).

| tool | what | heavy |
|---|---|---|
| look | `url` / `archive` / `fixture` + `target` (auto or selector) + `interaction` (load, hover, click, scroll) + `depth` (+ optional `color_scheme` light / dark, default light; `compare` takes it too) -> analysis id (also in `summary.stats.analysis`), headline, top motions. Runs `look` (record + fit + export). Top rows are compact (at most 3 lines and 8 channel ids each, with `lines_more` / `channels_more`) and paged to fit the inline cap, so a 40-element group never turns `data` into a truncated marker. A bare `archive` name is a target id, looked up only in REVA's target folders under the data root (`<targets>/<id>.json` and the archive store's target folder), never as a path in the server's working directory. | yes |
| motions | pages the motions of an analysis: plain lines, params with exact / fitted / unknown labels (a tween's `from` / `to` and a spring's `x0` / `target` always appear: the fitted or declared value, else the recorded value at the motion's start / end with its source, else unknown with the reason), derived t50 / settle99 / overshoot / peak velocity, default match (react-spring / Motion presets, named eases, CSS keywords, Lenis lerp). Filters: element, class, channel, confidence. | |
| design | analysis + `section` (overview, fonts, type, palette, contrast, spacing, radii, shadows, layout, breakpoints, states, custom_properties) + `offset` / `limit` -> how the page is designed, from the design pass analyze runs after the take (`design: false` skips it, src/design): every value with unit and label exact / measured / derived; font names, CSS texts, custom properties and media queries as untrusted_content. `export` with motion id `design` gives the design tokens: stack `css` (CSS custom properties, our names, numbers and hex only, no font names) or `tokens` (W3C design-tokens JSON); both files are written to `<out root>/export` | no |
| code | motion ids + stack (css, gsap, motion, lenis, raf, react-spring) -> code from the export module, computed at call time from the record with the recorded start / end values put in where the fit has none, with a fidelity word (as declared, matches fit, approx, unknown model). Snippets carry both ends (css: start state + `.to` end state; gsap `fromTo`; Motion `[from, to]`; react-spring `from` / `to`); a snippet with a value hole or a channel that names no property of the stack is listed in `missing`, never shipped. The code's source comment is rebuilt from our ids: no page text in code. | |
| curve | recorded samples and the fitted curve at the same times, LTTB-downsampled to <= 300 points, with the rebuild's rms next to the fitter's. | |
| card | analysis + motion ids (default: all) -> the motion card (src/card) for just those motions, written to `<out root>/specimen/<analysis>_<hash>.html`: each law replayed on a plain box (fitted vs recorded, scrub, 0.25×, replay), curve, values, code tabs; per law what plays (fitted + recorded / fitted / recorded / none, with why). Content-free: elements are named by their motion id, the source by its origin; descriptors, selectors, URL path, warnings and the page text in code comments are left out. | |
| unknowns | the ledger of an analysis (or of a report / fit result): reason + probe per row, elements left out of the ranking included. | |
| doctor | install check (test browser launch / close, offline flags). | yes |
| compare | two pages (`a` / `b`: a URL, an archive or a fixture) looked at the same way (one browser at a time), motions paired and compared value by value: same / close / different. | yes |
| scan_moves | a finished `reva scan` folder (under the data roots or `REVA_MCP_ROOTS`): the site in brief, how it moves, what the ledger could not read, one short row per move; paged. | no |
| scan_move | one move of a scan folder in full, in parts that page with `offset` / `next_offset`: `groups`, `code` (CSS, GSAP, Motion), `webgl` (clocks, passes, program values, shader sources as untrusted_content, read from the local scan folder only when asked, program switches, canvases, geometry) and `prompt` (points to shader sources in the move file, never carries them). | no |

Ids: an analysis is its folder under `<out root>/look/` (name made of our own characters, never page text). Inside it: `m<rank>`,
`page` (the page's scroll line), `m<rank>/<channel>` (e.g. `m1/ren:ty`; `#2`, `#3` when one channel holds several motions),
`m<rank>/stagger`.

Pages auto-shrink: `fitPage()` (envelope.js) drops rows from the end of a page until it fits the inline budget and returns
`next_offset`; a row is never cut. A single motion too big for a page (e.g. 20 step records on one channel) is paged by
channel: `motions` returns `next_channel_offset` and takes `channel_offset`, every channel whole with its values (the compact
form is left only for one channel that is too big alone). The `channel` filter takes the ids the tools print
(`m4/ren:opacity`, `ren:rz#2`, `--reva-p1#2`: that one record) or part of a channel name, and keeps only the plain lines about
the matching channels; a filter that matches nothing names the channels that are there. `export` pages with `offset` /
`next_offset`, and a snippet whose code is longer than the inline code cap (6000 characters, e.g. a sampled CustomEase) is
written whole to `<out root>/export/<analysis>_<hash>.<stack>.<css|js>` and returned as `code_file` (path, chars, sha256) and
an artifact; our code is never wrapped as untrusted page text.

Fit order (look, `fitOrder` in src/look/select.js): channels a declared animation of the element names go first, then one
channel per motion per round in rank order, so one motion whose channels are slow to fit cannot spend the take's whole
evaluation budget before the next motion is tried. A channel still cut by the budget gets the probe "look again with
target ..." (aiming fits only that element, with the whole budget); `depth full` does not raise the budget.

Internal surface (research checkouts only, where `src/ext` exists: `reva tools` / `reva tool`, or `reva mcp --surface all` /
`REVA_MCP_SURFACE=all`; the published build serves and runs the public tools only): quota_status, archive_verify, take_summary,
record, fit, motion_records, rebuild_specimen (M3 builder, provider key `specimen`), score, verify, report.

## Target safety (plan item 1.5, MCP part; guard.js)
`look` opens public http(s) sites only. `file:` URLs and loopback / private / link-local / CGNAT / multicast / documentation
addresses (literal, decimal forms, `localhost`, `*.local`, names that resolve to such an address; IPv6 is parsed into hextets and
only global unicast 2000::/3 passes, minus Teredo / 2001::/23 / documentation, while the forms that carry an IPv4 address,
mapped, compatible, translated, NAT64 64:ff9b::/96 and 6to4, are judged by that IPv4 address) are refused with
`target_blocked`, unless the person running the server opted in: `REVA_MCP_ALLOW_LOCAL=1` or `reva mcp --allow-local`.
The opt-in is a server setting, never a tool argument (the model sets arguments). Even with it, a `file:` path must be inside the data
roots. A name whose lookup fails is refused too (the check fails closed). On a live page the browser reaches the network only
through an in-process guard proxy (`startGuardProxy`: `--proxy-server` to it, `--proxy-bypass-list=<-loopback>`, QUIC off, no
no non-proxied WebRTC UDP: the policy is a profile pref, `WEBRTC_PREFS`, because the browser ignores the command-line switch;
the WebRTC / WebTransport constructors are also removed in every frame, `NO_UDP_APIS_SCRIPT`; `runLook` applies both to every
source, so a frozen archive, a fixture and a local URL get them too: the replay walls stop TCP only). The proxy resolves each host itself, refuses non-public answers and connects to the exact IP it checked,
so every redirect hop, subresource, WebSocket (CONNECT) and a rebinding name meet the same check; Playwright routes do not see
redirect hops or WebSockets, so the route check (`liveRequestGuard`) is a second layer only. A real-browser test covers it
(test/mcp/guard-browser.test.js). The internal `record` tool (`--surface all`) takes URL targets only with the same opt-in.
Archives (`archive`) and the bundled fixtures (`fixture`, served on loopback by the tool) are their own explicit inputs and stay
allowed. The CLI face is the owner's terminal and allows local targets.

## Result envelope (envelope.js)
`{ok, contract, tool, summary:{headline, stats}, data, artifacts:[{kind,path,bytes,sha256}], next, warnings, reading_rule}` or
`{ok:false, error:{code, message, hint}}`. Summary first: `enforce()` turns any array of more than 64 numbers into a
`series_ref` (label, n, digest, min/p05/median/p95/max), replaces strings over 400 chars, and cuts a payload over 12 KB (full detail
lives in `artifacts` or behind `offset`/`limit`). Page-derived strings are `{untrusted_content: true, source, text}` wrappers
(`src/report/untrusted.js`): over MCP they travel in a separate `<untrusted_content>` text block (page text cannot close the tag) and the
JSON text holds only tokens; headlines never carry page text.
Page-authored CSS custom-property names (`drv:--orbit-x`) are page words too: outside untrusted_content every tool shows them as
ids of ours, `--reva-p<n>` in order of first appearance in the look result (channel ids, lines, code, the specimen card, which is
built from the aliased look and frames). The page's own name is given only as `property` (untrusted) in motions / code / curve
rows; ids sent back with an alias resolve to the real channel (`realName`, analysis.js).

## Guards in runTool
- JSON-Schema validation (`additionalProperties: false`); unknown arguments are errors.
- Reads only inside the private data roots (or `REVA_MCP_ROOTS`), writes only through `ensureOutDir` or inside those roots (`access.js`).
- Heavy tools: one at a time (mutex), refused at the usage cap (`quota_cap`, exit 75), `record --lane rt` refused unless the display is awake (`display_asleep`).

## Merge points (for the merge agent)
1. `src/cli.js`: before the `default:` case add
   `const code = await contractCommand(cmd, f); if (code !== undefined) return code;` with
   `import { contractCommand } from './mcp/cli.js'`. That gives `tools`, `tool <name> ...`, `mcp`, and the aliases in `ALIASES`
   (`report`, `records`, `unknowns`, `specimen`, `score`, `verify`, `quota`). Existing `record`, `take validate`, `fit` keep working;
   the contract tools are the same operations with the shared envelope. Add the lines to `HELP`.
2. `providers.js`: `PROVIDER_MODULES` lists where the specimen builder / scorer / verify loop export
   `providers = { specimen, score, verify }` (each `async (args, ctx) => ({headline, stats, data, artifacts, next, warnings})`; use
   `ctx.access.readable/writable` for every path). Edit the three lists or call `registerProvider` at start-up. Until wired, those tools
   return `not_wired` (never a fake success).
3. M4 tools: a module listed in `EXTRA_TOOL_MODULES` exporting `tools = [toolDef]` joins the surface (toolDef as in contract.js).
4. `package.json`: nothing required (no new dependency). Optional script `"mcp": "node bin/reva.js mcp"`.

Run it: `node -e "import('./src/mcp/server.js').then(m => m.serveStdio())"` (or `reva mcp` after step 1). Client config example:
`{"command": "node", "args": ["bin/reva.js", "mcp"]}`.
5. Done (20 Oct): the public `card` (was `specimen`) is in `PUBLIC_TOOLS`; the internal M3 tool is `rebuild_specimen` (CLI alias of the same name;
   `reva specimen time|scroll lab` still run the specimen generators).
