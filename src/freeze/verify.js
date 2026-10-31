// Offline replay check of a frozen archive (PLAN M4 "DONE WHEN - freeze": DNS disabled, 0 misses, `load` fires).
// Differences from src/replay/replay.js bootCheck: structured miss records, optional interaction steps
// (the recording did not click; a replay that does is what exposes JS-built URLs the recording never saw), a probe of page state.
import { launchBrowser } from '../browser/launch.js';
import { assertPoolFits } from '../browser/pool.js';
import { seedScript, OFFLINE_ARGS } from '../replay/target.js';
import { installMissLogger, classifyMisses } from './misslog.js';
import { isTrackerFailure } from './trackers.js';
import { kindOf, isRelevantKind } from './policy.js';
import { contextOptions, sleep } from './record.js';
import { defaultEngine } from '../browser/engines.js';

async function runSteps(page, steps, out) {
  for (const s of steps) {
    try {
      if (s.click) await page.click(s.click, { timeout: 3000 });
      else if (s.wait) await sleep(s.wait);
      else if (s.wheel) { const v = page.viewportSize(); await page.mouse.move(v.width >> 1, v.height >> 1); await page.mouse.wheel(0, s.wheel); }
      else if (s.scrollTo !== undefined) await page.evaluate(y => scrollTo(0, y), s.scrollTo);
    } catch (e) { out.stepErrors.push(`${JSON.stringify(s)}: ${e.message.split('\n')[0]}`); }
  }
}

/**
 * The replay's failed requests that are not explained (pure: unit-testable without a browser). Explained: the block list,
 * the redirect hop, a tracker block we made, a request the page aborted after a fuzzy answer, and the catch-all abort of a
 * TOLERATED miss (telemetry, third-party api / non-GET, other: that failure is the miss again, not a second failure).
 * The catch-all abort of a relevant miss (render, same-site data) stays unexpected.
 * @param {{failed?:string[]}} out  "METHOD url :: error" lines (requestfailed)
 * @param {object[]} misses  the catch-all's miss records {method, url, resourceType}
 * @param {object[]} fuzzy  the fuzzy fallback's answers {method, url}
 * @param {{startUrl:string, block?:string|null}} cfg
 * @returns {string[]}
 */
export function unexpectedFailures(out, misses = [], fuzzy = [], cfg) {
  const block = cfg.block ? new RegExp(cfg.block) : null;
  const redirectHop = f => f === `GET ${cfg.startUrl} :: net::ERR_ABORTED`; // a replayed 303 surfaces as ERR_ABORTED on the redirected request (D-M0-6)
  // a request the page itself aborted after we answered it from the archive (fuzzy match) is page behaviour, not an archive hole
  const fuzzyUrls = new Set(fuzzy.map(x => `${x.method} ${x.url}`.slice(0, 200)));
  const pageAborted = f => / :: net::ERR_ABORTED$/.test(f) && fuzzyUrls.has(f.replace(/ :: .*$/, '').slice(0, 200));
  const tolerated = new Set(misses.filter(m => !isRelevantKind(kindOf(m, { siteUrl: cfg.startUrl }))).map(m => `${m.method} ${m.url}`.slice(0, 200)));
  const toleratedAbort = f => / :: net::ERR_INTERNET_DISCONNECTED$/.test(f) && tolerated.has(f.replace(/ :: .*$/, '').slice(0, 200));
  return (out.failed || []).filter(f => !(block && block.test(f)) && !redirectHop(f) && !isTrackerFailure(f, cfg.startUrl) && !pageAborted(f) && !toleratedAbort(f));
}

/** Browser flags + context options of one class's replay check (pure; the same with or without a shared browser). */
export function verifyOpenOptions(cfg, cls) {
  // No host rules: with every name unresolvable, the archive is the only server there is.
  return { args: OFFLINE_ARGS, context: contextOptions(cfg, cls) };
}

/** S11 (26 Oct): the replay-check browser of one class: its own launch (default) or a fresh context in `pool` (one browser
 *  per check round, a context per class; same flags and engine, checked). */
export async function openVerifyBrowser(cfg, cls, { engine = defaultEngine(), pool = null, launch = launchBrowser } = {}) {
  const { args, context } = verifyOpenOptions(cfg, cls);
  if (!pool) return launch({ engine, args, context });
  assertPoolFits(pool, { args, engine });
  return pool.open({ context });
}

/**
 * @param {object} cfg normalized freeze config
 * @param {string} cls
 * @param {string[]} hars union first, class HAR last
 * @param {{engine?:string, steps?:object[], timeoutMs?:number, pool?:object}} [o]  pool: a BrowserPool with OFFLINE_ARGS
 */
export async function replayVerify(cfg, cls, hars, { engine = defaultEngine(), steps = cfg.verifySteps, timeoutMs = 20000, pool = null } = {}) {
  const out = { cls, engine, pageerrors: [], consoleErrors: [], failed: [], stepErrors: [], requests: 0 };
  const block = cfg.block ? new RegExp(cfg.block) : null;
  const inflight = new Map();
  let h, net0 = null;
  try {
    h = await openVerifyBrowser(cfg, cls, { engine, pool });
    const { context: ctx, page } = h;
    const net = net0 = await installMissLogger(ctx, { hars, block, ownUrl: cfg.startUrl });
    await ctx.addInitScript(seedScript(cfg.seed));
    page.on('pageerror', e => out.pageerrors.push(String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 300)); });
    ctx.on('request', r => { out.requests++; inflight.set(r, r.url()); });
    ctx.on('requestfinished', r => inflight.delete(r));
    ctx.on('requestfailed', r => { inflight.delete(r); out.failed.push(`${r.method()} ${r.url().slice(0, 200)} :: ${(r.failure() || {}).errorText}`); });
    const t0 = Date.now();
    try { const resp = await page.goto(cfg.startUrl, { waitUntil: 'load', timeout: timeoutMs }); out.docStatus = resp && resp.status(); out.loadFired = true; }
    catch (e) { out.gotoError = e.message.split('\n')[0]; out.loadFired = false; }
    out.loadMs = Date.now() - t0;
    out.finalUrl = page.url();
    await sleep(cfg.settleMs);
    if (steps.length) await runSteps(page, steps, out);
    await sleep(300);
    if (cfg.probe) { try { out.probe = await page.evaluate(`(${cfg.probe})()`); } catch (e) { out.probeError = e.message.split('\n')[0]; } }
    out.misses = net.misses;
    out.blockedCount = net.blocked.length;
    out.trackers = [...new Set(net.trackers)].slice(0, 100); out.trackersBlocked = net.trackers.length; out.fuzzy = net.fuzzy.slice(0, 100); out.fuzzyAnswered = net.fuzzy.length;
    out.inflight = [...inflight.values()].map(u => u.slice(0, 160));
  } catch (e) { out.error = e.stack.split('\n').slice(0, 4).join(' | '); }
  finally { if (h) await h.close(); }
  const unexpected = unexpectedFailures(out, net0?.misses || [], net0?.fuzzy || [], cfg);
  out.failedUnexpected = unexpected.slice(0, 12);
  out.missKinds = classifyMisses(out.misses || [], out.pageerrors);
  out.checks = {
    noError: !out.error,
    loadFired: out.loadFired === true,
    docStatus200: out.docStatus === 200,
    finalUrlMatches: !cfg.expect.finalUrlPath || (!!out.finalUrl && new URL(out.finalUrl).pathname === cfg.expect.finalUrlPath),
    // 24 Oct: a render-relevant miss (document, stylesheet, script, font, image, media: policy kindOf 'render', the same
    // misses the archive completeness counts and the completion step chases) fails the check.
    // 26 Oct (S2): so does a miss of the site's own data (same registrable domain as cfg.startUrl: api / JSON / GraphQL /
    // non-GET, kind 'site-data'), a separate check so older reasons still parse. Third-party api / non-GET and telemetry
    // misses are listed in out.misses and out.missKinds but do not gate.
    noRenderMisses: Array.isArray(out.misses) && out.misses.every(m => kindOf(m, { siteUrl: cfg.startUrl }) !== 'render'),
    noSiteDataMisses: Array.isArray(out.misses) && out.misses.every(m => kindOf(m, { siteUrl: cfg.startUrl }) !== 'site-data'),
    noUnexpectedFailures: unexpected.length === 0,
    noInflight: (out.inflight || []).length === 0,
    noPageErrors: out.pageerrors.length === 0,
    stepsOk: out.stepErrors.length === 0,
  };
  out.pass = Object.values(out.checks).every(Boolean);
  return out;
}

/**
 * Trap 2 demonstration: replay a HAR exactly as Playwright's defaults would (no sanitiser, no block route, no catch-all).
 * @returns {Promise<{loadFired:boolean, ms:number}>}
 */
export async function naiveReplayLoads(cfg, cls, harPath, { engine = defaultEngine(), timeoutMs = 4000 } = {}) {
  let h;
  try {
    h = await launchBrowser({ engine, args: OFFLINE_ARGS, context: contextOptions(cfg, cls) });
    await h.context.routeFromHAR(harPath);
    const t0 = Date.now();
    try { await h.page.goto(cfg.startUrl, { waitUntil: 'load', timeout: timeoutMs }); return { loadFired: true, ms: Date.now() - t0 }; }
    catch { return { loadFired: false, ms: Date.now() - t0 }; }
  } finally { if (h) await h.close(); }
}
