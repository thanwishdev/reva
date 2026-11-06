// The end of a scan (DESIGN 3.2, S7-S10): the takes become moves, the fit runs beside the clips and the take video, the ledger gets
// the moves' rows and is checked again, and the card is written last, so it sees every field. Each step can fail alone: what was
// recorded is already safe on disk. Clips come before the take video, since encodeTake deletes the JPEG files they are cut from.
import fs from 'node:fs';
import path from 'node:path';
import { encodeScan } from './video.js';
import { repackSeries, REPACK_SMALL_BYTES } from './repack.js';
import { writeScanCard } from '../card/stage.js';
import { clipRequests, applyClips, heroRequests, applyHeroes } from '../card/moves.js';
import { fitAll, fitLine } from './open.js';
import { buildMoves, writeMoves } from './moves/index.js';
import { fitMoves, writeClipT0 } from './moves/fit.js';
import { joinDeclared } from './moves/join.js';
import { cutClips, cutHeroPosters } from './clips.js';
import { Ledger, promisedUnits, exitFor } from './ledger.js';
import { addRows, fitRow, moveRow } from './rows.js';
import { siteWords } from './words.js';

const first = (e) => String(e?.message ?? e).split('\n')[0];
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
/** What a move's pictures show and its values cannot say, on the kinds no element's rows can read in full (DESIGN 2.5). */
const NOT_READ = {
  scene: [{ what: 'what the canvas draws beyond its uniforms', why: 'a canvas is drawn by code; only its pictures and uniforms can be read' }],
  media: [{ what: "the video's own timeline", why: "it runs on its own clock, not the page's" }],
};

/** The ledger's rows for the moves, the check with everything the scan now knows, and the exit code. */
export function closeLedger(out, index, { fit = null, failed = [] } = {}) {
  const file = path.join(out, 'coverage.json'), scan = readJson(path.join(out, 'scan.json')), ledger = Ledger.read(file);
  const failedBy = new Map(failed.map((f) => [f.id, f.error]));
  addRows(ledger, index.moves.map((m) => moveRow({ ...m, take: m.instances?.[0]?.take ?? null, runs: m.n ?? null }, { clip: m.frame?.clip ?? null, fps: m.frame?.fps ?? null, noClipReason: m.gap ?? failedBy.get(m.id) ?? null, partial: NOT_READ[m.kind] ?? null })));
  addRows(ledger, (fit?.ledger ?? []).map((v) => fitRow(v)));
  const { context = {}, ...promised } = scan.promised ?? {};
  const ctx = { ...context, tally: index.tally };
  const units = promisedUnits({ pages: [], viewports: [], moments: [], ...promised, moves: index.moves.map((m) => ({ id: m.id })) });
  for (const v of fit?.ledger ?? []) units.push({ unit: 'fit', viewport: v.viewport, id: 'summary' });
  const check = ledger.check(units, ctx);
  ledger.write(file);
  return { ledger, check, exit: exitFor(ledger, check, { homeCaptured: scan.homeCaptured ?? true }), scan };
}

/** @returns {{card:string|null, video:object|null, fit:object|null, moves:object|null, clips:object|null, ledger:Ledger|null, exit:number|null, problems:string[]}} */
export async function finishScan(out, { all = false, engine, workers, video = true, repack = true, log = () => {}, launch } = {}) {
  const t0 = Date.now(), times = {}, res = { card: null, video: null, fit: null, moves: null, clips: null, ledger: null, exit: null, problems: [] };
  const timed = (name, t) => { times[name] = Date.now() - t; };
  const on = launch ? { launch } : {};
  let index = null, pages = [];
  try { pages = readJson(path.join(out, 'scan.json')).pages || []; } catch { /* a folder with no pages list has no moves either */ }

  // S7 moves
  try {
    const t = Date.now(), built = buildMoves(out);
    res.moves = { ...writeMoves(out, built), ms: built.stats?.ms ?? null };
    index = built.index; timed('moves', t);
    log(`${res.moves.moves} moves, ${res.moves.laws} law classes, ${Date.now() - t} ms`);
  } catch (e) { res.problems.push(`no moves: ${first(e)}`); }

  // S8 beside S9: fits are CPU, encoding is the media engine. fitMoves rewrites moves.json at its end, so clip fields go in after it
  const fit = (async () => {
    if (!index) return null;
    const t = Date.now();
    const r = await fitMoves(out, { ...(workers ? { workers } : {}), log });
    res.join = joinDeclared(out, { log }); timed('fit', t);
    return r;
  })().catch((e) => { res.problems.push(`the fit stopped: ${first(e)}`); return null; });
  // the series packed tighter once the fit has read them, on threads beside the take video (repack.js). Not beside the clips:
  // the fit's memory is not yet given back when it ends, and the clip browser runs then (a 3D portfolio site, 5 Nov: tree 5.4 GB). One
  // thread beside the video's two browsers, all of them once it ends (a small agency site, 5 Nov: tree 5.07 GB with three beside it); large
  // series start on all threads, else one would outlast the video by minutes (repack.js REPACK_SMALL_BYTES)
  let clipsDone = () => {}, videoDone = () => {};
  const clipsGate = new Promise((r) => { clipsDone = r; }), videoGate = new Promise((r) => { videoDone = r; });
  const packed = Promise.all([fit, clipsGate]).then(async () => {
    if (!repack) return null;
    const t = Date.now(), r = await repackSeries(out, { log, first: (bytes) => (bytes <= REPACK_SMALL_BYTES ? 1 : Infinity), widen: videoGate }); timed('repack', t);
    log(`${r.files} series packed again: ${(r.before / 1e6).toFixed(0)} to ${(r.after / 1e6).toFixed(0)} MB, ${Math.round(r.wallMs / 1000)} s`);
    return r;
  }).catch((e) => { res.problems.push(`the series stay as recorded: ${first(e)}`); return null; });
  let rq = [], cut = null, heroes = [];
  if (index && video) {
    const t = Date.now();
    try {
      rq = clipRequests(out, index, { pages });
      cut = await cutClips(out, rq, { engine, log, ...on });
      heroes = await cutHeroPosters(out, heroRequests(out, index, { pages }), { engine, log, ...on });
      res.clips = { encoded: cut.encoded, posters: cut.posters, shared: cut.shared ?? 0, bytes: cut.bytes, wallMs: cut.wallMs, scale: cut.scale ?? 1, qp: cut.qp ?? null, why: cut.why };
      log(`${cut.encoded} clips, ${(cut.bytes / 1e6).toFixed(0)} MB, ${Math.round(cut.wallMs / 1000)} s`);
    } catch (e) { res.problems.push(`no clips: ${first(e)}`); }
    timed('clips', t);
  }
  clipsDone();
  if (video) {
    const t = Date.now();
    try {
      res.video = await encodeScan(out, { engine, log });
      if (res.video.encoded) log(`${res.video.encoded} takes as video: ${(res.video.bytes / 1e6).toFixed(0)} MB, was ${(res.video.jpegBytes / 1e6).toFixed(0)} MB of pictures, ${Math.round(res.video.wallMs / 1000)} s`);
    } catch (e) { res.problems.push(`pictures stay as JPEG files: ${first(e)}`); }
    timed('video', t);
  }
  videoDone();
  res.fit = await fit;
  res.repack = await packed;

  // what S8 and S9 made goes together; the instance's place in the take video needs that video
  let failed = [];
  if (index) {
    try {
      const t = Date.now(), file = path.join(out, 'moves.json'), merged = readJson(file);
      if (cut) {
        const a = applyClips(out, merged, rq, cut.results, { pages }); failed = a.failed;
        applyHeroes(out, merged, heroes, { pages });
        fs.writeFileSync(file, JSON.stringify(merged));
        writeClipT0(out, a.starts);
        if (failed.length) res.problems.push(`${failed.length} moves have no clip: ${failed[0].error}`);
      }
      index = merged; timed('merge', t);
    } catch (e) { res.problems.push(`the clips were not joined to the moves: ${first(e)}`); }
  }

  // S10: the ledger, then the card
  if (index) {
    try {
      const c = closeLedger(out, index, { fit: res.fit, failed });
      res.ledger = c.ledger; res.exit = c.exit; res.check = c.check;
      const words = siteWords(c.scan, c.ledger);
      index.coverage = words.coverage ?? null;
      if (index.scan) index.scan.wallMs = (c.scan.wallMs ?? 0) + (Date.now() - t0);
      fs.writeFileSync(path.join(out, 'moves.json'), JSON.stringify(index));
    } catch (e) { res.problems.push(`the ledger was not closed: ${first(e)}`); }
  }
  try {
    const t = Date.now();
    res.card = writeScanCard(out, { log }).file;
    if (!res.card) res.problems.push('no card: no page has pictures');
    if (all && res.card) {
      res.study = await fitAll(out, { log, ...(workers ? { workers } : {}) });
      log(fitLine(res.study));
      writeScanCard(out, { log, keepStage: true });
    }
    timed('card', t);
  } catch (e) { res.problems.push(`the card was not written: ${first(e)}`); }

  const file = path.join(out, 'scan.json');
  try {
    const scan = readJson(file);
    scan.card = res.card ? path.relative(out, res.card) : null;
    if (res.video) scan.video = res.video;
    if (res.clips) scan.clips = res.clips;
    if (res.moves) scan.moves = res.moves;
    if (res.repack) scan.repack = res.repack;
    if (res.fit) scan.fitMoves = { ms: res.fit.ms, fitMs: res.fit.fitMs, medianFitMs: res.fit.medianFitMs, classes: res.fit.classes, problems: res.fit.problems.length, ledger: res.fit.ledger };
    if (res.join) scan.join = { gsap: res.join.gsap, groups: res.join.groups, moves: res.join.moves, lottie: res.join.lottie, morphs: res.join.morphs, problems: res.join.problems.length };
    if (res.study) scan.fit = { motions: res.study.motions, fitted: res.study.fitted, failed: res.study.failed.length, cut: res.study.cut.length, p50: res.study.p50, p95: res.study.p95, max: res.study.max, wallMs: res.study.wallMs, workers: res.study.workers };
    if (res.exit != null) {
      scan.exit = res.exit;
      scan.ledger = { line: res.ledger.firstLine(), check: { ok: res.check.ok, missing: res.check.missing.length, problems: res.check.problems.length } };
    }
    scan.finish = { wallMs: Date.now() - t0, times, problems: res.problems };
    fs.writeFileSync(file, JSON.stringify(scan, null, 1));
  } catch { /* scan.json stays as the scan wrote it */ }
  return res;
}
