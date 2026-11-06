// Offline archive replay. Route order in Playwright: last registered runs first, so
//   BLOCK abort -> HAR(class) fallback -> HAR(union) fallback -> catch-all miss logger (abort).
// Pass = zero logged misses (PLAN M0, S5 §7.3).
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../browser/launch.js';
import { harPaths, seedScript, OFFLINE_ARGS } from './target.js';
import { ensureOutDir } from '../util/paths.js';
import { defaultEngine } from '../browser/engines.js';
import { blockTrackers, isTrackerFailure } from '../freeze/trackers.js';
import { installFuzzyFallback } from '../freeze/fuzzy.js';

/** A document for the page itself. A link that opens a new window has no frame yet: Playwright throws, and that is no leaving. */
function isMainDocument(q) {
  if (!q.isNavigationRequest()) return false;
  try { return !q.frame().parentFrame(); } catch { return false; }
}

export async function wireReplay(ctx, hars, { blockRegex = null, catchAll = true, trackers = true, fuzzy = true, ownUrl = null, onMiss = null } = {}) {
  // net.stay (a caller sets it once the page is up): the page asks to leave for a document the archive does not hold. A 204
  // keeps it where it is; refused, Chrome goes to its error page and the renderer dies with nothing said to the recorder
  // onMiss (read-through, DESIGN 3.7, off unless a caller passes it): a miss may be answered from outside. net.own counts those
  // answers still out, so the network gate keeps the virtual clock still and a slow answer stays invisible to the page.
  const net = { misses: [], blocked: [], trackers: [], fuzzy: [], left: [], stay: false, own: 0, answered: [] };
  if (catchAll) await ctx.route('**/*', async r => {
    const q = r.request();
    if (onMiss && !(net.stay && isMainDocument(q))) {
      net.own++;
      let a = null;
      try { a = await onMiss(q); } catch { a = null; } finally { net.own--; }
      if (a) { net.answered.push(q.url()); return r.fulfill(a).catch(() => {}); }
    }
    net.misses.push(`${q.method()} ${q.url()}`);
    if (net.stay && isMainDocument(q)) { net.left.push(q.url()); return r.fulfill({ status: 204 }); }
    return r.abort('internetdisconnected');
  });
  if (catchAll && fuzzy) net.fuzzy = await installFuzzyFallback(ctx, hars); // volatile-URL variants of archived entries (F10); logged
  for (const h of hars) await ctx.routeFromHAR(h, { notFound: catchAll ? 'fallback' : 'abort' });
  if (trackers) await blockTrackers(ctx, net.trackers, { ownUrl }); // analytics beacons: aborted and logged (F21)
  if (blockRegex) await ctx.route(blockRegex, r => { net.blocked.push(r.request().url()); r.abort(); });
  return net;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Boot one viewport class from the archive, offline, and scroll the whole page down and up.
 * @returns {Promise<object>} a plain report; `pass` is the gate (0 misses etc.)
 */
export async function bootCheck(target, cls, { reducedMotion = 'no-preference', engine = defaultEngine(), wheel = true, label } = {}) {
  const vp = target.classes[cls];
  if (!vp) throw new Error(`target has no viewport class "${cls}"`);
  const out = { cls, reducedMotion, engine, started: new Date().toISOString(), pageerrors: [], consoleErrors: [], failed: [], requests: 0, finished: 0 };
  const inflight = new Map();
  const blockRegex = target.blockRegex ? new RegExp(target.blockRegex) : null;
  const guard = setTimeout(() => { console.error('bootCheck HARD TIMEOUT'); process.exit(3); }, 300000);
  let h;
  try {
    h = await launchBrowser({
      engine, args: OFFLINE_ARGS,
      context: { locale: target.locale || 'en-US', timezoneId: target.timezone || 'UTC', reducedMotion, ...vp },
    });
    const { context: ctx, page } = h;
    const net = await wireReplay(ctx, harPaths(target, cls), { blockRegex, ownUrl: target.startUrl });
    await ctx.addInitScript(seedScript(target.seed));
    page.on('pageerror', e => out.pageerrors.push(String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 300)); });
    ctx.on('request', r => { out.requests++; inflight.set(r, r.url()); });
    ctx.on('requestfinished', r => { out.finished++; inflight.delete(r); });
    ctx.on('requestfailed', r => { inflight.delete(r); out.failed.push(`${r.method()} ${r.url().slice(0, 160)} :: ${(r.failure() || {}).errorText}`); });
    const t0 = Date.now();
    try { const resp = await page.goto(target.startUrl, { waitUntil: 'load', timeout: 30000 }); out.docStatus = resp && resp.status(); }
    catch (e) { out.gotoError = e.message.split('\n')[0]; }
    out.loadMs = Date.now() - t0;
    out.finalUrl = page.url();
    await sleep(target.settleMs ?? 4000);
    const probe = async () => page.evaluate(target.probe ? `(${target.probe})()` : '({})');
    out.atLoad = await probe();
    if (wheel) {
      const w = target.wheel || { down: { n: 90, dy: 120, gapMs: 90 }, up: { n: 60, dy: -240, gapMs: 40 } };
      const vs = page.viewportSize();
      await page.mouse.move(vs.width >> 1, vs.height >> 1);
      for (let i = 0; i < w.down.n; i++) { await page.mouse.wheel(0, w.down.dy); await sleep(w.down.gapMs); }
      await sleep(2000);
      out.atBottom = await probe(); out.bottomY = await page.evaluate(() => scrollY);
      for (let i = 0; i < w.up.n; i++) { await page.mouse.wheel(0, w.up.dy); await sleep(w.up.gapMs); }
      await sleep(2000);
      out.atTop = await probe();
    }
    out.misses = net.misses;
    out.blockedCount = net.blocked.length;
    out.trackersBlocked = net.trackers.length; out.fuzzyAnswered = net.fuzzy.length;
    out.inflight = [...inflight.values()].map(u => u.slice(0, 160));
  } catch (e) { out.error = e.stack.split('\n').slice(0, 4).join(' | '); }
  finally { if (h) await h.close(); clearTimeout(guard); }
  out.finished_at = new Date().toISOString();
  const exp = target.expect || {};
  // Expected failures: the block list, and the start URL's own redirect hop (a replayed 303 is reported as ERR_ABORTED
  // for the request that was redirected; present in every research boot, ARCH boot/*.json). Nothing else is excused.
  const isRedirectHop = f => f === `GET ${target.startUrl} :: net::ERR_ABORTED`;
  const failedUnexpected = out.failed.filter(f => !(blockRegex && blockRegex.test(f)) && !isRedirectHop(f) && !isTrackerFailure(f, target.startUrl));
  out.expectedRedirectHops = out.failed.filter(isRedirectHop).length;
  out.checks = {
    noError: !out.error && !out.gotoError,
    docStatus200: out.docStatus === 200,
    finalUrlMatches: !exp.finalUrlPath || (out.finalUrl && new URL(out.finalUrl).pathname === exp.finalUrlPath),
    zeroMisses: Array.isArray(out.misses) && out.misses.length === 0,
    noUnexpectedFailures: failedUnexpected.length === 0,
    noInflight: (out.inflight || []).length === 0,
  };
  out.failedUnexpected = failedUnexpected.slice(0, 12);
  out.pass = Object.values(out.checks).every(Boolean);
  const dir = ensureOutDir('boot', label || 'adhoc');
  fs.writeFileSync(path.join(dir, `boot_${cls}_${reducedMotion}.json`), JSON.stringify(out, null, 1));
  return out;
}

export function summarize(r) {
  return {
    cls: r.cls, rm: r.reducedMotion, pass: r.pass, doc: r.docStatus, final: r.finalUrl, loadMs: r.loadMs,
    requests: r.requests, finished: r.finished, misses: r.misses?.length ?? null, blocked: r.blockedCount,
    failedUnexpected: r.failedUnexpected?.length ?? null, inflight: r.inflight?.length ?? null,
    pageerrors: r.pageerrors.length, consoleErrors: r.consoleErrors.length, bottomY: r.bottomY, error: r.error || r.gotoError || undefined,
    failedChecks: Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k),
  };
}
