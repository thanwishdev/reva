// M3 scorer gate on the own scorer fixture (PLAN M3 DONE WHEN, scorer rows; G1-4 §8.3 as registered in D-M2-2).
//   node test/score/gate.mjs [--jobs 4]
// Records every take in the hx lane at 120 Hz (plus one 60 Hz take for the refusal row), scores them, prints a summary
// and writes the full JSON report to <out>/m3/score/. Exit code 1 if any gated row fails. Nothing is loosened here:
// the thresholds come from protocol.js (registered expectations) and thresholds.js (provisional layer 2).
import fs from 'node:fs';
import path from 'node:path';
import { serve, recordTake } from './record.mjs';
import { scoreTakeSets, compareEnv } from '../../src/score/score.js';
import { selfBand, floors, ladderVerdict, twinsVerdict, defectVerdict, readbackFloorSd } from '../../src/score/protocol.js';
import { formatScore } from '../../src/score/format.js';
import { fromTakeDir, extractSeries, parseChannelKey, readbackOf } from '../../src/score/series.js';
import { ensureOutDir } from '../../src/util/paths.js';
import { SPEC, LADDER_KEYS, DEFECTS, PHASES, LADDER } from './spec.mjs';

const jobs = +(process.argv.find((a, i) => process.argv[i - 1] === '--jobs') || 4);
const t0 = Date.now();
// M3 Amendment 1, rt live floor: `--rt <rtfloor json from test/score/rtfloor.mjs>` (attended, display awake). Per mechanism the rt
// floor is the largest drop 1 - S between rt takes of the reference. A floor >= 0.5 is not a noise floor but the scorer failing
// on identical-input rt twins (alpha: per-frame EMA, one-frame lattice shift); it is reported and NOT used (rt = null).
const rtArg = process.argv.find((a, i) => process.argv[i - 1] === '--rt');
const rtFile = rtArg ? JSON.parse(fs.readFileSync(rtArg, 'utf8')) : null;
const rtOf = (mech) => { const m = rtFile && rtFile.mechanisms[mech]; if (!m) return { sd: null }; return { sd: m.floor < 0.5 ? m.floor : null, raw: m.floor, sdScore: m.sdScore, excluded: m.floor >= 0.5 }; };

async function pool(tasks, n) {
  const out = new Array(tasks.length); let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { for (;;) { const i = next++; if (i >= tasks.length) return; out[i] = await tasks[i](); } }));
  return out;
}

const srv = await serve();
let report;
try {
  const T = 1000 / 120;
  const plan = [];
  const add = (name, o) => plan.push({ name, o: { write: true, scenario: `score-gate-${name}`, ...o } });
  for (const ph of PHASES) add(`ref-resp-ph${ph}`, { kind: 'resp', query: { phase: +(ph * T).toFixed(6) } });
  add('ref-sweep-a', { kind: 'sweep' }); add('ref-sweep-b', { kind: 'sweep' });
  for (const p of LADDER) { const q = {}; for (const [k, base] of Object.entries(LADDER_KEYS)) q[k] = +(base * (1 + p / 100)).toPrecision(12); add(`ladder${p}`, { kind: 'resp', query: q }); }
  for (const d of Object.keys(DEFECTS)) { add(`${d}-resp`, { kind: 'resp', query: { v: d } }); add(`${d}-sweep`, { kind: 'sweep', query: { v: d } }); }
  add('ref-resp-60', { kind: 'resp', rate: 60 });
  add('rec-ref-a', { kind: 'respRec' }); add('rec-ref-b', { kind: 'respRec' }); add('rec-none', { kind: 'respRec', query: { v: 'none' } });
  const takes = {};
  const reuse = process.argv.find((a, i) => process.argv[i - 1] === '--reuse');
  if (reuse) {
    // rescore stored takes (no browser): the take folders listed in an earlier gate report
    const prev = JSON.parse(fs.readFileSync(reuse, 'utf8'));
    for (const x of plan) { const t = fromTakeDir(prev.takes[x.name].id); t.events = t.extra.events; takes[x.name] = t; }
    console.log(`rescoring ${plan.length} stored takes from ${reuse}`);
  } else {
    const res = await pool(plan.map(x => async () => { const w = Date.now(); const t = await recordTake(srv.origin, x.o); process.stdout.write(`recorded ${x.name} (${t.rows.length} rows, ${Date.now() - w} ms)\n`); return t; }), jobs);
    plan.forEach((x, i) => { takes[x.name] = res[i]; });
  }
  const recordMs = Date.now() - t0;

  const ref = { response: takes['ref-resp-ph0'], sweep: takes['ref-sweep-a'] };
  const ev = (t) => t.events;
  const score = (src, reb, extra = {}) => scoreTakeSets({ src, reb }, SPEC, { events: { src: ev(src.response), reb: ev(reb.response) }, ...extra });

  // 1. identity floor: phase 0 vs phases T/8 .. T/2 (arm 1: two sweep runs)
  const identity = PHASES.slice(1).map(ph => score(ref, { response: takes[`ref-resp-ph${ph}`], sweep: takes['ref-sweep-b'] }));
  const band = selfBand(identity);
  const fl = floors(identity);
  const scoreB = (src, reb) => score(src, reb, { band, floors: fl });

  // 2. ladder (all five key parameters perturbed together; each mechanism is scored on its own element)
  const ladderRecs = LADDER.map(p => ({ p, rec: scoreB(ref, { response: takes[`ladder${p}`], sweep: takes['ref-sweep-b'] }) }));
  // M3 Amendment 1 (owner-approved 2026-10-15 17:2x, written after results; the 1 % row only): the measured minimum noise
  // floor of each mechanism = its channels' D3 read-back floor, in score units (source vs itself moved by ±q per sample),
  // and the rt live floor when one exists (`--rt`; without it rt = null, hx only: rt is attended work).
  const ladder = {};
  for (const mech of Object.values(LADDER_KEYS_TO_MECH())) {
    const pts = ladderRecs.map(({ p, rec }) => ({ p, score: rec.mechanisms.find(m => m.id === mech).pooled.score }));
    const mspec = SPEC.mechanisms.find(m => m.id === mech);
    const chans = mspec.pairs.map(pr => { const key = typeof pr === 'string' ? pr : pr.src; const ch = parseChannelKey(key).channel;
      return { el: extractSeries(ref.response, key).el, channel: ch, q: readbackOf(ref.response, ch) }; });
    const rb = readbackFloorSd(ref.response, chans, (twin) => { const r = score(ref, { response: twin, sweep: ref.sweep }); const m = r.mechanisms.find(x => x.id === mech); return m && m.pooled ? m.pooled.score : null; });
    const rtf = rtOf(mech);
    ladder[mech] = { pts, readbackFloor: rb, rtFloor: rtf, ...ladderVerdict(pts, fl[mech], { readback: rb.sd, rt: rtf.sd }) };
  }

  // 4. CSS vs WAAPI twins, inside every reference take
  const twinSpec = { mechanisms: [{ id: 'twins', arms: ['response'], pairs: [{ src: '#cs|ren:tx', reb: '#wa|ren:tx' }] }] };
  const twins = PHASES.map(ph => { const t = takes[`ref-resp-ph${ph}`]; const r = scoreTakeSets({ src: { response: t }, reb: { response: t } }, twinSpec, { events: { src: t.events, reb: t.events } });
    return { phase: ph, ...twinsVerdict(r.mechanisms[0].pooled.score, fl.duration), layer1: r.mechanisms[0].verdict.layer1, maxAbs: r.mechanisms[0].pairs[0].response.events[0].aligned };
  });

  // planted defects
  const defects = {};
  const defectRecs = {};
  for (const [d, mechs] of Object.entries(DEFECTS)) {
    const rec = scoreB(ref, { response: takes[`${d}-resp`], sweep: takes[`${d}-sweep`] });
    defectRecs[d] = rec;
    defects[d] = Object.fromEntries(mechs.map(id => [id, defectVerdict(rec.mechanisms.find(m => m.id === id), fl[id])]));
  }
  // W2G1-3 "dense step" number for the 60 vs 120 Hz smoothing defect (max |Δ| / A over the frames after each step)
  const hz60Steps = defectRecs.hz60.mechanisms.find(m => m.id === 'alpha').pairs[0].response.events.filter(e => e.aligned).map(e => ({ input: e.i, y: e.value, maxAbs: e.aligned.maxAbs }));

  // cross-rate refusal
  const cross = scoreTakeSets({ src: { response: takes['ref-resp-ph0'] }, reb: { response: takes['ref-resp-60'] } }, SPEC, { events: { src: takes['ref-resp-ph0'].events, reb: takes['ref-resp-60'].events } });
  const refusal = { refused: cross.refused, scoredMechanisms: cross.mechanisms.filter(m => m.pooled).length, env: compareEnv(takes['ref-resp-ph0'], takes['ref-resp-60']) };

  // recorder-driven inputs (inputLog path, takes read back from disk)
  const recSpec = { mechanisms: SPEC.mechanisms.filter(m => ['alpha', 'map', 'mask'].includes(m.id)).map(m => ({ ...m, arms: ['response'] })) };
  const recSame = scoreTakeSets({ src: { response: takes['rec-ref-a'] }, reb: { response: takes['rec-ref-b'] } }, recSpec);
  const recNone = scoreTakeSets({ src: { response: takes['rec-ref-a'] }, reb: { response: takes['rec-none'] } }, recSpec);

  // printed-band check: every cue line of every printed record carries a band
  const printed = [formatScore(identity[3]), ...Object.values(defectRecs).map(r => formatScore(r)), ...ladderRecs.map(x => formatScore(x.rec))].join('\n');
  const cueLines = printed.split('\n').filter(l => / Δ /.test(l));
  const unbanded = cueLines.filter(l => l.split(' Δ ').length - 1 !== (l.match(/\((band [^)]*)\)/g) || []).length);
  const srcText = fs.readdirSync(new URL('../../src/score/', import.meta.url)).map(f => fs.readFileSync(new URL(`../../src/score/${f}`, import.meta.url), 'utf8')).join('\n');
  const codeOnly = srcText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''");
  const forbidden = /\bdtw\b|frechet|fréchet|openai|anthropic|fetch\(/i.test(codeOnly);

  const rows = [
    { id: 'identity-floor', pass: Object.values(fl).every(f => f.pass), detail: Object.fromEntries(Object.entries(fl).map(([k, f]) => [k, { mean: f.mean, sd: f.sd, min: f.min }])) },
    { id: 'ladder-monotone', pass: Object.values(ladder).every(l => l.rhoPass), detail: Object.fromEntries(Object.entries(ladder).map(([k, l]) => [k, l.rho])) },
    { id: 'ladder-1pct-within-2sd', pass: Object.values(ladder).every(l => l.onePct.pass), detail: Object.fromEntries(Object.entries(ladder).map(([k, l]) => [k, { scores: l.onePct.scores, limit: l.onePct.limit, sdEff: l.onePct.sdEff, sdFrom: l.onePct.sdFrom, sdSelf: l.onePct.sdSelf, sdReadback: l.onePct.sdReadback, sdRt: l.onePct.sdRt }])) },
    { id: 'ladder-10pct-beyond-5sd', pass: Object.values(ladder).every(l => l.tenPct.pass), detail: Object.fromEntries(Object.entries(ladder).map(([k, l]) => [k, { scores: l.tenPct.scores, limit: l.tenPct.limit }])) },
    { id: 'twins-css-waapi', pass: twins.every(t => t.pass), detail: twins.map(t => ({ phase: t.phase, score: t.score, limit: t.limit })) },
    ...Object.entries(defects).map(([d, ms]) => ({ id: `defect-${d}`, pass: Object.values(ms).every(v => v.pass), detail: Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, { score: v.score, limit: v.limit, beyondBand: v.beyondBand, top: v.top[0] }])) })),
    { id: 'cross-rate-refused', pass: refusal.refused.length > 0 && refusal.scoredMechanisms === 0, detail: refusal.refused },
    { id: 'self-band-printed', pass: cueLines.length > 0 && unbanded.length === 0, detail: { cueLines: cueLines.length, unbanded: unbanded.slice(0, 3) } },
    { id: 'no-dtw-frechet-vlm', pass: !forbidden, detail: 'src/score code (comments and strings excluded) has no DTW/Frechet/network/model call' },
    { id: 'inputlog-path', pass: recSame.mechanisms.every(m => m.verdict.layer1 === 'identical' && m.pooled.score === 1) && recNone.mechanisms.every(m => m.verdict.layer1 === 'different'), detail: { same: recSame.mechanisms.map(m => [m.id, m.pooled.score, m.verdict.layer1]), none: recNone.mechanisms.map(m => [m.id, m.pooled.score, m.verdict.layer1]) } },
  ];
  report = { schema: 'reva.scoregate/0', created: new Date().toISOString(), recordMs, totalMs: Date.now() - t0, jobs, takes: Object.fromEntries(Object.entries(takes).map(([k, t]) => [k, { id: t.id, digest: t.digest, rows: t.rows.length }])),
    rows, floors: fl, band, ladder, twins, defects, hz60Steps, refusal, recSame: recSame.mechanisms.map(m => m.pooled), identitySample: identity[3], defectRecs, ladderRecs };
  const dir = ensureOutDir('m3', 'score');
  const file = path.join(dir, `gate-${report.created.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 1));
  console.log('\n' + formatScore(defectRecs.hz60, { maxEvents: 2 }));
  console.log('\nGATE ROWS');
  for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${JSON.stringify(r.detail)}`);
  console.log(`hz60 dense step max|Δ|/A per input: ${hz60Steps.map(s => s.maxAbs.toFixed(3)).join(' ')}`);
  console.log(`report: ${file}\nrecord ${(recordMs / 1000).toFixed(1)} s, total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exitCode = rows.every(r => r.pass) ? 0 : 1;
} finally { await srv.close(); }

function LADDER_KEYS_TO_MECH() { return { D: 'duration', k: 'spring-k', L: 'lag', h: 'hold', alpha: 'alpha' }; }
