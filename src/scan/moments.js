// The moments of one page in one viewport (PLAN §2): load, idle, full scroll down, scroll back up. Each runs on the sealed
// archive on the virtual clock (hx lane, 60 Hz, no cap on moving elements, rows streamed to disk) and keeps real pictures of
// every frame next to the take. Nothing here reaches the real site: the archive replay is walled off (BLACKHOLE_ARGS).
//
//   load    boot frame by frame until the document is complete, then 3 s more
//   idle    after load has settled: 4 s of the page alone (ambient loops, WebGL)
//   scroll  wheel down at human speed (2,000 px/s) to the bottom or to the cap, then back up; one take, two marks
//   arrive  all of the above in one browser, then the pointer sweep and the inventory (recordArrive, DESIGN 3.2)
import fs from 'node:fs';
import path from 'node:path';
import { openSession } from '../record/session.js';
import { BLACKHOLE_ARGS } from '../replay/target.js';
import { quietBeforeStart, settle, noUdpPrefs } from '../look/index.js';
import { clickRejectInPage } from '../safety/consent.js';
import { CONSENT_HIDE_INIT, consentStateInPage, rejectHiddenInPage, mergeConsent } from '../safety/banner.js';
import { frameRecorder } from './frames.js';
import { passGate, gateProbe, findGate } from './gate.js';
import { writeTable } from './table.js';
import { LISTENER_INIT, inventoryInPage } from './inventory.js';
import { ARRIVE, IDLE_WAIT_MS, framesOf } from './moves/contract.js';
import { DECLARED_INIT, restSource } from '../record/declared.js';

export const VIEWPORTS = { desktop: { cls: 'A' }, phone: { cls: 'E' } };
export const RATE = 60;
/** Wheel of 100 px every 3 frames at 60 Hz = 2,000 px/s, the speed of a person scrolling (look's 100 px per frame is 12,000 px/s at 120 Hz). */
export const WHEEL_PX = 100;
export const WHEEL_EVERY = 3;
export const SCROLL_CAP_PX = 30000;
/** A session with no new frame for this long is closed: its unit gets a failed row, the scan goes on. */
export const STALL_MS = 90000;
export const TAKE_OF = { load: 'load', idle: 'idle', 'scroll-down': 'scroll', 'scroll-up': 'scroll' };

export { gateProbe };

/**
 * One recording on the sealed archive, in its own browser: the session, the pictures, the take moved to takes/<viewport>/<name>/.
 * `body` gets { S, shot, ready, phaseFrames, result }; `ready()` brings the page to rest (boot, the banner's non-accepting
 * choice, settle) and passes the gate of `gatePlan` when there is one.
 * @param {object} o
 * @param {object} o.target       loaded target (archive path, classes, seed)
 * @param {'desktop'|'phone'} o.viewport
 * @param {string} o.name         the take's folder name
 * @param {string} o.outDir       the page's folder in the scan
 * @param {string[]} [o.consentClicks]  reject selectors found by the safety gate (the banner's non-accepting choice)
 * @param {object|null} [o.gatePlan]    how to get past this page's gate (src/scan/gate.js)
 * @param {string} [o.init]       a script for every document of the session
 * @param {boolean} [o.write]     false: no take, no pictures (a survey of the page)
 * @param {boolean} [o.dropLeft]  a page the unit's press left for is no miss: the test only touches it, one page per template
 * @param {number} [o.idleMs]      wall bound of a page-idle wait: 250 ms against 2 s, a sealed large marketing site, scroll, same settle: 22 of 19 M values differ
 * @param {boolean} [o.gate]       false: a picture of every frame, no shot gate
 * @param {boolean} [o.hideConsent] false: leave cookie-consent banners on screen (default: hidden for the whole take, src/safety/banner.js)
 */
/** Where the page went since `from`: the document it asked for outside the archive, or its own address when that moved. */
export async function leftPage(S, from) {
  const out = S.net?.left?.at(-1);
  if (out) return out;
  const now = await S.evRetry(() => location.href);
  return now.split('#')[0] !== from.split('#')[0] ? now : null;
}

export async function recordUnit({ target, viewport, name, outDir, consentClicks = [], gatePlan = null, engine, log = () => {}, noFrames = false, args = [], init = null, write = true, dropLeft = false, onMiss = null, idleMs = IDLE_WAIT_MS, gate = true, hideConsent = true }, body) {
  const { cls } = VIEWPORTS[viewport];
  const vp = target.classes[cls].viewport;
  const w0 = Date.now();
  const takeRoot = path.join(outDir, 'takes', viewport);
  const frameDir = path.join(outDir, 'frames', viewport, name);
  fs.mkdirSync(takeRoot, { recursive: true });
  // the take goes to a private work folder of the scan and is moved when it is whole, so a stopped take leaves no half folder
  const work = fs.mkdtempSync(path.join(outDir, '.take-'));
  const S = await openSession({
    writeDir: path.join(work, 'take'), lane: 'hx', rate: RATE, engine, cls, target, args: [...BLACKHOLE_ARGS, ...args], prefs: noUdpPrefs(), timerFlag: true, keepalive: true, discover: true,
    maxElements: Infinity, capPolicy: null, netGate: true, streamRows: true, scan: true, idleMs, onMiss, scene: { init: [DECLARED_INIT, hideConsent ? CONSENT_HIDE_INIT : null, init].filter(Boolean).join('\n') },
  });
  const fr = noFrames || !write ? null : frameRecorder(S, { dir: frameDir, width: vp.width, height: vp.height, gate });
  /** One frame's picture: `opts` as frameRecorder's shot. Returns its read of the page, with no recorder only W.quiet. */
  const shot = async (phase, opts = {}) => (fr ? fr.shot(phase, opts) : { quiet: opts.quiet ? await S.quiet(opts.quiet) : null });
  const result = { take: name, viewport };
  // a page that stops answering without dying (seen on a press that ends in a heavy route) must not hold the scan for ever
  let lastSteps = -1, lastAt = Date.now(), stalled = null, told = Date.now();
  const stallTimer = setInterval(() => {
    if (S.finishing || S.closed) return;
    // a call into a crashed page never answers, so the crash itself ends the unit
    if (S.deadError) { stalled = S.deadError.message; log(`${viewport} ${name}: ${stalled}`); S.close().catch(() => {}); return; }
    const n = S.stepWall?.length ?? 0;
    if (Date.now() - told >= 30000) { told = Date.now(); log(`${viewport} ${name}: recording, ${n} frames so far`); }
    if (n !== lastSteps) { lastSteps = n; lastAt = Date.now(); return; }
    if (Date.now() - lastAt > STALL_MS) { stalled = `the page stopped answering: no frame for ${STALL_MS / 1000} s`; log(`${viewport} ${name}: no frame for ${STALL_MS / 1000} s, closing this browser`); S.close().catch(() => {}); }
  }, 5000);
  stallTimer.unref?.();
  try {
    const flight = new Map();
    S.page.on('request', (r) => flight.set(r, Date.now())); S.page.on('requestfinished', (r) => flight.delete(r)); S.page.on('requestfailed', (r) => flight.delete(r));
    const pending = S.netInFlight || (() => { const now = Date.now(); let n = 0; for (const t of flight.values()) if (now - t < 3000) n++; return n; });
    // what the consent hider took out of this take (every document of it), and the reject it pressed, if any
    let consent = null;
    const readConsent = async () => { if (!hideConsent || S.closed || S.deadError) return; try { consent = mergeConsent(consent, await S.evRetry(consentStateInPage)); } catch { /* a page between documents: the next read has it */ } };
    const reject = async () => {
      let c = null;
      if (consentClicks.length) try { c = await S.evRetry(clickRejectInPage, consentClicks); if (c && c.length) await S.hold(400); } catch { c = null; }
      // a banner the hider took out may offer a clear "reject": pressed once, never "accept" (the banner stays hidden either way)
      if (hideConsent && !(c && c.length)) try { if (await S.evRetry(rejectHiddenInPage)) await S.hold(400); } catch { /* none */ }
      await readConsent();
      return c;
    };
    /**
     * Up to n frames of a phase. { pictures } as wantShot. { quiet: q, min }: the phase ends once W.quiet(q) holds, never before
     * frame `min`; S.partStart comes first, right before the input. Returns the frames run.
     */
    const phaseFrames = async (phase, n, { pictures = 'gate', quiet = 0, min = 0 } = {}) => {
      for (let i = 1; i <= n; i++) {
        await S.step(1);
        const m = await shot(phase, { pictures, quiet: i >= min ? quiet : 0 });
        if (m.quiet) return i;
      }
      return n;
    };
    const rest = async () => { await settle(S, { pending, aim: [], needAim: false, maxWallMs: 60000, pageQuiet: true, waitAnims: true }); await reject(); await S.hold(500); };
    await S.goto(); await quietBeforeStart(S, { pending });
    const ready = async ({ gatePhase = null } = {}) => {
      await S.boot({ until: 'document.readyState === "complete"', maxMs: 120000, maxVirtualMs: 30000, thenMs: 0 });
      await reject();
      await rest();
      if (gatePlan?.sel) {
        result.gatePassed = await passGate(S, gatePlan, { phaseFrames, phase: gatePhase });
        if (result.gatePassed) await rest();
      }
      if (S.net) S.net.stay = true;
    };
    await body({ S, shot, phaseFrames, ready, rest, reject, result });
    await readConsent();
    if (consent && (consent.hidden.length || consent.rejected.length || consent.unlocked?.length)) result.consent = consent;
    if (write) {
      const bare = (u) => u.split(/[?#]/)[0], left = new Set(dropLeft ? (S.net?.left || []).map(bare) : []);
      result.missList = [...new Set((S.net?.misses || []))].filter((m) => !left.has(bare(m.slice(m.indexOf(' ') + 1))));
      result.netGate = S.netGateStats?.() ?? null;
      // what the page declares, read at rest on the object the hook caught; a page that broke on the last step keeps its take
      if (!S.deadError) try { result.declared = await S.page.evaluate(restSource()); await S.evRetry(() => window.__WR.snapshotDeclared('take-end')); } catch (e) { result.declared = { error: String(e.message).split('\n')[0].slice(0, 200) }; }
      const { take, dir } = await S.finish({ scenario: name, extra: { netGate: result.netGate, ...(result.consent ? { consent: result.consent } : {}) } });
      const dest = path.join(takeRoot, name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(dir, dest);
      result.dir = dest;
      result.frames = fr ? fr.close() : null;
      result.rows = take.data.rows.length;
      result.moving = (take.watch || []).length;
      result.misses = take.net.misses;
      const written = JSON.parse(fs.readFileSync(path.join(dest, 'take.json'), 'utf8'));
      result.valid = !!written.validation?.ok;
      result.problems = written.validation?.problems || [];
      result.flags = (written.flags || []).map((f) => f.id);
      result.gl = written.gl || null;
      result.docStatus = written.net?.docStatus ?? null;
      result.rate = RATE;
      result.marks = written.marks || [];
    }
    result.wallMs = Date.now() - w0;
    result.ok = true;
    log(`${viewport} ${name}: ${result.rows ?? 0} frames, ${result.moving ?? 0} moving elements, ${result.frames ? result.frames.files + ' pictures' : 'no pictures'}, ${Math.round(result.wallMs / 1000)} s`);
    return result;
  } catch (e) {
    throw stalled ? new Error(stalled) : e;
  } finally {
    clearInterval(stallTimer);
    await S.close().catch(() => {});
    if (fr && !result.frames) try { fr.close(); } catch { /* the take failed before pictures were indexed */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** The page arriving: a frame at a time until the document is complete, then 3 s more. */
async function loadPhase(S, shot, reject) {
  for (let n = 0; n < 1800; n++) { await S.step(1); await shot('load'); if (n % 4 === 3 && await S.evRetry(() => document.readyState === 'complete')) break; }
  await S.mark('load-complete');
  for (let n = 0; n < 3 * RATE; n++) { await S.step(1); await shot('load'); }
  await reject();
}

/** Wheel down to the bottom or the cap, rest, wheel back up, rest. Scroll up stays capped at 30 a second: rows prove the rest. */
async function scrollPass(S, shot, scrollCapPx) {
  const maxS = await S.evRetry(() => document.documentElement.scrollHeight - innerHeight);
  const reach = Math.min(Math.max(0, maxS), scrollCapPx);
  const n = Math.max(40, Math.ceil(reach / WHEEL_PX) + 40);
  const stall = { wheels: 6 * WHEEL_EVERY, pauseMs: 450, restMs: 120, maxPauseMs: 3000, maxPauses: 3 };
  let cur = 'scroll-down', pictures = 'gate';
  const onStep = async () => {
    await shot(cur, { pictures });
    for (let e = 1; e < WHEEL_EVERY; e++) { await S.step(1); await shot(cur, { pictures }); }
  };
  await S.mark('scroll-down');
  const down = await S.wheel({ dy: WHEEL_PX, n, stall, onStep, until: scrollCapPx < maxS ? `scrollY >= ${scrollCapPx}` : null });
  for (let i = 0; i < RATE; i++) { await S.step(1); await shot(cur, { pictures }); }
  const atBottom = await S.evRetry(() => scrollY);
  cur = 'scroll-up'; pictures = 'cap';
  await S.mark('scroll-up');
  const up = await S.wheel({ dy: -WHEEL_PX, n: Math.ceil(atBottom / WHEEL_PX) + 40, stall, onStep });
  for (let i = 0; i < RATE; i++) { await S.step(1); await shot(cur, { pictures }); }
  const top = await S.evRetry(() => scrollY);
  return { maxScroll: Math.round(maxS), reached: Math.round(atBottom), capped: maxS > scrollCapPx + 2, cap: scrollCapPx, backToTop: top <= 2, topAfterUp: Math.round(top), down: { sent: down.sent, stop: down.stop, pauses: (down.pauses || []).length, virtual: !!down.virtual }, up: { sent: up.sent, stop: up.stop, pauses: (up.pauses || []).length } };
}

/**
 * One page and viewport arriving, in one browser (DESIGN 3.2): load, settle, the gate with pictures, idle, scroll down and up, the
 * pointer sweep on desktop, then the inventory, last, once every lazy section exists. Phases keep their names, so the marks and
 * frames.json read as the separate takes did. Without o.gatePlan the gate is found here, and its plan comes back like a survey's:
 * `result.gatePlan`, and `result.inv` for the patterns.
 */
export async function recordArrive({ scrollCapPx = SCROLL_CAP_PX, ...o }) {
  return recordUnit({ ...o, name: 'arrive', init: LISTENER_INIT }, async ({ S, shot, phaseFrames, ready, rest, reject, result }) => {
    result.gate = null; result.scrolled = null;
    await loadPhase(S, shot, reject);
    await ready({ gatePhase: 'gate' });
    if (o.gatePlan) result.gatePlan = o.gatePlan;
    else {
      // findGate presses as it looks, so that press is the gate's one pass: pictures from there, under the same mark as passGate's
      let pressed = false;
      const G = Object.create(S);
      G.click = async (a) => { if (!pressed) await S.mark('gate'); pressed = true; return S.click(a); };
      G.hold = async (ms) => (pressed ? phaseFrames('gate', framesOf(ms)) : S.hold(ms));
      result.gatePlan = await findGate(G);
      if (result.gatePlan.sel) { result.gatePassed = true; await rest(); }
    }
    const probe = await S.evRetry(gateProbe).catch(() => null);
    result.gate = probe ? probe.overlays : null;
    result.visible = probe ? probe.visible : null;
    result.table = await writeTable(S, path.join(o.outDir, 'frames', o.viewport, 'arrive'));
    await S.mark('idle');
    await phaseFrames('idle', framesOf(ARRIVE.idleMs));
    result.scrolled = await scrollPass(S, shot, scrollCapPx);
    if (o.viewport === 'desktop') {
      await S.mark('pointer-sweep');
      await S.pointerSweep({ frames: framesOf(ARRIVE.sweepMs), park: ARRIVE.park, onStep: () => shot('pointer-sweep') });
      await phaseFrames('pointer-sweep', framesOf(ARRIVE.restMs));
    }
    // the recorder's own way back is no motion of the page
    await S.setSampling(false);
    await S.evRetry(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await S.hold(600);
    await S.mark('inventory');
    try { result.inv = await S.evRetry(inventoryInPage, {}); } catch (e) { if (S.deadError) throw e; result.inv = null; result.invError = String(e.message).split('\n')[0].slice(0, 200); }
  });
}

/** One moment take (load, idle or scroll). The gate is passed in `idle` with pictures of the transition, in `scroll` without. */
export async function recordMoment({ take: name, scrollCapPx = SCROLL_CAP_PX, ...o }) {
  return recordUnit({ ...o, name }, async ({ S, shot, ready, reject, result }) => {
    result.gate = null; result.scrolled = null;
    if (name === 'load') { await loadPhase(S, shot, reject); return; }
    await ready({ gatePhase: name === 'idle' ? 'gate' : null });
    const probe = await S.evRetry(gateProbe).catch(() => null);
    result.gate = probe ? probe.overlays : null;
    if (name === 'idle') result.table = await writeTable(S, path.join(o.outDir, 'frames', o.viewport, 'idle'));
    result.visible = probe ? probe.visible : null;
    if (name === 'idle') {
      await S.mark('idle');
      for (let n = 0; n < 4 * RATE; n++) { await S.step(1); await shot('idle'); }
    } else if (name === 'scroll') result.scrolled = await scrollPass(S, shot, scrollCapPx);
  });
}

/**
 * A WebGL experience a click opens (opens.js flagged it: files the copy lacks, or a loader, and a canvas that has not drawn): recorded
 * as a page of its own, an `arrive-…` take. The page loads and passes its gate as the arrival did; the press is the take's `gate`
 * phase, held (pictures as a gate) until the canvas draws on EXPERIENCE.drawing frames in a row and no request has been open for
 * EXPERIENCE.quietMs, or EXPERIENCE.waitMs of wall time have passed (then `timedOut`, and the take is still kept). Then idle, the scroll
 * down and up, and on desktop the pointer sweep, as on any page. `o.onMiss` lets the files the copy lacks come from the site, paced.
 * @param {object} o  recordUnit options, plus `press: {sel, text}`, `name` (arrive-exp-<n>), `wait` (EXPERIENCE)
 */
export async function recordExperience({ press, name, wait, scrollCapPx = SCROLL_CAP_PX, ...o }) {
  return recordUnit({ ...o, name, init: LISTENER_INIT }, async ({ S, shot, phaseFrames, ready, rest, result }) => {
    await ready();
    const here = await S.evRetry((q) => !!document.querySelector(q), press.sel).catch(() => false);
    result.experience = { press: press.text ?? null, sel: press.sel, found: here };
    if (!here) return;
    const t0 = Date.now(), gl0 = await S.evRetry(() => window.__WR.glCanvas()).catch(() => ({ frames: 0, k: -1 }));
    let quietSince = null, run = 0, frames = 0, last = gl0.frames;
    await S.mark('gate');
    await S.click({ target: press.sel, hoverMs: 200 });
    for (;;) {
      frames += await phaseFrames('gate', 6);
      const g = await S.evRetry(() => window.__WR.glCanvas()).catch(() => null);
      if (g) { run = g.frames - last >= 6 ? run + 6 : 0; last = g.frames; }
      const open = S.netInFlight ? S.netInFlight() : 0;
      if (open) quietSince = null; else if (quietSince == null) quietSince = Date.now();
      if (run >= wait.drawing && quietSince != null && Date.now() - quietSince >= wait.quietMs) break;
      if (Date.now() - t0 > wait.waitMs) { result.experience.timedOut = true; break; }
      if (S.deadError) throw S.deadError;
    }
    const g1 = await S.evRetry(() => window.__WR.glCanvas()).catch(() => null);
    Object.assign(result.experience, { waitedMs: Date.now() - t0, frames, drawnFrames: g1 ? g1.frames - gl0.frames : null, drawing: run >= wait.drawing, misses: S.net?.misses?.length ?? null });
    await rest();
    await S.mark('idle');
    await phaseFrames('idle', framesOf(ARRIVE.idleMs));
    result.scrolled = await scrollPass(S, shot, scrollCapPx);
    if (o.viewport === 'desktop') {
      await S.mark('pointer-sweep');
      await S.pointerSweep({ frames: framesOf(ARRIVE.sweepMs), park: ARRIVE.park, onStep: () => shot('pointer-sweep') });
      await phaseFrames('pointer-sweep', framesOf(ARRIVE.restMs));
    }
  });
}
