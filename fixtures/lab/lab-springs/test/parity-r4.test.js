// Group B parity at R4 (30 Hz, recorder X1). R5 (stall schedule) is covered by the integrator's lab sweep (src/lab).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { serve, loadJson, routes, recordCell, parity, saveTake, parityDir } from './harness.mjs';

test('parity at R4 (30 Hz): every route x default params x every trace', { skip: process.env.LAB_PARITY === 'quick' }, async (t) => {
  const srv = await serve(); const out = [];
  try {
    for (const route of routes()) for (const v of route.codeVariants) for (const tn of Object.keys(route.traces)) {
      await t.test(`${route.id}/${v.id}/${tn}/R4`, async () => {
        const { take, merged } = await recordCell(srv.origin, route, v.default, loadJson(route.traces[tn]), { rate: 30 });
        const p = parity(route, merged, take); const name = `${route.id}.${v.id}.${tn}.R4`;
        out.push({ name, regime: 'R4', dtMs: take.dt, ...p, takeDir: saveTake(take, name) });
        assert.ok(Math.abs(take.dt - 1000 / 30) < 1e-9);
        assert.ok(p.pass, `${name}: ${JSON.stringify(p.channels)}`);
      });
    }
  } finally {
    await srv.close();
    fs.mkdirSync(parityDir(), { recursive: true });
    fs.writeFileSync(path.join(parityDir(), 'parity-r4.json'), JSON.stringify({ schema: 'reva.labparity/0', group: 'lab-springs', regime: 'R4', cells: out }, null, 1));
  }
});
