// Recorder session (Node side). One browser, one page, one lane. Owns time (hx), scroll and input; collects dense,
// ungated samples and writes a provenance-tagged take (src/record/take.js).
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../browser/launch.js';
import { assertPoolFits } from '../browser/pool.js';
import { wireReplay } from '../replay/replay.js';
import { harPaths, seedScript, OFFLINE_ARGS } from '../replay/target.js';
import { inpageSource } from './inpage.js';
import { stripControls, CONTROL_CHARS } from '../report/untrusted.js';
import { writeTake } from './take.js';
import { DELTA_HEADER, rowDecoder } from './rowcodec.js';
import { attachWorkers, WORKER_TAP_SOURCE } from './workergl.js';
import { Spool } from './series-io.js';
import { pixelChannelSource } from './pixel.js';
import { keepaliveSource, KEEPALIVE_ARGS } from './keepalive.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const RATES = { 120: 1000 / 120, 60: 1000 / 60, 30: 1000 / 30 };   // 30 Hz: M2 X1 (regime R4)
/** Fixed virtual wall clock for hx takes (A2 determinism). Before 2026-11-06 05:00 UTC (S5 §7.4: countdown scenes). */
export const DEFAULT_DATE_EPOCH = Date.UTC(2026, 9, 14, 9, 0, 0);
/** macOS: moves headless frames off the display link (W2G1-2 §6). Used for unattended hx takes only. */
export const TIMER_FLAG = '--enable-features=ForceMacVSyncTimerForDebugging';

/** o.maxElements: Infinity becomes this (Infinity does not survive the JSON that carries the config into the page). */
export const NO_CAP = 1e9;

export class FatalRecorderError extends Error {}

/** Network gate (hx): resource types whose request holds virtual time up to NET_LONG_MS wall until its response starts. */
export const NET_WAITED = new Set(['document', 'stylesheet', 'script', 'font', 'image', 'fetch', 'xhr', 'manifest', 'texttrack']);
/** The types whose body is waited for too (NET_LONG_MS); any other body (a fetch / XHR stream or long poll) up to maxMs. */
export const NET_BODY_WAITED = new Set(['document', 'stylesheet', 'script', 'font', 'image', 'manifest', 'texttrack']);
/** Wall bound of one waited request, and of one whole gate wait. */
export const NET_LONG_MS = 30000;
/** Wall bound of one page-idle wait after a response. */
export const NET_IDLE_MS = 2000;
/** For this many frames after any network event, one frame per page call (the gate is checked between calls). */
export const NET_QUIET_FRAMES = 30;
/** Bound (wall) of the wait for one arrived script to be parsed by V8. */
export const SCRIPT_PARSE_MS = 10000;

/** Scan: has this request's frame gone? A request of a removed sub-frame never finishes, so it must leave the gate (DESIGN 3.2). */
export function frameGone(r) { try { return r.frame().isDetached(); } catch { return true; } }

/** The pointer sweep's path (pure): a closed figure over the viewport, the same on every page, 8 % in from the edges. */
export function sweepPoint(i, n, w, h) {
  const t = n > 1 ? i / (n - 1) : 0;
  return { x: Math.round(w * (0.5 - 0.42 * Math.cos(2 * Math.PI * t))), y: Math.round(h * (0.5 - 0.42 * Math.cos(4 * Math.PI * t))) };
}

/** Browser flags of a session (pure): what launchBrowser gets on top of MANDATORY_ARGS, and what a pool must carry. */
export function sessionArgs(o = {}) {
  const keepalive = !!o.keepalive && (o.lane || 'hx') === 'hx';
  return [...(o.live ? [] : OFFLINE_ARGS), ...(o.timerFlag ? [TIMER_FLAG] : []), ...(keepalive ? KEEPALIVE_ARGS : []), ...(o.args || [])];
}
/** Context options of a session (pure): viewport class (or o.viewport), reduced motion, colour scheme (when asked), locale, timezone. */
export function sessionContext(o = {}) {
  const vpCls = o.target && o.cls ? o.target.classes[o.cls] : null;
  const ctxOpts = vpCls ? { ...vpCls } : { viewport: o.viewport || { width: 1440, height: 900 }, deviceScaleFactor: 1 };
  ctxOpts.reducedMotion = o.reducedMotion || 'no-preference';
  // --color-scheme (src/browser/scheme.js): absent = Playwright's default (light) and nothing added, as before the option
  if (o.colorScheme) ctxOpts.colorScheme = o.colorScheme;
  ctxOpts.locale = (o.target && o.target.locale) || 'en-US';
  if (o.target && o.target.timezone) ctxOpts.timezoneId = o.target.timezone;
  return ctxOpts;
}
/** The browser handle of a session: its own launch (default), or a context in o.pool (checked to be the same browser). */
export async function sessionHandle(o, { engine, args, ctxOpts, launch = launchBrowser }) {
  if (!o.pool) return launch({ engine, toolkit: o.toolkit, args, context: ctxOpts, prefs: o.prefs });
  if (o.prefs) throw new Error('a pooled session cannot take profile prefs (they are written before a browser launch)');
  assertPoolFits(o.pool, { args, engine, toolkit: o.toolkit });
  const h = await o.pool.open({ context: ctxOpts });
  await h.page.bringToFront().catch(() => {}); // the only page of its browser; as the gate does for pooled sessions
  return h;
}

/**
 * @param {object} o
 * @param {'hx'|'rt'} o.lane
 * @param {120|60|30} [o.rate]       hx virtual rate (rt: nominal; real frames decide)
 * @param {{every:number, ms:number}} [o.stall]  hx only: deterministic stall schedule (M2 X1, regime R5)
 * @param {object} [o.target]        a loaded private target config (replay) — or o.url for a local fixture
 * @param {string} [o.url]
 * @param {string} [o.cls]           target viewport class
 * @param {object} [o.viewport]      {width,height} when no target class is used
 * @param {object} [o.scene]         {selectors[], computedVars[], glUniforms[], pixelKeys[], probe: '() => ({...})', init}
 * @param {boolean} [o.keepalive]    hx: keep real frames flowing at full speed (src/record/keepalive.js); recorded in
 *                                   take.extra.frameClock and the browser args
 * @param {{selectors:string[], pseudos?:(string|null)[]}} [o.aim]  aim mode (pseudos[i]: read selectors[i] at that pseudo-element) (`look --el`): only elements matching the selectors are watched, each
 *                                   from its first style/class write, --var write or running animation (the corpus
 *                                   discovery trigger), and every match from S.aimOn() on
 * @param {string} [o.writeDir]      where this take is written (default: a new folder under the output root); two sessions at once each name their own
 * @param {Function} [o.onMiss]      archive replay only: read-through, see wireReplay. Off unless a caller passes it
 * @param {boolean} [o.live]         a live (non-local) URL: drop the DNS sinkhole (OFFLINE_ARGS). Archive replay never sets it.
 * @param {boolean|{maxMs:number, longMs:number}} [o.netGate]  hx only: virtual time waits for the network. Before each
 *                                   virtual step, wait (wall clock) until no request is in flight, no arrived script of
 *                                   the top document is still unparsed, and the page has handled what arrived (main
 *                                   thread idle), so a response lands at the same virtual time on every run whatever the
 *                                   machine load (Chrome's virtual-time policy "pauseIfNetworkFetchesPending", done here).
 *                                   A waited request (NET_WAITED) counts up to `longMs` (default NET_LONG_MS); a stream or
 *                                   long-poll body and other types up to `maxMs` (default 3000). Stats: S.netGateStats().
 * @param {number} [o.cpuThrottle]   tests / load experiments: CDP CPU throttling rate of the page (> 1)
 * @param {object} [o.pool]          OPT-IN (corpus motion step, S11): a BrowserPool (src/browser/pool.js) whose browser was
 *                                   started with exactly sessionArgs(o), the same engine and toolkit; the session gets a
 *                                   fresh empty context + page in it instead of its own browser launch. Without o.pool (every
 *                                   `reva look` path) the session launches its own browser exactly as before.
 * @param {number} [o.maxElements]   moving-set cap (default 300); Infinity = no cap
 * @param {boolean} [o.streamRows]   rows and mutations go to disk as they arrive (delta form, rowcodec.js) and never into the
 *                                   heap: what lets a page with thousands of moving elements be recorded in full. S.data.rows
 *                                   and take.data.rows hold only {k, T, sy, sx}; read the values with loadTake(dir, ['rows']).
 * @param {boolean} [o.rowTee]       proof only, slow: the page also sends every row whole, the old way; S.teeResult() is the
 *                                   sha256 and count of those rows as JSON Lines, which the decoded rows must equal
 * @param {object} [o.recordHar]     Playwright recordHar options ({path, mode, content}): the look's session cache
 * @param {boolean} [o.scan]         a `reva scan` take: every capture change of the scan sits behind this one option, carried in
 *                                   CFG, so a look's rows stay byte-equal. Page side: Event.timeStamp on the clock, every keyframe
 *                                   kept, a selector at first watch, W.quiet, the shot signals. Node side: a request of a removed
 *                                   frame leaves the gate. S.controlStart/controlStop/controlClear, S.partStart, S.quiet need it.
 * @param {number} [o.idleMs]        wall bound of one page-idle wait in the network gate (default NET_IDLE_MS); hits are counted
 */
export class BrowserDiedError extends FatalRecorderError {}
export const WATCH = { everyMs: 4000, answerMs: 8000, misses: 2 };

/**
 * Browser-death watchdog (2 Nov): a killed or crashed browser used to leave a take waiting for ever on a CDP answer that
 * never comes. Now the page closing or crashing, or `misses` unanswered browser-level pings in a row (about 24 s at most),
 * rejects every later CDP call with BrowserDiedError, so the take ends in an error and the caller's finally closes the rest.
 */
export function watchBrowser(S, w = WATCH) {
  let died = null, fail;
  const dead = new Promise((_, rej) => { fail = rej; });
  dead.catch(() => {});
  const die = why => { if (died) return; died = new BrowserDiedError(`browser died: ${why}`); S.deadError = died; fail(died); };
  const raw = S.cdp.send.bind(S.cdp);
  S.cdp.send = (...a) => died ? Promise.reject(died) : Promise.race([raw(...a), dead]);
  S.dead = dead;
  S.page.on('close', () => die('the page closed'));
  S.page.on('crash', () => die('the page crashed'));
  let misses = 0, busy = false;
  const timer = setInterval(async () => {
    if (busy || died || S.closed) return; busy = true;
    try {
      await Promise.race([raw('Browser.getVersion'), new Promise((_, rej) => setTimeout(() => rej(new Error('no answer')), w.answerMs).unref())]);
      misses = 0;
    } catch (e) { if (++misses >= w.misses) die(`no answer from the browser for ${misses} pings (${e.message})`); }
    busy = false;
  }, w.everyMs);
  timer.unref();
  S.stopWatch = () => clearInterval(timer);
}

export async function openSession(o) {
  const lane = o.lane || 'hx';
  const rate = o.rate || 120;
  const dt = RATES[rate];
  if (!dt) throw new Error(`unsupported rate ${rate} (use 120, 60 or 30)`);
  const stall = o.stall && lane === 'hx' ? { every: +o.stall.every, ms: +o.stall.ms } : null;
  if (o.stall && lane !== 'hx') throw new Error('a stall schedule needs the hx lane');
  if (stall && !(stall.every >= 2 && stall.ms > dt)) throw new Error(`bad stall schedule ${JSON.stringify(o.stall)}`);
  const engine = o.engine || 'chs';
  const scene = o.scene || {};
  const keepalive = !!o.keepalive && lane === 'hx';
  if (o.live && o.target) throw new Error('a live session cannot replay an archive target');
  const args = sessionArgs(o);
  const ctxOpts = sessionContext(o);
  const cfg = {
    lane, dt, t0: 0, dateEpoch: o.dateEpoch ?? DEFAULT_DATE_EPOCH, dateInteger: !!o.dateInteger, yieldMode: o.yieldMode || 'macro',
    births: o.births !== false, rtPhase: o.rtPhase || 'post', birthRule: o.birthRule || 'next', settleTimeoutMs: o.settleTimeoutMs || 250, maxElements: o.maxElements === Infinity ? NO_CAP : o.maxElements || 300, capPolicy: o.capPolicy || null,
    seed: o.target ? o.target.seed : (o.seed ?? null),
    discover: o.discover !== false, computedVars: scene.computedVars || [], glUniforms: scene.glUniforms || [], glTap: o.glTap !== false, stall,
    aim: o.aim && o.aim.selectors && o.aim.selectors.length ? { selectors: [...o.aim.selectors], ...(o.aim.pseudos && o.aim.pseudos.some(Boolean) ? { pseudos: [...o.aim.pseudos] } : {}) } : null, keepalive, live: !!o.live, ...(o.rowTee ? { rowTee: true } : {}), ...(o.scan ? { scan: true } : {}),
  };
  const started = new Date();
  const wallT0 = Date.now();
  // o.recordHar (look's session cache, src/look/cache.js): Playwright records the responses passively into a temp HAR,
  // written when the context closes. Not part of ctxOpts, so take.json never names the temp file.
  const h = await sessionHandle(o, { engine, args, ctxOpts: o.recordHar ? { ...ctxOpts, recordHar: o.recordHar } : ctxOpts });
  const S = {
    lane, rate, dt, cfg, h, page: h.page, ctx: h.context, o, scene, marks: [], errors: [], net: null,
    data: { rows: [], births: [], mut: [], wheel: [], declared: [], cdpAnimations: [] }, inputLog: [], stepWall: [], started, closed: false,
  };
  try {
    if (o.target) {
      S.net = await wireReplay(S.ctx, harPaths(o.target, o.cls), { blockRegex: o.target.blockRegex ? new RegExp(o.target.blockRegex) : null, onMiss: o.onMiss ?? null });
      await S.ctx.addInitScript(seedScript(o.target.seed));
    } else {
      // no archive replay: nothing counts failed requests, so take.json says misses: null (not counted), never 0
      S.net = { misses: [], blocked: [] };
      if (o.seed != null) await S.ctx.addInitScript(seedScript(o.seed));
    }
    if (o.scan && lane === 'hx' && cfg.glTap && o.workerGl !== false) await S.ctx.addInitScript({ content: `window.__WR_WORKER_TAP = ${JSON.stringify(WORKER_TAP_SOURCE)};` });
    await S.ctx.addInitScript({ content: inpageSource(cfg) });
    if (scene.pixelKeys && scene.pixelKeys.length) await S.ctx.addInitScript({ content: pixelChannelSource({ pixelKeys: scene.pixelKeys }) });
    if (scene.probe) await S.ctx.addInitScript({ content: `window.__WR_PROBE = ${scene.probe};` });
    if (scene.init) await S.ctx.addInitScript({ content: scene.init });
    if (keepalive) await S.ctx.addInitScript({ content: keepaliveSource() });
    S.page.on('pageerror', e => S.errors.push('pageerror: ' + String(e).slice(0, 300)));
    S.cdp = await S.ctx.newCDPSession(S.page);
    // a scan take taps WebGL inside the page's dedicated workers too, on the page's virtual clock (workergl.js)
    if (o.scan && lane === 'hx' && cfg.glTap && o.workerGl !== false) { try { S.workers = await attachWorkers(S); } catch (e) { S.workers = null; S.errors.push('worker tap: ' + String(e.message).slice(0, 200)); } }
    S.browserInfo = await S.cdp.send('Browser.getVersion');
    watchBrowser(S);
    // o.cpuThrottle (tests / load experiments only): CDP CPU throttling of the page, a controlled stand-in for a busy machine
    if (o.cpuThrottle > 1) await S.cdp.send('Emulation.setCPUThrottlingRate', { rate: +o.cpuThrottle });
  } catch (e) { await h.close(); throw e; }

  // network gate (o.netGate): requests in flight. A busy machine or a slow server makes requests take longer in wall
  // time; virtual time must not run meanwhile, or a page's own timeout (a library raced against setTimeout, a poster
  // shown when the texture is late) fires on a loaded machine and not on an idle one (measured: 6 of 17 motions lost on
  // a local site with 2 s of added latency). So what a page waits for (document, script, style, font, image, and a
  // fetch / XHR until its response starts) holds virtual time up to `longMs` wall; only what can stay open by design
  // (a stream or a long poll's open body, media, beacons, event sources) stops counting after `maxMs`.
  const gate = o.netGate && lane === 'hx' ? { maxMs: (o.netGate && o.netGate.maxMs) || 3000, longMs: (o.netGate && o.netGate.longMs) || NET_LONG_MS, flight: new Map(), waits: 0, waitedMs: 0, maxWaitMs: 0, expired: 0, expiredTypes: {}, done: 0, idleDone: 0, idleWaits: 0, idleMs: 0, idleHits: 0, detached: 0, lastAct: -1e9 } : null;
  const idleBound = o.idleMs || NET_IDLE_MS;
  let stepsDone = 0;
  if (gate) {
    const done = (r) => { if (gate.flight.delete(r)) { gate.done++; gate.lastAct = stepsDone; } };
    S.page.on('request', (r) => { let type = 'other', sub = false; try { type = r.resourceType(); sub = r.frame() !== S.page.mainFrame(); } catch {} gate.flight.set(r, { t: Date.now(), type, sub, resp: null }); gate.lastAct = stepsDone; });
    S.page.on('response', (res) => { try { const e = gate.flight.get(res.request()); if (e) e.resp = Date.now(); } catch {} });
    S.page.on('requestfinished', done); S.page.on('requestfailed', done);
  }
  // ... and a script that has arrived is not run yet: the browser compiles it (off the main thread for a big module, so
  // an idle main thread does not mean it is done). Each script response of the top document is waited for until V8
  // reports it parsed (CDP Debugger.scriptParsed / scriptFailedToParse; no breakpoint is ever set and pauses are skipped),
  // bounded by SCRIPT_PARSE_MS wall (a preloaded script nobody runs yet, a worker script: counted in the stats)
  // (the first response of a URL only: a module is compiled once however often it is fetched or imported)
  const parse = gate ? { want: new Map(), credit: new Map(), seen: new Set(), waited: 0, expired: 0 } : null;
  if (parse) {
    const parsed = (e) => { const u = e && e.url; if (!u) return; const q = parse.want.get(u); if (q && q.length) { q.shift(); if (!q.length) parse.want.delete(u); } else parse.credit.set(u, (parse.credit.get(u) || 0) + 1); };
    S.cdp.on('Debugger.scriptParsed', parsed); S.cdp.on('Debugger.scriptFailedToParse', parsed);
    S.page.on('requestfinished', (r) => {
      try {
        if (r.resourceType() !== 'script' || r.frame() !== S.page.mainFrame()) return;
        const u = r.url(); if (parse.seen.has(u)) return; parse.seen.add(u); const c = parse.credit.get(u) || 0;
        if (c > 0) { if (c > 1) parse.credit.set(u, c - 1); else parse.credit.delete(u); return; }
        if (!parse.want.has(u)) parse.want.set(u, []); parse.want.get(u).push(Date.now()); parse.waited++;
      } catch { /* closed */ }
    });
    try { await S.cdp.send('Debugger.enable'); await S.cdp.send('Debugger.setSkipAllPauses', { skip: true }); } catch (e) { await h.close(); throw e; }
  }
  const scriptsPending = () => {
    if (!parse || !parse.want.size) return 0;
    const now = Date.now(); let n = 0;
    for (const [u, q] of parse.want) { while (q.length && now - q[0] >= SCRIPT_PARSE_MS) { q.shift(); parse.expired++; } if (!q.length) parse.want.delete(u); else n += q.length; }
    return n;
  };
  // a frame inside the page is not stepped, so its data requests cannot change the page's virtual time: they count only up
  // to maxMs (a colour widget's fetch inside an iframe on a large marketing site never answers, and held every take for 30 s). What a
  // frame needs to load (its document, scripts, styles, images) still counts: the page's load event waits for those.
  const capOf = (e) => (e.resp == null ? (NET_WAITED.has(e.type) && !(e.sub && (e.type === 'fetch' || e.type === 'xhr')) ? gate.longMs : gate.maxMs) : (NET_BODY_WAITED.has(e.type) ? gate.longMs : gate.maxMs));
  const inFlight = () => {
    const now = Date.now(); let n = 0;
    for (const [r, e] of gate.flight) {
      if (o.scan && e.sub && frameGone(r)) { gate.flight.delete(r); gate.detached++; continue; }
      if (now - (e.resp ?? e.t) < capOf(e)) n++;
      else { gate.flight.delete(r); gate.expired++; gate.expiredTypes[e.type] = (gate.expiredTypes[e.type] || 0) + 1; }
    }
    return n + (S.net?.own || 0);   // a file read-through is fetching holds the clock whatever its type: only netWait's long bound ends it
  };
  const netWait = async () => {
    if (!gate || S.closed) return;   // (closed: a cancel or a failed navigation; nothing will finish any more)
    if (!inFlight() && !scriptsPending() && gate.done === gate.idleDone) return;
    const w0 = Date.now(); gate.waits++;
    // a response is handled by the page after it lands (a module parsed and its imports requested, a font or an image
    // decoded): wait until the page's main thread is idle, and again whenever that idle wait let new requests start,
    // before virtual time runs. Bounded (wall) so a page that never stops loading cannot hold the take forever.
    for (let round = 0; ; round++) {
      while ((inFlight() || scriptsPending()) && Date.now() - w0 <= gate.longMs && !S.closed) await sleep(5);
      const seen = gate.done; const i0 = Date.now();
      const idled = await evRetry((ms) => (window.__WR && window.__WR.idle ? window.__WR.idle(ms) : null), idleBound).catch(() => null);
      gate.idleWaits++; gate.idleMs += Date.now() - i0; if (idled && idled.ok === false) gate.idleHits++;
      if ((!inFlight() && !scriptsPending() && gate.done === seen) || Date.now() - w0 > gate.longMs || S.closed) break;
    }
    gate.idleDone = gate.done;
    const w = Date.now() - w0; gate.waitedMs += w; gate.maxWaitMs = Math.max(gate.maxWaitMs, w);
  };
  S.netInFlight = gate ? inFlight : null;
  S.netGateStats = () => (gate ? { maxMs: gate.maxMs, longMs: gate.longMs, waits: gate.waits, waitedMs: gate.waitedMs, maxWaitMs: gate.maxWaitMs, expired: gate.expired, expiredTypes: gate.expiredTypes, idleWaits: gate.idleWaits, idleMs: gate.idleMs, scripts: { waited: parse.waited, expired: parse.expired }, ...(o.scan ? { idleBoundMs: idleBound, idleHits: gate.idleHits, detached: gate.detached } : {}) } : null);

  const ev = (fn, arg) => S.page.evaluate(fn, arg);
  // page.evaluate that survives navigations during boot
  const evRetry = async (fn, arg, tries = 100) => {
    for (let i = 0; ; i++) {
      try { return await ev(fn, arg); } catch (e) {
        if (i >= tries || !/context|navigat|Execution|__WR|not defined|Target closed/i.test(e.message)) throw e;
        await sleep(30);
      }
    }
  };
  S.ev = ev; S.evRetry = evRetry;

  S.goto = async (url, waitUntil = lane === 'hx' ? 'commit' : 'load') => {
    const u = url || o.url || (o.target && (o.target.recordUrl || o.target.startUrl));
    const r = await S.page.goto(u, { waitUntil, timeout: 60000 });
    S.url = u; S.docStatus = r && r.status();
    return r;
  };

  let pending = 0;
  const drainEvery = 200;
  // streamed take: its rows and mutations wait in a temp folder until writeTake stores them next to take.json
  const spoolDir = o.streamRows ? fs.mkdtempSync(path.join(os.tmpdir(), 'reva-rows-')) : null;
  const spool = spoolDir ? { rows: new Spool(path.join(spoolDir, 'rows'), JSON.stringify(DELTA_HEADER)), mut: new Spool(path.join(spoolDir, 'mutations')) } : null;
  const dropSpool = () => { if (spool) { spool.rows.close(); spool.mut.close(); fs.rmSync(spoolDir, { recursive: true, force: true }); } };
  if (spool) S.data.spool = spool;
  const decodeRow = rowDecoder();
  const tee = o.rowTee ? { hash: crypto.createHash('sha256'), n: 0 } : null;
  S.teeResult = () => (tee ? { digest: tee.hash.copy().digest('hex'), n: tee.n } : null);
  S.drain = async () => {
    const d = await evRetry((wantTee) => { const W = window.__WR; W.discover(); const o = W.drain(['births', 'wheel', 'declared', ...(wantTee ? ['teeRows'] : [])]); o.rows = W.drainRows(); o.mut = W.stringify(W.mut); W.mut.length = 0; W._mutSeen = 0; return o; }, !!tee);
    for (const w of JSON.parse(d.rows)) {
      if (spool) { spool.rows.line(JSON.stringify(w)); S.data.rows.push({ k: w.k, T: w.T, sy: w.sy, sx: w.sx }); } else S.data.rows.push(decodeRow(w));
    }
    for (const m of JSON.parse(d.mut)) { if (spool) spool.mut.line(JSON.stringify(m)); else S.data.mut.push(m); }
    // (one push per element: a spread of a long list overflows the call stack)
    for (const k of ['births', 'wheel', 'declared']) for (const x of d[k]) S.data[k].push(x);
    if (tee) for (const r of d.teeRows) { tee.hash.update(JSON.stringify(r) + '\n'); tee.n++; }
    if (S.workers?.list.length) await S.workers.drain();
    pending = 0;
  };

  /** hx: n virtual frames (each: timers, pin, rAF, pin, real settle, post-pin, sample). rt: n real frames (approx). */
  S.step = async (n = 1, { sample = true, batch = 1 } = {}) => {
    if (lane === 'rt') { await sleep(n * dt); return; }
    let left = n;
    while (left > 0) {
      // the gate is checked between page calls only: while the network is active, one frame per call, so a request
      // started inside a batch cannot see a load-dependent number of frames pass before it is waited for
      await netWait();
      const m = Math.min(left, gate && stepsDone - gate.lastAct < NET_QUIET_FRAMES ? 1 : batch);
      const w0 = Date.now();
      const kNow = await evRetry(([m, s]) => window.__WR.steps(m, s), [m, sample]);
      if (S.workers?.list.length) await S.workers.step(kNow);
      S.stepWall.push((Date.now() - w0) / m);
      left -= m; pending += m; stepsDone += m;
      if (pending >= drainEvery) await S.drain();
    }
  };
  S.hold = async (ms, opt = {}) => {
    if (lane === 'rt') { await sleep(ms); return; }
    await S.step(Math.round(ms / dt), { batch: 8, ...opt });
  };
  /** Boot: hx steps until `until` (page expression) is true; rt waits in real time. */
  S.boot = async ({ until = 'document.readyState === "complete"', maxMs = 30000, maxVirtualMs = Infinity, thenMs = 0 } = {}) => {
    const t0 = Date.now();
    let ok = false, frames = 0;
    if (lane === 'hx') {
      while (!ok) {
        await S.step(4, { sample: o.sampleBoot !== false });
        frames += 4;
        ok = await evRetry((u) => !!(0, eval)(u), until);
        // maxVirtualMs: a bound in page time (the network gate holds it while the page loads, so it does not run out sooner
        // on a busy machine or a slow server); maxMs stays the wall safety net
        if (!ok && (Date.now() - t0 > maxMs || frames * dt > maxVirtualMs)) throw new FatalRecorderError(`boot watchdog: "${until}" not true after ${frames * dt > maxVirtualMs ? `${Math.round(frames * dt)} ms of page time` : `${maxMs} ms wall`} (${frames} frames)`);
      }
    } else {
      while (!ok) {
        ok = await evRetry((u) => !!(0, eval)(u), until).catch(() => false);
        if (!ok) { if (Date.now() - t0 > maxMs) throw new FatalRecorderError(`boot watchdog: "${until}" not true after ${maxMs} ms`); await sleep(50); }
      }
    }
    S.bootWallMs = Date.now() - t0; S.bootFrames = frames;
    if (thenMs) await S.hold(thenMs);
    await S.mark('boot-done');
  };
  S.mark = async (name, extra) => {
    const m = await evRetry(([name, extra]) => { const W = window.__WR; const r = { name, k: W.frameKey(), T: performance.now(), sy: scrollY, extra }; W.marks.push(r); return r; }, [name, extra ?? null]);
    S.marks.push(m); return m;
  };
  /**
   * Discovery pass only (PLAN M1 item 5): CDP Animation domain on, collect animationStarted events, then off.
   * Left on for a whole take it caused 50-317 ms gaps (S2 §2), so takes never keep it enabled.
   */
  S.cdpDiscovery = async (fn) => {
    const onStart = (e) => { const a = e.animation; S.data.cdpAnimations.push({ id: a.id, name: a.name, type: a.type, playState: a.playState, startTime: a.startTime,
      source: a.source && { duration: a.source.duration, delay: a.source.delay, easing: a.source.easing, iterations: a.source.iterations, keyframesRule: a.source.keyframesRule && a.source.keyframesRule.name }, provenance: 'declared' }); };
    S.cdp.on('Animation.animationStarted', onStart);
    await S.cdp.send('Animation.enable');
    try { await fn(); } finally { await S.cdp.send('Animation.disable'); S.cdp.off('Animation.animationStarted', onStart); }
    return S.data.cdpAnimations.length;
  };
  S.watch = async (selectors) => evRetry((s) => window.__WR.watchSelectors(s), selectors);
  /** Aim mode: from now on every element matching the aim selectors is watched (until now: only once it starts to move). */
  S.aimOn = async () => evRetry(() => { window.__WR.aimOn = true; });
  /** Aim mode: ids of every element that matched an aim selector so far (watched or not). */
  S.aimIds = async () => evRetry(() => [...(window.__WR.aimIds || [])]);
  S.snapshotDeclared = async (label) => evRetry((l) => window.__WR.snapshotDeclared(l), label);
  S.setSampling = async (on) => evRetry((v) => { window.__WR.sampling = v; }, on);
  // Scan (o.scan): one test's control window, then its parts. controlStart..controlStop learns what moves with nothing touched;
  // controlClear ends the test. partStart comes right before an input: W.quiet counts frames and virtual timers from there.
  S.controlStart = async () => evRetry(() => window.__WR.controlStart());
  S.controlStop = async () => evRetry(() => window.__WR.controlStop());
  S.controlClear = async () => evRetry(() => window.__WR.controlClear());
  S.partStart = async () => evRetry(() => window.__WR.partStart());
  S.quiet = async (n) => evRetry((n) => window.__WR.quiet(n), n);
  S.clearSamples = async () => {
    await S.drain(); S.data.rows = [];
    if (spool) spool.rows.clear();
    if (tee) { tee.hash = crypto.createHash('sha256'); tee.n = 0; }
    await evRetry(() => window.__WR.rowsReset());   // what comes next has no row before it
  };

  /** hx: run the real settle for an input just given, at the current virtual time (A2; see W.flush). rt: no-op. */
  S.settleInput = async () => { if (lane === 'hx') await evRetry(() => window.__WR.flush()); };
  /** Instant scrollTo with read-back; FATAL if it lands more than 4 px off (PLAN M1 item 6). */
  S.scrollTo = async (y, { tolerance = 4 } = {}) => {
    const r = await evRetry((y) => {
      const max = document.documentElement.scrollHeight - innerHeight;
      scrollTo({ top: y, left: scrollX, behavior: 'instant' });
      const r = { want: y, got: scrollY, max, T: performance.now(), k: window.__WR.frameKey() };
      // hx: dispatch the scroll event (and IO callbacks) now, at the current virtual time (A2, W.flush)
      if (window.__WR.flush) return window.__WR.flush().then(() => r);
      return r;
    }, y);
    const expected = Math.min(y, Math.max(0, r.max));
    r.offPx = Math.abs(r.got - expected);
    S.inputLog.push({ type: 'scrollTo', ...r });
    if (r.offPx > tolerance) throw new FatalRecorderError(`scrollTo(${y}) landed at ${r.got} (${r.offPx} px off, max ${r.max})`);
    return r;
  };
  /** Grid pass: positions from..to by step, hold each; birth/declared snapshots after each landing. */
  S.sweep = async ({ from = 0, to, step = 300, holdMs = 350, snapshot = true, both = false } = {}) => {
    const ys = []; for (let y = from; y <= to; y += step) ys.push(y);
    if (ys[ys.length - 1] !== to) ys.push(to);
    const seq = both ? [...ys, ...ys.slice(0, -1).reverse()] : ys;
    const landings = [];
    for (const y of seq) {
      const r = await S.scrollTo(y); await S.mark('sweep', { y, i: landings.length }); landings.push(r);
      await S.hold(holdMs);
      if (snapshot) await S.snapshotDeclared('sweep@' + y);
    }
    return landings;
  };
  /** Dense sweep: <= 10 px per frame, both directions (PLAN M1 item 6). */
  S.denseSweep = async ({ from = 0, to, px = 10, framesPerPos = 1 } = {}) => {
    if (px > 10) throw new Error('dense sweep step must be <= 10 px');
    const ys = []; for (let y = from; y <= to; y += px) ys.push(y);
    for (const y of [...ys, ...ys.slice(0, -1).reverse()]) { await S.scrollTo(y); await S.step(framesPerPos); }
  };
  // Pointer input (corpus scenarios, B5): one CDP mouse event, logged like a wheel step (hx: frame key + virtual time,
  // then one frame). Targets are CSS selectors resolved at the moment of input (the first match that has a size: the first node of a generated list can be an empty template); a missing target is logged, not thrown.
  const mouse = async (type, x, y, extra = {}) => {
    await S.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: extra.button || 'none', clickCount: extra.clickCount || 0, buttons: extra.buttons || 0 });
    if (lane === 'hx') {
      const kt = await evRetry(() => window.__WR.flush().then(() => ({ k: window.__WR.V.k, T: performance.now() })));
      S.inputLog.push({ type: 'pointer', kind: type, x, y, k: kt.k, T: kt.T }); await S.step(1);
    } else S.inputLog.push({ type: 'pointer', kind: type, x, y, wallMs: Date.now() - wallT0 });
  };
  // which match of a selector the pointer goes to: the first one that is shown and can be hit where it lands once scrolled
  // into view (a skip link parked off screen, a hidden duplicate, a copy under an overlay are passed over); else the first
  // shown one, else the first with a size, else the first match. `pick` is the index chosen among the matches.
  const centre = sel => evRetry((q) => {
    const auto = /^auto:(\d+)$/.exec(q);
    const sized = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const shown = (e) => { try { if (e.checkVisibility && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false; } catch (x) { /* old engine */ } const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const hits = (e) => { const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false; const h = document.elementFromPoint(x, y); return !!h && (h === e || e.contains(h)); };
    const sx = scrollX, sy = scrollY;
    let el = null, pick = 0;
    if (auto) el = [...document.querySelectorAll('a[href],button,[role=button],summary,input[type=submit]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; })[+auto[1] - 1];
    else {
      const all = [...document.querySelectorAll(q)];
      const cand = all.filter(sized).slice(0, 40);
      let firstShown = null;
      for (const e of cand) {
        if (!shown(e)) continue; if (!firstShown) firstShown = e;
        if (cand.length === 1) { el = e; break; }
        e.scrollIntoView({ block: 'center', behavior: 'instant' });
        if (hits(e)) { el = e; break; }
      }
      if (!el) { scrollTo({ left: sx, top: sy, behavior: 'instant' }); el = firstShown || cand[0] || all[0] || null; }
      pick = el ? all.indexOf(el) : 0;
    }
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), scrolled: scrollX !== sx || scrollY !== sy, pick } : { zero: true };
  }, sel);
  /** Where match `pick` of the selector is now (no scrolling); null when gone. */
  const centreAt = (q, pick) => evRetry(([q, i]) => { const el = document.querySelectorAll(q)[i] || document.querySelector(q); if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; }, [q, pick || 0]);
  // an element with no size yet (a bar that grows with the scroll it was just scrolled into view by) gets up to 4 x 250 ms to grow
  // pin-aware: a pinned scene moves its content on the scroll event after the jump, so the element can sit elsewhere (or off
  // screen) a few frames later; it is brought back to the middle of the viewport, up to 3 times
  const centreSized = async (target) => {
    let c = await centre(target); let scrolled = !!(c && c.scrolled);
    for (let i = 0; c && c.zero && i < 4; i++) { await S.hold(250); c = await centre(target); scrolled = scrolled || !!(c && c.scrolled); }
    if (!c || c.zero) return null;
    if (scrolled && !/^auto:\d+$/.test(target) && lane === 'hx') {
      for (let i = 0; i < 3; i++) {
        await S.hold(4 * dt);
        const n = await centreAt(target, c.pick); if (!n) break;
        const vs = S.page.viewportSize() || { width: 1440, height: 900 };
        if (n.x >= 0 && n.y >= 0 && n.x < vs.width && n.y < vs.height) { c = { ...c, x: n.x, y: n.y }; break; }
        await evRetry((d) => scrollBy({ top: d, left: 0, behavior: 'instant' }), n.y - (vs.height >> 1));
      }
    }
    return { ...c, scrolled };
  };
  // the recorder's own scroll-into-view and the pointer input must not land in one frame: a scroll-linked element (a
  // progress bar) that jumps with that scroll would read as reacting to the pointer. SCROLL_GAP frames (more than the
  // 2-frame lead window of the driver attribution, src/analysis/fit/attribution.js) separate the two
  const SCROLL_GAP = 4;
  // the raw parts of hover and click, for a recorder that takes a picture of every frame between them (src/scan/patterns.js)
  S.mouse = mouse; S.locate = centreSized;
  /** Scan: the pointer walks sweepPoint over the viewport, one move per frame (a canvas listening on window is no hover target), then parks. */
  S.pointerSweep = async ({ frames = 180, park = [2, 2], onStep = null } = {}) => {
    const vs = S.page.viewportSize() || { width: 1440, height: 900 };
    for (let i = 0; i < frames; i++) { const p = sweepPoint(i, frames, vs.width, vs.height); await mouse('mouseMoved', p.x, p.y); if (onStep) await onStep(i); }
    await mouse('mouseMoved', park[0], park[1]);
  };
  S.hover = async (a) => {
    const { target, inMs = 800, outMs = 800 } = typeof a === 'string' ? { target: a } : a;
    const c = await centreSized(target);
    if (!c) { S.inputLog.push({ type: 'pointer', kind: 'missing', target }); return; }
    S.lastPick = { target, pick: c.pick || 0 };
    if (c.scrolled) await S.hold(SCROLL_GAP * dt);
    await mouse('mouseMoved', c.x, c.y); await S.hold(inMs);
    await mouse('mouseMoved', 2, 2); await S.hold(outMs);
  };
  /** Pointer to a viewport point (no element): one mouse move, logged like hover's; {click:true} also presses there. */
  S.pointer = async (x, y, { click = false, hoverMs = 0, pressMs = 0 } = {}) => {
    const px = Math.round(x), py = Math.round(y);
    await mouse('mouseMoved', px, py);
    if (click) {
      if (hoverMs) await S.hold(hoverMs);
      await mouse('mousePressed', px, py, { button: 'left', clickCount: 1, buttons: 1 });
      if (pressMs) await S.hold(pressMs);
      await mouse('mouseReleased', px, py, { button: 'left', clickCount: 1 });
    }
  };
  /** Where the target is now, without scrolling (null when gone): the click point can drift while the page is still smoothing. */
  const centreNow = (q, pick) => centreAt(q, pick);
  /** True while the target or something inside it has a finite CSS transition / animation / WAAPI animation running. */
  const busyOn = (q) => evRetry((q) => { const el = document.querySelector(q); if (!el) return false; try { return el.getAnimations({ subtree: true }).some((a) => { if (a.playState !== 'running') return false; const t = a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming(); return !!t && Number.isFinite(t.endTime) && t.endTime > 0 && t.iterations !== Infinity; }); } catch (e) { return false; } }, q);
  /**
   * A click is hover -> press -> release. hoverMs: the pointer rests on the target that long before the press (and, with
   * quiet, until the transitions on the target have ended, at most quietMaxMs), so the press starts from rest; pressMs: the
   * button stays down that long (a :active / pointerdown tween plays out before the release fires the click). The point is
   * read again before the press: a page still smoothing a scroll moves the target away from where it was found.
   */
  S.click = async (a) => {
    const { target, holdMs = 0, hoverMs = 0, pressMs = 0, quiet = false, quietPress = quiet, quietMaxMs = 2500 } = typeof a === 'string' ? { target: a } : a;
    let c = await centreSized(target);
    if (!c) { S.inputLog.push({ type: 'pointer', kind: 'missing', target }); return; }
    // which match of the selector was clicked (look tries the other matches when this one does not react)
    S.lastPick = { target, pick: c.pick || 0 };
    if (c.scrolled) await S.hold(SCROLL_GAP * dt);
    await mouse('mouseMoved', c.x, c.y);
    if (hoverMs) await S.hold(hoverMs);
    if (quiet && !/^auto:\d+$/.test(target)) { for (let t = hoverMs; t < quietMaxMs && await busyOn(target); t += 100) await S.hold(100); }
    if (!/^auto:\d+$/.test(target)) {
      for (let i = 0; i < 8; i++) {
        const n = await centreNow(target, c.pick);
        if (!n || (Math.abs(n.x - c.x) <= 1 && Math.abs(n.y - c.y) <= 1)) break;
        c = { ...c, x: n.x, y: n.y }; await mouse('mouseMoved', c.x, c.y); await S.hold(100);
      }
    }
    await mouse('mousePressed', c.x, c.y, { button: 'left', clickCount: 1, buttons: 1 });
    if (pressMs) await S.hold(pressMs);
    if (quietPress && !/^auto:\d+$/.test(target)) { for (let t = pressMs; t < quietMaxMs && await busyOn(target); t += 100) await S.hold(100); }
    await mouse('mouseReleased', c.x, c.y, { button: 'left', clickCount: 1 });
    if (holdMs) await S.hold(holdMs);
  };
  /**
   * Pipelined wheel: CDP mouseWheel events dispatched on a fixed schedule WITHOUT awaiting each one (rt), or one per
   * virtual frame (hx). The page-side log records defaultPrevented per event.
   */
  /**
   * stall (hx only): the driver gets past gesture snapping and scroll locks that hold input back. When scrollY has not
   * moved for `wheels` wheels in a row, the wheel pauses (no input) for at least `pauseMs` of virtual time and until the
   * page rests (scrollY still for `restMs`, at most `maxPauseMs`), then goes on: a snapping page ends a gesture only once
   * the input has been quiet, and the next lane needs a new gesture. The wheel stops at the bottom of the page (scrollY at
   * the end for `wheels` wheels), after `maxPauses` pauses in a row that brought no progress, or when `until` says so.
   * S.wheelStop says why it stopped ('until' | 'bottom' | 'stalled' | null); S.wheelPauses lists the pauses.
   */
  S.wheel = async ({ dy = 10, n = 100, intervalMs = dt, x, y, until = null, stall = null, onStep = null } = {}) => {
    const vs = S.page.viewportSize() || { width: 800, height: 600 };
    const px = x ?? (vs.width >> 1), py = y ?? (vs.height >> 1);
    await evRetry(() => { window.__WR.inputMute = true; });
    await S.page.mouse.move(px, py);
    await S.settleInput();
    await evRetry(() => { window.__WR.inputMute = false; });
    const send = () => S.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: px, y: py, deltaX: 0, deltaY: dy });
    const t0 = Date.now(); const sends = [];
    const startY = await evRetry(() => scrollY);
    S.wheelStoppedAt = 0; S.wheelStop = null; S.wheelPauses = []; S.wheelVirtual = false;
    const st = stall && lane === 'hx' ? { wheels: stall.wheels ?? 6, pauseMs: stall.pauseMs ?? 450, restMs: stall.restMs ?? 120, maxPauseMs: stall.maxPauseMs ?? 3000, maxPauses: stall.maxPauses ?? 3 } : null;
    if (lane === 'hx') {
      // X2: k = the frame after which the wheel landed (same key as the page-side wheel log), T = virtual time then
      // `until` (hx only): a page expression read after each wheel lands; true stops the wheel early (look: the aimed
      // element has left the viewport)
      let lastY = startY, same = 0, atEnd = 0, moved = false, fruitless = 0, yPause = null;
      for (let i = 0; i < n; i++) {
        await send();
        const kt = await evRetry((u) => window.__WR.flush().then(() => ({ k: window.__WR.V.k, T: performance.now(), stop: u ? !!(0, eval)(u) : false, y: scrollY, max: document.documentElement.scrollHeight - innerHeight })), until);
        S.inputLog.push({ type: 'wheel', i, dy, k: kt.k, T: kt.T }); await S.step(1);
        if (onStep) await onStep(kt.y);   // between two frames: the virtual clock stands still here
        if (kt.stop) { S.wheelStoppedAt = i + 1; S.wheelStop = 'until'; break; }
        if (!st) continue;
        if (Math.abs(kt.y - lastY) >= 0.5) { moved = true; same = 0; } else same++;
        lastY = kt.y;
        // the bottom: nothing further to scroll to
        if (dy > 0 ? kt.y >= kt.max - 2 : kt.y <= 1) { if (moved && ++atEnd >= st.wheels) { S.wheelStoppedAt = i + 1; S.wheelStop = 'bottom'; break; } continue; }
        atEnd = 0;
        if (same < st.wheels) continue;
        // scrollY has never moved: one pause (a snapper may hold the very first gesture); if scrollY still has not moved
        // after it, the page scrolls without scrollY (a virtual scroller: wheel prevented, content translated), so the
        // stall rule is off for the rest of the wheel and only `until` or n stops it
        if (!moved && S.wheelPauses.length) { st.off = true; S.wheelVirtual = true; }
        if (st.off) { same = 0; continue; }
        // stalled short of the bottom: a pause that brought no progress since the last one counts against maxPauses
        if (yPause != null && Math.abs(kt.y - yPause) < 2) fruitless++; else fruitless = 0;
        if (fruitless >= st.maxPauses) { S.wheelStoppedAt = i + 1; S.wheelStop = 'stalled'; break; }
        yPause = kt.y;
        const T0 = kt.T; let still = 0, prev = kt.y, Tn = T0;
        for (;;) {
          await S.step(6, { batch: 6 });
          const r = await evRetry(() => ({ y: scrollY, T: performance.now() }));
          still = Math.abs(r.y - prev) < 0.5 ? still + 6 * dt : 0; prev = r.y; Tn = r.T;
          if ((Tn - T0 >= st.pauseMs && still >= st.restMs) || Tn - T0 >= st.maxPauseMs) break;
        }
        S.wheelPauses.push({ atWheel: i + 1, y: Math.round(kt.y), ms: Math.round(Tn - T0) });
        if (Math.abs(prev - kt.y) >= 0.5) moved = true;
        same = 0; lastY = prev;
      }
    } else {
      for (let i = 0; i < n; i++) {
        sends.push(send().catch(e => S.errors.push('wheel: ' + e.message)));
        S.inputLog.push({ type: 'wheel', i, dy, wallMs: Date.now() - t0 });
        const wait = t0 + (i + 1) * intervalMs - Date.now(); if (wait > 0) await sleep(wait);
      }
      await Promise.all(sends);
    }
    return { startY, sentMs: Date.now() - t0, sent: S.wheelStoppedAt || n, stoppedEarly: !!S.wheelStoppedAt, stop: S.wheelStop, pauses: S.wheelPauses, ...(S.wheelVirtual ? { virtual: true } : {}) };
  };

  /** Finish: collect everything, close the browser (always), write the take. */
  S.finish = async ({ scenario = 'adhoc', target = o.target ? o.target.id : 'fixture', extra = {}, write = true } = {}) => {
    let tail = {};
    S.finishing = true;
    try {
      if (spool && !write) throw new Error('a streamed take lives on disk: finish it with write: true');
      await S.drain();
      tail = await evRetry(() => {
        const W = window.__WR;
        let gl = null; try { gl = W.glInfo ? W.glInfo() : null; if (gl && W.glBuffers) gl.bufferStore = W.glBuffers(); } catch (e) { gl = { error: String(e && e.message).slice(0, 200) }; }
        return { pageInputs: W.inputs || [], pix: window.__WR_PIX ? window.__WR_PIX.status() : null, gl, c: W.c, errors: W.errors, escapes: W.escapes, els: W.elDescs(0), watch: [...W.watch].map(([id, w]) => [id, w.why]), selectors: W.selectors([...W.watch.keys()]),
          rtDt: W.rtDt || null, marks: W.marks, env: { innerWidth, innerHeight, dpr: devicePixelRatio, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference',
            colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
            ua: navigator.userAgent, docUrl: location.href, readback: W.readbackFloor() } };
      });
      // a worker's WebGL joins the page's: its contexts (the canvas it was given, by transfer order), its programs (ids from 1001), its rows
      if (S.workers?.list.length && !(tail.gl && tail.gl.error)) {
        try {
          const ws = await S.workers.finish(), gl = tail.gl || (tail.gl = { contexts: [], programs: [], counters: {} }), xfer = [...(gl.transferred || [])];
          for (const w of ws) for (const c of w.contexts || []) { const t = xfer.shift() || null; gl.contexts.push({ id: c.id, webgl2: c.webgl2, el: t ? t.el : null, offscreen: true, worker: w.index, width: c.width, height: c.height }); }
          for (const w of ws) for (const p of w.programs || []) gl.programs.push(p);
          gl.workers = ws.map(({ contexts, programs, ...w }) => ({ ...w, contexts: (contexts || []).length, programs: (programs || []).length }));
          tail.glWorkerRows = S.workers.rows;
        } catch (e) { if (tail.gl) tail.gl.workers = [{ error: String(e.message).slice(0, 200) }]; }
      }
      if (o.target && o.target.archive) {
        try { tail.buildId = JSON.parse(fs.readFileSync(path.join(o.target.archive, 'version.json'), 'utf8')).version; } catch {}
      }
    } finally { await S.close(); }
    // the scheme the page matched is kept only on a take that asked for one (take.json stays as before without --color-scheme)
    if (tail.env && !ctxOpts.colorScheme) delete tail.env.colorScheme;
    // the page can replace window.__WR.desc: descriptors are stripped of terminal escapes / bidi overrides again here
    if (Array.isArray(tail.els)) tail.els = tail.els.map((d) => (d == null ? d : stripControls(d)));
    // selectors keep matching: a control or bidi character CSS.escape left raw (C1, U+2028/9, U+202A-E, U+2066-9) becomes a CSS hex escape
    if (Array.isArray(tail.selectors)) tail.selectors = tail.selectors.map((r) => (Array.isArray(r) && typeof r[1] === 'string' ? [r[0], r[1].replace(CONTROL_CHARS, (c) => `\\${c.codePointAt(0).toString(16)} `), ...r.slice(2)] : r));
    // page-observed pointer/click events join the input log (driver entries first, then by frame key); X2/X3
    const inputLog = [...S.inputLog, ...(tail.pageInputs || [])].map((e, i) => [e, i]).sort((a, b) => ((a[0].k ?? -1) - (b[0].k ?? -1)) || a[1] - b[1]).map(([e]) => e);
    delete tail.pageInputs;
    const take = {
      scenario, target, lane, rate, dt, cfg, started: started.toISOString(), wallMs: Date.now() - wallT0,
      browser: { engine, version: h.version, product: S.browserInfo.product, protocolVersion: S.browserInfo.protocolVersion, revision: S.browserInfo.revision,
        toolkit: h.toolkit, playwright: h.playwrightVersion, executablePath: h.executablePath, args: h.args, ...(h.pooled ? { pooled: true } : {}) },
      context: ctxOpts, net: { misses: o.target ? S.net.misses.length : null, missList: o.target ? S.net.misses.slice(0, 20) : null, blocked: S.net.blocked.length, docStatus: S.docStatus, url: S.url },
      host: { platform: process.platform, release: os.release(), node: process.versions.node, loadavg: os.loadavg(), cpus: os.cpus().length },
      inputLog, stepWall: S.stepWall, bootWallMs: S.bootWallMs, bootFrames: S.bootFrames,
      pageErrors: S.errors, ...tail, data: S.data,
      extra: keepalive ? { ...extra, frameClock: { keepalive: true, args: KEEPALIVE_ARGS, note: 'real-frame keepalive (src/record/keepalive.js)' } } : extra,
    };
    if (!write) return { take };
    try {
      const dir = writeTake(take, o.writeDir ? { root: o.writeDir } : {});
      return { take, dir };
    } finally { dropSpool(); delete S.data.spool; }
  };
  S.close = async () => {
    if (S.closed) return;
    S.closed = true; S.stopWatch?.();
    if (!S.finishing) dropSpool();
    await h.close();
  };
  return S;
}

/** Run fn(session) and always close the browser. */
export async function withSession(o, fn) {
  const s = await openSession(o);
  try { return await fn(s); } finally { await s.close(); }
}
