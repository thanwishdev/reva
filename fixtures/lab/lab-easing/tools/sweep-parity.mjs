// Parity over every cell (route x grid parameter x trace) at the given rates. Reports go to the private output root.
// node tools/sweep-parity.mjs [rates=120,60] [route|all] [gridMax=5]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureOutDir } from '../../../../src/util/paths.js';
import { serveLab, loadRoutes } from './harness.mjs';
import { parityCell, summarize } from './parity.mjs';

const [ratesArg = '120,60', which = 'all', gridMax = '5'] = process.argv.slice(2);
const rates = ratesArg.split(',').map(Number);
const dir = ensureOutDir('m2', 'parity', 'lab-easing');
const out = path.join(dir, `parity-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const srv = await serveLab();
let n = 0, bad = 0;
const t0 = Date.now();
try {
  for (const r of loadRoutes().routes) {
    if (which !== 'all' && r.id !== which) continue;
    for (let gi = 0; gi < Math.min(r.params.grid.length, +gridMax); gi++) {
      for (const variant of Object.keys(r.traces)) {
        for (const rate of rates) {
          const res = await parityCell({ origin: srv.origin, route: r.id, params: r.params.grid[gi], variant, rate });
          const digest = crypto.createHash('sha256').update(JSON.stringify(res.take.data.rows)).digest('hex').slice(0, 16);
          const worst = res.channels.reduce((m, c) => Math.max(m, c.tol ? c.maxAbs / c.tol : 0), 0);
          fs.appendFileSync(out, JSON.stringify({ route: r.id, grid: gi, variant, rate, pass: res.pass, worstRatio: worst, rowsDigest: digest, frames: res.frames,
            bad: res.channels.filter((c) => !c.ok), births: res.births, errors: res.errors }) + '\n');
          n++; if (!res.pass) bad++;
          console.log(`g${gi} ${summarize(res)} ratio=${worst.toFixed(2)}`);
        }
      }
    }
  }
} finally { await srv.close(); }
console.log(`cells ${n}, failed ${bad}, ${((Date.now() - t0) / 1000).toFixed(0)} s, report ${out}`);
process.exitCode = bad ? 1 : 0;
