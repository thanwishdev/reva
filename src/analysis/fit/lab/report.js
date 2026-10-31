// Lab report (design §13): confusion matrix, per-(route, regime) metric tables, integrator table, calibration
// coverage, confident-wrong rate, determinism and parity tables → JSON + Markdown under the private output root.
import fs from 'node:fs';
import path from 'node:path';

const pct = (a, b) => (b ? (100 * a) / b : null);
const fmt = (x, d = 1) => (x == null ? 'n/a' : x.toFixed(d));

/**
 * @param {object[]} cells   scoreFitted() results
 * @param {{determinism?: {cell:string, digests:string[]}[], parity?: {cell:string, ok:boolean}[], revisions?: number}} [extra]
 */
export function aggregate(cells, extra = {}) {
  const regimes = [...new Set(cells.map((c) => c.regime))].sort();
  const conf = cells.flatMap((c) => c.confusion.map((x) => ({ ...x, regime: c.regime, route: c.route })));
  const matrix = {}; for (const x of conf) { const t = x.negative ? `neg:${x.truth}` : x.truth; matrix[t] = matrix[t] || {}; matrix[t][x.pred] = (matrix[t][x.pred] || 0) + 1; }
  const classAcc = (sub) => pct(sub.filter((x) => x.correct).length, sub.length);
  const rows = cells.flatMap((c) => c.rows.map((r) => ({ ...r, regime: c.regime, route: c.route })));
  const byMetric = {}; for (const r of rows) { const k = `${r.route}|${r.regime}|${r.metric}`; const b = byMetric[k] || (byMetric[k] = { route: r.route, regime: r.regime, metric: r.metric, n: 0, pass: 0, abstain: 0, maxErr: 0 }); b.n++; if (r.pass) b.pass++; if (r.abstain) b.abstain++; if (Number.isFinite(r.err)) b.maxErr = Math.max(b.maxErr, r.err); }
  const integ = rows.filter((r) => r.metric === 'integrator');
  const inSet = integ.filter((r) => !r.outOfSet);
  const calib = cells.flatMap((c) => c.calib.map((x) => ({ ...x, regime: c.regime })));
  const withCI = calib.filter((x) => x.covered != null);
  const cover = (sub) => pct(sub.filter((x) => x.covered).length, sub.length);
  const cw = (sub) => pct(sub.filter((x) => x.confidentWrong).length, sub.length);
  const neg = rows.filter((r) => r.metric === 'negatives');
  const det = extra.determinism || []; const detFail = det.filter((d) => new Set(d.digests).size !== 1);
  const par = extra.parity || []; const parFail = par.filter((p) => !p.ok);
  const gate = {
    class: { value: classAcc(conf), pass: classAcc(conf) >= 95, perRegime: Object.fromEntries(regimes.map((g) => [g, classAcc(conf.filter((x) => x.regime === g))])) },
    attribution: (() => { const a = rows.filter((r) => r.metric === 'attribution'); return { value: pct(a.filter((r) => r.pass).length, a.length), pass: a.length > 0 && a.every((r) => r.pass) }; })(),
    integratorIdentified: { value: pct(inSet.filter((r) => r.pass).length, inSet.length), pass: inSet.length > 0 && pct(inSet.filter((r) => r.pass).length, inSet.length) >= 80 },
    integratorWrongConfident: { value: pct(integ.filter((r) => r.wrongConfident).length, integ.length), pass: integ.length > 0 && pct(integ.filter((r) => r.wrongConfident).length, integ.length) <= 5 },
    negatives: { value: pct(neg.filter((r) => r.pass).length, neg.length), pass: neg.length > 0 && pct(neg.filter((r) => r.pass).length, neg.length) >= 95, falseSpringEma: pct(neg.filter((r) => r.falseSpringEma).length, neg.length) },
    calibration: { value: cover(withCI), pass: withCI.length > 0 && cover(withCI) >= 90 && cover(withCI) <= 99, n: withCI.length, withoutCI: calib.length - withCI.length, perRegime: Object.fromEntries(regimes.map((g) => [g, cover(withCI.filter((x) => x.regime === g))])) },
    confidentWrong: { value: cw(calib), pass: calib.length > 0 && cw(calib) <= 2 && regimes.every((g) => (cw(calib.filter((x) => x.regime === g)) ?? 0) <= 2), perRegime: Object.fromEntries(regimes.map((g) => [g, cw(calib.filter((x) => x.regime === g))])) },
    determinism: { cells: det.length, failing: detFail.map((d) => d.cell), pass: det.length > 0 && detFail.length === 0 },
    parity: { cells: par.length, invalid: parFail.map((p) => p.cell), pass: par.length > 0 && parFail.length === 0 },
  };
  // per-metric rows must pass in every regime (A1.1 "per regime")
  const metricGate = {}; for (const b of Object.values(byMetric)) { const k = `${b.route}|${b.metric}`; const m = metricGate[k] || (metricGate[k] = { route: b.route, metric: b.metric, perRegime: {}, pass: true }); m.perRegime[b.regime] = `${b.pass}/${b.n}`; if (b.pass !== b.n) m.pass = false; }
  return { schema: 'reva.labreport/0', cells: cells.length, regimes, gate, metricGate: Object.values(metricGate), matrix, revisions: extra.revisions ?? null, fitMs: { total: cells.reduce((a, c) => a + (c.fitMs || 0), 0) } };
}

export function toMarkdown(rep) {
  const g = rep.gate; const L = [];
  L.push(`# Lab recovery report`, '', `cells ${rep.cells}, regimes ${rep.regimes.join(', ')}, fitter revisions ${rep.revisions ?? 'n/a'}`, '');
  L.push('| Gate row | Value | Pass |', '|---|---|---|');
  L.push(`| class correct (≥ 95 %) | ${fmt(g.class.value)} % (${Object.entries(g.class.perRegime).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}) | ${g.class.pass} |`);
  L.push(`| attribution (100 %) | ${fmt(g.attribution.value)} % | ${g.attribution.pass} |`);
  L.push(`| M07 integrator identified (≥ 80 %) | ${fmt(g.integratorIdentified.value)} % | ${g.integratorIdentified.pass} |`);
  L.push(`| M07 wrong-confident (≤ 5 %) | ${fmt(g.integratorWrongConfident.value)} % | ${g.integratorWrongConfident.pass} |`);
  L.push(`| negatives (≥ 95 %; false spring/EMA ≤ 5 %) | ${fmt(g.negatives.value)} % / ${fmt(g.negatives.falseSpringEma)} % | ${g.negatives.pass} |`);
  L.push(`| calibration coverage (90–99 %) | ${fmt(g.calibration.value)} % (n ${g.calibration.n}, ${g.calibration.withoutCI} values without CI) | ${g.calibration.pass} |`);
  L.push(`| confident-wrong (≤ 2 % pooled and per regime) | ${fmt(g.confidentWrong.value, 2)} % | ${g.confidentWrong.pass} |`);
  L.push(`| determinism (bit-identical) | ${g.determinism.cells} cells, ${g.determinism.failing.length} failing | ${g.determinism.pass} |`);
  L.push(`| parity (0 invalid cells) | ${g.parity.cells} cells, ${g.parity.invalid.length} invalid | ${g.parity.pass} |`, '');
  L.push('## Per-metric rows (pass/n per regime)', '', '| Route | Metric | Per regime | Pass |', '|---|---|---|---|');
  for (const m of rep.metricGate) L.push(`| ${m.route} | ${m.metric} | ${Object.entries(m.perRegime).map(([k, v]) => `${k} ${v}`).join(', ')} | ${m.pass} |`);
  L.push('', '## Confusion matrix (truth → predicted counts)', '');
  for (const [t, row] of Object.entries(rep.matrix)) L.push(`- ${t}: ${Object.entries(row).map(([p, n]) => `${p} ${n}`).join(', ')}`);
  return L.join('\n') + '\n';
}

/** Write report.json + report.md to `outDir` (must be the private output root, H2) and return a summary line. */
export function writeReport(rep, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(rep, null, 1));
  fs.writeFileSync(path.join(outDir, 'report.md'), toMarkdown(rep));
  const g = rep.gate;
  return `class ${fmt(g.class.value)}% · integrator ${fmt(g.integratorIdentified.value)}% (wrong-confident ${fmt(g.integratorWrongConfident.value)}%) · negatives ${fmt(g.negatives.value)}% · calibration ${fmt(g.calibration.value)}% · confident-wrong ${fmt(g.confidentWrong.value, 2)}%`;
}
