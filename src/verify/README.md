# src/verify: the verify loop (M3)

Record the **source** and the **specimen** with the same recorder, lane and rate; score the specimen against the source in cue units
against the source's self-band (`src/score/`); return one `reva.verify/0` record per job.

| file | what |
|---|---|
| `refs.js` | which recorder (both sides) and which Fixture Lab; defaults to this repo, `REVA_RECORDER_ROOT` / `REVA_LAB_REPO` point elsewhere READ-ONLY (before the M2 merge: the main tree). The recorder digest is in every record. |
| `jobs.js` | the lab jobs: every committed specimen in `specimens/time` and `specimens/scroll` (one per scroll scenario) with its lab cell; specimen-side actions; the time-origin rule per lab group |
| `loop.js` | `verifyJob(job)`: source x2 (reference + identity take for the band/floor) + specimen, time mapping, pairs, scores, NRMSE_t, verdict. `scoreJob` is the browser-free half. `declaredArm` scores declared-only specimens (View Transitions) from births. |
| `gate.js` | `runLabGate()`: all jobs, gate rows, `<out>/m3/verify/gate-*.json` + `scores-*.json` (report v1 input) |
| `planted.js` | planted defects through the same loop (easing swap, 60 vs 120 Hz law, no motion, mask-skip, spring k +10 %) |
| `report.js` | verify record -> report score record (every number with its self-band) |
| `mcp.js` | contract providers `specimen`, `score`, `verify` |

## Time mapping (never fitted)
- **Scroll family** (real inputs replayed): both takes start with the mark `verify-start`; specimen times are shifted by the difference of
  that mark. The scorer then checks that every input (scrollTo, wheel, pointer, trigger marks) is the same and less than one frame apart
  (exact input replay); otherwise the arm is refused.
- **Time family** (the specimen's own timeline): `source T = origin + (T_specimen - anchor) - sourceShiftMs`, where `anchor` is the
  specimen's first frame after its `go` trigger, and `origin` is the lab group's truth time base: absolute take time for `lab-easing`,
  the first frame after the page's post-boot `go` for `lab-springs`. Arm-2 windows start at the track's schedule (onsets, retargets,
  segment starts) on both sides, so a late or early specimen shows up as a lag / t50 difference.
- **Trigger swap:** only the page's trigger action differs (`__go()` -> `window.specimen.go()`; the lab's `go` event -> `window.specimen.script()`
  for the pointer path). The lab page's pointer script runs on page timers (they fire before the frame at their due time); the
  specimen's `script()` lands an event after the frame at T (recorder-input semantics), so the driver passes `base - 0.0015 ms`.

## Run
```
node test/verify/gate.mjs --jobs 4 [--only time/m07-i6-p400,scroll/m01] [--write-takes]
reva verify lab [--jobs N] [--only ...]           # same, from the CLI
reva tool verify --specimen time/m19-click         # one job over the contract (MCP: tool "verify")
```
To use a recorder or lab from another checkout, set `REVA_RECORDER_ROOT=<checkout>` and `REVA_LAB_REPO=<checkout>`.
