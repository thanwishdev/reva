// S-SPEED #1 (27 Oct): which state sessions may run side by side, and the executor that runs them overlapped but commits
// every result in the sequential suite's order. Pure: no browser (sessions are fakes with delays).
import test from 'node:test';
import assert from 'node:assert/strict';
import { statesSessionPlan, sessionsMayOverlap, runSessionPlan, statesConcurrent, statesRunPlan, sessionBrowser } from '../../src/gate/states.js';

const runsOf = verify => { const p = statesRunPlan(verify); return [...p.data, ...p.verification.filter(x => x !== 'rb')]; };
const idx = (plan, run, kind, id = null) => plan.findIndex(s => s.run === run && s.kind === kind && s.id === id);

test('session plan, data mode: every CSS session and o1/cov of different states overlap; cov of a state follows its o1', () => {
  const plan = statesSessionPlan({ runs: runsOf('data'), jsIds: ['s1', 's2', 's3'] });
  assert.deepEqual(plan.map(s => s.name), ['o1-css', 'o1-s1', 'o1-s2', 'o1-s3', 'cov-css', 'cov-s1', 'cov-s2', 'cov-s3'], 'canonical = sequential order');
  const o1c = idx(plan, 'o1', 'css'), covc = idx(plan, 'cov', 'css');
  assert.ok(sessionsMayOverlap(plan, o1c, covc), 'cov CSS needs nothing from o1 CSS');
  for (const id of ['s1', 's2', 's3']) {
    assert.ok(sessionsMayOverlap(plan, o1c, idx(plan, 'o1', 'js', id)), `o1 css || o1 ${id}`);
    assert.ok(sessionsMayOverlap(plan, covc, idx(plan, 'o1', 'js', id)), `cov css || o1 ${id}`);
    assert.ok(!sessionsMayOverlap(plan, idx(plan, 'o1', 'js', id), idx(plan, 'cov', 'js', id)), `cov ${id} waits for o1 ${id} (a failed o1 drops the state)`);
    for (const id2 of ['s1', 's2', 's3'].filter(x => x !== id)) {
      assert.ok(sessionsMayOverlap(plan, idx(plan, 'o1', 'js', id), idx(plan, 'cov', 'js', id2)), `o1 ${id} || cov ${id2}`);
      assert.ok(sessionsMayOverlap(plan, idx(plan, 'o1', 'js', id), idx(plan, 'o1', 'js', id2)), `o1 ${id} || o1 ${id2}`);
    }
  }
});

test('session plan, full mode: o2/o3 CSS after o1 CSS (clips); each state runs o1 -> cov -> o2 -> o3 -> cap; the rest overlaps', () => {
  const plan = statesSessionPlan({ runs: runsOf('full'), jsIds: ['s1', 's2'] });
  assert.deepEqual(plan.map(s => s.name), ['o1-css', 'o1-s1', 'o1-s2', 'cov-css', 'cov-s1', 'cov-s2', 'o2-css', 'o2-s1', 'o2-s2', 'o3-css', 'o3-s1', 'o3-s2', 'cap-s1', 'cap-s2']);
  assert.ok(!plan.some(s => s.run === 'rb'), 'rb runs after every class (artifacts from the cap tables)');
  assert.ok(!plan.some(s => s.run === 'cap' && s.kind === 'css'), 'cap has JS sessions only');
  const o1c = idx(plan, 'o1', 'css');
  for (const r of ['o2', 'o3']) assert.ok(!sessionsMayOverlap(plan, o1c, idx(plan, r, 'css')), `${r} css after o1 css`);
  assert.ok(sessionsMayOverlap(plan, idx(plan, 'o2', 'css'), idx(plan, 'o3', 'css')), 'o2 css || o3 css');
  assert.ok(sessionsMayOverlap(plan, o1c, idx(plan, 'cov', 'css')), 'o1 css || cov css');
  const chain = ['o1', 'cov', 'o2', 'o3', 'cap'];
  for (const id of ['s1', 's2']) for (let a = 0; a < chain.length; a++) for (let b = a + 1; b < chain.length; b++)
    assert.ok(!sessionsMayOverlap(plan, idx(plan, chain[a], 'js', id), idx(plan, chain[b], 'js', id)), `${chain[a]} ${id} before ${chain[b]} ${id}`);
  assert.ok(sessionsMayOverlap(plan, idx(plan, 'o1', 'js', 's1'), idx(plan, 'o3', 'js', 's2')), 'different states never wait for each other');
  assert.ok(sessionsMayOverlap(plan, o1c, idx(plan, 'cap', 'js', 's2')), 'JS states never wait for a CSS session');
  for (const s of plan) for (const j of s.after) assert.ok(j < plan.indexOf(s), 'a session only waits for an earlier one (no cycle)');
});

const delay = ms => new Promise(r => setTimeout(r, ms));
function fakeSuite(plan, { fail = new Set(), ms = s => (s.kind === 'css' ? 30 : 10 + (s.id.charCodeAt(1) % 3) * 7) } = {}) {
  let live = 0, peak = 0;
  const started = [], committed = [], ends = [], metas = {}, dropped = [], failed = new Set();
  const runOne = async s => {
    if (s.kind === 'js' && failed.has(s.id)) return { skipped: true };
    started.push(s.name); live++; peak = Math.max(peak, live);
    try { await delay(ms(s)); if (fail.has(s.name)) { if (s.kind === 'js') failed.add(s.id); throw new Error(`boom ${s.name}`); } return { meta: { name: s.name }, ms: 1 }; }
    finally { live--; }
  };
  const commit = async (s, v) => { if (v.skipped) return; committed.push(s.name); if (v.error) dropped.push(s.id); else metas[s.name] = v.meta; };
  const endOfRun = async run => { ends.push(run); };
  return { runOne, commit, endOfRun, started, committed, ends, metas, dropped, peak: () => peak };
}

test('executor: sessions overlap, results are committed in the sequential order, runs end in order (empty cap too)', async () => {
  const runs = runsOf('full');
  const plan = statesSessionPlan({ runs, jsIds: ['s1', 's2', 's3'] });
  const f = fakeSuite(plan);
  await runSessionPlan(plan, runs, f);
  assert.ok(f.peak() > 2, `sessions ran side by side (peak ${f.peak()})`);
  assert.deepEqual(f.committed, plan.map(s => s.name), 'commit order = the sequential order');
  assert.deepEqual(Object.keys(f.metas), plan.map(s => s.name), 'metas key order = the sequential order');
  assert.deepEqual(f.ends, runs, 'every run ends once, in order');
  const g = fakeSuite([]); await runSessionPlan(statesSessionPlan({ runs, jsIds: [] }), runs, g);
  assert.deepEqual(g.ends, runs, 'a run with no session (cap, no JS state) still ends, as in the sequential loop');
});

test('executor: a failed JS session drops that state only (its later runs never start); the same files and skips as the sequential order', async () => {
  const runs = runsOf('full');
  const plan = statesSessionPlan({ runs, jsIds: ['s1', 's2', 's3'] });
  const f = fakeSuite(plan, { fail: new Set(['cov-s2']) });
  await runSessionPlan(plan, runs, f);
  // sequential reference: walk the canonical order, skip a state after its failure
  const seq = [], gone = new Set();
  for (const s of plan) { if (s.kind === 'js' && gone.has(s.id)) continue; seq.push(s.name); if (s.name === 'cov-s2') gone.add('s2'); }
  assert.deepEqual([...f.started].sort(), [...seq].sort(), 'same sessions started as the sequential suite');
  assert.deepEqual(f.committed, seq, 'same commit order');
  assert.deepEqual(f.dropped, ['s2']);
  assert.ok(!f.started.some(n => /^(o2|o3|cap)-s2$/.test(n)), 'nothing after the failure for s2');
});

test('executor: a failed CSS session is thrown once the commit order reaches it, after running sessions ended; nothing new starts', async () => {
  const runs = runsOf('data');
  const plan = statesSessionPlan({ runs, jsIds: ['s1', 's2'] });
  const f = fakeSuite(plan, { fail: new Set(['o1-css']), ms: s => (s.kind === 'css' ? 5 : 40) });
  await assert.rejects(runSessionPlan(plan, runs, f), /boom o1-css/);
  assert.deepEqual(f.committed, [], 'nothing committed past the failure');
  assert.equal(f.ends.length, 0);
});

test('statesConcurrent: on by default; off with REVA_STATES_PAR=1, a time budget or a rescore', () => {
  assert.equal(statesConcurrent({ env: {} }), true);
  assert.equal(statesConcurrent({ env: { REVA_STATES_PAR: '1' } }), false);
  assert.equal(statesConcurrent({ budgetMs: 60000, env: {} }), false);
  assert.equal(statesConcurrent({ rescore: true, env: {} }), false);
});

test('sessionBrowser: one session at a time per (run, cls) gets the pooled browser; a concurrent one launches its own (REVA_STATES_LANES=0: shares)', () => {
  const pools = { got: [], get(k) { this.got.push(k); return { key: k }; } };
  const ctx = { pools };
  const a = sessionBrowser(ctx, 'o1', 'A', {});
  assert.deepEqual(a.pool, { key: 'o1|A' });
  const b = sessionBrowser(ctx, 'o1', 'A', {});
  assert.equal(b.pool, null, 'a second live session of o1|A launches its own browser');
  const c = sessionBrowser(ctx, 'cov', 'A', {});
  assert.deepEqual(c.pool, { key: 'cov|A' }, 'other runs have their own pool');
  a.release(); a.release(); // idempotent
  const d = sessionBrowser(ctx, 'o1', 'A', {});
  assert.deepEqual(d.pool, { key: 'o1|A' }, 'free again: back to the pool');
  const e = sessionBrowser(ctx, 'o1', 'A', { REVA_STATES_LANES: '0' });
  assert.deepEqual(e.pool, { key: 'o1|A' }, 'lanes off: a context in the shared pool browser');
  assert.equal(sessionBrowser({ pools: null }, 'o1', 'A', {}).pool, null, 'no pools: launch (stateMutant)');
});

// F1 (27 Oct final review): the live browser count must never exceed the live sessions (= what the step lease + gate slots
// cover). A fake launcher counts open browsers; a pooled browser stays open until its run ends (endOfRun), a launched one
// closes with its session.
function fakeBrowsers() {
  let live = 0, peak = 0, launches = 0;
  const up = () => { live++; launches++; peak = Math.max(peak, live); };
  const pooled = new Map();
  const pools = {
    get(k) { if (!pooled.has(k)) pooled.set(k, { key: k, up: false, async open() { if (!this.up) { this.up = true; up(); } return { close: async () => {} }; } }); return pooled.get(k); },
    async closeMatching(prefix) { for (const [k, p] of [...pooled]) if (k.startsWith(prefix)) { pooled.delete(k); if (p.up) { p.up = false; live--; } } },
  };
  const launch = async () => { up(); return { close: async () => { live--; } }; };
  return { pools, launch, live: () => live, peak: () => peak, launches: () => launches };
}
async function runFake({ concurrent, lanes }) {
  const runs = runsOf('full');
  const plan = statesSessionPlan({ runs, jsIds: ['s1', 's2', 's3'] });
  const fb = fakeBrowsers();
  const ctx = { pools: fb.pools, concurrent };
  const env = lanes === undefined ? {} : { REVA_STATES_LANES: lanes };
  let sessions = 0, peakSessions = 0, over = 0;
  const runOne = async s => {
    const br = sessionBrowser(ctx, s.run, 'A', env);
    let h;
    try { h = br.pool ? await br.pool.open() : await fb.launch(); sessions++; peakSessions = Math.max(peakSessions, sessions); await delay(s.kind === 'css' ? 20 : 8); }
    finally { sessions--; if (h) await h.close(); br.release(); if (fb.live() > sessions) over++; } // a session just ended: every browser still open must belong to a live session
    return { meta: { name: s.name }, ms: 1 };
  };
  const sample = setInterval(() => { if (fb.live() > sessions) over++; }, 1); // browsers beyond the sessions open right now
  const f = fakeSuite(plan);
  const endOfRun = async run => { f.ends.push(run); await fb.pools.closeMatching(`${run}|A`); };
  if (concurrent) await runSessionPlan(plan, runs, { runOne, commit: f.commit, endOfRun });
  else { // the sequential suite (REVA_STATES_PAR=1): one session at a time, run by run
    for (const run of runs) { for (const s of plan.filter(x => x.run === run)) await f.commit(s, await runOne(s)); await endOfRun(run); }
  }
  clearInterval(sample);
  return { fb, peakSessions, over, committed: f.committed, plan };
}

test('F1: concurrent states sessions never leave an idle pooled browser: live browsers <= live sessions, and the commit order is unchanged', async () => {
  const r = await runFake({ concurrent: true });
  assert.ok(r.peakSessions > 2, `sessions overlapped (peak ${r.peakSessions})`);
  assert.ok(r.fb.peak() <= r.peakSessions, `browser peak ${r.fb.peak()} <= session peak ${r.peakSessions}`);
  assert.equal(r.over, 0, 'at no sample did a browser stay open without a session');
  assert.equal(r.fb.live(), 0, 'nothing left open');
  assert.deepEqual(r.committed, r.plan.map(s => s.name), 'same commit order as the sequential suite');
});

test('F1: the old path is intact: sequential (REVA_STATES_PAR=1) takes the pooled browser, one per (run, cls), closed at the end of its run', async () => {
  const seq = await runFake({ concurrent: false });
  assert.equal(seq.fb.launches(), 5, 'sequential: one pooled browser per run (o1, cov, o2, o3, cap)');
  assert.equal(seq.fb.live(), 0);
  const ctx = { pools: { get: k => ({ key: k }) }, concurrent: true };
  assert.deepEqual(sessionBrowser(ctx, 'o1', 'A', { REVA_STATES_LANES: '0' }).pool, { key: 'o1|A' }, 'LANES=0 keeps its explicit shared-pool opt-in');
  assert.equal(sessionBrowser(ctx, 'o1', 'A', {}).pool, null, 'concurrent: always a browser of its own');
});
