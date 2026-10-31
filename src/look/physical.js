// Impossible values. Opacity lives in [0, 1]. A fit that ends a little outside (1.02: noise in the read-back, an overshooting
// curve fitted to a clipped channel) is clamped; one that ends clearly outside (a spring to -0.364) is a wrong model, not a
// fade: it is not exported and not printed as a law (an 'unexplained' record carrying the reason).
const OPACITY_CH = /^(drv|ren):opacity$/;
export const OPACITY_TOL = 0.05;   // beyond this, outside [0, 1] is not noise
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const outBy = (v) => (!Number.isFinite(v) ? 0 : v < 0 ? -v : v > 1 ? v - 1 : 0);

/** A record whose opacity values stay in [0, 1] (clamped when the excess is noise) or becomes unusable (unexplained, with the reason). */
export function guardPhysical(rec) {
  if (!rec || !rec.model || !rec.target || !OPACITY_CH.test(rec.target.channel || '')) return rec;
  const ps = rec.model.params || {}; const m = rec.model.map; const KEYS = ['from', 'to', 'x0', 'target'];
  const ends = [];   // every end value the record states
  for (const k of KEYS) { const v = ps[k] && (ps[k].value ?? ps[k].withheld_value); if (Number.isFinite(v)) ends.push([k, v]); }
  const kv = ps.keyframeValues && Array.isArray(ps.keyframeValues.value) ? ps.keyframeValues.value.map(Number) : null;
  if (kv) kv.forEach((v, i) => { if (Number.isFinite(v)) ends.push([`keyframe ${i + 1}`, v]); });
  if (m && Number.isFinite(m.a) && Number.isFinite(m.b)) { ends.push(['map start', m.a]); ends.push(['map end', m.a + m.b]); }
  const worst = ends.reduce((w, [k, v]) => (outBy(v) > outBy(w[1]) ? [k, v] : w), ['', 0]);
  const excess = outBy(worst[1]);
  if (!(excess > 0)) return rec;
  if (excess > OPACITY_TOL) {
    return { ...rec, tier: 'unexplained', model: { ...rec.model, family: null, was: rec.model.family }, physical: { unusable: true, at: worst[0], value: worst[1] },
      unknowns: [{ id: 'unk_impossible_value', kind: 'impossible value', reason: `the fit ends at opacity ${+worst[1].toPrecision(3)} (${worst[0]}), outside 0..1: not a physical opacity, so this model is not used`, probe: null }, ...(rec.unknowns || [])] };
  }
  const nps = { ...ps };
  for (const k of KEYS) if (nps[k] && Number.isFinite(nps[k].value)) nps[k] = { ...nps[k], value: clamp01(nps[k].value) };
  if (kv) nps.keyframeValues = { ...ps.keyframeValues, value: kv.map((v) => (Number.isFinite(v) ? clamp01(v) : v)) };
  let map = m;
  if (m && Number.isFinite(m.a) && Number.isFinite(m.b)) {
    const a = clamp01(m.a), b = clamp01(m.a + m.b) - a; map = { ...m, a, b };
    if (nps.mapA) nps.mapA = { ...nps.mapA, value: a };
    if (nps.mapB) nps.mapB = { ...nps.mapB, value: b };
  }
  return { ...rec, model: { ...rec.model, params: nps, ...(map ? { map } : {}) }, physical: { clamped: true, at: worst[0], value: worst[1] } };
}
