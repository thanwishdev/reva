// `reva lab <plan|parity|probe|sweep|determinism|draws|check|score|report>` (M2 design §12 X5). Every browser run
// goes through src/record/session.js (PLAN H1); takes, truth snapshots and reports go to the private output root (H2):
// <out>/m2/lab/<run>/ . Long phases resume: a take whose meta.json exists is not recorded again.
import fs from 'node:fs';
import path from 'node:path';
import { loadAdapters, plan, reduce, recordTake, fitAndScore, hasTake, readMeta, takeDir, serveLab, ensureOutDir, retruth, RECORDED, GROUPS, ESCALATED, DRAW_SEED, DROP_TRACE, DROP_TRACE_A1 } from './runner.js';
import { mulberry32 } from '../analysis/fit/numeric.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const appendJsonl = (file, obj) => fs.appendFileSync(file, JSON.stringify(obj) + '\n');
export const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function select(p, f) {
  let cells = p.cells;
  if (f.group) cells = cells.filter((c) => f.group.split(',').includes(c.group));
  if (f.route) cells = cells.filter((c) => f.route.split(',').includes(c.route));
  if (f.variant) cells = cells.filter((c) => f.variant.split(',').includes(c.variant));
  if (f.default) { const s = new Set(p.stratum.map((c) => c.key)); cells = cells.filter((c) => s.has(c.key)); }
  if (f.limit) cells = cells.slice(0, +f.limit);
  return cells;
}

/** Record (resumable) every regime of each cell, then fit + score it; results go to `<dir>/<phase>.jsonl`. */
async function runCells(cells, { dir, phase, adapters, regimes = RECORDED, fit = true, idleOf, origin }) {
  const A = Object.fromEntries(adapters.map((a) => [a.name, a]));
  const resFile = path.join(dir, `${phase}.jsonl`); const recFile = path.join(dir, `${phase}-takes.jsonl`);
  const done = new Set(readJsonl(resFile).map((r) => r.key + '|' + r.regime));
  let i = 0; const t0 = Date.now();
  for (const c of cells) {
    i++;
    const idle = idleOf ? idleOf(c) : null;
    for (const cc of idle && idle.key !== c.key ? [idle, c] : [c]) for (const reg of regimes) {
      if (hasTake(dir, cc, reg)) continue;
      const m = await recordTake(A[cc.group], cc, reg, { origin, outRoot: dir });
      appendJsonl(recFile, m);
      log(`${phase} ${i}/${cells.length} ${cc.key} ${reg} frames=${m.frames} ${m.wallMs}ms parity=${m.parity && m.parity.pass}${m.parity && !m.parity.pass ? ' ' + JSON.stringify(m.parity.bad || m.parity.error).slice(0, 300) : ''}${m.pageErrors ? ' pageErrors=' + m.pageErrors : ''}${m.settleTimeouts ? ' settleTimeouts=' + m.settleTimeouts : ''}`);
    }
    if (!fit) continue;
    const want = [...regimes, ...(regimes.includes('R2') ? ['R6'] : [])].filter((r) => !done.has(c.key + '|' + r));
    if (!want.length) continue;
    const res = await fitAndScore(c, dir, { idleCell: idle && idle.key !== c.key ? idle : null, regimes: want });
    for (const r of res) appendJsonl(resFile, r);
    const ok = res.filter((r) => !r.error); const cls = ok.flatMap((r) => r.confusion || []);
    log(`${phase} ${i}/${cells.length} ${c.key} fit ${res.map((r) => r.regime + ':' + (r.error ? 'ERR' : (r.fitMs | 0) + 'ms')).join(' ')} class ${cls.filter((x) => x.correct).length}/${cls.length}${res.some((r) => r.error) ? ' ' + res.find((r) => r.error).error.slice(0, 200) : ''} · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  }
}

export async function runLabCommand(f) {
  const sub = f._[1];
  const adapters = await loadAdapters(f.groups ? f.groups.split(',') : GROUPS);
  // --protocol a1: the attempt-1/2 protocol (r3 dropped the dense traces, draws seed 20261015) — development data only;
  // default: Amendment 2 (C1 dense traces kept, C4 fresh draws; seed 20261017 since owner decision W10; --draw-seed
  // 20261016 reads the attempt-3 set as development data)
  const a1 = f.protocol === 'a1';
  const p0 = plan(adapters, { drawSeed: f['draw-seed'] != null ? +f['draw-seed'] : a1 ? 20261015 : DRAW_SEED });
  const p = f.reduce ? reduce(p0, adapters, String(f.reduce).split(','), { dropTrace: a1 ? DROP_TRACE_A1 : DROP_TRACE }) : { ...p0, K: { R2: 5, R3: 5, R4: 5, R5: 5 }, reductions: [] };
  p.protocol = a1 ? 'A1 (attempt 1/2)' : 'Amendment 2';
  const run = f.run || 'main';
  const dir = ensureOutDir('m2', 'lab', run);
  const idleOf = (c) => {
    const r = adapters.find((a) => a.name === c.group).routes().find((x) => x.id === c.route);
    if (!r.idleVariant || c.variant === r.idleVariant) return null;
    const pool = c.kind === 'draw' ? [c] : p.cells;
    const hit = p.cells.find((x) => x.group === c.group && x.route === c.route && x.variant === r.idleVariant && JSON.stringify(x.params) === JSON.stringify(c.params));
    return hit || pool[0];
  };
  if (sub === 'plan') {
    const det = p.stratum.length * Object.values(p.K).reduce((a, k) => a + k - 1, 0);
    console.log(JSON.stringify({ reductions: p.reductions, cells: p.cells.length, stratum: p.stratum.length, draws: p.draws.length, K: p.K, runs: { sweep: p.cells.length * 4, draws: p.draws.length * 4, determinism: det, total: p.cells.length * 4 + p.draws.length * 4 + det } }));
    if (f.list) for (const c of p.cells) console.log(c.key);
    return 0;
  }
  if (sub === 'retruth') {
    // recompute stored truth snapshots (after a fixture truth fix): no browser
    const A = Object.fromEntries(adapters.map((a) => [a.name, a])); let n = 0;
    for (const c of [...select(p, f), ...(f.draws ? p.draws : [])]) for (const reg of RECORDED) if (hasTake(dir, c, reg)) { await retruth(A[c.group], c, reg, dir); n++; }
    log(`retruth: ${n} takes`); return 0;
  }
  const srv = await serveLab();
  try {
    if (sub === 'probe') {
      // A1.4 cost probe: M02 default params, 3 traces × R2–R5, recording only (no fitting)
      const cells = p.stratum.filter((c) => c.group === 'lab-scroll' && c.route === 'm02');
      const metas = [];
      for (const c of cells) for (const reg of RECORDED) { const m = await recordTake(adapters.find((a) => a.name === c.group), c, reg, { origin: srv.origin, outRoot: dir }); metas.push(m); log(`probe ${c.variant} ${reg} ${m.frames} frames ${m.wallMs} ms parity=${m.parity && m.parity.pass}`); }
      const mean = metas.reduce((a, m) => a + m.wallMs, 0) / metas.length;
      const out = { runs: metas.length, meanMs: mean, perRegime: Object.fromEntries(RECORDED.map((r) => [r, metas.filter((m) => m.regime === r).map((m) => m.wallMs)])), projectedFullProtocolH: (mean * 2808) / 3.6e6 };
      fs.writeFileSync(path.join(dir, 'probe.json'), JSON.stringify(out, null, 1)); console.log(JSON.stringify(out)); return 0;
    }
    if (sub === 'sweep' || sub === 'parity') {
      const cells = select(p, f);
      await runCells(cells, { dir, phase: f.phase || sub, adapters, regimes: f.regimes ? f.regimes.split(',') : RECORDED, fit: sub === 'sweep' && !f['no-fit'], idleOf, origin: srv.origin });
      return 0;
    }
    if (sub === 'draws') {
      // --shard i/n: record every n-th draw in this process (parallel hx recording, speed-up E; hx is deterministic under
      // load). Each shard logs its takes to its own file.
      const [si, sn] = (f.shard || '0/1').split('/').map(Number);
      await runCells(p.draws.filter((_, j) => j % sn === si), { dir, phase: sn > 1 ? `draws-s${si}` : 'draws', adapters, idleOf, origin: srv.origin, fit: !f['no-fit'] });
      return 0;
    }
    if (sub === 'determinism') {
      // A1.5: K runs per stratum cell per regime; run 0 is the sweep take, runs 1..K-1 are extra (digest only)
      const K = f.k ? Object.fromEntries(f.k.split(',').map((s) => s.split(':')).map(([r, k]) => [r, +k])) : p.K;
      const file = path.join(dir, 'determinism.jsonl'); const A = Object.fromEntries(adapters.map((a) => [a.name, a]));
      // A1.5 escalation: every cell of an escalated route, K = 5 at every regime
      let n = 0; const strat = new Set(p.stratum.map((c) => c.key));
      const cells = select({ ...p, cells: [...p.stratum, ...p.cells.filter((c) => ESCALATED.has(c.route) && !strat.has(c.key))] }, f);
      for (const c of cells) for (const reg of RECORDED) for (let i = 1; i < (ESCALATED.has(c.route) ? 5 : (K[reg] || 1)); i++) {
        if (hasTake(dir, c, reg, i)) continue;
        const m = await recordTake(A[c.group], c, reg, { origin: srv.origin, outRoot: dir, runIndex: i });
        appendJsonl(file, m); n++;
        if (n % 20 === 0) log(`determinism ${n} runs, last ${c.key} ${reg}#${i} ${m.wallMs} ms`);
      }
      log(`determinism: ${n} new runs`); return 0;
    }
    if (sub === 'check') {
      // A1.5 cross-session check: re-record a seeded 10 % sample of all cells (+ extra routes) and compare digests
      const rnd = mulberry32(+(f.seed || 20261016)); const routes = (f.routes || '').split(',').filter(Boolean);
      // --shard i/n: re-record every n-th sampled cell in this process (the sample itself does not depend on the shard)
      const [si, sn] = (f.shard || '0/1').split('/').map(Number);
      const sample = p.cells.filter((c) => routes.includes(c.route) || rnd() < 0.1).filter((_, j) => j % sn === si);
      const file = path.join(dir, `check-${f.label || 'x'}${sn > 1 ? `-s${si}` : ''}.jsonl`); const A = Object.fromEntries(adapters.map((a) => [a.name, a]));
      let same = 0, diff = 0;
      for (const c of sample) for (const reg of (f.regimes ? f.regimes.split(',') : RECORDED)) {
        if (!hasTake(dir, c, reg)) continue;
        const ref = readMeta(dir, c, reg);
        const m = await recordTake(A[c.group], c, reg, { origin: srv.origin, outRoot: dir, runIndex: 0, write: false });
        const eq = m.digest === ref.digest; eq ? same++ : diff++;
        appendJsonl(file, { key: c.key, regime: reg, ref: ref.digest, now: m.digest, equal: eq, wallMs: m.wallMs });
        if (!eq) log(`check DIFF ${c.key} ${reg}`);
      }
      log(`check: ${same} equal, ${diff} different (${sample.length} cells)`); console.log(JSON.stringify({ cells: sample.length, same, diff })); return diff ? 1 : 0;
    }
    if (sub === 'score') {
      // re-fit + re-score stored takes (after a fitter revision; A1.6 j)
      // --shard i/n: this process scores every n-th cell (parallel scoring of stored takes; CPU only)
      const phase = f.phase || 'sweep'; const cells0 = phase === 'draws' ? p.draws : select(p, f);
      // --queue <name> --worker <id>: dynamic sharding — each worker claims the next unscored cell (an atomic mkdir under
      // <run>/<name>/), so workers can be added or stopped (<run>/<name>/STOP) as the machine's load allows; every worker
      // appends to its own `<phase>-rescore-q<id>.jsonl` and marks a claimed cell done after its results are written
      const qdir = f.queue ? path.join(dir, String(f.queue)) : null;
      const [si, sn] = qdir ? [0, 1] : (f.shard || '0/1').split('/').map(Number); const cells = cells0.filter((_, j) => j % sn === si);
      const resFile = path.join(dir, `${phase}${f.suffix || '-rescore'}${qdir ? `-q${f.worker ?? 0}` : sn > 1 ? `-s${si}` : ''}.jsonl`);
      if (qdir) fs.mkdirSync(qdir, { recursive: true }); else fs.rmSync(resFile, { force: true });
      // claims are named by the cell key, so runs with different --route filters share one queue
      const cname = (c) => `${phase}--${c.key.replace(/[^A-Za-z0-9._-]/g, '_')}`;
      const claim = (c) => { if (!qdir) return true; if (fs.existsSync(path.join(qdir, 'STOP'))) return null; try { fs.mkdirSync(path.join(qdir, cname(c))); return true; } catch { return false; } };
      let i = 0;
      for (const [j, c] of cells.entries()) {
        i++; if (!hasTake(dir, c, 'R2')) continue;
        const cl = claim(c); if (cl === null) { log('STOP: exiting before the next claim'); break; } if (!cl) continue;
        const idle = idleOf(c);
        const res = await fitAndScore(c, dir, { idleCell: idle && idle.key !== c.key ? idle : null });
        for (const r of res) appendJsonl(resFile, r);
        if (qdir) { fs.writeFileSync(path.join(qdir, cname(c), 'done'), ''); log(`score ${phase} cell ${j + 1}/${cells.length} ${c.key} done`); }
        else if (i % 25 === 0) log(`score ${i}/${cells.length}`);
      }
      return 0;
    }
    if (sub === 'report') {
      const { buildReport } = await import('./report.js');
      const rep = buildReport({ dir, plan: p, files: (f.files || 'sweep,draws').split(','), revisions: f.revisions != null ? +f.revisions : null });
      console.log(rep.summary); return rep.pass ? 0 : 1;
    }
  } finally { await srv.close(); }
  console.error('usage: reva lab <plan|probe|parity|sweep|draws|determinism|check|score|report> [--run name] [--group g] [--route r] [--default] [--regimes R2,R3]');
  return 2;
}

export { takeDir };
