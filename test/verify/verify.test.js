// Verify loop: the parts that need no browser (time mapping, channel pairing, schedules, declared arm, job catalogue),
// plus one recorded lab job when a Fixture Lab is reachable (own tree after the merge, or REVA_LAB_REPO).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shiftInput, normKey, timePairs, scheduleOf, declaredArm, verifyJob } from '../../src/verify/loop.js';
import { specimenActions, labJobs, timeJobs, TIME_DIR, SCRIPT_EPS } from '../../src/verify/jobs.js';
import { labRepo } from '../../src/verify/refs.js';
import { providers } from '../../src/verify/mcp.js';

test('shiftInput moves rows, inputs and marks together on the 1e-6 ms grid and clips a window', () => {
  const inp = { id: 'x', rows: [{ k: 1, T: 8.333333 }, { k: 2, T: 16.666667 }, { k: 3, T: 25 }], inputLog: [{ type: 'scrollTo', T: 8.333333 }], marks: [{ name: 'go', T: 16.666667 }] };
  const s = shiftInput(inp, -8.333333, { from: 0, to: 10 });
  assert.deepEqual(s.rows.map((r) => r.T), [0, 8.333334]);
  assert.equal(s.inputLog[0].T, 0); assert.equal(s.marks[0].T, 8.333334);
  assert.equal(inp.rows.length, 3, 'input not mutated');
});

test('normKey: bare custom property means the driver channel unless only the rendered one exists', () => {
  assert.equal(normKey('.b0|--x'), '.b0|drv:--x');
  assert.equal(normKey('.b0|--x', (k) => k === '.b0|ren:--x'), '.b0|ren:--x');
  assert.equal(normKey('#c|ren:tx'), '#c|ren:tx');
  assert.equal(normKey('#c|opacity'), '#c|ren:opacity');
});

test('time specimen pairs: source selector from the element key, specimen box by id; bounding-box sources keep their channel', () => {
  const spec = { elements: [{ id: 'e0', key: '.b0' }, { id: 'e1', key: '#b0' }],
    tracks: [{ id: 't0', el: 0, channel: 'var', name: '--x', motion: { kind: 'spring' } },
      { id: 't1', el: 1, channel: 'tx', motion: { kind: 'keyframes' }, assumptions: [{ field: 'channel', reason: 'bounding-box channel bx reproduced by the tx channel (base geometry is not in the record)' }] },
      { id: 't2', el: 1, channel: 'opacity', motion: { kind: 'tween' } }] };
  const p = timePairs(spec, () => true);
  assert.deepEqual(p.map((x) => [x.src, x.reb]), [['.b0|drv:--x', '#e0|drv:--x'], ['#b0|ren:bx', '#e1|ren:tx'], ['#b0|ren:opacity', '#e1|ren:opacity']]);
  assert.equal(p[1].offsetOnly, true);
});

test('scheduleOf: spring retargets, chain segments, single onsets', () => {
  assert.deepEqual(scheduleOf({ kind: 'spring', events: [{ t: 900, g: 0 }, { t: 500, g: 1 }] }), [500, 900]);
  assert.deepEqual(scheduleOf({ kind: 'spring', events: [], start: { t: 640 } }), [640]);   // fit-built spring without retargets: its onset
  assert.deepEqual(scheduleOf({ kind: 'spring', events: [{ t: 900 }], start: { t: 640 } }), [900]);   // retargets present: unchanged
  assert.deepEqual(scheduleOf({ kind: 'chain', parts: [{ startMs: 800 }, { startMs: 500 }] }), [500, 800]);
  assert.deepEqual(scheduleOf({ kind: 'tween', startMs: 512 }), [512]);
});

test('specimenActions: time specimens use the documented go trigger; scroll specimens replay the source actions, swapping only the trigger', () => {
  const t = specimenActions({ family: 'time', rate: 120 }, [{ hold: 400 }], { timeline: { durationMs: 1000 } });
  assert.equal(t.mapping, 'anchor'); assert.match(t.actions[0].eval, /new Event\('go'\)/); assert.deepEqual(t.actions[1], { mark: 'go' });
  const src = [{ hold: 400 }, { mark: 'go' }, { eval: '__go()' }, { wheel: { dy: 120, n: 1 } }, { eval: "window.dispatchEvent(new Event('go'))" }];
  const s = specimenActions({ family: 'scroll', rate: 120 }, src, {});
  assert.equal(s.mapping, 'mark');
  assert.deepEqual(s.actions.slice(0, 2), src.slice(0, 2)); assert.deepEqual(s.actions[2], { eval: 'window.specimen.go()' }); assert.deepEqual(s.actions[3], src[3]);
  assert.match(s.actions[4].eval, new RegExp(`specimen\\.script\\(null, performance\\.now\\(\\) \\+ 8\\.33+\\d* - ${SCRIPT_EPS}\\)`));
});

test('declared arm: equal births pass; a longer duration is a timing difference in DL units; a missing birth fails', () => {
  const b = (name, T, duration, easing = 'linear') => ({ name, pseudoElement: `::view-transition-group(${name})`, T, duration, delay: 0, easing, iterations: 1, direction: 'normal', fill: 'both', keyframes: [{ offset: 0, transform: 'matrix(1,0,0,1,0,0)' }] });
  const src = [b('g0', 450, 600), b('g1', 450, 400)];
  const same = declaredArm(src, src, src, { origin: 433.333333 });
  assert.equal(same.verdict.layer1, 'identical'); assert.equal(same.verdict.layer2, 'pass'); assert.equal(same.pooled.score, 1);
  const longer = declaredArm(src, src, [b('g0', 450, 900), b('g1', 450, 400)], { origin: 433.333333 });
  const d = longer.diffs.find((x) => x.cue === 'duration' && x.birth.includes('g0'));
  assert.equal(d.layer1, 'different'); assert.ok(d.e > 1, `300 ms on 600 ms is above one DL (e ${d.e})`); assert.equal(longer.verdict.layer2, 'fail');
  const missing = declaredArm(src, src, [b('g0', 450, 600)], {});
  assert.deepEqual(missing.missing, ['::view-transition-group(g1)|g1']); assert.equal(missing.verdict.layer2, 'fail');
});

test('job catalogue: one time job per committed time specimen; every job names its lab group and rate', () => {
  const man = JSON.parse(fs.readFileSync(path.join(TIME_DIR, 'manifest.json'), 'utf8'));
  const tj = timeJobs();
  assert.equal(tj.length, man.specimens.length);
  for (const j of tj) { assert.ok(j.group, j.id); assert.equal(j.rate, 120, j.id); }
  assert.ok(tj.filter((j) => j.spring).length >= 30, 'spring specimens (M07, M07x, M08) are in the set');
  if (labRepo()) assert.ok(labJobs().length > tj.length, 'scroll jobs are listed when the lab is reachable');
});

test('MCP providers refuse instead of guessing: score needs the specimen, verify needs a lab specimen id', async () => {
  const ctx = { access: { readable: (p) => p, writable: (p) => p } };
  await assert.rejects(providers.score({ source: 'a', candidate: 'b' }, ctx), (e) => e.code === 'bad_arguments');
  await assert.rejects(providers.verify({ specimen: 'no-such', source: 'lab' }, ctx), (e) => e.code === 'bad_arguments');
});

test('one recorded lab job (time/m19-click): source x2 + specimen, same recorder; scored, identity band 0, verdict pass', { timeout: 180000 }, async (t) => {
  if (!labRepo()) return t.skip('Fixture Lab not reachable (set REVA_LAB_REPO)');
  const [job] = labJobs({ only: ['time/m19-click'] });
  const r = await verifyJob(job);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.scored, true); assert.equal(r.sourceParity.pass, true);
  assert.equal(r.pairs[0].floor.mean, 1); assert.equal(r.pairs[0].floor.sd, 0);
  assert.ok(Math.abs(r.pairs[0].lag.worstDeltaMs) < 1e-3, 'trigger mapping: specimen onset on the source onset');
  assert.equal(r.verdict, 'pass');
});
