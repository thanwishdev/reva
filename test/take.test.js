// A11 unit tests for the take/evidence model: provenance on every env value, unknowns carry reason + probe,
// a defaulted (empty) field is rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEnvironment, validateTake, writeTake, loadTake } from '../src/record/take.js';

const raw = (over = {}) => ({
  scenario: 'unit', target: 'fixture', lane: 'hx', rate: 120, dt: 1000 / 120, started: '2026-10-14T00:00:00.000Z', wallMs: 1,
  cfg: { dateEpoch: 1, dateInteger: false, birthRule: 'next', yieldMode: 'macro', seed: 7, maxElements: 300 },
  browser: { engine: 'chs', product: 'HeadlessChrome/147', protocolVersion: '1.3', revision: '@x', toolkit: 't147', playwright: '1.60.0', executablePath: '/x', args: ['--a'] },
  env: { innerWidth: 800, innerHeight: 600, dpr: 1, reducedMotion: 'no-preference', ua: 'ua', readback: { opacity: { maxAbsErr: 0 } } },
  host: { platform: 'darwin', release: '1', node: '26', loadavg: [1, 1, 1], cpus: 8 },
  net: { misses: 0 }, c: {}, escapes: {}, data: { rows: [{ k: 1, T: 0 }, { k: 2, T: 1000 / 120 }], births: [], declared: [], mut: [], wheel: [] },
  inputLog: [], extra: {}, ...over,
});

test('every env value carries a provenance; unknowns are in the ledger with reason + probe', () => {
  const { env, unknowns } = buildEnvironment(raw());
  const t = { env, unknowns, series: {} };
  const v = validateTake(t);
  assert.deepEqual(v.problems, []);
  for (const [k, x] of Object.entries(env)) assert.ok(['declared', 'measured', 'unknown'].includes(x.provenance), k);
  assert.ok(unknowns.some(u => u.id === 'unk_build_id'));
  assert.ok(unknowns.some(u => u.id === 'unk_display_state'));
});

test('validator rejects a silently defaulted field and an unknown without a probe', () => {
  const { env, unknowns } = buildEnvironment(raw());
  env.dpr = { value: null, provenance: 'measured' };
  env.extra = { value: null, provenance: 'unknown', unknown: 'unk_x', reason: 'r' };
  const v = validateTake({ env, unknowns, series: {} });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some(p => p.includes('env.dpr')));
  assert.ok(v.problems.some(p => p.includes('env.extra')));
});

test('escapes become unknowns-ledger entries; rt frame gaps are flagged', () => {
  const r = raw({ lane: 'rt', escapes: { worker: { kind: 'worker', reason: 'own clock', count: 1 } }, rtDt: [8.3, 8.3, 8.4, 20, 8.3] });
  const { unknowns, flags, env } = buildEnvironment(r);
  assert.ok(unknowns.some(u => u.id === 'unk_escape_worker'));
  assert.ok(flags.some(f => f.id === 'rt_frame_gap'));
  assert.equal(env.refreshHz.provenance, 'measured');
});

test('writeTake stores content-addressed series and a valid summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-take-'));
  const out = writeTake(raw(), { root: dir });
  const { take, data } = loadTake(out, ['rows']);
  assert.equal(take.validation.ok, true, JSON.stringify(take.validation));
  assert.equal(data.rows.length, 2);
  assert.match(take.series.rows.digest, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(out, take.series.rows.file)));
});
