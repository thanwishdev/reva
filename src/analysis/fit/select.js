// Model selection (design §5): explain bar, noise-floored BIC, holdout, runner-up, class decisions by likelihood
// (ΔL ≥ 10 or a decisive probe), ambiguity → class `unknown` (U3), and the output guard (§6).

/** Simpler ⊂ richer pairs (a nested richer model that does not beat the simpler by ΔL ≥ 10 is not an alternative). */
const NESTED = [['scroll map', 'first-order smoothing'], ['first-order smoothing', 'asymmetric smoothing'], ['scroll map', 'asymmetric smoothing'],
  ['ramp', 'tween'], ['ramp', 'friction'], ['ramp', 'spring'], ['ramp', 'first-order smoothing'], ['static', '*'], ['step', '*']];
export const nests = (simple, rich) => NESTED.some(([a, b]) => a === simple && (b === rich || b === '*'));
const DRIVER_CLASSES = new Set(['scroll map', 'first-order smoothing', 'asymmetric smoothing', 'restarted tween', 'composite']);

/** Holdout (design §5.2) on one fitted candidate; mutates c.holdout. */
export function holdout(c, explainBar, { segments } = {}) {
  if (!c.refit || !c.window) { c.holdout = c.holdout || { method: 'none', rms: null, pass: true, note: 'no refit hook (declared/periodic/integrator: cross-rate or exact read)' }; return c.holdout; }
  const T = c.window.T, y = c.window.y; let worst = null; let method;
  const runs = [];
  if (segments && segments.length >= 2) {
    method = 'leave-one-segment-out';
    const big = [...segments].sort((a, b) => b.amp - a.amp).slice(0, 3);
    for (const sg of big) runs.push(T.map((t, i) => !(i >= sg.b && i <= sg.e)));
  } else {
    method = 'last-30%-of-[t0,t99]';
    const d = c.derived || {}; const t0 = d.t0 ?? T[0]; const t99 = d.t99 != null ? t0 + d.t99 : (d.settle99 != null ? t0 + d.settle99 : T.at(-1));
    const a = t0 + 0.7 * (t99 - t0); runs.push(T.map((t) => !(t >= a && t <= t99)));
  }
  for (const use of runs) {
    const held = use.map((u) => !u); if (held.filter(Boolean).length < 2) continue;
    const r = c.refit(use); if (!r) continue;
    const m = r.predictFull; let s = 0, n = 0; for (let i = 0; i < T.length; i++) if (held[i]) { s += (m[i] - y[i]) ** 2; n++; }
    const v = Math.sqrt(s / n); if (worst == null || v > worst) worst = v;
  }
  c.holdout = worst == null ? { method, rms: null, pass: true, note: 'too few held-out frames' } : { method, rms: worst, pass: worst <= Math.max(2 * c.rms, explainBar) };
  return c.holdout;
}

/**
 * Select among candidates fitted on the SAME frames.
 * @param {object[]} cands  {family, cls, n, k, rss, rms, L, bic, ...}
 * @param {{explainBar:number, probes?:{driverAligned?:boolean}}} o
 */
export function select(cands, o) {
  const list = cands.filter((c) => c && Number.isFinite(c.rss));
  for (const c of list) c.explains = c.rms <= o.explainBar;
  const ok = list.filter((c) => c.explains && (!c.holdout || c.holdout.pass)).sort((a, b) => a.bic - b.bic);
  const rejected = list.filter((c) => !ok.includes(c)).map((c) => ({ family: c.family, cls: c.cls, rms: c.rms, reason: !c.explains ? `rms ${c.rms.toExponential(2)} > explain bar ${o.explainBar.toExponential(2)}` : `holdout ${c.holdout.method} rms ${c.holdout.rms?.toExponential(2)} failed` }));
  if (!ok.length) {
    const bestRej = [...list].sort((a, b) => a.bic - b.bic)[0] || null;
    return { winner: null, runnerUp: bestRej, rejected, ambiguity: null, decided: false, reason: 'no family explains (U2)' };
  }
  let winner = ok[0];
  // a nested simpler model wins when the richer one does not improve the likelihood by ≥ 10
  for (const c of ok) if (c !== winner && nests(c.cls, winner.cls) && c.L - winner.L < 10) { winner = c; }
  const others = ok.filter((c) => c !== winner);
  const runnerUp = others[0] || [...list].filter((c) => c !== winner).sort((a, b) => a.bic - b.bic)[0] || null;
  // class decision: competing different-class explainers within ΔL < 10 → ambiguous unless a decisive probe exists
  const rivals = others.filter((c) => c.cls !== winner.cls && !nests(c.cls, winner.cls) && !nests(winner.cls, c.cls) && c.L - winner.L < 10);
  let ambiguity = null;
  if (rivals.length) {
    const driverProbe = o.probes && o.probes.driverAligned;
    const decisive = driverProbe && DRIVER_CLASSES.has(winner.cls) && rivals.every((r) => !DRIVER_CLASSES.has(r.cls));
    if (decisive) winner.decidedBy = 'driver alignment (every response starts within 2 frames of a driver change; one shared parameter set)';
    else ambiguity = { candidates: [winner, ...rivals].map((c) => ({ family: c.family, cls: c.cls, ease: c.ease, rms: c.rms, dL: c.L - winner.L, params: paramValues(c) })), reason: 'two classes explain within the noise (ΔL < 10) and no decisive probe (G1-4 §8.2: report both)' };
  }
  // L9-A: how close this decided outcome is to another one (null: farther than the noise of L, or ambiguous already)
  const ke = ambiguity ? null : selectionMargin(ok, o); const knifeEdge = ke && { ...ke, of: winner };
  return { winner, runnerUp, rejected, ambiguity, decided: !ambiguity, knifeEdge };
}

/**
 * The rule select() applies, as a function of the candidate order (by BIC) and the ΔL threshold (10): the nested
 * simpler model wins below the threshold, and a non-nested other class below it is a rival (ambiguous unless the driver
 * probe is decisive).
 */
function decide(order, thr, o) {
  let w = order[0];
  for (const c of order) if (c !== w && nests(c.cls, w.cls) && c.L - w.L < thr) w = c;
  const rv = order.filter((c) => c !== w && c.cls !== w.cls && !nests(c.cls, w.cls) && !nests(w.cls, c.cls) && c.L - w.L < thr);
  const decisive = rv.length > 0 && !!(o.probes && o.probes.driverAligned) && DRIVER_CLASSES.has(w.cls) && rv.every((r) => !DRIVER_CLASSES.has(r.cls));
  return { w, amb: rv.length > 0 && !decisive, rv };
}
const outcomeKey = (d) => `${d.w.family}|${d.w.cls}|${d.amb}`;

/**
 * Numerical noise of the likelihood L (FIT-SPEED idea 2, L9-A). The class / family decision compares likelihoods (the
 * ΔL ≥ 10 nested and rival rules, the BIC order). Measured on the stored takes of three corpus sites by
 * refitting with the LM stop changed (relative gain 1e-12 → 1e-9 and → 1e-6; lanes/L9A.md): the L of records whose
 * decision did not change moved by ≤ 0.023 at the 99th percentile (1e-9 run), and every decision that flipped because of
 * the selection rule had a margin ≤ 0.03. A decided record within this of another outcome is reported as ambiguous
 * within the noise (record.selectionAmbiguity), its value fields unchanged. (Flips where one candidate's optimiser
 * reached another basin, L moving by 1–220, are not noise of L and no margin catches them.)
 */
export const SELECT_NOISE_L = 0.1;

/**
 * Smallest perturbation (in L units, on the differences the rule compares; from `levels`, ascending) that changes the
 * outcome of select() — winner family / class or ambiguity — when the ΔL threshold moves by ±δ or a candidate within δ
 * of the best BIC is taken first. null when no level changes it. {level, alt: {w, amb, rv}}.
 */
export function selectionMargin(ok, o, levels = [SELECT_NOISE_L]) {
  if (ok.length < 2) return null;
  const k0 = outcomeKey(decide(ok, 10, o));
  for (const dl of levels) {
    const outs = [decide(ok, 10 - dl, o), decide(ok, 10 + dl, o)];
    for (let i = 1; i < ok.length && ok[i].bic - ok[0].bic <= dl; i++) {
      const ord = [ok[i], ...ok.filter((_, j) => j !== i)];
      outs.push(decide(ord, 10 - dl, o), decide(ord, 10, o), decide(ord, 10 + dl, o));
    }
    const alt = outs.find((d) => outcomeKey(d) !== k0);
    if (alt) return { level: dl, alt };
  }
  return null;
}

export const paramValues = (c) => Object.fromEntries(Object.entries(c.params || {}).map(([k, v]) => [k, v && typeof v === 'object' ? v.value : v]));

/**
 * Output guard (design §6, code invariant): a value carries `fitted` only if the model explains, passed holdout, is
 * not ambiguous, has a finite CI and, for spring k/c, the integrator is identified. Returns the list of downgrades.
 */
export function guardRecord(rec) {
  const downgrades = [];
  const why = [];
  if (!rec.fit || !(rec.fit.rms <= rec.fit.explain_bar)) why.push('model does not explain');
  if (rec.fit && rec.fit.holdout && rec.fit.holdout.pass === false) why.push('holdout failed');
  if (rec.ambiguity) why.push('ambiguous class');
  for (const [name, p] of Object.entries((rec.model && rec.model.params) || {})) {
    if (!p || p.provenance !== 'fitted') continue;
    const w = p.sharedByAmbiguity ? why.filter((x) => x !== 'ambiguous class') : [...why];
    if (!Array.isArray(p.ci95) || !p.ci95.every(Number.isFinite)) w.push('no finite CI');
    if ((name === 'k' || name === 'c' || name === 'kf' || name === 'cf') && !(rec.model.integrator && rec.model.integrator.identified)) w.push('integrator not identified');
    if (w.length) { p.provenance = 'unknown'; p.reason = w.join('; '); p.withheld_value = p.value; p.value = null; downgrades.push({ param: name, reason: p.reason }); }
  }
  return downgrades;
}

/**
 * record.selectionAmbiguity of a decided record whose selection is within the noise of L (select().knifeEdge, for the
 * winner the record reports), else null. Added beside the record's values: class, tier and params are unchanged.
 */
export function selectionAmbiguity(sel, w) {
  const ke = sel && sel.knifeEdge; if (!ke || sel.ambiguity || !w || ke.of !== w) return null;
  const a = ke.alt; const other = a.w !== w ? a.w : a.rv[0]; if (!other) return null;
  const how = a.w !== w ? `${other.family} (${other.cls}) would be selected instead` : `${other.family} (${other.cls}) would become a rival and the class ambiguous`;
  return { ambiguous: true, reason: `a change of ${ke.level} in the likelihood comparison (inside its numerical noise, ${SELECT_NOISE_L}) and ${how}`,
    noise_L: SELECT_NOISE_L, runnerUp: { family: other.family, cls: other.cls, ease: other.ease ?? null, dL: other.L - w.L, dBIC: other.bic - w.bic, params: paramValues(other) } };
}

// The scale a parameter's 95 % interval is judged against (L9-A): a half-width at least this large means the data do not
// pin the parameter down. Ratio parameters (a duration, a rate, a stiffness …): the value itself (the interval reaches
// zero, not even the order of magnitude is known). Bezier control points: the unit square. A value in the channel's units
// (start, end, target, map value): the motion amplitude of the record (rms / nrmse). A time (onset, retarget): the
// record's time range. A scroll-map corner: the sampled scroll range.
const RATIO_PARAMS = new Set(['D', 'duration', 'L', 'tau_ms', 'omega', 'zeta', 'k', 'c', 'kf', 'cf', 'lambda', 'alpha', 'alpha_per_frame', 'alphaUp', 'alphaDown', 'eps', 'period']);
function paramScale(name, p, rec) {
  if (RATIO_PARAMS.has(name)) return Math.abs(p.value);
  if (/^[xy][12]$/.test(name)) return 1;
  const loc = rec.evidence && rec.evidence.location; const span = loc && Array.isArray(loc.range) && loc.range.every(Number.isFinite) ? loc.range[1] - loc.range[0] : NaN;
  if (/^mapS[01]$/.test(name)) return loc && loc.kind === 'scroll_range' && span > 0 ? span : NaN;
  if (/^(t0|at|start|delay|tr\d+)$/.test(name)) return loc && loc.kind === 'time_range' && span > 0 ? span : NaN;
  if (/^(from|to|x0|mapA|mapB|target\d*)$/.test(name)) { const f = rec.fit || {}; const A = f.rms > 0 && f.nrmse > 0 ? f.rms / f.nrmse : NaN; return A > 0 ? A : NaN; }
  return NaN;
}

/**
 * L9-A, honest labels: a `fitted` parameter the data cannot pin down gets `identified: false` and the reason
 * (`unidentified`); its value, provenance and interval are unchanged (the provenance vocabulary is a closed set that the
 * report validator and look read; lanes/L9A.md). Unidentified: a scroll-map corner the record already reports as not
 * reached by any sample (model.map.s0_provenance / s1_provenance 'unknown'), or a 95 % half-width at least the
 * parameter's scale (paramScale). Returns the names labelled.
 */
export function labelUnidentified(rec) {
  const P = (rec && rec.model && rec.model.params) || {}; const m = rec && rec.model && rec.model.map; const out = [];
  for (const [name, p] of Object.entries(P)) {
    if (!p || typeof p !== 'object' || p.provenance !== 'fitted' || !Number.isFinite(p.value)) continue;
    let why = null;
    if (m && ((name === 'mapS0' && m.s0_provenance === 'unknown') || (name === 'mapS1' && m.s1_provenance === 'unknown'))) why = 'scroll-map corner beyond every sampled offset: it trades off with the other map parameters along a ridge (model.map reports it unknown)';
    else if (Array.isArray(p.ci95) && p.ci95.every(Number.isFinite)) {
      const hw = (p.ci95[1] - p.ci95[0]) / 2; const sc = paramScale(name, p, rec);
      if (sc >= 0 && hw >= sc) why = `95 % half-width ${+hw.toPrecision(3)} at least the parameter's scale ${+sc.toPrecision(3)} (${RATIO_PARAMS.has(name) ? 'its value' : /^[xy][12]$/.test(name) ? 'the unit square' : /^mapS/.test(name) ? 'the sampled scroll range' : /^(from|to|x0|mapA|mapB|target)/.test(name) ? 'the motion amplitude' : 'the time range'}): the data do not pin it down`;
    }
    if (why) { p.identified = false; p.unidentified = why; out.push(name); }
  }
  return out;
}
