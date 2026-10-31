// Browser tests of the freeze command on our own fixture site (PLAN M4 "DONE WHEN - freeze").
// Run: node --test --test-concurrency=1 src/freeze/test/
// Each freeze records over the fixture server, then the server is stopped: every later replay has no server and no DNS.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, TELEMETRY_HOST } from '../../../fixtures/freeze-site/server.js';
import { fixtureConfig } from '../../../fixtures/freeze-site/config.js';
import { freeze } from '../freeze.js';
import { unsealArchive } from '../build.js';
import { checkArchive, checkManifest, checkKnownUrls } from '../check.js';
import { freezeSection } from '../report.js';
import { replayVerify, naiveReplayLoads } from '../verify.js';
import { normalizeConfig } from '../config.js';
import { parseHarZip, packHarZip } from '../sanitize.js';

const KNOWN = JSON.parse(fs.readFileSync(new URL('../../../fixtures/freeze-site/known-urls.json', import.meta.url), 'utf8'));
let tmp, srv, main;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-freeze-'));
  srv = await startServer();
  main = await freeze(fixtureConfig(srv.port), { outDir: path.join(tmp, 'main'), engine: 'chs' });
  await srv.close(); // from here on there is no server: replay can only be answered by the archive
});
after(() => {
  for (const d of fs.readdirSync(tmp)) { const p = path.join(tmp, d); if (fs.existsSync(path.join(p, 'ARCHIVE.SHA256SUMS'))) unsealArchive(p); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('freeze of the fixture: replay with DNS off logs 0 misses, load fires, checksums pass', () => {
  assert.equal(main.ok, true, JSON.stringify(main.report.finalReplay));
  assert.equal(main.sums.ok, true);
  assert.equal(main.report.converged, true);
  for (const [cls, v] of Object.entries(main.report.finalReplay)) {
    assert.equal(v.checks.loadFired, true, `${cls}: load fired`);
    assert.deepEqual(v.misses, [], `${cls}: 0 misses`);
    assert.equal(v.pass, true);
  }
  // the page state after replay proves the archive answered the POST and the late fetch, not just that nothing failed
  const p = main.report.finalReplay.A.probe;
  assert.equal(p.consent, 'consent: granted-v3');
  assert.equal(p.flag, 'flag: spring');
  assert.equal(p.tab, 'tab c loaded');
});

test('trap 1 (JS-built URLs): the plain recording missed them, URL completion supplied them, every known URL is archived', () => {
  const r1 = main.report.rounds[0];
  assert.ok(Object.values(r1.classes).every(c => c.misses > 0), 'after the plain recording the replay (which clicks tabs) hit misses');
  assert.ok(r1.newFromCode >= 3, 'code analysis found URLs the recording never requested');
  const k = checkKnownUrls(main.outDir, KNOWN, srv.origin);
  assert.deepEqual(k, { ok: true, checked: KNOWN.urls.length, missing: [], wrongStatus: [] });
  const m = JSON.parse(fs.readFileSync(path.join(main.outDir, 'manifest.json'), 'utf8'));
  const tabB = m.entries.find(e => e.url.endsWith('/chunks/tab-b.js'));
  assert.equal(tabB.origin, 'completed');
  assert.equal(tabB.provenance, 'inferred', 'derived from code, not observed (H6)');
  assert.equal(m.entries.find(e => e.url.endsWith('/home')).provenance, 'measured');
  const omega = m.entries.find(e => e.url.endsWith('/img/omega-960.svg'));
  assert.equal(omega.status, 404, 'a code-derived URL that does not exist is archived as the 404 it is');
});

test('unknowns ledger: templates that cannot be resolved are listed with a reason and were not fetched', () => {
  const u = main.report.completion.unknown;
  assert.ok(u.some(x => x.template === '/api/user/${state.userId}/avatar.png' && /runtime expression/.test(x.reason) && x.probe));
  assert.ok(u.some(x => x.template === '${TEL}/pixel.gif?v=1'));
  const m = JSON.parse(fs.readFileSync(path.join(main.outDir, 'manifest.json'), 'utf8'));
  assert.ok(!m.entries.some(e => /\/api\/user\//.test(e.url)), 'never guessed');
});

test('trap 2 (blocked telemetry): the server never saw it, the raw HAR holds status -1, the archive none, naive replay never fires load', async () => {
  assert.equal(srv.hits.filter(h => h.host === TELEMETRY_HOST).length, 0, 'telemetry blocked at record time');
  const raw = parseHarZip(fs.readFileSync(path.join(main.outDir, 'har-raw', 'A.har.zip')));
  assert.ok(raw.har.log.entries.some(e => e.response.status === -1 && /telemetry\.fixture\.test/.test(e.request.url)), 'raw HAR contains the status -1 entries');
  assert.equal(checkManifest(main.outDir).ok, true);
  assert.ok(Object.values(main.report.recording).every(r => r.sanitise.dropped['status-1(blocked)'] >= 3));
  const cfg = normalizeConfig(fixtureConfig(srv.port));
  const naive = await naiveReplayLoads(cfg, 'A', path.join(main.outDir, 'har-raw', 'A.har.zip'), { timeoutMs: 4000, engine: 'chs' });
  assert.equal(naive.loadFired, false, 'trap is real: a naive replay of the raw HAR stalls and load never fires');
  const clean = main.report.finalReplay.A;
  assert.equal(clean.checks.loadFired, true);
  assert.ok(clean.loadMs < 4000);
});

test('trap 3 (POST body): the body file is kept; a HAR whose post body was dropped turns the POST into a logged miss', async () => {
  const m = JSON.parse(fs.readFileSync(path.join(main.outDir, 'manifest.json'), 'utf8'));
  const post = m.entries.find(e => e.method === 'POST' && e.url.endsWith('/api/consent'));
  assert.ok(post.postSha256 && post.postBytes > 0 && post.status === 200 && post.path);
  const cfg = normalizeConfig(fixtureConfig(srv.port));
  const harA = parseHarZip(fs.readFileSync(path.join(main.outDir, 'har', 'A.har.zip')));
  const harAll = path.join(tmp, 'all-nopost.har.zip');
  for (const e of harA.har.log.entries) if (e.request.postData) delete e.request.postData._file; // what a sanitiser that forgets body files produces
  fs.writeFileSync(harAll, packHarZip(harA));
  const bad = await replayVerify(cfg, 'A', [harAll], { steps: [], engine: 'chs' });
  assert.ok(bad.misses.some(x => x.method === 'POST' && x.url.endsWith('/api/consent')), 'dropped body file -> logged miss');
  assert.equal(bad.probe.consent, 'consent: failed', 'and the page shows it');
});

test('trap 4 (silent misses): a missing entry the page swallows is invisible to the page but logged', async () => {
  const cfg = normalizeConfig(fixtureConfig(srv.port));
  const h = parseHarZip(fs.readFileSync(path.join(main.outDir, 'har', 'A.har.zip')));
  h.har.log.entries = h.har.log.entries.filter(e => !e.request.url.endsWith('/api/flags.json'));
  const p = path.join(tmp, 'noflags.har.zip');
  fs.writeFileSync(p, packHarZip(h));
  const v = await replayVerify(cfg, 'A', [p], { steps: [], engine: 'chs' });
  assert.equal(v.pageerrors.length, 0, 'the page raised no error');
  assert.equal(v.probe.flag, 'flag: none', 'and looks fine');
  assert.ok(v.misses.some(x => x.url.endsWith('/api/flags.json')), 'the catch-all logged it');
  assert.ok(v.missKinds.silent >= 1);
  assert.equal(v.pass, false, 'so the gate fails');
});

test('check command: shasum + manifest + known list + ledger + offline replay, server stopped', async () => {
  const r = await checkArchive(main.outDir, { known: KNOWN, origin: srv.origin, engine: 'chs' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.ledger.ok, true);
});

test('tampering with an archived body is caught by the checksum manifest', async () => {
  const copy = path.join(tmp, 'tampered');
  fs.cpSync(main.outDir, copy, { recursive: true });
  unsealArchive(copy);
  const m = JSON.parse(fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
  const e = m.entries.find(x => x.url.endsWith('/app.js'));
  fs.appendFileSync(path.join(copy, e.path), '//x');
  const { verifyArchive } = await import('../../archive.js');
  assert.equal(verifyArchive(copy).ok, false);
  assert.equal(checkManifest(copy).ok, false);
});

test('report section: provenance, inventory from the manifest, unknowns listed (merge point for M3)', () => {
  const s = freezeSection(main.outDir);
  assert.equal(s.id, 'freeze');
  assert.ok(s.data.inventory.byKind.svg.count >= 10 && s.data.inventory.byKind.script.bytes > 0);
  assert.match(s.markdown, /Unknowns \(never guessed\)/);
  assert.match(s.markdown, /unk_url_/);
  assert.ok(s.data.derivedFromCode.every(c => c.provenance === 'inferred' || c.provenance === 'declared'));
});

test('code analysis alone (no replay misses) supplies every known URL, from one viewport class', async () => {
  const srv2 = await startServer();
  try {
    const cfg = fixtureConfig(srv2.port, { classes: { A: { viewport: { width: 1000, height: 700 } } } });
    const r = await freeze(cfg, { outDir: path.join(tmp, 'codeonly'), engine: 'chs', missDriven: false });
    await srv2.close();
    assert.equal(r.ok, true);
    assert.equal(checkKnownUrls(r.outDir, KNOWN, srv2.origin).ok, true, 'class A saw only the 960 images; the 320 ones come from the template');
  } finally { await srv2.close().catch(() => {}); }
});

test('without completion and miss feedback the same freeze is NOT enough (the gate can fail)', async () => {
  const srv3 = await startServer();
  try {
    const cfg = fixtureConfig(srv3.port, { classes: { A: { viewport: { width: 1000, height: 700 } } } });
    const r = await freeze(cfg, { outDir: path.join(tmp, 'plain'), engine: 'chs', completion: false, missDriven: false, maxRounds: 1 });
    await srv3.close();
    assert.equal(r.ok, false);
    assert.ok(r.report.finalReplay.A.misses.length >= 2);
    assert.equal(checkKnownUrls(r.outDir, KNOWN, srv3.origin).ok, false);
  } finally { await srv3.close().catch(() => {}); }
});

test('miss feedback alone converges the replay but does not find URLs nothing requested (why code analysis exists)', async () => {
  const srv4 = await startServer();
  try {
    const cfg = fixtureConfig(srv4.port, { classes: { A: { viewport: { width: 1000, height: 700 } } } });
    const r = await freeze(cfg, { outDir: path.join(tmp, 'missonly'), engine: 'chs', completion: false, missDriven: true });
    await srv4.close();
    assert.equal(r.report.finalReplay.A.pass, true, 'replay clean after the miss round');
    const k = checkKnownUrls(r.outDir, KNOWN, srv4.origin);
    assert.equal(k.ok, false);
    assert.ok(k.missing.includes('/img/hero-night.svg') && k.missing.includes('/img/alpha-320.svg'));
  } finally { await srv4.close().catch(() => {}); }
});

test('the default engine (Chrome for Testing) freezes and replays the fixture too', async () => {
  const srv5 = await startServer();
  try {
    const cfg = fixtureConfig(srv5.port, { classes: { E: { viewport: { width: 390, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } } });
    const r = await freeze(cfg, { outDir: path.join(tmp, 'cft') }); // engine omitted on purpose
    await srv5.close();
    assert.equal(r.ok, true, JSON.stringify(r.report.finalReplay));
    assert.match(r.report.rounds.length ? JSON.stringify(Object.values(r.report.recording)[0]) : '', /"docStatus":200/);
    assert.equal(checkKnownUrls(r.outDir, KNOWN, srv5.origin).ok, true);
  } finally { await srv5.close().catch(() => {}); }
});
