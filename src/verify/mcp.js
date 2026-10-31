// Providers for the contract's `specimen`, `score` and `verify` tools (src/mcp/providers.js merge point). Each returns the
// envelope fields {headline, stats, data, artifacts, next, warnings}; every user path goes through ctx.access.
//   specimen  fit result (reva.motion/0) or lab truth (reva.labtruth/0) -> time + scroll specimens
//   score     two recorded take folders + the specimen that names the channel pairs -> score record (cue units, self-band)
//   verify    a committed lab specimen id: record the lab source (x2) and the specimen with one recorder, score, verdict
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { specimensFromFit, specimensFromLabTruth, writeSpecimens } from '../specimens/time/index.js';
import { scrollSpecimensFromFit, buildScrollSpecimen, writeSpecimen } from '../specimens/scroll/index.js';
import { labJobs } from './jobs.js';
import { verifyJob, scoreJob, NRMSE_LIMIT } from './loop.js';
import { recorderRoot } from './refs.js';
import { ensureOutDir, isInside, REPO_ROOT } from '../util/paths.js';
import { isSchema } from '../util/schema.js';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const artifact = (kind, p) => { const b = fs.readFileSync(p); return { kind, path: p, bytes: b.length, sha256: sha(b) }; };

/** A take folder written by the recorder, reshaped like session.finish().take (what the verify loop scores). */
export async function rawFromDir(dir) {
  const { loadTake } = await import(pathToFileURL(path.join(recorderRoot(), 'src', 'record', 'take.js')).href);
  const { take, data } = loadTake(dir, ['rows', 'births', 'declared', 'mutations', 'wheel', 'inputLog', 'elements']);
  const ev = (k) => (take.env && take.env[k] && 'value' in take.env[k] ? take.env[k].value : undefined);
  const vp = ev('viewport') || {};
  return { ...take, dt: ev('dtMs'), data: { rows: data.rows || [], births: data.births || [], declared: data.declared || [], mut: data.mutations || [], wheel: data.wheel || [] },
    inputLog: data.inputLog || [], els: data.elements || [], marks: take.marks || [],
    env: { innerWidth: vp.width, innerHeight: vp.height, dpr: ev('dpr'), reducedMotion: ev('reducedMotion'), readback: ev('readbackFloor') },
    browser: { engine: ev('engine'), toolkit: ev('toolkit') } };
}

function specimenDirOf(x, ctx) {
  const lab = labJobs({ only: [x] });
  if (lab.length) return { dir: lab[0].dir, job: lab[0] };
  const d = ctx.access.readable(x);
  if (!fs.existsSync(path.join(d, 'spec.json'))) throw Object.assign(new Error(`${d} holds no spec.json`), { code: 'bad_arguments' });
  return { dir: d, job: null };
}

export const providers = {
  async specimen(args, ctx) {
    const file = ctx.access.readable(args.fit);
    const j = readJson(file);
    const isLab = isSchema(j.schema, 'reva.labtruth/0');
    const out = args.out ? ctx.access.writable(args.out) : ensureOutDir('specimens', path.basename(file).replace(/\.json$/, ''));
    if (isInside(out, REPO_ROOT) && !isLab) throw Object.assign(new Error('site-derived specimens are never written inside the repo (PLAN H2)'), { code: 'path_not_allowed' });
    const fit = args.mechanisms && Array.isArray(j.records) ? { ...j, records: j.records.filter((r, i) => args.mechanisms.includes(r.id ?? String(i))) } : j;
    const time = isLab ? specimensFromLabTruth(fit) : specimensFromFit(fit, { origin: 'site', id: 'fit' });
    const written = writeSpecimens(time.specs, path.join(out, 'time'));
    let scroll = { specs: [], skipped: [], claimed: [] };
    try { scroll = isLab ? { specs: [buildScrollSpecimen(fit.items || [], { id: 'lab-' + (fit.route || 'x') })].filter((b) => b.spec.mechanisms.length), skipped: [], claimed: [] } : scrollSpecimensFromFit(fit, { id: 'fit-scroll' }); }
    catch (e) { scroll.error = String(e.message || e).slice(0, 200); }
    for (const b of scroll.specs) writeSpecimen(path.join(out, 'scroll', b.spec.id), b, { site: !isLab });
    const files = [...written.map((d) => path.join(d, 'spec.json')), ...scroll.specs.map((b) => path.join(out, 'scroll', b.spec.id, 'spec.json'))];
    return { headline: `${time.specs.length} time + ${scroll.specs.length} scroll specimens (${time.skipped.length + scroll.skipped.length} records skipped with a reason)`,
      stats: { time: time.specs.length, scroll: scroll.specs.length, skipped: time.skipped.length + scroll.skipped.length },
      data: { out, skipped: [...time.skipped, ...scroll.skipped].slice(0, 40).map((s) => ({ target: s.target || s.channel || null, reason: String(s.reason).slice(0, 160) })), scrollClaimed: scroll.claimed.slice(0, 40) },
      artifacts: files.map((f) => artifact('specimen', f)), next: ['verify a specimen: tool verify --specimen <id|folder> --source <take>'], warnings: scroll.error ? [`scroll builder: ${scroll.error}`] : [] };
  },

  async score(args, ctx) {
    if (!args.specimen) throw Object.assign(new Error('score needs `specimen` (the specimen folder or lab id) to know which source channel each specimen channel rebuilds'), { code: 'bad_arguments' });
    const { dir, job } = specimenDirOf(args.specimen, ctx);
    const spec = readJson(path.join(dir, 'spec.json'));
    const srcTake = await rawFromDir(ctx.access.readable(args.source));
    const rebTake = await rawFromDir(ctx.access.readable(args.candidate));
    const family = isSchema(spec.schema, 'reva.specimen.time/0') ? 'time' : 'scroll';
    const j = job || { id: spec.id, family, group: spec.source && spec.source.route ? null : null };
    if (family === 'time' && !job) throw Object.assign(new Error('a time specimen needs its source time origin; only lab specimens carry it (use a lab id)'), { code: 'bad_arguments' });
    const rec = scoreJob(j, spec, { srcTake, idTake: null, rebTake, mapping: family === 'time' ? 'anchor' : 'mark' });
    const outFile = args.out ? ctx.access.writable(args.out) : path.join(ensureOutDir('m3', 'scores'), `${String(spec.id).replace(/[^\w.-]/g, '_')}-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(rec, null, 1));
    return { headline: `${rec.verdict} (provisional) — ${rec.pairs.length} pairs; self-band unmeasured (no identity take given)`, stats: { pairs: rec.pairs.length, verdict: rec.verdict, minScore: Math.min(...rec.pairs.map((p) => p.score ?? 1)) },
      data: { pairs: rec.pairs.map((p) => ({ track: p.track, src: p.src, score: p.score, layer1: p.verdict && p.verdict.layer1, layer2: p.verdict && p.verdict.layer2, band: 'unmeasured' })) },
      artifacts: [artifact('score', outFile)], next: ['verify records an identity take, so the self-band is measured'], warnings: ['self-band unmeasured: pass a lab specimen to `verify` for a measured band'] };
  },

  async verify(args, ctx) {
    const jobs = labJobs({ only: [args.specimen] });
    if (!jobs.length) throw Object.assign(new Error(`no lab specimen "${args.specimen}" (site specimens are verified after the M2 merge, against their own recorded source)`), { code: 'bad_arguments', hint: 'ids look like time/m07-i6-p400 or scroll/m01/speed' });
    if (args.source && args.source !== 'lab') ctx.access.readable(args.source);   // reserved for site takes; the lab source is always re-recorded
    const dir = ensureOutDir('m3', 'verify');
    const recs = [];
    for (const j of jobs) for (let k = 0; k < (args.rounds || 1); k++) recs.push(await verifyJob(j, { write: true, outDir: path.join(dir, 'takes-mcp') }));
    const file = path.join(dir, `verify-${Date.now()}.json`); fs.writeFileSync(file, JSON.stringify(recs, null, 1));
    const v = recs.map((r) => r.verdict);
    return { headline: `${jobs.length} lab job(s): ${v.filter((x) => x === 'pass').length} pass, ${v.filter((x) => x === 'needs-owner').length} needs-owner, ${v.filter((x) => x === 'fail').length} fail (provisional)`,
      stats: { jobs: jobs.length, pass: v.filter((x) => x === 'pass').length, needsOwner: v.filter((x) => x === 'needs-owner').length, fail: v.filter((x) => x === 'fail').length },
      data: { rows: recs.map((r) => ({ id: r.id, verdict: r.verdict, scored: r.scored, pairs: (r.pairs || []).map((p) => ({ track: p.track, score: p.score, floor: p.floor && { mean: p.floor.mean, sd: p.floor.sd }, layer2: p.verdict && p.verdict.layer2 })), springReplay: r.springReplay ? { worst: r.springReplay.worst, limit: NRMSE_LIMIT } : null, error: r.error ? r.error.split('\n')[0] : null })) },
      artifacts: [artifact('verify', file)], next: [], warnings: [] };
  },
};
