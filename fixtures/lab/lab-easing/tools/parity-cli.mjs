// node tools/parity-cli.mjs <route|all> [rate] [variant|''] [gridIndex|default] [stall]
import { serveLab, loadRoutes } from './harness.mjs';
import { parityCell, summarize } from './parity.mjs';
const [which = 'all', rate = '120', onlyVariant = '', gi = 'default', stallArg = ''] = process.argv.slice(2);
const stall = stallArg === 'stall';
const routes = loadRoutes().routes.filter((r) => which === 'all' || r.id === which);
const srv = await serveLab();
let bad = 0;
try {
  for (const r of routes) {
    const params = gi === 'default' ? r.params.default : r.params.grid[+gi];
    for (const variant of Object.keys(r.traces)) {
      if (onlyVariant && variant !== onlyVariant) continue;
      const res = await parityCell({ origin: srv.origin, route: r.id, params, variant, rate: +rate, stall });
      console.log(summarize(res));
      for (const c of res.channels.filter((x) => !x.ok).slice(0, 6)) console.log('   bad', JSON.stringify(c));
      for (const m of res.births.mismatches.slice(0, 4)) console.log('   birth', JSON.stringify(m).slice(0, 400));
      if (!res.pass) bad++;
    }
  }
} finally { await srv.close(); }
process.exitCode = bad ? 1 : 0;
