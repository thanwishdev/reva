// Planted defects run through the SAME verify loop as the lab specimens (source recorded from the lab, defective specimen
// recorded with the same recorder), so a lab "pass" is shown to be earned, not an artefact of the mapping:
//   scroll: easing swap (M01 map), 60 vs 120 Hz smoothing law swap (M02 EMA -> dt-damp calibrated at another rate is
//           identical at its own rate, so the swap is calibrated at 60 Hz and recorded at 120 Hz), all motion removed (M09),
//           one mechanism dropped (mask-skip analogue, M03);
//   time:   spring stiffness +10 % (M07 i6), easing swap (M19 easeOutCubic -> linear), all motion removed (M06 stagger).
// Expected for every row: layer 1 `different` beyond the self-band and a provisional layer-2 verdict that is not `pass`.
import fs from 'node:fs';
import path from 'node:path';
import { labJobs } from './jobs.js';
import { verifyJob } from './loop.js';
import { easingSwap, noMotion, dropMechanism, withEdit } from '../specimens/scroll/variants.js';
import { reviveSpec, renderHtml, serializeSpec, digestOf } from '../specimens/time/build.js';
import { ensureOutDir } from '../util/paths.js';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function writeVariant(base, name, files) {
  const d = path.join(base, name); fs.mkdirSync(d, { recursive: true });
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  return d;
}

function timeVariant(job, name, edit) {
  const spec = reviveSpec(readJson(path.join(job.dir, 'spec.json')));
  edit(spec); spec.id = `${spec.id}~${name}`; spec.digest = digestOf(spec);
  return { 'index.html': renderHtml(spec), 'spec.json': serializeSpec(spec, 1) };
}
function scrollVariant(job, fn) { const spec = readJson(path.join(job.dir, 'spec.json')); const v = fn(spec); return { 'index.html': v.html, 'spec.json': JSON.stringify(v.spec, null, 1) }; }

export const PLANTED = [
  { id: 'scroll-easing-swap', job: 'scroll/m01/reversal', make: (j) => scrollVariant(j, easingSwap) },
  { id: 'scroll-rate-60-vs-120', job: 'scroll/m02/reversal', make: (j) => scrollVariant(j, (s) => withEdit(s, 'rate-60', (x) => {
    for (const m of x.mechanisms) if (m.kind === 'scroll-driven' && m.smoothing.law === 'ema') { m.smoothing.lambda = -Math.log(1 - m.smoothing.alpha) / (1 / 60); delete m.smoothing.alpha; m.smoothing.law = 'dtdamp'; }
  })) },
  { id: 'scroll-no-motion', job: 'scroll/m09/speed', make: (j) => scrollVariant(j, noMotion) },
  { id: 'scroll-mask-skip', job: 'scroll/m03/reversal', make: (j) => scrollVariant(j, (s) => dropMechanism(s, 0)) },
  { id: 'time-spring-k+10pct', job: 'time/m07-i6-p400', make: (j) => timeVariant(j, 'k+10', (s) => { for (const t of s.tracks) if (t.motion.kind === 'spring') t.motion.k *= 1.1; }) },
  { id: 'time-easing-swap', job: 'time/m19-click', make: (j) => timeVariant(j, 'ease-linear', (s) => { for (const t of s.tracks) { const m = t.motion; for (const p of m.kind === 'chain' ? m.parts : [m]) if (p.ease) p.ease = { kind: 'linear' }; } }) },
  { id: 'time-no-motion', job: 'time/m06-go', make: (j) => timeVariant(j, 'no-motion', (s) => { for (const t of s.tracks) { const m = t.motion; if (m.frames) { const v = m.frames[0].value; m.frames = m.frames.map((f) => ({ ...f, value: v })); } } }) },
];

export async function runPlanted({ only, log = (s) => console.log(s) } = {}) {
  const base = ensureOutDir('m3', 'verify', 'planted');
  const rows = [];
  for (const p of PLANTED) {
    if (only && !only.includes(p.id)) continue;
    const [job] = labJobs({ only: [p.job] });
    if (!job) { rows.push({ id: p.id, error: `no job ${p.job}` }); continue; }
    const dir = writeVariant(base, p.id, p.make(job));
    const r = await verifyJob({ ...job, id: `${job.id}~${p.id}`, dir });
    const l1 = (r.pairs || []).map((x) => x.verdict && x.verdict.layer1);
    const caught = r.scored && l1.includes('different') && r.verdict !== 'pass';
    rows.push({ id: p.id, job: p.job, verdict: r.verdict, layer1: l1, minScore: Math.min(...(r.pairs || []).map((x) => x.score ?? 1)), caught, worst: (r.pairs || []).flatMap((x) => x.worst || []).sort((a, b) => b.e - a.e)[0] || null, error: r.error || null });
    log(`${caught ? 'CAUGHT' : 'MISSED'}  ${p.id.padEnd(24)} on ${p.job.padEnd(22)} verdict ${r.verdict}  S_min ${rows.at(-1).minScore.toFixed(4)}  worst ${JSON.stringify(rows.at(-1).worst)}${r.error ? ' ERROR ' + r.error.split('\n')[0] : ''}`);
  }
  return { ok: rows.every((r) => r.caught), rows };
}
