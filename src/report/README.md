# src/report: report v1 (motion)

`buildReport({fits, takes?, scores?, sections?, labels?, title?})` -> `reva.report/0` JSON; `renderMarkdown` -> report.md;
`validateReport` -> the H6 rules as code; `writeReport(report, dir?)` validates first and refuses a report that breaks them.

What the report holds: per-scene environment (from the primary take.json when given, provenance kept; otherwise an explicit unknown),
one row per motion record (tier, class, family, parameters each with provenance/unit/CI, derived timings, fit quality, runner-up,
ambiguity, unknown ids, evidence take + location), specimen scores with the self-band next to every number, the **unknowns ledger**
(`unk_*` id, count, reason, probes, instances), and the **recorded, not parameterised** list (unexplained, unknown, not applicable,
ambiguous, replay-only springs, pins). Coverage is tri-state: moving / not observed moving (never "static") / not recorded.

Rules: no inline series (digest + count), page-derived strings are `untrusted_content` wrappers and render as quoted text, a parameter
without provenance is shown as `unknown` and ledgered, a spring k/c is only reported with an identified integrator, verdicts are
provisional (pass / fail / needs-owner; JND layer 2 not measured), lab hard fails are counted against an allowed 0.

Score record input (the scorer's side of the contract, tolerant): `{id, kind: lab|reference|..., verdict, score|pooled: number|{value,
selfBand:{lo,hi,sd?}}, channels: {name: ...}, lag, refused, rate, notes}`. A number without a band is printed `self-band: unknown`
and ledgered as `unk_selfband_missing`; an unrecognised verdict becomes `needs-owner`.

## M4 merge point (report v2)
`report.sections` is an object keyed by id, as build/m4 expects. v1 carries `sections.static = {status: 'not_included', reason, merge}`.
`mergeStaticSection(report, buildStaticSection(record))` (src/static/report.js) or `buildReportV2({v1: report})` (src/report/v2.js)
replaces it, bumps `version` to `v2` and appends the section's unknowns tagged `layer: 'static'`; `buildReport({sections: {static,
freeze, ...}})` does the same attach. `renderMarkdown` prints a foreign section with `renderStaticMarkdown` (auto-registered when
src/static/report.js exists), else the section's own `markdown`, else a pointer. Foreign sections are not walked by `validateReport`
(their producers check them); sections left out must say why.
