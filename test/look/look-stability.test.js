// look stability re-take: pure parts (no browser). The session cache's scope and cleanup (src/look/cache.js) and the
// comparison of two runs' fit records (src/look/stability.js), on synthetic records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSessionCache, withSessionCache, openCaches, cacheWanted, retakePlan, CACHE_PREFIX, CACHE_HAR, RETAKE_BUDGET_MS } from '../../src/look/cache.js';
import { recordSummary, compareSummary, compareMotions, matchEntry } from '../../src/look/stability.js';

const CACHE_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'look', 'cache.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'look-stab-'));

// ---------- session cache ----------

test('cache: a fresh folder under the temp base, a zip HAR path, recordHar options, removed by dispose (twice is fine)', () => {
  const base = tmp();
  try {
    const c = createSessionCache({ base });
    assert.ok(path.basename(c.dir).startsWith(CACHE_PREFIX));
    assert.equal(path.dirname(c.dir), base);
    assert.equal(c.har, path.join(c.dir, CACHE_HAR));
    assert.deepEqual(c.recordHar, { path: c.har, mode: 'minimal', content: 'attach' });
    assert.equal(c.ready(), false);   // the HAR exists only once the take's browser has closed
    fs.writeFileSync(c.har, 'x'); assert.equal(c.ready(), true);
    assert.ok(openCaches().includes(c.dir));
    c.dispose(); c.dispose();
    assert.equal(fs.existsSync(c.dir), false);
    assert.ok(!openCaches().includes(c.dir));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('cache: never inside the output folder or the data root (refused, not used)', () => {
  const out = tmp();
  try {
    const inside = path.join(out, 'sub'); fs.mkdirSync(inside);
    assert.throws(() => createSessionCache({ base: inside, forbid: [out] }), /never kept beside the output/);
    assert.throws(() => createSessionCache({ base: out, forbid: [null, out] }), /never kept beside the output/);
    assert.deepEqual(fs.readdirSync(inside), []);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('cache: withSessionCache removes it after success and after an error; a cache that cannot be made is null', async () => {
  const base = tmp();
  try {
    let seen = null;
    const r = await withSessionCache(true, async (c) => { seen = c.dir; fs.writeFileSync(c.har, 'har'); return 7; }, { base });
    assert.equal(r, 7); assert.equal(fs.existsSync(seen), false);
    await assert.rejects(withSessionCache(true, async (c) => { seen = c.dir; fs.writeFileSync(c.har, 'har'); throw new Error('take failed'); }, { base }), /take failed/);
    assert.equal(fs.existsSync(seen), false);
    assert.equal(await withSessionCache(false, async (c) => c, { base }), null);
    assert.equal(await withSessionCache(true, async (c) => c, { base, forbid: [base] }), null);
    assert.deepEqual(fs.readdirSync(base), []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('cache: a process that exits without disposing still removes it (exit sweep)', () => {
  const base = tmp();
  try {
    const code = `import(${JSON.stringify(CACHE_JS)}).then((m) => { const c = m.createSessionCache({ base: ${JSON.stringify(base)} }); require('fs').writeFileSync(c.har, 'x'); console.log(c.dir); process.exit(0); });`;
    const dir = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' }).trim();
    assert.ok(dir.startsWith(base));
    assert.equal(fs.existsSync(dir), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('cache: only a URL look records one, and not when the re-take is off', () => {
  assert.equal(cacheWanted({ kind: 'url', url: 'https://example.com/', live: true }), true);
  assert.equal(cacheWanted({ kind: 'url', url: 'http://localhost:1/', live: false }), true);
  assert.equal(cacheWanted({ kind: 'archive' }), false);
  assert.equal(cacheWanted({ kind: 'url' }, { retake: false }), false);
  assert.equal(cacheWanted(null), false);
});

test('retake plan: off, nothing to compare, --after, no cache, over budget, near the deadline; else runs', () => {
  const ok = { action: 'load', motions: 3, estMs: 12000, leftMs: 200000 };
  assert.deepEqual(retakePlan(ok), { run: true });
  assert.deepEqual(retakePlan({ ...ok, srcKind: 'archive', cacheReady: false }), { run: true });
  assert.match(retakePlan({ ...ok, retake: false }).why, /--no-retake/);
  assert.match(retakePlan({ ...ok, motions: 0 }).why, /no fitted motion/);
  assert.match(retakePlan({ ...ok, action: 'click', after: '.card' }).why, /--after/);
  assert.match(retakePlan({ ...ok, cacheReady: false }).why, /not recorded/);
  assert.match(retakePlan({ ...ok, estMs: RETAKE_BUDGET_MS + 1 }).why, /more than 30 s/);
  assert.match(retakePlan({ ...ok, leftMs: 30000 }).why, /time limit/);
});

// ---------- comparison ----------

const tween = (o = {}) => ({ target: { el: o.el ?? 1, channel: o.ch || 'ren:ty' }, tier: 'fitted', class: 'tween',
  model: { family: `named:${o.ease || 'easeOutCubic'}`, ease: o.ease || 'easeOutCubic', params: { D: { value: o.D ?? 900 }, t0: { value: o.t0 ?? 1100 } } }, derived: { t0: o.t0 ?? 1100 } });
const spring = (o = {}) => ({ target: { el: 1, channel: 'ren:ty' }, tier: 'fitted', model: { family: 'spring', params: { omega: { value: o.w ?? 20 }, zeta: { value: o.z ?? 0.6 }, t0: { value: 1100 } } }, derived: { t0: 1100 } });

test('summary: duration, start relative to the action, a normalised ease curve, end values', () => {
  const s = recordSummary(tween(), { tRef: 1000, ends: { from: 40, to: 0 } });
  assert.equal(s.channel, 'ren:ty'); assert.equal(s.kind, 'tween');
  assert.equal(s.durationMs, 900); assert.equal(s.t0, 100);
  assert.equal(s.curve.length, 41); assert.equal(s.curve[0], 0); assert.equal(s.curve.at(-1), 1);
  assert.deepEqual([s.from, s.to], [40, 0]);
  const sp = recordSummary(spring(), { tRef: 1000 });
  assert.equal(sp.kind, 'spring'); assert.ok(sp.durationMs > 100, String(sp.durationMs)); assert.ok(sp.curve);
  const odd = recordSummary({ target: { el: 1, channel: 'ren:ty' }, tier: 'fitted', model: { family: 'scroll map piecewise', params: {} } });
  assert.equal(odd.durationMs, null); assert.equal(odd.curve, null);
});

test('compare: identical runs are stable; one frame of start jitter is within tolerance', () => {
  const a = recordSummary(tween(), { tRef: 1000, ends: { from: 40, to: 0 } });
  const b = recordSummary(tween({ t0: 1108 }), { tRef: 1000, ends: { from: 40, to: 0 } });
  const c = compareSummary(a, b, { dt: 1000 / 120 });
  assert.deepEqual(c.varies, []);
  assert.equal(c.deltas.t0Ms.delta, 8); assert.equal(c.deltas.ease, 0); assert.equal(c.deltas.durationMs.delta, 0);
});

test('compare: duration, start, ease, end values and law each break stability, with the deltas', () => {
  const ref = recordSummary(tween(), { tRef: 1000, ends: { from: 40, to: 0 } });
  const v = (rec, ends = { from: 40, to: 0 }) => compareSummary(ref, recordSummary(rec, { tRef: 1000, ends }), { dt: 1000 / 120 });
  const d = v(tween({ D: 960 }));
  assert.deepEqual(d.varies.map((x) => x.what), ['duration']); assert.equal(d.varies[0].text, 'duration 900 → 960 ms'); assert.equal(d.deltas.durationMs.delta, 60);
  assert.deepEqual(v(tween({ t0: 1180 })).varies.map((x) => x.what), ['start']);
  const e = v(tween({ ease: 'linear' }));
  assert.deepEqual(e.varies.map((x) => x.what), ['ease']); assert.ok(e.deltas.ease > 0.2, String(e.deltas.ease));
  assert.deepEqual(v(tween(), { from: 40, to: 12 }).varies.map((x) => x.what), ['to']);
  assert.deepEqual(v(tween(), { from: 40, to: 0.5 }).varies, []);   // under 1 px on a px channel: the same end
  assert.ok(compareSummary(ref, recordSummary(spring(), { tRef: 1000 })).varies.some((x) => x.what === 'law'));
});

test('compareMotions: per-motion verdict, a short line only when it varies, unknown when nothing was compared', () => {
  const S = (rec, ends = { from: 40, to: 0 }) => recordSummary(rec, { tRef: 1000, ends });
  const out = compareMotions([
    { rank: 1, desc: 'h1', selector: 'h1', first: [S(tween())], second: [S(tween())] },
    { rank: 2, desc: 'p', selector: '.p', first: [S(tween())], second: [S(tween({ D: 960 }))] },
    { rank: 3, desc: 'img', selector: null, first: [S(tween())], second: null },
    { rank: 4, desc: 'nav', selector: null, first: [S(tween())], second: [] },
    { rank: 5, desc: 'li', selector: null, first: [S(tween()), S(tween({ t0: 2500 }))], second: [S(tween())] },
  ]);
  assert.deepEqual(out.map((m) => m.verdict), ['stable', 'varies', 'varies', 'unknown', 'varies']);
  assert.equal(out[0].text, null);
  assert.equal(out[1].text, 'varies between two runs: duration 900 → 960 ms');
  assert.match(out[2].text, /did not move in the second run/);
  assert.equal(out[3].channels[0].why, 'not fitted in the second run');
  assert.match(out[4].text, /2 → 1 segment/);
  assert.equal(out[1].channels[0].deltas.durationMs.delta, 60);
});

test('matchEntry: selector, then lead selector, then descriptor nearest the first box (ids differ between runs)', () => {
  const entries = [{ lead: 7, selector: 'h1', desc: 'h1' }, { lead: 9, selector: null, leadSelector: '.c:nth-child(2)', desc: 'div.c' }, { lead: 11, desc: 'span', box: { x: 0, y: 0 } }, { lead: 12, desc: 'span', box: { x: 300, y: 40 } }];
  assert.equal(matchEntry({ selector: 'h1', desc: 'h1' }, entries).lead, 7);
  assert.equal(matchEntry({ selector: null, leadSelector: '.c:nth-child(2)', desc: 'x' }, entries).lead, 9);
  assert.equal(matchEntry({ desc: 'span', box: { x: 290, y: 44 } }, entries).lead, 12);
  assert.equal(matchEntry({ desc: 'none' }, entries), null);
});
