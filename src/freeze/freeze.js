// Freeze orchestrator (PLAN M4 "freeze a new target"; recipe ARCH W2G1-4, traps SYN §7.4).
//   record each viewport class (blocked telemetry, seeded Math.random, scroll sweep, declared clicks/extra URLs)
//   -> sanitise (status -1 out, body files kept, secrets redacted) -> merge a union HAR
//   -> URL completion from the CODE in the recording (templates the recording never triggered)
//   -> offline replay check with DNS disabled + miss logger (misses of GET URLs feed the next round)
//   -> repeat until a round adds nothing -> write the archive + checksum manifest -> seal -> final replay + shasum check
import fs from 'node:fs';
import path from 'node:path';
import { assertOutsideRepo } from '../util/paths.js';
import { verifyArchive } from '../archive.js';
import { normalizeConfig, assertFreezable } from './config.js';
import { recordClass } from './record.js';
import { parseHarZip, sanitizeHar, mergeHars, packHarZip } from './sanitize.js';
import { analyseCompletion } from './complete.js';
import { replayVerify } from './verify.js';
import { buildArchive, sealArchive, unsealArchive } from './build.js';
import { rankCandidates, completenessOf } from './policy.js';
import { robotsFilter, robotsFetcher, notFetchedText } from './robots-gate.js';
import { defaultEngine } from '../browser/engines.js';
import { BrowserPool } from '../browser/pool.js';
import { recordArgs } from './config.js';
import { OFFLINE_ARGS } from '../replay/target.js';

/**
 * S11 (26 Oct, shareBrowser): the classes of one round record (or are checked) one after the other in ONE browser, each in
 * a fresh context, instead of a browser launch per class. Contexts never share cookies, storage or the HTTP cache, so each
 * class still loads everything itself. Returns null (every class launches its own browser, the old path) when sharing is
 * off or a round has a single class.
 */
function roundPool(share, n, args, engine) { return share && n > 1 ? new BrowserPool({ args, engine }) : null; }
async function closePool(pool) { if (pool) await pool.close().catch(() => {}); }
/** S-SPEED #5: sealVersion's replay checks of the classes side by side (REVA_FREEZE_SEAL_PAR=0: one after the other in the
 *  round's shared browser, as before). Off for a single class. */
export const sealParallel = (n, env = process.env) => n > 1 && env.REVA_FREEZE_SEAL_PAR !== '0';
/** {cls: check(cls)} in class order, the checks one after the other or all at once (results land in class order either way). */
export async function checkClasses(clsList, check, { parallel = false } = {}) {
  const out = {};
  if (parallel) { const vs = await Promise.all(clsList.map(cls => check(cls))); clsList.forEach((cls, i) => { out[cls] = vs[i]; }); }
  else for (const cls of clsList) out[cls] = await check(cls);
  return out;
}

const CODE_RE = /javascript|ecmascript|json|css|html/i;

function codeFiles(union) {
  const out = [];
  for (const e of union.har.log.entries) {
    if (e.response.status !== 200 || e.request.method !== 'GET') continue;
    const ct = (e.response.headers.find(h => h.name.toLowerCase() === 'content-type') || {}).value || '';
    const f = e.response.content?._file;
    if (!CODE_RE.test(ct) || !f || !union.files.has(f)) continue;
    out.push({ url: e.request.url, contentType: ct, text: union.files.get(f).toString('utf8') });
  }
  return out;
}

/** Corpus caps (CORPUS-PLAN §6): a response body larger than cfg.mediaMaxBytes is emptied, then the largest bodies are
 *  emptied until the class's bodies fit cfg.archiveCapBytes. The entry stays (status, headers) so the replay serves it
 *  and nothing is refetched; every emptied URL goes to the ledger. No caps configured: unchanged. */
function capMedia(s, cfg, truncated) {
  if (!cfg.mediaMaxBytes && !cfg.archiveCapBytes) return;
  const ents = s.har.log.entries.filter(e => e.response.content?._file && s.files.has(e.response.content._file));
  const size = e => s.files.get(e.response.content._file).length;
  const cut = e => { const n = size(e); truncated.set(e.request.url, n); s.files.set(e.response.content._file, Buffer.alloc(0)); e.response.content.size = 0; e.response.content._truncated = n; };
  for (const e of ents) if (cfg.mediaMaxBytes && size(e) > cfg.mediaMaxBytes) cut(e);
  if (cfg.archiveCapBytes) {
    let total = 0; for (const b of s.files.values()) total += b.length;
    for (const e of [...ents].sort((a, b) => size(b) - size(a))) { if (total <= cfg.archiveCapBytes) break; const n = size(e); if (n) { cut(e); total -= n; } }
  }
}

/** The sanitised HARs of a round, written next to the work files so the replay check reads files, as a user of the archive would. */
function writeRoundHars(dir, classes, union) {
  fs.mkdirSync(dir, { recursive: true });
  const paths = { all: path.join(dir, 'all.har.zip') };
  fs.writeFileSync(paths.all, packHarZip(union));
  for (const [cls, h] of Object.entries(classes)) { paths[cls] = path.join(dir, `${cls}.har.zip`); fs.writeFileSync(paths[cls], packHarZip(h)); }
  return paths;
}

/** Replay-relevant part of the config as a target config for src/replay (loadTarget / bootCheck). */
export function targetConfig(cfg, archiveDir) {
  return {
    id: cfg.id, archive: path.resolve(archiveDir), startUrl: cfg.startUrl, classes: cfg.classes,
    blockRegex: cfg.block, seed: cfg.seed, locale: cfg.locale, timezone: cfg.timezone, settleMs: cfg.settleMs, probe: cfg.probe, expect: cfg.expect,
    harDir: 'har', harPattern: '{name}.har.zip', harUnion: 'all',
  };
}

/**
 * @param {object} rawCfg freeze config (see config.js)
 * @param {{outDir:string, engine?:string, maxRounds?:number, completion?:boolean, missDriven?:boolean, allowLive?:boolean, log?:Function,
 *   bounded?:{maxUrls?:number, budgetMs?:number, concurrency?:number}|null, onSealed?:Function}} o
 *   bounded: the corpus policy (seal early, one typed completion pass, never lose a sealed archive); see freezeBounded.
 *   shareBrowser: one browser per round, a context per class (roundPool); off by default (`reva freeze` unchanged).
 */
export async function freeze(rawCfg, { outDir, engine = defaultEngine(), maxRounds = 3, completion = true, missDriven = true, allowLive = false, log = () => {}, bounded = null, onSealed = null, shareBrowser = false } = {}) {
  const t0 = Date.now();
  const cfg = normalizeConfig(rawCfg);
  assertFreezable(cfg, { allowLive });
  outDir = path.resolve(outDir);
  assertOutsideRepo(outDir); // H2
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`output directory is not empty: ${outDir}`);
  const work = outDir + '.work';
  fs.rmSync(work, { recursive: true, force: true });
  for (const x of ['.next', '.prev']) fs.rmSync(outDir + x, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  if (bounded) {
    try { return await freezeBounded(cfg, { outDir, work, engine, completion, log, t0, bounded, onSealed, shareBrowser }); }
    finally { fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(outDir + '.next', { recursive: true, force: true }); }
  }
  try { return await freezeInner(cfg, { outDir, work, engine, maxRounds, completion, missDriven, log, t0, shareBrowser }); }
  finally { fs.rmSync(work, { recursive: true, force: true }); } // raw rounds are site-derived and only needed while freezing
}

async function freezeInner(cfg, { outDir, work, engine, maxRounds, completion, missDriven, log, t0, shareBrowser = false }) {
  const block = cfg.block ? new RegExp(cfg.block) : null;

  const extra = new Map(); // url -> {origin, provenance, ...}: what we ask the browser to fetch on top of the sweep
  for (const u of cfg.extraUrls) extra.set(u, { origin: 'declared', provenance: 'declared' });
  const attempted = new Set(), rounds = [];
  let naturalUrls = null, final = null, unknown = [], missUnknown = [];
  const truncated = new Map(); // url -> bytes: bodies left out by the media / archive caps (ledger kind media-truncated)

  for (let round = 1; round <= maxRounds; round++) {
    const rdir = path.join(work, `round${round}`);
    const recLogs = {}, classes = {}, raw = {};
    const recPool = roundPool(shareBrowser, Object.keys(cfg.classes).length, recordArgs(cfg), engine);
    try {
      for (const cls of Object.keys(cfg.classes)) {
        const harPath = path.join(rdir, 'raw', `${cls}.har.zip`);
        log(`round ${round}: recording class ${cls} (${extra.size} extra URLs)`);
        recLogs[cls] = await recordClass(cfg, cls, { harPath, extraUrls: [...extra.keys()], engine, pool: recPool });
        raw[cls] = fs.readFileSync(harPath);
        const s = sanitizeHar(parseHarZip(raw[cls]), { block });
        capMedia(s, cfg, truncated);
        classes[cls] = s;
        recLogs[cls].sanitise = s.report;
      }
    } finally { await closePool(recPool); }
    for (const u of extra.keys()) attempted.add(u);
    const union = mergeHars(Object.values(classes));
    if (!naturalUrls) naturalUrls = new Set(union.har.log.entries.map(e => e.request.url));
    const have = new Set([...union.har.log.entries.map(e => e.request.url), ...attempted]);

    let newFromCode = 0;
    if (completion) {
      const a = analyseCompletion({ files: codeFiles(union), documentOrigin: new URL(cfg.startUrl).origin, have, block, domains: cfg.domains });
      unknown = a.unknown;
      for (const c of a.candidates) { extra.set(c.url, { origin: 'completed', provenance: c.provenance, kind: c.kind, template: c.template, file: c.file, how: c.how }); newFromCode++; }
      log(`round ${round}: code analysis found ${a.candidates.length} new candidate URLs, ${a.unknown.length} unknown templates`);
    }

    const paths = writeRoundHars(path.join(rdir, 'san'), classes, union);
    const verifies = {};
    let newFromMiss = 0; missUnknown = [];
    const verPool = roundPool(shareBrowser, Object.keys(cfg.classes).length, OFFLINE_ARGS, engine);
    try { for (const cls of Object.keys(cfg.classes)) {
      const v = await replayVerify(cfg, cls, [paths.all, paths[cls]], { engine, pool: verPool });
      verifies[cls] = v;
      for (const m of v.misses || []) {
        if (m.method === 'GET' && missDriven && !extra.has(m.url) && !attempted.has(m.url)) { extra.set(m.url, { origin: 'miss-driven', provenance: 'measured' }); newFromMiss++; }
        else if (m.method !== 'GET') missUnknown.push({ id: `unk_miss_${missUnknown.length + 1}`, kind: 'non-GET miss', method: m.method, url: m.url, reason: 'a non-GET request cannot be fetched blindly (its body is unknown)', probe: 'perform the interaction that sends it during recording (config "clicks") and re-freeze' });
      }
      log(`round ${round}: class ${cls} replay ${v.pass ? 'PASS' : 'FAIL'} (${(v.misses || []).length} misses)`);
    } } finally { await closePool(verPool); }
    rounds.push({ round, extraUrls: extra.size, newFromCode, newFromMiss, classes: Object.fromEntries(Object.entries(verifies).map(([k, v]) => [k, { pass: v.pass, misses: (v.misses || []).length }])) });
    final = { classes, raw, union, recLogs, verifies };
    if (newFromCode === 0 && newFromMiss === 0) break;
    if (round === maxRounds) rounds[rounds.length - 1].notConverged = true;
  }

  // Provenance: what the plain recording saw is measured; what only the completion/miss rounds fetched carries how it was derived.
  const provenance = new Map();
  for (const [u, p] of extra) if (!naturalUrls.has(u) || p.origin === 'declared') provenance.set(u, p);

  const fetchResults = [];
  for (const l of Object.values(final.recLogs)) for (const x of l.extra) fetchResults.push({ url: x[0], result: x[1], bytes: x[2] });
  const meta = {
    createdAt: new Date().toISOString(), tool: 'reva-freeze/1', id: cfg.id, startUrl: cfg.startUrl, classes: Object.keys(cfg.classes),
    browser: Object.values(final.recLogs)[0]?.browser, blockRegex: cfg.block,
    note: 'PRIVATE. Site-derived material when frozen from a real site (H2). Never commit, publish or upload.',
  };
  buildArchive({ dir: outDir, union: final.union, classes: final.classes, raw: final.raw, provenance, meta });

  // Final check runs against the archive on disk, exactly as a later replay would.
  const finalVerify = {};
  const finPool = roundPool(shareBrowser, Object.keys(cfg.classes).length, OFFLINE_ARGS, engine);
  try {
    for (const cls of Object.keys(cfg.classes)) {
      const v = await replayVerify(cfg, cls, [path.join(outDir, 'har', 'all.har.zip'), path.join(outDir, 'har', `${cls}.har.zip`)], { engine, pool: finPool });
      finalVerify[cls] = v;
    }
  } finally { await closePool(finPool); }
  const report = {
    schema: 1, id: cfg.id, finishedAt: new Date().toISOString(), wallSeconds: Math.round((Date.now() - t0) / 100) / 10,
    converged: !rounds.at(-1).notConverged, rounds,
    recording: Object.fromEntries(Object.entries(final.recLogs).map(([k, l]) => [k, { docStatus: l.docStatus, finalUrl: l.finalUrl, ...(l.preloader ? { preloader: l.preloader } : {}), blockedRequests: l.blocked.length, trackersBlocked: (l.trackers || []).length, pageerrors: l.pageerrors.length, wheelSteps: l.wheelSteps, sanitise: l.sanitise, extraFetched: l.extra.length }])),
    completion: { enabled: completion, missDriven, candidates: [...extra].filter(([, p]) => p.origin !== 'declared').map(([url, p]) => ({ url, ...p })), declared: cfg.extraUrls, fetchResults, unknown: [...unknown, ...missUnknown, ...[...truncated].map(([url, bytes], i) => ({ id: `unk_media_${i + 1}`, kind: 'media-truncated', url, bytes, reason: `body left out by the archive caps (mediaMaxBytes ${cfg.mediaMaxBytes}, archiveCapBytes ${cfg.archiveCapBytes}); the entry replays with an empty body`, probe: 'freeze again without the caps' }))] },
    finalReplay: Object.fromEntries(Object.entries(finalVerify).map(([k, v]) => [k, { pass: v.pass, checks: v.checks, loadMs: v.loadMs, requests: v.requests, misses: v.misses, silentMisses: v.missKinds.silent, blocked: v.blockedCount, trackersBlocked: v.trackersBlocked, trackers: v.trackers, fuzzyAnswered: v.fuzzyAnswered, fuzzy: v.fuzzy, failedUnexpected: v.failedUnexpected, probe: v.probe, stepErrors: v.stepErrors, pageerrors: v.pageerrors }])),
    pass: Object.values(finalVerify).every(v => v.pass),
  };
  fs.writeFileSync(path.join(outDir, 'freeze-report.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(outDir, 'completion.json'), JSON.stringify(report.completion, null, 1));
  fs.writeFileSync(path.join(outDir, 'target.json'), JSON.stringify(targetConfig(cfg, outDir), null, 1));
  fs.writeFileSync(path.join(outDir, 'freeze-config.json'), JSON.stringify(cfg, null, 1));
  fs.writeFileSync(path.join(outDir, 'README.txt'), readme(cfg));
  sealArchive(outDir);
  const sums = verifyArchive(outDir);
  return { ok: report.pass && sums.ok, report, sums, outDir };
}

/** Build one archive version into `dir`, check it offline from disk, write the report + live evidence, seal. */
export async function sealVersion(cfg, { dir, finalDir, version, union, classes, raw, provenance, recLogs, live, rounds, completionInfo, engine, t0, policy = 'bounded', shareBrowser = false }) {
  const meta = {
    createdAt: new Date().toISOString(), tool: 'reva-freeze/1', id: cfg.id, startUrl: cfg.startUrl, classes: Object.keys(cfg.classes),
    browser: Object.values(recLogs)[0]?.browser, blockRegex: cfg.block, policy, version,
    note: 'PRIVATE. Site-derived material when frozen from a real site (H2). Never commit, publish or upload.',
  };
  buildArchive({ dir, union, classes, raw, provenance, meta });
  const finalVerify = {};
  const clsList = Object.keys(cfg.classes);
  const check = (cls, pool) => replayVerify(cfg, cls, [path.join(dir, 'har', 'all.har.zip'), path.join(dir, 'har', `${cls}.har.zip`)], { engine, timeoutMs: 30000, pool });
  if (sealParallel(clsList.length)) {
    // S-SPEED #5 (27 Oct): the class checks are independent offline loads of the same sealed files, so they run side by
    // side, each with its own whole check (same 2.5 s settle, same steps, same timeouts). Each class launches its own
    // browser here (the pre-S11 setup, no page sharing a browser with another live page); results keep class order.
    Object.assign(finalVerify, await checkClasses(clsList, cls => check(cls, null), { parallel: true }));
  } else {
    const verPool = roundPool(shareBrowser, clsList.length, OFFLINE_ARGS, engine);
    try {
      Object.assign(finalVerify, await checkClasses(clsList, cls => check(cls, verPool), { parallel: false }));
    } finally { await closePool(verPool); }
  }
  const completeness = completenessOf(finalVerify, { siteUrl: cfg.startUrl });
  const pass = Object.values(finalVerify).every(v => v.pass);
  const report = {
    schema: 2, policy, version, id: cfg.id, finishedAt: new Date().toISOString(), wallSeconds: Math.round((Date.now() - t0) / 100) / 10,
    status: pass ? 'ok' : 'partial', converged: pass, rounds,
    completeness: { pct: completeness.pct, requests: completeness.requests, renderMisses: completeness.renderMisses, siteDataMisses: completeness.siteDataMisses, misses: completeness.misses },
    recording: Object.fromEntries(Object.entries(recLogs).map(([k, l]) => [k, { docStatus: l.docStatus, finalUrl: l.finalUrl, ...(l.preloader ? { preloader: l.preloader } : {}), blockedRequests: l.blocked.length, trackersBlocked: (l.trackers || []).length, pageerrors: l.pageerrors.length, wheelSteps: l.wheelSteps, sanitise: l.sanitise, extraFetched: l.extra.length }])),
    completion: completionInfo,
    finalReplay: Object.fromEntries(Object.entries(finalVerify).map(([k, v]) => [k, { pass: v.pass, checks: v.checks, loadMs: v.loadMs, requests: v.requests, misses: v.misses, silentMisses: v.missKinds.silent, blocked: v.blockedCount, trackersBlocked: v.trackersBlocked, trackers: v.trackers, fuzzyAnswered: v.fuzzyAnswered, fuzzy: v.fuzzy, failedUnexpected: v.failedUnexpected, probe: v.probe, stepErrors: v.stepErrors, pageerrors: v.pageerrors }])),
    pass,
  };
  fs.writeFileSync(path.join(dir, 'freeze-report.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(dir, 'completion.json'), JSON.stringify(completionInfo, null, 1));
  fs.writeFileSync(path.join(dir, 'misses.json'), JSON.stringify({ completeness: report.completeness, missLog: completeness.missLog, notFetched: completionInfo.notFetched || [] }, null, 1));
  fs.writeFileSync(path.join(dir, 'target.json'), JSON.stringify(targetConfig(cfg, finalDir), null, 1));
  fs.writeFileSync(path.join(dir, 'freeze-config.json'), JSON.stringify(cfg, null, 1));
  fs.writeFileSync(path.join(dir, 'README.txt'), readme(cfg));
  if (live) { // live evidence of the round-1 visit (live.json + live/<cls>.jpg), kept inside the sealed archive
    fs.mkdirSync(path.join(dir, 'live'), { recursive: true });
    for (const cls of Object.keys(live.classes)) { const f = path.join(live.dir, `${cls}.jpg`); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, 'live', `${cls}.jpg`)); }
    fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify({ schema: 1, note: 'what the LIVE page showed at freeze time (round 1, after consent, before the sweep)', classes: live.classes }, null, 1));
  }
  sealArchive(dir);
  const sums = verifyArchive(dir);
  return { report, sums, completeness, ok: pass && sums.ok };
}

/**
 * Bounded freeze (corpus policy, C-REVIEW §3 points 1-4):
 *  1. round 1 records every class (+ live evidence), builds, checks and SEALS archive v1 at once -> onSealed(outDir, report)
 *  2. one typed completion pass: render-relevant replay misses first, then typed code literals; <= maxUrls, <= budgetMs,
 *     fetched ONCE (one class, into the union), concurrency; telemetry/API/non-GET logged, never chased
 *  3. v2 is built next to v1 and replaces it only when it is not worse on render-relevant misses and adds entries; a kill at any
 *     point leaves sealed v1 (or v2) in outDir. The miss log + completeness % travel in the report and misses.json.
 */
async function freezeBounded(cfg, { outDir, work, engine, completion, log, t0, bounded, onSealed, shareBrowser = false }) {
  const B = { maxUrls: 200, budgetMs: 120000, concurrency: 4, ...bounded };
  const block = cfg.block ? new RegExp(cfg.block) : null;
  const truncated = new Map();
  const recLogs = {}, classes = {}, raw = {};
  const liveDir = path.join(work, 'live');
  const recPool = roundPool(shareBrowser, Object.keys(cfg.classes).length, recordArgs(cfg), engine);
  try {
    for (const cls of Object.keys(cfg.classes)) {
      const harPath = path.join(work, 'round1', 'raw', `${cls}.har.zip`);
      log(`round 1: recording class ${cls} (${cfg.extraUrls.length} declared URLs)`);
      recLogs[cls] = await recordClass(cfg, cls, { harPath, extraUrls: cfg.extraUrls, engine, evidence: { dir: liveDir }, pool: recPool });
      raw[cls] = fs.readFileSync(harPath);
      const s = sanitizeHar(parseHarZip(raw[cls]), { block });
      capMedia(s, cfg, truncated);
      classes[cls] = s; recLogs[cls].sanitise = s.report;
    }
  } finally { await closePool(recPool); }
  const live = { dir: liveDir, classes: Object.fromEntries(Object.entries(recLogs).map(([k, l]) => [k, l.live || null])) };
  const union1 = mergeHars(Object.values(classes));
  const mediaUnknown = () => [...truncated].map(([url, bytes], i) => ({ id: `unk_media_${i + 1}`, kind: 'media-truncated', url, bytes, reason: `body left out by the archive caps (mediaMaxBytes ${cfg.mediaMaxBytes}, archiveCapBytes ${cfg.archiveCapBytes}); the entry replays with an empty body`, probe: 'freeze again without the caps' }));
  const declaredProv = new Map(cfg.extraUrls.map(u => [u, { origin: 'declared', provenance: 'declared' }]));
  const rounds = [{ round: 1, at: Math.round((Date.now() - t0) / 1000) }];
  let info = { enabled: completion, policy: B, declared: cfg.extraUrls, candidates: [], fetchResults: [], notFetched: [], dropped: {}, unknown: mediaUnknown() };
  let cur = await sealVersion(cfg, { dir: outDir, finalDir: outDir, version: 1, union: union1, classes, raw, provenance: declaredProv, recLogs, live, rounds, completionInfo: info, engine, t0, shareBrowser });
  log(`v1 sealed at ${Math.round((Date.now() - t0) / 1000)} s: completeness ${cur.completeness.pct} %, ${cur.completeness.renderMisses} render misses, ${cur.completeness.siteDataMisses} site-data misses`);
  if (onSealed) await onSealed(outDir, cur.report);
  if (!completion) return { ok: cur.ok, report: cur.report, sums: cur.sums, outDir };
  try { return await completeOnce(cfg, { outDir, work, engine, log, t0, B, block, truncated, recLogs, classes, raw, live, union1, mediaUnknown, declaredProv, rounds, info, cur, onSealed, shareBrowser }); }
  catch (e) { // the completion pass is best effort: sealed v1 stands
    log(`completion failed, v1 kept: ${String(e.message || e).split('\n')[0]}`);
    return { ok: cur.ok, report: cur.report, sums: cur.sums, outDir, completionError: String(e.message || e).split('\n')[0].slice(0, 300) };
  }
}

async function completeOnce(cfg, { outDir, work, engine, log, t0, B, block, truncated, recLogs, classes, raw, live, union1, mediaUnknown, declaredProv, rounds, info, cur, onSealed, shareBrowser = false }) {

  // typed, bounded completion: once
  const have = new Set(union1.har.log.entries.map(e => e.request.url));
  const misses = Object.values(cur.report.finalReplay).flatMap(v => v.misses || []);
  const a = analyseCompletion({ files: codeFiles(union1), documentOrigin: new URL(cfg.startUrl).origin, have, block, domains: cfg.domains });
  const rk = rankCandidates({ misses, literals: a.candidates, have, maxUrls: B.maxUrls, origin: new URL(cfg.startUrl).origin, siteUrl: cfg.startUrl });
  // robots.txt of the site's own hosts decides before anything is fetched (26 Oct): a disallowed URL stays a logged miss
  const rb = await robotsFilter(rk.picked, { siteUrl: cfg.startUrl, robotsText: robotsFetcher() });
  const picked = rb.allowed;
  const dropped = rb.disallowed.length ? { ...rk.dropped, robots: rb.disallowed.length } : rk.dropped;
  info = { ...info, candidates: picked, notFetched: [...rk.notFetched, ...rb.disallowed], dropped, unknown: [...a.unknown, ...mediaUnknown()] };
  log(`completion: ${picked.length} typed candidates (${rk.notFetched.length} over the cap; dropped ${JSON.stringify(dropped)})`);
  for (const d of rb.disallowed) log(notFetchedText(d));
  if (!picked.length) return { ok: cur.ok, report: cur.report, sums: cur.sums, outDir };

  const cls0 = Object.keys(cfg.classes)[0];
  const harPath = path.join(work, 'round2', 'raw', 'completion.har.zip');
  const rec = await recordClass(cfg, cls0, { harPath, extraUrls: picked.map(c => c.url), engine, fetchOnly: true, fetchBudgetMs: B.budgetMs, fetchConcurrency: B.concurrency });
  const rawC = fs.readFileSync(harPath);
  const sC = sanitizeHar(parseHarZip(rawC), { block });
  capMedia(sC, cfg, truncated);
  const union2 = mergeHars([...Object.values(classes), sC]);
  info.fetchResults = rec.extra.map(x => ({ url: x[0], result: x[1], bytes: x[2] }));
  info.notFetched = [...info.notFetched, ...rec.extra.filter(x => x[1] === 'not-fetched:budget').map(x => ({ url: x[0], reason: 'not-fetched:budget' }))];
  info.unknown = [...a.unknown, ...mediaUnknown()];
  rounds.push({ round: 2, at: Math.round((Date.now() - t0) / 1000), fetched: rec.extra.length, budgetMs: B.budgetMs });
  const prov = new Map(declaredProv);
  for (const c of picked) if (!prov.has(c.url)) prov.set(c.url, { origin: c.origin, provenance: c.origin === 'miss-driven' ? 'measured' : c.provenance, kind: c.kind, template: c.template, file: c.file, how: c.how });
  const next = outDir + '.next';
  const v2 = await sealVersion(cfg, { dir: next, finalDir: outDir, version: 2, union: union2, classes, raw: { ...raw, completion: rawC }, provenance: prov, recLogs: { ...recLogs }, live, rounds, completionInfo: info, engine, t0, shareBrowser });
  // v2 replaces v1 when it is not worse on render-relevant misses and holds more entries: code-only assets (states,
  // interactions the default replay never triggers) are why completion exists, so "equal misses, more assets" counts.
  // relevant = render + same-site data misses (S2, 26 Oct): v2 must not be worse on either kind taken together
  const relevant = c => c.renderMisses + (c.siteDataMisses || 0);
  const better = v2.sums.ok && relevant(v2.completeness) <= relevant(cur.completeness) && union2.har.log.entries.length > union1.har.log.entries.length;
  log(`v2: ${v2.completeness.renderMisses} render + ${v2.completeness.siteDataMisses} site-data misses vs v1 ${cur.completeness.renderMisses} + ${cur.completeness.siteDataMisses}: ${better ? 'replaces v1' : 'v1 kept'}`);
  if (!better) return { ok: cur.ok, report: cur.report, sums: cur.sums, outDir, v2Rejected: { renderMisses: v2.completeness.renderMisses, siteDataMisses: v2.completeness.siteDataMisses } };
  const prev = outDir + '.prev';
  fs.renameSync(outDir, prev); fs.renameSync(next, outDir); fs.rmSync(prev, { recursive: true, force: true });
  if (onSealed) await onSealed(outDir, v2.report);
  return { ok: v2.ok, report: v2.report, sums: verifyArchive(outDir), outDir };
}

function readme(cfg) {
  return `FROZEN COPY ${cfg.id} -- made by reva freeze. PRIVATE when the source is a real site (PLAN H2): never commit, publish or upload.

  har/<class>.har.zip, har/all.har.zip   sanitised Playwright HARs (blocked/failed entries removed, request-body files kept, secrets redacted)
  har-raw/                              as recorded, provenance only: do NOT replay (status -1 entries stall 'load' forever)
  files/                                one body per answered URL;  manifest.json lists every entry with provenance
  SHA256SUMS (files/)  ARCHIVE.SHA256SUMS (all other files):  shasum -a 256 -c <file>  from this directory
  target.json                           target config for src/replay (reva replay boot) -- copy it to the targets folder
  freeze-report.json, completion.json   what was recorded, derived from code, found missing; unknowns ledger

Replay recipe (Playwright; the most recently registered route runs first):
  launch with --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost"   (proves nothing leaks to the network)
  ctx.route('**/*', log-miss-then-abort)  ->  routeFromHAR(har/all.har.zip, {notFound:'fallback'})  ->  routeFromHAR(har/<class>.har.zip, {notFound:'fallback'})  ->  ctx.route(BLOCK, abort)
  Pass = zero logged misses and 'load' fires.
`;
}

export { unsealArchive };
