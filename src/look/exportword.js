// Look's export helpers, shared by look (look.json) and the motion card (src/card), which re-exports per law.
// Kept out of look/index.js so the card does not load the recorder.

/** asym smoothing with ONE direction seen is a one-rate smoothing (same law, other direction not exercised): export it so. */
export function asExportRecord(r) {
  const fam = r.model && r.model.family; if (!/^asym/.test(fam || '')) return r;
  const dt = r.model.valid_at && r.model.valid_at.refresh_hz ? 1000 / r.model.valid_at.refresh_hz : null; if (!dt) return r;
  const a = ['alphaUp', 'alphaDown'].map((k) => r.model.params[k]).filter((p) => p && p.value != null && p.value < 1);
  if (a.length !== 1 || (r.model.pinned && Object.values(r.model.pinned).includes(1))) return r;
  const tau = -dt / Math.log(1 - a[0].value);
  return { ...r, model: { ...r.model, family: 'ema (one direction seen)', params: { ...r.model.params, tau_ms: { value: tau, unit: 'ms', provenance: 'derived' } } } };
}
export const forExport = (res) => ({ ...res, records: res.records.map(asExportRecord) });

/**
 * A linear scroll map whose corner was not observed (no sample beyond it reads the plateau) is reported over the
 * scroll range that was sampled, never past it: the unobserved corner moves to the first / last sampled offset and the
 * value there is read off the fitted line. A fitted corner outside the samples (a reading-progress bar: width 127.9 ->
 * 1584 px over scroll 200 -> 2476 px, when the take saw 100 -> 2252 px and 63.9 -> 1440 px) is an extrapolation, and its
 * snippet would hold the wrong value over the part of the scroll it invented. The moved corner stays [unknown] (the ramp
 * may run on past the samples). Linear maps only (a curved shape cut at the samples is not the same shape).
 */
export function anchorMapToSamples(rec) {
  const m = rec && rec.model && rec.model.map; const loc = rec && rec.evidence && rec.evidence.location;
  if (!m || m.shape !== 'linear' || !loc || loc.kind !== 'scroll_range' || !Array.isArray(loc.range)) return rec;
  if ((rec.unknowns || []).some((u) => u.id === 'unk_map_range')) return rec;   // the ramp itself is not identified
  const [r0, r1] = loc.range; const { a, b, s0_px: s0, s1_px: s1 } = m;
  if (![r0, r1, a, b, s0, s1].every(Number.isFinite) || !(r1 > r0) || s1 === s0) return rec;
  const n0 = m.s0_provenance === 'unknown' && Math.abs(s0 - r0) > 0.5 ? r0 : s0;
  const n1 = m.s1_provenance === 'unknown' && Math.abs(s1 - r1) > 0.5 ? r1 : s1;
  if ((n0 === s0 && n1 === s1) || !(n1 > n0)) return rec;
  const line = (x) => a + b * (x - s0) / (s1 - s0);
  const na = line(n0); const nb = line(n1) - na;
  const vh = (px, old, oldPx) => (Number.isFinite(old) && oldPx ? old * px / oldPx : null);
  const map = { ...m, a: na, b: nb, s0_px: n0, s1_px: n1,
    ...(n0 !== s0 ? { s0_ci95: null, s0_vh: vh(n0, m.s0_vh, s0), s0_interval: [null, n0] } : {}),
    ...(n1 !== s1 ? { s1_ci95: null, s1_vh: vh(n1, m.s1_vh, s1), s1_interval: [n1, null] } : {}),
    anchored: { range: [r0, r1], fittedS0: s0, fittedS1: s1, why: 'a corner the samples did not reach is reported at the edge of the sampled scroll range, not extrapolated' } };
  const ps = { ...rec.model.params };
  const setP = (k, v, extra = {}) => { if (!ps[k]) return; const { ci95, withheld_value, reason, ...q } = ps[k]; ps[k] = { ...q, value: v, ...extra }; };
  // the values at the two ends are the fitted line read at offsets the take sampled: identified whenever the ramp is
  // (a withheld a / b was withheld only because it traded off against a corner beyond the samples)
  setP('mapA', na, { provenance: 'fitted' }); setP('mapB', nb, { provenance: 'fitted' });
  if (n0 !== s0) setP('mapS0', n0, { provenance: 'unknown', reason: `the ramp reaches back to the first sampled offset (${Math.round(r0)} px); where it starts is not identified` });
  if (n1 !== s1) setP('mapS1', n1, { provenance: 'unknown', reason: `the ramp reaches the last sampled offset (${Math.round(r1)} px); where it ends is not identified` });
  const unknowns = (rec.unknowns || []).map((u) => (u.id === 'unk_map_start' && n0 !== s0 ? { ...u, reason: `no sample below ${Math.round(r0)} px (the first sampled offset) reads the start plateau: where the ramp starts is not identified` }
    : u.id === 'unk_map_end' && n1 !== s1 ? { ...u, reason: `no sample past ${Math.round(r1)} px (the last sampled offset) reads the end plateau: where the ramp ends is not identified` } : u));
  return { ...rec, model: { ...rec.model, map, params: ps }, unknowns };
}

// shape parameters per export kind, as groups of alternatives (smoothing: τ or λ): an export built on a group whose
// values are all withheld is an "unknown model", whatever its error against the fit
const SHAPE = { spring: [['omega'], ['zeta']], smoothing: [['tau_ms', 'lambda']], tween: [['D'], ['x1'], ['y1'], ['x2'], ['y2']], 'scroll map': [['mapS0'], ['mapS1'], ['mapA'], ['mapB']] };
/**
 * The export's accuracy in look's words. "exact" stays reserved for values read from the page; a snippet that
 * reproduces a FITTED curve "matches fit" (the fit itself has its own labels), one built on withheld values is an
 * "unknown model", and a smoothing export says the rate it was measured at (one rate cannot tell per-frame from dt).
 */
export function exportWord(rec, it, x, rate) {
  if (!x.code) return { word: 'n/a', why: (x.accuracy && (x.accuracy.why || x.accuracy.label)) || null };
  const ps = (rec && rec.model && rec.model.params) || {};
  const withheld = (SHAPE[it.kind] || []).filter((g) => g.some((k) => ps[k]) && g.every((k) => !ps[k] || ps[k].value == null)).map((g) => { const k = g.find((n) => ps[n]); return [k, ps[k]]; });
  // a scroll map whose ramp the fit did not identify: no map parameters at all, or an end the fitter marks unknown with
  // no interval (a driver that took two values pins the two flat ends, never where or how the ramp runs between them)
  const mp = (rec && rec.model && rec.model.map) || {};
  const openEnds = it.kind === 'scroll map' ? ['s0', 's1'].filter((e) => mp[`${e}_provenance`] === 'unknown' && !Array.isArray(mp[`${e}_ci95`])) : [];
  const noParams = it.kind === 'scroll map' && !Object.keys(ps).length;
  if (!rec || rec.tier === 'unknown' || rec.tier === 'unexplained' || withheld.length || noParams || openEnds.length) {
    const mapWhy = noParams || openEnds.length ? [`ramp ${openEnds.length ? openEnds.map((e) => (e === 's0' ? 'start' : 'end')).join(' and ') : 'parameters'} not identified (no fitted value with an interval)${mp.anchored && openEnds.length ? `; the code covers the sampled scroll range ${Math.round(mp.anchored.range[0])}-${Math.round(mp.anchored.range[1])} px only` : ''}`] : [];
    const why = [...new Set([...withheld.map(([k, p]) => `${k}: ${p.reason || 'withheld'}`), ...mapWhy, ...(rec && rec.ambiguity ? ['class ambiguous'] : [])])].join('; ') || 'the fit did not establish this model';
    return { word: 'unknown model', why };
  }
  const acc = x.accuracy.label;
  if (it.kind === 'smoothing') return { word: `${acc === 'exact' ? 'matches fit' : acc} at ${rate} Hz`, why: `frame-rate behaviour unknown: recorded at ${rate} Hz only` };
  const word = acc === 'exact' ? (rec.tier === 'declared' ? 'as declared' : 'matches fit') : acc;
  const kc = ['k', 'c'].some((n) => ps[n] && ps[n].value == null);
  if (it.kind === 'spring' && kc && (x.form === 'physics' || x.lib === 'react-spring')) return { word, why: 'these stiffness / damping values reproduce the curve in this library; the site\'s own config values are unknown (integrator)' };
  return { word, why: null };
}
