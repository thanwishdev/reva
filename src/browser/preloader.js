// Preloader wait (C1, 1 Nov 2026). Award WebGL showpieces often open on a loader (an overlay named "loader"/"preloader",
// a progress bar, a "37%" counter, or a one-colour screen with no words while a 3D scene downloads). The corpus took its
// live evidence, its scroll sweep and its static read while that loader still ran, so the page read as near-empty and the
// site dropped out of the cards. waitForPreloader() polls cheap DOM signals (plus a small screenshot colour count) until
// the loader is gone for `stablePolls` reads in a row, or the cap passes, and returns what it saw so the caller can record
// the outcome. It never clicks, types or scrolls: a "click to enter" gate stays a gate.
import { PNG } from 'pngjs';

export const PRELOADER_DEFAULTS = Object.freeze({ capMs: 20000, pollMs: 500, stablePolls: 2, shot: true });

// id/class words of a loader overlay. Word-bounded on space, "_" and "-", so "loaded", "is-loaded" and "lazyload" do not match.
export const LOADER_NAME = /(^|[\s_-])(pre-?loader|preload(ing)?|loader|loading|load-?screen|loading-?screen|splash|progress|intro-?(screen|overlay|loader))([\s_-]|$)/i;

/**
 * In-page probe, run with page.evaluate (must stay self-contained: no closure variables). DOM signals only.
 * @returns {{loaderEls:Array<{sel:string,cover:number}>, progress:number, pct:string[], bigCanvas:number|null, words:number, scrollable:boolean, readyState:string}}
 */
export function preloaderProbe(namePattern) {
  const NAME = new RegExp(namePattern, 'i');
  const PCT = /^\d{1,3}(\.\d+)?\s?%$/;
  const vw = innerWidth, vh = innerHeight, area = Math.max(1, vw * vh);
  const loaderEls = [], pct = []; let progress = 0, bigCanvas = null;
  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length && i < 15000; i++) {
    const el = all[i];
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) continue;
    const cover = (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) / area;
    const tag = el.tagName;
    if (tag === 'PROGRESS' || el.getAttribute('role') === 'progressbar') progress++;
    const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
    if (cover >= 0.25 && NAME.test(`${el.id || ''} ${cls}`)) loaderEls.push({ sel: tag.toLowerCase() + (el.id ? `#${el.id}` : '') + (cls ? `.${cls.trim().split(/\s+/)[0]}` : ''), cover: Math.round(cover * 100) / 100 });
    if (el.childElementCount === 0) { const t = (el.textContent || '').trim(); if (t.length <= 8 && PCT.test(t)) pct.push(t); }
    if (tag === 'CANVAS' && cover >= 0.5) bigCanvas = Math.max(bigCanvas || 0, Math.round(cover * 100) / 100);
  }
  const text = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim();
  return { loaderEls: loaderEls.slice(0, 5), progress, pct: pct.slice(0, 3), bigCanvas, words: text ? text.split(' ').length : 0,
    scrollable: document.documentElement.scrollHeight > vh + 50, readyState: document.readyState };
}

/** Share of the most common colour (5 bits a channel) in a PNG screenshot, sampling every `step`-th pixel both ways. */
export function screenStats(png, step = 8) {
  const img = PNG.sync.read(png); const { width: w, height: h, data } = img;
  const counts = new Map(); let n = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 4; const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    counts.set(k, (counts.get(k) || 0) + 1); n++;
  }
  let max = 0; for (const c of counts.values()) if (c > max) max = c;
  return { w, h, dominantShare: n ? Math.round((max / n) * 1000) / 1000 : null, colours: counts.size };
}

/**
 * Pure verdict on one probe (+ optional screen stats). A weak page = few words or nothing to scroll; the weaker signals
 * (a counter, a progress bar, a one-colour screen) only count on a weak page, so a "98%" stat or a reading-progress bar in
 * a real page never holds the capture.
 * @returns {{loading:boolean, reasons:string[]}}
 */
export function classifyPreloader(p, stats = null) {
  const reasons = [];
  if (!p) return { loading: false, reasons };
  const weak = (p.words ?? 0) < 60 || p.scrollable === false;
  if (p.loaderEls?.length) reasons.push(`loader element ${p.loaderEls[0].sel} covers ${Math.round(p.loaderEls[0].cover * 100)} %`);
  if (p.pct?.length && weak) reasons.push(`percentage counter "${p.pct[0]}"`);
  if (p.progress > 0 && weak) reasons.push('progress bar');
  if (stats?.dominantShare != null && stats.dominantShare >= 0.97 && (p.words ?? 0) < 15) reasons.push(`one-colour screen (${Math.round(stats.dominantShare * 100)} %), ${p.words ?? 0} words${p.bigCanvas ? ', large canvas' : ''}`);
  return { loading: reasons.length > 0, reasons };
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until the preloader is gone (`stablePolls` clear reads in a row) or `capMs` passes. Never throws for a page error:
 * a failed probe counts as "not loading" (the caller goes on as before).
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{state:'none'|'cleared'|'cap', waitedMs:number, polls:number, first:string[], last:string[]}>}
 *   none: no loader at the first read; cleared: a loader was seen and went away; cap: still loading at the cap.
 */
export async function waitForPreloader(page, opts = {}) {
  const o = { ...PRELOADER_DEFAULTS, ...opts }; const now = o.now || Date.now; const sleep = o.sleep || realSleep;
  const t0 = now(); let polls = 0, clear = 0, first = null, last = [];
  const read = async () => {
    polls++;
    let p = null, stats = null;
    try { p = await page.evaluate(preloaderProbe, LOADER_NAME.source); } catch { return { loading: false, reasons: [] }; }
    if (o.shot && (p.words ?? 0) < 15) { try { stats = screenStats(await page.screenshot({ type: 'png', timeout: 5000 })); } catch { stats = null; } }
    return classifyPreloader(p, stats);
  };
  for (;;) {
    const v = await read();
    if (first === null) first = v.reasons;
    if (v.loading) { clear = 0; last = v.reasons; } else clear++;
    if (!first.length && clear >= 1) return { state: 'none', waitedMs: now() - t0, polls, first: [], last: [] };
    if (clear >= o.stablePolls) return { state: 'cleared', waitedMs: now() - t0, polls, first, last };
    if (now() - t0 >= o.capMs) return { state: 'cap', waitedMs: now() - t0, polls, first, last };
    await sleep(o.pollMs);
  }
}
