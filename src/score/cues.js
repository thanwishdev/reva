// Cue extraction (S3 §10.2, W2G2-3 §6 "cue units"). Pure functions on plain arrays; no curve alignment anywhere:
// arm 2 measures every time from the input (input-aligned), arm 1 compares values at the same scrollY. No DTW and no
// Fréchet distance is computed in this module or anywhere in src/score (SYN §5.5: they forgive timing).

const lerpCross = (t0, p0, t1, p1, q) => (p1 === p0 ? t1 : t0 + (t1 - t0) * (q - p0) / (p1 - p0));

/**
 * Step-response cues of one channel for one event window.
 * @param {number[]} T  sample times (ms), ascending
 * @param {number[]} v  values
 * @param {number} Te   event (input) time
 * @param {number} Tend end of the window (next event, or end of take)
 * @param {object} o    {bar}: smallest change that counts as motion (value units)
 * @returns cues in ms (times measured from Te), progress units, or {static:true}
 */
export function responseCues(T, v, Te, Tend, { bar = 0 } = {}) {
  // Convention (hx and rt): a sample stamped at the same time as an input was taken BEFORE that input (the recorder
  // samples at the end of a frame; inputs land between frames). Baseline = last sample at or before the input; the
  // window = samples after the input up to and including the next input's time.
  let i0 = -1; for (let i = 0; i < T.length && T[i] <= Te + 1e-9; i++) i0 = i;
  const idx = []; for (let i = Math.max(0, i0 + 1); i < T.length && T[i] <= Tend + 1e-9; i++) idx.push(i);
  if (i0 < 0 || idx.length < 2) return { insufficient: true, n: idx.length };
  const v0 = v[i0];
  const vEnd = v[idx[idx.length - 1]];
  const delta = vEnd - v0;
  let maxDev = 0; for (const i of idx) maxDev = Math.max(maxDev, Math.abs(v[i] - v0));
  const settledEnd = Math.abs(v[idx[idx.length - 1]] - v[idx[idx.length - 2]]) <= Math.max(bar, 1e-12);
  if (Math.abs(delta) <= bar && maxDev <= bar) return { static: true, v0, vEnd, delta, maxDev, n: idx.length };
  // progress against the own end value; the curve starts at (Te, 0): nothing can respond before its input
  const ts = [Te], ps = [0];
  const dn = Math.abs(delta) > bar ? delta : (maxDev || 1);   // a there-and-back pulse: progress against its peak
  for (const i of idx) { ts.push(T[i]); ps.push((v[i] - v0) / dn); }
  const cross = (q) => { for (let j = 1; j < ps.length; j++) if (ps[j] >= q && ps[j - 1] < q) return lerpCross(ts[j - 1], ps[j - 1], ts[j], ps[j], q) - Te; return null; };
  // onset = the 1 % crossing. A motion that starts with a velocity (ease-out from rest, a smoothing step) has a kink
  // between two samples; a straight line from the last rest sample puts the crossing anywhere in that frame depending
  // on where the kink fell (sub-frame), so the crossing is solved on a parabola through the first three moving samples,
  // extrapolated back into the kink interval. Same for the velocity at the start (see peakVel). Linear fallback.
  let j1 = -1; for (let j = 1; j < ps.length; j++) if (Math.abs(ps[j]) >= 0.01) { j1 = j; break; }
  const sg = j1 > 0 && ps[j1] < 0 ? -1 : 1;
  let quad = null;
  if (j1 > 0 && j1 + 2 < ps.length) {
    const x1 = ts[j1 + 1] - ts[j1], x2 = ts[j1 + 2] - ts[j1];
    const y0 = sg * ps[j1], y1 = sg * ps[j1 + 1], y2 = sg * ps[j1 + 2];
    const c = ((y2 - y0) / x2 - (y1 - y0) / x1) / (x2 - x1), b = (y1 - y0) / x1 - c * x1;
    // p(t) = y0 + b·x + c·x², x = t - ts[j1]; solve p = 0.01 for x in [ts[j1-1] - ts[j1], 0]
    const roots = []; const A0 = y0 - 0.01;
    if (Math.abs(c) < 1e-15) { if (b) roots.push(-A0 / b); } else { const D = b * b - 4 * c * A0; if (D >= 0) { const r = Math.sqrt(D); roots.push((-b + r) / (2 * c), (-b - r) / (2 * c)); } }
    // bracket with the previous REAL sample (the synthetic input point would make the bracket depend on the input's
    // sub-frame phase); a root before the input is clamped to the input below (nothing responds before its input)
    const lo = (j1 >= 2 ? ts[j1 - 1] : T[i0]) - ts[j1] - 1e-9;
    const x = roots.filter(r => r >= lo && r <= 1e-9).sort((a, b) => b - a)[0];
    if (x != null && b > 0) {
      // velocity at the start of the motion: slope at the parabola's p = 0 root when it lies in the bracket
      let x0 = null; if (Math.abs(c) < 1e-15) x0 = -y0 / b; else { const D0 = b * b - 4 * c * y0; if (D0 >= 0) { const r = Math.sqrt(D0); x0 = [(-b + r) / (2 * c), (-b - r) / (2 * c)].filter(z => z >= 1.5 * lo - 1e-9 && z <= 1e-9).sort((p, q) => q - p)[0] ?? null; } }
      quad = { t: ts[j1] + x, slope: b + 2 * c * (x0 ?? x), c };
    }
  }
  const onset = j1 < 0 ? null : quad ? Math.max(quad.t, Te) - Te : lerpCross(ts[j1 - 1], Math.abs(ps[j1 - 1]), ts[j1], Math.abs(ps[j1]), 0.01) - Te;
  // settle into the 1 % band (t99) and 0.1 % band: the crossing after the last sample outside the band
  const settleBand = (b) => {
    if (!settledEnd) return null;
    let last = -1; for (let j = 1; j < ps.length; j++) if (Math.abs(1 - ps[j]) > b) last = j;
    if (last < 0) return onset;
    if (last >= ps.length - 1) return null;
    const a = Math.abs(1 - ps[last]), c = Math.abs(1 - ps[last + 1]);
    return (a === c ? ts[last + 1] : ts[last] + (ts[last + 1] - ts[last]) * (a - b) / (a - c)) - Te;
  };
  // peak velocity (progress per ms) from finite differences between real samples after the input (vel[m] = interval
  // ps[m+1] -> ps[m+2]). Decelerating start (ease-out from rest, smoothing step): the peak sits at the kink, which
  // falls between samples at a sub-frame phase, so it is read from the parabola at the onset. Otherwise an interior
  // peak is refined by a parabola through the peak and its neighbours, using intervals that lie after the onset only.
  const vel = [], tm = [];
  for (let j = 2; j < ps.length; j++) { const dt = ts[j] - ts[j - 1]; if (dt > 0) { vel.push((ps[j] - ps[j - 1]) / dt); tm.push((ts[j] + ts[j - 1]) / 2); } }
  let pk = 0; for (let j = 1; j < vel.length; j++) if (Math.abs(vel[j]) > Math.abs(vel[pk])) pk = j;
  let peakVel = vel.length ? Math.abs(vel[pk]) : null, tPeak = vel.length ? tm[pk] - Te : null;
  const kink = quad && quad.c < 0 && j1 > 0 && pk <= j1 - 1;
  if (kink) { peakVel = quad.slope; tPeak = Math.max(quad.t, Te) - Te; }
  else if (vel.length >= 3 && pk > 0 && pk < vel.length - 1 && pk >= j1) {
    const [a, b, c] = [Math.abs(vel[pk - 1]), Math.abs(vel[pk]), Math.abs(vel[pk + 1])];
    const den = a - 2 * b + c;
    if (den < 0) { const off = 0.5 * (a - c) / den; if (Math.abs(off) <= 1) { peakVel = b - 0.25 * (a - c) * off; tPeak = tm[pk] + off * (tm[pk + 1] - tm[pk - 1]) / 2 - Te; } }
  }
  // instant: the change is complete at the first sample after the input (no inter-frame velocity exists)
  const instant = ps.length >= 2 && ps.slice(1).every(p => Math.abs(1 - p) <= 0.01);
  let maxP = -Infinity, minP = Infinity; for (const p of ps) { if (p > maxP) maxP = p; if (p < minP) minP = p; }
  let crossings = 0; for (let j = 1; j < ps.length; j++) if ((ps[j - 1] - 1) * (ps[j] - 1) < 0) crossings++;
  return {
    v0, vEnd, delta, maxDev, n: idx.length, settledEnd,
    lag: onset, t10: cross(0.1), t50: cross(0.5), t90: cross(0.9), t99: settleBand(0.01), t999: settleBand(0.001),
    peakVel: instant ? null : peakVel, tPeak: instant ? null : tPeak, instant, overshoot: Math.max(0, maxP - 1), undershoot: Math.max(0, -minP), crossings,
    curve: { ts, ps },
  };
}

/** Linear interpolation of (xs, ys) at x; xs ascending. Null outside the range. */
export function interp(xs, ys, x) {
  if (!xs.length || x < xs[0] - 1e-9 || x > xs[xs.length - 1] + 1e-9) return null;
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  if (xs[hi] === xs[lo]) return ys[lo];
  return ys[lo] + (ys[hi] - ys[lo]) * (x - xs[lo]) / (xs[hi] - xs[lo]);
}

/**
 * Input-aligned value differences of two takes recorded with the same input schedule and rate (frame index after the
 * input matches frame index): max |Δ| and RMS, normalised by the source amplitude. This is the W2G1-3 "dense step"
 * number (max |Δ| / A over the frames after the jump). No shift, no warping.
 */
export function alignedDiff(src, reb, Te, Tend, A, maxFrames = Infinity) {
  const a = [], b = [];
  for (let i = 0; i < src.T.length; i++) if (src.T[i] > Te + 1e-9 && src.T[i] <= Tend + 1e-9) a.push(src.v[i]);
  for (let i = 0; i < reb.T.length; i++) if (reb.T[i] > Te + 1e-9 && reb.T[i] <= Tend + 1e-9) b.push(reb.v[i]);
  const n = Math.min(a.length, b.length, maxFrames);
  let mx = 0, ss = 0; for (let i = 0; i < n; i++) { const d = Math.abs(a[i] - b[i]); mx = Math.max(mx, d); ss += d * d; }
  return { n, maxAbs: A > 0 ? mx / A : mx, rms: A > 0 ? Math.sqrt(ss / Math.max(1, n)) / A : Math.sqrt(ss / Math.max(1, n)) };
}

/**
 * NRMSE_t (G1-4 §8.1): RMS over the common frame grid of (rebuild − source)/A, frames matched by time (same rate, same
 * schedule), no DTW. Used for the spring-specimen replay rule (≤ 0.005).
 */
export function nrmseT(src, reb, A) {
  const m = new Map(); for (let i = 0; i < reb.T.length; i++) m.set(reb.T[i].toFixed(6), reb.v[i]);
  let ss = 0, n = 0; for (let i = 0; i < src.T.length; i++) { const r = m.get(src.T[i].toFixed(6)); if (r == null) continue; ss += (r - src.v[i]) ** 2; n++; }
  if (!n) return { n: 0, nrmse: null };
  const amp = A || (Math.max(...src.v) - Math.min(...src.v)) || 1;
  return { n, nrmse: Math.sqrt(ss / n) / amp };
}

// ------------------------------------------------------------------ arm 1 (scrollY sweep)
/**
 * Settled value per sweep landing: the last sample after each scrollTo and before the next input.
 * Returns {down: Map(y -> v), up: Map(y -> v), unsettled: n} (direction from the previous landing).
 */
export function sweepProfile(series, landings) {
  const down = new Map(), up = new Map(); let unsettled = 0;
  let prevY = null;
  for (let i = 0; i < landings.length; i++) {
    const L = landings[i]; const Tn = i + 1 < landings.length ? landings[i + 1].T : Infinity;
    let last = -1, prev = -1;
    for (let j = 0; j < series.T.length; j++) if (series.T[j] > L.T + 1e-9 && series.T[j] <= Tn + 1e-9) { prev = last; last = j; }
    if (last < 0) { prevY = L.y; continue; }
    if (prev >= 0 && series.v[last] !== series.v[prev]) unsettled++;
    const dir = prevY == null || L.y >= prevY ? down : up;
    dir.set(L.y, series.v[last]);
    prevY = L.y;
  }
  return { down, up, unsettled };
}

function profileArrays(map) { const ys = [...map.keys()].sort((a, b) => a - b); return { ys, vs: ys.map(y => map.get(y)) }; }

/**
 * Arm 1 cues for one channel: map error vs scrollY before and after the best range shift (searched over ±maxShiftPx at
 * 1 px, rebuild compared with the source shifted by s), normalised by the source range.
 */
export function sweepCues(srcProf, rebProf, { vh, maxShiftPx, bar = 0 }) {
  const dirs = ['down', 'up'].map(d => ({ d, s: profileArrays(srcProf[d]), r: profileArrays(rebProf[d]) })).filter(x => x.s.ys.length >= 2 && x.r.ys.length >= 2);
  let lo = Infinity, hi = -Infinity; for (const x of dirs) for (const v of x.s.vs) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const A = hi - lo;
  let rlo = Infinity, rhi = -Infinity; for (const x of dirs) for (const v of x.r.vs) { rlo = Math.min(rlo, v); rhi = Math.max(rhi, v); }
  const common = dirs.reduce((n, x) => n + x.r.ys.filter(y => x.s.ys.includes(y)).length, 0);
  if (!dirs.length || !(A > bar)) return { static: true, A, rebRange: rhi - rlo, common, n: dirs.length };
  const errAt = (s) => {
    let mx = 0, ss = 0, n = 0;
    for (const x of dirs) for (let i = 0; i < x.r.ys.length; i++) {
      const sv = interp(x.s.ys, x.s.vs, x.r.ys[i] + s); if (sv == null) continue;
      const d = Math.abs(x.r.vs[i] - sv) / A; mx = Math.max(mx, d); ss += d * d; n++;
    }
    return { mx, rms: n ? Math.sqrt(ss / n) : Infinity, n };
  };
  const at0 = errAt(0);
  let best = { s: 0, ...at0 };
  for (let s = -maxShiftPx; s <= maxShiftPx; s++) {
    if (s === 0) continue;
    const e = errAt(s); if (e.n < 0.8 * at0.n) continue;
    if (e.rms < best.rms - 1e-12) best = { s, ...e };
  }
  // reb(y) ≈ src(y + s): the rebuild's map sits -s px later in the scroll (positive shiftPx = later)
  return { A, common, maxAbs: at0.mx, rms: at0.rms, shiftPx: -best.s, shiftVh: -best.s / vh, shiftAtSearchBound: Math.abs(best.s) >= maxShiftPx, residualMax: best.mx, residualRms: best.rms };
}
