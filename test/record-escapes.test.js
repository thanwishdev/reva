// A10: escapes on our own fixtures are detected and logged "not steppable" with a reason in 100 % of runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSession } from '../src/record/session.js';
import { serveFixture } from './helpers.js';

const RUNS = Number(process.env.WR_ESCAPE_RUNS || 3);
const CASES = {
  'iframe-same': 'iframe-same-origin', 'iframe-cross': 'iframe-cross-origin', worker: 'worker',
  offscreen: 'offscreen-canvas', 'offscreen-ctor': 'offscreen-canvas', ric: 'request-idle-callback',
};

test(`A10 escapes detected and flagged in ${RUNS}/${RUNS} runs per case; control case has none`, async () => {
  const srv = await serveFixture('escapes');
  const other = await serveFixture('escapes');   // a second port = a second origin
  const tally = {};
  try {
    for (const [c, kind] of Object.entries({ ...CASES, none: null })) {
      for (let i = 0; i < RUNS; i++) {
        const s = await openSession({ lane: 'hx', rate: 120, url: `${srv.origin}/?case=${c}&other=${encodeURIComponent(other.origin)}`, viewport: { width: 600, height: 400 }, seed: 1 });
        let take;
        try {
          await s.goto(); await s.boot({ until: 'window.CASE_DONE === true', maxMs: 20000 });
          await s.hold(100);
          ({ take } = await s.finish({ scenario: 'escapes-' + c, write: false }));
        } finally { await s.close(); }
        const e = take.escapes;
        const t = tally[c] || (tally[c] = { runs: 0, detected: 0, kinds: new Set() });
        t.runs++; Object.keys(e).forEach(k => t.kinds.add(k));
        if (kind ? (e[kind] && e[kind].steppable === false && e[kind].reason && e[kind].count > 0) : Object.keys(e).length === 0) t.detected++;
      }
    }
  } finally { await srv.close(); await other.close(); }
  const out = Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, { runs: v.runs, ok: v.detected, kinds: [...v.kinds] }]));
  console.log('A10', JSON.stringify(out));
  for (const [c, v] of Object.entries(out)) assert.equal(v.ok, v.runs, `${c}: ${v.ok}/${v.runs}`);
});
