// Static-layer session driver (PLAN M4 "Static layer"). One browser session of its own (never shared with a motion take,
// PLAN M4 DONE-WHEN): per variant it loads the page, settles it, reads computed styles + layout boxes, resolves the winning
// declarations through the CDP CSS domain, forces :hover/:focus on interactive elements, reads platform fonts, takes an
// ariaSnapshot; then it sweeps widths for breakpoints. Nothing is fetched twice, nothing is written into the page
// (only a non-enumerable matchMedia query log), no style is injected.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../browser/launch.js';
import { ensureOutDir, assertOutsideRepo } from '../util/paths.js';
import { PROPS, IDX, SIDES, CORNERS, STATE_PROPS } from './props.js';
import { STATIC_SCHEMA, Ledger, measured, declared as decl, inferred } from './prov.js';
import { settlePage, extractElements, inventory, mediaHookInit, textSignature } from './inpage.js';
import { buildTokens, styleObject } from './tokens.js';
import { openCss, listMediaQueries, nodeIdsForRows, matchedStyles, pseudoView, pickDeclared, declaredPart, checkConsistency, platformFonts, forcedComputed, isGoneError } from './cdpcss.js';
import { sweepBreakpoints, queryEdges, explainEdges } from './breakpoints.js';
import { defaultEngine } from '../browser/engines.js';
import { waitForPreloader } from '../browser/preloader.js';
import { declaredTransition } from './transition.js';

export const DEFAULT_VARIANTS = [
  { id: 'desktop-1440', width: 1440, height: 900 },
  { id: 'tablet-920', width: 920, height: 1000 },
  { id: 'mobile-390', width: 390, height: 844, touch: true },
  { id: 'desktop-1440-dark', width: 1440, height: 900, colorScheme: 'dark', light: true },
  { id: 'desktop-1440-reduced-motion', width: 1440, height: 900, reducedMotion: 'reduce', light: true },
];

const DECL_LONGHANDS = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'color', 'background-color',
  ...SIDES.map(s => `border-${s}-color`), ...SIDES.map(s => `margin-${s}`), ...SIDES.map(s => `padding-${s}`), 'row-gap', 'column-gap',
  ...CORNERS.map(c => `border-${c}-radius`), 'box-shadow', 'text-shadow'];

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hostAllowed = (u, allow) => { try { return allow.includes(new URL(u).hostname.toLowerCase()); } catch { return false; } };
const isLocalUrl = u => { try { const x = new URL(u); return x.protocol === 'file:' || x.protocol === 'data:' || x.protocol === 'about:' || x.protocol === 'blob:' || ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname); } catch { return false; } };

/** Live loads need an explicit opt-in (PLAN M4 stop-and-ask, WAITING W3): refuse anything but localhost/file unless allowLive is passed. */
export function assertLocalTarget(url, allowLive = false) {
  if (!allowLive && !isLocalUrl(url)) throw new Error(`refusing to load ${url}: a live site needs --allow-live and permission to load it; only localhost / file: targets run without it`);
}

function writeSeries(outDir, name, obj) {
  const body = JSON.stringify(obj); const sha = sha256(body);
  const dir = path.join(outDir, 'series'); fs.mkdirSync(dir, { recursive: true });
  const file = `${name}-${sha.slice(0, 16)}.json`;
  fs.writeFileSync(path.join(dir, file), body);
  return { file: `series/${file}`, sha256: sha, bytes: Buffer.byteLength(body) };
}

async function applyVariant(h, css, v, base) {
  const { page } = h;
  await page.setViewportSize({ width: v.width, height: v.height });
  // pinned, never null: null hands the media feature back to the OS (macOS auto appearance turns dark at night),
  // so the same archive would read a different palette depending on the time of day
  await page.emulateMedia({ colorScheme: v.colorScheme ?? 'light', reducedMotion: v.reducedMotion ?? 'no-preference' });
  await css.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: !!v.touch, ...(v.touch ? { maxTouchPoints: 5 } : {}) });
  await page.goto(base, { waitUntil: 'load' });
  css.docFetched = false;
}

/** Declared layer for a chosen subset of rows (cascade winner + consistency check). Mutates rows[].decl. */
async function resolveDeclared(css, page, data, ledger, { maxRows, vars, rootFontPx }) {
  const { rows, styles } = data;
  const byId = new Map(rows.map(r => [r.id, r]));
  const seenStyle = new Set(); const pick = [];
  const add = r => { if (!pick.includes(r)) pick.push(r); };
  for (const r of rows) if (r.elId) add(r);
  for (const r of rows) if (r.pseudo) add(r);
  for (const r of rows) if (r.text && !seenStyle.has(r.s)) { seenStyle.add(r.s); add(r); }
  for (const r of rows) if (!seenStyle.has('b' + r.s)) { seenStyle.add('b' + r.s); add(r); }
  const chosen = pick.slice(0, maxRows);
  if (pick.length > maxRows) ledger.add('unk_declared_rows_capped', `declared sources were resolved for ${maxRows} of ${pick.length} representative elements`, 'raise maxDeclaredRows', 'declared');
  const nodeIds = await nodeIdsForRows(css, chosen.map(r => r.id));
  let resolved = 0, dropped = 0;
  for (const r of chosen) {
    const nodeId = nodeIds.get(r.id); if (!nodeId) continue;
    let m = await matchedStyles(css, nodeId); if (!m) continue;
    if (r.pseudo) m = pseudoView(m, r.pseudo); if (!m) continue;
    const st = styleObject(styles, r);
    const parent = byId.get(r.parent);
    const ctx = { vars, rootFontPx, fontSizePx: parseFloat(st['font-size']), parentFontSizePx: parent ? parseFloat(styleObject(styles, parent)['font-size']) : undefined };
    r.decl = {};
    for (const prop of DECL_LONGHANDS) {
      const w = pickDeclared(m, prop, css.sheets); if (!w) continue;
      const part = declaredPart(prop, w.name, w.value);
      const chk = part.exact ? checkConsistency(prop, part.text, st[prop], { ...ctx, via: w.via }) : { result: 'unchecked', reason: `shorthand "${w.name}": part for ${prop} not isolated` };
      if (chk.result === 'inconsistent') {
        dropped++;
        if (dropped <= 20) ledger.add('unk_declared_inconsistent', `winning declaration "${w.name}: ${w.value}" disagrees with the computed ${prop} = ${st[prop]}: the declared source is not reported`, 'inspect cascade layers / @property / registered custom properties', `${r.sel} ${prop}`);
        continue;
      }
      r.decl[prop] = { text: part.exact ? part.text : w.value, from: w.name, file: w.file, line: w.line, selector: w.selector, important: w.important, via: w.via, verified: chk.result === 'consistent', ...(chk.reason ? { note: chk.reason } : {}) };
      resolved++;
    }
  }
  if (dropped > 20) ledger.add('unk_declared_inconsistent_more', `${dropped - 20} further declared sources were dropped for the same reason`, 'see unk_declared_inconsistent', 'declared');
  return { rowsLooked: chosen.length, resolved, dropped, rowIds: new Set(chosen.map(r => r.id)), nodeIds };
}

// the declared transition (property, duration, easing, delay) is read for the first controls only
const TRANSITION_CONTROLS = 10;
async function interactiveStates(css, page, data, ledger, { max }) {
  const { rows } = data;
  const inter = rows.filter(r => r.interactive && r.rendered).slice(0, max);
  if (rows.filter(r => r.interactive && r.rendered).length > max) ledger.add('unk_states_capped', `forced states read for ${max} interactive elements only`, 'raise maxStates', 'states');
  const nodeIds = await nodeIdsForRows(css, inter.map(r => r.id));
  const out = [];
  let gone = 0;
  let ctl = 0;
  for (const r of inter) {
    const nodeId = nodeIds.get(r.id); if (!nodeId) continue;
    const timed = ctl++ < TRANSITION_CONTROLS;
    try {
      const rest = await forcedComputed(css, page, nodeId, []);
      for (const [state, classes] of [['hover', ['hover']], ['focus', ['focus', 'focus-visible']]]) {
        const forced = await forcedComputed(css, page, nodeId, classes);
        // the transition that runs INTO the state is the one declared in the state (the destination style): its timing, per control
        const transition = timed ? declaredTransition(forced) : null;
        for (const p of STATE_PROPS) if (forced[p] !== undefined && forced[p] !== rest[p]) out.push({ sel: r.sel, state, prop: p, rest: measured(rest[p]), value: measured(forced[p], { state }), ...(transition ? { transition } : {}) });
      }
    } catch (e) { if (!isGoneError(e)) throw e; gone++; } // the page replaced this element since its node id was resolved (corpus F25): skip it, say so
  }
  if (gone) ledger.add('unk_states_gone', `${gone} interactive element(s) were replaced by the page while their forced states were read; skipped`, 'rerun or read them with a settled page', 'states');
  return out;
}

async function fontsUsed(css, data, nodeIdsCache) {
  const { rows } = data; const seen = new Set(); const reps = [];
  for (const r of rows) if (r.text && r.rendered && !seen.has(r.s)) { seen.add(r.s); reps.push(r); }
  const need = reps.filter(r => !nodeIdsCache.has(r.id)).map(r => r.id);
  if (need.length) for (const [k, v] of await nodeIdsForRows(css, need)) nodeIdsCache.set(k, v);
  const agg = new Map();
  for (const r of reps) {
    const nodeId = nodeIdsCache.get(r.id); if (!nodeId) continue;
    const fonts = await platformFonts(css, nodeId); if (!fonts) continue;
    for (const f of fonts) {
      const k = [f.familyName, f.postScriptName, f.isCustomFont].join('|');
      const e = agg.get(k) || { familyName: f.familyName, postScriptName: f.postScriptName, isCustomFont: !!f.isCustomFont, glyphCount: 0, styleGroups: 0, examples: [] };
      e.glyphCount += f.glyphCount; e.styleGroups++; if (e.examples.length < 3) e.examples.push(r.sel); agg.set(k, e);
    }
  }
  return [...agg.values()].sort((a, b) => b.glyphCount - a.glyphCount);
}

/**
 * @param {object} o
 * @param {string} o.url            target URL (localhost / file: unless allowLive)
 * @param {string} [o.outDir]       output folder (default: <out root>/static/<id>); never inside the repo (H2)
 * @param {'cft'|'chs'} [o.engine]
 * @param {Array}  [o.variants]     DEFAULT_VARIANTS
 * @param {object} [o.sweep]        {from,to,step} width sweep for breakpoints
 */
export async function extractStatic({ url, outDir, engine = defaultEngine(), variants = DEFAULT_VARIANTS, sweep = {}, allowLive = false, allowHosts = [], offlineReplay = false, prepare, launchArgs = [], maxDeclaredRows = 400, maxStates = 40, maxElements = 4000, a11y = true, saveScripts = true, prefs, signal, settleText = null, afterLoad = null, preloader = null, log = () => {} } = {}) {
  // a11y=false: no ariaSnapshot (it holds the page's words); saveScripts=false: no JS bodies on disk; prefs: browser profile
  // prefs (e.g. the WebRTC no-UDP policy); signal: an AbortSignal that closes the browser (the session then fails fast)
  // offlineReplay: the page is served from an archive by `prepare(context)` (e.g. routeFromHAR). The guard below is registered
  // BEFORE prepare, so every request the archive does not fulfil falls through to it, is aborted and counted (a replay miss).
  if (offlineReplay && typeof prepare !== 'function') throw new Error('offlineReplay needs a prepare(context) that installs the archive routes');
  assertLocalTarget(url, allowLive || offlineReplay);
  const t0 = Date.now();
  const ledger = new Ledger();
  const id = `static-${new Date().toISOString().replace(/[:.]/g, '-')}-${sha256(url).slice(0, 6)}`;
  outDir = outDir ? assertOutsideRepo(path.resolve(outDir)) : ensureOutDir('static', id);
  fs.mkdirSync(outDir, { recursive: true });

  const h = await launchBrowser({ engine, args: launchArgs, prefs, context: { viewport: { width: variants[0].width, height: variants[0].height }, deviceScaleFactor: 1 } });
  const onAbort = () => { h.close().catch(() => {}); };
  if (signal) { if (signal.aborted) { await h.close(); throw Object.assign(new Error('static: cancelled'), { code: 'cancelled' }); } signal.addEventListener('abort', onAbort, { once: true }); }
  const resources = []; const blocked = [];
  try {
    const { context, page } = h;
    if (!allowLive) await context.route('**/*', route => { const u = route.request().url(); if (!offlineReplay && (isLocalUrl(u) || hostAllowed(u, allowHosts))) return route.continue(); blocked.push(u); return route.abort('blockedbyclient'); });
    if (prepare) await prepare(context, page);
    await page.addInitScript(mediaHookInit);
    const scripts = []; // JS bodies are written to <outDir>/scripts/<sha>.js for the bundle-signature step (src/libdetect, P4); nothing is analysed here
    const saveScript = (name, buf) => {
      const sha = sha256(buf); const dir = path.join(outDir, 'scripts'); fs.mkdirSync(dir, { recursive: true });
      const file = `scripts/${sha.slice(0, 16)}.js`; fs.writeFileSync(path.join(outDir, file), buf);
      return { name, bytes: buf.length, sha256: sha, file };
    };
    page.on('response', async resp => {
      try {
        const req = resp.request(); let bytes = null, src = 'body', buf = null;
        try { buf = await resp.body(); bytes = buf.length; } catch { const cl = resp.headers()['content-length']; bytes = cl != null ? +cl : null; src = 'content-length header'; }
        const mime = (resp.headers()['content-type'] || '').split(';')[0];
        resources.push({ url: resp.url(), status: resp.status(), type: req.resourceType(), mime, bytes, bytesSource: bytes == null ? null : src });
        if (saveScripts && buf && (req.resourceType() === 'script' || /javascript|ecmascript/.test(mime)) && bytes <= 8 * 1024 * 1024) scripts.push(saveScript(resp.url(), buf));
      } catch {}
    });
    const css = await openCss(context, page);
    const fontFaces = [];
    css.cdp.on('CSS.fontsUpdated', e => { if (e.font) fontFaces.push({ family: e.font.fontFamily, src: e.font.src, platformFamily: e.font.platformFontFamily }); });
    const browserInfo = await css.cdp.send('Browser.getVersion').catch(() => ({}));

    const out = { variants: [], a11y: [] };
    let preCap = null;
    let baseData = null, baseInventory = null, declaredQueries = [], baseDeclMeta = null, fontsByVariant = {};
    // a page that reloads or redirects right after it loads destroys the context mid-variant: wait for the new document and
    // read the whole variant again from its start (at most twice); the ledger names the variant
    const NAV_ERR = /Execution context was destroyed/; // not "navigating to" in a goto timeout
    const afterNav = async (e, attempt, what) => {
      if (attempt >= 2 || !NAV_ERR.test(e.message)) throw e;
      log(`${what}: the page navigated (${String(e.message).split('\n')[0]}); again`);
      ledger.add('unk_page_navigated', `the page reloaded or navigated during ${what}; it was read again on the new document`, 'a script that reloads or redirects after load', what);
      await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    };
    for (const [vi, v] of variants.entries()) for (let attempt = 0; ; attempt++) try {
      log(`variant ${v.id}`);
      await applyVariant(h, css, v, url);
      // preloader = { capMs }: C1 (1 Nov) wait for a loader overlay / counter / one-colour screen to go before the read;
      // after one variant hit the cap (a loader the archive cannot finish) the next variants wait at most 3 s
      let preWait = null;
      if (preloader) {
        preWait = await waitForPreloader(page, { capMs: preCap ?? (preloader.capMs ?? 20000) }).catch(e => ({ state: 'error', error: String(e.message || e).split('\n')[0].slice(0, 200) }));
        if (preWait.state === 'cap') preCap = Math.min(preloader.capMs ?? 20000, 3000);
        if (preWait.state !== 'none') log(`variant ${v.id}: preloader ${preWait.state} after ${preWait.waitedMs} ms (${(preWait.first || []).join('; ')})`);
      }
      const settle = await page.evaluate(settlePage);
      // afterLoad(page): the caller's step once the variant has loaded and settled (REVA's design pass rejects a cookie banner)
      if (afterLoad) { try { if (await afterLoad(page)) await page.evaluate(settlePage); } catch {} }
      // script-sized text (a resize handler, a debounced fit-text) can change after the frames settlePage waits for:
      // sample the text sizes until three reads in a row agree (REVA's design pass), and once more after the extract
      let textSettle = null;
      if (settleText) {
        const t0 = Date.now(); const sig = () => page.evaluate(textSignature).catch(() => null);
        const seen = [await sig()];
        // three equal reads of NO text at all are not a settled page: a preloader that has not drawn its words yet looks the
        // same three times (measured on a real site: 1 run in 4 read an empty page). Wait for the first words, up to maxMs.
        const agree = () => seen.length >= 3 && seen.slice(-3).every(x => x === seen[seen.length - 1]);
        const hasText = () => /\d+(\.\d+)?pxx\d/.test(String(seen[seen.length - 1]));
        while (Date.now() - t0 < (settleText.maxMs ?? 5000) && !(agree() && hasText())) {
          await page.waitForTimeout(settleText.everyMs ?? 300); seen.push(await sig());
        }
        textSettle = { stable: agree(), samples: seen.length, ms: Date.now() - t0, last: seen[seen.length - 1], ...(hasText() ? {} : { noText: true }) };
      }
      const data = await page.evaluate(extractElements, { props: PROPS, maxElements });
      if (textSettle) { const after = await page.evaluate(textSignature).catch(() => null); if (after !== textSettle.last) textSettle.stable = false; delete textSettle.last; }
      if (data.truncated) ledger.add('unk_elements_truncated', `more than ${maxElements} elements: the rest were not read`, 'raise maxElements', v.id);
      const rec = { id: v.id, viewport: measured({ width: data.page.innerWidth, height: data.page.innerHeight }, { from: 'window.innerWidth/innerHeight' }),
        requested: { width: v.width, height: v.height, colorScheme: v.colorScheme ?? 'light', reducedMotion: v.reducedMotion ?? 'no-preference', touch: !!v.touch },
        media: measured({ pointerCoarse: data.page.pointerCoarse, hoverNone: data.page.hoverNone, prefersDark: data.page.colorSchemeDark, prefersReducedMotion: data.page.reducedMotion }, { from: 'matchMedia' }),
        document: measured({ scrollWidth: data.page.scrollWidth, scrollHeight: data.page.scrollHeight }, { from: 'documentElement.scrollWidth/Height' }),
        settle: measured(settle, { from: 'document.fonts.ready + finish()/cancel() of CSS animations' }), elementCount: data.rows.length,
        ...(preWait ? { preloader: measured(preWait, { from: 'waitForPreloader: loader element / counter / progress bar / one-colour screen, polled until gone or the cap' }) } : {}),
        ...(textSettle ? { textSettle: measured(textSettle, { from: 'text font sizes + document height sampled until three reads agree, and once after the extract' }) } : {}) };

      const nodeIdsCache = new Map();
      if (!v.light) {
        // declared layer (cascade winners) and the custom-property values needed to check var() references
        const inv = vi === 0 ? await page.evaluate(inventory) : null;
        if (inv) baseInventory = inv;
        const names = [...new Set((baseInventory?.customProps || []).map(c => c.name))];
        const vars = await page.evaluate(ns => Object.fromEntries(ns.map(n => [n, getComputedStyle(document.documentElement).getPropertyValue(n)])), names);
        const rootFontPx = parseFloat(data.page.rootFontSize);
        const dm = await resolveDeclared(css, page, data, ledger, { maxRows: maxDeclaredRows, vars, rootFontPx });
        for (const [k, nid] of dm.nodeIds) nodeIdsCache.set(k, nid);
        rec.declaredLookup = { rowsLooked: dm.rowsLooked, declarations: dm.resolved, droppedInconsistent: dm.dropped };
        rec.states = await interactiveStates(css, page, data, ledger, { max: maxStates });
        if (vi === 0) { declaredQueries = await listMediaQueries(css); baseDeclMeta = { hooked: await page.evaluate(() => window.__reva_mm || []) }; }
        fontsByVariant[v.id] = await fontsUsed(css, data, nodeIdsCache);
        rec.fontsUsed = fontsByVariant[v.id];
      }
      rec.tokens = buildTokens(data, { ledger, variant: v.id });
      // a11y
      if (a11y) try {
        const snap = await page.ariaSnapshot({ mode: 'ai', boxes: true });
        const noBoxes = snap.replace(/ \[box=[^\]]*\]/g, '').replace(/ \[ref=e\d+\]/g, '');
        out.a11y.push({ variant: v.id, mode: measured('ai+boxes', { from: 'page.ariaSnapshot' }), snapshot: snap, structureSha256: sha256(noBoxes), lines: snap.split('\n').length });
      } catch (e) { out.a11y.push({ variant: v.id, snapshot: ledger.add('unk_aria_snapshot', `ariaSnapshot failed: ${e.message}`, 'retry with mode default', v.id) }); }
      rec.elements = writeSeries(outDir, `elements-${v.id}`, { rows: data.rows, styles: data.styles, props: PROPS });
      rec.iframes = data.iframes; rec.canvases = data.canvases; rec.shadowHosts = data.shadowHosts;
      for (const f of data.iframes) ledger.add('unk_iframe_content', `iframe ${f.sel} (${f.src ?? 'no src'}) content is not traversed by the static layer`, 'run the static layer on the iframe URL', f.sel);
      for (const c of data.canvases) ledger.add('unk_canvas_pixels', `canvas ${c.sel}: colours drawn into a canvas are pixels, not styles`, 'sample the pixels (screenshot + pixel read) or read the drawing code', c.sel);
      if (vi === 0) baseData = data;
      out.variants.push(rec);
      break;
    } catch (e) { await afterNav(e, attempt, `variant ${v.id}`); }

    // ---- breakpoints (base variant, touch off)
    const base = variants[0];
    let hooked;
    for (let attempt = 0; ; attempt++) try {
      await applyVariant(h, css, base, url);
      await page.evaluate(settlePage);
      hooked = await page.evaluate(() => window.__reva_mm || []);
      break;
    } catch (e) { await afterNav(e, attempt, 'breakpoint setup'); }
    const cssTexts = [...new Set(declaredQueries.map(q => q.text))];
    const allTexts = [...new Set([...cssTexts, ...hooked])];
    const qe = await queryEdges(page, allTexts, { from: 200, to: 2600 });
    const queryList = [];
    for (const t of allTexts) {
      const d = declaredQueries.filter(q => q.text === t);
      const isCss = d.length > 0, isJs = hooked.includes(t);
      const e = qe[t] || { edges: [] };
      if (e.error) { ledger.add('unk_query_rejected', `matchMedia rejected "${t}"`, 'check the query syntax', t); continue; }
      queryList.push({ query: t, source: isCss ? 'css' : 'js-matchMedia', alsoJs: isCss && isJs, file: d[0]?.file ?? null, edges: e.edges.map(x => ({ lastOld: x.lastOld, firstNew: x.firstNew })), matchesAtSweepStart: e.at, engineExpressions: d[0]?.expressions ?? [] });
    }
    const extra = queryList.flatMap(q => q.edges.flatMap(e => [e.lastOld - 1, e.lastOld, e.firstNew, e.firstNew + 1]));
    log('breakpoint sweep');
    const sw = await sweepBreakpoints(page, { from: sweep.from ?? 320, to: sweep.to ?? 1920, step: sweep.step ?? 40, height: base.height, declaredEdgeWidths: extra, ignoreWrap: !!sweep.ignoreWrap, maxProbesPerInterval: sweep.maxProbesPerInterval ?? Infinity });
    if (sw.navigations.length) ledger.add('unk_breakpoint_navigation', `the page reloaded or navigated at ${sw.navigations.length} sweep width(s) (${sw.navigations.slice(0, 5).map(n => n.width + 'px').join(', ')}); those widths were measured on the new document`, 'a resize handler that reloads or redirects (e.g. a mobile site): check the url per width', sw.navigations.map(n => n.width).join(','));
    const ex = explainEdges(sw.edges.map(({ lastOld, firstNew, reflowOnly, fluidInterval }) => ({ lastOld, firstNew, reflowOnly, ...(fluidInterval ? { fluidInterval } : {}) })), queryList);
    // Unexplained edges that sit <= 2 px apart in runs of >= 4 are one continuously varying property (viewport-unit sizing, rounding)
    // that the fluid mask did not catch, not hundreds of breakpoints: one ledger entry per run (every edge still points at it).
    const runOf = new Map();
    { const un = ex.explained.filter(e => !e.explainedBy.length && !e.reflowOnly && !e.fluidInterval).sort((a, b) => a.firstNew - b.firstNew);
      let cur = [];
      const flush = () => { if (cur.length >= 4) { const lo = cur[0].lastOld, hi = cur[cur.length - 1].firstNew;
        const u = ledger.add('unk_breakpoint_continuous', `${cur.length} layout changes between ${lo}px and ${hi}px, each at most 2px from the next: a continuously varying property (viewport-unit sizing or rounding) that the fluid mask did not catch, not a discrete breakpoint`, 'compare rect sizes across the interval; a discrete gate inside it would need a signature on rects only', `${lo}-${hi}`);
        for (const e of cur) runOf.set(e, u); } cur = []; };
      for (const e of un) { if (cur.length && e.firstNew - cur[cur.length - 1].firstNew > 2) flush(); cur.push(e); }
      flush(); }
    const edges = ex.explained.map(e => {
      const t = { lastOld: measured(e.lastOld), firstNew: measured(e.firstNew), explainedBy: e.explainedBy.map(b => decl(b.query, b.source === 'css' ? (b.file ?? 'stylesheet') : 'window.matchMedia() call', { kind: b.source })), near: e.near };
      if (!e.explainedBy.length && e.reflowOnly) t.explanation = inferred('reflow', 'only sibling wrap flags changed between these widths and no computed style did: content wrapping on its own, not a design breakpoint');
      else if (!e.explainedBy.length && runOf.has(e)) t.explanation = runOf.get(e);
      else if (!e.explainedBy.length && e.fluidInterval) { t.fluidInterval = true; t.explanation = ledger.add('unk_breakpoint_continuous', `the layout changes at many widths between ${e.lastOld}px and ${e.firstNew}px: a continuously varying property (viewport-unit sizing); the quick sweep did not search it pixel by pixel`, 'rerun the static layer without maxProbesPerInterval', `fluid ${e.lastOld}-${e.firstNew}`); }
      else if (!e.explainedBy.length) t.explanation = ledger.add('unk_breakpoint_unexplained', `layout changes between ${e.lastOld}px and ${e.firstNew}px but no declared media query or hooked matchMedia() call has an edge there`, 'a JS gate reading innerWidth, a container query, a viewport-unit effect or an adopted stylesheet; search the bundle for innerWidth/resize (P4 bundle-signature step)', `${e.lastOld}|${e.firstNew}`);
      return t;
    });
    const breakpoints = {
      method: decl('width sweep + layout signature + binary search', 'S6 §1.5 / PLAN M4'), range: { from: sw.widths[0], to: sw.widths[sw.widths.length - 1], step: sweep.step ?? 40, ...(sw.ignoreWrap ? { reflowEdgesSearched: false } : {}) },
      probes: sw.probes, fluidCells: sw.fluidCount, trackedCells: sw.trackedCells, edges,
      declaredQueries: queryList.map(q => ({ query: decl(q.query, q.source === 'css' ? (q.file ?? 'stylesheet') : 'window.matchMedia() call', { kind: q.source, alsoCalledFromJs: q.alsoJs }), widthEdges: q.edges, engineExpressions: q.engineExpressions })),
      declaredWithoutMeasuredEffect: ex.declaredWithoutMeasuredEffect,
      hookedMatchMedia: hooked,
    };
    ledger.add('unk_bp_fluid_masked', `${sw.fluidCount} element-property cells change continuously across the sweep (fluid type/size) and are excluded from the layout signature; a breakpoint that only changes one of those cannot be seen`, 'compare those cells at the edges with a second signature on rects', 'breakpoints');
    ledger.add('unk_bp_flicker', 'a state that appears and reverts inside one sweep step is invisible unless a declared edge is probed', 'lower sweep.step', 'breakpoints');
    for (const q of ex.declaredWithoutMeasuredEffect) ledger.add('unk_declared_edge_no_effect', `query ${q.query} has a width edge at ${q.edge.lastOld}|${q.edge.firstNew} but the layout signature did not change there`, 'the rule may style only masked (fluid) properties, match no element, or be overridden', `${q.query}|${q.edge.lastOld}`);

    // declared-but-not-measured conditions (media that are not width edges, supports, containers, print ...)
    const conditions = declaredQueries.map(q => {
      const e = qe[q.text] || { edges: [] };
      const widthDriven = e.edges.length > 0;
      return { query: decl(q.text, q.file ?? 'stylesheet', { kind: 'media' }), widthDriven, activeAtBase: q.activeNow, expressions: q.expressions };
    });
    const variantMedia = { dark: variants.some(v => v.colorScheme === 'dark'), reducedMotion: variants.some(v => v.reducedMotion === 'reduce'), touch: variants.some(v => v.touch) };
    for (const q of declaredQueries) {
      const t = q.text;
      if (/print/.test(t)) ledger.add('unk_print_media', `rules under "@media ${t}" are declared but print media is not emulated`, 'page.emulateMedia({media:"print"}) pass', t);
      if (/prefers-color-scheme/.test(t) && !variantMedia.dark) ledger.add('unk_color_scheme', `"${t}" declared but no dark variant was run`, 'add a colorScheme:dark variant', t);
      if (/prefers-reduced-motion/.test(t) && !variantMedia.reducedMotion) ledger.add('unk_reduced_motion', `"${t}" declared but no reduced-motion variant was run`, 'add a reducedMotion:reduce variant', t);
      if (/pointer|hover/.test(t) && !variantMedia.touch) ledger.add('unk_pointer_media', `"${t}" declared but no touch variant was run`, 'add a touch variant', t);
      if (/forced-colors|prefers-contrast|prefers-reduced-transparency|inverted-colors|color-gamut/.test(t)) ledger.add('unk_other_media_feature', `"${t}" declared; this media feature is not emulated`, 'Emulation.setEmulatedMedia features', t);
    }
    // measured content for variants that did run: record that print/dark/touch rules were exercised
    // cross-origin sheets: the CSSOM walk could not read them
    const sheets = baseInventory.sheets.map(s => ({ name: s.name, rules: s.rules, crossOrigin: s.crossOrigin }));
    for (const s of baseInventory.sheets) if (s.crossOrigin) ledger.add('unk_xorigin_cssom', `stylesheet ${s.name} is cross-origin: its custom properties, @container, @supports and @property rules are not enumerable through the CSSOM (media queries and winning declarations are read through CDP)`, 'CDP CSS.getStyleSheetText + a real CSS parser (not a regex)', s.name);
    for (const c of baseInventory.containers) ledger.add('unk_container_query', `@container ${c.text} (${c.sheet}) is declared; container-query edges depend on the container width, not the viewport`, 'measure the container, not the viewport', c.text);

    // ---- assets
    const allResponses = resources.length;
    { const seenUrl = new Set(); const uniq = resources.filter(r => (seenUrl.has(r.url) ? false : seenUrl.add(r.url))); resources.length = 0; resources.push(...uniq); } // every variant reloads the page: one entry per URL
    const used = fontsByVariant[variants[0].id] || [];
    const customUsed = used.filter(f => f.isCustomFont);
    const fontRes = resources.filter(r => r.type === 'font' || /^font\//.test(r.mime) || /\.(woff2?|ttf|otf)(\?|$)/i.test(r.url));
    const fontFaceMap = new Map(); for (const f of fontFaces) if (f.src) fontFaceMap.set(f.src, f.family);
    const declaredFaces = baseInventory.fonts;
    const assets = {
      fonts: {
        used: used.map(f => ({ familyName: measured(f.familyName), postScriptName: measured(f.postScriptName), isCustomFont: measured(f.isCustomFont), glyphCount: measured(f.glyphCount), examples: f.examples, from: 'CDP CSS.getPlatformFontsForNode' })),
        declaredFaces: declaredFaces.map(f => ({ family: decl(f.family, 'document.fonts (@font-face)'), weight: f.weight, style: f.style, status: measured(f.status, { from: 'FontFace.status' }), usedOnPage: customUsed.some(u => u.familyName === f.family) })),
        files: fontRes.map(r => ({ url: r.url, family: fontFaceMap.get(r.url) ?? ledger.add('unk_font_file_family', 'CSS.fontsUpdated did not name the family for this file', 'match @font-face src urls', r.url), bytes: r.bytes == null ? ledger.add('unk_font_bytes', 'response body size unavailable', 'read content-length', r.url) : measured(r.bytes, { from: r.bytesSource }) })),
        declaredNotUsed: declaredFaces.filter(f => !customUsed.some(u => u.familyName === f.family)).map(f => f.family),
      },
      svg: {
        inline: baseInventory.svgs.map(s => ({ ...s, provenance: 'measured' })),
        external: resources.filter(r => r.mime === 'image/svg+xml' || /\.svg(\?|$)/i.test(r.url)).map(r => ({ url: r.url, bytes: r.bytes == null ? ledger.add('unk_svg_bytes', 'response body size unavailable', 'read content-length', r.url) : measured(r.bytes, { from: r.bytesSource }), referencedBy: baseInventory.imgs.some(i => i.src === r.url) ? 'img' : baseInventory.bgUrls.some(b => r.url.endsWith(b) || b === r.url) ? 'css background' : 'fetched, reference not found' })),
      },
      images: baseInventory.imgs.map(i => ({ ...i, bytes: (() => { const r = resources.find(x => x.url === i.src); return r && r.bytes != null ? measured(r.bytes, { from: r.bytesSource }) : ledger.add('unk_img_bytes', 'no response recorded for this image', 'reload with the response listener on', i.src); })() })),
      backgroundUrls: baseInventory.bgUrls,
      stylesheets: sheets,
      svgoNotRun: ledger.add('unk_svgo', 'svgo rewrites ids, so it runs only after motion analysis (S6 §1.4); no optimisation statistics are reported', 'run svgo on a copy after the motion pass', 'assets'),
      fonttoolsNotRun: ledger.add('unk_fonttools', 'font file internals (axes, glyph coverage, licence strings) are not read; fonttools is an optional external step', 'uv run --with fonttools ttx -l <file>', 'assets'),
    };

    // ---- scripts saved for the bundle-signature step (P4 lives in src/libdetect; this layer only hands over the files)
    const inlineScripts = !saveScripts ? [] : await page.evaluate(() => [...document.scripts].filter(x => !x.src).map(x => x.textContent || ''));
    const seenScript = new Set(); const scriptFiles = scripts.filter(x => (seenScript.has(x.sha256) ? false : seenScript.add(x.sha256)));
    inlineScripts.filter(t => t.trim()).forEach((t, i) => { const r = saveScript(`inline script #${i + 1}`, Buffer.from(t)); if (!seenScript.has(r.sha256)) { seenScript.add(r.sha256); scriptFiles.push(r); } });

    // ---- custom properties and at-rule census (declared, from the CSSOM)
    const declaredLayer = {
      customProperties: baseInventory.customProps.map(c => ({ name: c.name, value: decl(c.value, `${c.sheet}${c.selector ? ' ' + c.selector : ''}`, { condition: c.condition }) })),
      atRules: decl(baseInventory.atRules, 'CSSOM walk of same-origin sheets'),
      mediaConditions: conditions, supports: baseInventory.supports, containers: baseInventory.containers, keyframes: baseInventory.keyframes,
    };

    // ---- reduced-motion / dark deltas
    const baseRec = out.variants[0];
    const deltas = out.variants.slice(1).map(v => ({ variant: v.id, documentHeight: v.document.value.scrollHeight, baseDocumentHeight: baseRec.document.value.scrollHeight, differsInHeight: v.document.value.scrollHeight !== baseRec.document.value.scrollHeight, a11yStructureSame: (out.a11y.find(a => a.variant === v.id)?.structureSha256) === (out.a11y.find(a => a.variant === baseRec.id)?.structureSha256) }));

    const record = {
      schema: STATIC_SCHEMA, id, createdAt: new Date().toISOString(), wallMs: Date.now() - t0,
      target: { url, local: isLocalUrl(url), allowLive },
      environment: {
        session: decl({ purpose: 'static', sharedWithMotionTake: false, browserLaunches: 1 }, 'recorder-config'),
        engine: decl(h.engine, 'recorder-config'), toolkit: decl(h.toolkit, 'recorder-config'), playwrightVersion: measured(h.playwrightVersion, { from: 'playwright-core package.json' }), executablePath: decl(h.executablePath, 'recorder-config'), flags: decl(h.args, 'recorder-config'),
        browserVersion: measured(browserInfo.product ?? null, { from: 'CDP Browser.getVersion' }), userAgent: measured(browserInfo.userAgent ?? null),
        injected: decl('one non-enumerable window.__reva_mm matchMedia query log; no style or attribute is written to the page', 'src/static/inpage.js'),
        blockedExternalRequests: blocked.length, ...(blocked.length ? { blockedExternalSample: blocked.slice(0, 5) } : {}),
      },
      variants: out.variants, a11y: out.a11y, variantDeltas: deltas,
      declared: declaredLayer, breakpoints, assets, scripts: { dir: 'scripts', files: scriptFiles, note: 'run `libdetect <outDir>/scripts` (P4 bundle signatures); motion-library detection is not part of this layer' },
      network: { resources: resources.length, responsesSeen: allResponses, note: 'sizes come from the responses of this session; nothing was fetched a second time' },
      hints: {}, unknowns: [], leftOut: [],
    };
    record.unknowns = ledger.list();
    return { record, outDir, ledger };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    await h.close();
  }
}

export function writeRecord(record, outDir) {
  const file = path.join(outDir, 'static.json');
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

/** Loads an elements series back (rows + styles) for a variant. */
export function loadElements(outDir, variantRec) {
  return JSON.parse(fs.readFileSync(path.join(outDir, variantRec.elements.file), 'utf8'));
}
