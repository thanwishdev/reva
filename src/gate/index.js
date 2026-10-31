// Stage G suite: identical replay, T6 baseline (captured vs held-out), source audit, mutation test.
// How a later stage scores its own rebuild (D1 rule-table capture, D2 states):
//   1. points = testPoints({captured, edges, range})  (held-out widths/heights are never used for capture)
//   2. reuse the suite's orig1..orig3 runs (noise caps) or run runGateSuite once per site
//   3. captureRun(site, points, dir, {artifacts: {cls: {html, frames}}}) with the stage's generated rebuild
//   4. compareRuns(orig1, dir, points, caps) -> per point oracle (named misses) + pixel verdict; auditRun(...)
// A capture is complete only when every point passes, held-out ones included (review F1).
import fs from 'node:fs';
import path from 'node:path';
import { captureRun, compareRuns, summarize, noiseCapsFrom, auditRun, gzRead } from './run.js';
import { makeMutants } from './mutate.js';
import { testPoints } from './points.js';
import { decodeStyle } from './snapshot.js';
import { enterTopLayer } from './scriptowned.js';

export { testPoints } from './points.js';
export { compareSnapshots } from './compare.js';
export { auditSources } from './audit.js';
export { makeMutants } from './mutate.js';
export { fixtureSite, archiveSite, captureRun, compareRuns, auditRun, noiseCapsFrom } from './run.js';
// stage D1: rule-table capture scored by this gate (rebuild rendered from the captured JSON only)
export { runCaptureSuite, ruleTableCapture } from './capture.js';
export { renderRebuild, tableMutants } from './rebuild.js';
// stage D2: interaction states (CSS forced + JS by real input), each scored by this gate; state-rule coverage
export { runStatesSuite, captureBaseTables } from './states.js';

const rmPngs = dir => { for (const f of fs.readdirSync(dir)) if (f.endsWith('.png')) fs.rmSync(path.join(dir, f)); };

/**
 * @param {object} site      fixtureSite()/archiveSite()
 * @param {object} o
 * @param {object[]} o.points       from testPoints()
 * @param {string} o.out            output dir (private for site-derived runs)
 * @param {number} [o.mutants=20]   @param {string} [o.mutantCls] class whose artifact is mutated (default: first captured)
 * @param {Function} [o.log]
 */
export async function runGateSuite(site, { points, out, mutants = 20, mutantCls, log = console.log }) {
  const t0 = Date.now();
  const D = n => path.join(out, n);
  fs.mkdirSync(out, { recursive: true });
  const r = { site: site.id, url: site.url, points, steps: {} };
  const step = async (name, fn) => { const t = Date.now(); const v = await fn(); r.steps[name] = { ms: Date.now() - t }; log(`step ${name} ${Date.now() - t}ms`); return v; };

  const m1 = await step('orig1', () => captureRun(site, points, D('orig1'), { withDump: true, log }));
  const m2 = await step('orig2', () => captureRun(site, points, D('orig2'), { log }));
  const m3 = await step('orig3', () => captureRun(site, points, D('orig3'), { log }));
  const m4 = await step('orig4', () => captureRun(site, points, D('orig4'), { log }));
  r.archiveMisses = Object.fromEntries([['orig1', m1], ['orig2', m2], ['orig3', m3], ['orig4', m4]].map(([k, m]) => [k, Object.values(m.classes).reduce((s, c) => s + c.misses, 0)]));

  // noise: three identical replays, all three pairs; identity: a fourth replay judged with those caps
  const pairs = [['orig1', 'orig2'], ['orig1', 'orig3'], ['orig2', 'orig3']].map(([a, b]) => compareRuns(D(a), D(b), points, null, { heatDir: D(`heat-noise-${a}-${b}`) }));
  const nz = noiseCapsFrom(pairs);
  const caps = nz.caps;
  const allNoise = pairs.flatMap(p => Object.entries(p));
  r.noise = { caps, perPoint: nz.perPoint, perClass: nz.perClass, oraclePass: allNoise.every(([, x]) => x.oracle.pass), maxBlob: Math.max(...allNoise.map(([, x]) => x.pixel.blob)), oracleFails: Object.fromEntries(allNoise.filter(([, x]) => !x.oracle.pass).map(([k, x]) => [k, x.oracle.byKind])) };
  const identity = compareRuns(D('orig1'), D('orig4'), points, caps, { heatDir: D('heat-identity') });
  r.identity = { summary: summarize(identity), results: identity };

  // T6 baseline subject: one dump per class, taken at that class's captured point
  const artifacts = {};
  for (const cls of new Set(points.map(p => p.cls))) artifacts[cls] = JSON.parse(fs.readFileSync(path.join(D('orig1'), `dump-${cls}.json`), 'utf8'));
  // the dump cannot hold the top layer (open popover / modal); the harness re-enters what orig1 had at the point, as
  // the capture suite does from its table (D2) - otherwise `overlay: auto` vs none fails every captured point
  const prepare = async (page, pt) => { const tl = m1.points?.[pt.id]?.topLayer; return tl?.length ? { topLayer: await page.evaluate(enterTopLayer, tl) } : null; };
  const mt6 = await step('t6', () => captureRun(site, points, D('t6'), { artifacts, prepare, log }));
  const t6 = compareRuns(D('orig1'), D('t6'), points, caps, { heatDir: D('heat-t6') });
  r.t6 = { summary: summarize(t6), results: t6, archiveMisses: Object.values(mt6.classes).reduce((s, c) => s + c.misses, 0), artifactBytes: Object.fromEntries(Object.entries(artifacts).map(([k, a]) => [k, a.html.length])) };
  r.audit = auditRun(D('orig1'), mt6, artifacts);

  // Mutation test at the mutated class's captured point (where the unmutated baseline is expected to pass)
  const mc = mutantCls || points.find(p => p.kind === 'captured').cls;
  const mpt = points.find(p => p.cls === mc && p.kind === 'captured');
  const snap = gzRead(path.join(D('orig1'), `${mpt.id}.json.gz`));
  const fam = new Set(); for (const e of snap.els) { const v = decodeStyle(snap, e.s).get('font-family'); if (v && (e.f || e.t.trim())) fam.add(v); }
  const muts = makeMutants(artifacts[mc].html, mutants, 20261016, { usedFamilies: [...fam] });
  r.mutants = { cls: mc, point: mpt.id, baselinePass: t6[mpt.id]?.pass, made: muts.length, killed: 0, rows: [] };
  await step('mutants', async () => {
    for (const m of muts) {
      const dir = D(`mut-${m.id}`);
      await captureRun(site, [mpt], dir, { artifacts: { [mc]: { html: m.html, frames: artifacts[mc].frames } }, prepare });
      const res = compareRuns(D('orig1'), dir, [mpt], caps)[mpt.id];
      // a kill must be caused by the mutation: when the unmutated baseline already fails at this point, the mutant
      // also has to differ from the baseline rebuild itself (oracle exact, pixel cap 0)
      const vsBase = compareRuns(D('t6'), dir, [mpt], { [mpt.id]: 0 })[mpt.id];
      const killed = !res.pass && (r.mutants.baselinePass || !vsBase.pass);
      if (killed) r.mutants.killed++;
      r.mutants.rows.push({ id: m.id, desc: m.desc, killed, by: [res.oracle.pass ? null : `oracle(${Object.keys(res.oracle.byKind).join(',')})`, res.pixel.pass ? null : 'pixel'].filter(Boolean).join('+') || 'none', firstMiss: res.oracle.misses[0] || null, pixel: res.pixel.reason || null, vsBaseline: { oracle: vsBase.oracle.byKind, pixelPx: vsBase.pixel.diffPx } });
      fs.rmSync(dir, { recursive: true, force: true });
      log(`mutant ${m.id} ${killed ? 'KILLED' : 'survived'} ${m.desc}`);
    }
  });
  r.verdict = {
    identityPass: r.identity.summary.all.pass === r.identity.summary.all.points,
    t6CapturedPass: r.t6.summary.captured.pass === r.t6.summary.captured.points,
    t6HeldoutFails: r.t6.summary.heldout.pass < r.t6.summary.heldout.points,
    t6HeldoutFailCount: r.t6.summary.heldout.points - r.t6.summary.heldout.pass,
    auditPass: Object.values(r.audit).every(a => a.pass),
    mutantsKilled: `${r.mutants.killed}/${r.mutants.made}`,
    mutantsPass: r.mutants.made >= 20 && r.mutants.killed >= 19,
    archiveMisses: r.archiveMisses,
  };
  r.verdict.acceptance = r.verdict.identityPass && r.verdict.t6CapturedPass && r.verdict.t6HeldoutFails && r.verdict.auditPass && r.verdict.mutantsPass;
  r.wallMs = Date.now() - t0;
  fs.writeFileSync(D('gate.json'), JSON.stringify(r, null, 1));
  return r;
}

export function pointsFromTruth(truth, o = {}) { return testPoints({ captured: truth.captured, edges: truth.edges, range: truth.range, ...o }); }
