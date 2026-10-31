// Text summary of a score record (summary-first, REA pattern). Every number is printed with its self-band (layer 1)
// or its floor (pooled score); a number without a measured band says "band unmeasured".
const f = (x, d = 3) => (x == null || !Number.isFinite(x) ? 'n/a' : Math.abs(x) >= 1000 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(2) : x.toFixed(d));
const band = (b) => (b == null ? 'band unmeasured' : `band ${f(b)}`);
const UNITS = { lag: 'ms', t10: 'ms', t50: 'ms', t90: 'ms', t99: 'ms', peakVel: 'rel', amplitude: 'of A', overshoot: 'of A', crossings: 'n', maxAbs: 'of A', rms: 'of A', rangeShiftVh: 'vh', mapShape: 'of A' };

export function formatScore(rec, { maxEvents = 4 } = {}) {
  const L = [];
  L.push(`score ${rec.schema}  pooling Minkowski beta=${rec.pooling.beta}, S = exp(-E^3)  layer 2 PROVISIONAL (${rec.provisional.note})`);
  for (const r of rec.refused) L.push(`REFUSED ${r.arm}: ${r.reasons.map(x => `${x.field}: ${x.why}`).join('; ')}`);
  for (const m of rec.mechanisms) {
    if (m.refused) { L.push(`- ${m.id}: refused (${m.refused})`); continue; }
    const fl = m.floor && !m.floor.unmeasured ? `floor ${f(m.floor.mean, 4)} ± ${f(m.floor.sd, 4)} (n ${m.floor.n})` : 'floor unmeasured';
    L.push(`- ${m.id}: S ${f(m.pooled.score, 4)} (${fl})  E ${f(m.pooled.E)} JND  layer1 ${m.verdict.layer1}  layer2 ${m.verdict.layer2} (provisional)${m.unscorable ? '  UNSCORABLE: ' + m.unscorable : ''}`);
    if (m.lag) L.push(`    lag channel: worst Δ ${f(m.lag.worstDeltaMs, 2)} ms (${band(m.lag.worstBandMs)})`);
    for (const p of m.pairs) {
      if (p.sweep && p.sweep.diffs) for (const d of p.sweep.diffs) L.push(`    sweep ${p.pair.src}: ${d.cue} Δ ${f(d.delta, 4)} ${UNITS[d.cue] || ''} (${band(d.band)})${d.e != null ? `  ${f(d.e)} JND ${d.layer2}` : ''}`);
      const evs = (p.response && p.response.events) || [];
      let shown = 0;
      for (const ev of evs) {
        const diffs = ev.diffs.filter(d => d.layer1 !== 'identical');
        if (!diffs.length) continue;
        if (shown++ >= maxEvents) { L.push(`    response ${p.pair.src}: … ${evs.length - maxEvents} more events with differences`); break; }
        L.push(`    response ${p.pair.src} input#${ev.i} (${ev.kind}): ` + diffs.map(d => `${d.cue} Δ ${f(d.delta)} ${UNITS[d.cue] || ''} (${band(d.band)})${d.e != null ? ` ${f(d.e, 2)}JND` : ''}`).join('; '));
      }
    }
  }
  return L.join('\n');
}
