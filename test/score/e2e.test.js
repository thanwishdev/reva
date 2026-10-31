// Scorer end to end on the own fixture (browser, hx lane, repo launcher): same-schedule repeats score identical,
// a planted defect (all motion removed) is different beyond the band, a 60 Hz take is refused against a 120 Hz one.
// The full DONE WHEN gate (floor, ladder, twins, every defect) is `node test/score/gate.mjs` (about 3 min).
import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, recordTake } from './record.mjs';
import { scoreTakeSets } from '../../src/score/score.js';

const SPEC = { mechanisms: [{ id: 'alpha', arms: ['response'], pairs: ['#em|ren:tx'] }, { id: 'mask', arms: ['response'], pairs: ['#mk|ren:clipPath', '#fd|ren:opacity'] }] };
const steps = [850, 300];

test('scorer e2e: identical repeat, planted defect, cross-rate refusal', { timeout: 180000 }, async () => {
  const srv = await serve();
  try {
    const a = await recordTake(srv.origin, { kind: 'respRec', steps });
    const b = await recordTake(srv.origin, { kind: 'respRec', steps });
    const ms = await recordTake(srv.origin, { kind: 'respRec', steps, query: { v: 'maskskip' } });
    const h60 = await recordTake(srv.origin, { kind: 'respRec', steps, rate: 60 });
    const same = scoreTakeSets({ src: { response: a }, reb: { response: b } }, SPEC);
    for (const m of same.mechanisms) { assert.equal(m.pooled.score, 1, m.id); assert.equal(m.verdict.layer1, 'identical', m.id); }
    const defect = scoreTakeSets({ src: { response: a }, reb: { response: ms } }, SPEC);
    const mask = defect.mechanisms.find(m => m.id === 'mask');
    assert.equal(mask.verdict.layer1, 'different'); assert.ok(mask.pooled.score < 0.5, `mask S ${mask.pooled.score}`);
    assert.equal(defect.mechanisms.find(m => m.id === 'alpha').verdict.layer1, 'identical');
    const cross = scoreTakeSets({ src: { response: a }, reb: { response: h60 } }, SPEC);
    assert.ok(cross.refused.length === 1 && cross.refused[0].reasons.some(r => r.field === 'dtMs'));
    assert.ok(cross.mechanisms.every(m => !m.pooled));
  } finally { await srv.close(); }
});
