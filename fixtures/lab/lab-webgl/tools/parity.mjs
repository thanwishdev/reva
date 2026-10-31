// Usage: node tools/parity.mjs <route|all> [--grid i,j] [--variant v] [--rate 120,60] [--all-variants] [--out dir]
// Records the cells with the repo recorder (hx lane) and prints max |rendered - refsim| per channel against 2x floor.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../serve.mjs';
import { outRoot } from '../../../../src/util/paths.js';
import { routesJson, recordCell, parity, gridParams } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const want = args[0] || 'all';
const gridSel = flag('grid', null)?.split(',').map(Number);
const rates = (flag('rate', '120,60')).split(',').map(Number);
const outDir = flag('out', path.join(outRoot(), 'm2', 'parity', 'lab-webgl'));
const allVariants = args.includes('--all-variants');
fs.mkdirSync(outDir, { recursive: true });
const srv = await startServer();
let fails = 0, cells = 0;
try {
  for (const route of routesJson()) {
    if (want !== 'all' && route.id !== want) continue;
    const variants = flag('variant', null) ? [flag('variant')] : allVariants ? Object.keys(route.traces) : [Object.keys(route.traces)[0]];
    const grid = gridParams(route);
    for (const gi of gridSel || grid.map((_, i) => i)) for (const variant of variants) for (const rate of rates) {
      const t0 = Date.now();
      const take = await recordCell({ route, params: grid[gi], variant, rate, server: srv });
      const p = parity(take, route.id, grid[gi]);
      cells++; if (!p.pass) fails++;
      const tag = `${route.id}.g${gi}.${variant}.r${rate}`;
      fs.writeFileSync(path.join(outDir, `${tag}.json`), JSON.stringify({ tag, params: grid[gi], rate, pass: p.pass, channels: p.channels, events: p.events.slice(0, 40), rows: take.data.rows.length, errors: take.pageErrors, escapes: Object.keys(take.escapes || {}) }, null, 1));
      const worst = Object.entries(p.channels).map(([k, r]) => `${k}:${r.maxAbs.toExponential(2)}/${r.limit.toExponential(1)}${r.missing ? ' MISSING' + r.missing : ''}${r.pass ? '' : ' FAIL'}`);
      console.log(`${p.pass ? 'PASS' : 'FAIL'} ${tag} rows=${take.data.rows.length} ${((Date.now() - t0) / 1000).toFixed(1)}s | ${worst.join('  ')}`);
      if (!p.pass) for (const [k, r] of Object.entries(p.channels)) if (!r.pass) console.log('   first bad', k, JSON.stringify(r.firstBad));
      if (take.pageErrors.length) console.log('   pageErrors', take.pageErrors.slice(0, 3));
    }
  }
} finally { await srv.close(); }
console.log(`parity: ${cells - fails}/${cells} cells pass`);
process.exit(fails ? 1 : 0);
