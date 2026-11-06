// Open states (PLAN §2): menus, modals, tabs, accordions. A click test on every pattern that may be pressed; what stays
// changed is an open state: recorded opening, while open and closing. Depth 1: what appears inside gets a hover at the picture
// floor (DESIGN 3.3), a further open is a not-reached row. A state that will not close ends the session, the next test starts from
// a fresh load. An open never stops early before frame 90: a click transition can start 2.9 s after the press (DESIGN 3.3).
import { recordUnit, leftPage } from './moments.js';
import { LISTENER_INIT, inventoryInPage, stateInPage, stateDiffers, noisyCells, patternsOf, clickVerdict } from './inventory.js';
import { testMember, readReactions, planTests, keepMarks } from './patterns.js';
import { STOP } from './moves/contract.js';

const CLOSE_FRAMES = 60, SETTLE_MS = 800, TEST_WALL_MS = 120000;
/** A click starts an experience: this many files the copy lacks (or in flight), and its canvas drew on fewer frames than this since. */
export const EXPERIENCE = Object.freeze({ misses: 3, drawnFrames: 30, watchFrames: 300, waitMs: 60000, quietMs: 1500, drawing: 30, maxTakes: 2, cover: 0.5 });
/** The rule: a canvas over at least half the screen (EXPERIENCE.cover; a WebGL context somewhere else on the page, off screen or
 * small, is not what the click opened), files the copy lacks or still in flight (at least EXPERIENCE.misses, counted by fileMisses),
 * and a canvas that drew on fewer than EXPERIENCE.drawnFrames frames since the click. A loader label counts only beside loading files. */
export const isExperience = (p) => p.cover >= EXPERIENCE.cover && Math.max(p.misses || 0, p.inflight || 0) >= EXPERIENCE.misses && p.drawnFrames < EXPERIENCE.drawnFrames;
/**
 * The files a click asked for that the copy lacks: GETs, each URL once, none the page had already missed before the click. A POST is a
 * beacon or an API write, never an experience's files, and a URL the arrival missed too is the page's own (a large marketing site, 6 Nov: 14 analytics
 * POSTs and the editor-bar GET of every load made two clicks "experiences" that waited 60 s each for a canvas that never drew).
 * @param {string[]} list  S.net.misses ("METHOD url")   @param {number} from  its length before the click
 */
export function fileMisses(list = [], from = 0) {
  const bare = (m) => m.slice(m.indexOf(' ') + 1).split(/[?#]/)[0];
  const seen = new Set(list.slice(0, from).map(bare)), out = new Set();
  for (const m of list.slice(from)) if (m.startsWith('GET ') && !seen.has(bare(m))) out.add(bare(m));
  return out.size;
}
/** In the page: the largest canvas's share of the screen, the WebGL contexts and canvas draws, a loader (a "NN %" or "loading" label). */
export function experienceProbe() {
  const W = window.__WR, gl = W && W.glCanvas ? W.glCanvas() : { k: -1, frames: 0, contexts: 0 };
  let cover = 0;
  for (const c of document.querySelectorAll('canvas')) { const r = c.getBoundingClientRect(), w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)); cover = Math.max(cover, (w * h) / (innerWidth * innerHeight)); }
  let loader = false, n = 0;
  for (const e of document.querySelectorAll('body *')) {
    if (++n > 4000) break; if (e.children.length > 2) continue;
    const t = (e.textContent || '').trim(), cls = typeof e.className === 'string' ? e.className : '';
    if (!(t.length <= 24 && (/^\d{1,3}\s?%$|^loading\b/i.test(t))) && !/(^|[-_ ])(loader|preloader|loading)([-_ ]|$)/i.test(cls)) continue;
    const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) continue;
    const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || +cs.opacity === 0 || cs.display === 'none') continue;
    loader = true; break;
  }
  return { cover: Math.round(cover * 1000) / 1000, contexts: gl.contexts, canvasK: gl.k, canvasFrames: gl.frames, k: W ? W.frameKey() : null, loader };
}
/** A screen changed this much (cells of 64) may be a page change that draws its cover first: it gets STOP.openLate frames to leave, ending at 2 s quiet. */
const COVER_CELLS = 32;

const clickAt = async (S, sel, phaseFrames, phase, frames) => {
  await S.click({ target: sel, hoverMs: 150, pressMs: 60 });
  await phaseFrames(phase, frames);
};
const near = (base, s, ignore) => !stateDiffers(base, s, { cells: 3, elements: 40, ignore }).changed;

/** Try to shut what is open: the same control, Escape, then a close button. */
async function closeIt(S, c, base, { phaseFrames, ignore }) {
  const phase = `${c.id}:close`;
  await S.mark(phase);   // the phase alone would do on a stored take; a mark is what the take view trusts
  await S.mouse('mouseMoved', 2, 2);
  const key = async () => { for (const type of ['rawKeyDown', 'keyUp']) await S.cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await phaseFrames(phase, CLOSE_FRAMES); };
  const sameControl = async () => { const here = await S.evRetry((q) => { const e = document.querySelector(q); if (!e) return false; const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.width > 0 && !!t && (e === t || e.contains(t) || t.contains(e)); }, c.sel); if (!here) return false; await clickAt(S, c.sel, phaseFrames, phase, CLOSE_FRAMES); return true; };
  const closer = async () => {
    const sel = await S.evRetry(() => {
      const hit = [...document.querySelectorAll('button,[role=button],a,[aria-label],[class*="close" i]')].find((e) => { const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4 || !(e.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true)) return false; return /\b(close|dismiss)\b|^[x×✕]$/i.test(`${e.getAttribute('aria-label') || ''} ${(e.innerText || '').trim()}`.trim()) || /(^|[-_ ])close([-_ ]|$)/i.test(e.getAttribute('class') || ''); });
      if (!hit) return null; hit.setAttribute('data-reva-close', '1'); return '[data-reva-close]';
    });
    if (!sel) return false; await clickAt(S, sel, phaseFrames, phase, CLOSE_FRAMES); return true;
  };
  for (const [how, go] of [['the same control', sameControl], ['Escape', async () => { await key(); return true; }], ['a close button', closer]]) {
    if (!await go()) continue;
    // a slow close: give it up to 2 s more
    for (let i = 0; i < 4; i++) {
      const now = await S.evRetry(stateInPage);
      if (near(base, now, ignore)) return how;
      c.left = stateDiffers(base, now, { cells: 3, elements: 40, ignore });
      await phaseFrames(phase, 30);
    }
  }
  return null;
}

/**
 * Click tests for the patterns of a page and viewport.
 * @param {object} o  recordUnit options, plus `patterns`, `hoverInside` (hover what appears inside), `maxTests`
 * @returns {Promise<{tests:object[], takes:object[]}>} one test per pressable pattern
 */
export async function recordOpens({ patterns, reached = null, members = 2, hoverInside = true, maxTests = 40, onTake = () => {}, ...o }) {
  const queue = [], tests = [];
  for (const p of patterns) {
    const v = clickVerdict(p);
    if (!v.ok) { tests.push({ pattern: p.id, skipped: v.why }); continue; }
    if (queue.length >= maxTests) { tests.push({ pattern: p.id, skipped: null, over: true }); continue; }
    queue.push({ id: `${p.id}:click`, pattern: p.id, sel: p.members[0].sel, text: p.members[0].text });
  }
  // what the pointer could not reach at rest (the links of a closed menu) counts as new when a click reveals it
  const known = new Set(patterns.filter((p) => !reached || reached.has(p.id)).map((p) => p.sig));
  const takes = []; let part = 0;
  while (queue.length) {
    const name = `opens-${part++}`;
    let current = null, timer = null;
    const watch = (S) => { clearTimeout(timer); timer = setTimeout(() => { if (current) current.error = `no answer for ${TEST_WALL_MS / 1000} s`; S.close().catch(() => {}); }, TEST_WALL_MS); };
    const u = await recordUnit({ ...o, name, init: LISTENER_INIT, dropLeft: true }, async ({ S, ready, phaseFrames, shot, result }) => {
      watch(S);
      await ready();
      await S.evRetry(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await S.hold(300);
      const from = await S.evRetry(() => location.href);
      result.tests = [];
      while (queue.length) {
        const c = queue.shift();
        const row = { pattern: c.pattern, id: c.id, sel: c.sel, take: name, text: c.text };
        result.tests.push(row); tests.push(row); current = row; watch(S);
        o.log?.(`${o.viewport} ${name}: pressing "${String(c.text || c.pattern).slice(0, 40)}"`);
        const at = await S.locate(c.sel);
        if (!at) { row.gone = true; continue; }
        // the settle doubles as this test's control window: what moves in it asks for no picture while the test runs
        await S.controlStart();
        await S.hold(SETTLE_MS);
        const look = await S.evRetry(stateInPage);
        await S.hold(SETTLE_MS);
        const base = await S.evRetry(stateInPage);
        await S.controlStop();
        const ignore = noisyCells(look, base);
        await S.mark(`${c.id}:open`);
        await S.partStart();
        const before = S.inputLog.length, missesBefore = S.net?.misses?.length ?? 0;
        const glBefore = await S.evRetry(() => (window.__WR.glCanvas ? window.__WR.glCanvas() : { frames: 0 })).catch(() => ({ frames: 0 }));
        try { await clickAt(S, c.sel, phaseFrames, `${c.id}:open`, STOP.openMin); }
        catch (e) { if (S.deadError) throw e; row.error = String(e.message).split('\n')[0].slice(0, 200); return; }
        row.pressed = S.inputLog.length > before;
        row.stopped = { open: STOP.openMin };
        let d = stateDiffers(base, await S.evRetry(stateInPage), { ignore });
        if (d.cells >= COVER_CELLS && !d.navigated) { row.stopped.open += await phaseFrames(`${c.id}:open`, STOP.openLate, { quiet: STOP.lateQuiet }); d = stateDiffers(base, await S.evRetry(stateInPage), { ignore }); }
        row.diff = d;
        // a click that starts a WebGL experience loading (files the copy lacks, or a loader, on a page that has a canvas): its own take
        // waits for it to draw (scanPage, recordExperience); this test only says so
        try { let p = await S.evRetry(experienceProbe), misses = fileMisses(S.net?.misses, missesBefore), inflight = S.netInFlight?.() ?? 0;
          // a canvas that has not drawn while a file or two is asked for: the experience may still be starting (a WebGL gallery site, 6 Nov: 2 files at
          // 0.5 s, 3 more at 2.7 s); watch up to EXPERIENCE.watchFrames more, 30 at a time, until it draws or the files make it an experience
          for (let w = 0; w < EXPERIENCE.watchFrames && p.cover >= EXPERIENCE.cover && p.canvasFrames - glBefore.frames < EXPERIENCE.drawnFrames && (misses > 0 || inflight > 0 || p.loader) && Math.max(misses, inflight) < EXPERIENCE.misses; w += 30) {
            row.stopped.open += await phaseFrames(`${c.id}:open`, 30);
            p = await S.evRetry(experienceProbe); misses = fileMisses(S.net?.misses, missesBefore); inflight = S.netInFlight?.() ?? 0;
          }
          // files must be loading: a "loading" label alone is no experience (a shader-transition site, 6 Nov: a page-change loader that stays in the DOM)
          if (isExperience({ ...p, misses, inflight, drawnFrames: p.canvasFrames - glBefore.frames })) row.experience = { misses, inflight, loader: p.loader, cover: p.cover, drawnFrames: p.canvasFrames - glBefore.frames }; } catch (e) { if (S.deadError) throw e; }
        const to = await leftPage(S, from);
        if (to) { row.navigated = to; await keepMarks(S); return; } // the page left: the rest starts from a fresh load
        await S.mark(`${c.id}:opened`);
        if (!d.changed) { row.opened = false; await S.controlClear(); await S.mark(`${c.id}:end`); continue; }
        row.opened = true;
        // depth 1: what appeared inside
        const inv = await S.evRetry(inventoryInPage, {}).catch(() => null);
        const fresh = inv ? patternsOf(inv).filter((p) => !known.has(p.sig)) : [];
        row.inside = fresh.map((p) => ({ id: p.id, n: p.n, kind: p.kind, text: p.members[0].text, sel: p.members[0].sel }));
        for (const p of fresh) known.add(p.sig);
        if (hoverInside) for (const raw of planTests(fresh.slice(0, STOP.insidePatterns), { members, modes: o.viewport === 'desktop' ? ['focus', 'hover'] : [] })) {
          const t = { ...raw, id: `${c.id}/${raw.id}`, inside: true };
          try { (row.insideTests ||= []).push({ ...await testMember(S, t, { phaseFrames, shot }), take: name }); }
          catch (e) { if (S.deadError) throw e; }
        }
        const how = await closeIt(S, c, base, { phaseFrames, ignore });
        row.closedBy = how; if (!how) row.left = c.left;
        await S.controlClear();
        await S.mark(`${c.id}:end`);
        if (!how) { // it stays open: the next test needs a clean page. Or it was a page change all along
          const late = await leftPage(S, from);
          if (late) { row.opened = false; row.navigated = late; await keepMarks(S); }
          return;
        }
      }
    }).catch((e) => {
      // the page died on this press (a renderer crash, a hang): the test says so, the next one starts from a fresh load
      if (!current) throw e;
      current.error = current.error || String(e.message).split('\n')[0].slice(0, 200);
      current.lost = true;
      return null;
    }).finally(() => clearTimeout(timer));
    if (!u) continue;
    readReactions(u.dir, u.tests.flatMap((t) => t.insideTests || []));
    for (const t of u.tests) for (const m of t.insideTests || []) delete m.ids;
    takes.push(u); onTake(u);
    if (!u.tests.length) break;
  }
  return { tests, takes };
}
