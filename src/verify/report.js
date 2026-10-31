// Verify records -> the report's score input (src/report/scores.js): every number goes in with its self-band.
//   pooled score: band = the identity floor (mean ± 2 sd of run 0 vs run 1 of the source)
//   per pair: the worst cue |Δ| with the identity band of that cue; the lag channel with its own band (never aligned away)
export function toReportScore(r) {
  const pairs = (r.pairs || []).filter((p) => p.score != null);
  const worstPair = pairs.reduce((w, p) => (w == null || p.score < w.score ? p : w), null);
  const fl = worstPair && worstPair.floor && worstPair.floor.mean != null ? worstPair.floor : null;
  const channels = [];
  for (const p of pairs) {
    const w = (p.worst || [])[0];
    if (w) channels.push({ name: `${p.track} ${w.cue}`, value: w.delta, unit: w.cue === 'lag' || /^t\d/.test(w.cue) || w.cue === 'onset' || w.cue === 'duration' ? 'ms' : 'cue', selfBand: w.band != null ? { lo: -w.band, hi: w.band } : null });
  }
  const lags = pairs.map((p) => p.lag).filter(Boolean);
  const lag = lags.length ? lags.reduce((w, l) => (Math.abs(l.worstDeltaMs ?? 0) > Math.abs(w.worstDeltaMs ?? 0) ? l : w)) : null;
  return {
    id: r.id, kind: 'lab', verdict: r.verdict,
    score: worstPair ? { value: worstPair.score, selfBand: fl ? { lo: fl.mean - 2 * (fl.sd || 0), hi: Math.min(1, fl.mean + 2 * (fl.sd || 0)), sd: fl.sd } : null, unit: 'S = exp(-E^3)' } : undefined,
    channels,
    ...(lag ? { lag: { value: lag.worstDeltaMs, unit: 'ms', selfBand: lag.worstBandMs != null ? { lo: -lag.worstBandMs, hi: lag.worstBandMs } : null } } : {}),
    rate: { source: r.recorder ? `${r.recorder.lane} ${r.recorder.rate} Hz` : null, candidate: r.recorder ? `${r.recorder.lane} ${r.recorder.rate} Hz` : null },
    refused: r.error ? r.error.split('\n')[0] : null,
  };
}
