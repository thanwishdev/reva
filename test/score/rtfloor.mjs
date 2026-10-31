// M3 Amendment 1 (rt live floor): record N attended rt takes of the scorer-fixture reference and score them against each
// other in the SAME lane (hx and rt takes are never compared, compareEnv refuses it). ATTENDED: the display must be awake.
//   node test/score/rtfloor.mjs [--takes 3] [--out <file>]
// Output: per mechanism, the pairwise scores and the rt floor in score units = the largest drop 1 - S over the pairs
// (the same convention as the read-back floor, readbackFloorSd) plus the sd of the pair scores for the record.
// The schedule is driven from inside the page from one anchor (no wall-clock drift between steps), and each take's time
// axis is rebased to its 'go' trigger so the two takes' inputs are within one frame (compareEvents); nothing else is changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { serve, VIEWPORT, WATCH, STEPS } from './record.mjs';
import { openSession } from '../../src/record/session.js';
import { fromTakeDir } from '../../src/score/series.js';
import { scoreTakeSets } from '../../src/score/score.js';
import { mean, sd } from '../../src/score/protocol.js';
import { ensureOutDir } from '../../src/util/paths.js';
import { SPEC } from './spec.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg('--takes', 3);

/** Display-awake check (NIGHT_PLAN note c). Returns the evidence string, or throws. */
function displayAwake() {
  const a = execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' });
  const user = /UserIsActive\s+(\d)/.exec(a);
  let state = null;
  try { const m = /CurrentPowerState\D+(\d)/.exec(execFileSync('ioreg', ['-n', 'IODisplayWrangler', '-r'], { encoding: 'utf8' })); state = m ? +m[1] : null; } catch {}
  if (!(state === 4 || (state == null && user && user[1] === '1'))) throw new Error(`display not confirmed awake (UserIsActive=${user && user[1]}, CurrentPowerState=${state})`);
  return `UserIsActive=${user && user[1]} CurrentPowerState=${state == null ? 'n/a on this OS' : state}`;
}

const rebase = (t) => {
  const t0 = t.events[0].T;
  return { ...t, rows: t.rows.map(r => ({ ...r, T: r.T - t0 })), events: t.events.map(e => ({ ...e, T: e.T - t0 })) };
};

const display = displayAwake();
const srv = await serve();
const takes = [];
const loads = [];
try {
  for (let i = 0; i < N; i++) {
    displayAwake();
    loads.push(os.loadavg()[0]);
    const s = await openSession({ lane: 'rt', rate: 120, url: `${srv.origin}/?`, viewport: VIEWPORT, seed: 7, discover: false, engine: 'chs' });
    try {
      await s.goto(); await s.boot({ until: 'window.__ready === true' });
      await s.watch(WATCH);
      await s.clearSamples();
      await s.hold(200);
      // one anchor, absolute offsets: go at 0, then each scroll step at 1300 + i * 900 ms
      await s.ev((steps) => { window.__go(); steps.forEach((y, i) => setTimeout(() => window.__scrollAt(y), 1300 + i * 900)); }, STEPS);
      await s.hold(1300 + STEPS.length * 900);
      const events = await s.ev(() => window.__ev);
      const r = await s.finish({ scenario: `rt-floor-take${i + 1}`, target: 'scorer-fixture', extra: { query: {}, events }, write: true });
      const t = fromTakeDir(r.dir); t.events = events;
      takes.push(rebase(t));
      process.stdout.write(`rt take ${i + 1}: ${t.rows.length} rows, ${events.length} events, refreshHz ${t.meta.refreshHz}, load1 ${loads[i].toFixed(1)}, ${r.dir}\n`);
    } finally { await s.close(); }
  }
} finally { await srv.close(); }

const pairs = [];
for (let a = 0; a < takes.length; a++) for (let b = a + 1; b < takes.length; b++) pairs.push([a, b]);
const mech = {};
const refused = [];
for (const [a, b] of pairs) {
  const A = takes[a], B = takes[b];
  const r = scoreTakeSets({ src: { response: A }, reb: { response: B } }, SPEC, { events: { src: A.events, reb: B.events } });
  if (r.refused.length) { refused.push({ pair: [a + 1, b + 1], why: r.refused }); continue; }
  for (const m of r.mechanisms) {
    if (!m.pooled || !['duration', 'spring-k', 'lag', 'hold', 'alpha'].includes(m.id)) continue;
    (mech[m.id] = mech[m.id] || []).push({ pair: [a + 1, b + 1], score: m.pooled.score, layer1: m.verdict && m.verdict.layer1 });
  }
}
const out = { schema: 'reva.rtfloor/0', created: new Date().toISOString(), display, loadavg1: loads, host: os.cpus().length + ' cpus',
  takes: takes.map(t => ({ id: t.id, digest: t.digest, refreshHz: t.meta.refreshHz, lane: t.meta.lane })), refused,
  rule: 'rt floor (score units) = max over take pairs of 1 - S (same convention as readbackFloorSd); sd of the pair scores reported alongside',
  mechanisms: Object.fromEntries(Object.entries(mech).map(([id, ps]) => { const sc = ps.map(p => p.score); return [id, { pairs: ps, meanScore: mean(sc), sdScore: sd(sc), maxDrop: Math.max(...sc.map(x => 1 - x)), floor: Math.max(0, ...sc.map(x => 1 - x)) }]; })) };
const file = arg('--out', path.join(ensureOutDir('m3', 'score'), `rtfloor-${out.created.replace(/[:.]/g, '-')}.json`));
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ display, refused, mechanisms: Object.fromEntries(Object.entries(out.mechanisms).map(([k, v]) => [k, { scores: v.pairs.map(p => p.score), maxDrop: v.maxDrop, sd: v.sdScore }])) }, null, 1));
console.log('rtfloor json:', file);
