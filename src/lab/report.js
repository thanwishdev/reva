// Lab gate report (PLAN §4 M2 DONE WHEN, D-M2-2 G1-4 §8.2 + Amendment 1). Reads the scored cells (sweep + confirmation
// draws), the take metas (parity, pixel NRMSE, settle timeouts) and the determinism runs; writes report.json and
// report.md to the private output root (H2) and returns a summary. Every row is computed per regime and pooled.
import fs from 'node:fs';
import path from 'node:path';
import { RECORDED, ESCALATED } from './runner.js';
import { DESIGNED_TRACE } from '../analysis/fit/lab/metrics.js';

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const pct = (a, b) => (b ? (100 * a) / b : null);
const f1 = (x, d = 1) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));
const REGS = ['R2', 'R3', 'R4', 'R5', 'R6'];

/** Latest result per (key, regime) across the given result files (later files win: a rescore replaces the sweep). */
function loadResults(dir, files) {
  const by = new Map();
  for (const name of files) {
    // a rescore (after a fitter revision) replaces the inline sweep results entirely
    const all = fs.readdirSync(dir); const rs = all.filter((f) => f.startsWith(`${name}-rescore`) && f.endsWith('.jsonl'));
    for (const f of (rs.length ? rs : all.filter((f) => f === `${name}.jsonl`)).sort()) for (const r of readJsonl(path.join(dir, f))) by.set(`${r.key}|${r.regime}`, r);
  }
  return [...by.values()];
}

function walkMetas(dir) {
  const out = []; const root = path.join(dir, 'takes');
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'meta.json') out.push(JSON.parse(fs.readFileSync(p, 'utf8'))); } };
  if (fs.existsSync(root)) walk(root); return out;
}

export function buildReport({ dir, plan, files = ['sweep', 'draws'], revisions = null }) {
  const want = new Set([...plan.cells, ...plan.draws].map((c) => c.key));
  const res = loadResults(dir, files).filter((r) => want.has(r.key));
  const errors = res.filter((r) => r.error);
  const ok = res.filter((r) => !r.error);
  const metas = walkMetas(dir).filter((m) => want.has(m.key));
  const run0 = metas.filter((m) => m.runIndex === 0);
  // ---- parity (A1.6 f): every run-0 take of every gated cell
  const parFail = run0.filter((m) => !m.parity || !m.parity.pass);
  // ---- determinism (A1.5): stratum digests per (cell, regime)
  // A1.5: the stratum, plus every cell of an escalated route (K = 5 at every regime)
  const esc = new Set(plan.cells.filter((c) => ESCALATED.has(c.route)).map((c) => c.key));
  const strat = new Set([...plan.stratum.map((c) => c.key), ...esc]);
  const det = new Map(); for (const m of metas) { if (!strat.has(m.key)) continue; const k = `${m.key}|${m.regime}`; const d = det.get(k) || []; d.push(m.digest); det.set(k, d); }
  const detRows = [...det.entries()].map(([k, d]) => ({ cell: k, runs: d.length, distinct: new Set(d).size, need: esc.has(k.split('|')[0]) ? 5 : plan.K ? plan.K[k.split('|').pop()] : 5 }));
  const detFail = detRows.filter((r) => r.distinct !== 1);
  const detShort = detRows.filter((r) => r.runs < r.need);
  // cross-session check (A1.5): re-recorded seeded sample vs the stored takes
  const chk = fs.readdirSync(dir).filter((f) => /^check-.*\.jsonl$/.test(f)).flatMap((f) => readJsonl(path.join(dir, f)));
  const chkDiff = chk.filter((c) => !c.equal);
  // ---- classification
  const conf = ok.flatMap((r) => (r.confusion || []).map((x) => ({ ...x, regime: r.regime, route: r.route, kind: r.kind })));
  const acc = (sub) => pct(sub.filter((x) => x.correct).length, sub.length);
  const perReg = (sub, fn) => Object.fromEntries(REGS.map((g) => [g, fn(sub.filter((x) => x.regime === g))]));
  const rows = ok.flatMap((r) => (r.rows || []).map((x) => ({ ...x, regime: r.regime, route: r.route, kind: r.kind, key: r.key })));
  // A1.3: M07x (out-of-set integrators) counts only toward the M07 wrong-confident rate and the global confident-wrong
  // rate; its own k/c/replay/tag rows are reported, not gated
  const rowsOf = (m) => rows.filter((x) => x.metric === m && !(x.route === 'm07x' && m !== 'integrator'));
  const passPct = (sub) => pct(sub.filter((x) => x.pass).length, sub.length);
  const allPass = (sub) => sub.length > 0 && sub.every((x) => x.pass);
  const negs = rowsOf('negatives');
  const integ = rowsOf('integrator'); const inSet = integ.filter((x) => !x.outOfSet);
  const calib = ok.flatMap((r) => (r.calib || []).map((x) => ({ ...x, regime: r.regime, route: r.route }))); const withCI = calib.filter((x) => x.covered != null && x.route !== 'm07x');   // A1.3: M07x counts toward wrong-confident and confident-wrong only
  const cover = (sub) => pct(sub.filter((x) => x.covered).length, sub.length);
  const cw = (sub) => pct(sub.filter((x) => x.confidentWrong).length, sub.length);
  // ---- M14 pixel row (measured by the runner from the take vs the analytic projection)
  const pix = run0.filter((m) => m.key.includes('/m14/') || m.key.includes('/m14b/')).flatMap((m) => Object.entries((m.parity && m.parity.pixel) || {}).map(([k, v]) => ({ key: m.key, regime: m.regime, marker: k, ...v })));
  const m14dom = conf.filter((x) => (x.route === 'm14' || x.route === 'm14b') && x.target === 'dom');
  const gate = {
    class: { value: acc(conf), perRegime: perReg(conf, acc), n: conf.length, pass: conf.length > 0 && REGS.every((g) => { const v = acc(conf.filter((x) => x.regime === g)); return v == null || v >= 95; }) && acc(conf) >= 95 },
    attribution: { value: passPct(rowsOf('attribution')), perRegime: perReg(rowsOf('attribution'), passPct), n: rowsOf('attribution').length, pass: allPass(rowsOf('attribution')) },
    alpha: { value: passPct(rowsOf('alpha')), perRegime: perReg(rowsOf('alpha'), passPct), n: rowsOf('alpha').length, pass: allPass(rowsOf('alpha')) },
    integratorIdentified: { value: pct(inSet.filter((x) => x.pass).length, inSet.length), perRegime: perReg(inSet, (s) => pct(s.filter((x) => x.pass).length, s.length)), n: inSet.length, pass: inSet.length > 0 && REGS.every((g) => { const s = inSet.filter((x) => x.regime === g); return !s.length || pct(s.filter((x) => x.pass).length, s.length) >= 80; }) },
    integratorWrongConfident: { value: pct(integ.filter((x) => x.wrongConfident).length, integ.length), n: integ.length, pass: integ.length > 0 && pct(integ.filter((x) => x.wrongConfident).length, integ.length) <= 5 },
    springReplayKc: { replay: passPct(rowsOf('spring_replay_nrmse')), k: passPct(rowsOf('k')), c: passPct(rowsOf('c')), analyticTag: passPct(rowsOf('analytic.valid_for_reproduction_only')), n: rowsOf('spring_replay_nrmse').length,
      pass: allPass(rowsOf('spring_replay_nrmse')) && allPass(rowsOf('k')) && allPass(rowsOf('c')) && rowsOf('analytic.valid_for_reproduction_only').every((x) => x.pass) },
    m08: { omega: passPct(rows.filter((x) => x.route === 'm08' && x.metric === 'omega')), zeta: passPct(rows.filter((x) => x.route === 'm08' && x.metric === 'zeta')), overshoot: passPct(rows.filter((x) => x.route === 'm08' && x.metric === 'overshoot')),
      n: rows.filter((x) => x.route === 'm08' && x.metric === 'omega').length, pass: ['omega', 'zeta', 'overshoot'].every((m) => allPass(rows.filter((x) => x.route === 'm08' && x.metric === m))) },
    m10: { friction: passPct(rowsOf('friction')), stopping: passPct(rowsOf('stopping')), n: rowsOf('friction').length, pass: allPass(rowsOf('friction')) && allPass(rowsOf('stopping')) },
    m14: { maxNrmseDiag: pix.length ? Math.max(...pix.map((p) => p.nrmseDiag ?? Infinity)) : null, n: pix.length, domNotApplicable: passPct(m14dom.map((x) => ({ pass: x.correct }))), pass: pix.length > 0 && pix.every((p) => p.nrmseDiag != null && p.nrmseDiag <= 0.01) && m14dom.length > 0 && m14dom.every((x) => x.correct) },
    negatives: { value: passPct(negs), perRegime: perReg(negs, passPct), falseSpringEma: pct(negs.filter((x) => x.falseSpringEma).length, negs.length), n: negs.length, pass: negs.length > 0 && passPct(negs) >= 95 && pct(negs.filter((x) => x.falseSpringEma).length, negs.length) <= 5 },
    confidentWrong: { value: cw(calib), perRegime: perReg(calib, cw), n: calib.length, pass: calib.length > 0 && cw(calib) <= 2 && REGS.every((g) => (cw(calib.filter((x) => x.regime === g)) ?? 0) <= 2) },
    // A1.6 d: coverage 90–99 % pooled AND per regime (the attempt-2 report gated the pooled value only; D-M2-11)
    calibration: { value: cover(withCI), perRegime: perReg(withCI, cover), n: withCI.length, withoutCI: calib.length - withCI.length,
      pass: withCI.length > 0 && cover(withCI) >= 90 && cover(withCI) <= 99 && REGS.every((g) => { const v = cover(withCI.filter((x) => x.regime === g)); return v == null || (v >= 90 && v <= 99); }) },
    determinism: { cells: detRows.length, failing: detFail.length, short: detShort.length, crossSession: { takes: chk.length, different: chkDiff.length, cells: [...new Set(chkDiff.map((c) => c.key))].slice(0, 40) },
      pass: detRows.length > 0 && detFail.length === 0 && detShort.length === 0 && chkDiff.length === 0 },
    parity: { takes: run0.length, invalid: parFail.length, pass: run0.length > 0 && parFail.length === 0 },
  };
  // per-metric rows (route × metric, pass/n per regime)
  // Amendment 2 B: a scorer-certified abstention passes, except on the trace designed to measure the row, where every
  // item must pass on the registered tolerance; each (route, row, regime) must hold ≥ 1 designed-trace item
  const variantOf = (key) => String(key).split('/').pop();
  const designedFor = (x) => (DESIGNED_TRACE[x.route] && DESIGNED_TRACE[x.route][x.metric]) || null;
  for (const x of rows) { x.designed = designedFor(x) ? variantOf(x.key) === designedFor(x) : true; if (x.certified && x.designed && !x.unobservableAnywhere) x.pass = false; }
  const mg = new Map();
  for (const x of rows) { if (/_info$/.test(x.metric) || x.route === 'm07x') continue; const k = `${x.route}|${x.metric}`; const g = mg.get(k) || { route: x.route, metric: x.metric, perRegime: {}, n: 0, pass: 0, certified: 0, designedPerRegime: {} }; const pr = g.perRegime[x.regime] || (g.perRegime[x.regime] = [0, 0]); pr[1]++; g.n++; if (x.pass) { pr[0]++; g.pass++; } if (x.certified && x.pass) g.certified++; if (x.designed) g.designedPerRegime[x.regime] = (g.designedPerRegime[x.regime] || 0) + 1; mg.set(k, g); }
  const metricRows = [...mg.values()].sort((a, b) => a.route.localeCompare(b.route) || a.metric.localeCompare(b.metric));
  // a row's registered pass rule: every item, except the integrator row, whose registered rule is a rate (≥ 80 %
  // identified per regime; its wrong-confident rate is gated by its own row)
  for (const m of metricRows) {
    const regs = Object.keys(m.perRegime);
    m.rule = m.metric === 'integrator' ? '≥ 80 % per regime' : 'every item';
    m.ok = m.metric === 'integrator' ? regs.every((g) => m.perRegime[g][0] >= 0.8 * m.perRegime[g][1]) : m.pass === m.n;
    m.designedMissing = DESIGNED_TRACE[m.route] && DESIGNED_TRACE[m.route][m.metric] ? regs.filter((g) => g !== 'R6' && !m.designedPerRegime[g]) : [];
    if (m.designedMissing.length) m.ok = false;
  }
  const classByRoute = {}; for (const x of conf) { const c = classByRoute[x.route] || (classByRoute[x.route] = { n: 0, ok: 0, perRegime: {} }); c.n++; if (x.correct) c.ok++; const pr = c.perRegime[x.regime] || (c.perRegime[x.regime] = [0, 0]); pr[1]++; if (x.correct) pr[0]++; }
  const matrix = {}; for (const x of conf) { const t = x.negative ? `neg:${x.truth}` : x.truth; matrix[t] = matrix[t] || {}; matrix[t][x.pred] = (matrix[t][x.pred] || 0) + 1; }
  const fitMs = ok.reduce((a, r) => a + (r.fitMs || 0), 0);
  const settleTimeouts = metas.reduce((a, m) => a + (m.settleTimeouts || 0), 0);
  const wall = { takes: metas.length, recordMs: metas.reduce((a, m) => a + (m.wallMs || 0), 0) };
  // every registered metric row must pass in every regime (G1-4 §8.2 "all must hold across the sweep, per regime";
  // A1.1). The specific rows above are summaries; this row gates the rest (M01 endpoints, M05 latch/duration, τ, laws …)
  const regFail = metricRows.filter((m) => !m.ok);
  gate.registeredRows = { rows: metricRows.length, failing: regFail.length, certifiedItems: metricRows.reduce((a, m) => a + m.certified, 0), unobservableAnywhere: rows.filter((x) => x.unobservableAnywhere && x.pass && !/_info$/.test(x.metric)).length, failingRows: regFail.map((m) => `${m.route} ${m.metric} ${m.pass}/${m.n}${m.designedMissing.length ? ' (no designed-trace item at ' + m.designedMissing.join(',') + ')' : ''}`), pass: metricRows.length > 0 && regFail.length === 0 };
  const gateKeys = Object.keys(gate); const pass = gateKeys.every((k) => gate[k].pass);
  const rep = { schema: 'reva.labreport/1', at: new Date().toISOString(), protocol: plan.protocol || null, reductions: plan.reductions, cells: { sweep: plan.cells.length, draws: plan.draws.length, stratum: plan.stratum.length },
    scored: { results: res.length, errors: errors.length, errorSample: errors.slice(0, 10).map((e) => `${e.key} ${e.regime}: ${String(e.error).slice(0, 200)}`) },
    gate, pass, classByRoute, metricRows, matrix, revisions, fitMs, settleTimeouts, wall, parityFailures: parFail.slice(0, 30).map((m) => ({ key: m.key, regime: m.regime, bad: m.parity && (m.parity.bad || m.parity.error) })),
    determinismFailures: detFail.slice(0, 30), determinismShort: detShort.length };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(rep, null, 1));
  fs.writeFileSync(path.join(dir, 'report.md'), toMarkdown(rep));
  rep.summary = `lab gate ${pass ? 'PASS' : 'FAIL'} · class ${f1(gate.class.value)}% · attribution ${f1(gate.attribution.value)}% · α ${f1(gate.alpha.value)}% · M07 identified ${f1(gate.integratorIdentified.value)}% (wrong-confident ${f1(gate.integratorWrongConfident.value)}%) · negatives ${f1(gate.negatives.value)}% · confident-wrong ${f1(gate.confidentWrong.value, 2)}% · calibration ${f1(gate.calibration.value)}% · determinism ${gate.determinism.failing} failing/${gate.determinism.cells} · parity ${gate.parity.invalid} invalid/${gate.parity.takes} → ${path.join(dir, 'report.md')}`;
  return rep;
}

function toMarkdown(rep) {
  const g = rep.gate; const L = []; const pr = (o) => Object.entries(o || {}).filter(([, v]) => v != null).map(([k, v]) => `${k} ${f1(v)}`).join(', ');
  L.push('# M2 lab gate report', '', `${rep.at} · protocol ${rep.protocol || 'n/a'} · reductions ${rep.reductions.join('+') || 'none'} · sweep cells ${rep.cells.sweep}, draws ${rep.cells.draws}, determinism stratum ${rep.cells.stratum} · scored results ${rep.scored.results} (${rep.scored.errors} errors) · fitter revisions ${rep.revisions ?? 'n/a'}`, '');
  L.push('| Gate row (registered) | Measured | Pass |', '|---|---|---|');
  L.push(`| class ≥ 95 % (pooled and per regime) | ${f1(g.class.value)} % of ${g.class.n} items (${pr(g.class.perRegime)}) | ${g.class.pass} |`);
  L.push(`| attribution 100 % on the attribution scene (M20) | ${f1(g.attribution.value)} % of ${g.attribution.n} | ${g.attribution.pass} |`);
  L.push(`| α ≤ 5 % (≤ 8 % q2, ≤ 3 % q3) | ${f1(g.alpha.value)} % of ${g.alpha.n} rows pass (${pr(g.alpha.perRegime)}) | ${g.alpha.pass} |`);
  L.push(`| M07 integrator identified ≥ 80 % | ${f1(g.integratorIdentified.value)} % of ${g.integratorIdentified.n} (${pr(g.integratorIdentified.perRegime)}) | ${g.integratorIdentified.pass} |`);
  L.push(`| M07 wrong-confident ≤ 5 % | ${f1(g.integratorWrongConfident.value)} % of ${g.integratorWrongConfident.n} | ${g.integratorWrongConfident.pass} |`);
  L.push(`| spring replay NRMSE ≤ 0.005, k, c ≤ 5 % (identified); analytic tag | replay ${f1(g.springReplayKc.replay)} %, k ${f1(g.springReplayKc.k)} %, c ${f1(g.springReplayKc.c)} %, tag ${f1(g.springReplayKc.analyticTag)} % | ${g.springReplayKc.pass} |`);
  L.push(`| M08 ω, ζ ≤ 5 %, overshoot ≤ 0.02 A | ω ${f1(g.m08.omega)} %, ζ ${f1(g.m08.zeta)} %, overshoot ${f1(g.m08.overshoot)} % of ${g.m08.n} | ${g.m08.pass} |`);
  L.push(`| M10 friction ≤ 5 %, stopping ≤ 3 % | friction ${f1(g.m10.friction)} %, stopping ${f1(g.m10.stopping)} % of ${g.m10.n} | ${g.m10.pass} |`);
  L.push(`| M14 marker NRMSE ≤ 0.01 diagonal; DOM "not applicable" | max ${g.m14.maxNrmseDiag == null ? 'n/a' : g.m14.maxNrmseDiag.toExponential(2)} over ${g.m14.n}; DOM n/a ${f1(g.m14.domNotApplicable)} % | ${g.m14.pass} |`);
  L.push(`| negatives ≥ 95 %; false spring/EMA ≤ 5 % | ${f1(g.negatives.value)} % / ${f1(g.negatives.falseSpringEma)} % of ${g.negatives.n} | ${g.negatives.pass} |`);
  L.push(`| confident-wrong ≤ 2 % (pooled and per regime) | ${f1(g.confidentWrong.value, 2)} % of ${g.confidentWrong.n} (${pr(g.confidentWrong.perRegime)}) | ${g.confidentWrong.pass} |`);
  L.push(`| calibration coverage 90–99 % (pooled and per regime) | ${f1(g.calibration.value)} % of ${g.calibration.n} (${pr(g.calibration.perRegime)}; ${g.calibration.withoutCI} fitted values without CI) | ${g.calibration.pass} |`);
  L.push(`| determinism K runs bit-identical (A1.5) | ${g.determinism.failing} failing, ${g.determinism.short} short of K, of ${g.determinism.cells} (cell, regime); cross-session ${g.determinism.crossSession.different} different of ${g.determinism.crossSession.takes} re-recorded takes | ${g.determinism.pass} |`);
  L.push(`| every registered metric row passes in every regime (§8.2, A1.1; A2-B certified abstentions ${g.registeredRows.certifiedItems}, never on the designed trace except ${g.registeredRows.unobservableAnywhere} corner(s) at the scroll minimum, judgement D-M2-12) | ${g.registeredRows.failing} failing of ${g.registeredRows.rows} (route × metric)${g.registeredRows.failing ? ': ' + g.registeredRows.failingRows.join('; ') : ''} | ${g.registeredRows.pass} |`);
  L.push(`| refsim parity, 0 invalid cells (A1.6 f) | ${g.parity.invalid} invalid of ${g.parity.takes} takes | ${g.parity.pass} |`, '');
  L.push('## Class by route (correct/n per regime)', '', '| Route | Pooled | Per regime |', '|---|---|---|');
  for (const [r, c] of Object.entries(rep.classByRoute).sort()) L.push(`| ${r} | ${c.ok}/${c.n} | ${Object.entries(c.perRegime).sort().map(([k, v]) => `${k} ${v[0]}/${v[1]}`).join(', ')} |`);
  L.push('', '## Registered metric rows (pass/n per regime)', '', '| Route | Metric | Per regime | Certified (A2-B) | Rule | Pass |', '|---|---|---|---|---|---|');
  for (const m of rep.metricRows) L.push(`| ${m.route} | ${m.metric} | ${Object.entries(m.perRegime).sort().map(([k, v]) => `${k} ${v[0]}/${v[1]}`).join(', ')} | ${m.certified} | ${m.rule} | ${m.ok} |`);
  L.push('', '## Confusion (truth → predicted counts)', '');
  for (const [t, row] of Object.entries(rep.matrix)) L.push(`- ${t}: ${Object.entries(row).map(([p, n]) => `${p} ${n}`).join(', ')}`);
  if (rep.scored.errorSample.length) L.push('', '## Scoring errors (sample)', '', ...rep.scored.errorSample.map((e) => `- ${e}`));
  if (rep.parityFailures.length) L.push('', '## Parity failures (sample)', '', ...rep.parityFailures.map((p) => `- ${p.key} ${p.regime}: ${JSON.stringify(p.bad).slice(0, 200)}`));
  if (rep.determinismFailures.length) L.push('', '## Determinism failures (sample)', '', ...rep.determinismFailures.map((d) => `- ${d.cell}: ${d.distinct} distinct digests over ${d.runs} runs`));
  return L.join('\n') + '\n';
}

export { RECORDED };
