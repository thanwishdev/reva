// `reva fit <primaryTakeDir> [--probe <dir>] [--idle <dir>] [--out <file>]` (design §12 X5). The integrator wires
// this into src/cli.js; it prints a summary-first result and writes the full fit result JSON to the private output root.
import fs from 'node:fs';
import path from 'node:path';
import { loadTake } from '../../record/take.js';
import { ensureOutDir } from '../../util/paths.js';
import { fitTakeSet } from './index.js';

const SERIES = ['rows', 'births', 'declared', 'mutations', 'wheel', 'inputLog', 'elements'];

/** Fit options from CLI flags: --only a,b (substring of `desc|channel`), --max-channels, --eval-budget,
 *  --channel-eval-budget, --work-budget, --early-exit (look's early exits). Absent flags leave the fitter's defaults. */
export function fitOptsFromFlags(f) {
  const num = (k) => (f[k] != null && f[k] !== true ? Number(f[k]) : undefined);
  const o = { maxChannels: num('max-channels'), deadlineMs: num('deadline-ms'), evalBudget: num('eval-budget'), channelEvalBudget: num('channel-eval-budget'), workBudget: num('work-budget') };
  if (typeof f.only === 'string') o.only = f.only.split(',').map((x) => x.trim()).filter(Boolean);
  if (f['early-exit']) o.earlyExit = true;
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** @param {{_: string[], probe?: string, idle?: string, out?: string}} f parsed flags; returns an exit code */
export async function runFitCommand(f) {
  const dir = f._[1]; if (!dir) { console.error('usage: reva fit <takeDir> [--probe <takeDir>] [--idle <takeDir>] [--out <file.json>] [--only a,b] [--max-channels n] [--eval-budget n] [--channel-eval-budget n] [--work-budget n] [--early-exit]'); return 2; }
  const L = (d) => loadTake(d, SERIES);
  const t0 = Date.now();
  const res = fitTakeSet({ primary: L(dir), probe: f.probe ? L(f.probe) : undefined, idle: f.idle ? L(f.idle) : undefined }, fitOptsFromFlags(f));
  const out = f.out || path.join(ensureOutDir('fits'), `${path.basename(dir)}.fit.json`);
  fs.writeFileSync(out, JSON.stringify(res, null, 1));
  const byTier = {}; for (const r of res.records) byTier[r.tier] = (byTier[r.tier] || 0) + 1;
  console.log(JSON.stringify({ out, ms: Date.now() - t0, records: res.records.length, byTier, unknowns: res.unknowns.length, stagger: res.stagger.length, flags: res.flags.map((x) => x.id),
    summary: res.records.slice(0, 40).map((r) => `${r.target.desc}|${r.target.channel}: ${r.tier} ${r.class}${r.model.ease ? ' ' + r.model.ease : ''}${r.model.law ? ' law=' + r.model.law : ''}`) }, null, 1));
  return 0;
}
