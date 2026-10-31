// Writes truth/<route>.json for review (run after gen.mjs): every cell of the route table x regimes R2-R5.
// R6 reuses R2's truth (the rendered values are identical; only the sampling is thinned). The lab server refuses truth/.
import fs from 'node:fs';
import path from 'node:path';
import { truth } from './truth.mjs';
import { loadRoutes, ROOT } from './cell.mjs';

fs.mkdirSync(path.join(ROOT, 'truth'), { recursive: true });
for (const r of loadRoutes()) {
  const cells = [];
  for (const tn of Object.keys(r.traces)) for (const p of r.params.grid) {
    const regimes = {};
    for (const R of ['R2', 'R3', 'R4', 'R5']) { const t = truth(r.id, p, R, { trace: tn }); regimes[R] = { items: t.items, planned: t.planned }; }
    const t2 = truth(r.id, p, 'R2', { trace: tn });
    cells.push({ trace: tn, params: t2.params, attribution: t2.attribution, metrics: t2.metrics, regimes, r6: 'same as R2' });
  }
  fs.writeFileSync(path.join(ROOT, 'truth', `${r.id}.json`), JSON.stringify({ schema: 'reva.labtruth/0', route: r.id, cells }, null, 1) + '\n');
  console.log(r.id, cells.length, 'cells');
}
