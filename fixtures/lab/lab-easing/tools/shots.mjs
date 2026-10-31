// Screenshots of each route in motion (headless, repo launcher): node tools/shots.mjs [route|all]
// Written to ~/.reva/out/m2/parity/lab-easing/shots/. A visual check that every page renders.
import fs from 'node:fs';
import path from 'node:path';
import { ensureOutDir } from '../../../../src/util/paths.js';
import { openSession } from '../../../../src/record/session.js';
import { serveLab, loadRoutes } from './harness.mjs';
import { encodeParams } from '../core.js';

// [actions before the shot (after boot)] per route: wait for the motion to be mid-flight
const PLAN = {
  m06: [{ hold: 400 }, { eval: '__go()' }, { hold: 1500 }],
  m11: [{ hold: 400 }, { scrollTo: 1100 }, { hold: 200 }],
  m12: [{ hold: 400 }, { scrollTo: 1000 }, { hold: 700 }],
  m15: [{ hold: 400 }, { eval: '__go()' }, { hold: 1800 }],
  m17: [{ hold: 400 }, { eval: '__go()' }, { hold: 300 }],
  m18: [{ hold: 400 }, { eval: '__go()' }, { hold: 250 }],
  m19: [{ hold: 400 }, { eval: '__go()' }, { hold: 800 }],
  m16e: [{ hold: 400 }, { eval: '__go()' }, { hold: 500 }],
  m16f: [{ hold: 400 }, { eval: '__go()' }, { hold: 400 }],
};
const which = process.argv[2] || 'all';
const dir = ensureOutDir('m2', 'parity', 'lab-easing', 'shots');
const srv = await serveLab();
try {
  for (const r of loadRoutes().routes) {
    if (which !== 'all' && r.id !== which) continue;
    const url = `${srv.origin}/${r.page}#p=${encodeParams(r.params.default)}`;
    const s = await openSession({ lane: 'hx', rate: 60, url, engine: 'chs', viewport: { width: 1280, height: 800 }, seed: 1, scene: { computedVars: r.watch.computedVars || [] } });
    try {
      await s.goto(url); await s.boot({ until: 'window.__ready === true' });
      for (const a of PLAN[r.id]) {
        if ('hold' in a) await s.hold(a.hold); else if ('eval' in a) await s.ev((src) => (0, eval)(src), a.eval); else if ('scrollTo' in a) await s.scrollTo(a.scrollTo);
      }
      const file = path.join(dir, `${r.id}.png`);
      fs.writeFileSync(file, await s.page.screenshot({ type: 'png' }));
      console.log('shot', file);
    } finally { await s.close(); }
  }
} finally { await srv.close(); }
