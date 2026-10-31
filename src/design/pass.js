// The design pass of `reva look` / `reva design`: one static-layer session (src/static/extract.js) of its own, after the
// motion take has closed (never shared with it), behind the same network walls as the look (archive routes + DNS sinkhole
// + dead proxy; loopback only for a local page; the caller's guard for a live page) and with WebRTC UDP off. Lean on purpose:
// desktop at the look's viewport with the declared layer and forced :hover / :focus, a light mobile pass (type sizes),
// one breakpoint sweep; no accessibility snapshot (it holds the page's words) and no script bodies on disk.
import fs from 'node:fs';
import path from 'node:path';
import { extractStatic, writeRecord, loadElements } from '../static/extract.js';
import { harPaths, seedScript, OFFLINE_ARGS, BLACKHOLE_ARGS } from '../replay/target.js';
import { wireReplay } from '../replay/replay.js';
import { NO_UDP_APIS_SCRIPT, WEBRTC_PREFS } from '../mcp/guard.js';
import { summarizeDesign, DESIGN_SCHEMA } from './summary.js';
import { defaultEngine } from '../browser/engines.js';
import { clickRejectInPage } from '../safety/consent.js';
import { localArgs } from '../look/localnet.js';

/** Loopback only (the same walls as look's LOCAL_ARGS; restated here so this module does not import look). */
const LOCAL_ARGS = (allow = []) => localArgs(allow);
export const DESIGN_SWEEP = { from: 320, to: 1920, step: 80, ignoreWrap: true, maxProbesPerInterval: 12 };

/**
 * @param {object} o
 * @param {object} o.src        look's resolved source (src/look/source.js resolveSource)
 * @param {string} o.outDir     where the raw static record goes (outside the repo)
 * @param {string} [o.cls]      archive viewport class (default A)
 * @param {object} [o.viewport] {width,height} for a URL (default 1440×900)
 * @param {string[]} [o.args]   extra browser args (the MCP's guard proxy for a live page)
 * @param {object} [o.prefs]    browser profile prefs (merged with the WebRTC no-UDP policy)
 * @param {Function} [o.onSession] ({ctx, page}) => Promise: the caller's guard (route handler) for a live page
 * @param {string[]} [o.consentClicks] reject selectors the look's safety gate found (src/safety/consent.js); clicked once per
 *                   variant after load, never "accept", so a cookie banner does not sit in the design read
 * @param {object} [o.navGuard] a live page's robots check for every main-frame navigation (src/safety/gate.js navigationGuard);
 *                   a refusal ends the pass with {ok:false, code:'blocked_robots'} and removes what it wrote
 * @param {string} [o.engine]   browser engine (default: defaultEngine(), cft when installed else the headless shell)
 * @returns {Promise<object>} design summary (DESIGN_SCHEMA) with timing; {ok:false, error} when the pass failed
 */
export async function runDesignPass(o) {
  const t0 = Date.now(); const src = o.src; const cls = o.cls || 'A'; const log = o.log || (() => {});
  try {
    let url, extra = {}, vp = o.viewport || { width: 1440, height: 900 };
    if (src.kind === 'archive') {
      const t = src.target; url = t.startUrl;
      const c = t.classes[cls] || {}; if (c.viewport) vp = c.viewport;
      extra = { offlineReplay: true, launchArgs: [...OFFLINE_ARGS, ...BLACKHOLE_ARGS], prepare: async (ctx) => {
        await ctx.addInitScript({ content: NO_UDP_APIS_SCRIPT });
        await wireReplay(ctx, harPaths(t, cls), { blockRegex: t.blockRegex ? new RegExp(t.blockRegex) : null });
        await ctx.addInitScript(seedScript(t.seed));
      } };
    } else {
      url = src.url;
      extra = { allowLive: !!src.live, allowHosts: o.allowNet || [], launchArgs: [...(src.live ? [] : LOCAL_ARGS(o.allowNet)), ...(o.args || [])], prepare: async (ctx, page) => {
        await ctx.addInitScript({ content: NO_UDP_APIS_SCRIPT });
        if (o.onSession) await o.onSession({ ctx, page });
        // robots.txt for every main-frame navigation of this second page load too (src/safety/gate.js navigationGuard)
        if (o.navGuard) await o.navGuard.attach(page, { onBlock: () => { ctx.close().catch(() => {}); } });
      } };
    }
    fs.mkdirSync(o.outDir, { recursive: true });
    // the scheme and motion preference are pinned (light, no preference): the design read never follows the OS appearance
    const pin = { colorScheme: 'light', reducedMotion: 'no-preference' };
    const variants = [{ id: `desktop-${vp.width}`, width: vp.width, height: vp.height, ...pin }, { id: 'mobile-390', width: 390, height: 844, touch: true, light: true, ...pin }];
    const prefs = { ...(o.prefs || {}), webrtc: { ...((o.prefs && o.prefs.webrtc) || {}), ...WEBRTC_PREFS.webrtc } };
    const { record } = await extractStatic({ url, outDir: o.outDir, engine: o.engine || defaultEngine(), variants, sweep: o.sweep || DESIGN_SWEEP, maxStates: 24, maxDeclaredRows: 300,
      a11y: false, saveScripts: false, settleText: { everyMs: 300, maxMs: 5000 }, prefs, signal: o.signal, afterLoad: consentStep(o.consentClicks, log), log: (m) => log(`design: ${m}`), ...extra });
    if (o.navGuard && await o.navGuard.settle()) throw Object.assign(new Error('robots'), { code: 'blocked_robots' });
    writeRecord(record, o.outDir);
    const d = summarizeDesign(record, loadElements(o.outDir, record.variants[0]));
    return { ...d, timing: { ms: Date.now() - t0, browserMs: record.wallMs }, record: path.join(o.outDir, 'static.json') };
  } catch (e) {
    if (o.signal && o.signal.aborted) throw Object.assign(new Error('design: cancelled'), { code: 'cancelled' });
    // the page sent the browser to a URL its robots.txt disallows: nothing of the read is kept, the refusal is the result
    if (o.navGuard && await o.navGuard.settle()) {
      try { fs.rmSync(o.outDir, { recursive: true, force: true }); } catch { /* already gone */ }
      return { schema: DESIGN_SCHEMA, ok: false, code: 'blocked_robots', error: o.navGuard.error().message, timing: { ms: Date.now() - t0 } };
    }
    // the design pass never fails the look: the motion result stands, the design section says what went wrong in our
    // words only (a category). The raw message can carry the page's own words (a thrown error's text): it goes to a local
    // log beside the record, never into the result.
    const raw = String(e && e.stack || e && e.message || e);
    let log = null;
    try { fs.mkdirSync(o.outDir, { recursive: true }); log = path.join(o.outDir, 'design-error.log'); fs.writeFileSync(log, `${new Date().toISOString()}\n${raw}\n`); } catch { log = null; }
    return { schema: DESIGN_SCHEMA, ok: false, error: `design pass failed: ${failureCategory(e)}`, ...(log ? { errorLog: log } : {}), timing: { ms: Date.now() - t0 } };
  }
}

/** The per-variant cookie-banner step (null when the gate found no banner). True when it clicked, so the page settles again. */
function consentStep(clicks, log) {
  if (!Array.isArray(clicks) || !clicks.length) return null;
  return async (page) => {
    const done = await page.evaluate(clickRejectInPage, clicks).catch(() => []);
    if (done.length) { log(`design: cookie banner: clicked ${done.join(', ')}`); await page.waitForTimeout(400); }
    return done.length > 0;
  };
}

/** What kind of failure, in our words (never the message itself). */
export function failureCategory(e) {
  const m = String(e && e.message || e || '');
  if (/timeout|timed out/i.test(m)) return 'timed out';
  if (/net::|ERR_[A-Z_]+|navigation|page\.goto/i.test(m)) return 'the page did not load (navigation failed)';
  if (/browserType\.launch|executable|Failed to launch/i.test(m)) return 'the browser did not start';
  if (/Target (page, context or browser )?(has been )?closed|crash/i.test(m)) return 'the browser closed or crashed during the read';
  if (/page\.evaluate|Evaluation failed|Execution context/i.test(m)) return 'a page script error during the read';
  return 'an internal error during the read';
}
