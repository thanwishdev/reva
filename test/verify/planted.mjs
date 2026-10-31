// Planted defects through the verify loop (src/verify/planted.js): every row must be CAUGHT (layer 1 different + a
// provisional layer-2 verdict that is not pass). Writes <out>/m3/verify/planted-<time>.json.
import fs from 'node:fs';
import path from 'node:path';
import { runPlanted } from '../../src/verify/planted.js';
import { ensureOutDir } from '../../src/util/paths.js';

const r = await runPlanted({});
const file = path.join(ensureOutDir('m3', 'verify'), `planted-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(r, null, 1));
console.log(`${r.ok ? 'PASS' : 'FAIL'}  planted-defects-caught-by-verify-loop  ${r.rows.filter((x) => x.caught).length}/${r.rows.length}\nreport: ${file}`);
process.exitCode = r.ok ? 0 : 1;
