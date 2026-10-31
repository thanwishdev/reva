// Test points (review F1): captured points + held-out points the capture never saw.
// Held-out = t-1 and t+1 of every edge, N seeded random widths per band, and one height change per captured class
// (svh/dvh/vh units). Each point runs in the viewport class whose captured width is nearest (same UA/DPR/touch).

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

/**
 * @param {object} o
 * @param {{cls:string,w:number,h:number}[]} o.captured
 * @param {number[]} o.edges   viewport widths t where layout flips between t and t+1 (t = last old width)
 * @param {{from:number,to:number}} o.range
 * @param {number} [o.perBand=2] @param {number} [o.seed=7] @param {number} [o.heightDelta=-200]
 * @returns {{id:string,cls:string,w:number,h:number,kind:string}[]}
 */
export function testPoints({ captured, edges, range, perBand = 2, seed = 7, heightDelta = -200 }) {
  const capW = new Set(captured.map(c => c.w));
  const nearest = w => captured.reduce((b, c) => (Math.abs(c.w - w) < Math.abs(b.w - w) ? c : b));
  const pts = new Map();
  const add = (w, kind, h) => {
    if (w < range.from || w > range.to) return;
    const c = nearest(w);
    const hh = h ?? c.h;
    const id = `${c.cls}-${w}x${hh}`;
    if (!pts.has(id)) pts.set(id, { id, cls: c.cls, w, h: hh, kind });
  };
  for (const c of captured) add(c.w, 'captured', c.h);
  const es = [...new Set(edges)].sort((a, b) => a - b);
  for (const t of es) for (const w of [t - 1, t + 1]) if (!capW.has(w)) add(w, 'heldout-edge');
  const r = rng(seed);
  const bounds = [range.from, ...es.filter(t => t > range.from && t < range.to), range.to];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const lo = bounds[i] + 2, hi = bounds[i + 1] - 1;
    if (hi <= lo) continue;
    for (let k = 0; k < perBand; k++) { const w = lo + Math.floor(r() * (hi - lo + 1)); if (!capW.has(w)) add(w, 'heldout-band'); }
  }
  for (const c of captured) add(c.w, 'heldout-height', c.h + heightDelta);
  return [...pts.values()];
}
