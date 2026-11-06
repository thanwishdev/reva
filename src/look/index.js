// `reva look`: one page, one interaction, only the elements that moved -> fitted motion in plain words + code.
// Promoted from the aim-mode spike (19 Oct 2026):
//   record (hx lane, real-frame keepalive, aim watcher) -> choose elements and channels -> fit (budgeted, early exits)
//   -> export -> plain lines with exact / fitted / unknown labels -> look.json (for the motion card and the MCP).
// Live URLs and archives share everything after the page load; only the network wiring differs (source.js).
import fs from 'node:fs';
import path from 'node:path';
import { openSession } from '../record/session.js';
import { loadTake } from '../record/take.js';
import { fitTakeSet } from '../analysis/fit/index.js';
import { analyseStagger } from '../analysis/fit/stagger.js';
import { baseKey } from '../analysis/fit/series.js';
import { exportFit, exportStagger, LIBS } from '../export/index.js';
import { BLACKHOLE_ARGS } from '../replay/target.js';
import { localArgs, watchBlocked, describeLocalNet, normalizeAllowNet, KNOWN_CDNS } from './localnet.js';
import { ensureOutDir } from '../util/paths.js';
import { resolveSource } from './source.js';
import { declaredOnly, fillMeasuredFontEnds } from './declared.js';
import { descMatch } from '../analysis/fit/declared.js';
import { axisOfChannel, travelText } from './fontaxes.js';
import { measureCanvasCover, CANVAS_COVER_60HZ } from './rate.js';
import { notFromAction, elementStats, planFit, splitDeclaredTransform, fitOrder, renderedTransformStill, matrixChanges, parseAim, aimStateInPage, stateChanged, triggerCandidatesInPage, revealPendingInPage, declaredReaction, restChanged } from './select.js';
import { describeElement, describeStagger, channelWord } from './words.js';
import { forExport, exportWord, anchorMapToSamples } from './exportword.js';
import { guardPhysical } from './physical.js';
import { restPoseInPage, attachRest, REST_ANCESTORS } from './rest.js';
import { groupStarts, relStart } from './starts.js';
import { withRecordedEnds } from '../export/index.js';
import { recordedEnds } from '../mcp/analysis.js';
import { WEBRTC_PREFS, NO_UDP_APIS_SCRIPT } from '../mcp/guard.js';
import { runDesignPass } from '../design/pass.js';
import { parseColorScheme } from '../browser/scheme.js';
import { defaultEngine } from '../browser/engines.js';
import { safetyGate, navigationGuard } from '../safety/gate.js';
import { clickRejectInPage } from '../safety/consent.js';
import { motionPositions, cropsFor } from './position.js';
import { collectScripts, gatherEvidence, detectFrom, mechanismsOf } from './libs.js';
import { readGsap, lookGsap, attachGsap } from './gsap.js';
import { readLenis, lookLenis } from './lenis.js';
import { readLibs, lookLibs, attachAnime } from './libprobe.js';
import { glPass, holdForLateGl } from './gl.js';
import { glMotions, mergeRanked, screensOf } from './rank.js';
import { shotBefore, shotEnd, shotPage, canvasesOf, midShooter } from './screens.js';
import { POSITION_SCHEMA } from './position.js';
import { cacheWanted, withSessionCache, wireCacheReplay, retakePlan, RETAKE_MAX_MS, RETAKE_MOTIONS } from './cache.js';
import { recordSummary, compareMotions, matchEntry, STABILITY_SCHEMA } from './stability.js';
import { outRoot } from '../util/paths.js';
export { exportWord };

export const LOOK_SCHEMA = 'reva.look/0';
export const ACTIONS = ['load', 'hover', 'click', 'scroll'];
const SERIES = ['rows', 'births', 'declared', 'mutations', 'wheel', 'inputLog', 'elements'];
/**
 * Fit budget for look (frame evaluations; numeric.js meter). Lower than the corpus LITE budget (4e8 per channel, 3e9
 * per take): at the ~5 M evaluations/s measured under load a channel stops after ~40 s and the take after ~2 min, and
 * a channel cut by the budget is reported as unknown with the reason, never silently. identifyBudget caps the spring
 * integrator identification inside one channel (9 hypotheses, ~50 M evaluations for the dearest one, ~225 M for all of
 * them with the refits: on an archived real site two identical 1.5 s opacity ramps spent the whole channel budget there
 * and got no model): the stage keeps the cheapest hypotheses it finished and says so (record unknown "integrator
 * identification stopped ..."), so the curve still gets its model.
 */
export const LOOK_FIT = { maxChannels: 40, workBudget: 30000, channelEvalBudget: 2e8, evalBudget: 6e8, identifyBudget: 1e8, driverBudget: 5e7 };

const r1 = (x) => Math.round(x * 10) / 10;
/** click: how long the pointer rests on the target before the press, and how long the button stays down (--press). */
export const CLICK_HOVER_MS = 300;
export const CLICK_PRESS_MS = 300;
/**
 * A local URL (fixtures, a dev server). The barrier is the DNS sinkhole: every name but the loopback ones resolves to
 * nothing. It is restated here with the loopback IP literals excluded too (the session puts OFFLINE_ARGS first and a
 * repeated switch takes its last value), so http://127.0.0.1:<port> and http://[::1]:<port> open like localhost. The dead
 * proxy is only a backstop for a run without the sinkhole: loopback bypasses it, everything else goes nowhere.
 */
export const LOCAL_ARGS = localArgs();

/** Page expression for the scroll action: stop once the aimed elements have left the viewport (12 wheels after). */
/** Profile prefs for every look session: the caller's, with the WebRTC policy forced to no non-proxied UDP (src/mcp/guard.js). */
export const noUdpPrefs = (prefs) => ({ ...(prefs || {}), webrtc: { ...((prefs && prefs.webrtc) || {}), ...WEBRTC_PREFS.webrtc } });

// (the bottom of the page and a page that holds the wheel back are handled by the session's stall driver: WHEEL_STALL)
export function wheelUntil(selectors) {
  return `(() => { const st = window.__LOOK_WHEEL || (window.__LOOK_WHEEL = { gone: 0 });
    const sels = ${JSON.stringify(selectors || [])}; if (!sels.length) return false;
    let n = 0, out = 0; for (const s of sels) { let l; try { l = document.querySelectorAll(s); } catch (e) { continue; } for (const el of l) { n++; const r = el.getBoundingClientRect(); if (r.bottom < -40) out++; } }
    st.gone = n && out === n ? st.gone + 1 : 0; return st.gone >= 12; })()`;
}

/** Trigger for hover/click: a selector, or a viewport point "x,y" / "point:x,y". */
export function parseTrigger(t) {
  const m = /^(?:point:)?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(t || ''));
  return m ? { point: { x: +m[1], y: +m[2] } } : { selector: t || null };
}

/**
 * Page hook (look only, added before the page's own scripts): when did the page last register an input listener
 * (pointer, mouse, wheel, touch, scroll)? A page wires its cursor / hover / smooth-scroll code after its bundle runs,
 * which can be long after readyState "complete" (a lazily imported bundle, a preloader).
 */
export const LISTEN_HOOK = `(() => { const L = window.__LOOK_LST = { n: 0, T: 0 }; const add = EventTarget.prototype.addEventListener;
  const re = /^(mouse|pointer|wheel|touch|click|scroll|DOMMouseScroll)/;
  EventTarget.prototype.addEventListener = function (t, f, o) { try { if (re.test(String(t))) { L.n++; L.T = performance.now(); } } catch (e) {} return add.call(this, t, f, o); }; })();`;

/**
 * Readiness before the action (hx: virtual frames keep running while it waits). readyState "complete" is not enough:
 * a page can fetch and run its interactive code later (measured on one archived site: the bundle arrived ~470 ms of
 * virtual time after "complete", its pointer listeners at 668 ms, and a pointer move at 566 ms went unseen for the
 * whole take). Waits until ALL of: no request in flight for `quietMs`; no new input listener for `quietMs`; the trigger
 * selector matches, and the aimed selector too when `needAim`; then up to `stableMs` more for the aimed elements to stop
 * changing (an element that never rests, e.g. a marquee, does not block); with `pageQuiet` (no aim: ranking the
 * page), the same for the elements the recorder already watches as moving, so a preloader or an intro plays out before
 * the action and is not ranked as its motion. Every gate is in virtual (page) time, and the
 * session's network gate (openSession netGate) holds virtual time while a request is in flight, so a frozen archive
 * starts the action at the same page time on every run, whatever the machine load: the same ranking every run.
 * Bounded by `maxVirtualMs` (page time) and, as a safety net only, `maxWallMs` (wall clock, generous: a busy page on a
 * loaded machine needs ~14 s wall for 3.3 s of page time, measured on one archived site, and a wall cut would make the
 * action time depend on the machine again); when a bound stops it, the unmet conditions are reported.
 */
export async function settle(S, { pending, aim = [], needAim = true, trigger = null, quietMs = 300, stableMs = 3000, maxWallMs = 15000, maxVirtualMs = 20000, pageQuiet = false, waitAnims = false, aimWaitMs = null } = {}) {
  const w0 = Date.now(); let T0 = null; let netQuiet = null, sig = null, stableSince = null, hardSince = null, p = null, otherSince = null;
  for (;;) {
    await S.step(4, { sample: true });
    p = await S.evRetry(([aim, trig, pq, wa]) => {
      const q = (s) => { try { return [...document.querySelectorAll(s)]; } catch (e) { return []; } };
      const one = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return [Math.round(r.x * 2), Math.round(r.y * 2), Math.round(r.width * 2), Math.round(r.height * 2), cs.transform, cs.opacity].join(','); };
      const els = aim.flatMap(q); let sig = els.slice(0, 5).map(one).join('|');
      // no aim (ranking the page): the elements the recorder watches as moving (a preloader, an intro) must rest too
      if (pq && window.__WR) { const W = window.__WR; try { W.discover(); } catch (e) {} sig += '#' + [...W.watch.values()].filter((w) => w.el && w.el.isConnected).slice(0, 80).map((w) => one(w.el)).join('|'); }
      // finite animations (CSS / WAAPI) still to play on the aimed elements: an entrance waiting out its delay looks
      // still, so the value check alone passes
      let run = 0;
      if (wa) for (const e of els.slice(0, 50)) { try { for (const a of e.getAnimations()) { const t = a.effect && a.effect.getComputedTiming(); if ((a.playState === 'running' || a.pending) && t && Number.isFinite(t.endTime)) run++; } } catch (x) { /* no getAnimations */ } }
      return { T: performance.now(), lst: window.__LOOK_LST ? window.__LOOK_LST.T : 0, aimN: els.length, trigOk: trig ? q(trig).length > 0 : true, sig, run };
    }, [aim, trigger, pageQuiet, waitAnims]);
    if (T0 == null) T0 = p.T;
    const now = Date.now();
    if (pending() === 0) { if (!netQuiet) netQuiet = { T: p.T }; } else netQuiet = null;
    if (p.sig !== sig) { sig = p.sig; stableSince = p.T; }
    const met = { network: !!netQuiet && p.T - netQuiet.T >= quietMs, listeners: p.T - p.lst >= quietMs, element: !needAim || !aim.length || p.aimN > 0, trigger: p.trigOk };
    // aimWaitMs: the aimed element may be built by the page after load (split text, a generated list): wait for it this long
    // (page time) once everything else is ready, then go on without it (a selector that matches nothing must not hold the look)
    if (met.network && met.listeners && met.trigger) { if (otherSince == null) otherSince = p.T; } else otherSince = null;
    if (!met.element && aimWaitMs != null && otherSince != null && p.T - otherSince >= aimWaitMs) met.element = true;
    const hard = Object.values(met).every(Boolean);
    if (hard) { if (hardSince == null) hardSince = p.T; } else hardSince = null;
    const stable = p.T - stableSince >= quietMs && !p.run;
    if (hard && (stable || p.T - hardSince >= stableMs)) return { ok: true, wallMs: now - w0, virtualMs: Math.round(p.T - T0), stable, unmet: [] };
    if (now - w0 > maxWallMs || p.T - T0 > maxVirtualMs) {
      const unmet = Object.entries(met).filter(([, v]) => !v).map(([k]) => ({ network: `requests still in flight (${pending()})`, listeners: 'the page was still adding input listeners', element: 'the --el selector matched nothing', trigger: 'the trigger selector matched nothing' }[k]));
      return { ok: false, wallMs: now - w0, virtualMs: Math.round(p.T - T0), stable, unmet };
    }
  }
}

/** Does the --el selector match the document root (html)? Then a scroll look at it is the page scroll line. */
async function aimsAtRoot(S, sel) {
  try { return !!(await S.evRetry((s) => { try { return [...document.querySelectorAll(s)].includes(document.documentElement); } catch (e) { return false; } }, sel)); } catch { return false; }
}

/**
 * Real-time quiet before the virtual clock starts. The recorder's clock only moves when the driver steps it, so the page's
 * own start-up (module graph, dynamic import() of a library, a bundle that builds the markup) can finish in wall time with
 * virtual time frozen at 0: the animations it creates then start at 0 on every run, whatever the machine load. Without
 * this wait the first steps ran while the module graph was still loading (readyState is "complete" before a dynamic
 * import() resolves), so on a loaded machine the page's start-up code ran late in virtual time or after the take: the same
 * `--el` load look found the element's entrance on one run and "no motion" on the next (measured: 2 of 8 runs under load).
 * Waits (wall clock, no virtual time) until the document is complete, no request has been in flight and no long task
 * (> 50 ms) has run for `quietMs`, bounded by `maxMs`.
 * @returns {{ok:boolean, wallMs:number}}
 */
export async function quietBeforeStart(S, { pending, quietMs = 300, maxMs = 20000 } = {}) {
  const w0 = Date.now(); let since = null;
  for (;;) {
    // the page's main thread is free when this evaluate returns; a long task that ended less than quietMs ago means the
    // start-up is still going (a task chain: promise continuations between long tasks leave only short gaps)
    // a closed browser (cancel, navigation error) throws here and ends the look, as it does anywhere else
    const st = await S.evRetry(() => { const W = window.__WR; return { done: document.readyState === 'complete', idle: W && W.realNow ? W.realNow() - (W.lastLongEnd || 0) : 1e9 }; });
    if (st.done && st.idle >= quietMs && pending() === 0) { if (since == null) since = Date.now(); if (Date.now() - since >= quietMs) return { ok: true, wallMs: Date.now() - w0 }; } else since = null;
    if (Date.now() - w0 > maxMs) return { ok: false, wallMs: Date.now() - w0 };
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Did any of `ids` change (any channel) in the rows recorded at or after virtual time `sinceT`? */
function movedSince(rows, ids, sinceT) {
  const first = new Map();
  for (const r of rows) {
    if (r.T < sinceT) continue;
    for (const id of ids) { const v = r.v && r.v[id]; if (!v) continue; const j = JSON.stringify(v); if (!first.has(id)) first.set(id, j); else if (first.get(id) !== j) return true; }
  }
  return false;
}

/** The scroll action's stall driver (session S.wheel `stall`): past gesture snapping (a lane snapper holds a wheel
 *  gesture back until the input has been quiet ~300 ms), stopping at the bottom or after 3 pauses with no progress. */
export const WHEEL_STALL = { wheels: 6, pauseMs: 450, restMs: 120, maxPauseMs: 3000, maxPauses: 3 };
/** Wheel step: 100 px, finer (down to 40 px) when the page scrolls less than 6000 px, so a short range gets enough samples. */
export function wheelStep(maxScroll) { return !Number.isFinite(maxScroll) || maxScroll <= 0 ? 100 : Math.max(40, Math.min(100, Math.round(maxScroll / 60))); }

/**
 * Hold on while the aimed elements still change (virtual time, 100 ms steps): stops once they have been still for
 * `quietMs`, or at `capMs`. A scroll reveal with a delay, or a load look whose element changes on a period (a value
 * updated every few seconds), is not cut by a fixed hold. Returns the extra page time held.
 */
export async function holdWhileMoving(S, sels, { quietMs = 1200, capMs = 6000 } = {}) {
  if (!sels || !sels.length) return 0;
  let last = await S.evRetry(aimStateInPage, sels).catch(() => null); let still = 0, held = 0;
  while (held < capMs && still < quietMs) {
    await S.hold(100); held += 100;
    const now = await S.evRetry(aimStateInPage, sels).catch(() => null);
    const ch = stateChanged(last, now);
    still = ch.changed || (now && now.els.some((e) => e.run)) ? 0 : still + 100; last = now;
  }
  return held;
}

async function act(S, o, sels) {
  const a = o.action;
  if (a === 'load') {
    await S.hold(o.holdMs ?? 4000); if (o.holdMs == null) await holdForLateGl(S);
    // aimed: a change that runs on a period (every few seconds) or late in the hold is followed to its end
    const extraMs = o.holdMs == null && sels && sels.length ? await holdWhileMoving(S, sels, { quietMs: 1500, capMs: 8000 }) : 0;
    return extraMs ? { heldOnMs: extraMs } : {};
  }
  if (a === 'scroll') {
    const maxScroll = await S.evRetry(() => document.documentElement.scrollHeight - innerHeight).catch(() => null);
    const dy = o.dy ?? wheelStep(maxScroll);
    const w = await S.wheel({ dy, n: o.n ?? Math.max(200, 2 * Math.ceil((maxScroll || 0) / dy) + 80), until: wheelUntil(sels), stall: WHEEL_STALL, onStep: o.midShots ? midShooter(S, maxScroll, o.midShots) : null });
    await S.hold(o.holdMs ?? 1000);
    // aimed elements still moving (a staggered reveal with a delay): hold on until they rest
    const extraMs = o.holdMs == null && sels && sels.length ? await holdWhileMoving(S, sels, { quietMs: 1200, capMs: 6000 }) : 0;
    return { wheels: w.sent, dy, stoppedEarly: w.stoppedEarly, stop: w.stop, ...(w.virtual ? { virtualScroll: true } : {}), ...(w.pauses && w.pauses.length ? { pauses: w.pauses.length, pausedMs: w.pauses.reduce((s, p) => s + p.ms, 0) } : {}), ...(extraMs ? { heldOnMs: extraMs } : {}) };
  }
  const trig = parseTrigger(o.on || (sels && sels[0]));
  if (!trig.point && !trig.selector) throw new Error(`look --do ${a} needs a target: --el <selector> or --on <selector|x,y>`);
  if (a === 'hover') {
    if (trig.point) { await S.pointer(trig.point.x, trig.point.y); await S.hold(o.holdMs ?? 2500); }
    else { await S.hover({ target: trig.selector, inMs: 800, outMs: 800 }); if (o.holdMs) await S.hold(o.holdMs); }
    return { trigger: trig };
  }
  if (a === 'click') {
    // a real click is hover -> press -> release; each phase gets time to play out, so a hover transition, a :active press
    // tween and the click handler's own motion do not run into each other (and are told apart: clickPhaseTrigger)
    const hoverMs = o.hoverMs ?? CLICK_HOVER_MS, pressMs = o.pressMs ?? CLICK_PRESS_MS;
    if (trig.point) { await S.pointer(trig.point.x, trig.point.y, { click: true, hoverMs, pressMs }); await S.hold(o.holdMs ?? 3000); }
    else await S.click({ target: trig.selector, holdMs: o.holdMs ?? 3000, hoverMs, pressMs, quiet: true, quietPress: o.pressMs == null });
    return { trigger: trig, hoverMs, pressMs };
  }
  throw new Error(`look: unknown action "${a}" (use ${ACTIONS.join(', ')})`);
}

/** Did any of `ids` change by more than a hair (1 px on a box or a length, 0.02 on a unit value) at or after `sinceT`?
 *  A sub-pixel drift (a smoothed page settling) is not a reaction. */
function movedClearly(rows, ids, sinceT) {
  const first = new Map();
  const far = (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > (Math.max(Math.abs(a), Math.abs(b)) > 2 ? 1 : 0.02);
    if (Array.isArray(a) && Array.isArray(b)) return a.length !== b.length || a.some((x, i) => far(x, b[i]));
    if (a && b && typeof a === 'object' && typeof b === 'object') { const k = new Set([...Object.keys(a), ...Object.keys(b)]); for (const x of k) if (far(a[x], b[x])) return true; return false; }
    return a !== b;
  };
  for (const r of rows) {
    if (r.T < sinceT) continue;
    for (const id of ids) { const v = r.v && r.v[id]; if (!v) continue; if (!first.has(id)) first.set(id, v); else if (far(first.get(id), v)) return true; }
  }
  return false;
}

/** Did the page scroll after the action's last press (rows' scroll offset moved by more than 2 px)? */
function pageScrolledAfterPress(S, sinceT) {
  const presses = (S.inputLog || []).filter((x) => x.kind === 'mousePressed' && Number.isFinite(x.T) && x.T >= sinceT - 1);
  if (!presses.length) return false;
  const tp = presses[presses.length - 1].T; let y0 = null, x0 = null;
  for (const r of S.data.rows) {
    if (r.T < tp) continue; const y = Number(r.sy) || 0, x = Number(r.sx) || 0;
    if (y0 == null) { y0 = y; x0 = x; continue; }
    if (Math.abs(y - y0) > 2 || Math.abs(x - x0) > 2) return true;
  }
  return false;
}

/** Trigger search: at most this many candidate controls are tried, and a look starts again at most this often for it. */
export const TRIGGER_PROBES = 8;
export const TRIGGER_RESTARTS = 2;

/**
 * Try candidate controls (triggerCandidatesInPage) one by one in this session and keep the first whose input changes the
 * aimed elements. hover: the pointer rests on it first (a hover trigger); then (hover and click) it is clicked. A click
 * that makes a hidden target shown and the target itself did not animate means the target exists only after that click:
 * `after` (the look then clicks it first and does the action on the target). Otherwise the control is the trigger: `on`.
 * The probing itself is never measured: the look starts again with what was found (runLookRestart).
 */
async function findTrigger(S, { action, sels, cands, status }) {
  const tried = [];
  const pointAt = (q) => S.evRetry((q) => { const el = document.querySelector(q); if (!el) return null; el.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); return r.width && r.height ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; }, q).catch(() => null);
  for (const c of cands.slice(0, TRIGGER_PROBES)) {
    const p = await pointAt(c.selector);
    if (!p) { tried.push({ selector: c.selector, why: c.why, result: 'not reachable' }); continue; }
    // the scroll may start a reveal on the target: wait until it rests, so that change is not credited to the candidate;
    // the target must also stay unchanged through the idle window right before the pointer moves
    const st0 = await aimStable(S, sels, { reveal: true });
    if (!st0.stable) { tried.push({ selector: c.selector, why: c.why, result: 'the target changes on its own' }); continue; }
    const s0 = st0.state;
    const p2 = await S.evRetry((q) => { const el = document.querySelector(q); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }, c.selector).catch(() => null) || p;
    await S.pointer(p2.x, p2.y);
    if (action === 'hover') {
      let ch = { changed: false };
      for (let t = 0; t < 700 && !ch.changed; t += 100) { await S.hold(100); ch = stateChanged(s0, await S.evRetry(aimStateInPage, sels).catch(() => null)); }
      if (ch.changed) { tried.push({ selector: c.selector, why: c.why, result: 'changes the target on hover' }); return { on: c.selector, why: c.why, tried }; }
    } else await S.hold(150);
    // the pointer resting on the candidate may start a hover change on the target: the click is measured from rest
    const st1 = await aimStable(S, sels);
    if (!st1.stable) { tried.push({ selector: c.selector, why: c.why, result: 'the target keeps changing under the pointer' }); continue; }
    const s1 = st1.state;
    await S.pointer(p2.x, p2.y, { click: true, pressMs: 80 });
    let ch = { changed: false }, end = null;
    for (let t = 0; t < 900; t += 100) { await S.hold(100); end = await S.evRetry(aimStateInPage, sels).catch(() => null); const x = stateChanged(s1, end); if (x.changed) { ch = { ...x, ...ch, changed: true, own: ch.own || x.own, shown: ch.shown || x.shown, created: ch.created || x.created }; } }
    if (!ch.changed) { tried.push({ selector: c.selector, why: c.why, result: 'no change' }); continue; }
    const nowShown = !!(end && end.els.some((e) => e.shown));
    const opener = (status === 'missing' || status === 'hidden') && nowShown;
    // a hover look: a control that changes the target only when clicked is never the hover trigger; it is clicked first
    // (open, then hover the target). A click look: a click whose target appears without animating itself
    if (action === 'hover' || (opener && !ch.own)) { tried.push({ selector: c.selector, why: c.why, result: opener ? 'shows the target' : 'changes the target on click (hover after it)' }); return { after: c.selector, why: c.why, tried }; }
    tried.push({ selector: c.selector, why: c.why, result: 'changes the target on click' });
    return { on: c.selector, why: c.why, tried };
  }
  return { none: true, tried };
}

/**
 * Wait (virtual time, 100 ms steps) until the aimed state rests: unchanged for `gapMs` (two equal aimStateInPage
 * readings at least that far apart), and with `reveal` no finite animation pending on the target or an ancestor (a load
 * fade still in its delay). At most `maxMs`. {stable, state, ms}
 */
export async function aimStable(S, sels, { gapMs = 300, maxMs = 2000, reveal = false } = {}) {
  const read = () => S.evRetry(aimStateInPage, sels).catch(() => null);
  let last = await read(), quiet = 0, held = 0;
  while (held < maxMs) {
    await S.hold(100); held += 100;
    const now = await read();
    quiet = restChanged(last, now) ? 0 : quiet + 100; last = now;
    if (quiet >= gapMs && !(reveal && await S.evRetry(revealPendingInPage, sels).catch(() => false))) return { stable: true, state: now, ms: held };
  }
  return { stable: false, state: last, ms: held };
}

/** Merge two fit results of the same take (pass 2 = the deferred channels). */
export function mergeFits(a, b) {
  if (!b) return a;
  return { ...a, partial: a.partial || b.partial, flags: [...a.flags, ...b.flags.filter((f) => !a.flags.some((g) => g.id === f.id))], records: [...a.records, ...b.records],
    stagger: [...a.stagger, ...b.stagger], unknowns: [...a.unknowns, ...b.unknowns], pruned: [...(a.pruned || []), ...(b.pruned || [])], pins: [...(a.pins || []), ...(b.pins || [])], capped: { ...a.capped, pass2: b.capped } };
}

// the sampled colour channels (ren:color / ren:bg / ren:fill / ren:stroke, as computed strings) and the CSS property each paints
const PAINT_PROP = { 'ren:color': 'color', 'ren:bg': 'background-color', 'ren:fill': 'fill', 'ren:stroke': 'stroke' };
/**
 * The recorder samples colours, so a colour change can be fitted from the frames. Two kinds are left to what states them
 * better, and are taken out of an element's moving channels before ranking and fitting:
 * - a colour the page declares (a CSS transition / animation / Web Animation of that property from the action on): the
 *   declared-only line states it exactly (timing, easing, the CSS end values); a fit of its 0-255 parts would only repeat
 *   it with fitted numbers;
 * - a colour that changed in at most two frames (a :hover / :active colour swap with no transition, and its way back):
 *   a state, not a motion; the design pass reports hover / focus states.
 * A colour that changes over many frames with no declaration (a script tween, a scrubbed colour) stays and is fitted.
 * @param {Map<number, object>} stats  elementStats output (mutated: `moving`)
 */
export function dropStatedPaint(stats, els, dir, fromT) {
  const any = [...stats.values()].some((st) => [...st.moving].some((c) => c in PAINT_PROP));
  if (!any) return;
  let decl = [];
  try { decl = declaredOnly(loadTake(dir, ['births']).data.births, { descs: null, fromT, max: Infinity }); } catch { decl = []; }
  for (const st of stats.values()) {
    for (const c of [...st.moving]) {
      if (!(c in PAINT_PROP)) continue;
      const declared = decl.some((d) => descMatch(d.desc, els[st.id]) && d.properties.some((p) => p.prop === PAINT_PROP[c]));
      if (declared || (st.energy[c] ?? 0) <= 2) st.moving.delete(c);
    }
  }
}

/**
 * @param {object} o
 * @param {string} o.input       URL or archive (see source.js)
 * @param {string} [o.action]    load | hover | click | scroll (default load)
 * @param {string} [o.el]        CSS selector of the element(s) to look at (aim mode)
 * @param {boolean|number|string} [o.pick]  rank the moving elements and pick one: a key (selector, member selector or
 *   descriptor; stable between runs), a number (the rank in this run), or true (asks o.chooser)
 * @param {Function} [o.chooser] async (entries) => rank   (the CLI's terminal prompt)
 * @param {string} [o.on]        hover/click trigger when it is not the element itself (selector, or "x,y")
 * @param {number} [o.top]       entries without --el (default 5)
 * @param {string[]} [o.channels]  channel filter (e.g. ren:ty,ren:opacity)
 * @param {number} [o.maxChannels] [o.maxMembers] [o.fitBudget]  fit budget (channels; members per folded group; frame evaluations)
 * @param {number} [o.rate] [o.holdMs] [o.n] [o.dy]  recording knobs
 * @param {boolean} [o.keepalive]  default true (hx frames at full speed; src/record/keepalive.js)
 * @param {boolean} [o.write]    write look.json + fit.json (default true)
 * @param {(msg:string)=>void} [o.log]
 */
export const LOOK_DEADLINE_MS = 300000;

export async function runLook(o) {
  // a hard wall-clock deadline for the whole look (both takes of a rate restart and the design pass): a page that never
  // settles, or sends the browser somewhere that never answers, ends in a timeout error instead of hanging the CLI or the
  // MCP queue. It is chained to the caller's signal (MCP cancel), so either one closes the browser.
  const ms = Number.isFinite(o.deadlineMs) && o.deadlineMs > 0 ? o.deadlineMs : LOOK_DEADLINE_MS;
  const timer = AbortSignal.timeout(ms);
  const signal = o.signal ? AbortSignal.any([o.signal, timer]) : timer;
  try { return await runLookRestart({ ...o, signal, _deadlineAt: Date.now() + ms }); } catch (e) {
    if (timer.aborted && !(o.signal && o.signal.aborted) && (!e || e.code === 'cancelled' || e.code === undefined)) {
      throw Object.assign(new Error(`look: no result within ${Math.round(ms / 1000)} s (the time limit of one analysis); the browser was closed. The page may never finish loading or settling.`), { code: 'timeout' });
    }
    throw e;
  }
}

async function runLookRestart(o) {
  const T0 = Date.now();
  // the design pass runs beside the take (startDesign) and is not tied to one attempt: a restart (rate, trigger, match,
  // load) keeps the one already running. A look that ends in an error stops it and removes what it wrote.
  const designRun = { run: null };
  try { return await restartLoop({ ...o, _designRun: designRun }, T0); } finally { if (designRun.run && !designRun.run.taken) await designRun.run.cancel(); }
}

async function restartLoop(o, T0) {
  for (let opt = o; ;) {
    try { return await runLookOnce(opt, T0); } catch (e) {
      // a canvas covers the page and the caller gave no rate: the corpus rule says 60 Hz; the rate is baked into the page
      // clock at launch, so the look starts again (the first browser is closed; time spent counts in the total)
      // the --el target could not be the trigger and a control that changes it was found: start again with it (the
      // probing clicked around the page; the measured take starts from a fresh page)
      // nothing was found: start again with the search off, so the take is the plain action on a page no probe touched
      // a click on the first match of --el that got no reaction: the next other match, each in a fresh page
      if (e && e.code === 'match_restart') { opt = { ...opt, _onMatch: e.next.selector, _matchList: e.rest, _matchTried: [...(opt._matchTried || []), e.tried].filter(Boolean) }; continue; }
      if (e && e.code === 'trigger_restart' && (opt._triggerTries || 0) < TRIGGER_RESTARTS) {
        opt = { ...opt, _onMatch: null, ...(e.found.none ? { triggerSearch: false } : {}), ...(e.found.on ? { on: e.found.on } : {}), ...(e.found.after ? { after: e.found.after } : {}), _triggerTries: (opt._triggerTries || 0) + 1, _triggerSearch: [...(opt._triggerSearch || []), { ...e.search, restarted: true }] }; continue;
      }
      if (e && e.code === 'rate_restart' && !opt._rateRule) { opt = { ...opt, rate: 60, _rateRule: { from: 120, to: 60, canvasCover: e.cover.maxCover, canvases: e.cover.canvases, probeMs: Date.now() - T0 } }; continue; }
      // the page's own script or style failed to arrive (a busy server dropped the connection): the page did not run as
      // it does, so the look starts again, up to LOAD_RETRIES times, after a short random pause (parallel looks on one
      // server fail together; the pause spreads them). look.json says so; a last failure is reported, not hidden.
      if (e && e.code === 'load_restart' && (opt._loadRetries || 0) < LOAD_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 + Math.random() * 1500 * ((opt._loadRetries || 0) + 1)));
        opt = { ...opt, _loadRetries: (opt._loadRetries || 0) + 1, _loadRetry: [...(opt._loadRetry || []), ...e.failed].slice(0, 6) }; continue;
      }
      throw e;
    }
  }
}

/** Times a look starts again when the page's own script / style / document failed at the connection level. */
export const LOAD_RETRIES = 3;
/** Connection-level failures (the request never got a whole response): transient on a busy server or machine. */
export const TRANSIENT_NET = /ERR_(CONNECTION_(RESET|REFUSED|CLOSED|ABORTED|FAILED)|EMPTY_RESPONSE|TIMED_OUT|NETWORK_CHANGED|SOCKET_NOT_CONNECTED|INCOMPLETE_CHUNKED_ENCODING|CONTENT_LENGTH_MISMATCH|ADDRESS_UNREACHABLE|INSUFFICIENT_RESOURCES)/;

/**
 * One attempt of a look, with its session cache (src/look/cache.js): created before the take for a URL look, used by the
 * stability re-take, and removed when the attempt ends, whatever way it ends (never kept, never in the output folder).
 */
async function runLookOnce(o, T0) {
  // (a cache that cannot be made only costs the re-take: look.json "stability" then says the responses were not recorded)
  let want = false, forbid = [o.outDir];
  try { want = cacheWanted(resolveSource(o.input, { cls: o.cls || 'A' }), o); forbid = [o.outDir, outRoot()]; } catch { /* lookOnce reports a bad source */ }
  return withSessionCache(want, (cache) => lookOnce(o, T0, cache), { forbid });
}

/**
 * The design pass (src/design/pass.js) in its own browser, started beside the motion take: a second browser process
 * with its own profile and context, so it shares nothing with the take (the take's clock is virtual and gated on its own
 * page's network and main thread; the other browser only costs CPU, which the virtual clock does not see). It writes
 * into a staging folder under the output root, moved into the take folder once both are done (finishDesign). Same
 * signal (deadline, cancel), same walls, robots guard and consent clicks as before; a failure only warns.
 */
function startDesign({ src, cls, o, allowNet, guard, safety, log }) {
  const ctrl = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, ctrl.signal]) : ctrl.signal;
  const stageRoot = ensureOutDir('takes', '.design-staging');   // beside the takes: the same disk, so the move is a rename
  const stage = fs.mkdtempSync(path.join(stageRoot, 'd-')); const outDir = path.join(stage, 'design');
  const promise = runDesignPass({ src, cls, outDir, viewport: o.viewport, colorScheme: o.colorScheme, args: o.args, allowNet, prefs: o.prefs, onSession: o.onSession, signal, engine: o.engine, navGuard: guard, consentClicks: safety ? safety.consent.clicks : null, log });
  promise.catch(() => {});   // awaited by finishDesign or cancel; never an unhandled rejection meanwhile
  const run = { promise, guard, stage, outDir, taken: false };
  run.cancel = async () => { ctrl.abort(); await promise.catch(() => {}); try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* gone */ } };
  return run;
}
/** Wait for the design pass and move its record into the take folder (`<take>/design`, where it always was). */
async function finishDesign(run, dir) {
  const d = await run.promise; run.taken = true;
  const dest = path.join(dir, 'design');
  try {
    if (fs.existsSync(run.outDir)) { fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(run.outDir, dest); }
    for (const k of ['record', 'errorLog']) if (d && typeof d[k] === 'string' && d[k].startsWith(run.outDir)) d[k] = dest + d[k].slice(run.outDir.length);
  } finally { try { fs.rmSync(run.stage, { recursive: true, force: true }); } catch { /* gone */ } }
  return d;
}

async function lookOnce(o, T0, cache) {
  const lap = {}; let tl = Date.now(); if (o._rateRule) lap.rateProbe = o._rateRule.probeMs; const mark = (k) => { const n = Date.now(); lap[k] = n - tl; tl = n; };
  const log = o.log || (() => {});
  const action = o.action || 'load';
  if (!ACTIONS.includes(action)) throw new Error(`look: unknown action "${action}" (use ${ACTIONS.join(', ')})`);
  // the colour scheme the page is read in (--color-scheme): undefined = light, exactly as before the option
  const colorScheme = parseColorScheme(o.colorScheme, 'colorScheme');
  const cls = o.cls || 'A';
  const src = resolveSource(o.input, { cls });
  if (o.after && action === 'load') throw Object.assign(new Error('look: --after clicks first and then does the action; it needs --do hover, click or scroll (a load has nothing to click before)'), { code: 'bad_arguments' });
  const aimed = !!o.el;
  // --el may name a pseudo-element (`a::after`): the host selectors find the elements, the pseudo says where their style is read
  const aim = aimed ? parseAim(o.el) : null;
  const sels = aim ? aim.selectors : [];
  // the trigger: --on, else another match of --el being tried after the first one did not react (o._onMatch)
  const onSel = o.on || o._onMatch || null;
  const rate = o.rate || (src.kind === 'archive' && src.rate) || 120;
  const rateAuto = !o.rate && src.kind === 'url';
  // network: an archive is replayed behind the catch-all route, the DNS sinkhole and a dead proxy; a local URL behind the
  // DNS sinkhole (loopback names and IPs excluded) with a dead proxy as backstop; a live URL goes to the network (plan item 1.5)
  // o.args: extra browser args (the MCP passes its guard proxy for live pages, src/mcp/guard.js startGuardProxy)
  // safety gate (src/safety/gate.js): a live page is checked against robots.txt and walls BEFORE the browser starts
  const safety = o._retake ? o._retake.safety : (o.safety ?? (src.kind === 'url' && src.live)) ? await safetyGate(src.url, { ignoreRobots: !!o.ignoreRobots, who: o.safetyWho === 'mcp' ? 'mcp' : 'cli', preflightImpl: o.preflight, fetchImpl: o.preflightFetch, log }) : null;
  // hosts a LOCAL page may reach (--allow-net / --allow-cdn, src/look/localnet.js); meaningless, so refused, for any other source
  const allowNet = normalizeAllowNet([...(o.allowCdn ? KNOWN_CDNS : []), ...(o.allowNet || [])]);
  const isLocal = src.kind === 'url' && !src.live;
  if (allowNet.length && !isLocal) throw Object.assign(new Error(`--allow-net / --allow-cdn apply to a local page (http://localhost:<port>/...) only; ${src.kind === 'archive' ? 'an archive is replayed offline' : 'a live page already has the network'}`), { code: 'bad_arguments' });
  const args = [...(src.kind === 'archive' ? BLACKHOLE_ARGS : isLocal ? localArgs(allowNet, { map: o._testHostMap }) : []), ...(o.args || [])];
  if (!o._retake) log(`look: ${src.kind === 'archive' ? `archive ${src.archive}` : src.url} · ${action}${aimed ? ` · ${o.el}` : ''} · virtual clock ${rate} Hz`);
  const S = await openSession({
    lane: 'hx', rate, engine: o.engine || defaultEngine(), cls, args, prefs: noUdpPrefs(o.prefs), timerFlag: o.timerFlag !== false, keepalive: o.keepalive !== false, ...(colorScheme ? { colorScheme } : {}),
    ...(src.kind === 'archive' ? { target: src.target } : { url: src.url, live: src.live, viewport: o.viewport || { width: 1440, height: 900 }, seed: 1 }),
    discover: !aimed, aim: aimed ? { selectors: sels, pseudos: aim.pseudos } : null, maxElements: o.maxElements, capPolicy: aimed ? null : 'viewport',
    netGate: o.netGate !== false, cpuThrottle: o.cpuThrottle ?? (+process.env.REVA_CPU_THROTTLE || 0),
    // the session cache: the first take's responses, recorded passively for the stability re-take (src/look/cache.js)
    ...(cache ? { recordHar: cache.recordHar } : {}),
  });
  // the scripts this page loads, for the library check (bodies are read after the take; a listener only, nothing runs in the page)
  const scripts = o.libs !== false && !o._retake ? collectScripts(S.page) : null;
  // a local page: count what the sinkhole refuses, so a blocked CDN library is reported, never silent
  const localWatch = isLocal ? watchBlocked(S.page) : null;
  // o.signal (an AbortSignal, e.g. the MCP's notifications/cancelled): closing the browser makes the take fail fast
  const onAbort = () => { S.close().catch(() => {}); };
  if (o.signal) { if (o.signal.aborted) { await S.close(); throw Object.assign(new Error('look: cancelled'), { code: 'cancelled' }); } o.signal.addEventListener('abort', onAbort, { once: true }); }
  // an invalid selector is a usage error, said before the page loads (never "no element matches")
  for (const [what, sel] of [['--el', aimed ? o.el : null], ...(aim && aim.hasPseudo ? sels.map((x) => ['--el', x]) : []), ['--on', o.on ? parseTrigger(o.on).selector : null], ['--after', o.after || null]]) {
    if (!sel) continue;
    const why = await S.page.evaluate((x) => { try { document.createDocumentFragment().querySelector(x); return null; } catch (e) { return String(e && e.name); } }, sel).catch(() => null);
    if (why) { await S.close(); throw Object.assign(new Error(`${what} "${sel}" is not a valid CSS selector`), { code: 'bad_arguments' }); }
  }
  // no UDP for any source (archive, local or live): the catch-all route, the DNS sinkhole and the dead proxy stop TCP only,
  // so an archived third-party script could otherwise still send STUN to any IP literal (WEBRTC_PREFS + NO_UDP_APIS_SCRIPT)
  try { await S.ctx.addInitScript({ content: NO_UDP_APIS_SCRIPT }); } catch (e) { await S.close(); throw e; }
  if (o.onSession) { try { await o.onSession(S); } catch (e) { await S.close(); throw e; } } // e.g. the MCP's request guard for live pages (src/mcp/guard.js)
  // the gate checked the typed URL and its HTTP redirects; a meta refresh, a script setting location or a clicked link can
  // still send the browser on: every main-frame navigation is checked against robots.txt too, and a refusal stops the look
  const guard = safety ? navigationGuard(src.url, { ignoreRobots: !!o.ignoreRobots, who: o.safetyWho === 'mcp' ? 'mcp' : 'cli', fetchImpl: o.preflightFetch, seed: safety.robotsTexts, log }) : null;
  if (guard) { try { await guard.attach(S.page, { onBlock: () => { S.close().catch(() => {}); } }); } catch (e) { await S.close(); throw e; } }
  // the stability re-take of a URL: every response from the first take's cache, anything else aborted (registered last,
  // so it runs before the guards; nothing new reaches them or the network)
  let cacheNet = null;
  if (o._retake && o._retake.cache) { try { cacheNet = await wireCacheReplay(S.ctx, o._retake.cache); } catch (e) { await S.close(); throw e; } }
  // a main-frame navigation that ends on the browser's error page (a script sent the page to a dead host or a refused
  // port, or the MCP guard / robots guard aborted it) leaves nothing to measure: stop at once instead of waiting for a
  // page that will never be ready
  let lastNavFail = null; let navFailed = null;
  const isMainFrame = (fr) => { try { return fr === S.page.mainFrame(); } catch { return false; } };
  S.page.on('requestfailed', (r) => { try { if (r.isNavigationRequest() && isMainFrame(r.frame())) lastNavFail = { url: r.url(), why: (r.failure() && r.failure().errorText) || 'failed' }; } catch { /* closed */ } });
  S.page.on('framenavigated', (fr) => {
    if (navFailed || !isMainFrame(fr)) return;
    let u = ''; try { u = fr.url(); } catch { return; }
    if (!/^chrome-error:/i.test(u)) return;
    navFailed = lastNavFail || { url: null, why: 'error page' };
    S.close().catch(() => {});
  });
  const navError = () => {
    let shown = navFailed.url; try { const x = new URL(navFailed.url); shown = x.origin + x.pathname; } catch { /* keep */ }
    let typed = false; try { typed = !!src.url && new URL(navFailed.url).href.split('#')[0] === new URL(src.url).href.split('#')[0]; } catch { typed = false; }
    if (typed) return Object.assign(new Error(`look: could not load ${shown.slice(0, 200)} (${String(navFailed.why).slice(0, 80)}).`), { code: 'navigation_failed' });
    return Object.assign(new Error(`look: the page sent the browser to ${shown ? shown.slice(0, 200) : 'an address'} and it could not be loaded (${String(navFailed.why).slice(0, 80)}); nothing left to measure, so REVA stopped.`), { code: 'navigation_failed' });
  };
  // readiness inputs: requests in flight (without the session network gate: a request older than 3 s wall is a long poll / stream and does not count)
  const flight = new Map();
  S.page.on('request', (r) => flight.set(r, Date.now())); S.page.on('requestfinished', (r) => flight.delete(r)); S.page.on('requestfailed', (r) => flight.delete(r));
  // (with the session network gate: the gate's own count, so readiness and virtual time agree on what is still loading)
  const pending = S.netInFlight || (() => { const now = Date.now(); let n = 0; for (const t of flight.values()) if (now - t < 3000) n++; return n; });
  // the page's own scripts, styles and documents that failed to arrive at the connection level (src: a URL; an archive
  // replays): without them the page does not run as it does (measured: under load a local server reset main.js's imports
  // and the look found 1 motion of 12), so the look is started again, up to LOAD_RETRIES times (runLookRestart)
  const ownFailed = [];
  let ownHost = null; try { ownHost = src.kind === 'url' ? new URL(src.url).host : null; } catch { ownHost = null; }
  if (ownHost) S.page.on('requestfailed', (r) => { try { const t = r.resourceType(); const why = (r.failure() && r.failure().errorText) || ''; if (/^(script|stylesheet|document)$/.test(t) && new URL(r.url()).host === ownHost && TRANSIENT_NET.test(why)) ownFailed.push({ url: r.url().slice(0, 300), type: t, why }); } catch { /* closed */ } });
  // any other script or stylesheet (a CDN library too) that failed to load for another reason than the local sinkhole (counted by watchBlocked): a
  // page whose library import fails runs its static fallback, and every scroll law then reads as plain layout. Said, so a
  // "box y only" look is never mistaken for the page's motion
  const loadFails = new Map();
  S.page.on('requestfailed', (r) => { try {
    const t = r.resourceType(); if (t !== 'script' && t !== 'stylesheet') return;
    const why = (r.failure() && r.failure().errorText) || 'failed'; if (/ERR_NAME_NOT_RESOLVED|ERR_PROXY_CONNECTION_FAILED|ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(why)) return;
    const u = new URL(r.url()); const k = u.origin + u.pathname; if (!loadFails.has(k) && loadFails.size < 20) loadFails.set(k, { url: k.slice(0, 200), type: t, why: String(why).slice(0, 60) });
  } catch { /* closed */ } });
  if (action !== 'load') await S.ctx.addInitScript({ content: LISTEN_HOOK });
  mark('launch');
  let take, dir, aimIds = null, actInfo = {}, afterInfo = null, ready = null, pageProbe = false, actStartT = null, netGate = null, shot = null, libEv = null, restRaw = null;
  const shotM = [];   // scroll: viewport pictures on the way down
  let shotB = null, shotE = null, shotP = null;   // screens (src/look/screens.js): before the action, end of the take, full page (scroll)
  let lenisRead = null;   // declared Lenis options (read-only probe, src/look/lenis.js), once after the action
  const libReads = [];    // declared Swiper / Lottie / Locomotive / anime.js values (src/look/libprobe.js), same two moments
  const gsapReads = [];   // declared GSAP tweens (read-only probe, src/look/gsap.js): after load, after the action
  try {
    await S.goto();
    if (o.quietStart !== false && !process.env.REVA_NOQUIET) await quietBeforeStart(S, { pending });
    await S.boot({ until: 'document.readyState === "complete"', maxMs: o.bootMaxMs ?? 120000, maxVirtualMs: 30000, thenMs: 0 });
    if (o.gsap !== false && !o._retake) gsapReads.push(await readGsap(S.page, 'load'));
    if (o.libprobe !== false && !o._retake) libReads.push(await readLibs(S.page, 'load'));
    // a cookie banner the preflight recognised: click its reject button (never accept); a load take keeps the banner
    // closing. Tried after boot, and again once the page is ready (a consent script often adds the banner late).
    const rejectConsent = async () => {
      if (!safety || !safety.consent.clicks.length || safety.consent.clicked.length) return;
      try { safety.consent.clicked = await S.evRetry(clickRejectInPage, safety.consent.clicks); } catch { safety.consent.clicked = []; }
      if (safety.consent.clicked.length) { log(`cookie banner: clicked ${safety.consent.clicked.join(', ')}`); await S.hold(400); }
    };
    await rejectConsent();
    const trigSel = action === 'hover' || action === 'click' ? parseTrigger(onSel || sels[0]).selector || null : null;
    // a load take records from the start (the load IS the action); every other action waits for the page to be ready
    // the --el element must exist first only when a point is the trigger (it is the thing that reacts, e.g. a cursor);
    // with a selector trigger it can appear because of the action (a tooltip, the next page's heading after a click)
    const needEl = (action === 'hover' || action === 'click') && !!parseTrigger(onSel || sels[0]).point;
    if (action !== 'load') {
      // a scroll waits for the aimed elements' entrance animations too: a scroll begun mid-entrance reads the load tween,
      // and the scrubbed law that takes over afterwards is lost under it; an aimed element the page builds late (split
      // text, rows) is waited for, up to 5 s of page time; with --after the trigger may only exist once that click is done
      ready = await settle(S, { pending, aim: sels, needAim: needEl || (action === 'scroll' && aimed), aimWaitMs: action === 'scroll' && aimed && !needEl ? 5000 : null, trigger: o.after ? null : trigSel, maxWallMs: o.settleMaxMs ?? 60000, pageQuiet: !aimed, waitAnims: action === 'scroll' });
      await rejectConsent();
      await S.hold(500);
    }
    mark('boot');
    // (checked again after the action: a lazily imported module can fail later)
    if (ownFailed.length && (o._loadRetries || 0) < LOAD_RETRIES) throw Object.assign(new Error(`the page's own ${ownFailed[0].type} ${ownFailed[0].url} failed to load (${ownFailed[0].why})`), { code: 'load_restart', failed: ownFailed.slice(0, 5) });
    // click: bring the target into view BEFORE the recording of the action starts (the page probe, the aim), and wait until it
    // rests: the recorder's own scroll-into-view is not the click's scroll, and a smoothed page (Lenis) keeps drifting after it
    if (action === 'click' && trigSel && !o.after && !/^auto:\d+$/.test(trigSel)) {
      const jumped = await S.evRetry((q) => { const el = document.querySelector(q); if (!el) return false; const sy = scrollY, sx = scrollX; el.scrollIntoView({ block: 'center', behavior: 'instant' }); return scrollY !== sy || scrollX !== sx; }, trigSel);
      if (jumped) {
        let last = null, still = 0;
        for (let i = 0; i < 30 && still < 3; i++) {
          await S.hold(100);
          const y = await S.evRetry((q) => { const el = document.querySelector(q); return el ? `${Math.round(el.getBoundingClientRect().y * 4)}|${Math.round(scrollY * 4)}` : null; }, trigSel);
          still = y === last ? still + 1 : 0; last = y;
        }
      }
    }
    if (rateAuto) {
      const cover = await measureCanvasCover(S);
      if (cover && cover.maxCover > CANVAS_COVER_60HZ) throw Object.assign(new Error(`a canvas covers ${Math.round(cover.maxCover * 100)} % of the viewport: record at 60 Hz`), { code: 'rate_restart', cover });
    }
    // the design pass starts here, beside the take: after the take's page load and readiness (the part of the take that
    // waits on the wall clock and the server), so the two page loads do not compete; REVA_DESIGN_SERIAL=1 runs it after
    // the take as before (timing A/B)
    if (o.design !== false && !o._retake && o._designRun && !o._designRun.run && !process.env.REVA_DESIGN_SERIAL) {
      try { o._designRun.run = startDesign({ src, cls, o, allowNet, guard, safety, log }); } catch { /* not started: it runs after the take instead */ }
    }
    // --after <selector>: click that first (a card that opens a viewer, a toggle that builds the panel), let the page settle,
    // and only then start recording the aimed element(s) and do the action: motion that exists only after a click
    if (o.after) {
      await S.click({ target: o.after, hoverMs: CLICK_HOVER_MS, pressMs: 100, holdMs: o.afterHoldMs ?? 1200, quiet: true, quietPress: false });
      afterInfo = { selector: o.after, settle: await settle(S, { pending, aim: sels, needAim: needEl, trigger: trigSel, maxWallMs: o.settleMaxMs ?? 60000, pageQuiet: !aimed, waitAnims: action === 'scroll' }) };
      await S.hold(500);
      if (!afterInfo.settle.ok) log(`look: after ${o.after}: the page may not have settled (${afterInfo.settle.unmet.join('; ')})`);
    }
    // trigger search: hover / click aimed at an element that cannot be the trigger as it is (missing, hidden, no size,
    // never hit once scrolled into view): find the control that changes it, and start again with that (look.json
    // action.triggerSearch says what was tried and chosen)
    const searchable = aimed && (action === 'hover' || action === 'click') && !o.on && o.triggerSearch !== false && (o._triggerTries || 0) < TRIGGER_RESTARTS;
    const search = async (why) => {
      const st = await S.evRetry(triggerCandidatesInPage, [sels, trigSel, TRIGGER_PROBES + 4]).catch(() => null);
      if (!st) return null;
      const status = why || st.status;
      const found = st.candidates.length ? await findTrigger(S, { action, sels, cands: st.candidates, status }) : { none: true, tried: [] };
      const info = { status, after: o.after || null, candidates: st.candidates.length, tried: found.tried, chosen: found.none ? null : { ...(found.on ? { on: found.on } : {}), ...(found.after ? { after: found.after } : {}), why: found.why } };
      if (!found.none) throw Object.assign(new Error('look: trigger found'), { code: 'trigger_restart', found, search: info });
      // nothing found, but the probes clicked and scrolled the page (a menu may now cover it): the measured take must not
      // go on in that page, so the look starts again from a fresh page with the search off (the plain action as asked)
      if (found.tried.length) throw Object.assign(new Error('look: no trigger found'), { code: 'trigger_restart', found, search: info });
      return info;
    };
    let searchInfo = null, status0 = null, revealWait = null, matchTried = null;
    if (searchable) {
      let st = await S.evRetry(triggerCandidatesInPage, [sels, trigSel, 0]).catch(() => null);
      // shown and sized but transparent: a reveal that has not run yet. Bring it into view, let it run, and check again;
      // only one still transparent then is hidden
      if (st && st.status === 'transparent') {
        await S.evRetry(([aim, trig, i]) => { const q = (s) => { try { return [...document.querySelectorAll(s)]; } catch (e) { return []; } }; const els = trig ? q(trig) : [...new Set(aim.flatMap(q))]; const el = els[i]; if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' }); }, [sels, trigSel, st.reveal]).catch(() => null);
        const w = await aimStable(S, sels, { reveal: true });
        st = await S.evRetry(triggerCandidatesInPage, [sels, trigSel, 0, { settled: true }]).catch(() => st);
        revealWait = { ms: w.ms, stable: w.stable, status: st && st.status };
      }
      status0 = st && st.status;
      // only a target the action cannot reach at all (missing, hidden) is searched for before the action; a target that
      // is shown but covered (a transparent scrim over a card, whose :hover still reaches it) gets the plain action first,
      // and the search only if it did not react (below)
      if (status0 === 'missing' || status0 === 'hidden') searchInfo = await search(status0);
    }
    const aimState0 = searchable && !searchInfo ? await S.evRetry(aimStateInPage, sels).catch(() => null) : null;
    if (aimed) await S.aimOn();
    // page-level scroll: the root element's box follows the document scroll, so its fit against the wheel is the page's
    // own smoothing (Lenis, native, ...) even when no element is aimed at
    // ... and when the aimed element IS the root (--el html): its box is the page scroll, reported as the page line;
    // a click probes it too (an anchor link, a rail button: the click scrolls the page)
    if ((action === 'scroll' && (!aimed || await aimsAtRoot(S, o.el))) || action === 'click') pageProbe = (await S.watch(['html'])) > 0;
    // the rest state just before the action (a load: after boot, small pixel-check frame only); never fails the look
    if (!o._retake) shotB = await shotBefore(S, { file: action !== 'load' }).catch(() => null);
    const tAct = await S.evRetry(() => performance.now()); actStartT = tAct;
    // page height around a scroll: scroll-linked values (a map's start and amplitude) depend on it, and lazy content can
    // grow the page during the take, so two runs can differ (measured on a real site); look.json and the text say so
    const pageH = () => S.evRetry(() => document.documentElement.scrollHeight).catch(() => null);
    const h0 = action === 'scroll' ? await pageH() : null;
    // hover / click: the rest pose before the action (after it the pointer still holds the hovered or pressed state)
    if (action !== 'load' && !o._retake) restRaw = await S.evRetry(restPoseInPage, [400, REST_ANCESTORS]).catch(() => null);
    actInfo = await act(S, { ...o, on: onSel, action, midShots: o._retake ? null : shotM }, sels);
    if (action === 'scroll') actInfo = { ...actInfo, pageHeight: { start: h0, end: await pageH() } };
    // hover / click on an aimed element that did not react: act once more after a further settle (the page may have
    // wired its listeners after the first input); the take keeps both, and look.json says so
    if (aimed && (action === 'hover' || action === 'click') && o.retry !== false) {
      await S.drain(); const ids = await S.aimIds();
      if (ids.length && !movedSince(S.data.rows, ids, tAct)) {
        const again = await settle(S, { pending, aim: sels, needAim: needEl, trigger: trigSel, maxWallMs: 5000, maxVirtualMs: 5000 });
        if (actInfo.trigger && actInfo.trigger.point) await S.pointer(actInfo.trigger.point.x + 3, actInfo.trigger.point.y + 3);
        const tAgain = await S.evRetry(() => performance.now());
        const second = await act(S, { ...o, on: onSel, action }, sels);
        actInfo = { ...second, retried: { atMs: Math.round(tAgain), firstAtMs: Math.round(tAct), settle: again, why: `no --el element changed after the first ${action}; waited for the page again and repeated it` } };
      }
    }
    // ... and an aimed element that did not react to the action, nor to its repeat: look for the control that changes it
    if (searchable && !searchInfo && aimState0) {
      await S.drain(); const ids = await S.aimIds();
      let reacted = !!ids.length && movedClearly(S.data.rows, ids, tAct);
      // a declared CSS transition / animation the action started on the target (or its pseudo-elements) is a reaction,
      // even when no sampled channel carries it (a background-size underline)
      if (!reacted) {
        const descs = await S.evRetry((aim) => { const q = (s) => { try { return [...document.querySelectorAll(s)]; } catch (e) { return []; } }; return [...new Set(aim.flatMap(q))].slice(0, 200).map((e) => window.__WR.desc(e)); }, sels).catch(() => []);
        const b = declaredReaction(S.data.births, descs, tAct);
        if (b) { reacted = true; actInfo = { ...actInfo, reaction: { declared: b.name, on: b.tgt, atMs: Math.round(b.T - tAct) } }; }
      }
      // a click that scrolled the page (an anchor link, a rail button) reacted: the page probe line carries it
      if (!reacted && action === 'click' && pageScrolledAfterPress(S, tAct)) { reacted = true; actInfo = { ...actInfo, reaction: { pageScroll: true } }; }
      // a click on the first match that did nothing: up to 3 other matches (shown, can be hit; a current / selected /
      // disabled one last), each in a fresh page, before any other control is searched
      if (!reacted && action === 'click' && !o.on) {
        let list = o._matchList;
        if (list == null) {
          const lp = S.lastPick && S.lastPick.target === trigSel ? S.lastPick.pick : 0;
          const mt = await S.evRetry(triggerCandidatesInPage, [sels, trigSel, 0, { matchesExcept: lp, maxMatches: 3 }]).catch(() => null);
          list = (mt && mt.matches) || [];
        }
        const tried = o._onMatch ? { selector: o._onMatch, result: 'no reaction' } : { selector: trigSel, pick: S.lastPick ? S.lastPick.pick : 0, result: 'no reaction' };
        if (list.length) throw Object.assign(new Error('look: another match'), { code: 'match_restart', next: list[0], rest: list.slice(1), tried });
        if (o._onMatch) matchTried = [...(o._matchTried || []), tried];
      }
      if (!reacted) searchInfo = await search(status0 && status0 !== 'ok' ? `${status0}, no reaction` : 'no reaction');
    }
    if (searchInfo) actInfo = { ...actInfo, triggerSearch: [...(o._triggerSearch || []), searchInfo] };
    if (revealWait) actInfo = { ...actInfo, revealWait };
    if (o._matchTried || matchTried) actInfo = { ...actInfo, otherMatches: { tried: matchTried || o._matchTried, ...(o._onMatch && !matchTried ? { chosen: o._onMatch } : {}) } };
    mark('action');
    if (aimed) aimIds = await S.aimIds();
    if (ownFailed.length && (o._loadRetries || 0) < LOAD_RETRIES) throw Object.assign(new Error(`the page's own ${ownFailed[0].type} ${ownFailed[0].url} failed to load (${ownFailed[0].why})`), { code: 'load_restart', failed: ownFailed.slice(0, 5) });
    // after the action, before the browser closes: ONE viewport screenshot (the element crops of look.json "position" are cut
    // from it) and the evidence for look.json "libraries" (script bodies, inline scripts, a read-only DOM probe). Neither
    // advances the page clock or writes to the page, and neither is allowed to fail the look.
    if (o.gsap !== false && !o._retake) gsapReads.push(await readGsap(S.page, 'action'));
    if (o.lenis !== false && !o._retake) lenisRead = await readLenis(S.page, 'action');   // always (one evaluate, <= 1 s, never fails the look)
    if (o.libprobe !== false && !o._retake) libReads.push(await readLibs(S.page, 'action'));
    if (!o._retake) { shotE = await shotEnd(S).catch(() => null); shot = shotE ? shotE.png : null; }
    if (scripts) libEv = await gatherEvidence(S.page, scripts).catch((e) => ({ modules: [], skipped: [{ file: 'page', reason: String(e && e.message).slice(0, 80) }], scriptUrls: [], dom: null, inline: 0, bytes: 0, ms: 0, probeError: 'evidence not gathered' }));
    // rest pose (src/look/rest.js): transform / origin / opacity / transformed ancestors of the watched elements, once the page has settled
    if (!restRaw) restRaw = await S.evRetry(restPoseInPage, [400, REST_ANCESTORS]).catch(() => null);
    // scroll: the whole page once, last (rendering beyond the viewport can lay the page out again)
    if (!o._retake && action === 'scroll' && o.pageShot !== false) shotP = await shotPage(S).catch(() => null);
    mark('evidence');
    ({ take, dir } = await S.finish({ scenario: `look-${action}`, extra: { look: { action, el: o.el || null, on: onSel, source: src.kind, ready, retried: actInfo.retried || null } } }));
    mark('record');
    netGate = S.netGateStats();
  } catch (e) {
    if (e && (e.code === 'rate_restart' || e.code === 'load_restart' || e.code === 'trigger_restart' || e.code === 'match_restart')) throw e;
    if (o.signal && o.signal.aborted) throw Object.assign(new Error('look: cancelled'), { code: 'cancelled' });
    if (guard && await guard.settle()) throw guard.error();
    if (navFailed) throw navError();
    throw e;
  } finally { if (o.signal) o.signal.removeEventListener('abort', onAbort); await S.close(); }
  // a navigation committed just before the take closed: its check may still be running
  if (guard && await guard.settle()) { if (dir) fs.rmSync(dir, { recursive: true, force: true }); throw guard.error(); }
  if (navFailed) { if (dir) fs.rmSync(dir, { recursive: true, force: true }); throw navError(); }
  if (o.signal && o.signal.aborted) throw Object.assign(new Error('look: cancelled'), { code: 'cancelled' });

  const missing = (take.inputLog || []).filter((e) => e.kind === 'missing').map((e) => e.target);
  const els = take.els || [];
  const viewport = { width: take.env.innerWidth || 1440, height: take.env.innerHeight || 900 };
  const watched = (take.watch || []).map(([id]) => id);
  // (the root may already be watched for its own class writes, e.g. Lenis adding "lenis-smooth": any watch reason counts)
  const pageId = pageProbe ? ((take.watch || []).find(([id]) => /^HTML\b/.test(els[id] || '')) || [null])[0] : null;
  let candidates = (aimed ? watched.filter((id) => aimIds.includes(id)) : watched).filter((id) => id !== pageId);
  // the scroll action parks the pointer mid-viewport to wheel there: cursor followers chase it (see elementStats)
  const pointer = action === 'scroll' ? { x: viewport.width >> 1, y: viewport.height >> 1 } : null;
  // ranking (not aimed): for hover / click / scroll only what moved from the action on counts; the page's own load
  // motion (a preloader still fading while the tool waited for readiness) is not the action's motion. Fits still use
  // the whole take (a scroll look: from just before the scroll, below).
  // A scroll look aimed at elements chooses their channels the same way: an entrance that played while the tool waited for
  // the page is the load's motion, not the scroll's (and the fit below starts just before the scroll)
  const rankFromAction = action !== 'load' && actStartT != null && (!aimed || action === 'scroll');
  const rankRows = rankFromAction ? take.data.rows.filter((r) => r.T >= actStartT - 1) : take.data.rows;
  const stats = elementStats({ rows: rankRows, ids: candidates, dt: take.dt, viewport, pointer });
  dropStatedPaint(stats, els, dir, action === 'load' ? null : actStartT);
  const selMap = new Map((take.selectors || []).map(([id, s, n, gone]) => [id, [s, n, gone]]));
  // ... and what was already moving in the 300 ms before the action started
  let preMoving = null;
  if (!aimed && action !== 'load' && actStartT != null) {
    const pre = elementStats({ rows: take.data.rows.filter((r) => r.T >= actStartT - 300 && r.T < actStartT - 1), ids: candidates, dt: take.dt, viewport });
    preMoving = new Set([...pre.values()].filter((st) => st.moving.size).map((st) => st.id));
  }
  const pageKey = pageId != null && (valueSpan(take.data.rows, pageId, 'ren:by') || {}).distinct > 1 ? `${pageId}|ren:by` : null;
  // a click that scrolled the page (an anchor link, a scroll-to button): every element's box rides that scroll, which the page
  // row already describes; a box that only follows the page is not an element's own motion, even when aimed at
  const ridesPage = action === 'click' && !!pageKey;
  let plan = planFit({ stats, els, candidates, top: o.top ?? 5, aimed, maxChannels: o.maxChannels ?? LOOK_FIT.maxChannels, maxMembers: o.maxMembers ?? 24, action, channels: o.channels, preMoving, sels: selMap, ridesPage, viewport });
  let picked = null;
  if (!aimed && o.pick) {
    // a key (a printed selector, a member's selector or the descriptor) finds the same motion every run; a rank is
    // only meaningful within one run (readiness timing can reorder the ranking)
    const key = typeof o.pick === 'string' ? o.pick : null;
    const all = planFit({ stats, els, candidates, top: key ? 1e9 : o.pickList ?? 12, aimed: false, maxChannels: 1e9, action, channels: o.channels, preMoving, sels: selMap, ridesPage, viewport });
    let e;
    if (key) {
      const m = all.entries.filter((x) => x.selector === key || x.leadSelector === key || x.desc === key);
      if (m.length > 1) throw new Error(`look --pick: "${key}" names ${m.length} moving elements (${m.map((x) => `${x.desc}${x.box ? ` at ${x.box.x},${x.box.y}` : ''}`).join('; ')}); use --el with a selector`);
      e = m[0];
      if (!e) throw new Error(`look --pick: nothing moving matches "${key}" (${all.entries.length} moving elements: ${all.entries.slice(0, 8).map((x) => x.selector || x.desc).join(', ')})`);
    } else {
      const rank = typeof o.pick === 'number' ? o.pick : o.chooser ? await o.chooser(all.entries) : null;
      e = all.entries.find((x) => x.rank === rank);
      if (!e) throw new Error(`look --pick: no entry ranked ${rank}: ${all.entries.length ? `ranks 1-${all.entries.length} exist in this run` : 'nothing is moving'} (a printed selector or descriptor is a stable key)`);
    }
    picked = { rank: e.rank, key, desc: e.desc, selector: e.selector, box: e.box };
    candidates = e.ids;
    plan = { ...planFit({ stats, els, candidates, aimed: true, maxChannels: o.maxChannels ?? LOOK_FIT.maxChannels, maxMembers: o.maxMembers ?? 24, action, channels: o.channels, sels: selMap, ridesPage, viewport }), pointerDriven: all.pointerDriven, alreadyMoving: all.alreadyMoving };
  }
  // the page's own scroll line (one channel, fitted first): pageKey, above
  const planned = [...(pageKey ? [pageKey] : []), ...plan.onlyKeys];
  // a transform string that changes while the rendered transform does not (translate3d(0px, 0px, 0px) ->
  // translate(0px, 0px)) is not motion: not fitted, reported as such by coverage()
  const still = new Map(); const isStill = (el) => { if (!still.has(el)) still.set(el, renderedTransformStill(take.data.rows, el)); return still.get(el); };
  const noop = new Set(planned.filter((k) => { const [el, ch] = k.split('|'); return /^(drv|ren):transform$/.test(ch) && isStill(el); }));
  let fitKeys = planned.filter((k) => !noop.has(k));
  // the stability re-take fits only the lead channels of the first take's compared motions (matched by selector or
  // descriptor: element ids differ between runs), and only the channels the first take has records for
  let retakeMatch = null;
  if (o._retake) {
    const pool = planFit({ stats, els, candidates, top: 1e9, aimed, maxChannels: 1e9, action, channels: o.channels, preMoving, sels: selMap, ridesPage, viewport }).entries;
    retakeMatch = o._retake.motions.map((m) => ({ rank: m.rank, entry: matchEntry(m, pool) }));
    fitKeys = retakeMatch.flatMap(({ rank, entry }) => (entry ? o._retake.motions.find((m) => m.rank === rank).channels.map((c) => `${entry.lead}|${c}`) : []));
  }
  mark('select');

  // fit: pass 1, then the deferred translate parts of declared transforms that pass 1 did not explain
  // (the re-take keeps these budgets: a channel's fit depends on its budget, and the two runs must be fitted alike; it
  // has fewer channels, so it spends less)
  const fitOpts = { ...LOOK_FIT, maxChannels: o.maxChannels ?? LOOK_FIT.maxChannels, earlyExit: true,
    ...(o.fitBudget ? { evalBudget: o.fitBudget, channelEvalBudget: Math.min(LOOK_FIT.channelEvalBudget, o.fitBudget), identifyBudget: Math.min(LOOK_FIT.identifyBudget, o.fitBudget), driverBudget: Math.min(LOOK_FIT.driverBudget, o.fitBudget) } : {}) };
  let res = null; const covered = [];
  if (fitKeys.length) {
    const L = loadTake(dir, SERIES);
    // a scroll look fits from 300 ms before the scroll (the page rested that long: settle): a load entrance recorded while
    // the tool waited is a second motion on the same channel, and the fit spent its budget on the pair (an entrance tween
    // then the scrubbed law that takes over) instead of the scrubbed law
    if (action === 'scroll' && actStartT != null && L.data && Array.isArray(L.data.rows)) L.data.rows = L.data.rows.filter((r) => r.T >= actStartT - 300);
    const split = splitDeclaredTransform(fitKeys, L.data.births, els);
    // declared channels first, then one channel per motion per round, so one slow motion cannot spend the whole budget
    const order = fitOrder(plan.entries, L.data.births, els, { pageKey });
    res = fitTakeSet({ primary: L }, { ...fitOpts, order, declaredFirst: order.declared, onlyKeys: split.first });
    const declaredEls = new Set(res.records.filter((r) => r.tier === 'declared' && /^ren:(sx|sy|rz|skx|tz|tx|ty)$/.test(r.target.channel)).map((r) => String(r.target.el)));
    const pass2 = split.deferred.filter((k) => { if (declaredEls.has(k.split('|')[0])) { covered.push({ key: k, by: 'the declared transform transition of this element' }); return false; } return true; });
    if (pass2.length) res = mergeFits(res, fitTakeSet({ primary: L }, { ...fitOpts, order, onlyKeys: pass2 }));
    // a scroll map is reported over the sampled scroll range: an unobserved corner is never an extrapolated number
    res = { ...res, records: res.records.map((r) => guardPhysical(anchorMapToSamples(r))) };   // opacity stays in 0..1 (exportword.js)
  }
  mark('fit');
  if (o._retake) {
    const first = (take.inputLog || []).find((e) => ((e.type === 'pointer' && e.kind !== 'missing') || e.type === 'wheel') && (actStartT == null || !Number.isFinite(e.T) || e.T >= actStartT - 1));
    return { retake: true, res, dir, take, tAction: first && Number.isFinite(first.T) ? first.T : null, match: retakeMatch, cacheNet, lap };
  }
  const meta = { url: src.kind === 'archive' ? src.target.startUrl : src.url, date: take.started.slice(0, 10), takeName: `look-${action}` };
  // the snippets' unmeasured ends come from the recording, as on the card and over the MCP (one law, one snippet)
  const endsOf = (r) => { try { return recordedEnds(dir, r); } catch { return null; } };
  const exRes = res ? (({ records, ...rest }) => ({ ...rest, records: records.map((r) => withRecordedEnds(r, endsOf).rec) }))(forExport(res)) : null;
  const ex = res ? exportFit(exRes, { to: LIBS, meta }) : { items: [], stagger: [] };
  mark('export');

  // every planned channel ends as a record, as covered by another channel, or as an explicit unknown with its reason
  const gaps = res || noop.size ? coverage(planned, res, take.data.rows, covered, els, noop) : [];

  // the fitter attributes a motion to an input from the frames alone (and calls it unknown without an idle-control
  // take); look also knows what it did and when: a motion that starts after the action's first input follows it
  // (inputs before the action itself, the --after click, are not the action's)
  const ofAction = (e) => actStartT == null || !Number.isFinite(e.T) || e.T >= actStartT - 1;
  const firstInput = (take.inputLog || []).find((e) => ((e.type === 'pointer' && e.kind !== 'missing') || e.type === 'wheel') && ofAction(e));
  const tAction = firstInput && Number.isFinite(firstInput.T) ? firstInput.T : null;
  // click = hover, press, release: a line that starts in one of them says which (a :hover transition, a :active press tween
  // and the click handler's own motion are three different things)
  const ptrT = (kind) => { const e = (take.inputLog || []).find((x) => x.type === 'pointer' && x.kind === kind && Number.isFinite(x.T) && ofAction(x)); return e ? e.T : null; };
  const tPress = action === 'click' ? ptrT('mousePressed') : null, tRelease = action === 'click' ? ptrT('mouseReleased') : null;
  const PHASE_TOL = 20;   // ms: a fitted start can sit a frame or two before the event that caused it
  const clickPhase = (t0) => (tPress != null && t0 < tPress - PHASE_TOL ? 'starts on hover, before the press' : tRelease != null && t0 < tRelease - PHASE_TOL ? 'starts on press (button held down)' : 'starts on release (the click)');
  const phaseOf = (l) => (tPress != null && tAction != null && Number.isFinite(l.t0) && l.t0 >= tAction - 1 && (!l.trigger || /^(reacts to the pointer|starts after the click)$/.test(l.trigger)) ? clickPhase(l.t0) : l.trigger);
  const fallbackTrigger = (t0) => (action === 'load' ? 'plays on load' : tAction != null && t0 >= tAction - 1 ? (tPress != null ? clickPhase(t0) : `starts after the ${action}`) : null);
  const lineOf = (l) => ({ text: l.text, kind: l.kind, family: l.family, label: l.label, channels: [...new Set(l.channels)], trigger: phaseOf(l), t0: l.t0, rel: relStart(l.t0, tAction), times: l.times, values: l.values });
  // a font axis line says where the axis goes ('font weight 300 → 800'): the recorded values at the start and end of the
  // line's own motion (the first segment when the motion plays more than once). Scroll maps print their own ends.
  const travelOfLine = (l, recs) => {
    if (!/^(tween|spring|smoothing|asymmetric smoothing|step)$/.test(l.kind)) return null;
    const out = [];
    for (const ch of new Set(l.channels)) {
      const tag = axisOfChannel(ch); if (!tag) continue;
      const pool = recs.filter((r) => r.target.channel === ch && r.model && r.model.family === l.family);
      const rec = pool.sort((a, b) => Math.abs(((a.derived && a.derived.t0) ?? 1e12) - (l.t0 ?? 0)) - Math.abs(((b.derived && b.derived.t0) ?? 1e12) - (l.t0 ?? 0)))[0];
      const e = rec && endsOf(rec); if (!e || !Number.isFinite(e.from) || !Number.isFinite(e.to)) continue;
      out.push({ channel: ch, axis: tag, from: e.from, to: e.to, label: 'fitted', text: travelText(tag, e.from, e.to) });
    }
    return out.length ? out : null;
  };
  const exportsOf = (el) => ex.items.filter((it) => it.el === el).map((it) => {
    const rec = exRes.records.find((r) => r.target.el === it.el && r.target.channel === it.channel) || null;
    return { channel: it.channel, family: it.family, kind: it.kind, model: it.model, notes: it.notes, fit: it.fit, t0: rec && rec.derived && Number.isFinite(rec.derived.t0) ? rec.derived.t0 : null,
      exports: it.exports.map((x) => ({ lib: x.lib, form: x.form || null, code: x.code, accuracy: x.accuracy, note: x.note || null, match: exportWord(rec, it, x, take.rate), ...(x.decl ? { decl: x.decl } : {}) })) };
  });
  // WebGL light (src/look/gl.js): shaders, uniforms and camera from the page's WebGL calls, fitted like DOM channels
  let gl = null;
  try { gl = glPass({ dir, take, fitOpts, rate: take.rate, fallbackTrigger, endsOf, series: SERIES }); } catch (e) { gl = { read: false, error: String(e && e.message).slice(0, 200), lines: [], records: [] }; }
  mark('gl');
  const glEls = new Set(gl && gl.read ? (gl.contexts || []).map((c) => c.el).filter((x) => x != null) : []);
  const glText = 'drawn with WebGL: read from the page\'s WebGL calls (shaders, uniforms, camera: see the WebGL lines)';
  // ---- assemble: one entry per element / folded group
  const ids0 = (e) => (Array.isArray(e.ids) && e.ids.length ? e.ids : [e.lead]);
  // click: the page's own transition births, to tell the hover, the press and the release transitions apart (expandDeclaredBirths)
  let clickBirths = null;
  if (action === 'click') { try { clickBirths = loadTake(dir, ['births']).data.births; } catch { clickBirths = null; } }
  const motions = plan.entries.map((e) => {
    const recs = res ? res.records.filter((r) => r.target.el === e.lead) : [];
    const memberRecs = res && e.kind === 'group' ? res.records.filter((r) => e.ids.includes(r.target.el) && r.target.el !== e.lead) : [];
    const lines0 = describeElement(recs, { fallbackTrigger, oneRate: take.rate });
    // a click line's phase (hover, press, release) is said by phaseOf below, from a null trigger
    const lines = expandDeclaredBirths(lines0, els[e.lead], action === 'click' ? clickBirths : null, action === 'click' ? tAction : null, recs, action === 'click' ? null : fallbackTrigger);
    let stagger = null;
    if (res && e.kind === 'group') {
      // the stagger of THIS group only: onsets of its own members (the fitter's groups can mix elements of other groups)
      const g = groupStagger(res.records.filter((r) => e.ids.includes(r.target.el)), take, viewport);
      if (g) { const d = describeStagger(g, e.count); const xs = exportStagger(g, new Set(LIBS)); stagger = { ...d, group: g, exports: xs.skipped ? [] : xs.exports }; }
    }
    // a group without a fitted stagger: when each member starts (cli prints a few, look.json keeps all)
    const starts = e.kind === 'group' && !stagger ? groupStarts([...recs, ...memberRecs], e.memberChannel) : null;
    // how many fitted members share the lead's motion on the member channel (folding check)
    let share = null;
    if (e.kind === 'group' && e.memberChannel) {
      const fam = (recs.find((r) => r.target.channel === e.memberChannel) || {}).model?.family;
      const ms = memberRecs.filter((r) => r.target.channel === e.memberChannel);
      const byEl = new Map(); for (const r of ms) if (!byEl.has(r.target.el)) byEl.set(r.target.el, r);
      share = { channel: e.memberChannel, family: fam || null, same: [...byEl.values()].filter((r) => r.model && r.model.family === fam).length, fitted: byEl.size };
    }
    // the --el selector stands for a row only when it names exactly that row's elements (a broad --el such as "div"
    // names hundreds: the row then gets its own selector reasoning and a member's selector instead)
    const elIsGroup = (x) => !!(aimIds && aimIds.length === x.count);
    // an aimed scroll look at an element whose box only rides the page (its place in the document never changes): said
    // as layout, never fitted (against the scroll it read the page's own smoothing as the element's law)
    const st0 = stats.get(e.lead);
    const rides = action === 'scroll' && !(e.channels || []).length && !!st0 && st0.moving.has('ren:by') && !st0.docMoving.has('ren:by');
    if (rides) lines.unshift({ kind: 'layout', family: null, label: 'fitted', channels: ['ren:by'], trigger: 'tied to the scroll', t0: null, times: 1, values: [],
      text: 'Rides the page scroll: its box moves 1:1 with the scroll offset and its place in the page never changes (layout, no motion of its own; the page\'s smoothing: --el html) [fitted]' });
    return {
      rank: e.rank, kind: e.kind, desc: e.desc, selector: e.selector ?? (aimed && elIsGroup(e) ? o.el : null), selectorMatches: e.matches ?? null, selectorWhy: e.selector ? e.why || null : aimed && elIsGroup(e) ? 'the --el selector' : e.why || null, leadSelector: e.leadSelector ?? null, selectorGone: !!e.gone,
      box: e.box || null, count: e.count, lead: e.lead, ids: e.ids,
      notice: e.notice || null, starts, weight: e.weight, weightShare: e.weightShare, channels: e.channels, fitted: e.fitted, membersNotFitted: e.membersNotFitted || 0,
      covered: covered.filter((c) => c.key.split('|')[0] === String(e.lead)).map((c) => ({ channel: c.key.split('|')[1], by: c.by })),
      unknowns: gaps.filter((g) => g.el === e.lead),
      lines: lines.map((l) => { if ((l.kind === 'not applicable' || (l.channels || []).includes('*')) && ids0(e).some((id) => glEls.has(id))) return { ...lineOf(l), kind: 'not applicable', text: glText, label: 'measured', trigger: null }; const t = travelOfLine(l, recs); return t ? { ...lineOf(l), travel: t } : lineOf(l); }), stagger, share, records: recs, exports: res ? exportsOf(e.lead) : [],
    };
  });
  attachRest(motions, restRaw);
  const warnings0 = [];
  // hover / click: a fitted line that began before the action, or plays on its own time well after it, is the page's own
  // (load) motion, not the action's result: moved out of `motions` into `notFromAction` (said in the text, kept in look.json)
  const fromAction = [];
  if (action === 'hover' || action === 'click') {
    for (let i = motions.length - 1; i >= 0; i--) {
      const m = motions[i]; const keep = []; const out = [];
      for (const l of m.lines) { let w = notFromAction(l, tAction, action, undefined, tRelease); if (w && o.after) w = { why: w.why.replace('(page load)', '(the --after click or the page load)') }; if (w) out.push({ ...l, why: w.why }); else keep.push(l); }
      if (!out.length) continue;
      m.lines = keep;
      if (!keep.length && !(m.unknowns || []).length && !(m.covered || []).length) {
        motions.splice(i, 1);
        fromAction.unshift({ desc: m.desc, selector: m.selector, lead: m.lead, lines: out.map((l) => ({ text: l.text, t0: l.t0, channels: l.channels, why: l.why })) });
      } else m.beforeAction = out.map((l) => ({ text: l.text, t0: l.t0, channels: l.channels, why: l.why }));
    }
  }
  // WebGL scenes as ranked motions (rank.js glMotions): a canvas that moves is ranked by its on-screen area like any element;
  // the gl entries join the list by notice score and the ranks are numbered again (plan entries follow, for the crops)
  let glRanked = [];
  if (!aimed && !picked && gl && gl.read) {
    try {
      glRanked = glMotions({ gl, canvases: canvasesOf(shotB, shotE), viewport, action, scrollY: (shotE && shotE.view && shotE.view.scrollY) || 0, sels: selMap });
      for (const g of glRanked) g.lines = g.lines.map((l) => ({ ...l, rel: relStart(l.t0, tAction) }));
      if (glRanked.length) { const map = mergeRanked(motions, glRanked); for (const e of plan.entries) if (map.has(e.rank)) e.rank = map.get(e.rank); }
    } catch (e) { warnings0.push(`WebGL scenes could not be ranked: ${String(e && e.message).slice(0, 120)}`); glRanked = []; }
  }
  let page = null;
  if (pageKey && res) {
    const recs = res.records.filter((r) => r.target.el === pageId);
    page = { el: pageId, desc: els[pageId], channel: 'ren:by', lines: describeElement(recs, { oneRate: take.rate }).map((l) => (action === 'click' && tPress != null && Number.isFinite(l.t0) && l.t0 >= tAction - 1 ? { ...lineOf(l), trigger: clickPhase(l.t0) } : lineOf(l))), unknowns: gaps.filter((g) => g.el === pageId), records: recs, exports: exportsOf(pageId) };
  }
  // what the take itself says about coverage: the moving set cap (big pages), the readiness wait, the retry
  const capped = take.c && take.c.watchOverflow ? { cap: take.cfg.maxElements, notSampled: take.c.watchOverflow, evicted: take.c.watchEvicted || 0 } : null;
  const warnings = [...warnings0];
  // a local page: what the sinkhole refused (a CDN library that did not load) and what the person allowed, said out loud
  const localNet = localWatch ? describeLocalNet(allowNet, localWatch.summary()) : null;
  if (localNet) warnings.push(...localNet.warnings);
  const failList = (l) => { const u = [...new Set(l.map((f) => `${f.type} ${f.url.split('/').pop() || f.url} (${f.why})`))]; return u.slice(0, 3).join(', ') + (u.length > 3 ? ` and ${u.length - 3} more` : ''); };
  if (o._loadRetries) warnings.push(`the page's own ${failList(o._loadRetry)} failed to load (a busy server): the look was started again ${o._loadRetries === 1 ? 'once' : `${o._loadRetries} times`}${ownFailed.length ? '' : ' and the page then loaded completely'}`);
  if (ownFailed.length) warnings.push(`the page's own ${failList(ownFailed)} failed to load${o._loadRetries ? ' in the last attempt too' : ''}: the page did not run as it does, so motion can be missing; run the look again when the server is less busy`);
  // other failed scripts / stylesheets; the page's own ones already said above are not said twice
  { const ownKeys = new Set(ownFailed.map((f) => { try { const u = new URL(f.url); return u.origin + u.pathname; } catch { return f.url; } }));
    const f = [...loadFails.values()].filter((x) => !ownKeys.has(x.url));
    if (f.length) warnings.push(`${f.length} script / stylesheet request(s) failed to load (${f.slice(0, 3).map((x) => `${x.url} ${x.why}`).join('; ')}${f.length > 3 ? '; …' : ''}): the page may have run without that code, so motion it drives can be missing; run the look again`); }
  if (ready && !ready.ok) warnings.push(`the page may not have been ready when the ${action} started (waited ${r1(ready.wallMs / 1000)} s: ${ready.unmet.join('; ')})`);

  const ph = actInfo.pageHeight;
  if (ph && ph.start > 0 && ph.end > 0 && Math.abs(ph.end - ph.start) / ph.start > 0.01) warnings.push(`the page ${ph.end > ph.start ? 'grew' : 'shrank'} from ${ph.start} to ${ph.end} px during the scroll (content loaded as it scrolled): scroll-linked values depend on the page height and can differ between runs`);
  if (capped) warnings.push(`the page has more moving elements than the ${capped.cap} watched (${capped.notSampled} not sampled${capped.evicted ? `, ${capped.evicted} off-screen ones swapped for on-screen ones` : ''}): the ranking can miss motion${aimed ? '; a narrower --el watches fewer' : '; use --el to aim at one'}`);
  // moved: anything changed, except a transform string switching between equivalent forms (nothing moved on screen)
  const moved = candidates.some((id) => { const st = stats.get(id); return st && [...st.moving].some((c) => !(/^(drv|ren):transform$/.test(c) && isStill(id))); });
  // paint-only motion (colour, background, shadow): not sampled, but the page declares it (exact timing, easing, end values)
  let declared = [];
  try {
    declared = declaredOnly(loadTake(dir, ['births']).data.births, { descs: aimed ? new Set((aimIds || []).map((id) => els[id])) : null, fromT: action === 'load' ? null : actStartT, max: aimed ? 8 : 6 }).map((d) => ({ ...d, selector: aimed ? o.el : null }));
    if (declared.length && res) fillMeasuredFontEnds(declared, res.records, endsOf);
  } catch (e) { warnings.push(`declared colour / shadow transitions could not be read: ${String(e && e.message).slice(0, 120)}`); }
  if (actInfo.retried) warnings.push(`${declared.length ? 'no sampled channel of the aimed element(s) changed in' : 'nothing aimed reacted to'} the first ${action}; it was repeated after the page settled again (at ${actInfo.retried.atMs} ms)`);
  const glMoves = !!(gl && gl.lines && gl.lines.some((l) => !['shader', 'unknown', 'camera'].includes(l.kind)));
  const aimedGl = aimed && (aimIds || []).some((id) => glEls.has(id));
  if (aimedGl && !moved && glMoves) { /* the canvas itself does not move: what it draws is in the WebGL lines */ }
  else if (aimed && aimIds.length && !moved && !declared.length && !page) warnings.push(`the --el element(s) matched (${aimIds.length}) but did not change during the ${action}: the ${action} may have run before the page was ready, or this element does not react to it`);
  if (gl && gl.error) warnings.push(`WebGL calls could not be read: ${gl.error}`);
  if (!aimed && !plan.entries.length && !page && !declared.length && !glMoves) warnings.push(`nothing moved during the ${action}`);
  // stability: the same action once more in a fresh browser, served from the session cache, fitted on the compared
  // motions only; each is marked stable or varies (look.json "stability"; one printed line when it varies). It runs
  // while the design pass is still going, so it mostly hides behind it.
  const stability = await runRetake({ o, src, action, motions, take, dir, tAction, lap, safety, cache });
  mark('retake');
  // design: how the page is designed (type, colour, spacing, layout, breakpoints, hover / focus), from a static session of
  // its own in a second browser (src/design/pass.js); o.design === false skips it (--no-design)
  let design = null;
  if (o.design !== false) {
    // started beside the take (startDesign above); started only now with REVA_DESIGN_SERIAL=1
    const run = (o._designRun && o._designRun.run) || startDesign({ src, cls, o, allowNet, guard, safety, log });
    if (o._designRun) o._designRun.run = run;
    design = await finishDesign(run, dir);
    mark('design');
    if (design && design.timing) design.timing = { ...design.timing, parallel: !process.env.REVA_DESIGN_SERIAL, waitedMs: lap.design };
    // the design load was sent to a URL robots.txt disallows (the same page, so the look stops as the take would have)
    if (design.code === 'blocked_robots') { fs.rmSync(dir, { recursive: true, force: true }); throw (run.guard || guard).error(); }
    if (design.ok === false) warnings.push(design.error);
  }
  const totalMs = Date.now() - T0;
  const errors = [...(missing.length ? [`trigger not found: ${missing.join(', ')}`] : []), ...(aimed && !aimIds.length ? [`no element matches --el ${o.el}`] : [])];
  // something is reported only when there is something to show: a ranked motion, the page scroll, or a declared paint change.
  // (A page whose elements were all moving before the action, or follow the pointer, has `moved` true and nothing to report.)
  const found = (motions.length > 0 && moved) || !!page || declared.length > 0 || glMoves;
  // element positions (boxes at the start and the end of each motion, from the recorded frames) and their crops
  const positions = motionPositions({ entries: plan.entries, stats, rows: take.data.rows, viewport });
  for (const g of glRanked) {
    const sy = (shotE && shotE.view && shotE.view.scrollY) || 0;
    positions.set(g.rank, { schema: POSITION_SCHEMA, label: 'measured', unit: 'css px, relative to the recorded viewport (getBoundingClientRect of the canvas)', viewport: { width: viewport.width, height: viewport.height },
      start: null, end: { ...g.box, t: null, scroll: { x: 0, y: sy } }, endBoxLast: g.box, what: 'the canvas box at the end of the take, read in the page' });
  }
  const cropFiles = cropsFor({ positions, screenshot: shot, viewport, fileFor: (rank) => `crops/m${rank}.png` });
  if (o.write === false) for (const p of positions.values()) if (p && p.image && p.image.path) { p.image.path = null; p.image.reason = 'look.json was not written (write: false)'; }
  for (const m of motions) m.position = positions.get(m.rank) || null;
  let libraries = null;
  if (libEv) {
    libraries = detectFrom(libEv);
    libraries.mechanisms = mechanismsOf({ motions, page, declaredOnly: declared }, libraries);
  }
  // declared GSAP values joined with the fits; a matched tween's gsap code becomes the page's declaration
  const gs = gsapReads.length ? lookGsap(gsapReads, res ? res.records : [], cls) : null;
  if (gs) attachGsap(motions, gs.gsap, gs.doc);
  const declaredLibs = libReads.length ? lookLibs(libReads) : null;
  const animeRest = declaredLibs ? attachAnime(motions, declaredLibs) : null;
  const result = {
    schema: LOOK_SCHEMA, ok: !errors.length && found,
    status: errors.length ? 'error' : found ? 'motion' : 'no-motion',
    errors, warnings,
    // demo: REVA's bundled demo page (reva demo, compare "demo", the MCP fixture "demo"): the card calls it by that name
    source: src.kind === 'archive' ? { kind: 'archive', archive: src.archive, startUrl: src.target.startUrl, target: src.target.id || null } : { kind: 'url', url: src.url, live: src.live, ...(o.demo && !src.live ? { demo: true } : {}) },
    action: { do: action, el: o.el || null, on: onSel, after: afterInfo ? afterInfo.selector : null, picked, ...(o._triggerSearch ? { triggerSearch: o._triggerSearch } : {}), ...actInfo },
    safety,
    network: localNet ? localNet.net : { mode: src.kind === 'archive' ? 'archive' : 'live' },
    ready,
    take: { dir, lane: take.lane, rate: take.rate, rateRule: o._rateRule ? { rule: 'a canvas covers more than 30 % of the viewport: 60 Hz', ...o._rateRule } : null, frames: take.data.rows.length, watched: watched.length, aimMatches: aimIds ? aimIds.length : null, capped,
      net: { misses: src.kind === 'archive' ? take.net.misses : null, blocked: take.net.blocked, docStatus: take.net.docStatus }, netGate, frameClock: (take.extra && take.extra.frameClock) || null,
      stepWallMsMedian: median(take.stepWall), pageErrors: (take.pageErrors || []).length,
      // only when --color-scheme was given: what was asked and what prefers-color-scheme matched in the page
      ...(take.context && take.context.colorScheme ? { colorScheme: { requested: take.context.colorScheme, read: (take.env && take.env.colorScheme) || null, label: 'measured' } } : {}) },
    timing: { totalMs, lap, screensMs: { before: shotB ? shotB.ms : null, end: shotE ? shotE.ms : null, page: shotP ? shotP.ms : null } },
    fit: res ? { partial: !!res.partial, flags: res.flags, capped: res.capped, records: res.records.length, unknowns: res.unknowns.length, budget: fitOpts } : null,
    page,
    motions,
    declaredOnly: declared,
    gl,
    unknowns: gaps,
    pointerDriven: (plan.pointerDriven || []).map((p) => ({ ...p, why: 'follows the pointer the tool parked mid-viewport to scroll (cursor follower), not the scroll' })),
    notFromAction: fromAction,
    alreadyMoving: (plan.alreadyMoving || []).map((p) => ({ ...p, why: `already moving in the 300 ms before the ${action} (page load or an ambient loop)` })),
    others: plan.rest.map((e) => ({ rank: e.rank + glRanked.length, notice: e.notice || null, desc: e.desc, selector: e.selector, selectorWhy: e.why || null, leadSelector: e.leadSelector ?? null, selectorGone: !!e.gone, box: e.box || null, count: e.count, weightShare: e.weightShare })),
    notFitted: plan.notFitted,
    design,
    libraries,
    gsap: gs ? gs.gsap : null,
    lenis: lenisRead ? lookLenis(lenisRead) : null,
    declaredLibs, animeRest,
    stability,
    screens: screensOf({}),
  };
  if (o.write !== false) {
    const slug = (aimed ? o.el : picked ? picked.desc : 'top').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
    const out = o.outDir || ensureOutDir('look', `${take.started.replace(/[:.]/g, '-')}_${action}_${slug}`);
    fs.mkdirSync(out, { recursive: true });
    if (res) fs.writeFileSync(path.join(out, 'fit.json'), JSON.stringify(res, null, 1));
    result.dir = out;
    // screens (look.json "screens"): the end-of-take viewport, the rest state before the action, the full page (scroll)
    const put = (f, b) => { if (!b) return false; try { fs.writeFileSync(path.join(out, f), b); return true; } catch { return false; } };
    const vOf = (sh, file) => (sh && sh.view && put(file, sh.jpg) ? { w: sh.view.w, h: sh.view.h, scrollY: Math.round(sh.view.scrollY * 100) / 100, dpr: sh.view.dpr } : null);
    result.screens = screensOf({ end: vOf(shotE, 'screen-end.jpg'), before: action === 'load' ? null : vOf(shotB, 'screen-before.jpg'), page: shotP && put('page.jpg', shotP.data) ? shotP : null });
    if (shotM.length && shotE && shotE.view) result.screens.mid = shotM.map((m, i) => (put(`screen-mid${i}.jpg`, m.data) ? { file: `screen-mid${i}.jpg`, w: shotE.view.w, h: shotE.view.h, scrollY: m.scrollY } : null)).filter(Boolean);
    if (cropFiles.length) { fs.mkdirSync(path.join(out, 'crops'), { recursive: true }); for (const f of cropFiles) fs.writeFileSync(path.join(out, f.path), f.data); }
    fs.writeFileSync(path.join(out, 'look.json'), JSON.stringify(result, null, 1));
  }
  log(`look: ${r1(totalMs / 1000)} s (launch ${r1(lap.launch / 1000)}, boot+ready ${r1(lap.boot / 1000)}, action ${r1(lap.action / 1000)}, record ${r1(lap.record / 1000)}, fit ${r1(lap.fit / 1000)}${stability && stability.ran ? `, second run ${r1(stability.ms / 1000)}` : ''}${lap.design != null ? `, design ${design && design.timing ? r1(design.timing.ms / 1000) : '?'}${process.env.REVA_DESIGN_SERIAL ? '' : ` beside the take, waited ${r1(lap.design / 1000)}`}` : ''})`);
  return result;
}

/**
 * The stability re-take: the same action once more, in a fresh browser (lookOnce with `_retake`), served from the session
 * cache for a URL (an archive replays itself), so the network cannot make the two runs differ. Only the top motions with a
 * fitted record are compared (RETAKE_MOTIONS), and the re-take fits only their lead channels (with the same fit budgets). Bounded:
 * skipped when it would not fit the budget or the deadline (retakePlan), stopped at RETAKE_MAX_MS (its browser is closed).
 * It never fails the look: a failure is said in look.json "stability" in our words (a code, never the page's text). Its
 * take folder is removed once compared; the look's own cancel / deadline still ends the look.
 */
async function runRetake({ o, src, action, motions, take, dir, tAction, lap, safety, cache }) {
  const base = { schema: STABILITY_SCHEMA };
  const compared = motions.filter((m) => m.kind !== 'gl' && (m.records || []).some((r) => r.tier !== 'unknown')).slice(0, RETAKE_MOTIONS);
  const estMs = ['launch', 'boot', 'action', 'evidence', 'record'].reduce((s, k) => s + (lap[k] || 0), 0);
  const plan = retakePlan({ retake: o.retake, action, after: o.after, motions: compared.length, estMs, leftMs: (o._deadlineAt ?? Infinity) - Date.now(), cacheReady: !!cache && cache.ready(), srcKind: src.kind });
  if (!plan.run) return { ...base, ran: false, skipped: plan.why };
  const t0 = Date.now();
  const timer = AbortSignal.timeout(RETAKE_MAX_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, timer]) : timer;
  const spec = compared.map((m) => ({ rank: m.rank, desc: m.desc, selector: m.selector, leadSelector: m.leadSelector, box: m.box, channels: [...new Set(m.records.filter((r) => r.tier !== 'unknown').map((r) => r.target.channel))] }));
  // the first take's decisions are kept (rate, trigger, the match that reacted); nothing is searched or restarted again
  const ro = { ...o, signal, rate: take.rate, design: false, write: false, libs: false, pick: false, triggerSearch: false, _matchList: [], _loadRetries: LOAD_RETRIES, log: () => {},
    _retake: { safety: safety ? { ...safety, consent: { ...safety.consent, clicked: [] } } : null, cache: src.kind === 'url' ? cache : null, motions: spec } };
  let R;
  try { R = await lookOnce(ro, Date.now(), null); } catch (e) {
    if (o.signal && o.signal.aborted) throw e;   // the look's own cancel or deadline
    return { ...base, ran: false, skipped: timer.aborted ? `the second run took longer than ${RETAKE_MAX_MS / 1000} s and was stopped` : `the second run failed (${(e && typeof e.code === 'string' && e.code) || 'error'})`, ms: Date.now() - t0 };
  }
  try {
    const live = (rs) => (rs || []).filter((r) => r.tier !== 'unknown');
    const endsIn = (d, r) => { try { return recordedEnds(d, r); } catch { return null; } };
    const first = compared.map((m) => live(m.records).map((r) => recordSummary(r, { tRef: tAction ?? 0, ends: endsIn(dir, r) })));
    const second = compared.map((m) => { const hit = (R.match || []).find((x) => x.rank === m.rank); if (!hit || !hit.entry) return null; return live(R.res ? R.res.records.filter((r) => r.target.el === hit.entry.lead) : []).map((r) => recordSummary(r, { tRef: R.tAction ?? 0, ends: endsIn(R.dir, r) })); });
    const verdicts = compareMotions(compared.map((m, i) => ({ rank: m.rank, desc: m.desc, selector: m.selector, first: first[i], second: second[i] })), { dt: take.dt });
    const net = R.cacheNet ? { served: 'session cache', misses: R.cacheNet.misses, byType: R.cacheNet.byType, sample: R.cacheNet.sample } : { served: src.kind === 'archive' ? 'archive' : 'network' };
    return { ...base, ran: true, ms: Date.now() - t0, frames: R.take.data.rows.length, network: net,
      compared: verdicts.length, stable: verdicts.filter((v) => v.verdict === 'stable').length, varies: verdicts.filter((v) => v.verdict === 'varies').length, motions: verdicts };
  } finally { if (R.dir) fs.rmSync(R.dir, { recursive: true, force: true }); }
}

/**
 * A click runs several CSS transitions of one property on one element, one after another: the hover-in, the :active press
 * (often with its own, shorter duration) and the release back. The declared record names the first birth only, and a
 * magnetic / spring-driven element retargets its transition every frame; here every run of transitions with one duration and
 * curve is a line of its own, read from the page's own transition births (duration, curve and end values are exact), so the
 * press tween (160 ms) is not hidden behind the hover transition (520 ms). Used when an element has at least two runs of one
 * property. Returns the lines with the element's declared lines of that property replaced.
 */
const KF_META = new Set(['offset', 'easing', 'composite', 'computedOffset']);
const TRANSFORM_CH = new Set(['ren:tx', 'ren:ty', 'ren:tz', 'ren:sx', 'ren:sy', 'ren:rz', 'ren:skx', 'ren:transform', 'drv:transform']);
const FN_CH = { translateX: ['ren:tx'], translateY: ['ren:ty'], translateZ: ['ren:tz'], translate: ['ren:tx', 'ren:ty'], translate3d: ['ren:tx', 'ren:ty', 'ren:tz'], scale: ['ren:sx', 'ren:sy'], scale3d: ['ren:sx', 'ren:sy'], scaleX: ['ren:sx'], scaleY: ['ren:sy'], rotate: ['ren:rz'], rotateZ: ['ren:rz'], skewX: ['ren:skx'], skew: ['ren:skx'] };
export function transitionTravel(a, b) {
  a = a || {}; b = b || {}; const out = []; const chans = [];
  for (const k of Object.keys(b)) {
    if (KF_META.has(k) || a[k] === b[k]) continue;
    if (k === 'transform' && typeof a[k] === 'string' && typeof b[k] === 'string') {
      const fn = (t) => [...t.matchAll(/([a-zA-Z0-9]+)\(([^)]*)\)/g)].map((m) => [m[1], m[2].trim()]);
      // 'none' is the identity of the other side's functions (transform: none -> scale(1.05) reads "scale 1 → 1.05")
      const ident = (f) => { const n = f[1].split(',').length; return /^scale/.test(f[0]) ? [f[0], Array(n).fill('1').join(', ')] : /^(translate|rotate|skew)/.test(f[0]) ? [f[0], Array(n).fill(/^translate/.test(f[0]) ? '0px' : '0deg').join(', ')] : null; };
      let fa = fn(a[k]), fb = fn(b[k]);
      if (String(a[k]).trim() === 'none' && fb.every(ident)) fa = fb.map(ident);
      else if (String(b[k]).trim() === 'none' && fa.every(ident)) fb = fa.map(ident);
      if (fa.length === fb.length && fa.every((f, i) => f[0] === fb[i][0])) { for (let i = 0; i < fa.length; i++) if (fa[i][1] !== fb[i][1]) { out.push(`${fa[i][0]} ${fa[i][1]} → ${fb[i][1]}`); chans.push(...(FN_CH[fa[i][0]] || [])); } continue; }
    }
    out.push(`${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} ${a[k]} → ${b[k]}`);
    if (k === 'transform') chans.push(...TRANSFORM_CH); else if (k === 'opacity') chans.push('ren:opacity');
  }
  return out.length ? { text: out.join(', '), channels: [...new Set(chans)] } : null;
}
// the parts of a transition's end value: transform functions one by one, any other property as one value
const KF_VAL = (kf, name) => { if (!kf) return null; const camelName = String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return kf[camelName] ?? kf[name] ?? null; };
const partsOf = (v) => { const fns = [...String(v).matchAll(/([a-zA-Z0-9]+)\(([^)]*)\)/g)].map((m) => [m[1], m[2].trim()]); return fns.length ? fns : [['', String(v).trim()]]; };
const endOf = (b) => partsOf(KF_VAL((b.keyframes || []).slice(-1)[0], b.name));
const fromOf = (b) => partsOf(KF_VAL((b.keyframes || [])[0], b.name));
/**
 * Runs of one property's transitions on one element: births with one duration, delay and curve in a row are one run, and a
 * run splits where its target turns (hover in, then hover out, with one duration). A target a script retargets each frame
 * (a magnetic button writes --mx, so its translate moves a little with every birth) does not split it: a run splits when a
 * part that held still over the run changes, or (a run of one birth) when the new target is the old start.
 * @param {object[]} births
 * @param {string|null} desc   only births on this descriptor; null: births already chosen for one element
 */
export function transitionRuns(births, desc, fromT = null) {
  const byName = new Map();
  for (const b of births || []) {
    if (!b || b.type !== 'CSSTransition' || !b.name || (desc != null && b.tgt !== desc) || !(+b.duration > 0) || (b.timeline && b.timeline !== 'document')) continue;
    if (fromT != null && Number.isFinite(b.T) && b.T < fromT - 1) continue;
    const a = byName.get(b.name) || []; a.push(b); byName.set(b.name, a);
  }
  const runs = [];
  for (const [name, list0] of byName) {
    const seen = new Set(); const list = list0.filter((b) => { const k = `${b.T}|${JSON.stringify(b.keyframes)}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((x, y) => x.T - y.T);
    let cur = null;
    for (const b of list) {
      const key = `${+b.duration}|${+b.delay || 0}|${b.easing}`;
      if (cur && cur.key === key && !turns(cur, b)) { cur.n++; cur.last = b; continue; }
      cur = { name, key, n: 1, first: b, last: b, held: null }; runs.push(cur);
    }
  }
  return runs.sort((x, y) => x.first.T - y.first.T);
}
function turns(run, b) {
  const p = endOf(run.last), q = endOf(b);
  if (p.length !== q.length || p.some((x, i) => x[0] !== q[i][0])) return true;
  const diff = p.map((x, i) => x[1] !== q[i][1]);
  if (!diff.some(Boolean)) return false;
  if (run.n === 1) {
    const f = fromOf(run.first);
    const reverses = f.length === q.length && diff.every((d, i) => !d || f[i][1] === q[i][1]);
    if (reverses) return true;
    run.held = diff.map((d) => !d);
    return false;
  }
  const held = run.held || p.map(() => true);
  if (diff.some((d, i) => d && held[i])) return true;
  return false;
}
const SAMPLED_TRANSITION = (name) => name === 'transform' || name === 'opacity' || name === 'translate' || name === 'scale' || name === 'rotate';
const chOfProp = (name) => (name === 'opacity' ? new Set(['ren:opacity']) : TRANSFORM_CH);
/**
 * Transition lines of one element, read from the page's own transition births (duration, curve and end values are exact):
 * every run of one property is a line of its own (the hover, the :active press, the release; or one transition a script
 * retargets every frame), in every kind of look. Births come from the element's declared records when the fitter chose
 * them (siblings that share a descriptor see each other's births), else from all births on the descriptor (click).
 * Returns the lines with the element's declared / retargeted lines of that property replaced.
 */
export function expandDeclaredBirths(lines, desc, births, fromT, recs = [], triggerOf = null) {
  const own = []; for (const r of recs || []) { if (r.tier !== 'declared' || !r.declared || !Array.isArray(r.declared.births)) continue; for (const b of r.declared.births) if (b && b.type === 'CSSTransition') own.push({ ...b, tgt: desc }); }
  const runs = transitionRuns(own.length ? own : births, own.length ? null : desc, fromT).filter((r) => SAMPLED_TRANSITION(r.name));
  const count = new Map(); for (const r of runs) count.set(r.name, (count.get(r.name) || 0) + 1);
  // a click: every run (hover, press, release are three motions); other looks: only when a script retargets a run (the
  // fitter's line for one plain transition already states it exactly)
  const retargeted = new Set(runs.filter((r) => r.n >= 2).map((r) => r.name));
  const use = runs.filter((r) => (triggerOf ? retargeted.has(r.name) : count.get(r.name) >= 2 || r.n >= 2));
  if (!use.length) return lines;
  const added = use.map((r) => {
    const D = +r.first.duration, delay = +r.first.delay || 0;
    const kf0 = (r.first.keyframes || [])[0], kfN = (r.last.keyframes || []).slice(-1)[0];
    const tr = transitionTravel(kf0, kfN);
    const parts = [`${D} ms [exact]`, `${r.first.easing} [exact]`]; if (delay) parts.push(`delay ${delay} ms [exact]`);
    if (tr) parts.push(`${tr.text} [exact]`);
    if (r.n > 1) parts.push(`restarted ${r.n} times as its target changed (a script retargets it)`);
    return { text: `CSS transition: ${parts.join(', ')}`, kind: 'declared', family: 'declared:css', label: 'exact', property: r.name,
      channels: tr && tr.channels.length ? tr.channels : r.name === 'opacity' ? ['ren:opacity'] : ['ren:transform'],
      trigger: triggerOf ? triggerOf(r.first.T + delay) : null, t0: r.first.T + delay, times: 1, values: [{ name: 'duration', value: D, unit: 'ms', label: 'exact', text: `${D} ms [exact]` }] };
  });
  const names = new Set(use.map((r) => r.name));
  const replaced = (l) => (l.kind === 'declared' || l.kind === 'composite') && (l.channels || []).length && [...names].some((n) => l.channels.every((c) => chOfProp(n).has(c)));
  const kept = lines.filter((l) => !replaced(l));
  return [...kept, ...added].sort((a, b) => (a.t0 ?? Infinity) - (b.t0 ?? Infinity));
}

/** Stagger of one folded group, from its own members' onsets (same item shape as the fitter's, src/analysis/fit/index.js). */
export function groupStagger(recs, take, viewport) {
  const firstRow = new Map(); for (const r of take.data.rows) for (const id of Object.keys(r.v || {})) if (!firstRow.has(id)) firstRow.set(id, r.v[id]);
  const items = recs.filter((r) => r.derived && Number.isFinite(r.derived.t0) && r.tier !== 'unknown').map((r) => {
    const v = firstRow.get(String(r.target.el)) || {};
    const D = r.model.params && r.model.params.D;
    const shape = `${r.class}|${r.model.family}|${r.target.channel}|${D && D.value != null ? Math.round(D.value / Math.max(take.dt, 0.03 * D.value)) : ''}`;
    return { id: `${r.target.el}|${r.target.channel}|${r.derived.t0}`, t0: r.derived.t0, dom: r.target.el, x: +v['ren:bx'] || 0, y: +v['ren:by'] || 0, w: +v['ren:bw'] || 0, h: +v['ren:bh'] || 0, shape };
  });
  const gs = analyseStagger(items, { dtMs: take.dt, viewport });
  const els = (g) => new Set(g.members.map((m) => m.split('|')[0])).size;
  return gs.sort((a, b) => els(b) - els(a))[0] || null;
}

/**
 * Planned channels with no record: covered by a same-shape twin (pruned), or an explicit unknown with the reason
 * (statics: no change above the noise floor in the number the fitter reads; cut by a budget; or no model at all).
 */
export function coverage(planned, res, rows, covered, els, noop = new Set()) {
  res = res || { records: [], unknowns: [] };
  const has = new Set(res.records.map((r) => baseKey(`${r.target.el}|${r.target.channel}`)));
  const statics = new Set(((res.statics && res.statics.sample) || []).map((x) => x.key));
  const pruned = new Map((res.pruned || []).map((x) => [x.key, x]));
  const out = [];
  for (const k of planned) {
    if (has.has(k) || covered.some((c) => c.key === k)) continue;
    const [el, ch] = k.split('|');
    if (pruned.has(k)) { const pr = pruned.get(k); covered.push({ key: k, by: `the ${channelWord(pr.redundant_with)} channel (${pr.why || 'same motion'})` }); continue; }
    const span = valueSpan(rows, el, ch);
    const ledger = (res.unknowns || []).find((u) => u.target === `${els[+el]}|${ch}`);
    const fmt = span ? ` (values go ${span.from} → ${span.to}, ${span.distinct}${span.distinct >= 1000 ? '+' : ''} distinct)` : '';
    // a numeric channel in statics changed only below the read-back noise floor: not motion. A string channel in
    // statics changed in a part the fitter does not read (its first number stayed put): an unknown, with the values
    const numeric = span && span.numeric;
    // "none" and an identity matrix are the same transform: a switch between them is not motion
    // ... nor is any transform string change while the rendered transform parts stay put (`noop`, renderedTransformStill)
    const sameForm = noop.has(k) || (span && /transform$/.test(ch) && span.values.length > 0 && span.values.every((v) => v === 'none' || /^matrix\(1, 0, 0, 1, 0, 0\)$/.test(v) || /^matrix3d\(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1\)$/.test(v)));
    // a rendered matrix that changes only where the fitter does not read it (it reads the first entry): say where
    const mch = !ledger && !sameForm && ch === 'ren:transform' ? matrixChanges(rows, el) : [];
    const persp = mch.length && mch.every((m) => m === 'm34' || m === 'm44');
    const kind = ledger ? 'not fitted' : sameForm || (statics.has(k) && numeric) ? 'below noise' : 'no model';
    const reason = ledger ? ledger.reason
      : sameForm ? `switches between equivalent forms${fmt}: the rendered transform does not change, not motion`
        : mch.length && !mch.includes('m11') ? `the rendered matrix changes in ${mch.join(', ')}${persp ? ' (perspective: a 3D zoom)' : ''}${fmt}, which the fitter does not read (it reads the first entry)`
        : statics.has(k) ? (numeric ? `changes only below the read-back noise floor${fmt}: not counted as motion` : `the value changes${fmt} but not in the number the fitter reads from it`)
          : `the fitter produced no model for this channel${fmt}`;
    out.push({ el: +el, desc: els[+el] || null, channel: ch, kind, reason, values: span });
  }
  return out;
}
function valueSpan(rows, el, ch) {
  let from = null, to = null, numeric = true; const seen = new Set();
  for (const r of rows) { const v = r.v && r.v[el]; if (!v || !(ch in v)) continue; if (typeof v[ch] !== 'number') numeric = false; const s = typeof v[ch] === 'string' ? v[ch] : JSON.stringify(v[ch]); if (from == null) from = s; to = s; if (seen.size < 1000) seen.add(s); }
  return from == null ? null : { from: String(from).slice(0, 80), to: String(to).slice(0, 80), distinct: seen.size, numeric, values: seen.size <= 4 ? [...seen] : [] };
}

function median(a) { if (!a || !a.length) return null; const s = [...a].sort((x, y) => x - y); return r1(s[s.length >> 1]); }
