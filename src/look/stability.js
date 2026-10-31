// Stability of a look between two runs (the re-take of src/look/index.js, served from the session cache: src/look/cache.js).
// Pure: fit records in, per-motion verdicts out. Each compared motion is `stable` (every compared channel within the
// tolerances), `varies` (with the deltas that broke them) or `unknown` (nothing could be compared: a channel the re-take
// did not fit). Compared per channel: the law (tween / spring / smoothing), the duration, the start relative to the action,
// the ease (max |Δ progress| over the normalised curve) and the end values.
import { progressOf, derivedOf } from '../mcp/analysis.js';
import { familyKind } from '../export/index.js';

export const STABILITY_SCHEMA = 'reva.stability/0';
/**
 * Tolerances: a frame or two of the virtual clock for times (a fitted start can sit a frame off), 5 % of a duration,
 * 0.05 of the progress (5 % of the travel) for the ease, and for an end value 2 % of the travel, at least 1 unit on a
 * big value (px, deg) or 0.02 on a unit value (opacity, scale), as look's movedClearly reads "moved".
 */
export const STABILITY_TOL = { frames: 2, durShare: 0.05, ease: 0.05, travelShare: 0.02 };
const CURVE_N = 41;
const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * What one fitted record says, reduced to what is compared. `tRef`: the action's time in that take (page ms; 0 for a
 * load); `ends`: {from, to} recorded at the motion's start and end (src/mcp/analysis.js recordedEnds), or null.
 */
export function recordSummary(rec, { tRef = 0, ends = null } = {}) {
  const fam = String((rec.model && rec.model.family) || '');
  const P = (n) => { const p = rec.model && rec.model.params && rec.model.params[n]; return p && typeof p.value === 'number' ? p.value : null; };
  const d = rec.derived || {};
  const t0 = /^declared:/.test(fam) ? num(d.visibleOnset) ?? num(d.t0) ?? P('start') : P('t0') ?? num(d.t0);
  let pr; try { pr = progressOf(rec); } catch { pr = { why: 'no progress' }; }
  let dur = null, span = null;
  if (pr.kind === 'tween') { dur = pr.D; span = pr.D; }
  else if (pr.kind === 'spring') { try { const s = derivedOf(rec).settle99; dur = s ? s.value : null; } catch { dur = null; } span = dur; }
  else if (pr.kind === 'smoothing') span = 5 * pr.tau;   // a smoothing has no duration of its own: its step response is compared
  const curve = pr.p && span > 0 ? Array.from({ length: CURVE_N }, (_, i) => r3(pr.p((i / (CURVE_N - 1)) * span))) : null;
  return {
    channel: rec.target.channel, family: fam || null, kind: familyKind(fam) || fam || null, tier: rec.tier || null,
    t0: t0 != null ? r1(t0 - (tRef || 0)) : null, durationMs: dur != null ? r1(dur) : null, curve,
    from: ends && num(ends.from) != null ? ends.from : null, to: ends && num(ends.to) != null ? ends.to : null,
  };
}

const endTol = (a, b, travel) => Math.max(STABILITY_TOL.travelShare * Math.abs(travel || 0), Math.max(Math.abs(a), Math.abs(b)) > 2 ? 1 : 0.02);

/**
 * Two summaries of one channel. `dt`: the frame interval (ms). Returns {deltas, varies: [{what, text}]}; deltas name only
 * what both runs have.
 */
export function compareSummary(a, b, { dt = 1000 / 120 } = {}) {
  const deltas = {}; const varies = [];
  const tTol = STABILITY_TOL.frames * dt;
  if (a.kind && b.kind && a.kind !== b.kind) varies.push({ what: 'law', text: `law ${a.kind} → ${b.kind}` });
  if (a.durationMs != null && b.durationMs != null) {
    const dd = r1(b.durationMs - a.durationMs); deltas.durationMs = { first: a.durationMs, second: b.durationMs, delta: dd };
    if (Math.abs(dd) > Math.max(tTol, STABILITY_TOL.durShare * Math.max(a.durationMs, b.durationMs))) varies.push({ what: 'duration', text: `duration ${Math.round(a.durationMs)} → ${Math.round(b.durationMs)} ms` });
  }
  if (a.t0 != null && b.t0 != null) {
    const dd = r1(b.t0 - a.t0); deltas.t0Ms = { first: a.t0, second: b.t0, delta: dd };
    if (Math.abs(dd) > tTol) varies.push({ what: 'start', text: `start ${Math.round(a.t0)} → ${Math.round(b.t0)} ms after the action` });
  }
  if (a.curve && b.curve && a.curve.length === b.curve.length) {
    let m = 0; for (let i = 0; i < a.curve.length; i++) m = Math.max(m, Math.abs(a.curve[i] - b.curve[i]));
    deltas.ease = r3(m);
    if (m > STABILITY_TOL.ease) varies.push({ what: 'ease', text: `ease differs by up to ${Math.round(m * 100)} % of the travel` });
  }
  const travel = a.from != null && a.to != null ? a.to - a.from : null;
  for (const k of ['from', 'to']) {
    if (a[k] == null || b[k] == null) continue;
    const dd = r3(b[k] - a[k]); deltas[k] = { first: a[k], second: b[k], delta: dd };
    if (Math.abs(dd) > endTol(a[k], b[k], travel)) varies.push({ what: k, text: `${k === 'to' ? 'ends at' : 'starts from'} ${r3(a[k])} → ${r3(b[k])}` });
  }
  return { deltas, varies };
}

/**
 * Compare the motions of two runs.
 * @param {{rank:number, desc:string, selector?:string|null, first:object[], second:object[]|null}[]} motions
 *   first / second: recordSummary lists of the motion's lead element (second null: the motion was not found in the re-take)
 * @returns {{rank, desc, selector, verdict:'stable'|'varies'|'unknown', channels:object[], text:string|null}[]}
 */
export function compareMotions(motions, { dt = 1000 / 120 } = {}) {
  return motions.map((m) => {
    const base = { rank: m.rank, desc: m.desc, selector: m.selector ?? null };
    if (!m.second) return { ...base, verdict: 'varies', channels: [], text: 'varies between two runs: it did not move in the second run' };
    const chans = [...new Set(m.first.map((s) => s.channel))];
    const out = [];
    for (const ch of chans) {
      const A = m.first.filter((s) => s.channel === ch && s.tier !== 'unknown').sort(byT0);
      const B = m.second.filter((s) => s.channel === ch && s.tier !== 'unknown').sort(byT0);
      if (!A.length) continue;
      if (!B.length) { out.push({ channel: ch, verdict: 'unknown', why: 'not fitted in the second run' }); continue; }
      const segs = [];
      const varies = A.length !== B.length ? [{ what: 'segments', text: `${A.length} → ${B.length} segment(s) on ${ch}` }] : [];
      for (let i = 0; i < Math.min(A.length, B.length); i++) { const c = compareSummary(A[i], B[i], { dt }); segs.push(c.deltas); varies.push(...c.varies); }
      out.push({ channel: ch, verdict: varies.length ? 'varies' : 'stable', deltas: segs.length === 1 ? segs[0] : segs, ...(varies.length ? { varies } : {}) });
    }
    const compared = out.filter((c) => c.verdict !== 'unknown');
    const verdict = compared.some((c) => c.verdict === 'varies') ? 'varies' : compared.length ? 'stable' : 'unknown';
    let text = null;
    if (verdict === 'varies') {
      const reasons = [...new Set(compared.flatMap((c) => (c.varies || []).map((v) => v.text)))];
      text = `varies between two runs: ${reasons.slice(0, 2).join('; ')}${reasons.length > 2 ? `; +${reasons.length - 2} more` : ''}`;
    }
    return { ...base, verdict, channels: out, text };
  });
}
const byT0 = (x, y) => (x.t0 ?? Infinity) - (y.t0 ?? Infinity);

/**
 * The re-take's entry for one motion of the first take: the same selector, else the same lead selector, else the same
 * descriptor (the one nearest the first's box when several share it). Element ids differ between runs; these keys do not.
 */
export function matchEntry(m, entries) {
  const by = (k) => (m[k] ? entries.filter((e) => e[k] === m[k]) : []);
  for (const k of ['selector', 'leadSelector']) { const hit = by(k); if (hit.length === 1) return hit[0]; }
  const same = entries.filter((e) => e.desc === m.desc);
  if (same.length <= 1 || !m.box) return same[0] || null;
  const dist = (e) => (e.box ? Math.hypot(e.box.x - m.box.x, e.box.y - m.box.y) : Infinity);
  return same.sort((x, y) => dist(x) - dist(y))[0];
}
