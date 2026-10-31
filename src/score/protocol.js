// Score calibration protocol (G1-4 §8.3, registered in DECISIONS D-M2-2; gated in M3):
//   1. identity floor: score(run A, run B), same params/trace/regime, different sampler phase (0..T/2 in 4 steps);
//      registered expectation >= 0.99; the mean and sd are THE noise floor, printed next to every score after.
//   2. perturbation ladder: key parameter off by ±1, 2, 5, 10, 20 %: score monotone decreasing in |p|
//      (Spearman rho <= -0.95 per mechanism); 1 % within 2 sd of the floor; 10 % more than 5 sd below it.
//   4. parity: CSS vs WAAPI twins score >= the identity floor.
// Reading of "within 2 sd" / "> 5 sd below" (decided before any result, recorded in the summary): one-sided against the
// floor mean, i.e. S(1 %) >= mean - 2 sd and S(10 %) < mean - 5 sd; "twins >= floor" means S_twin >= mean - 2 sd
// (indistinguishable from identity). A score above the floor mean is never "distinguishable" (cannot be more identical).
import { cueDeltas } from './score.js';

export const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
export const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

function ranks(a) {
  const idx = a.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
  return r;
}
/** Spearman rank correlation with average ranks for ties. */
export function spearman(x, y) {
  const rx = ranks(x), ry = ranks(y); const mx = mean(rx), my = mean(ry);
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < x.length; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Self-band from identity comparisons: per cue key, the largest |Δ| seen between runs of the same source. */
export function selfBand(identityRecords) {
  const band = {};
  for (const rec of identityRecords) for (const [k, v] of Object.entries(cueDeltas(rec))) if (v != null) band[k] = Math.max(band[k] ?? 0, v);
  return band;
}

/** Floor per mechanism: mean and sd of the identity scores. */
export function floors(identityRecords) {
  const by = {};
  for (const rec of identityRecords) for (const m of rec.mechanisms) if (m.pooled) (by[m.id] = by[m.id] || []).push(m.pooled.score);
  const out = {};
  for (const [id, s] of Object.entries(by)) out[id] = { mean: mean(s), sd: sd(s), min: Math.min(...s), n: s.length, scores: s, registered: '>= 0.99 (G1-4 §8.3.1)', pass: mean(s) >= 0.99 };
  return out;
}

/**
 * Ladder verdict for one mechanism.
 * @param {Array<{p:number, score:number}>} pts  p in percent (signed); score of source vs perturbed rebuild
 * @param {{mean:number, sd:number}} floor
 * @param {{readback?:number|null, rt?:number|null}} [minSd]  measured minimum noise floors, in score units
 *
 * OWNER-APPROVED M3 AMENDMENT (2026-10-15 17:2x; DECISIONS "M3 Amendment 1", written after results): for the
 * "1 % within 2 sd" row ONLY, sd_eff = max(self-band sd, the channel's D3 read-back quantisation floor, the rt live
 * floor when one exists). The 10 % row, the monotonicity row and every other threshold still use the self-band sd.
 */
export function ladderVerdict(pts, floor, minSd = {}) {
  const x = pts.map(q => Math.abs(q.p)), y = pts.map(q => q.score);
  const rho = spearman(x, y);
  const at = (p) => pts.filter(q => Math.abs(Math.abs(q.p) - p) < 1e-9).map(q => q.score);
  const s1 = at(1), s10 = at(10);
  const fin = (v) => (v != null && Number.isFinite(v) ? v : 0);
  const sdEff = Math.max(floor.sd, fin(minSd.readback), fin(minSd.rt));
  const sdFrom = sdEff === floor.sd ? 'self-band' : sdEff === fin(minSd.readback) ? 'readback' : 'rt';
  const lo2 = floor.mean - 2 * sdEff, lo5 = floor.mean - 5 * floor.sd;
  const ok1 = s1.length > 0 && s1.every(s => s >= lo2);
  const ok10 = s10.length > 0 && s10.every(s => s < lo5);
  return {
    rho, rhoPass: rho <= -0.95,
    onePct: { scores: s1, limit: lo2, sdEff, sdFrom, sdSelf: floor.sd, sdReadback: minSd.readback ?? null, sdRt: minSd.rt ?? null,
      rule: 'S(±1 %) >= floor mean - 2 sd_eff, sd_eff = max(self-band sd, read-back floor, rt floor) (M3 Amendment 1)', pass: ok1 },
    tenPct: { scores: s10, limit: lo5, rule: 'S(±10 %) < floor mean - 5 sd', pass: ok10 },
    pass: rho <= -0.95 && ok1 && ok10,
  };
}

// ------------------------------------------------------------------ read-back floor in score units (M3 Amendment 1)
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/**
 * A copy of a score input whose channel `channel` on element index `el` is moved by q * pattern(i) on every row:
 * what the same motion looks like through a read-back that is only accurate to ±q (D3).
 */
export function quantisedTwin(input, el, channel, q, pattern) {
  let i = 0;
  const rows = input.rows.map(r => {
    const o = r.v && r.v[el]; if (!o || typeof o[channel] !== 'number') return r;
    return { ...r, v: { ...r.v, [el]: { ...o, [channel]: o[channel] + q * pattern(i++) } } };
  });
  return { ...input, rows, id: `${input.id}#readback-twin` };
}

/** Deterministic read-back noise patterns: alternating ±1 (worst case for velocity) and 4 seeded uniform draws. */
export const READBACK_PATTERNS = [
  { id: 'alternating', make: () => (i) => (i % 2 ? -1 : 1) },
  ...[1, 2, 3, 4].map(seed => ({ id: `uniform-seed${seed}`, make: () => { const r = mulberry32(20261015 + seed); return () => 2 * r() - 1; } })),
];

/**
 * Read-back floor of a mechanism in score units: the largest drop 1 - S when the source is scored against itself with
 * each tracked channel moved by up to its own measured D3 read-back error. `scoreOf(twin)` returns the mechanism's
 * pooled score of source vs twin; `channels` = [{el, channel, q}] with q from readbackOf().
 */
export function readbackFloorSd(input, channels, scoreOf) {
  const per = [];
  for (const P of READBACK_PATTERNS) {
    let twin = input;
    for (const c of channels) twin = quantisedTwin(twin, c.el, c.channel, c.q, P.make());
    const s = scoreOf(twin);
    per.push({ pattern: P.id, score: s, drop: s == null ? null : 1 - s });
  }
  const drops = per.map(p => p.drop).filter(d => d != null && Number.isFinite(d));
  return { sd: drops.length ? Math.max(0, ...drops) : null, per, channels };
}

export function twinsVerdict(score, floor) {
  const lim = floor.mean - 2 * floor.sd;
  return { score, limit: lim, rule: 'S(CSS vs WAAPI twin) >= floor mean - 2 sd', pass: score >= lim };
}

/**
 * Planted defect verdict: the mechanism must be layer-1 "different" (some cue beyond its self-band) and its pooled score
 * more than 5 sd below the identity floor.
 */
export function defectVerdict(mech, floor) {
  const beyond = [];
  for (const p of mech.pairs) {
    for (const ev of (p.response && p.response.events) || []) for (const d of ev.diffs) if (d.layer1 === 'different') beyond.push({ where: `response#${ev.i}`, cue: d.cue, delta: d.delta, band: d.band, ratio: d.bandRatio });
    for (const d of (p.sweep && p.sweep.diffs) || []) if (d.layer1 === 'different') beyond.push({ where: 'sweep', cue: d.cue, delta: d.delta, band: d.band, ratio: d.bandRatio });
  }
  const lim = floor.mean - 5 * floor.sd;
  const score = mech.pooled ? mech.pooled.score : null;
  return { layer1: mech.verdict && mech.verdict.layer1, beyondBand: beyond.length, top: beyond.sort((a, b) => (b.ratio || 0) - (a.ratio || 0)).slice(0, 4), score, limit: lim,
    pass: mech.verdict && mech.verdict.layer1 === 'different' && score != null && score < lim };
}
