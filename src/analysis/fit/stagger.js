// Stagger, onset and sequence (design §9). Onset clustering reuses understudy's `recoverStagger` (vendored); the
// order/direction decision is ours: regress t0 on every order key, equivalent keys reported together, two
// non-equivalent orders within 1.2× of the best residual → direction `unknown` (U9) — never guess.
import { recoverStagger } from './vendor/understudy/cluster.js';
import { ols } from './numeric.js';

const KEYS = {
  dom: (e) => e.dom, 'reverse-dom': (e) => -e.dom, x: (e) => e.x, 'reverse-x': (e) => -e.x, y: (e) => e.y, 'reverse-y': (e) => -e.y,
  'row-major': (e) => e.y * 1e5 + e.x, 'column-major': (e) => e.x * 1e5 + e.y,
  'center-out': (e, c) => Math.hypot(e.x + e.w / 2 - c.x, e.y + e.h / 2 - c.y), 'edges-in': (e, c) => -Math.hypot(e.x + e.w / 2 - c.x, e.y + e.h / 2 - c.y),
};

/**
 * @param {{id:string, t0:number, dom:number, x:number, y:number, w:number, h:number, shape:string}[]} items
 * @param {{dtMs:number, viewport:{width:number,height:number}}} o
 */
export function analyseStagger(items, o) {
  const groups = new Map(); for (const it of items) { const g = groups.get(it.shape) || []; g.push(it); groups.set(it.shape, g); }
  const out = [];
  for (const [shape, g] of groups) {
    if (g.length < 3) continue;
    const clusters = recoverStagger(g.map((e) => ({ id: e.id, startT: e.t0 })), { floorMs: Math.max(1, o.dtMs * 0.5), maxGroupGapMs: 600 });
    for (const cl of clusters) {
      const mem = cl.memberIds.map((id) => g.find((e) => e.id === id)); if (mem.length < 3) continue;
      const c = { x: o.viewport.width / 2, y: o.viewport.height / 2 };
      const fits = [];
      for (const [key, fn] of Object.entries(KEYS)) {
        const vals = mem.map((e) => fn(e, c)); if (vals.some((v) => !Number.isFinite(v))) continue;
        const order = [...mem.keys()].sort((a, b) => vals[a] - vals[b] || a - b); const rank = new Array(mem.length); order.forEach((ix, r) => { rank[ix] = r; });
        // ties (same key value) share a rank
        let r = 0; const tr = new Array(mem.length); for (let q = 0; q < order.length; q++) { if (q && vals[order[q]] !== vals[order[q - 1]]) r++; tr[order[q]] = r; }
        const sol = ols(mem.map((_, i) => [1, tr[i]]), mem.map((e) => e.t0)); if (!sol) continue;
        fits.push({ key, order: order.map((i) => mem[i].id).join(','), step: sol.beta[1], rms: Math.sqrt(sol.rss / mem.length) });
      }
      const pos = fits.filter((f) => f.step > 0).sort((a, b) => a.rms - b.rms); if (!pos.length) continue;
      const best = pos[0]; const equivalent = pos.filter((f) => f.order === best.order).map((f) => f.key);
      const rivals = pos.filter((f) => f.order !== best.order && f.rms <= 1.2 * Math.max(best.rms, 1e-9 + o.dtMs * 0.05));
      const constant = best.rms <= 0.5 * o.dtMs;
      out.push({ shape, members: mem.map((e) => e.id), interval: { value: best.step, unit: 'ms', provenance: rivals.length ? 'unknown' : 'fitted', ci95: [best.step - o.dtMs, best.step + o.dtMs] },
        direction: rivals.length ? { value: null, provenance: 'unknown', reason: `orders ${[best.key, ...rivals.map((r) => r.key)].join(' / ')} fit within 1.2× residual (U9)`, probe: 'a layout where the candidate orders differ' } : { value: best.key, equivalent, provenance: 'fitted' },
        residual_ms: best.rms, constantStep: constant, understudy: { intervalMs: cl.intervalMs, cv: cl.cv, confident: cl.confident } });
    }
  }
  return out;
}
