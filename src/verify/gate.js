// M3 verify-loop gate on the lab specimens (PLAN M3 DONE WHEN: "every lab specimen scored; spring specimens replay
// NRMSE <= 0.005; verdicts pass / fail / needs-owner (provisional); lab specimens meet the allowed fail count" = 0 hard
// fails, NIGHT_PLAN). Every job records the lab SOURCE twice (reference + identity take for the self-band) and the
// SPECIMEN once, all in the hx lane at the specimen's rate, with one recorder (src/verify/refs.js), then scores.
//   runLabGate({jobs, only, writeTakes, log}) — CLI: reva verify lab [--jobs 3] [--only a,b] [--write-takes]; test/verify/gate.mjs
// Writes <out>/m3/verify/gate-<time>.json (full records) and prints one line per job and the gate rows. Exit 1 on a failed row.
import fs from 'node:fs';
import path from 'node:path';
import { labJobs } from './jobs.js';
import { verifyJob, NRMSE_LIMIT } from './loop.js';
import { recorderRoot, recorderDigest, labRepo } from './refs.js';
import { ensureOutDir } from '../util/paths.js';
import { toReportScore } from './report.js';

/** True when the verify/score code (comments and strings stripped; this checker file excluded, it holds the pattern) calls DTW, Frechet, the network or a model. */
export function noAlign() {
  const dirs = ['../verify/', '../score/'].map((d) => new URL(d, import.meta.url));
  const text = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.js') && f !== 'gate.js').map((f) => fs.readFileSync(new URL(f, d), 'utf8'))).join('\n');
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''").replace(/`[^`]*`/g, '``');
  return /\bdtw\b|frechet|fréchet|openai|anthropic|fetch\(/i.test(code);
}

export async function runLabGate({ jobs: jobsN = 3, only = null, writeTakes = false, log = (s) => console.log(s) } = {}) {
  const t0 = Date.now();
  const dir = ensureOutDir('m3', 'verify');
  const created = new Date().toISOString();
  const takesDir = writeTakes ? path.join(dir, `takes-${created.replace(/[:.]/g, '-')}`) : null;

  const jobs = labJobs({ only: only && only.length ? only : undefined });
  log(`verify gate: ${jobs.length} jobs, ${jobsN} at a time; recorder ${recorderRoot()} (${recorderDigest()}); lab ${labRepo()}`);

  async function pool(tasks, n) {
    const out = new Array(tasks.length); let next = 0;
    await Promise.all(Array.from({ length: n }, async () => { for (;;) { const i = next++; if (i >= tasks.length) return; out[i] = await tasks[i](); } }));
    return out;
  }
  const f = (x, d = 4) => (x == null || !Number.isFinite(x) ? 'n/a' : Math.abs(x) < 1e-3 && x !== 0 ? x.toExponential(1) : x.toFixed(d));
  const recs = await pool(jobs.map((j) => async () => {
    const r = await verifyJob(j, { write: !!takesDir, outDir: takesDir });
    const worst = (r.pairs || []).reduce((w, p) => (p.score != null && (w == null || p.score < w.score) ? p : w), null);
    const lag = (r.pairs || []).map((p) => p.lag && p.lag.worstDeltaMs).filter((x) => x != null);
    log(`${r.verdict.padEnd(11)} ${j.id.padEnd(30)} pairs ${(r.pairs || []).length} S_min ${f(worst && worst.score)} (floor ${f(worst && worst.floor && worst.floor.mean)} ± ${f(worst && worst.floor && worst.floor.sd)}) |lag|max ${f(lag.length ? Math.max(...lag.map(Math.abs)) : null, 3)} ms${r.springReplay ? ` NRMSE ${f(r.springReplay.worst)}` : ''}${r.error ? ' ERROR ' + r.error.split('\n')[0] : ''}${r.sourceParity && !r.sourceParity.pass ? ' SOURCE-PARITY-FAIL' : ''} (${((r.wallMs || 0) / 1000).toFixed(0)} s)`);
    return r;
  }), jobsN);

  const specimens = new Map();
  for (const r of recs) { const s = specimens.get(r.specimen) || []; s.push(r); specimens.set(r.specimen, s); }
  const springRecs = recs.filter((r) => r.springReplay);
  const count = (v) => recs.filter((r) => r.verdict === v).length;
  const unbanded = recs.flatMap((r) => (r.pairs || []).flatMap((p) => (p.worst || []).filter((w) => w.band == null).map((w) => `${r.id} ${p.track} ${w.cue}`)));
  const rows = [
    { id: 'every-lab-specimen-scored', pass: [...specimens.values()].every((rs) => rs.every((r) => r.scored)), detail: { specimens: specimens.size, jobs: recs.length, unscored: recs.filter((r) => !r.scored).map((r) => `${r.id}: ${r.error ? r.error.split('\n')[0] : r.unscoredReason || (r.pairs || []).filter((p) => !p.verdict).map((p) => p.unscored).join('; ')}`) } },
    { id: 'spring-replay-nrmse', pass: springRecs.length > 0 && springRecs.every((r) => r.springReplay.pass), detail: { limit: NRMSE_LIMIT, specimens: springRecs.length, worst: Math.max(...springRecs.map((r) => r.springReplay.worst)), failing: springRecs.filter((r) => !r.springReplay.pass).map((r) => `${r.id} ${r.springReplay.worst}`) } },
    { id: 'lab-hard-fails-0', pass: count('fail') === 0, detail: { pass: count('pass'), 'needs-owner': count('needs-owner'), fail: count('fail'), failing: recs.filter((r) => r.verdict === 'fail').map((r) => r.id) } },
    { id: 'source-parity', pass: recs.every((r) => r.sourceParity && r.sourceParity.pass), detail: recs.filter((r) => !(r.sourceParity && r.sourceParity.pass)).map((r) => `${r.id}: ${JSON.stringify(r.sourceParity)}`) },
    { id: 'same-recorder-lane-rate', pass: recs.every((r) => r.recorder && r.recorder.digest === recs[0].recorder.digest && r.recorder.lane === 'hx') && recs.every((r) => !(r.pairs || []).some((p) => p.refused)), detail: { digest: recs[0] && recs[0].recorder.digest, refusedPairs: recs.flatMap((r) => (r.pairs || []).filter((p) => p.refused).map((p) => `${r.id} ${p.track}: ${JSON.stringify(p.refused)}`)) } },
    { id: 'self-band-on-every-number', pass: unbanded.length === 0, detail: unbanded.slice(0, 10) },
    { id: 'no-dtw-frechet-vlm', pass: !noAlign(), detail: 'src/verify + src/score code (comments and strings excluded): no DTW / Frechet / network / model call; time mapping is trigger/mark based' },
  ];
  const report = { schema: 'reva.verifygate/0', created, totalMs: Date.now() - t0, jobs: jobsN, recorder: { root: recorderRoot(), digest: recorderDigest() }, lab: labRepo(), takesDir, rows,
    summary: recs.map((r) => ({ id: r.id, verdict: r.verdict, scored: r.scored, pairs: (r.pairs || []).map((p) => ({ track: p.track, src: p.src, reb: p.reb, score: p.score, layer1: p.verdict && p.verdict.layer1, layer2: p.verdict && p.verdict.layer2, floor: p.floor && { mean: p.floor.mean, sd: p.floor.sd }, nrmse: p.nrmse && p.nrmse.nrmse, lagMs: p.lag && p.lag.worstDeltaMs, worst: (p.worst || [])[0] })), springReplay: r.springReplay || null, error: r.error || null })),
    records: recs };
  const file = path.join(dir, `gate-${created.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 1));
  const scoresFile = file.replace(/gate-([^/]+)\.json$/, 'scores-$1.json');
  fs.writeFileSync(scoresFile, JSON.stringify({ scores: recs.map(toReportScore) }, null, 1));   // report v1 input (src/report/scores.js)
  report.scoresFile = scoresFile;
  log('\nGATE ROWS');
  for (const r of rows) log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${JSON.stringify(r.detail).slice(0, 600)}`);
  log(`report: ${file}\nscores (report input): ${scoresFile}\ntotal ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return { ok: rows.every((r) => r.pass), file, rows, report };
}
