// Scroll-map extras (design §4.7): pins (screen rect constant while scrollY changes) and hysteresis on integer/class
// outputs (change points differ up vs down → band edges per direction). Both read samples only.

/**
 * Pins per element: maximal scroll intervals over which the element's screen y (ren:by) stays constant while the
 * scroll changes, for elements that otherwise move with the scroll.
 */
export function findPins(view, sy) {
  const out = []; const rows = view.rows; const tol = 2 / 64;
  for (const [i, desc] of view.elements.entries()) {
    const pts = []; for (let k = 0; k < rows.length; k++) { const v = rows[k].v && rows[k].v[i]; if (!v || !Number.isFinite(+v['ren:by'])) continue; pts.push({ s: sy[k], y: +v['ren:by'] }); }
    if (pts.length < 6) continue;
    const bySy = new Map(); for (const p of pts) bySy.set(p.s, p.y);   // last value seen at each scroll position (settled)
    const S = [...bySy.keys()].sort((a, b) => a - b); if (S.length < 4) continue;
    const Y = S.map((s) => bySy.get(s));
    const moves = Y.some((y, j) => j && Math.abs(y - Y[j - 1]) > tol); if (!moves) continue;
    let a = 0;
    for (let j = 1; j <= S.length; j++) {
      if (j < S.length && Math.abs(Y[j] - Y[a]) <= tol) continue;
      if (j - 1 - a >= 2 && S[j - 1] - S[a] > 0) {
        // a pin is constant over the interval AND the element moves with the scroll on at least one side
        const before = a > 0 && Math.abs(Y[a - 1] - Y[a]) > tol, after = j < S.length && Math.abs(Y[j] - Y[j - 1]) > tol;
        // an element in normal flow moves 1:1 with the scroll: screenY + scrollY = its document position. Samples on
        // a side of the pin that agree on that sum give the edge exactly (edge = doc position − held screenY); else
        // the edge is only bracketed by the neighbouring offsets (lab case M04: gap trace 300 → 650 px around a 400 px
        // pin start; the old report used the first pinned offset, 650)
        const side = (lo, hi) => { const q = []; for (let k = lo; k <= hi; k++) q.push(Y[k] + S[k]); return q.length && q.every((v) => Math.abs(v - q[0]) <= tol) ? q[0] : null; };
        const docB = a > 0 ? side(0, a - 1) : null, docA = j < S.length ? side(j, S.length - 1) : null;
        const start = docB != null ? { value: docB - Y[a], ci95: [docB - Y[a] - tol, docB - Y[a] + tol], provenance: 'measured' } : { value: null, interval: [S[a - 1] ?? null, S[a]], provenance: 'unknown' };
        const end = docA != null ? { value: docA - Y[a], ci95: [docA - Y[a] - tol, docA - Y[a] + tol], provenance: 'measured' } : { value: null, interval: [S[j - 1], S[j] ?? null], provenance: 'unknown' };
        if (before || after) out.push({ el: i, desc, start_px: start.value, end_px: end.value, start, end, screenY: Y[a], heldFrom_px: S[a], heldTo_px: S[j - 1], resolution_px: Math.max(S[a] - (S[a - 1] ?? S[a]), (S[j] ?? S[j - 1]) - S[j - 1]), provenance: 'measured' });
      }
      a = j;
    }
  }
  return out;
}

/**
 * Hysteresis on an integer-valued series: change points while scrolling up vs down. When a continuous sibling channel
 * (e.g. the driver variable the index is derived from) is given, edges are also reported in its units.
 */
export function hysteresis(s, sy, sibling) {
  if (!s.y.every((v) => Math.abs(v - Math.round(v)) < 1e-9)) return null;
  // an index is a small integer (a slide, a step of a staircase): a counter shown in the text (ren:text, 0 -> 314160) or a
  // whole value that overflows (a layer at 3e19 px) is not one, and walking every integer between its ends is quadratic in
  // that span (or never ends: Map size exceeded)
  let lo = Infinity, hi = -Infinity; for (const v of s.y) { if (v < lo) lo = v; if (v > hi) hi = v; } if (hi - lo > 1000) return null;
  const edges = new Map();
  for (let i = 1; i < s.y.length; i++) {
    if (s.y[i] === s.y[i - 1]) continue;
    let j = i; while (j > 0 && sy[j] === sy[j - 1]) j--; if (j === 0) continue;
    const dir = sy[j] > sy[j - 1] ? 'down-page' : 'up-page';   // scrollY increasing = scrolling down the page
    const key = `${Math.min(s.y[i], s.y[i - 1])}-${Math.max(s.y[i], s.y[i - 1])}`;
    const e = edges.get(key) || { between: [Math.min(s.y[i], s.y[i - 1]), Math.max(s.y[i], s.y[i - 1])], 'down-page': [], 'up-page': [] };
    e[dir].push({ scroll_px: sy[i], prev_px: sy[j - 1], sibling: sibling ? sibling[i] : null }); edges.set(key, e);
  }
  const bands = [...edges.values()].map((e) => {
    const m = (a, f) => (a.length ? a.reduce((x, q) => x + f(q), 0) / a.length : null);
    const d = m(e['down-page'], (q) => q.scroll_px), u = m(e['up-page'], (q) => q.scroll_px);
    // the switch happened between the previous offset and this one: the tightest bracket over the events is the edge's
    // interval (its midpoint the value); a wide bracket means the edge is not resolved by these offsets
    const br = (a) => { if (!a.length) return null; let lo = -Infinity, hi = Infinity; for (const q of a) { lo = Math.max(lo, Math.min(q.prev_px, q.scroll_px)); hi = Math.min(hi, Math.max(q.prev_px, q.scroll_px)); } return lo <= hi ? [lo, hi] : null; };
    const bd = br(e['down-page']), bu = br(e['up-page']);
    return { between: e.between, downEdge_px: d, upEdge_px: u, width_px: d != null && u != null ? d - u : null, downEdge_interval: bd, upEdge_interval: bu,
      downEdge_sibling: m(e['down-page'].filter((q) => q.sibling != null), (q) => q.sibling), upEdge_sibling: m(e['up-page'].filter((q) => q.sibling != null), (q) => q.sibling), provenance: 'measured' };
  });
  // state-derived edge intervals (lab case M04 gap/reversal traces: an edge crossed in one direction only had no
  // interval at all, and a bracket from the switch events alone ignores the offsets where the index HELD). Rule of an
  // index i with edges up[j] (switch j → j+1 when the offset reaches it) and down[j] (j+1 → j): a frame that moved the
  // index from p to q > p at offset x proves up[p..q−1] ≤ x and, when it stopped, up[q] > x; a frame that held p proves
  // up[p] > x and down[p−1] < x; downward symmetric. Each interval is the closed set that reproduces every frame
  // (open ends moved 1e-6 px inside).
  const lim = new Map(); const L = (dir, j) => { const k = dir + j; if (!lim.has(k)) lim.set(k, [-Infinity, Infinity]); return lim.get(k); };
  const eps = 1e-6;
  for (let i = 1; i < s.y.length; i++) {
    const p = Math.round(s.y[i - 1]), q = Math.round(s.y[i]), x = sy[i]; if (!Number.isFinite(x)) continue;
    if (q > p) { for (let j = p; j < q; j++) { const u = L('up', j); u[1] = Math.min(u[1], x); } const u = L('up', q); u[0] = Math.max(u[0], x + eps); }
    else if (q < p) { for (let j = q; j < p; j++) { const d = L('down', j); d[0] = Math.max(d[0], x); } if (q > 0) { const d = L('down', q - 1); d[1] = Math.min(d[1], x - eps); } }
    else { const u = L('up', p); u[0] = Math.max(u[0], x + eps); if (p > 0) { const d = L('down', p - 1); d[1] = Math.min(d[1], x - eps); } }
  }
  const lo0 = Math.min(...s.y.map(Math.round)), hi0 = Math.max(...s.y.map(Math.round));
  for (let j = lo0; j < hi0; j++) {
    let b = bands.find((q) => q.between[0] === j && q.between[1] === j + 1);
    if (!b) { b = { between: [j, j + 1], downEdge_px: null, upEdge_px: null, width_px: null, downEdge_interval: null, upEdge_interval: null, downEdge_sibling: null, upEdge_sibling: null, provenance: 'measured' }; bands.push(b); }
    const u = lim.get('up' + j), d = lim.get('down' + j);
    if (u && u[0] <= u[1]) b.downEdge_interval = u.map((v) => (Number.isFinite(v) ? v : null));   // scrolling down the page = the index rising
    if (d && d[0] <= d[1]) b.upEdge_interval = d.map((v) => (Number.isFinite(v) ? v : null));
    b.intervalRule = 'state-derived';
  }
  bands.sort((a, b) => a.between[0] - b.between[0] || a.between[1] - b.between[1]);
  return bands.length ? { bands, hysteresis: bands.some((b) => b.width_px != null && Math.abs(b.width_px) > 0) } : null;
}

/**
 * The set of map corners (and, for a linear shape, slopes) that reproduce the sampled offsets exactly, when the corners
 * are not identified (Amendment 2 B: an abstention reports its interval). Map: y = a + b·S(clamp((s − s0)/(s1 − s0))),
 * S known (named shape or declared easing), a and b from the plateaus. Two cases:
 *  - one offset x inside the range with both plateaus around it: progress q = S⁻¹((y − a)/b) fixes (x − s0)/(s1 − s0) = q,
 *    a one-parameter ridge s1 = s0 + (x − s0)/q, bounded by the nearest plateau offsets (lab cases M01 g4 gap, M11 g3 gap);
 *  - a linear shape with ≥ 2 inner offsets and no offset past one corner: that corner is anywhere beyond the last offset
 *    (a, b re-scale; lab case M01 o = 0, the corner at the scroll minimum).
 * @param {{a:number, b:number, S:(u:number)=>number, linear:boolean, pairs:{s:number,y:number}[], tolv:number}} o
 * @returns {{s0:number[]|null, s1:number[]|null, slope:number[]|null, case:string}|null}
 */
export function mapRidge({ a, b, S, linear, pairs, tolv, s0 = null, s1 = null }) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !b || !pairs.length) return null;
  const pr = (y) => (y - a) / b;
  const inner = pairs.filter((q) => pr(q.y) > tolv / Math.abs(b) && pr(q.y) < 1 - tolv / Math.abs(b));
  const below = pairs.filter((q) => Math.abs(pr(q.y)) <= tolv / Math.abs(b)), above = pairs.filter((q) => Math.abs(pr(q.y) - 1) <= tolv / Math.abs(b));
  const inv = (u) => { let lo = 0, hi = 1; for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2; if (S(m) < u) lo = m; else hi = m; } return (lo + hi) / 2; };
  if (inner.length === 1) {
    const x = inner[0].s, q = inv(pr(inner[0].y)); if (!(q > 0 && q < 1)) return null;
    const xb = Math.max(-Infinity, ...below.filter((p) => p.s < x).map((p) => p.s)), xa = Math.min(Infinity, ...above.filter((p) => p.s > x).map((p) => p.s));
    if (below.some((p) => p.s > x) || above.some((p) => p.s < x)) return null;   // not a monotone map in s
    const L0 = Math.max(xb, Number.isFinite(xa) ? (x - q * xa) / (1 - q) : -Infinity);
    const s1hi = Number.isFinite(L0) ? L0 + (x - L0) / q : Infinity;
    const slope = linear ? [b * q / (x - L0), b > 0 ? Infinity : -Infinity].sort((u, v) => u - v) : null;
    // the ridge's end at the inner offset itself is a zero-width range (a step), not attained: report the closed set
    // 0.5 px short of it (a quarter of the 2 px tolerance; the ridge near that end is numerically ill-conditioned)
    return { s0: [L0, x - 0.5], s1: [x + 0.5, s1hi], slope, case: 'one inner offset' };
  }
  if (inner.length >= 2 && linear) {
    const xs = pairs.map((p) => p.s); const lo = Math.min(...xs), hi = Math.max(...xs);
    const out = { s0: null, s1: null, slope: null, case: 'linear, corner beyond the sampled offsets' };
    // the corner sits at or beyond the last offset (an offset ON the corner reads the plateau value but does not bound it)
    if (s0 != null && !xs.some((v) => v < s0 - 1)) out.s0 = [-Infinity, lo];
    if (s1 != null && !xs.some((v) => v > s1 + 1)) out.s1 = [hi, Infinity];
    return out.s0 || out.s1 ? out : null;
  }
  return null;
}
