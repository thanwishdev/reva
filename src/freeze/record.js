// Record one viewport class into a Playwright HAR (PLAN M4 freeze; recipe from ARCH tools/record.js, W2G1-4 §1.3).
// Telemetry is blocked at record time as well, so it never enters the archive as live traffic.
// Browser access goes only through src/browser/launch.js (H1).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launchBrowser } from '../browser/launch.js';
import { assertPoolFits } from '../browser/pool.js';
import { seedScript } from '../replay/target.js';
import { recordArgs } from './config.js';
import { defaultEngine } from '../browser/engines.js';
import { blockTrackers } from './trackers.js';
import { waitForPreloader } from '../browser/preloader.js';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function contextOptions(cfg, cls) {
  const { viewport, ...rest } = cfg.classes[cls];
  return { viewport, locale: cfg.locale, timezoneId: cfg.timezone, reducedMotion: 'no-preference', ...rest };
}

/** Browser flags + context options of one class's recording (pure; the same with or without a shared browser). */
export function recordOpenOptions(cfg, cls, harPath) {
  return { args: recordArgs(cfg), context: { ...contextOptions(cfg, cls), recordHar: { path: harPath, content: 'attach', mode: 'full' } } };
}

/**
 * S11 (26 Oct): the recording browser of one class: its own launch (default), or a fresh context in `pool` (one browser
 * per round, a context per class; the pool must carry the same flags and engine). Each context has its own cookies,
 * storage and HTTP cache, so a class never reuses what another class loaded and every class's HAR is complete.
 */
export async function openRecordBrowser(cfg, cls, { harPath, engine = defaultEngine(), pool = null, launch = launchBrowser } = {}) {
  const { args, context } = recordOpenOptions(cfg, cls, harPath);
  if (!pool) return launch({ engine, args, context });
  assertPoolFits(pool, { args, engine });
  return pool.open({ context });
}

/**
 * @param {object} cfg normalized freeze config
 * @param {string} cls viewport class
 * @param {{harPath:string, extraUrls?:string[], engine?:'cft'|'chs', evidence?:{dir:string}|null, fetchOnly?:boolean, fetchBudgetMs?:number, fetchConcurrency?:number}} o
 *   evidence: write a live above-the-fold screenshot (<dir>/<cls>.jpg) and a DOM digest into log.live (after consent clicks, before the sweep)
 *   fetchOnly: completion pass: load the page, fetch extraUrls (concurrency, deadline), no clicks/sweep/inner pages
 *   pool: a BrowserPool with recordArgs(cfg) (freeze shareBrowser): the class records in a fresh context of it
 * @returns {Promise<{finalUrl:string, docStatus:number, blocked:string[], extra:Array<[string,number|string,number]>, pageerrors:string[], requests:number, wheelSteps:number}>}
 */
export async function recordClass(cfg, cls, { harPath, extraUrls = [], engine = defaultEngine(), evidence = null, fetchOnly = false, fetchBudgetMs = 0, fetchConcurrency = 1, pool = null }) {
  fs.mkdirSync(path.dirname(harPath), { recursive: true });
  const log = { cls, blocked: [], trackers: [], extra: [], pageerrors: [], requests: 0, wheelSteps: 0, clicked: [] };
  const block = cfg.block ? new RegExp(cfg.block) : null;
  let h;
  // Safety net: closing the context makes every pending page call throw, so `finally` still runs (no process.exit that would skip the close).
  const guard = setTimeout(() => { console.error('freeze record: 10 min limit, closing the browser'); h?.close(); }, 600000);
  try {
    h = await openRecordBrowser(cfg, cls, { harPath, engine, pool });
    const { context: ctx, page } = h;
    log.browser = { engine: h.engine, version: h.version, toolkit: h.toolkit, playwright: h.playwrightVersion };
    if (block) await ctx.route(block, r => { log.blocked.push(r.request().method() + ' ' + r.request().url()); r.abort(); });
    if (cfg.blockTrackers !== false) await blockTrackers(ctx, log.trackers, { ownUrl: cfg.startUrl }); // F21: beacons never go live and never enter the HAR
    await ctx.addInitScript(seedScript(cfg.seed));
    page.on('pageerror', e => log.pageerrors.push(String(e).slice(0, 300)));
    ctx.on('request', () => { log.requests++; });
    const navAt = Date.now();
    const resp = await page.goto(cfg.startUrl, { waitUntil: 'load', timeout: 60000 });
    log.docStatus = resp.status(); log.finalUrl = page.url();
    await sleep(cfg.settleMs);
    // C1 (1 Nov): a loader overlay / counter / one-colour screen still showing: wait until it is gone (or the cap), so the
    // evidence shot, the sweep and the recording see the real page; the outcome goes into the log (and live.json)
    if (cfg.preloaderWait !== false && !fetchOnly) {
      log.preloader = await waitForPreloader(page, { capMs: cfg.preloaderCapMs ?? 20000 }).catch(e => ({ state: 'error', error: String(e.message || e).split('\n')[0].slice(0, 200) }));
    }
    for (const sel of (fetchOnly ? [] : cfg.clicks)) { // declared record-time interactions (e.g. open a menu so its lazy content loads)
      try { await page.click(sel, { timeout: 3000 }); log.clicked.push(sel); await sleep(300); } catch { log.clicked.push(sel + ' (not found)'); }
    }
    if (evidence) { // live evidence (C-PLAN-v2-CHECK §4): what the live page showed, so a wall or empty page can never pass later
      try {
        fs.mkdirSync(evidence.dir, { recursive: true });
        const shot = path.join(evidence.dir, `${cls}.jpg`);
        await page.screenshot({ path: shot, type: 'jpeg', quality: 60, timeout: 15000 });
        const d = await page.evaluate(() => {
          const all = document.querySelectorAll('*'); let visible = 0, aboveFold = 0, media = 0;
          for (let i = 0; i < all.length && i < 20000; i++) {
            const r = all[i].getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
            visible++; if (r.top < innerHeight && r.bottom > 0) aboveFold++;
            if (/^(IMG|VIDEO|CANVAS|SVG|PICTURE)$/i.test(all[i].tagName)) media++;
          }
          const text = (document.body && document.body.innerText) || '';
          return { title: document.title.slice(0, 200), elements: all.length, visible, aboveFold, media, textChars: text.length, text: text.slice(0, 20000), htmlChars: document.documentElement.outerHTML.length, scrollHeight: document.documentElement.scrollHeight };
        });
        log.live = { docStatus: log.docStatus, finalUrl: log.finalUrl, ...d, text: undefined, textSha1: crypto.createHash('sha1').update(d.text).digest('hex'), textHead: d.text.replace(/\s+/g, ' ').slice(0, 300), screenshot: `${cls}.jpg`, ...(log.preloader ? { preloader: log.preloader } : {}), at: new Date().toISOString() };
      } catch (e) { log.live = { docStatus: log.docStatus, finalUrl: log.finalUrl, error: String(e.message || e).split('\n')[0].slice(0, 200) }; }
    }
    if (cfg.sweep && !fetchOnly) { // a slow wheel pass mounts lazy content; stop at the bottom (or when the page stops moving: a latch, an end-of-scroll)
      const vs = page.viewportSize();
      await page.mouse.move(vs.width >> 1, vs.height >> 1);
      const { down, up } = cfg.sweep;
      let last = -1, still = 0, bottom = 0;
      for (let i = 0; i < down.n; i++) {
        await page.mouse.wheel(0, down.dy); log.wheelSteps++; await sleep(down.gapMs);
        if (i % 4 === 3) {
          const [y, atEnd] = await page.evaluate(() => [scrollY, scrollY + innerHeight >= document.documentElement.scrollHeight - 2]);
          still = Math.abs(y - last) < 1 ? still + 1 : 0; last = y;
          bottom = atEnd ? bottom + 1 : 0;
          if (bottom >= 2 || still >= 6) break;
        }
      }
      await sleep(600);
      for (let i = 0; i < up.n; i++) { await page.mouse.wheel(0, up.dy); await sleep(up.gapMs); if (i % 4 === 3 && await page.evaluate(() => scrollY) < 1) break; }
      await sleep(400);
    }
    // Inner pages (corpus, CORPUS-PLAN §5): visited by navigation after the home sweep so their subresources enter the
    // HAR (a fetch() would only get the document). Classes listed in cfg.pagesClasses (default: all). Navigations to a
    // host stay >= cfg.pageGapMs apart (default 10 s, the crawl policy minimum).
    if (!fetchOnly && cfg.pages?.length && (!cfg.pagesClasses || cfg.pagesClasses.includes(cls))) {
      log.pages = [];
      let lastNav = navAt;
      for (const u of cfg.pages) {
        const wait = (cfg.pageGapMs ?? 10000) - (Date.now() - lastNav);
        if (wait > 0) await sleep(wait);
        lastNav = Date.now();
        try {
          const r = await page.goto(u, { waitUntil: 'load', timeout: 45000 });
          await sleep(cfg.settleMs);
          for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 240); await sleep(60); if (i % 4 === 3 && await page.evaluate(() => scrollY + innerHeight >= document.documentElement.scrollHeight - 2)) break; }
          await sleep(400);
          log.pages.push([u, r ? r.status() : 0, page.url()]);
        } catch (e) { log.pages.push([u, 'ERR ' + String(e.message).split('\n')[0].slice(0, 120), null]); }
      }
    }
    // Explicit fetches of what code analysis derived (URL completion) or the config declared: they enter the HAR like any request.
    if (extraUrls.length) {
      // fetchConcurrency workers share one queue; requests to the page's own host keep the gap (robots crawl-delay);
      // past the deadline the rest is logged as not-fetched:budget (the caller's miss log), never silently dropped.
      log.extra = await page.evaluate(async ([urls, gap, conc, budgetMs]) => {
        const out = [], q = [...urls], until = budgetMs ? Date.now() + budgetMs : Infinity;
        let lastOwn = 0;
        const one = async (u) => {
          const same = new URL(u, location.href).origin === location.origin;
          if (same && gap) { const w = lastOwn + gap - Date.now(); lastOwn = Math.max(Date.now(), lastOwn + gap); if (w > 0) await new Promise(r => setTimeout(r, w)); }
          const ac = new AbortController(); const t = setTimeout(() => ac.abort(), Math.max(1000, Math.min(30000, until - Date.now())));
          try {
            const r = await fetch(u, { credentials: 'same-origin', mode: same ? 'cors' : 'no-cors', signal: ac.signal });
            out.push([u, r.status, (await r.arrayBuffer()).byteLength]);
          } catch (e) { out.push([u, 'ERR ' + e.message, 0]); } finally { clearTimeout(t); }
        };
        const worker = async () => { while (q.length) { if (Date.now() >= until) { for (const u of q.splice(0)) out.push([u, 'not-fetched:budget', 0]); return; } await one(q.shift()); } };
        await Promise.all(Array.from({ length: Math.max(1, conc) }, worker));
        return out;
      }, [extraUrls, cfg.extraGapMs || 0, fetchConcurrency, fetchBudgetMs]);
    }
    await sleep(300);
  } finally {
    // closing the context writes the HAR zip. A pooled handle's close() gives up after 15 s; the HAR of a big site can take
    // longer, so the context close is awaited in full first (a launched handle's close() awaits it anyway)
    if (h?.pooled) { try { await h.context.close(); } catch (e) { console.error('close error:', e.message); } }
    if (h) await h.close();
    clearTimeout(guard);
  }
  if (!fs.existsSync(harPath)) throw new Error(`recording produced no HAR at ${harPath}`);
  return log;
}
