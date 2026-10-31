// Writes truth/<route>.<variant>.json for review: default parameters, regime R3 (120 Hz), planned trace.
// The runner/scorer call truth() directly per (params, regime, actual take); these files are only a readable sample.
import fs from 'node:fs';
import path from 'node:path';
import { loadRoutes, loadTrace, ROOT } from './harness.mjs';
import { truth } from '../truth.mjs';

fs.mkdirSync(path.join(ROOT, 'truth'), { recursive: true });
let n = 0;
for (const r of loadRoutes().routes) {
  for (const variant of Object.keys(r.traces)) {
    const t = truth(r.id, r.params.default, 'R3', { trace: loadTrace(r.id, variant) });
    fs.writeFileSync(path.join(ROOT, 'truth', `${r.id}.${variant}.json`), JSON.stringify(t, null, 1) + '\n');
    n++;
  }
}
console.log('wrote', n, 'truth files');
