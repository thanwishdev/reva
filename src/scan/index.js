// reva scan <url>: capture a site (DESIGN 3.2): preflight, the site map, a temporary sealed archive of one page per template in
// both viewports, then per page and viewport one arrive session (load, gate, idle, scroll down and up, pointer sweep, inventory),
// each pattern, each open state; one page change per template pair; completion of what the recordings missed; the ledger.
// The archive is deleted at the end. Every unit is kept as it finishes, so a stopped scan goes on where it stopped.
// finishScan (finish.js) then turns the takes into moves, fits, clips, the take video and the card.
import fs from 'node:fs';
import path from 'node:path';
import { assertOutsideRepo, ensureOutDir } from '../util/paths.js';
import { safetyGate } from '../safety/gate.js';
import { defaultEngine, GL_ARGS } from '../browser/engines.js';
import { Ledger, promisedUnits, exitFor } from './ledger.js';
import { addRows, canvasRow, frameRow, freezeLossRows, mediaRow, workerRow } from './rows.js';
import { writeLottie } from './lottie.js';
import { admit, EXIT_ADMISSION, availableGb, estimateLine, lanesFor, roomNow, LANE_GB } from './admission.js';
import { freezePage, crawlDelayOf, hostId, targetOf } from './capture.js';
import { recordArrive, recordExperience, VIEWPORTS } from './moments.js';
import { designPass } from './design.js';
import { mapSite, pagesToRecord, describeMap, urlKey, PER_SHAPE_UP_TO } from './map.js';
import { patternsOf } from './inventory.js';
import { planTests, judgePatterns, recordPatterns, readReactions, touchRows, PageLeft } from './patterns.js';
import { gateRowOf } from './gate.js';
import { recordOpens, EXPERIENCE } from './opens.js';
import { readThrough, liveFetcher } from './readthrough.js';
import { planChanges, recordChange } from './changes.js';
import { completeUnits } from './complete.js';
import { sitePolicy } from './polite.js';
import { SHOTS } from './moves/contract.js';
import { stripControls } from '../report/untrusted.js';
import { CONSENT_POLICY } from '../safety/banner.js';
import os from 'node:os';

const PKG_VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return null; } })();

export const SCAN_SCHEMA = 'reva.scan/1';
export const MOMENTS = ['load', 'idle', 'scroll-down', 'scroll-up'];
/** Recorded page changes per viewport beyond the home page's own. */
export const MAX_CHANGES = 24;
/** The one take a page and viewport arrive in; every moment is a phase of it. */
export const ARRIVE_TAKE = 'arrive';

/** Visible elements of the live page at freeze time for a class (archive/live.json), or null when the archive has none. */
function liveVisibleOf(archiveDir, cls) {
  try { const v = JSON.parse(fs.readFileSync(path.join(archiveDir, 'live.json'), 'utf8')).classes?.[cls]?.visible; return Number.isFinite(v) ? v : null; } catch { return null; }
}
/** Every unit keeps its result as JSON next to its take, so a stopped scan does not record it twice. */
const unitFile = (dir, vp, name) => path.join(dir, 'takes', vp, `${name}.unit.json`);
/** Run a unit once: a finished one is read back, a failed one becomes {ok:false, error} (the rows say so). */
async function guarded(key, file, run, log) {
  try { if (file && !run.again) { const r = JSON.parse(fs.readFileSync(file, 'utf8')); if (r && r.ok) { log(`${key}: already recorded, kept`); return r; } } } catch { /* not recorded yet */ }
  try {
    const r = await run();
    if (file && r.ok) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(r)); }
    return r;
  } catch (e) {
    const error = String(e.message).split('\n')[0].slice(0, 300);
    log(`${key} FAILED: ${error}`);
    return { ok: false, error };
  }
}
/** The patterns take with what each member did read back from it. */
async function patternTake(o) {
  let tests = o.tests; const lost = [];
  for (let i = 0; ;) {
    const at = { test: null };
    try {
      const r = await recordPatterns({ ...o, tests, at });
      readReactions(r.dir, r.tests);
      for (const t of r.tests) delete t.ids;
      r.tests.push(...lost);
      return r;
    } catch (e) {
      // a press took the page away: its pattern keeps its hover and focus, and is pressed in no other take (the click test says where it goes)
      if (e instanceof PageLeft && e.test) {
        o.log?.(`${o.viewport} ${o.name || 'patterns'}: pressing "${String(e.test.text || e.test.id).slice(0, 40)}" leaves for ${e.left}; made again without that press`);
        tests = tests.map((t) => (t.pattern === e.test.pattern ? { ...t, leaves: e.left } : t));
        continue;
      }
      // the page died or hung on one member: that test says so, the take is made again without it
      if (!at.test || i++ >= 3) throw e;
      const why = String(e.message).split('\n')[0].slice(0, 200);
      o.log?.(`${o.viewport} ${o.name || 'patterns'}: lost on "${String(at.test.text || at.test.id).slice(0, 40)}": ${why}`);
      lost.push({ ...at.test, error: why });
      tests = tests.filter((t) => t.id !== at.test.id);
    }
  }
}
async function opensUnit(o) {
  const { tests, takes } = await recordOpens(o);
  return { ok: true, tests, takes: takes.map(({ tests: _, dir, ...t }) => t), missList: [...new Set(takes.flatMap((t) => t.missList || []))], names: takes.map((t) => t.take) };
}
/** Every one of these ends before the caller goes on (a failed unit must not leave others recording behind the return); the first failure is thrown. */
async function allOf(list) {
  const ends = await Promise.allSettled(list);
  const bad = ends.find((x) => x.status === 'rejected');
  if (bad) throw bad.reason;
  return ends.map((x) => x.value);
}
/** A machine that ran out of room during the scan: what is finished stays, the same command goes on from there. */
class ScanStopped extends Error {}
/**
 * The lanes' turn to record. Memory is read at every turn: when a second browser no longer fits, a lane waits for the other's
 * unit to end, so a tight machine slows down instead of dropping data. `room` ends the scan when the disk runs out.
 */
export function turns({ lanes, room, free = availableGb }) {
  let running = 0, stop = null; const waiting = [];
  const fits = () => running < lanes && (running === 0 || (free() ?? Infinity) >= LANE_GB);
  const wake = () => { while (waiting.length && fits()) { running++; waiting.shift()(); } };
  return {
    get stop() { return stop; },
    async run(fn) {
      if (!stop) { const why = room(); if (why) stop = new ScanStopped(why); }
      if (stop) throw stop;
      if (fits()) running++; else await new Promise((r) => waiting.push(r));
      try { if (stop) throw stop; return await fn(); } finally { running--; wake(); }
    },
  };
}
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/** Rows for the units later phases fill, so no unit of the plan is silently missing (PLAN §3). */
const LATER = {
  pattern: 'interactive patterns (hover, focus, press, click) are recorded in a later phase of reva scan',
  'open-state': 'open states (menu, modal, tab, accordion) are recorded in a later phase of reva scan',
  'page-change': 'transitions between pages are recorded in a later phase of reva scan',
  design: 'the design pass (fonts, colours, spacing, breakpoints) did not run for this page',
};

function gateRow(ledger, page, viewport, gate, takeDir) {
  if (gate === null) return ledger.add({ unit: 'gate', page, viewport, id: 'start', status: 'failed', reason: 'the overlay probe could not run in the page' });
  if (!gate.length) return ledger.add({ unit: 'gate', page, viewport, id: 'start', status: 'captured', reason: 'no full-screen overlay after the page settled', evidence: { take: takeDir } });
  const g = gate[0];
  return ledger.add({
    unit: 'gate', page, viewport, id: 'start', status: 'not-reached',
    reason: `a full-screen ${g.tag} covers ${Math.round(g.cover * 100)} % of the viewport after load${g.clickables.length ? ` (it offers: ${g.clickables.filter(Boolean).join(' | ')})` : ''}; every frame of this scan shows it. REVA does not click it yet and never clicks accept`,
    evidence: { take: takeDir, overlay: g },
  });
}

/** What every take of a page and viewport reported: what no row can reach, the canvases that drew, and the network gate's counts. */
export function takeFacts(root, vp) {
  const dir = path.join(root, 'takes', vp), out = { media: new Map(), frames: new Map(), workers: new Map(), gl: null, detached: 0, idleHits: 0, consent: new Map(), unlocked: new Map() };
  let names = []; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    let t; try { t = JSON.parse(fs.readFileSync(path.join(dir, n, 'take.json'), 'utf8')); } catch { continue; }
    const net = t.extra?.netGate; out.detached += net?.detached || 0; out.idleHits += net?.idleHits || 0;
    // a consent banner the take hid (src/safety/banner.js): one entry per layer, with the takes it was hidden in and any reject pressed
    for (const h of t.extra?.consent?.hidden || []) { const k = `${h.sel}|${h.text}`, e = out.consent.get(k) || out.consent.set(k, { ...h, takes: [], rejected: null }).get(k); e.takes.push(n); }
    for (const r of t.extra?.consent?.rejected || []) for (const e of out.consent.values()) if (e.sel === r.sel && !e.rejected) e.rejected = r.label;
    for (const u of t.extra?.consent?.unlocked || []) { const k = `${u.what}|${u.kinds.join(' ')}`, e = out.unlocked.get(k) || out.unlocked.set(k, { ...u, takes: [] }).get(k); e.takes.push(n); }
    if (t.gl?.contexts?.length && !out.gl) out.gl = { take: n, gl: t.gl };
    const details = (k) => { const e = t.escapes?.[k]; return e ? (e.details?.length ? e.details : [`${k}-${e.first ?? 0}`]) : []; };
    for (const u of details('media-element')) if (!out.media.has(u)) out.media.set(u, n);
    for (const u of details('iframe-cross-origin')) if (!out.frames.has(u)) out.frames.set(u, { crossOrigin: true, take: n });
    for (const u of details('iframe-same-origin')) if (!out.frames.has(u)) out.frames.set(u, { crossOrigin: false, take: n });
    for (const u of details('offscreen-canvas')) if (!out.workers.has(u)) out.workers.set(u, n);
  }
  return out;
}

/** One row per media element, frame, worker canvas and WebGL context a page's takes reported, and what the check must then find. */
function reachRows(ledger, facts, { page, viewport, frames }) {
  const escapes = [], canvases = [];
  const put = (row) => { const r = ledger.add(row); escapes.push({ unit: r.unit, page, viewport, id: r.id }); };
  for (const id of facts.media.keys()) put(mediaRow({ id, page, viewport, frames }));
  for (const [id, f] of facts.frames) put(frameRow({ id, page, viewport, crossOrigin: f.crossOrigin, evidence: { take: f.take, frames } }));
  for (const id of facts.workers.keys()) put(workerRow({ id: `canvas-${id}`, page, viewport }));
  for (const [i, c] of (facts.gl?.gl.contexts || []).entries()) {
    const id = `webgl-${i}`;
    ledger.add(canvasRow({ id, page, viewport, context: 'webgl', evidence: { take: facts.gl.take, programs: facts.gl.gl.programs ?? null, kind: c?.kind ?? null, frames } }));
    canvases.push({ page, viewport, id });
  }
  return { escapes, canvases };
}

/** What the live visit's rules did, as rows (src/scan/polite.js): the stop, what robots.txt kept out, hosts that asked for
 *  less, navigations REVA refused. At most 200 robots rows; the rest is one row with the count. */
export function liveRows(ledger, policy) {
  const s = policy?.stopped;
  if (!policy) return;
  if (s) ledger.add({ unit: 'request', id: 'stop', status: 'blocked', reason: `${s.why} at ${s.url}; REVA sent nothing more to the site. What was captured before is kept; the same command run later goes on from there`, evidence: { url: s.url, status: s.status ?? null, retryAfterMs: s.retryAfterMs ?? null, at: s.at } });
  const rb = [...policy.robotsBlocked.values()];
  for (const b of rb.slice(0, 200)) ledger.add({ unit: 'request', id: b.url, status: 'blocked', reason: b.agent ? `robots.txt disallows it for ${b.agent === '*' ? 'all robots' : b.agent}: the page asked for it during the live visit and REVA did not fetch it` : `${b.rule}: not fetched` });
  if (rb.length > 200) ledger.add({ unit: 'request', id: 'robots-more', status: 'blocked', reason: `${rb.length - 200} more requests that robots.txt disallows were not fetched` });
  for (const [host, why] of policy.hostsBlocked) ledger.add({ unit: 'request', id: `https://${host}/`, status: 'blocked', reason: `${why}; REVA sent nothing more to this host` });
  for (const b of policy.refused.values()) ledger.add({ unit: 'request', id: b.url, status: 'blocked', reason: b.agent === 'scope' ? 'the page tried to go to another site; the live visit stays on the site, so REVA did not follow' : `a navigation that robots.txt disallows for ${b.agent === '*' ? 'all robots' : b.agent}; REVA did not follow` });
}

/** A page's template: its cluster when the map opened it or its shape did, else its path shape. */
function templateOf(p, map) { return p.cluster != null && !smallSite(map) ? p.cluster : p.shape; }
const smallSite = (map) => !map || (map.counts?.shapes ?? Infinity) <= PER_SHAPE_UP_TO;

/**
 * @param {string} url
 * @param {object} [o]
 * @param {boolean} [o.onePage]       this page only: no site map
 * @param {boolean} [o.interact]      false: moments only, no survey, patterns, open states or page changes
 * @param {number} [o.patternMembers] members tested per pattern (default 2; the second is the check on the fold)
 * @param {object} [o.map]            a site map already made (test seam, and for --from-archive)
 * @param {string} [o.out]            scan folder (outside the repo); default <data root>/out/scan/<host>-<stamp>
 * @param {string} [o.engine]         cft | chs (default: the installed one)
 * @param {string} [o.fromArchive]    developer option: record on this sealed archive instead of freezing (it is never deleted)
 * @param {boolean} [o.keepArchive]   keep the temporary archive after the scan
 * @param {object} [o.floors] / [o.safetyGateImpl] / [o.roomImpl]  test seams: admission floors, the safety gate, the disk check while running
 * @param {number} [o.lanes]         1: one viewport at a time (default: both at once when the machine has room)
 * @param {boolean} [o.frames]        pictures (default true)
 * @param {string[]} [o.viewports]    default both
 * @param {object} [o.policy]        the live visit's rules (default: sitePolicy(url), src/scan/polite.js); tests pass shorter gaps
 * @param {(m:string)=>void} [o.log]
 */
export async function scanPage(url, o = {}) {
  const log = o.log || (() => {});
  const t0 = Date.now();
  const viewports = o.viewports || Object.keys(VIEWPORTS);
  const engine = o.engine || defaultEngine();
  const out = path.resolve(o.out || ensureOutDir('scan', `${hostId(url)}-${stamp()}`));
  assertOutsideRepo(out);
  fs.mkdirSync(out, { recursive: true });
  const ledger = new Ledger({ version: 2 });
  // every request of the live visit goes through this one object: pacing per host, robots.txt, the stop rules, the guard
  const policy = o.policy || sitePolicy(url, { log, ...(o.siteFetchImpl ? { fetchImpl: o.siteFetchImpl } : {}) });
  const scan = { schema: SCAN_SCHEMA, url, host: hostId(url), engine, startedAt: new Date(t0).toISOString(), out, viewports, moments: MOMENTS, steps: {}, takes: {}, exit: 0,
    reva: PKG_VERSION, node: process.versions.node, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length };
  const done = () => { scan.live = policy.summary(); scan.wallMs = Date.now() - t0; fs.writeFileSync(path.join(out, 'scan.json'), JSON.stringify(scan, null, 1)); ledger.write(path.join(out, 'coverage.json')); };
  const home = url;
  const page = url;

  // 1 admission, then preflight (robots, walls, consent): REVA stops on a block, as look does
  const adm = admit({ dir: out, ...(o.floors ? { floors: o.floors } : {}) });
  scan.admission = { ...adm.measured, availGb: availableGb() };
  if (!adm.ok) {
    ledger.add({ unit: 'page', id: page, page, status: 'not-reached', reason: `${adm.reason}. ${adm.resume}` });
    scan.exit = EXIT_ADMISSION; scan.stopped = adm.reason; done();
    return { ledger, scan, out, exit: EXIT_ADMISSION, check: { ok: true, missing: [], problems: [] } };
  }
  let safety;
  try { safety = await (o.safetyGateImpl || safetyGate)(url, { who: 'cli', log, fetchImpl: policy.pacedFetch }); }
  catch (e) {
    const status = e.code === 'blocked_robots' || e.code === 'blocked_wall' ? 'blocked' : 'failed';
    ledger.add({ unit: 'page', id: page, page, status, reason: e.message });
    scan.exit = 1; scan.stopped = e.message; done();
    return { ledger, scan, out, exit: 1, error: e, check: { ok: true, missing: [], problems: [] } };
  }
  policy.seed(safety.robotsTexts);
  /** The site asked REVA to stop before anything was recorded: the row says why, the scan ends (exit 1). */
  const stoppedEarly = (where) => {
    liveRows(ledger, policy);
    ledger.add({ unit: 'page', id: page, page, status: 'not-reached', reason: `the site asked REVA to stop during ${where} (${policy.stopped.why}); nothing was recorded` });
    scan.exit = 1; scan.stopped = policy.stopped.why; done();
    return { ledger, scan, out, exit: 1, check: { ok: true, missing: [], problems: [] } };
  };
  scan.steps.preflight = { verdict: safety.verdict, http: safety.http, consent: safety.consent.cmp || (safety.consent.clicks.length ? 'text' : null), robotsFound: safety.robots.found };

  // 2 map: every URL listed, templates; one page per template is recorded
  const work = path.join(out, '.work');
  fs.mkdirSync(work, { recursive: true });
  let map = null;
  const pages = [{ url: home, id: 'home', dir: out, why: null, template: 'home' }];
  if (!o.onePage) {
    const mapFile = path.join(out, 'map.json');
    try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')); log('continuing a stopped scan: the site map is kept'); } catch { /* first run */ }
    if (!map) {
      map = o.map || await (o.mapImpl || mapSite)(url, { onProgress: log, fetchImpl: policy.fetch, gapMs: 0, halted: () => !!policy.stopped });
      if (policy.stopped) return stoppedEarly('the site map'); // no map.json: a later run maps again
      fs.writeFileSync(mapFile, JSON.stringify(map));
    }
    for (const l of describeMap(map)) log(l);
    scan.steps.map = { counts: map.counts, requests: map.requests, kb: map.kb, unreadable: !!map.robots?.unreadable };
    const list = pagesToRecord(map);
    const tOf = (u) => { const p = map.pages.find((x) => x.url === urlKey(u)); return p ? templateOf(p, map) : null; };
    pages[0].template = tOf(url) ?? 'home';
    for (const [i, p] of list.slice(1).entries()) pages.push({ url: p.url, id: `p${i + 1}`, dir: path.join(out, 'pages', `p${i + 1}`), why: p.why, template: tOf(p.url) });
    for (const pg of pages) fs.mkdirSync(pg.dir, { recursive: true });
  }

  // 3-4 freeze and check (or a given archive)
  let archiveDir, checkRes, own = true;
  if (o.fromArchive) {
    archiveDir = path.resolve(o.fromArchive); own = false;
    const { checkArchive } = await import('./capture.js');
    checkRes = checkArchive(archiveDir);
    scan.steps.freeze = { fromArchive: true, check: checkRes };
  } else if (fs.existsSync(path.join(work, 'archive', 'freeze-report.json')) && fs.existsSync(path.join(work, 'archive', 'target.json'))) {
    // a scan that was stopped after its archive was sealed: go on with that archive, no second visit to the site
    archiveDir = path.join(work, 'archive');
    const { checkArchive } = await import('./capture.js');
    checkRes = checkArchive(archiveDir);
    scan.steps.freeze = { resumed: true, check: checkRes };
    log('continuing a stopped scan: the archive is already sealed, the site is not visited again');
  } else {
    const crawlDelaySec = await crawlDelayOf(url, safety);
    try {
      const fz = await freezePage(url, { work, engine, consentClicks: safety.consent.clicks, crawlDelaySec, log, freezeImpl: o.freezeImpl, pages: pages.slice(1).map((p) => p.url), policy });
      archiveDir = fz.dir; checkRes = fz.check;
      scan.steps.freeze = { wallMs: fz.wallMs, attempts: fz.attempts, check: fz.check, completeness: fz.report.completeness?.pct ?? null, renderMisses: fz.report.completeness?.renderMisses ?? null, rounds: fz.report.rounds?.length ?? null, crawlDelaySec, ...(policy.stopped ? { stopped: policy.stopped } : {}) };
    } catch (e) {
      liveRows(ledger, policy);
      ledger.add({ unit: 'page', id: page, page, status: 'failed', reason: `the page could not be frozen: ${String(e.message).split('\n')[0]}` });
      scan.exit = 1; scan.stopped = String(e.message).split('\n')[0]; done();
      fs.rmSync(work, { recursive: true, force: true });
      return { ledger, scan, out, exit: 1, error: e, check: ledger.check(promisedUnits({ pages: [page], viewports: [], moments: [] })) };
    }
  }
  // pages the live visit did not record: a login or region wall, or not reached before the site asked REVA to stop
  const dropped = new Set();
  for (const pg of pages.slice(1)) {
    const k = urlKey(pg.url), wall = policy.pageWalls.get(k);
    const why = wall ? ['blocked', `${wall}: REVA does not sign in or get around it, so this page was not recorded`]
      : policy.stopped && !policy.docs.has(k) ? ['not-reached', `the site asked REVA to stop (${policy.stopped.why}) before this page was visited`] : null;
    if (!why) continue;
    ledger.add({ unit: 'page', id: pg.url, page: pg.url, status: why[0], reason: why[1] });
    dropped.add(k); try { fs.rmdirSync(pg.dir); } catch { /* not empty or gone */ }
  }
  if (dropped.size) pages.splice(0, pages.length, ...pages.filter((pg) => pg.id === 'home' || !dropped.has(urlKey(pg.url))));
  const target = targetOf(archiveDir);
  const extrasFile = path.join(work, 'extras.json');
  try { target.harExtras = JSON.parse(fs.readFileSync(extrasFile, 'utf8')); } catch { /* none yet */ }
  const targetFor = (pg) => ({ ...target, startUrl: pg.url });
  const consentClicks = safety.consent.clicks;
  const common = (pg, vp) => ({ target: targetFor(pg), viewport: vp, outDir: pg.dir, consentClicks, engine, log, noFrames: o.frames === false });
  // an experience's files come from the site while its take waits (own files, robots.txt, the per-host queue, the stop rule); a scan on
  // a given archive adds nothing to it, and o.readThrough false keeps every take on the copy
  let expRead = null;
  const experienceMiss = () => {
    if (!own || o.readThrough === false) return null;
    if (!expRead) expRead = readThrough({ fetcher: o.experienceFetcher || liveFetcher(policy), home: url, allowed: async (u) => !(await policy.robotsBlock(u)) });
    return (q) => expRead.onMiss(q);
  };
  const liveChecks = viewports.map((vp) => ({ vp, cls: VIEWPORTS[vp].cls, cs: target.classes[VIEWPORTS[vp].cls]?.viewport, chk: checkRes.classes[VIEWPORTS[vp].cls] }));
  const usable = liveChecks.filter((v) => v.cs && v.chk?.ok);

  // 5-6 record: everything is a unit that can run again when completion adds what it missed. Each viewport is a lane of its own:
  // nothing a lane decides reads the other, so two can run at once and the recording is the same
  const units = []; // { key, run(), result }
  const { lanes, why: lanesWhy } = lanesFor({ cores: scan.admission.cores, availGb: scan.admission.availGb, ask: o.lanes ?? null });
  scan.lanes = usable.length > 1 ? lanes : 1;
  if (usable.length > 1) log(lanesWhy);
  log(estimateLine({ pages: pages.length, lanes: scan.lanes }));
  if (!GL_ARGS.length) log('no GPU path here: a page that draws with WebGL records many times slower in software (one such page took over 25 minutes on 4 cores)');
  const turn = turns({ lanes, room: o.roomImpl || (() => roomNow({ dir: out })) });
  const runUnit = async (key, file, run, apply, { keep = false } = {}) => {
    const u = { key, file, run, apply, result: null };
    units.push(u);
    u.result = keep || await turn.run(() => guarded(key, file, run, log));
    apply(u.result);
    return u;
  };
  const store = new Map(); // `${pg.id}/${vp}` -> { arrive, survey, patterns, opens }
  const escapes = [], canvases = [], savings = new Set();
  const interact = o.interact !== false;
  const laneOf = async ({ vp }) => {
    const rows = [];
    for (const pg of pages) {
      const slot = { arrive: null, survey: null, patterns: null, patterns2: null, opens: null };
      store.set(`${pg.id}/${vp}`, slot);
      log(`${pg.url} [${vp}]`);
      // one session: what the survey used to read (the gate, the inventory) comes back with the arrival
      await runUnit(`${pg.id}/${vp}/arrive`, unitFile(pg.dir, vp, ARRIVE_TAKE), () => recordArrive(common(pg, vp)), (r) => { slot.arrive = r; slot.survey = r; });
    }
    // patterns and open states, page by page: a pattern seen on an earlier page in this viewport is not tested again. Which
    // patterns a page tests is decided from the arrive takes alone, so every page's chain is queued at once: a lane whose own work
    // is done takes the other's next unit instead of standing idle (5 Nov: desktop ran alone 168-761 s at the end of every site)
    if (interact) {
      const seen = new Map(), chains = [];
      for (const pg of pages) {
        const slot = store.get(`${pg.id}/${vp}`);
        if (!slot.survey?.ok || !slot.survey.inv) continue;
        const all = patternsOf(slot.survey.inv);
        slot.dups = all.filter((p) => seen.has(p.sig));
        slot.fresh = all.filter((p) => !seen.has(p.sig));
        for (const p of slot.fresh) seen.set(p.sig, { page: pg.url, id: p.id });
        slot.dupOf = (p) => seen.get(p.sig);
        const gatePlan = slot.survey.gatePlan?.sel ? slot.survey.gatePlan : null;
        const modes = vp === 'desktop' ? ['focus', 'hover'] : [];
        const tests = planTests(slot.fresh, { members: o.patternMembers || 2, modes });
        chains.push((async () => {
          if (tests.length) {
            await runUnit(`${pg.id}/${vp}/patterns`, unitFile(pg.dir, vp, 'patterns'), () => patternTake({ ...common(pg, vp), gatePlan, tests }), (r) => { slot.patterns = r; });
            // members that differ: two more, so the split says who goes with whom
            const split = slot.patterns.ok ? judgePatterns(slot.fresh, slot.patterns.tests).filter((j) => j.split) : [];
            const more = planTests(slot.fresh.filter((p) => split.some((j) => j.pattern === p.id)), { members: 4, modes }).filter((t) => t.member >= (o.patternMembers || 2));
            if (more.length) await runUnit(`${pg.id}/${vp}/patterns-2`, unitFile(pg.dir, vp, 'patterns-2'), () => patternTake({ ...common(pg, vp), gatePlan, tests: more, name: 'patterns-2' }), (r) => { slot.patterns2 = r; });
          }
          await runUnit(`${pg.id}/${vp}/opens`, unitFile(pg.dir, vp, 'opens'), () => opensUnit({ ...common(pg, vp), gatePlan, patterns: slot.fresh, members: o.patternMembers || 2, reached: new Set((slot.patterns?.tests || []).filter((t) => t.signature != null).map((t) => t.pattern)) }), (r) => { slot.opens = r; });
          // a click that started a WebGL experience loading: that state is a page of its own, waited for until its canvas draws
          const exps = (slot.opens?.tests || []).filter((t) => t.experience && !t.navigated).slice(0, EXPERIENCE.maxTakes);
          slot.experiences = [];
          for (const [n, t] of exps.entries()) {
            const name = `arrive-exp-${n}`;
            await runUnit(`${pg.id}/${vp}/${name}`, unitFile(pg.dir, vp, name), () => recordExperience({ ...common(pg, vp), gatePlan, name, press: { sel: t.sel, text: t.text }, wait: EXPERIENCE, onMiss: experienceMiss() }), (r) => { slot.experiences.push({ test: t.id, take: name, ...(r?.experience || {}), ok: !!r?.ok }); });
          }
        })());
      }
      await allOf(chains);
    }
    // one page change per template pair; a site whose changes are plain loads needs its home's pairs only
    if (interact && pages.length > 1) {
      const clusterOf = new Map((map?.pages || []).map((p) => [p.url, templateOf(p, map)]));
      const list = pages.map((pg) => ({ url: pg.url, id: pg.id, cluster: pg.template, links: store.get(`${pg.id}/${vp}`)?.survey?.inv?.links || [] }));
      const pairs = planChanges(list, clusterOf);
      const home = pairs.filter((x) => x.from === pages[0].url), rest = pairs.filter((x) => x.from !== pages[0].url);
      let i = 0;
      // names are given in plan order before anything runs, and rows keep that order, so the ledger reads as before
      const doPair = (c) => {
        const pg = pages.find((x) => x.url === c.from), name = `change-${i++}`;
        const row = { c, pg, vp, name, result: null };
        // a pattern that opened a menu on any page, as it sits on this page
        const menus = new Set(pages.flatMap((x) => store.get(`${x.id}/${vp}`)?.opens?.tests || []).filter((t) => t.opened && t.closedBy && (t.insideTests || []).length).map((t) => t.pattern));
        c.openers = patternsOf(store.get(`${pg.id}/${vp}`)?.survey?.inv || { groups: [] }).filter((p) => menus.has(p.id)).map((p) => p.members[0].sel);
        return runUnit(`${pg.id}/${vp}/${name}`, unitFile(pg.dir, vp, name), () => recordChange({ ...common(pg, vp), gatePlan: store.get(`${pg.id}/${vp}`)?.survey?.gatePlan?.sel ? store.get(`${pg.id}/${vp}`).survey.gatePlan : null, change: c, name }), (r) => { row.result = r; }).then(() => row);
      };
      const first = await allOf(home.map(doPair));
      rows.push(...first);
      const plain = first.length > 0 && first.every((r) => r.result.ok && r.result.change?.kind === 'new-document');
      let budget = o.maxChanges ?? MAX_CHANGES;
      rows.push(...await allOf(rest.map((c) => {
        if (plain) return { c, vp, dup: first[0] };
        if (budget-- <= 0) return { c, vp, over: true };
        return doPair(c);
      })));
    }
    return rows;
  };
  // a machine that runs out of room stops here: the sealed archive and every finished unit stay for the next run
  const stopped = (e) => {
    const reason = `${e.message}; free the disk and run the same command again: what is finished is kept, the site is not visited again`;
    log(`stopped: ${reason}`);
    for (const pg of pages) ledger.add({ unit: 'page', id: pg.url, page: pg.url, status: 'not-reached', reason });
    scan.exit = EXIT_ADMISSION; scan.stopped = e.message; done();
    return { ledger, scan, out, exit: EXIT_ADMISSION, check: { ok: true, missing: [], problems: [] } };
  };
  const changeRows = [];
  {
    // both lanes end before anything is decided: a failed lane must not leave the other recording behind the return
    const ends = lanes > 1 ? await Promise.allSettled(usable.map(laneOf)) : [];
    if (lanes === 1) for (const v of usable) { try { ends.push({ status: 'fulfilled', value: await laneOf(v) }); } catch (reason) { ends.push({ status: 'rejected', reason }); break; } }
    const bad = ends.find((x) => x.status === 'rejected' && !(x.reason instanceof ScanStopped));
    if (bad) throw bad.reason;
    if (turn.stop) return stopped(turn.stop);
    for (const e of ends) changeRows.push(...e.value);
  }

  // 7 completion: what a recording missed is fetched when it may be, and that unit is recorded again
  let requests;
  try { requests = await completeUnits({ units, home: url, fromArchive: !own, target, archiveDir, engine, consentClicks, log, extrasFile, reRecord: (u) => turn.run(() => guarded(u.key, u.file, u.run, log)), scan, fetchImpl: o.fetchMissingImpl, policy }); }
  catch (e) { if (e instanceof ScanStopped) return stopped(e); throw e; }
  // what an experience's take fetched from the site while it waited (its own files, paced): counts, and a stop if the site asked for one
  if (expRead) { const st = expRead.stats; scan.steps.experienceReads = { asked: st.asked, fetched: st.fetched.length, failed: st.failed.length, refused: st.refused.length, overBudget: st.overBudget, stopped: st.stopped }; }

  // the ledger is written from what the units finally hold
  for (const pg of pages) {
    const page = pg.url;
    ledger.add({ unit: 'page', id: page, page, status: 'captured', reason: pg.why || null, evidence: { archive: o.keepArchive ? 'archive/ (kept: --keep-archive)' : !own ? archiveDir : 'temporary, deleted at the end of the scan', viewports, dir: path.relative(out, pg.dir) || '.' } });
    for (const { vp, cls, cs, chk } of liveChecks) {
      if (!cs || !chk?.ok) {
        const why = !cs ? (policy.stopped ? `not recorded: the site asked REVA to stop (${policy.stopped.why}) before this viewport` : 'the archive has no such viewport') : chk.reason;
        ledger.add({ unit: 'viewport', page, viewport: vp, id: vp, status: 'failed', reason: why });
        ledger.add({ unit: 'gate', page, viewport: vp, id: 'start', status: 'not-reached', reason: `no recording: ${why}` });
        for (const m of MOMENTS) ledger.add({ unit: 'moment', page, viewport: vp, id: m, status: 'not-reached', reason: `no recording: ${why}` });
        continue;
      }
      const slot = store.get(`${pg.id}/${vp}`);
      ledger.add({ unit: 'viewport', page, viewport: vp, id: vp, status: 'captured', reason: chk.notes, evidence: { width: cs.width, height: cs.height, deviceScaleFactor: target.classes[cls].deviceScaleFactor ?? 1 } });
      let r = slot.arrive;
      const prefix = pg.id === 'home' ? '' : `pages/${pg.id}/`, key = pg.id === 'home' ? `${vp}/${ARRIVE_TAKE}` : `${pg.id}/${vp}/${ARRIVE_TAKE}`;
      const rel = `${prefix}takes/${vp}/${ARRIVE_TAKE}`, framesRel = `${prefix}frames/${vp}/${ARRIVE_TAKE}`;
      scan.takes[key] = r.ok ? { dir: rel, rows: r.rows, moving: r.moving, frames: r.frames && { pictures: r.frames.files, frames: r.frames.frames, bytes: r.frames.bytes, shots: r.frames.shots ?? null }, wallMs: r.wallMs, valid: r.valid, misses: r.misses, flags: r.flags } : { error: r.error };
      const facts = takeFacts(pg.dir, vp);
      if (facts.consent.size) {
        scan.consent ||= { policy: CONSENT_POLICY, hidden: [], unlocked: [] };
        for (const h of facts.consent.values()) scan.consent.hidden.push({ page, viewport: vp, layer: stripControls(h.sel), how: h.why, platform: h.cmp ?? null, text: stripControls(h.text || ''), rejected: h.rejected ? stripControls(h.rejected) : null, takes: h.takes.length, box: h.box });
        for (const u of facts.unlocked.values()) scan.consent.unlocked.push({ page, viewport: vp, what: stripControls(u.what), undid: u.kinds, by: u.by, takes: u.takes.length });
        log(`${vp}: a cookie-consent banner was hidden during capture (${[...facts.consent.values()].map((h) => h.cmp || h.sel).join(', ')})`);
      }
      if (r.ok) {
        const seen = reachRows(ledger, facts, { page, viewport: vp, frames: framesRel });
        escapes.push(...seen.escapes); canvases.push(...seen.canvases);
        if (!interact) gateRow(ledger, page, vp, r.gate, rel); // the overlay probe runs after load has settled
      }
      for (const [name, value, one, many] of [['detached-requests', facts.detached, 'request of a frame that left the page no longer held a frame back', 'requests of a frame that left the page no longer held a frame back'], ['idle-waits', facts.idleHits, 'page-idle wait ended at its 250 ms bound', 'page-idle waits ended at their 250 ms bound']]) {
        if (!value) continue;
        ledger.add({ unit: 'request', page, viewport: vp, id: name, status: 'limit', name, value, reason: `${value} ${value === 1 ? one : many}` }); savings.add(name);
      }
      if (interact) ledger.add(gateRowOf(slot.survey?.ok ? slot.survey.gatePlan : { failed: true, why: slot.survey?.error ? `the arrive take of the page failed: ${slot.survey.error}` : null }, { page, viewport: vp, take: rel }));
      // independent of the freeze's own check: the settled replay against the live page it was frozen from (live.json)
      const liveVisible = pg.id === 'home' ? liveVisibleOf(archiveDir, cls) : null;
      const seen = r.ok ? r.visible ?? null : null;
      /** A recording judged void takes back the rows of what it saw. */
      const voided = () => {
        for (const x of ledger.rows.filter((q) => ['canvas', 'media', 'frame', 'worker'].includes(q.unit) && q.page === page && q.viewport === vp)) ledger.remove(x.unit, x.page, x.viewport, x.id);
        for (const list of [escapes, canvases]) for (let i = list.length - 1; i >= 0; i--) if (list[i].page === page && list[i].viewport === vp) list.splice(i, 1);
      };
      if (liveVisible && seen != null && seen >= 0.25 * liveVisible && seen < 0.5 * liveVisible) {
        // between a quarter and a half: a gate or a lazy section can hide that many; kept, and said
        const v = ledger.get('viewport', page, vp, vp);
        ledger.add({ ...v, reason: [v.reason, `the replay shows ${seen} visible elements after settling, the live page had ${liveVisible} when frozen`].filter(Boolean).join('; ') });
      }
      if (liveVisible && seen != null && seen < 0.25 * liveVisible) {
        const why = `the replay shows ${seen} visible elements, the live page had ${liveVisible}: the recording is of a blank or broken page`;
        ledger.add({ unit: 'viewport', page, viewport: vp, id: vp, status: 'failed', reason: why, evidence: { width: cs.width, height: cs.height } });
        r = { ok: false, error: why };
        ledger.add({ unit: 'gate', page, viewport: vp, id: 'start', status: 'failed', reason: why });
        voided();
      }
      // an inner page the archive does not hold answers with nothing: that page was not recorded
      const doc = r.ok ? r.docStatus ?? null : null;
      if (pg.id !== 'home' && r.ok && doc != null && !(doc >= 200 && doc < 400)) {
        const why = `the archive answered ${doc || 'nothing'} for this page`;
        ledger.add({ unit: 'viewport', page, viewport: vp, id: vp, status: 'failed', reason: why });
        r = { ok: false, error: why };
        voided();
      }
      if (!ledger.has('gate', page, vp, 'start')) ledger.add({ unit: 'gate', page, viewport: vp, id: 'start', status: 'failed', reason: 'the arrive take failed, so the overlay probe never ran' });
      for (const m of [...MOMENTS, ...(r.frames?.phases?.some((p) => p.name === 'pointer-sweep') ? ['pointer-sweep'] : [])]) {
        if (!r.ok) { ledger.add({ unit: 'moment', page, viewport: vp, id: m, status: 'failed', reason: `the arrive take failed: ${r.error}` }); continue; }
        const ph = r.frames?.phases?.find((p) => p.name === m) || null;
        const notes = [];
        if (!r.valid) notes.push(`the take failed its own validation (${(r.problems || []).slice(0, 2).join('; ')})`);
        if (r.misses) notes.push(`${r.misses} request(s) missed the archive`);
        if (m === 'scroll-down' && r.scrolled?.capped) notes.push(`scrolled the first ${r.scrolled.reached} of ${r.scrolled.maxScroll} px (cap ${r.scrolled.cap})`);
        if (m === 'scroll-down' && r.scrolled && !r.scrolled.capped && r.scrolled.reached < r.scrolled.maxScroll - 4) notes.push(`stopped at ${r.scrolled.reached} of ${r.scrolled.maxScroll} px (${r.scrolled.down.stop || 'wheel ended'})`);
        if (m === 'scroll-up' && r.scrolled && !r.scrolled.backToTop) notes.push(`ended ${r.scrolled.topAfterUp} px from the top`);
        const frames = ph ? ph.to - ph.from : null, shots = ph?.shots ?? null, gated = shots != null && shots < frames;
        if (gated) savings.add('shot-gate');
        ledger.add({ unit: 'moment', page, viewport: vp, id: m, status: r.valid ? 'captured' : 'failed', reason: notes.length ? notes.join('; ') : null, evidence: { take: rel, phase: m, frames: r.frames ? framesRel : null, framesFrom: ph?.from ?? null, framesTo: ph?.to ?? null, rate: r.rate }, ...(ph ? { pictures: { shots, frames, floor: SHOTS.floor } } : {}), ...(gated ? { saving: 'shot-gate' } : {}) });
        if (m === 'scroll-down' && r.scrolled?.capped) ledger.add({ unit: 'moment', page, viewport: vp, id: 'scroll-rest', status: 'not-reached', reason: `the page is ${r.scrolled.maxScroll} px long; the scan scrolls ${r.scrolled.cap} px at most` });
      }
      if (interact) touchRows(ledger, { page, viewport: vp, prefix, slot });
      // a WebGL experience a click opened: its own take, waited for until it drew, or said to have timed out
      for (const e of slot.experiences || []) ledger.add({ unit: 'open-state', page, viewport: vp, id: `${e.test}/experience`, status: e.ok && e.found !== false ? 'captured' : 'failed',
        reason: !e.ok ? 'the experience take failed' : e.found === false ? 'its control was gone in a fresh load' : e.timedOut ? `a WebGL experience: waited ${Math.round((e.waitedMs || 0) / 1000)} s, the limit, and its canvas ${e.drawing ? 'draws' : 'had not drawn steadily'}; recorded as it stood` : `a WebGL experience: drew after ${Math.round((e.waitedMs || 0) / 1000)} s of loading, recorded as a page (idle, scroll, pointer)`,
        evidence: { take: `${prefix}takes/${vp}/${e.take}`, waitedMs: e.waitedMs ?? null, drawnFrames: e.drawnFrames ?? null, misses: e.misses ?? null } });
    }
    if (!viewports.some((vp) => ledger.get('viewport', page, vp, vp)?.status === 'captured')) ledger.add({ ...ledger.get('page', page, null, page), status: 'failed', reason: 'no screen of this page was recorded', evidence: null });
    for (const [u, why] of Object.entries(interact ? { design: LATER.design } : LATER)) ledger.add({ unit: u, page, id: u, status: 'not-reached', reason: why });
    if (interact && !ledger.has('page-change', page, null, 'all')) {
      const n = changeRows.filter((r) => r.c.from === page).length;
      ledger.add({ unit: 'page-change', page, id: 'all', status: 'captured', reason: n ? `${n} changes from this page, each in its own row` : pages.length > 1 ? 'this page links to no other template' : 'one template: no pair of templates to change between', evidence: { pairs: n } });
    }
  }
  if (map) for (const p of map.pages) {
    if (pages.some((x) => urlKey(x.url) === p.url) || dropped.has(p.url)) continue;
    const rep = pages.find((x) => x.template === templateOf(p, map));
    if (p.status === 'blocked') ledger.add({ unit: 'page', id: p.url, page: p.url, status: 'blocked', reason: p.blockedWhy ? `${p.blockedWhy}: listed, never recorded` : 'robots.txt disallows it: listed, never opened' });
    else if (rep) ledger.add({ unit: 'page', id: p.url, page: p.url, status: 'predicted-same', basis: `same template as ${rep.url}`, evidence: { shape: p.shape } });
    else ledger.add({ unit: 'page', id: p.url, page: p.url, status: 'not-reached', reason: 'listed from the sitemap or a link; it was not opened and no recorded page shares its template', evidence: { shape: p.shape } });
  }
  for (const r of changeRows) {
    const id = `to ${r.c.href}`, base = { unit: 'page-change', page: r.c.from, viewport: r.vp, id };
    if (r.over) { ledger.add({ ...base, status: 'not-reached', reason: `over the budget of ${o.maxChanges ?? MAX_CHANGES} recorded page changes for this viewport` }); continue; }
    if (r.dup) { ledger.add({ ...base, status: 'duplicate-of', proof: 'signature', duplicateOf: `${r.dup.c.from} ${`to ${r.dup.c.href}`}`, reason: 'every change from the home page is a plain new document: this one loads the same way' }); continue; }
    const u = r.result, prefix = r.pg.id === 'home' ? '' : `pages/${r.pg.id}/`;
    if (!u.ok) ledger.add({ ...base, status: 'failed', reason: u.error });
    else if (u.newWindow) ledger.add({ ...base, status: 'not-reached', reason: 'the link opens a new window: this page stays where it is, so there is no transition to record' });
    else if (u.gone) ledger.add({ ...base, status: 'not-reached', reason: 'the pointer cannot reach the link: something lies over it and no menu on this page reveals it' });
    else if (!u.change?.arrived) ledger.add({ ...base, status: 'failed', reason: `the click ended at ${u.change?.url ?? 'nothing'}`, evidence: { take: `${prefix}takes/${r.vp}/${r.name}` } });
    else ledger.add({ ...base, status: 'captured', reason: u.change.kind, evidence: { take: `${prefix}takes/${r.vp}/${r.name}`, frames: `${prefix}frames/${r.vp}/${r.name}`, kind: u.change.kind, templates: [r.c.fromTemplate, r.c.toTemplate] } });
  }
  for (const q of requests) ledger.add({ unit: 'request', id: q.url, page: null, status: q.status, reason: q.requests ? `${q.requests} requests: ${q.reason}` : q.reason, evidence: { units: q.units } });
  liveRows(ledger, policy);
  scan.pages = pages.map((p) => ({ id: p.id, url: p.url, dir: path.relative(out, p.dir) || '.', why: p.why || null }));

  // the Design and Libraries pages of the card: one look per recorded page, on the archive while it still exists
  if (o.design !== false) {
    for (const pg of pages) {
      if (!viewports.some((vp) => ledger.get('viewport', pg.url, vp, vp)?.status === 'captured')) continue;
      const r = await (o.designImpl || designPass)(targetFor(pg), pg.dir, { engine, log });
      ledger.add({ unit: 'design', page: pg.url, id: 'design', status: r.ok ? 'captured' : 'failed', reason: r.ok ? null : `the design pass failed: ${r.error}`, evidence: r.ok ? { look: path.join(path.relative(out, pg.dir), 'look', 'look.json') } : null });
    }
  }

  // 8 ledger, then the temporary archive goes (owner's Q1): what the freeze lost and the Lottie files are read while it exists
  addRows(ledger, freezeLossRows(archiveDir));
  try { scan.lottie = writeLottie(archiveDir, out); } catch (e) { log(`Lottie files were not read: ${String(e.message).split('\n')[0]}`); }
  const promised = { pages: pages.map((p) => p.url), viewports, moments: MOMENTS, ...(interact ? { laterUnits: ['design'] } : {}), touchUnits: interact ? usable.map((v) => v.vp) : [] };
  const context = { escapes, canvases, savings: [...savings] };
  const check = ledger.check(promisedUnits(promised), context);
  scan.ledger = { line: ledger.firstLine(), check: { ok: check.ok, missing: check.missing.length, problems: check.problems.length } };
  scan.promised = { ...promised, context }; // finishScan adds the moves to this and checks again
  scan.archive = o.fromArchive ? 'given by the caller, kept' : o.keepArchive ? 'kept (--keep-archive)' : 'deleted';
  let keptAt = null;
  if (own && o.keepArchive) {
    keptAt = path.join(out, 'archive');
    if (target.harExtras?.length) { const t = path.join(archiveDir, 'target.json'), j = JSON.parse(fs.readFileSync(t, 'utf8')); fs.chmodSync(t, 0o644); fs.writeFileSync(t, JSON.stringify({ ...j, harExtras: target.harExtras }, null, 1)); }
    fs.rmSync(keptAt, { recursive: true, force: true }); fs.renameSync(archiveDir, keptAt); }
  else if (own) fs.rmSync(archiveDir, { recursive: true, force: true });
  if (keptAt) scan.archiveDir = 'archive';
  fs.rmSync(work, { recursive: true, force: true });
  for (const pg of pages) for (const n of fs.readdirSync(pg.dir)) if (n.startsWith('.take-')) fs.rmSync(path.join(pg.dir, n), { recursive: true, force: true }); // a take cut short by a stop
  const homeCaptured = viewports.some((vp) => ledger.get('viewport', home, vp, vp)?.status === 'captured' && MOMENTS.some((m) => ledger.get('moment', home, vp, m)?.status === 'captured'));
  scan.homeCaptured = homeCaptured;
  scan.exit = exitFor(ledger, check, { homeCaptured });
  if (policy.stopped) { scan.exit = Math.max(scan.exit, 1); scan.stopped = policy.stopped.why; } // not everything was captured
  done();
  return { ledger, scan, out, exit: scan.exit, check };
}
