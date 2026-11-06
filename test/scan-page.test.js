// Phase 2 (2 Nov): reva scan for one page. Unit tests: the ledger, admission, the frame index, the archive check, the freeze retry,
// and the scan's own refusals. The recording itself is proven on real sites (PLAN §7 acceptance), not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, promisedUnits } from '../src/scan/ledger.js';
import { admit, EXIT_ADMISSION, availableGb, estimateLine, lanesFor, roomNow, LANE_GB } from '../src/scan/admission.js';
import { frameRecorder, jpegSize } from '../src/scan/frames.js';
import { checkArchive, scanFreezeConfig, freezePage, CLASSES } from '../src/scan/capture.js';
import { scanPage, MOMENTS, turns } from '../src/scan/index.js';
import { formatScan, moveLine, runMovesCommand } from '../src/scan/cli.js';
import { closeLedger } from '../src/scan/finish.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-scan-test-'));

test('ledger: first line counts per status; a missing unit and a bare reason are caught', () => {
  const l = new Ledger({ version: 2 });
  l.add({ unit: 'page', id: 'https://a.test/', page: 'https://a.test/', status: 'captured', evidence: { x: 1 } });
  l.add({ unit: 'moment', id: 'load', page: 'https://a.test/', viewport: 'desktop', status: 'captured', evidence: { take: 't' } });
  l.add({ unit: 'moment', id: 'idle', page: 'https://a.test/', viewport: 'desktop', status: 'not-reached' }); // no reason: a problem
  assert.equal(l.firstLine(), '3 units: 2 captured, 1 not-reached');
  const c = l.check([{ unit: 'moment', page: 'https://a.test/', viewport: 'desktop', id: 'load' }, { unit: 'moment', page: 'https://a.test/', viewport: 'desktop', id: 'scroll-up' }]);
  assert.equal(c.ok, false);
  assert.equal(c.missing.length, 1);
  assert.match(c.problems[0], /not-reached without what stood in the way/);
  assert.throws(() => l.add({ unit: 'moment', id: 'x', status: 'maybe' }), /unknown status/);
  assert.throws(() => l.add({ unit: 'wat', id: 'x', status: 'captured' }), /unknown unit/);
});

test('ledger: add replaces the same unit, remove drops it, write and read round-trip, page text loses control characters', () => {
  const l = new Ledger({ version: 2 });
  l.add({ unit: 'gate', page: 'p', viewport: 'phone', id: 'start', status: 'failed', reason: 'a' });
  l.add({ unit: 'gate', page: 'p', viewport: 'phone', id: 'start', status: 'captured', evidence: { take: 't' } });
  assert.equal(l.rows.length, 1);
  assert.equal(l.get('gate', 'p', 'phone', 'start').status, 'captured');
  l.add({ unit: 'move', page: 'p', viewport: 'phone', id: 'div‮.evil\u0007', status: 'captured', evidence: { clip: 'c.mp4' } });
  assert.equal(l.rows[1].id, 'div.evil');
  const f = path.join(tmp(), 'coverage.json');
  l.write(f);
  const back = Ledger.read(f);
  assert.equal(back.rows.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).schema, 'reva.coverage/2');
  assert.equal(back.remove('gate', 'p', 'phone', 'start'), true);
  assert.equal(back.rows.length, 1);
  assert.equal(back.has('move', 'p', 'phone', 'div.evil'), true);
  assert.throws(() => back.add({ unit: 'moving-element', id: 'x', status: 'captured' }), /unknown unit/);
});

test('promisedUnits: every moment of every viewport, a gate per viewport, the later units once per page', () => {
  const u = promisedUnits({ pages: ['p'], viewports: ['desktop', 'phone'], moments: MOMENTS });
  assert.equal(u.filter((x) => x.unit === 'moment').length, 8);
  assert.equal(u.filter((x) => x.unit === 'gate').length, 2);
  assert.deepEqual(u.filter((x) => ['pattern', 'open-state', 'page-change', 'design'].includes(x.unit)).map((x) => x.unit).sort(), ['design', 'open-state', 'page-change', 'pattern']);
});

test('admission: low disk, memory and cores each stop the scan with the reason and how to go on', () => {
  const ok = admit({ dir: os.tmpdir(), env: { freeBytes: 50e9, ramGb: 16, cores: 8 } });
  assert.equal(ok.ok, true);
  const bad = admit({ dir: os.tmpdir(), env: { freeBytes: 1e9, ramGb: 4, cores: 1 } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /1 GB of disk/);
  assert.match(bad.reason, /4 GB of memory/);
  assert.match(bad.reason, /1 core/);
  assert.match(bad.resume, /run the same command again/);
  assert.equal(EXIT_ADMISSION, 3);
  assert.equal(admit({ dir: os.tmpdir(), env: { freeBytes: null, ramGb: 16, cores: 4 } }).ok, true); // unknown disk does not stop a scan
});

function fakeJpeg(w, h, tag) {
  // SOI, SOF0 (length 11) with the size, then a tag so two pictures can differ
  const b = Buffer.alloc(24);
  b.writeUInt16BE(0xffd8, 0); b.writeUInt16BE(0xffc0, 2); b.writeUInt16BE(11, 4); b[6] = 8; b.writeUInt16BE(h, 7); b.writeUInt16BE(w, 9); b[11] = 1;
  b.write(tag, 14); return b;
}

test('frames: an identical picture is stored once, every frame keeps its row key; at full width no clip, smaller a clip that follows scrollY', async () => {
  assert.deepEqual(jpegSize(fakeJpeg(960, 600, 'a')), { width: 960, height: 600 });
  assert.equal(jpegSize(Buffer.from('nope')), null);
  const dir = path.join(tmp(), 'f');
  const clips = [];
  const pics = ['a', 'a', 'b', 'b', 'b', 'c'];
  let i = 0;
  const S = {
    evRetry: async () => ({ k: i, T: i * 16.6667, sy: i * 100 }),
    cdp: { send: async (m, p) => { assert.equal(m, 'Page.captureScreenshot'); clips.push(p.clip); return { data: fakeJpeg(960, 600, pics[i]).toString('base64') }; } },
  };
  const fr = frameRecorder(S, { dir, width: 1440, height: 900 });
  for (; i < pics.length; i++) await fr.shot(i < 3 ? 'load' : 'scroll');
  const sum = fr.close();
  assert.equal(sum.frames, 6);
  assert.equal(sum.files, 3);
  assert.equal(sum.duplicates, 3);
  assert.deepEqual(sum.phases, [{ name: 'load', from: 0, to: 3 }, { name: 'scroll', from: 3, to: 6 }]);
  // 1440 wide is scale 1: no clip, since a clip from this second session clears the page's emulation and a phone fell to DPR 1 (b27fc50)
  assert.deepEqual(clips, Array(6).fill(undefined));
  const half = [], S2 = { evRetry: async () => ({ k: 1, T: 16.6667, sy: 300 }), cdp: { send: async (m, p) => { half.push(p.clip); return { data: fakeJpeg(720, 450, 'h').toString('base64') }; } } };
  const fr2 = frameRecorder(S2, { dir: path.join(tmp(), 'f2'), width: 1440, height: 900, targetWidth: 720 });
  await fr2.shot('scroll'); fr2.close();
  assert.equal(half[0].y, 300); // page coordinates: a scaled clip moves with the scroll
  assert.equal(half[0].scale, 0.5);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  assert.deepEqual(doc.rows.map((r) => r[3]), [0, 0, 1, 1, 1, 2]);
  assert.deepEqual(doc.rows.map((r) => r[0]), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')), ['00000.jpg', '00001.jpg', '00002.jpg']);
});

const report = (checksA, checksE, extra = {}) => ({
  finalReplay: { A: { pass: Object.values(checksA).every(Boolean), checks: checksA }, E: { pass: Object.values(checksE).every(Boolean), checks: checksE } },
  recording: { A: { docStatus: 200 }, E: { docStatus: 200 } }, ...extra,
});
const allOk = { noError: true, loadFired: true, docStatus200: true, finalUrlMatches: true, docNotBlank: true, matchesLive: true, noPageErrors: true };

test('archive check: a blank replay blocks its viewport, page errors are only noted', () => {
  const r = checkArchive('/none', report(allOk, { ...allOk, matchesLive: false, docNotBlank: false }));
  assert.equal(r.ok, false);
  assert.equal(r.classes.A.ok, true);
  assert.equal(r.classes.E.ok, false);
  assert.match(r.classes.E.reason, /docNotBlank, matchesLive|matchesLive/);
  const soft = checkArchive('/none', report({ ...allOk, noPageErrors: false }, allOk));
  assert.equal(soft.ok, true);
  assert.match(soft.classes.A.notes, /noPageErrors/);
  const http = checkArchive('/none', { ...report(allOk, allOk), recording: { A: { docStatus: 403 }, E: { docStatus: 200 } } });
  assert.match(http.classes.A.reason, /HTTP 403/);
  const noE = checkArchive('/none', { finalReplay: { A: { pass: true, checks: allOk } }, recording: { A: { docStatus: 200 } } });
  assert.match(noE.classes.E.reason, /no replay result/);
});

test('freeze config: both viewports, the consent reject, own-host gap 500 ms, a Crawl-delay raises the gaps', () => {
  const c = scanFreezeConfig('https://www.example.test/x', { consentClicks: ['text="Reject all"'] });
  assert.deepEqual(Object.keys(c.classes), ['A', 'E']);
  assert.equal(c.classes.A.viewport.width, 1440);
  assert.equal(c.classes.E.viewport.width, 390);
  assert.equal(c.extraGapMs, 500);
  assert.deepEqual(c.clicks, ['text="Reject all"']);
  assert.equal(c.id, 'scan-example.test');
  const d = scanFreezeConfig('https://example.test/', { crawlDelaySec: 30 });
  assert.equal(d.extraGapMs, 30000);
  assert.equal(d.pageGapMs, 30000);
  assert.equal(CLASSES.E.isMobile, true);
});

test('freezePage: a failed check freezes once more and keeps the better archive; a clean first attempt is not repeated', async () => {
  const work = tmp();
  const calls = [];
  const mk = (checksE) => async (cfg, { outDir }) => { calls.push(outDir); fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'x'), '1'); return { report: report(allOk, checksE) }; };
  const good = await freezePage('https://a.test/', { work, freezeImpl: mk(allOk) });
  assert.equal(calls.length, 1);
  assert.equal(good.check.ok, true);
  assert.equal(good.attempts, 1);
  calls.length = 0;
  const bad = await freezePage('https://a.test/', { work: tmp(), freezeImpl: mk({ ...allOk, docNotBlank: false }) });
  assert.equal(calls.length, 2);
  assert.equal(bad.check.ok, false);
  assert.equal(bad.attempts, 2);
  assert.ok(fs.existsSync(bad.dir));
  // a freeze that throws the first time and works the second
  let n = 0;
  const flaky = async (cfg, { outDir }) => { if (++n === 1) throw new Error('browser died'); fs.mkdirSync(outDir, { recursive: true }); return { report: report(allOk, allOk) }; };
  const again = await freezePage('https://a.test/', { work: tmp(), freezeImpl: flaky });
  assert.equal(again.check.ok, true);
  assert.equal(again.attempts, 2);
});

test('lanes: two viewports at once only with the cores and the memory for a second browser, and one when asked', () => {
  assert.equal(lanesFor({ cores: 8, availGb: 2 * LANE_GB }).lanes, 2);
  assert.equal(lanesFor({ cores: 8, availGb: null }).lanes, 2); // a platform that cannot say keeps the default: turns() and the floors still hold
  const short = lanesFor({ cores: 8, availGb: 2 * LANE_GB - 0.1 });
  assert.equal(short.lanes, 1); assert.match(short.why, /GB of memory is free/);
  assert.equal(lanesFor({ cores: 2, availGb: 32 }).lanes, 1);
  assert.equal(lanesFor({ cores: 15, availGb: 32, ask: 1 }).lanes, 1);
});

test('estimate: the line says the pages, a range of minutes and the disk, shorter with two lanes', () => {
  assert.match(estimateLine({ pages: 8, lanes: 1 }), /^8 pages to record: about 40 to 136 minutes/);
  assert.match(estimateLine({ pages: 1, lanes: 2 }), /^1 page to record: about 4 to 13 minutes/);
});

test('available memory: macOS counts what can be had, not only the free pages', () => {
  const text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:    100000.\nPages active:    999999.\nPages inactive:    200000.\nPages speculative:    50000.\nPages purgeable:    10000.\n';
  assert.equal(availableGb({ platform: 'darwin', run: () => text }), 5.9);
  assert.equal(availableGb({ platform: 'darwin', run: () => { throw new Error('no vm_stat'); } }), null);
  assert.equal(availableGb({ platform: 'linux', free: () => 4e9 }), 4);
});

test('turns: a second lane runs beside the first, waits when memory is short, and never holds the scan', async () => {
  const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
  let free = 10, peak = 0, now = 0;
  const t = turns({ lanes: 2, room: () => null, free: () => free });
  const job = async (g) => { peak = Math.max(peak, ++now); await g.p; now--; };
  const a = gate(), b = gate();
  const ra = t.run(() => job(a)), rb = t.run(() => job(b));
  await new Promise((r) => setImmediate(r));
  assert.equal(peak, 2);
  a.open(); b.open(); await Promise.all([ra, rb]);
  free = 1; peak = 0; // memory is short now: one at a time, in order, and both still finish
  const c = gate(), d = gate(), order = [];
  const rc = t.run(async () => { order.push('c'); await job(c); }), rd = t.run(async () => { order.push('d'); await job(d); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['c']);
  c.open(); await rc;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['c', 'd']);
  d.open(); await rd;
  assert.equal(peak, 1);
});

test('turns: the disk running out stops the lane that asks and the one that waits; a unit in hand ends first', async () => {
  let why = null, open;
  const t = turns({ lanes: 1, room: () => why, free: () => 32 });
  const held = t.run(() => new Promise((r) => { open = r; }));
  const waits = t.run(async () => 'ran');
  await new Promise((r) => setImmediate(r));
  why = 'only 1.0 GB of disk is left';
  await assert.rejects(t.run(async () => 'ran'), /only 1.0 GB/);
  open('done');
  assert.equal(await held, 'done');
  await assert.rejects(waits, /only 1.0 GB/);
});

test('room while running: under the running floor the reason is said; an unknown disk does not stop a scan', () => {
  assert.match(roomNow({ dir: os.tmpdir(), env: { freeBytes: 1e9 } }), /1\.0 GB of disk is left/);
  assert.equal(roomNow({ dir: os.tmpdir(), env: { freeBytes: 50e9 } }), null);
  assert.equal(roomNow({ dir: os.tmpdir(), env: { freeBytes: null } }), null);
});

test('scanPage: a machine below the floors stops with exit 3, a reason and a ledger row; nothing is opened', async () => {
  const out = path.join(tmp(), 'o');
  let gateCalled = false;
  const r = await scanPage('https://a.test/', { out, floors: { freeGb: 1e9 }, safetyGateImpl: async () => { gateCalled = true; return {}; } });
  assert.equal(r.exit, EXIT_ADMISSION);
  assert.equal(gateCalled, false);
  const rows = JSON.parse(fs.readFileSync(path.join(out, 'coverage.json'), 'utf8')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'not-reached');
  assert.match(rows[0].reason, /GB of disk/);
});

test('scanPage: a robots.txt refusal is a blocked page row and the browser never starts', async () => {
  const out = path.join(tmp(), 'o');
  const err = Object.assign(new Error('https://a.test/robots.txt disallows https://a.test/ for all robots'), { code: 'blocked_robots' });
  const r = await scanPage('https://a.test/', { out, safetyGateImpl: async () => { throw err; } });
  assert.equal(r.exit, 1);
  assert.equal(r.ledger.rows[0].status, 'blocked');
  assert.match(r.ledger.rows[0].reason, /disallows/);
  assert.match(formatScan(r), /^1 units: 1 blocked/);
  const wall = Object.assign(new Error('behind a bot wall'), { code: 'blocked_wall' });
  const w = await scanPage('https://a.test/', { out: path.join(tmp(), 'o2'), safetyGateImpl: async () => { throw wall; } });
  assert.equal(w.ledger.rows[0].status, 'blocked');
});

test('scanPage: a page that cannot be frozen ends as a failed page row with the error', async () => {
  const out = path.join(tmp(), 'o');
  const safety = { verdict: 'ok', http: 200, robots: { found: true }, consent: { cmp: null, clicks: [] } };
  const r = await scanPage('https://a.test/', { out, safetyGateImpl: async () => safety, onePage: true, engine: 'cft', freezeImpl: async () => { throw new Error('no browser'); } });
  assert.equal(r.exit, 1);
  assert.equal(r.ledger.rows[0].status, 'failed');
  assert.match(r.ledger.rows[0].reason, /could not be frozen: no browser/);
});

// A whole scan with no browser: the archive is sealed and every take is already on disk (a stopped scan that went on), so the
// ledger logic runs on the stored results.
function stoppedScan({ liveVisible = null, scrolled = {}, gateA = [], glA = null, escapes = null } = {}) {
  const root = tmp(); const out = path.join(root, 'out'); const arch = path.join(root, 'arch');
  fs.mkdirSync(arch, { recursive: true }); fs.mkdirSync(out, { recursive: true });
  const checks = allOk;
  fs.writeFileSync(path.join(arch, 'freeze-report.json'), JSON.stringify(report(checks, checks)));
  fs.writeFileSync(path.join(arch, 'target.json'), JSON.stringify({ id: 't', archive: arch, classes: { A: { viewport: { width: 1440, height: 900 } }, E: { viewport: { width: 390, height: 844 } } } }));
  if (liveVisible) fs.writeFileSync(path.join(arch, 'live.json'), JSON.stringify({ classes: { A: { visible: liveVisible }, E: { visible: liveVisible } } }));
  for (const vp of ['desktop', 'phone']) {
    const isA = vp === 'desktop', d = path.join(out, 'takes', vp, 'arrive'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'take.json'), JSON.stringify({ watch: [[1, 'animation'], [2, 'transition']], selectors: [[1, 'div.a'], [2, 'div.b']], series: {}, extra: { netGate: { detached: isA ? 2 : 0, idleHits: 0 } }, gl: isA ? glA : null, escapes: isA ? escapes : null }));
    const phases = [['load', 0, 100], ['idle', 100, 200], ['scroll-down', 200, 260], ['scroll-up', 260, 300], ...(isA ? [['pointer-sweep', 300, 340]] : [])].map(([name, from, to]) => ({ name, from, to, shots: Math.ceil((to - from) / 2) }));
    fs.writeFileSync(path.join(out, 'takes', vp, 'arrive.unit.json'), JSON.stringify({
      ok: true, take: 'arrive', rows: 340, moving: 2, valid: true, misses: 0, rate: 60, visible: 120, gate: isA ? gateA : [], gatePlan: { none: true }, inv: { interactive: 0, groups: [], links: [] },
      frames: { dir: 'x', frames: 340, files: 170, bytes: 1000, shots: 170, skipped: 170, phases },
      scrolled: { maxScroll: 5000, reached: 5000, capped: false, cap: 30000, backToTop: true, topAfterUp: 0, down: { sent: 50, stop: 'bottom' }, up: { sent: 50 }, ...scrolled },
      gl: isA ? glA : null,
    }));
  }
  return { out, arch };
}
const okSafety = async () => ({ verdict: 'ok', http: 200, robots: { found: true }, consent: { cmp: null, clicks: [] } });

test('scanPage: the disk running out during the recording stops with exit 3 and a reason; the takes stay for the next run', async () => {
  const { out, arch } = stoppedScan();
  fs.rmSync(path.join(out, 'takes', 'phone', 'arrive.unit.json'));
  const r = await scanPage('https://a.test/', { out, fromArchive: arch, safetyGateImpl: okSafety, onePage: true, interact: false, design: false, roomImpl: () => 'only 1.0 GB of disk is left' });
  assert.equal(r.exit, EXIT_ADMISSION);
  assert.match(r.scan.stopped, /1\.0 GB/);
  const row = JSON.parse(fs.readFileSync(path.join(out, 'coverage.json'), 'utf8')).rows.find((x) => x.unit === 'page');
  assert.equal(row.status, 'not-reached');
  assert.match(row.reason, /run the same command again/);
  assert.equal(fs.existsSync(path.join(out, 'takes', 'desktop', 'arrive.unit.json')), true);
});

test('scanPage on stored takes: every promised unit has a row, the archive given by the caller is kept', async () => {
  const { out, arch } = stoppedScan({ liveVisible: 100 });
  const r = await scanPage('https://a.test/', { out, fromArchive: arch, safetyGateImpl: okSafety, onePage: true, interact: false, design: false });
  assert.equal(r.check.ok, true, JSON.stringify(r.check).slice(0, 300));
  assert.equal(r.exit, 0);
  assert.match(r.ledger.firstLine(), /^\d+ units: \d+ captured, 4 not-reached, 1 limit$/); // pattern, open-state, page-change, design; detached requests
  for (const vp of ['desktop', 'phone']) for (const m of MOMENTS) assert.equal(r.ledger.get('moment', 'https://a.test/', vp, m).status, 'captured');
  const up = r.ledger.get('moment', 'https://a.test/', 'desktop', 'scroll-up');
  assert.equal(up.evidence.framesFrom, 260); assert.equal(up.evidence.take, 'takes/desktop/arrive'); assert.equal(up.evidence.phase, 'scroll-up');
  assert.deepEqual(up.pictures, { shots: 20, frames: 40, floor: 15 }); assert.equal(up.saving, 'shot-gate');
  assert.equal(r.ledger.get('moment', 'https://a.test/', 'desktop', 'pointer-sweep').status, 'captured');
  assert.equal(r.ledger.get('moment', 'https://a.test/', 'phone', 'pointer-sweep'), null, 'a phone has no pointer');
  assert.equal(r.ledger.get('request', 'https://a.test/', 'desktop', 'detached-requests').value, 2);
  assert.equal(r.scan.schema, 'reva.scan/1'); assert.deepEqual(r.scan.promised.context.savings.sort(), ['detached-requests', 'shot-gate']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'coverage.json'), 'utf8')).schema, 'reva.coverage/2');
  assert.equal(r.ledger.get('gate', 'https://a.test/', 'desktop', 'start').status, 'captured');
  assert.ok(fs.existsSync(arch), 'a caller-owned archive is never deleted');
  assert.ok(fs.existsSync(path.join(out, 'coverage.json')) && fs.existsSync(path.join(out, 'scan.json')));
});

test('scanPage: a capped scroll, a gate overlay and a WebGL context each leave their own row', async () => {
  const { out, arch } = stoppedScan({ scrolled: { maxScroll: 90000, reached: 30000, capped: true }, gateA: [{ tag: 'div', cover: 1, clickables: ['Enter'] }], glA: { contexts: [{}], programs: 3 } });
  const r = await scanPage('https://a.test/', { out, fromArchive: arch, safetyGateImpl: okSafety, onePage: true, interact: false, design: false });
  const P = 'https://a.test/';
  assert.match(r.ledger.get('moment', P, 'desktop', 'scroll-down').reason, /first 30000 of 90000 px/);
  assert.equal(r.ledger.get('moment', P, 'desktop', 'scroll-rest').status, 'not-reached');
  const g = r.ledger.get('gate', P, 'desktop', 'start');
  assert.equal(g.status, 'not-reached');
  assert.match(g.reason, /Enter/);
  assert.match(g.reason, /never clicks accept/);
  assert.equal(r.ledger.get('canvas', P, 'desktop', 'webgl-0').status, 'partial');
  assert.equal(r.check.ok, true);
});

test('scanPage: what no row can reach gets its own row, and the check holds the scan to it', async () => {
  const escapes = { 'media-element': { count: 1, first: 0, details: ['https://a.test/v.mp4'] }, 'offscreen-canvas': { count: 1, first: 0, details: ['1'] }, 'iframe-cross-origin': { count: 1, first: 0, details: ['https://b.test/'] } };
  const { out, arch } = stoppedScan({ escapes });
  const r = await scanPage('https://a.test/', { out, fromArchive: arch, safetyGateImpl: okSafety, onePage: true, interact: false, design: false });
  const P = 'https://a.test/';
  assert.equal(r.ledger.get('media', P, 'desktop', 'https://a.test/v.mp4').status, 'partial');
  assert.equal(r.ledger.get('worker', P, 'desktop', 'canvas-1').status, 'opaque');
  assert.equal(r.ledger.get('frame', P, 'desktop', 'https://b.test/').status, 'opaque');
  assert.equal(r.scan.promised.context.escapes.length, 3);
  assert.equal(r.check.ok, true);
  r.ledger.remove('media', P, 'desktop', 'https://a.test/v.mp4');
  assert.match(r.ledger.check([], r.scan.promised.context).problems[0], /a take reported it and the ledger has no row/);
});

test('scanPage: a replay with far fewer visible elements than the live page is a failed viewport, not a quiet recording of nothing', async () => {
  const { out, arch } = stoppedScan({ liveVisible: 900 }); // the stored takes saw 120 visible elements: under a quarter
  const r = await scanPage('https://a.test/', { out, fromArchive: arch, safetyGateImpl: okSafety, onePage: true, interact: false, design: false });
  const P = 'https://a.test/';
  assert.equal(r.ledger.get('viewport', P, 'desktop', 'desktop').status, 'failed');
  assert.match(r.ledger.get('viewport', P, 'desktop', 'desktop').reason, /120 visible elements, the live page had 900/);
  assert.equal(r.ledger.get('moment', P, 'desktop', 'load').status, 'failed');
  assert.equal(r.exit, 1);
  assert.equal(r.check.ok, true);
});

test('scanPage: between a quarter and a half of the live elements is kept, with the numbers in the viewport row', async () => {
  const { out, arch } = stoppedScan({ liveVisible: 300 }); // 120 of 300
  const r = await scanPage('https://a.test/', { out, fromArchive: arch, safetyGateImpl: okSafety, onePage: true, interact: false, design: false });
  const v = r.ledger.get('viewport', 'https://a.test/', 'desktop', 'desktop');
  assert.equal(v.status, 'captured');
  assert.match(v.reason, /120 visible elements after settling, the live page had 300/);
  assert.equal(r.exit, 0);
});

test('closeLedger: every move gets a row, the tally must add up, the exit is decided by the whole ledger', async () => {
  const { out, arch } = stoppedScan();
  await scanPage('https://a.test/', { out, fromArchive: arch, safetyGateImpl: okSafety, onePage: true, interact: false, design: false });
  const tally = { runs: 3, inMoves: 3, rideAlong: 0, setup: 0, between: 0, control: 0, clocked: 0, repeat: 0, belowNoise: 0, newDocument: 0 };
  const moves = [{ id: 'm-aaaa0000', kind: 'touch', name: 'x', n: 1, frame: { clip: 'clips/m-aaaa0000.mp4', fps: 60 } }, { id: 'm-bbbb0000', kind: 'scene', name: 'y', n: 1, frame: { clip: 'clips/m-bbbb0000.mp4', fps: 60 } }, { id: 'm-cccc0000', kind: 'touch', name: 'z', n: 1 }];
  const fit = { ledger: [{ viewport: 'desktop', fitted: 2, sampled: 1, split: 0, cut: 0 }] };
  const c = closeLedger(out, { moves, tally }, { fit, failed: [{ id: 'm-cccc0000', error: 'no picture at the poster row' }] });
  assert.equal(c.check.ok, true, JSON.stringify(c.check).slice(0, 300));
  assert.equal(c.exit, 0);
  assert.equal(c.ledger.get('move', null, null, 'm-bbbb0000').status, 'partial');
  assert.equal(c.ledger.get('move', null, null, 'm-cccc0000').reason, 'no picture at the poster row');
  assert.deepEqual(c.ledger.get('fit', null, 'desktop', 'summary').evidence, { fitted: 2, sampled: 1, split: 0, cut: 0 });
  const bad = closeLedger(out, { moves, tally: { ...tally, runs: 4 } }, { fit });
  assert.equal(bad.exit, 1);
  assert.match(bad.check.problems[0], /4 runs but the buckets add up to 3/);
});

test('reva scan moves: one short line per move, one move in full, a bad id refused', () => {
  const long = moveLine({ id: 'm-aaaa0000', kind: 'touch', name: 'x'.repeat(900), time: { ms: 600 }, curve: { name: 'power3.out' }, proof: { source: 'fitted' }, n: 3 });
  assert.ok(Buffer.byteLength(long) < 300);
  assert.match(long, /^m-aaaa0000 {2}touch {2}600 ms {2}power3\.out {2}fitted {2}×3 /);
  assert.equal(runMovesCommand({ _: ['scan', 'moves'] }), 2);
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'moves.json'), JSON.stringify({ moves: [] }));
  assert.equal(runMovesCommand({ _: ['scan', 'moves', dir], id: '../x' }), 2);
  assert.equal(runMovesCommand({ _: ['scan', 'moves', dir], id: 'm-aaaa0000' }), 1);
});
