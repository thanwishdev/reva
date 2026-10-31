// Synthetic take builder for fitter unit tests (own code; no site data). Produces the in-memory shape of
// `loadTake()` ({take, data}) with an hx-like environment and the D3 read-back floors measured in M1.
export const READBACK = {   // D-M1-3 measured maxima with the recorder's planted ranges
  opacity: { maxAbsErr: 5.0e-7, range: 1 }, 'translateX(px)': { maxAbsErr: 5.2e-4, range: 1000 }, scale: { maxAbsErr: 5.0e-6, range: 2 }, 'rotate(deg)': { maxAbsErr: 3.3e-5, range: 170 },
  'translate-prop(px)': { maxAbsErr: 5.2e-4, range: 1000 }, 'border-radius(px)': { maxAbsErr: 5.3e-5, range: 100 }, 'filter-blur(px)': { maxAbsErr: 5.0e-5, range: 20 }, 'clip-inset(%)': { maxAbsErr: 4.8e-5, range: 50 },
  '--var(unregistered)': { maxAbsErr: 0, range: 1 }, 'left(px)': { maxAbsErr: 1.5e-2, range: 1000 },
};
export const r6 = (x) => Math.round(x * 1e6) / 1e6;
export const frameTimes = (rate, durMs, { stall } = {}) => {
  const dt = 1000 / rate; const n = Math.round(durMs / dt); const T = [];
  for (let k = 0; k <= n; k++) T.push(r6(k * dt + (stall ? Math.floor(k / stall.every) * (stall.ms - dt) : 0)));
  return T;
};

/**
 * @param {object} o
 * @param {number} [o.rate]
 * @param {number[]} [o.T]               frame times (default: grid at rate)
 * @param {number} [o.dur]
 * @param {{desc:string, ch:object, rest?:object}[]} o.els   ch: {'ren:tx': number[] | (k, T) => number}
 * @param {number[]} [o.sy]              scrollY per frame
 * @param {object[]} [o.births] [o.inputLog]
 * @param {number} [o.stride]            keep every n-th row (R6), env unchanged
 */
export function synthTake(o) {
  const rate = o.rate || 120; const T = o.T || frameTimes(rate, o.dur || 2000); const dt = 1000 / rate;
  const rows = T.map((t, k) => {
    const v = {};
    o.els.forEach((e, id) => { const ch = {}; for (const [name, f] of Object.entries(e.ch)) ch[name] = typeof f === 'function' ? f(k, t) : f[k]; v[id] = { 'ren:bx': (e.rest && e.rest.x) || 0, 'ren:by': (e.rest && e.rest.y) || 0, 'ren:bw': 20, 'ren:bh': 20, ...ch }; });
    return { k, T: t, sy: o.sy ? o.sy[k] : 0, sx: 0, v };
  });
  const kept = o.stride ? rows.filter((_, i) => i % o.stride === 0) : rows;
  const env = {
    lane: { value: 'hx', provenance: 'declared' }, virtualRateHz: { value: rate, provenance: 'declared' }, dtMs: { value: dt, provenance: 'declared' },
    readbackFloor: { value: READBACK, provenance: 'measured' }, viewport: { value: { width: 1280, height: 800 }, provenance: 'measured' },
  };
  return {
    take: { schema: 'reva.take/0', scenario: o.scenario || 'synthetic', target: 'fixture', lane: 'hx', rate, env, marks: o.marks || [], extra: o.extra || {}, flags: [], unknowns: [] },
    data: { rows: kept, births: o.births || [], declared: [], mutations: [], wheel: [], inputLog: o.inputLog || [], elements: o.els.map((e) => e.desc) },
  };
}

/** Scroll steps: [[timeMs, y], …] → scrollY per frame; returns {sy, inputLog} (input after frame k lands in row k+1). */
export function scrollSteps(T, steps) {
  const sy = T.map(() => 0); const inputLog = [];
  for (const [ts, y] of steps) { const k = T.findIndex((t) => t >= ts); if (k < 0) continue; for (let i = k; i < T.length; i++) sy[i] = y; inputLog.push({ type: 'scrollTo', want: y, got: y, k: k - 1, T: T[k - 1] }); }
  return { sy, inputLog };
}
