// Generates truth/<route>.json for review (not served; the scorer calls truth() directly).
// Default parameters: every trace variant x R2..R5. Other grid vectors: parameters + R3 truth on the first trace.
// Run: node tools/gen-truth.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { truth, ROUTES } from '../truth.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildTruthFile(route) {
  const variants = Object.keys(route.traces);
  const dflt = {};
  for (const v of variants) { dflt[v] = {}; for (const reg of ['R2', 'R3', 'R4', 'R5']) dflt[v][reg] = truth(route.id, route.params.default, reg, { variant: v }); }
  const grid = route.params.grid.map((p, i) => ({ index: i, params: p, R3: truth(route.id, p, 'R3', { variant: variants[0] }) }));
  return {
    note: 'Generated for review by tools/gen-truth.mjs. Planned-trace values (start signal at k = 0); the scorer calls truth(route, params, regime, {variant, ctx}) with the actual take.',
    route: route.id, default: dflt, grid,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(root, 'truth'), { recursive: true });
  for (const r of ROUTES) fs.writeFileSync(path.join(root, 'truth', `${r.id}.json`), JSON.stringify(buildTruthFile(r), null, 1) + '\n');
  console.log(`wrote ${ROUTES.length} truth files`);
}
