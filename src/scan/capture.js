// Step 3 and 4 of a scan (PLAN §6): freeze one page into a sealed TEMPORARY archive, both viewports, then check the archive
// before anything is recorded on it. The archive lives only while the scan runs (owner's Q1) and is deleted at the end.
import fs from 'node:fs';
import path from 'node:path';
import { freeze } from '../freeze/freeze.js';
import { robotsVerdict, browserUserAgent } from '../safety/robots.js';
import { resolveToolkit } from '../browser/toolkit.js';
import { PINNED_BROWSER } from '../browser/engines.js';

const chromeVersion = (() => { try { return resolveToolkit().browser || PINNED_BROWSER; } catch { return PINNED_BROWSER; } })();
/**
 * Desktop 1440 x 900 and phone 390 x 844 (tablet stays out, owner 22 Oct 2026). Each names REVA in its user agent (owner go
 * 3 Nov); the phone is a phone to the site: mobile, touch, DPR 2 and Chrome on Android's user agent, so a site that picks
 * its phone version on the server serves it. The replay and every take use the same class, so the page sees the same agent.
 */
export const CLASSES = {
  A: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, userAgent: browserUserAgent('desktop', chromeVersion) },
  E: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: browserUserAgent('phone', chromeVersion) },
};
/** Own-host gap between requests, ms (NIGHT_PLAN: 500; a robots Crawl-delay raises it). */
export const OWN_HOST_GAP_MS = 500;
export const PAGE_GAP_MS = 10000;

export function hostId(url) { return new URL(url).hostname.replace(/^www\./, '').replace(/[^\w.-]/g, '-'); }

/** Freeze config: both viewports, the inner pages to visit, the consent banner's non-accepting choice. */
export function scanFreezeConfig(url, { consentClicks = [], crawlDelaySec = null, pages = [] } = {}) {
  const cfg = {
    id: 'scan-' + hostId(url), startUrl: url, classes: CLASSES, pages, pagesClasses: ['A', 'E'], clicks: consentClicks,
    extraGapMs: OWN_HOST_GAP_MS, archiveCapBytes: 600 * 1024 * 1024, mediaMaxBytes: 30 * 1024 * 1024, settleMs: 2500,
  };
  if (crawlDelaySec) { cfg.pageGapMs = Math.max(PAGE_GAP_MS, crawlDelaySec * 1000); cfg.extraGapMs = Math.max(OWN_HOST_GAP_MS, crawlDelaySec * 1000); }
  return cfg;
}

/** The robots Crawl-delay for this URL, in seconds, from the texts the safety gate already read (or null). */
export async function crawlDelayOf(url, safety) {
  try {
    const origin = new URL(url).origin;
    const text = await Promise.resolve(safety?.robotsTexts?.get?.(origin));
    return text ? robotsVerdict(text, [url]).crawlDelay ?? null : null;
  } catch { return null; }
}

/** Checks that make a recording worthless when they fail (a blank or wrong page); the others are noted, not blocking. */
export const HARD_CHECKS = ['noError', 'loadFired', 'docStatus200', 'finalUrlMatches', 'docNotBlank', 'matchesLive'];

/**
 * Judge a sealed archive: what the freeze's own offline replay said per viewport (its checks include the 2 Nov live-versus-
 * replay element count and the 0-byte document guard). A blank or wrong page blocks the recording of that viewport;
 * page errors, a miss of a third-party file and the like are kept as notes, since real pages have them.
 * @returns {{ok:boolean, classes:Record<string,{ok:boolean, reason:string|null, notes:string|null}>}}
 */
export function checkArchive(archiveDir, report = null) {
  const rep = report || JSON.parse(fs.readFileSync(path.join(archiveDir, 'freeze-report.json'), 'utf8'));
  const classes = {};
  for (const [cls, v] of Object.entries(rep.finalReplay || {})) {
    const failed = Object.entries(v.checks || {}).filter(([, x]) => !x).map(([c]) => c);
    const hard = failed.filter((c) => HARD_CHECKS.includes(c));
    const why = [];
    if (hard.length) why.push(`the offline replay check failed (${hard.join(', ')})`);
    else if (!v.checks && !v.pass) why.push('the offline replay check failed');
    const rec = rep.recording?.[cls] || {};
    if (rec.docStatus != null && rec.docStatus >= 400) why.push(`the page answered HTTP ${rec.docStatus} when frozen`);
    const soft = failed.filter((c) => !HARD_CHECKS.includes(c));
    classes[cls] = { ok: !why.length, reason: why.length ? why.join('; ') : null, notes: soft.length ? `replay check noted: ${soft.join(', ')}` : null };
  }
  for (const cls of Object.keys(CLASSES)) if (!classes[cls]) classes[cls] = { ok: false, reason: 'no replay result for this viewport', notes: null };
  return { ok: Object.values(classes).every((c) => c.ok), classes };
}

/** Read the sealed archive's target.json as a loaded target (the archive path made absolute). */
export function targetOf(archiveDir) {
  const t = JSON.parse(fs.readFileSync(path.join(archiveDir, 'target.json'), 'utf8'));
  t.archive = path.resolve(archiveDir);
  t._file = path.join(archiveDir, 'target.json');
  return t;
}

/**
 * Freeze, check, and retry once when the check fails (PLAN §6 step 4). Returns the best archive of the attempts.
 * @returns {Promise<{dir:string, report:object, check:object, attempts:number, wallMs:number}>}
 */
export async function freezePage(url, { work, engine, consentClicks = [], crawlDelaySec = null, log = () => {}, freezeImpl = freeze, retry = true, pages = [], policy = null }) {
  const cfg = scanFreezeConfig(url, { consentClicks, crawlDelaySec, pages });
  const t0 = Date.now();
  let best = null, made = 0;
  for (let attempt = 1; attempt <= (retry ? 2 : 1); attempt++) {
    const dir = path.join(work, attempt === 1 ? 'archive' : `archive-retry`);
    made = attempt;
    fs.rmSync(dir, { recursive: true, force: true });
    log(`freezing ${url} (attempt ${attempt}): both viewports, ${Math.round((cfg.pageGapMs ?? PAGE_GAP_MS) / 1000)} s between pages, ${cfg.extraGapMs} ms between requests to each host of the site`);
    let r;
    try {
      r = await freezeImpl(cfg, { outDir: dir, engine, maxRounds: 3, bounded: { maxUrls: 200, budgetMs: 120000, concurrency: 4 }, allowLive: true, shareBrowser: true, log, policy });
    } catch (e) {
      log(`freeze attempt ${attempt} failed: ${String(e.message).split('\n')[0]}`);
      if (attempt === 1 && retry && !policy?.stopped) continue; // a site that asked REVA to stop is not visited again
      throw e;
    }
    const check = checkArchive(dir, r.report);
    const cur = { dir, report: r.report, check, attempts: attempt, wallMs: Date.now() - t0 };
    const better = !best || Object.values(check.classes).filter((c) => c.ok).length > Object.values(best.check.classes).filter((c) => c.ok).length;
    if (better) { if (best) fs.rmSync(best.dir, { recursive: true, force: true }); best = cur; } else fs.rmSync(dir, { recursive: true, force: true });
    if (check.ok || policy?.stopped) break;
    log(`archive check: ${Object.entries(check.classes).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.reason}`).join('; ')}${attempt === 1 && retry ? '; freezing once more' : ''}`);
  }
  if (!best) throw new Error('the page could not be frozen');
  best.attempts = made; best.wallMs = Date.now() - t0;
  return best;
}
