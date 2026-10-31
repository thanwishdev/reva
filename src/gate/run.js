// Design-capture verification gate (stage G). Built before the capture so later stages are scored against it.
// Flow per site:
//   orig1, orig2, orig3 = three identical replays of the original (JS on, fixed clock) at every test point
//   noise  = orig2 vs orig1 (sets the pixel cap per point)        identity = orig3 vs orig1 (must pass)
//   subject = a rebuild artifact per viewport class (scripts blocked by CSP, routed at the original URL) vs orig1
//   audit   = source audit of each subject artifact              mutants = N corrupted copies, each must fail
// Capture (browser) and compare (pure) are separate: snapshots + screenshots are cached per run and point.
import { spinGuardSource } from '../util/spinguard.js';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { launchBrowser } from '../browser/launch.js';
import { OFFLINE_ARGS, harPaths, seedScript } from '../replay/target.js';
import { wireReplay } from '../replay/replay.js';
import { takeSnapshot, freezeMedia, expandStyles, internStyles } from './snapshot.js';
export { freezeMedia };
import { compareSnapshots } from './compare.js';
import { applyNest } from './rebuild.js';
import { diffPng, pixelVerdict } from './pixels.js';
import { computedDump } from './dump.js';
import { writeJsonFile } from '../util/jsonfile.js';
import { inPageSources, auditSources } from './audit.js';
import { scriptWriteRecorder, collectWrites, ownedRects, isOwned, loadedImages, topLayerNow } from './scriptowned.js';
import { runtimeStateRecorder } from './runtimestate.js';
import { inSlot } from './limit.js';
import { PoolSet, poolsEnabled } from '../browser/pool.js';

// Raster stays on the CPU: GPU raster gave 2 different PNGs in 8 identical loads (rounded-corner anti-aliasing), and
// on Chrome 147 it still fails the capture fixture's same-session check. WebGL runs on the GPU (Metal): with the GPU
// fully off it fell back to SwiftShader (23 fps vs 120 fps on a WebGL page, PNG capture 134 vs 56 ms per frame), and a
// heavy WebGL site's capture went from a 45-min timeout to 21 min, with identity and same-session checks still passing.
// WR_GATE_CPU=1 restores the old all-CPU mode (--disable-gpu).
export const GATE_ARGS = [...OFFLINE_ARGS, '--force-color-profile=srgb', '--hide-scrollbars', ...(process.env.WR_GATE_CPU === '1' ? ['--disable-gpu'] : ['--disable-gpu-rasterization']), ...(process.env.WR_GATE_ARGS ? process.env.WR_GATE_ARGS.split(' ') : [])];
/** A PoolSet whose browsers carry the gate's launch args (see src/browser/pool.js). */
export const newGatePools = (opts = {}) => new PoolSet({ args: GATE_ARGS, ...opts });
export const NO_SCRIPT_CSP = "script-src 'none'";
export const FIXED_TIME = Date.parse('2026-10-12T03:00:00Z');
const PAUSE_AT = FIXED_TIME + 300000;

/** Pause the Playwright fake clock at an ABSOLUTE time. pauseAt() is a fast-forward and throws "Cannot fast-forward to the
 *  past" when the clock is already beyond the target: (a) install -> pauseAt with a stall of more than the 1 s head start
 *  (machine overload, measured load ~85), (b) a load/settle/sweep that advanced the virtual clock past FIXED_TIME + 300 s.
 *  Playwright pauses the clock BEFORE it throws, so the clock is already paused; this helper swallows only that error.
 *  mode 'set': also put the paused clock's Date back at `time` (the install case, so Date.now() at load is the same for
 *  every replay); 'keep': stay at the later time (every replay advances identically, so they still agree). Returns
 *  ms the clock was late by (0 = on time). */
export async function pauseClockAt(page, time, mode = 'keep', net = null) {
  try { await page.clock.pauseAt(time); return 0; }
  catch (e) {
    if (await pageTimerError(page, e, net)) return 0; // pauseAt ran its timers and paused at `time` before rethrowing
    if (!/fast-forward to the past/.test(String(e && e.message))) throw e;
    const now = await page.evaluate(() => Date.now());
    if (mode === 'set') await page.clock.setSystemTime(time);
    return Math.max(0, now - time);
  }
}
// D-CORPUS-1: the gate replays NORMAL motion (`prefers-reduced-motion: no-preference`, as freeze and motion record);
// reduced motion stays available as an explicit option (site.reducedMotion, or WR_GATE_REDUCED_MOTION=reduce).
export const GATE_REDUCED_MOTION = 'no-preference';
export const reducedMotionOf = site => site?.reducedMotion || process.env.WR_GATE_REDUCED_MOTION || GATE_REDUCED_MOTION;
const nodeSleep = ms => new Promise(r => setTimeout(r, ms)); // Node side; only as a safety cap or a condition poll

/* Determinism (corpus S2). A replay is a function of the archive only when every clock the page can see is the
 * harness's:
 *  - script time: Playwright's fake clock is installed PAUSED before navigation. Measured: installed but not paused,
 *    it flows at real pace, so a 10 ms setInterval had fired 50 times after a 500 ms wait, i.e. timer/rAF-driven
 *    state depended on how long the load and the sweep took. Paused, it moves only by advance() (fixed chunks).
 *  - the document timeline (CSS animations, transitions, WAAPI): runs on real frames, not on the fake clock. It is
 *    frozen with CDP Animation.setPlaybackRate(0) before navigation (persists across documents, covers same-origin
 *    iframes); finite animations are then finished at every settle point (rest state) and infinite ones stay at
 *    their start (currentTime 0). Measured: document.timeline.currentTime stays 0, finish() still works.
 *  - media: <video>/<audio> are paused and sought to 0 at every settle point (freezeMedia).
 *  - no fixed real-time sleeps: the harness waits for real rendering FRAMES (scroll/resize events, observers and
 *    lazy loading are delivered by the frame loop) through rAF/setTimeout kept before the clock was faked, and for
 *    the network to be quiet (requests in flight = 0, with a cap), never for a number of milliseconds.
 *  - scrolling is instant (a page with `scroll-behavior: smooth` animated the harness's scrollTo in real time). */
export const REAL_TIMERS = '(() => { if (window.__wrReal) return; window.__wrReal = { raf: window.requestAnimationFrame.bind(window), st: window.setTimeout.bind(window) }; })();';

/** Init script: Math.random as one seeded stream PER CALL SITE (script URL:line:col of the caller) instead of one
 *  shared stream. The archive replay seeds one global PRNG (replay seedScript), but which module draws first depends
 *  on the order chunks arrive and run, so the same call site got other values on another load. Measured on a corpus
 *  site (two identical replays, class A): 3369 vs 3063 draws over 24 call sites, the shared sequence diverged at
 *  draw 724 (another chunk's draw came first), and 1x1 decorative dots got other positions in each replay. Per call
 *  site, a module's n-th draw is the same whatever runs around it. Opt out: WR_GATE_RANDOM=global. */
export function perSiteRandom(seed) {
  const streams = new Map(), lim = Error.stackTraceLimit;
  const h32 = str => { let h = (seed ^ 0x811c9dc5) >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h || 0x9e3779b9; };
  const where = () => { const o = {}; Error.stackTraceLimit = 2; try { Error.captureStackTrace(o, rnd); } finally { Error.stackTraceLimit = lim; } const line = String(o.stack || '').split('\n')[1] || ''; return line.replace(/\?[^:)\s]*/, ''); };
  function rnd() {
    const k = where();
    let st = streams.get(k); if (st === undefined) st = h32(k);
    st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0;
    streams.set(k, st);
    return st / 4294967296;
  }
  Math.random = rnd;
}

/** Wait n real rendering frames (rAF kept before the fake clock). Safety cap 3 s (a page that never paints). */
export async function frames(page, n = 2) {
  const w = page.evaluate(n => new Promise(r => { const R = (window.__wrReal && window.__wrReal.raf) || requestAnimationFrame; let k = 0; const f = () => (++k >= n ? r(k) : R(f)); R(f); }), n).catch(() => 0);
  return Promise.race([w, nodeSleep(3000)]);
}

/** Requests in flight for a page (request -> requestfinished/requestfailed). Long-lived ones (> staleMs) are ignored. */
export function trackNetwork(page) {
  const inflight = new Map();
  page.on('request', r => inflight.set(r, Date.now()));
  page.on('requestfinished', r => inflight.delete(r));
  page.on('requestfailed', r => inflight.delete(r));
  return { stats: { waits: 0, waitedMs: 0, capped: 0 }, pending: (staleMs = 10000) => { const now = Date.now(); let n = 0; for (const t of inflight.values()) if (now - t < staleMs) n++; return n; } };
}

/** Wait until no request is in flight (condition, not a duration), then one frame. capMs bounds a page that never idles. */
export async function networkQuiet(page, net, { capMs = 5000 } = {}) {
  if (!net) return frames(page, 1);
  const t0 = Date.now();
  if (net.pending()) { net.stats.waits++; while (net.pending() && Date.now() - t0 < capMs) await nodeSleep(15); net.stats.waitedMs += Date.now() - t0; if (net.pending()) net.stats.capped++; }
  return frames(page, 1);
}

/** A page's own timer exception, rethrown by Playwright's fake clock (26 Oct, L7 / S16). The clock runs EVERY due timer,
 *  advances to the target and only then rethrows the first exception a page callback threw (playwright-core clock
 *  `_runTo`: `firstException`), so the clock state is complete. In a browser such an exception is only reported and the
 *  page goes on; the harness failed the whole step instead (22-23 Oct deep runs: 6 capture steps, e.g. "clock.runFor:
 *  TypeError: window.updateNavColorFromSections is not a function", "RangeError: Maximum call stack size exceeded").
 *  Pure test: a clock call's error whose text is not a harness/browser failure. */
export function isPageTimerError(e) {
  const m = String(e?.message || e || '');
  return /^clock\.(runFor|pauseAt|fastForward|runAll|runToLast|install|setSystemTime): /.test(m)
    && !/fast-forward to the past|Negative ticks|Target page, context or browser has been closed|Target closed|Browser has been closed|browser has disconnected|Execution context was destroyed|Frame was detached|Protocol error|Timeout \d+ms exceeded/i.test(m);
}
/** Record a page timer error on the flight stats and return true (the replay goes on, the same in every replay), only
 *  when the page still answers; anything else returns false (the caller rethrows). */
export async function pageTimerError(page, e, net) {
  if (!isPageTimerError(e)) return false;
  const alive = await new Promise(res => { const t = setTimeout(() => res(false), 5000); page.evaluate(() => 1).then(() => { clearTimeout(t); res(true); }, () => { clearTimeout(t); res(false); }); });
  if (!alive) return false;
  if (net?.stats) { net.stats.pageTimerErrors = (net.stats.pageTimerErrors || 0) + 1; if (!net.stats.pageTimerError) net.stats.pageTimerError = String(e.message).split('\n')[0].slice(0, 200); }
  return true;
}

/** Advance the paused fake clock by ms in fixed chunks; after each chunk the network settles and one real frame
 *  runs, so what a timer started (a fetch, a lazy chunk, an observer) lands before the next chunk's timers.
 *  A page's own timer exception is recorded, not fatal (pageTimerError). */
export async function advance(page, net, ms, chunk = 250) {
  for (let t = 0; t < ms; t += chunk) {
    if (net?.hold) await net.hold();
    try { await page.clock.runFor(Math.min(chunk, ms - t)); }
    catch (e) { if (!(await pageTimerError(page, e, net))) throw e; }
    finally { net?.release?.(); }
    await networkQuiet(page, net);
  }
}

/** Serial network for an original replay. Playwright's fake clock yields a real macrotask after EVERY timer it fires
 *  (clock runFor -> _callFirstTimer awaits a real setTimeout), so a response that lands during runFor ran its
 *  callbacks between fake timers at a real-time-dependent point, and parallel responses completed in any order
 *  (measured: an asset loader's progress text listed other assets at the same percentage in two replays).
 *  A page-level route (runs before the context's archive routes) queues every request and lets ONE through at a time
 *  (route.fallback() -> the archive), in request order, the next after the previous finished (cap capMs); while the
 *  clock runs (hold) nothing is let through. Responses therefore land in a fixed order, between fake-time chunks. */
/** Request types released TOGETHER between clock chunks instead of one at a time (corpus S2F). Serialising
 *  stylesheets and images with everything else gave an image-paint history no real load has: measured on a real site
 *  (reduce), the original then drew a 730 px JPEG shown at 32 px up to 12 levels differently from the rebuild (10 px
 *  over the pixel threshold at all 14 E points), with identical src, box, computed style and no running animation.
 *  Bisected per type: images+stylesheets in parallel -> max 3 levels, 2 px (the D1b decoder band, as before S2);
 *  images alone, stylesheets alone, fonts, scripts, fetch/xhr, other -> unchanged; also unchanged: stylesheets
 *  first in the serial queue, and images+stylesheets as a second serial lane (deterministic, 21 px). The cost: image
 *  completion order is free again, so originals can differ on a JPEG drawn at several sizes (a real site: 5 px, one
 *  32 px avatar, max 9 levels), which the measured noise cap then carries. They still never land during runFor
 *  (hold waits for them). Override: WR_GATE_PAR_TYPES=<comma list> ('none' = everything serial). */
export const PAR_TYPES = new Set((process.env.WR_GATE_PAR_TYPES ?? 'image,stylesheet').split(',').filter(t => t && t !== 'none'));
export async function serialNetwork(page, net, { capMs = 3000 } = {}) {
  const queue = [], done = new Map();
  let busy = false, held = false, current = null;
  const fin = r => { const f = done.get(r); if (f) { done.delete(r); f(); } };
  page.on('requestfinished', fin); page.on('requestfailed', fin);
  const pump = async () => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && !held) {
        const route = queue.shift(), req = route.request();
        const finished = new Promise(r => { done.set(req, r); });
        current = Promise.race([finished, nodeSleep(capMs)]);
        try { await route.fallback(); } catch { done.delete(req); current = null; continue; }
        await current; current = null;
        done.delete(req);
      }
    } finally { busy = false; }
  };
  // PAR_TYPES: released together between clock chunks instead of one at a time (see the note above)
  const parQ = [], parFlight = new Set();
  const pumpPar = () => {
    while (parQ.length && !held) {
      const route = parQ.shift(), req = route.request();
      const p = Promise.race([new Promise(r => { done.set(req, r); }), nodeSleep(capMs)]).then(() => { done.delete(req); parFlight.delete(p); });
      parFlight.add(p);
      route.fallback().catch(() => { done.delete(req); parFlight.delete(p); });
    }
  };
  await page.route('**/*', route => { if (PAR_TYPES.has(route.request().resourceType())) { parQ.push(route); pumpPar(); } else { queue.push(route); pump(); } });
  // hold: nothing new goes out, and what is in flight finishes first (so no response lands during runFor)
  net.hold = async () => { held = true; if (current) await current; if (parFlight.size) await Promise.all([...parFlight]); };
  net.release = () => { held = false; pump(); pumpPar(); };
  net.serial = { queued: () => queue.length };
  return net;
}

const scrollInstant = y => scrollTo({ left: 0, top: y, behavior: 'instant' });

/** Site adapter for an own fixture served on localhost. */
export function fixtureSite(origin, truth, { live = [], reducedMotion = null } = {}) {
  return { id: 'fixture', url: origin + '/', classes: truth.classes, settleMs: 300, live, ...(reducedMotion ? { reducedMotion } : {}), locale: 'en-US', timezone: 'UTC', wire: async () => ({ misses: [], blocked: [] }) };
}

/** Site adapter for a frozen archive target (src/replay): every request is served from the HAR or aborted. */
export function archiveSite(target, { live = [], reducedMotion = null } = {}) {
  return {
    id: target.id || 'archive', url: target.startUrl, classes: target.classes, settleMs: target.settleMs ?? 4000, live, ...(reducedMotion ? { reducedMotion } : {}),
    locale: target.locale || 'en-US', timezone: target.timezone || 'UTC',
    wire: async (ctx, cls) => { const net = await wireReplay(ctx, harPaths(target, cls), { blockRegex: target.blockRegex ? new RegExp(target.blockRegex) : null, ownUrl: target.startUrl }); await ctx.addInitScript(seedScript(target.seed)); return net; },
  };
}

/** In-page: finish every running FINITE animation/transition (document, same-origin iframes). CSS transitions and
 *  animations run on the real frame clock, not the fake one, so a script that measures layout in rAF while one is
 *  in flight reads a time-dependent value. Measured on a real site: a section height written by JS into
 *  a script-written section-size custom property took 4 values in 8 identical loads (1242.3125 / .328125 / .34375 / .296875 px)
 *  while transform/filter transitions on its cards were running; finishing them before timers run removes that. */
export function finishFiniteAnimations() {
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch {} }
  let n = 0;
  for (const d of docs) for (const a of d.getAnimations ? d.getAnimations() : []) {
    try { const t = a.effect && a.effect.getComputedTiming(); if (t && Number.isFinite(t.endTime) && a.playState === 'running') { a.finish(); n++; } } catch {}
  }
  return n;
}

async function sweep(page, js, net) {
  // the page height is read at every step, not once: content that hydrates or lazy-renders during the sweep extends
  // it, and a height read once at the start differed between identical replays (one replay swept less of the page
  // and loaded 79 fewer lazy images on a corpus site)
  const H = () => page.evaluate(() => document.documentElement.scrollHeight);
  // scroll/resize events are dispatched by the real frame loop (not the fake clock): wait real FRAMES, then run timers.
  // Finite animations are finished before timers/rAF run, so JS that measures layout sees rest values (see above).
  const step = async y => {
    await page.evaluate(scrollInstant, y); await frames(page, 2);
    if (js) { await page.evaluate(finishFiniteAnimations); await page.evaluate(freezeMedia); await advance(page, net, 120); }
  };
  let y = 0;
  for (; y < Math.min(await H(), 60000); y += 600) await step(y); // capped: an endless feed keeps growing
  // ...and back up the same way. Scroll-linked script state can be path dependent: on a real site a section
  // keeps a script-written custom property at its last value and its scroll listener is attached only while the
  // section is near the viewport (IntersectionObserver, real time), so one jump from the bottom to 0 raced the
  // detach: 0 or 1 at the top (2 of 5 suite sessions in D1). Scrolling back up in steps lets the listener see the
  // section leave downwards, as a user scrolling up would, and ends in the same state as a fresh load (1).
  for (y -= 600; y > 0; y -= 600) await step(y);
  await page.evaluate(scrollInstant, 0);
  await frames(page, 3);
  if (js) { await page.evaluate(finishFiniteAnimations); await advance(page, net, 1500); await page.evaluate(finishFiniteAnimations); }
  await page.evaluate(freezeMedia);
  await networkQuiet(page, net);
}

/** goto + `load` with a diagnosis instead of a bare timeout (corpus F8). A renderer that no longer answers is a page spinning
 *  in a script: retrying cannot help, so it fails at once with that reason. A responsive page that is only slow (machine under
 *  load) gets one longer retry. */
export async function gotoLoad(page, url, flight, { timeoutMs = 60000, retryMs = 120000, probeMs = 4000 } = {}) {
  try { return await page.goto(url, { waitUntil: 'load', timeout: timeoutMs }); }
  catch (e) {
    if (!/Timeout/.test(e.message)) throw e;
    const alive = await Promise.race([page.evaluate(() => 1).then(() => true, () => false), nodeSleep(probeMs).then(() => false)]);
    const pending = flight ? flight.pending(timeoutMs) : 0;
    if (!alive) throw new Error(`page.goto: load did not fire in ${timeoutMs / 1000}s and the page does not answer (a script is busy-waiting or looping; ${pending} request(s) pending) - not retried`);
    try { return await page.goto(url, { waitUntil: 'load', timeout: retryMs }); }
    catch (e2) { throw new Error(`page.goto: load did not fire in ${timeoutMs / 1000}s nor in a retry of ${retryMs / 1000}s (page answers; ${flight ? flight.pending(retryMs) : '?'} request(s) pending): ${String(e2.message).split('\n')[0]}`); }
  }
}

/** Open one viewport class. artifact = {html, frames} to serve a rebuild (no script runs) instead of the original.
 *  afterLoad(h) (S12, the GSAP probe): called once after `load` + fonts, before the settle advance and the sweep (the fake
 *  clock is still paused at FIXED_TIME); its result is returned as `afterLoad`. Must not change the page. */
export async function openSession(site, cls, { artifact = null, beforeGoto = null, afterLoad = null, timeline = process.env.WR_GATE_TIMELINE !== 'real', pool = null } = {}) {
  const js = !artifact;
  // A rebuild is served with JavaScript ENABLED but every script blocked by CSP (`script-src 'none'`: no <script>,
  // no inline handler, no javascript: URL can run). Measured on a real site: with JavaScript disabled Chrome
  // turns lazy loading off (spec), so the rebuild loaded `loading=lazy` carousel images the original never loads
  // (C-719..859, ~150-230k px), and `@media (scripting)` / <noscript> would also differ from the original.
  const ctxOpts = { ...site.classes[cls], locale: site.locale, timezoneId: site.timezone, reducedMotion: reducedMotionOf(site), colorScheme: 'light', javaScriptEnabled: true };
  // pool: a BrowserPool (src/browser/pool.js) gives a fresh empty context in a shared browser; without one (or with
  // WR_GATE_POOL=0) every session launches its own browser with a throwaway profile
  const h = pool && poolsEnabled() ? await pool.open({ context: ctxOpts }) : await launchBrowser({ args: GATE_ARGS, context: ctxOpts });
  try {
    await h.page.bringToFront().catch(() => {}); // a page that is not frontmost can get no compositor frames, and its screenshots hang (CFT 147 / macOS)
    let installLateMs = 0;
    const net = await site.wire(h.context, cls);
    if (js && process.env.WR_GATE_RANDOM !== 'global') await h.context.addInitScript(perSiteRandom, 0x9e3779b9);
    const requests = [];
    h.page.on('request', r => requests.push({ type: r.resourceType(), url: r.url() }));
    const flight = trackNetwork(h.page);
    if (js && process.env.WR_GATE_NET !== 'parallel') await serialNetwork(h.page, flight);
    h.flight = flight; // capture hooks get h, not the session
    await h.context.addInitScript(REAL_TIMERS); // before the fake clock, so the harness keeps real frames
    if (timeline) { const cdp = await h.context.newCDPSession(h.page); await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 }); }
    if (artifact) {
      const ful = body => r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': NO_SCRIPT_CSP }, body });
      // An <iframe> whose document the table does not hold (cross-origin: Stripe, YouTube, Vimeo, reCAPTCHA embeds) loaded
      // its ORIGINAL document from the archive, with its scripts and stylesheets: the rebuild was not built from our data
      // (22-23 Oct deep runs: the audit's `network` issue on 90 capture/states gates, every request from such frames).
      // It gets an empty script-blocked document; its pixels then differ inside the iframe and the point is listed as
      // unpaintable (third-party content the table does not carry), never passed. Registered first, so the table's frame
      // documents and the page (routes registered later run first) are served as before.
      const known = new Set([site.url, ...Object.keys(artifact.frames || {})]);
      const subDoc = req => { if (req.resourceType() !== 'document') return false; try { return req.frame() !== h.page.mainFrame(); } catch { return false; } };
      await h.context.route(u => !known.has(u.href), r => (subDoc(r.request()) ? ful('')(r) : r.fallback()));
      for (const [u, body] of Object.entries(artifact.frames || {})) await h.context.route(u, ful(body));
      await h.context.route(site.url, ful(artifact.html));
    } else {
      // installed PAUSED: script time moves only when the harness advances it (see the determinism note above)
      // (installed 1 s early: between install and pauseAt the clock flows a few ms, and pausing at the install time
      // itself then failed as "fast-forward to the past" on 3 of 56 corpus sites)
      await h.page.clock.install({ time: FIXED_TIME - 1000 });
      installLateMs = await pauseClockAt(h.page, FIXED_TIME, 'set', flight); // > 0: the install stalled; Date is reset but performance.now()/rAF ticks are not, so replays may differ: the run is indeterminate
      await h.context.addInitScript(spinGuardSource()); // a page busy-waiting on the paused Date would spin forever (corpus F8)
      // script-write recorder (scriptowned.js): evidence for script-owned regions; also in every identical replay,
      // so noise/identity show it does not perturb the page
      await h.context.addInitScript(scriptWriteRecorder);
      if (process.env.WR_GATE_RUNTIME_REC !== '0') await h.context.addInitScript(runtimeStateRecorder); // S3 (opt-out for attribution runs): registerProperty + FontFace sources (original sessions only)
    }
    const capState = beforeGoto ? await beforeGoto(h) : null;
    await gotoLoad(h.page, site.url, flight);
    // a rebuild's content the HTML parser would have re-nested goes in now, before anything is read (rebuild.js parserMoves)
    const nest = artifact?.nest ? await applyNestAll(h.page, artifact.nest) : null;
    await h.page.evaluate(() => document.fonts.ready);
    const loadRead = afterLoad ? await afterLoad(h) : undefined;
    if (js) await advance(h.page, flight, site.settleMs); else { await networkQuiet(h.page, flight); await frames(h.page, 3); }
    if (js) await h.page.evaluate(() => { if (window.__wrSW) window.__wrSW.phase = 'sweep'; });
    await sweep(h.page, js, flight);
    const clockLateMs = js ? await pauseClockAt(h.page, PAUSE_AT, 'keep', flight) : 0;
    return { h, net, requests, js, capState, flight, clockLateMs, installLateMs, ...(nest ? { nest } : {}), ...(afterLoad ? { afterLoad: loadRead } : {}) };
  } catch (e) { await h.close(); throw e; }
}

/** Apply a rebuild's nest entries ('' = the page, else an iframe document by URL). A missing target is reported (the
 *  rebuild then differs where the oracle shows it), never thrown. */
export async function applyNestAll(page, nest) {
  const out = { done: 0, missing: [] };
  for (const [doc, entries] of Object.entries(nest)) {
    const fr = doc === '' ? page.mainFrame() : page.frames().find(f => f.url() === doc);
    if (!fr) { out.missing.push(`frame ${doc.slice(0, 100)}`); continue; }
    const r = await fr.evaluate(applyNest, entries);
    out.done += r.done; out.missing.push(...r.missing);
  }
  return out;
}

export async function toPoint(s, pt) {
  const page = s.h.page;
  // always re-apply: the previous full-page screenshot may have left height-dependent state behind
  await page.setViewportSize({ width: pt.w, height: pt.h });
  await frames(page, 2);
  if (s.js) { await page.evaluate(finishFiniteAnimations); await advance(page, s.flight, 1000); }
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(freezeMedia);
  await networkQuiet(page, s.flight);
  // every loaded image fully decoded before snapshot + screenshot
  await page.evaluate(() => Promise.all([...document.images].filter(i => i.complete && i.naturalWidth).map(i => i.decode().catch(() => {}))));
  await frames(page, 2);
}

/** A screenshot that cannot be taken (the clip is empty or entirely outside the page: Playwright throws "Clipped area is
 *  either empty or outside the resulting image") is SKIPPED with a recorded reason, not a step failure: a sidecar
 *  `<id>.noshot.json` stands in for the PNG and compareRuns reports that point's pixel check as skipped. */
export const isClipError = e => /Clipped area is either empty or outside/.test(String(e && e.message));
/** Reason a clip cannot work on a page of size {w, h} (document px), or null. Partly outside is fine (Playwright clips it). */
export function clipProblem(clip, size) {
  if (!clip) return null;
  const { x, y, width, height } = clip;
  if (![x, y, width, height].every(Number.isFinite)) return 'clip has a non-finite value';
  if (width <= 0 || height <= 0) return `clip is empty (${width}x${height})`;
  if (x >= size.w || y >= size.h || x + width <= 0 || y + height <= 0) return `clip ${Math.round(x)},${Math.round(y)} ${Math.round(width)}x${Math.round(height)} is outside the ${size.w}x${size.h} page`;
  return null;
}
export const pageSize = () => ({ w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0), h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) });
export function markNoShot(dir, id, reason) { fs.writeFileSync(path.join(dir, `${id}.noshot.json`), JSON.stringify({ reason })); }
function noShotReason(dirs, id) {
  for (const d of dirs) { try { return JSON.parse(fs.readFileSync(path.join(d, `${id}.noshot.json`), 'utf8')).reason || 'screenshot skipped'; } catch { /* a PNG exists */ } }
  return null;
}

/** Full-page screenshot. Playwright waits for document.fonts.ready; a font whose load is driven by page script on the
 *  paused clock never settles (measured: 30 s timeout on 1 of 56 corpus sites), so on a timeout the clock advances
 *  1 s (same for every replay) and the shot is retried once. */
async function shoot(s) {
  const opt = { fullPage: true, scale: 'css', animations: 'disabled', caret: 'hide' };
  await s.h.page.bringToFront().catch(() => {}); // see openSession
  try { return await s.h.page.screenshot(opt); } catch (e) {
    if (!/Timeout/.test(e.message) || !s.js) throw e;
    await advance(s.h.page, s.flight, 1000);
    return s.h.page.screenshot({ ...opt, timeout: 60000 });
  }
}

/** Snapshot / script-write file: interned JSON, gzipped. Returns a promise: await it before anything reads the file.
 *  S-SPEED #2c (27 Oct): the gzip runs on libuv's thread pool (zlib.gzip, default options) instead of blocking the one
 *  event loop that serves every parallel session; the bytes are the same as gzipSync's (proven on 60/60 stored payloads,
 *  test/gate/sspeed-offline.test.js). REVA_ASYNC_GZ=0: gzipSync + writeFileSync, as before. */
const gzipAsync = (buf) => new Promise((res, rej) => zlib.gzip(buf, (e, out) => (e ? rej(e) : res(out))));
export const gzWrite = async (f, obj) => {
  const json = JSON.stringify(internStyles(obj));
  if (process.env.REVA_ASYNC_GZ === '0') { fs.writeFileSync(f, zlib.gzipSync(json)); return; }
  await fs.promises.writeFile(f, await gzipAsync(json));
};
export const gzRead = f => expandStyles(JSON.parse(zlib.gunzipSync(fs.readFileSync(f))));

/**
 * Capture snapshots + full-page screenshots at points (grouped by class, captured point first).
 * artifacts: {cls: {html, frames}} for a rebuild run, or null for an original replay.
 * withDump: also dump the T6 baseline artifact + original sources at each class's captured point.
 */
/** capture: {beforeGoto(h) -> state, at(h, state, cls, pt, dir), close(state)} runs an extra capture (e.g. the D1
 *  rule table) in the same session at each class's captured point, after the snapshot and before the screenshot. */
/** prepare(page, pt): runs after the viewport is set and before the snapshot (rebuild runs: script-owned values). */
export async function captureRun(site, points, dir, { artifacts = null, withDump = false, withSources = withDump, capture = null, prepare = null, log = () => {}, reuse = process.env.WR_GATE_REUSE === '1', pools = null, poolKey = 'cap' } = {}) {
  if (reuse && fs.existsSync(path.join(dir, 'meta.json'))) return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  fs.mkdirSync(dir, { recursive: true });
  const meta = { classes: {}, points: {} };
  const byCls = new Map();
  for (const p of points) { if (!byCls.has(p.cls)) byCls.set(p.cls, []); byCls.get(p.cls).push(p); }
  for (const cls of byCls.keys()) if (artifacts && !artifacts[cls]) throw new Error(`no artifact for class ${cls}`);
  // F3: the viewport classes are independent sessions; they run side by side (bounded by the gate's session slots)
  // and write disjoint files. Results are merged in class order so meta.json is the same as a serial run's.
  const settled = await Promise.allSettled([...byCls].map(([cls, pts]) => inSlot(async () => {
    const out = { classes: null, points: {} };
    pts.sort((a, b) => (a.kind === 'captured' ? -1 : 0) - (b.kind === 'captured' ? -1 : 0));
    const t0 = Date.now();
    const s = await openSession(site, cls, { artifact: artifacts?.[cls], beforeGoto: capture?.beforeGoto, pool: pools?.get(`${poolKey}|${cls}`) });
    try {
      for (const pt of pts) {
        const t1 = Date.now();
        if (s.js) await s.h.page.evaluate(ph => { if (window.__wrSW) window.__wrSW.phase = ph; }, `pt:${pt.id}`);
        await toPoint(s, pt);
        if (prepare) out.points[pt.id] = { prepared: await prepare(s.h.page, pt) };
        // original runs: which <img> were loaded at the snapshot (a rebuild loads the same ones, see loadImagesLike)
        if (!artifacts) {
          const tl = await s.h.page.evaluate(topLayerNow);
          out.points[pt.id] = { ...out.points[pt.id], imgs: await s.h.page.evaluate(loadedImages), ...(tl.length ? { topLayer: tl } : {}) };
        }
        const snap = await takeSnapshot(s.h.page, { live: site.live });
        await gzWrite(path.join(dir, `${pt.id}.json.gz`), snap);
        // script-written state at this snapshot (same moment), the evidence for script-owned regions
        if (s.js) { const sw = await collectWrites(s.h.page, null); if (sw) await gzWrite(path.join(dir, `sw-${pt.id}.json.gz`), sw); }
        // dump BEFORE the screenshot: a full-page capture changes the viewport height for a moment (height media
        // queries, resize handlers), so anything read after it may describe another state than the snapshot
        if ((withDump || withSources) && pt.kind === 'captured') {
          // withSources alone (lite capture): the original sources the audit reads, without the T6 computed dump
          if (withDump) { const why = await writeDump(s.h.page, path.join(dir, `dump-${cls}.json`)); if (why) out.points[pt.id] = { ...out.points[pt.id], dumpSkipped: why }; }
          fs.writeFileSync(path.join(dir, `sources-${cls}.json`), JSON.stringify(await s.h.page.evaluate(inPageSources)));
        }
        if (capture && pt.kind === 'captured') await capture.at(s.h, s.capState, cls, pt, dir);
        // F7: the PNG goes straight to disk and the buffer is dropped (no screenshot is kept in memory)
        try { await fs.promises.writeFile(path.join(dir, `${pt.id}.png`), await shoot(s)); }
        catch (e) { if (!isClipError(e)) throw e; markNoShot(dir, pt.id, `full-page screenshot: ${String(e.message).split('\n')[0]}`); out.points[pt.id] = { ...out.points[pt.id], shotSkipped: true }; }
        if (capture?.after && pt.kind === 'captured') await capture.after(s.h, s.capState, cls, pt, dir);
        out.points[pt.id] = { ...out.points[pt.id], els: snap.els.length, docH: snap.docH, ms: Date.now() - t1 };
        log(`${path.basename(dir)} ${pt.id} els=${snap.els.length} ${Date.now() - t1}ms`);
      }
    } finally {
      out.classes = { misses: s.net.misses.length, missSample: s.net.misses.slice(0, 5), requests: s.requests, scriptsBlocked: !s.js ? `csp: ${NO_SCRIPT_CSP}` : null, ms: Date.now() - t0, quiet: s.flight?.stats, clockLateMs: s.clockLateMs || 0, installLateMs: s.installLateMs || 0, ...(s.nest ? { nest: s.nest } : {}) };
      if (capture?.close) await capture.close(s.capState).catch(() => {});
      await s.h.close();
    }
    return [cls, out];
  })));
  const bad = settled.find(x => x.status === 'rejected');
  if (bad) throw bad.reason;
  for (const { value: [cls, out] } of settled) { meta.classes[cls] = out.classes; Object.assign(meta.points, out.points); }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return meta;
}

/** T6 baseline dump -> file. Its HTML inlines every computed style of every element: on a 31k-element SVG page that is
 *  more than a JS string can hold (512 MB), in the page ("Invalid string length") or in JSON.stringify here. That is a
 *  property of this one measurement, not a reason to fail the capture: skip the file and return the reason.
 *  The file is written by writeJsonFile (same bytes as JSON.stringify): Node 26's fast stringifier aborted the step
 *  process (uncatchable "Zone Allocation failed", RSS ~11.6 GB) on a 162M-char dump of one corpus site (util/jsonfile.js). */
export async function writeDump(page, file, dump = computedDump) {
  try { writeJsonFile(file, await dump(page)); return null; }
  catch (e) {
    if (!/Invalid string length|Invalid array length|Cannot create a string longer/.test(String(e && e.message))) throw e;
    fs.rmSync(file, { force: true });
    return `T6 dump too large for a JS string (${String(e.message).split('\n')[0]})`;
  }
}

/** Compare run B against run A at every point. noiseCaps: {pointId: maxDiffPx} (Infinity = record only). */
/** owned: {pointId: [keys]} script-owned elements a replay cannot reproduce (scriptowned.js): skipped by the oracle,
 *  their boxes in both snapshots painted out of both screenshots; the masked area is reported (px, % of viewport/page). */
export function compareRuns(dirA, dirB, points, noiseCaps, { heatDir = null, maxHeat = 12, excuse = [], owned = null } = {}) {
  const res = {};
  let heat = 0;
  if (heatDir) fs.mkdirSync(heatDir, { recursive: true });
  for (const pt of points) {
    const a = gzRead(path.join(dirA, `${pt.id}.json.gz`)), b = gzRead(path.join(dirB, `${pt.id}.json.gz`));
    const ow = owned?.[pt.id] || [];
    const oracle = compareSnapshots(a, b, { maxDetail: 40, excuse, owned: ow });
    const hp = heatDir && heat < maxHeat ? path.join(heatDir, `${pt.id}-heat.png`) : null;
    const mask = ow.length ? [...ownedRects(a, ow), ...ownedRects(b, ow)] : null;
    const decodeRects = decodeRectsOf(a, b, oracle, ow);
    const cap = noiseCaps?.[pt.id] ?? Infinity;
    const skipped = noShotReason([dirA, dirB], pt.id);
    if (skipped) {
      const pixel = { pass: false, skipped, reason: `screenshot skipped (pixel check NOT done): ${skipped}`, diffPx: 0, decodePx: 0, pct: 0, blob: 0, blobBox: null, cap, size: [0, 0] };
      res[pt.id] = { kind: pt.kind, cls: pt.cls, pass: false, oracle, pixel, shotSkipped: skipped };
      continue;
    }
    const d = diffPng(fs.readFileSync(path.join(dirA, `${pt.id}.png`)), fs.readFileSync(path.join(dirB, `${pt.id}.png`)), { heatmap: hp, mask, decodeRects });
    if (hp && d.diffPx) heat++;
    const pixel = { ...pixelVerdict(d, cap), diffPx: d.diffPx, decodePx: d.decodePx || 0, pct: d.pct, blob: d.blob.area, blobBox: d.blob.box, cap, size: d.sizeMismatch || [d.w, d.h] };
    if (ow.length) pixel.masked = { px: d.maskedPx || 0, pctViewport: +(100 * (d.maskedPx || 0) / (a.vw * a.vh)).toFixed(2), pctPage: d.w ? +(100 * (d.maskedPx || 0) / (d.w * d.h)).toFixed(2) : null };
    res[pt.id] = { kind: pt.kind, cls: pt.cls, pass: oracle.pass && pixel.pass, oracle, pixel };
  }
  return res;
}

// decoder tolerance only where every element matched exactly (same src, box and computed style on both sides)
function decodeRectsOf(a, b, oracle, ow) {
  if (!oracle.pass) return null;
  const bk = new Map(b.els.map(e => [e.k, e.b]));
  return a.els.filter(e => /\/img\[\d+\]$/.test(e.k) && bk.has(e.k) && e.b.every((v, i) => Math.abs(v - bk.get(e.k)[i]) <= 0.5) && !(ow.length && isOwned(e.k, ow))).map(e => [Math.floor(e.b[0]), Math.floor(e.b[1]), Math.ceil(e.b[0] + e.b[2]), Math.ceil(e.b[1] + e.b[3])]);
}

/** Content a rule-table rebuild cannot paint: what a script or media decoder draws inside canvas / video / iframe. */
export const SCRIPT_PAINTED = /\/(canvas|video|iframe)\[\d+\]$/;

/** A failing point whose ONLY difference is pixels inside script-painted elements: every element matched exactly
 *  (oracle pass) and, with those elements' boxes (plus the owned regions) painted out of both screenshots, the pixel
 *  check passes under the same noise cap. Returns what was painted out, or null when that does not hold. It is never a
 *  pass: the content under the masks is NOT verified, and callers list such points as `unpaintable`. */
export function unpaintableAt(dirA, dirB, pt, r, owned = []) {
  if (r.pass || !r.oracle.pass || r.pixel.pass || r.pixel.skipped || !r.pixel.blobBox) return null;
  const a = gzRead(path.join(dirA, `${pt.id}.json.gz`)), b = gzRead(path.join(dirB, `${pt.id}.json.gz`));
  const painted = a.els.filter(e => SCRIPT_PAINTED.test(e.k) && e.b[2] > 0 && e.b[3] > 0 && !(owned.length && isOwned(e.k, owned)));
  if (!painted.length) return null;
  const rects = painted.map(e => [Math.floor(e.b[0]), Math.floor(e.b[1]), Math.ceil(e.b[0] + e.b[2]), Math.ceil(e.b[1] + e.b[3])]);
  const mask = [...rects, ...(owned.length ? [...ownedRects(a, owned), ...ownedRects(b, owned)] : [])];
  const d = diffPng(fs.readFileSync(path.join(dirA, `${pt.id}.png`)), fs.readFileSync(path.join(dirB, `${pt.id}.png`)), { mask, decodeRects: decodeRectsOf(a, b, r.oracle, owned) });
  if (!pixelVerdict(d, r.pixel.cap).pass) return null;
  return { elements: painted.map(e => e.k), maskedPx: d.maskedPx || 0, pctViewport: +(100 * (d.maskedPx || 0) / (a.vw * a.vh)).toFixed(2) };
}

export function summarize(results) {
  const rows = Object.entries(results);
  const by = k => rows.filter(([, r]) => r.kind === k || (k === 'heldout' && r.kind.startsWith('heldout')));
  const cnt = list => ({ points: list.length, pass: list.filter(([, r]) => r.pass).length, oraclePass: list.filter(([, r]) => r.oracle.pass).length, pixelPass: list.filter(([, r]) => r.pixel.pass).length });
  return { captured: cnt(by('captured')), heldout: cnt(by('heldout')), all: cnt(rows) };
}

/** Noise caps from identical-replay pairs (list of compareRuns results). Per point: max differing px over all pairs,
 *  raised to the max of its viewport class (the same renderer wobble, e.g. a fallback glyph, can show at any width
 *  of that class; one pair is only a sample). Every number is measured; nothing is a guessed allowance. */
export function noiseCapsFrom(pairs) {
  const pt = {}, cls = {};
  for (const res of pairs) for (const [id, r] of Object.entries(res)) {
    const d = Number.isFinite(r.pixel.diffPx) ? r.pixel.diffPx : 0;
    pt[id] = Math.max(pt[id] || 0, d); cls[r.cls] = Math.max(cls[r.cls] || 0, d);
  }
  const caps = {};
  for (const res of pairs) for (const [id, r] of Object.entries(res)) caps[id] = Math.max(pt[id], cls[r.cls]);
  return { caps, perPoint: pt, perClass: cls };
}

/** Provenance (D1): the served artifact is exactly what the renderer makes from the captured JSON alone: html, iframe
 *  documents and the nest entries the harness applied (26 Oct, L7). */
export const sameArtifact = (re, art) => !!re && re.html === art.html && JSON.stringify(re.frames || {}) === JSON.stringify(art.frames || {}) && JSON.stringify(re.nest || null) === JSON.stringify(art.nest || null);

/** Source audit of a rebuild run (artifact per class) against the original's sources (from orig1 withDump). */
export function auditRun(origDir, rebuildMeta, artifacts, { provenance = null } = {}) {
  const out = {};
  for (const [cls, art] of Object.entries(artifacts)) {
    const src = JSON.parse(fs.readFileSync(path.join(origDir, `sources-${cls}.json`), 'utf8'));
    const m = rebuildMeta.classes[cls];
    if (!m) continue;
    out[cls] = auditSources(src, art, { requests: m.requests, scriptsBlocked: m.scriptsBlocked, jsDisabled: m.jsDisabled });
    // provenance (D1): the served artifact is exactly what the renderer makes from the captured JSON alone
    if (provenance) { const re = provenance(cls); const ok = sameArtifact(re, art); out[cls].provenance = ok; if (!ok) { out[cls].pass = false; out[cls].issues.push({ kind: 'provenance' }); } }
  }
  return out;
}
