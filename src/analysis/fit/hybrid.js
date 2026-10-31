// S1b (27 Oct): hybrid 60/120 Hz fit, corpus fit step only (`reva look` never sets opts.hybrid).
//
// A 120 Hz take (page frame 8.33 ms, rows k = 0, 1, 2 ...) is fitted first on every 2nd row (the fitter already handles a
// sampling stride of the page frame: series.js timing.strideInt, the R6 stride), which costs about half the evaluations
// per candidate. A channel whose 60 Hz answer cannot be trusted to equal the 120 Hz one is then fitted again at the full
// rate and its records replace the 60 Hz ones (index.js, the channel loop). The test below is that decision.
//
// REVA_FIT_HYBRID=1 turns it on, =0 off; unset = HYBRID_DEFAULT.
export const HYBRID_DEFAULT = false;
export const hybridOn = () => { const v = process.env.REVA_FIT_HYBRID; return v === '1' ? true : v === '0' ? false : HYBRID_DEFAULT; };

/** A channel moving for less than this has too few 60 Hz samples for the short-motion families to be identified. */
export const SHORT_MS = 300;
export const HYBRID_STRIDE = 2;
/** the 60 Hz pass of a channel may spend this share of the channel evaluation budget; past it the channel is refit at full rate */
export const HYBRID_BUDGET_SHARE = 0.25;

/** every HYBRID_STRIDE-th row of a take's rows, counted in page frames (k) from the first row; the rest of the take is shared, not copied */
export function strideRows(rows, stride = HYBRID_STRIDE) {
  const k0 = rows.length ? rows[0].k ?? 0 : 0;
  return rows.filter((r, i) => ((r.k ?? i) - k0) % stride === 0);
}

/** true when a take is a plain consecutive-page-frame take that a stride of 2 can thin (else the normal fit runs) */
export function hybridApplies(rows, dtPage, strideInt) {
  return !!dtPage && strideInt === 1 && rows.length >= 40;
}

/**
 * Does the channel need the full-rate fit? `rs` = the records of the 60 Hz fit of one channel; `spanMs` = the time between
 * the channel's first and last moving sample (null when it never moves). Returns the reason, or null (keep the 60 Hz answer).
 *  - unknown / unexplained, or too few samples: the 60 Hz fit had nothing to identify, 120 Hz may;
 *  - a motion shorter than SHORT_MS (a record's own time range, a one-frame step, else the channel's moving span);
 *  - a decision within the noise of the criterion (selectionAmbiguity): 60 Hz can flip it;
 *  - a spring, or a tween of D < SHORT_MS: the parameters live in a handful of frames.
 */
export function needsFullRate(rs, spanMs) {
  if (!rs || !rs.length) return null;
  for (const r of rs) {
    if (r.tier === 'not_applicable') continue;
    if (r.tier === 'declared') return 'declared';   // read from the page's own animation: cheap to check, and its values come from the samples
    if (r.tier !== 'fitted') return 'unexplained';
    if ((r.unknowns || []).some((u) => u.id === 'unk_too_few_samples')) return 'too_few_samples';
  }
  for (const r of rs) {
    if (r.tier === 'not_applicable') continue;
    if (r.selectionAmbiguity) return 'selectionAmbiguity';
    if (r.class === 'spring') return 'spring';
    const D = r.model && r.model.params && r.model.params.D && r.model.params.D.value;
    if (r.class === 'tween' && Number.isFinite(D) && D < SHORT_MS) return 'short tween';
    const loc = r.evidence && r.evidence.location;
    if (loc && loc.kind === 'frame_index') return 'short (one-frame step)';
    if (loc && loc.kind === 'time_range' && Array.isArray(loc.range) && loc.range[1] - loc.range[0] < SHORT_MS) return 'short';
  }
  if (spanMs != null && spanMs < SHORT_MS) return 'short';
  return null;
}
