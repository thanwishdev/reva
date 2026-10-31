// Dev viewer: node tools/view.mjs <route> <variant> <rate> [gridIndex|default] [from] [to] -- prints watched channels per row.
import { serveLab, recordCell, loadRoutes, elementIndex } from './harness.mjs';
const [route, variant, rate = '120', gi = 'default', from = '0', to = '1e9'] = process.argv.slice(2);
const r = loadRoutes().routes.find((x) => x.id === route);
const params = gi === 'default' ? r.params.default : r.params.grid[+gi];
const srv = await serveLab();
try {
  const take = await recordCell({ origin: srv.origin, route, params, variant, rate: +rate });
  console.log('marks', JSON.stringify(take.marks.map((m) => [m.name, m.k, m.T])), 'inputs', JSON.stringify(take.inputLog.map((i) => [i.type, i.k, i.T, i.want, i.got])));
  console.log('els', JSON.stringify(take.els), 'errors', JSON.stringify(take.errors || []), JSON.stringify(take.pageErrors));
  console.log('births', take.data.births.length, JSON.stringify(take.data.births.slice(0, 3).map((b) => [b.name, b.tgt, b.T, b.k, b.delay, b.duration, b.easing])));
  for (const row of take.data.rows) {
    if (row.k < +from || row.k > +to) continue;
    console.log(row.k, row.T, row.sy, JSON.stringify(Object.entries(row.v).map(([id, c]) => [id, ...Object.entries(c).filter(([k]) => /^(ren:(tx|ty|sx|opacity|bx|by|bw|bh|--[a-z]+)|drv:--)/.test(k)).map(([k, v]) => k.slice(4) + '=' + (typeof v === 'number' ? +v.toFixed(5) : v))])));
  }
} finally { await srv.close(); }
