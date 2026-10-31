// The declared layer, read from the engine's own CSS model through the CDP CSS/DOM domains (not a regex over CSS text):
//   - which declaration WINS for a property on an element (cascade order, !important, inline style, inherited), with file:line
//   - media queries of every sheet, cross-origin sheets included (the CSSOM cannot read those)
//   - forced :hover / :focus states, platform fonts actually used by a node
// The pure helpers (pickDeclared, declaredPart, checkConsistency) take plain data and are unit-tested without a browser.
import { SHORTHANDS, SIDES, CORNERS } from './props.js';
import { parseColor } from './color.js';
import { parseShadowList, splitTopLevel } from './shadow.js';

// ---------- pure helpers ----------

/** Properties that inherit by default: a declaration on an ancestor can be the source of the value only for these. */
export const INHERITED_PROPS = new Set(['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'word-spacing', 'text-transform', 'color', 'text-align', 'text-shadow', 'visibility', 'fill', 'stroke']);

/** Top-level whitespace split (keeps var(--a, 1px) and rgb(0 0 0 / 50%) whole). */
export function splitWs(str) {
  const out = []; let depth = 0, cur = '';
  for (const ch of String(str).trim()) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const BOX = { top: 0, right: 1, bottom: 2, left: 3 };
function boxPart(vals, idx) {
  const n = vals.length; if (!n || n > 4) return null;
  const map = n === 1 ? [0, 0, 0, 0] : n === 2 ? [0, 1, 0, 1] : n === 3 ? [0, 1, 2, 1] : [0, 1, 2, 3];
  return vals[map[idx]];
}

/** Part of a (possibly shorthand) declaration that sets `prop`. Returns {text, exact:boolean}: exact=false when the part cannot be isolated. */
export function declaredPart(prop, name, value) {
  const v = value.replace(/\s*!important\s*$/i, '').trim();
  if (name === prop) return { text: v, exact: true };
  const sideM = /^(padding|margin|border)-(top|right|bottom|left)(?:-(color|width|style))?$/.exec(prop);
  if (sideM) {
    const [, fam, side, sub] = sideM;
    if (name === 'padding' && fam === 'padding' || name === 'margin' && fam === 'margin') { const p = boxPart(splitWs(v), BOX[side]); return p ? { text: p, exact: true } : { text: v, exact: false }; }
    if (fam === 'border' && sub && name === `border-${sub}`) { const p = boxPart(splitWs(v), BOX[side]); return p ? { text: p, exact: true } : { text: v, exact: false }; }
    if (fam === 'border' && sub && (name === 'border' || name === `border-${side}`)) {
      const toks = splitWs(v);
      const isW = t => /^-?[\d.]+(px|em|rem)?$/.test(t) || ['thin', 'medium', 'thick'].includes(t);
      const isS = t => ['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset'].includes(t);
      const t = sub === 'width' ? toks.find(isW) : sub === 'style' ? toks.find(isS) : toks.find(x => !isW(x) && !isS(x));
      return t ? { text: t, exact: true } : { text: v, exact: false };
    }
  }
  const cm = /^border-(top-left|top-right|bottom-right|bottom-left)-radius$/.exec(prop);
  if (cm && name === 'border-radius') {
    if (v.includes('/')) return { text: v, exact: false };
    const p = boxPart(splitWs(v), CORNERS.indexOf(cm[1])); return p ? { text: p, exact: true } : { text: v, exact: false };
  }
  if ((prop === 'row-gap' || prop === 'column-gap') && name === 'gap') {
    const t = splitWs(v); return { text: t.length === 1 ? t[0] : t[prop === 'row-gap' ? 0 : 1], exact: true };
  }
  return { text: v, exact: false }; // font / background / border-color on a single side ... : whole text, part not isolated
}

/**
 * Winning declaration of `prop` among the CDP matched-styles result.
 * Order rule: matchedCSSRules arrive in ascending cascade precedence (last wins); !important beats normal; the element's
 * inline style beats rules of the same importance; UA rules are ignored (they are not declared by the page).
 * @returns {null | {name,value,important,file,line,selector,via,sheetId}}
 */
export function pickDeclared(matched, prop, sheets = {}) {
  const names = new Set([prop, ...(SHORTHANDS[prop] || [])]);
  const cands = [];
  const take = (style, via, selector, sheetId, rank) => {
    for (const p of style?.cssProperties || []) {
      if (!p.range || p.disabled || p.implicit) continue; // as-written, enabled declarations only
      if (!names.has(p.name)) continue;
      const imp = !!p.important || /!important\s*$/i.test(p.value || '');
      cands.push({ name: p.name, value: p.value, important: imp, via, selector, sheetId, line: p.range.startLine + 1, rank });
    }
  };
  let rank = 0;
  const scan = (m, via) => {
    for (const r of m?.matchedCSSRules || []) {
      if (r.rule.origin === 'user-agent') continue;
      take(r.rule.style, via, r.rule.selectorList?.text, r.rule.style.styleSheetId, rank++);
    }
  };
  scan(matched, 'rule');
  if (matched?.inlineStyle) take(matched.inlineStyle, 'inline-style', 'style=""', matched.inlineStyle.styleSheetId, rank++);
  let pick = null;
  for (const imp of [true, false]) { const c = cands.filter(x => x.important === imp); if (c.length) { pick = c[c.length - 1]; break; } }
  if (!pick && matched?.inherited && INHERITED_PROPS.has(prop)) {
    for (const anc of matched.inherited) {
      const before = cands.length; scan(anc, 'inherited');
      if (cands.length > before) { const c = cands.slice(before); const imp = c.filter(x => x.important); pick = (imp.length ? imp : c).slice(-1)[0]; break; }
    }
  }
  if (!pick) return null;
  const sh = sheets[pick.sheetId];
  return { name: pick.name, value: pick.value.replace(/\s*!important\s*$/i, '').trim(), important: pick.important, file: sh?.file ?? (pick.via === 'inline-style' ? 'style attribute' : null), line: pick.line, selector: pick.selector, via: pick.via };
}

const KW_WEIGHT = { normal: 400, bold: 700 };
function lenPx(text, { fontSizePx, parentFontSizePx, rootFontPx, prop }) {
  const m = /^(-?[\d.]+)(px|rem|em)?$/.exec(text.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!m[2]) return n === 0 ? 0 : null;
  if (m[2] === 'px') return n;
  if (m[2] === 'rem') return rootFontPx ? n * rootFontPx : null;
  const base = prop === 'font-size' ? parentFontSizePx : fontSizePx; // em on font-size refers to the parent
  return base ? n * base : null;
}

/**
 * Does the declared text agree with the measured computed value? 'consistent' | 'inconsistent' | 'unchecked' (+reason).
 * Only 'inconsistent' drops the declared source; 'unchecked' keeps it with verified:false. var() is substituted from ctx.vars.
 */
export function checkConsistency(prop, declText, computed, ctx = {}) {
  let t = String(declText).trim();
  for (let i = 0; i < 4 && /var\(/.test(t); i++) {
    t = t.replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, (m0, n) => (ctx.vars && ctx.vars[n] != null ? ctx.vars[n].trim() : m0));
  }
  if (/var\(|calc\(|clamp\(|min\(|max\(|env\(|attr\(/.test(t)) return { result: 'unchecked', reason: 'needs engine evaluation (var/calc/clamp/min/max)' };
  if (ctx.via === 'inherited' && /(^|[\d.])em\b|%/.test(t)) return { result: 'unchecked', reason: 'relative unit inherited from an ancestor: it was resolved there, the computed value inherits as an absolute length' };
  if (/^(inherit|initial|unset|revert|revert-layer|currentcolor)$/i.test(t)) return { result: 'unchecked', reason: 'css-wide keyword or currentColor' };
  const cv = String(computed).trim();
  if (/color$|^fill$|^stroke$/.test(prop) || prop.endsWith('-color')) {
    const a = parseColor(t), b = parseColor(cv);
    if (!a || !b) return { result: 'unchecked', reason: 'colour space not converted' };
    const ok = ['r', 'g', 'b'].every(k => Math.abs(a[k] - b[k]) <= 1) && Math.abs(a.a - b.a) <= 0.01;
    return { result: ok ? 'consistent' : 'inconsistent' };
  }
  if (prop === 'box-shadow' || prop === 'text-shadow') {
    const a = parseShadowList(t, { text: prop === 'text-shadow' }), b = parseShadowList(cv, { text: prop === 'text-shadow' });
    if (!a || !b) return { result: a === b ? 'consistent' : 'inconsistent' };
    if (a.length !== b.length) return { result: 'inconsistent' };
    const ok = a.every((l, i) => ['x', 'y', 'blur'].every(k => Math.abs(l[k] - b[i][k]) < 0.02) && l.inset === b[i].inset
      && (l.spread == null || Math.abs((l.spread ?? 0) - (b[i].spread ?? 0)) < 0.02)
      && (() => { const ca = parseColor(l.color || ''), cb = parseColor(b[i].color || ''); return ca && cb ? ['r', 'g', 'b'].every(k => Math.abs(ca[k] - cb[k]) <= 1) && Math.abs(ca.a - cb.a) <= 0.01 : false; })());
    return { result: ok ? 'consistent' : 'inconsistent' };
  }
  if (prop === 'font-family') {
    const first = s => splitTopLevel(s)[0]?.replace(/^["']|["']$/g, '').trim().toLowerCase();
    return { result: first(t) === first(cv) ? 'consistent' : 'inconsistent' };
  }
  if (prop === 'font-weight') {
    const w = KW_WEIGHT[t.toLowerCase()] ?? parseFloat(t);
    if (Number.isNaN(w)) return { result: 'unchecked', reason: 'relative/unknown weight keyword' };
    return { result: Math.abs(w - parseFloat(cv)) < 0.5 ? 'consistent' : 'inconsistent' };
  }
  if (prop === 'line-height') {
    if (/^[\d.]+$/.test(t)) { if (!ctx.fontSizePx || cv === 'normal') return { result: 'unchecked', reason: 'unitless line-height needs font-size / computed is normal' }; return { result: Math.abs(parseFloat(t) * ctx.fontSizePx - parseFloat(cv)) < 0.05 ? 'consistent' : 'inconsistent' }; }
    if (t === 'normal') return { result: cv === 'normal' ? 'consistent' : 'inconsistent' };
  }
  if (/^-?[\d.]+(px|rem|em)?$/.test(t)) {
    const px = lenPx(t, { ...ctx, prop });
    if (px == null) return { result: 'unchecked', reason: 'unit needs font-size context' };
    const c = parseFloat(cv);
    if (Number.isNaN(c)) return { result: 'unchecked', reason: 'computed value is not a length' };
    return { result: Math.abs(px - c) < 0.05 ? 'consistent' : 'inconsistent' };
  }
  if (/^[a-z-]+$/i.test(t)) return { result: t.toLowerCase() === cv.toLowerCase() ? 'consistent' : (cv === 'normal' || t === 'normal' ? 'inconsistent' : 'unchecked'), ...(t.toLowerCase() === cv.toLowerCase() ? {} : { reason: 'keyword differs from computed' }) };
  return { result: 'unchecked', reason: 'value form not covered by the checker' };
}

// ---------- CDP session ----------

/** Opens DOM + CSS on a CDP session. Sheet headers (url/inline/length) are collected from styleSheetAdded events. */
export async function openCss(context, page) {
  const cdp = await context.newCDPSession(page);
  const sheets = {};
  cdp.on('CSS.styleSheetAdded', e => { const h = e.header; sheets[h.styleSheetId] = { file: h.isInline ? `${h.sourceURL || 'inline'} (inline <style>)` : h.sourceURL, origin: h.origin, inline: !!h.isInline, length: h.length, sourceURL: h.sourceURL || null, ownerNode: h.ownerNode ?? null, constructed: !!h.isConstructed }; });
  cdp.on('CSS.styleSheetRemoved', e => { if (sheets[e.styleSheetId]) sheets[e.styleSheetId].removed = true; });
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  return { cdp, sheets, async close() { try { await cdp.send('CSS.disable'); } catch {} try { await cdp.detach(); } catch {} } };
}

/** Engine-listed media queries of every sheet (cross-origin included). Width values come with the engine's own parsing. */
export async function listMediaQueries(css) {
  const { medias } = await css.cdp.send('CSS.getMediaQueries');
  const seen = new Set(); const out = [];
  for (const m of medias) {
    const file = m.sourceURL || css.sheets[m.styleSheetId]?.file || null;
    const k = m.text + '|' + file;
    if (seen.has(k)) continue; seen.add(k);
    out.push({ text: m.text, source: m.source, file, expressions: (m.mediaList || []).flatMap(l => l.expressions || []).map(e => ({ feature: e.feature, value: e.value, unit: e.unit, computedLength: e.computedLength ?? null })), activeNow: (m.mediaList || []).some(l => l.active) || null });
  }
  // CDP lists the rules in an unstable order between loads: sort so records are reproducible
  return out.sort((a, b) => a.text.localeCompare(b.text) || String(a.file).localeCompare(String(b.file)));
}

/** Resolves the page's recorded element array (inpage.extractElements) to DOM nodeIds for the wanted row ids. */
export async function nodeIdsForRows(css, rowIds) {
  const { cdp } = css;
  // DOM.getDocument invalidates earlier nodeIds: ask once per page load (css.docFetched is reset by the driver after goto)
  if (!css.docFetched) { await cdp.send('DOM.getDocument', { depth: 0 }); css.docFetched = true; }
  const arr = await cdp.send('Runtime.evaluate', { expression: 'window[Symbol.for("reva.static.els")]' });
  if (!arr.result?.objectId) return new Map();
  const props = await cdp.send('Runtime.getProperties', { objectId: arr.result.objectId, ownProperties: true });
  const byName = new Map(props.result.map(p => [p.name, p.value]));
  const out = new Map();
  for (const id of rowIds) {
    const v = byName.get(String(id)); if (!v?.objectId) continue;
    try { const { nodeId } = await cdp.send('DOM.requestNode', { objectId: v.objectId }); if (nodeId) out.set(id, nodeId); } catch {}
  }
  return out;
}

export async function matchedStyles(css, nodeId) {
  try { return await css.cdp.send('CSS.getMatchedStylesForNode', { nodeId }); } catch { return null; }
}
/** Pseudo-element view of a matched-styles result, shaped like an element result so pickDeclared works on it. */
export function pseudoView(matched, pseudo) {
  const type = pseudo.replace(/^::/, '');
  const pe = (matched?.pseudoElements || []).find(p => p.pseudoType === type);
  return pe ? { matchedCSSRules: pe.matches, inherited: matched.inherited } : null;
}

export async function platformFonts(css, nodeId) {
  try { return (await css.cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts; } catch { return null; }
}

/** Computed style of a node under forced pseudo classes, as a name->value map. */
export async function forcedComputed(css, page, nodeId, classes) {
  const { cdp } = css;
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes });
  try {
    // let a started transition reach its end value before reading (otherwise the first frame of the transition is read)
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch {} } requestAnimationFrame(r); })));
    const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
    return Object.fromEntries(computedStyle.map(x => [x.name, x.value]));
  } finally { await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {}); }
}

// ---------- rule table support (stage D1: src/static/ruletable.js) ----------

/** Start CDP rule-usage tracking. Call right after openCss and BEFORE navigation, so usage covers the whole load. */
export async function startRuleUsage(css) { await css.cdp.send('CSS.startRuleUsageTracking'); }
/** Stop tracking: every style rule of every live sheet, {styleSheetId, startOffset, endOffset, used}. */
export async function stopRuleUsage(css) { return (await css.cdp.send('CSS.stopRuleUsageTracking')).ruleUsage; }
/** The text of one sheet as the engine holds it (cross-origin sheets included). */
/** null (not a throw) when the sheet was removed since it was listed: script-managed <style> elements come and go (corpus F9). */
export async function sheetText(css, styleSheetId) {
  try { return (await css.cdp.send('CSS.getStyleSheetText', { styleSheetId })).text; }
  catch (e) { if (isGoneError(e)) return null; throw e; }
}
/** CDP says the sheet or node it was asked about no longer exists (removed or replaced between listing and use). */
export const isGoneError = e => /No style sheet with given id|Could not find node with given id|No node with given id|Node with given id does not belong|Cannot find context|Target closed/i.test(String(e && e.message));

/** CDP styleSheetId -> rule-table sheet id. inPageRuleTable tags every CSSStyleSheet it walks with __wrSid; a sheet's
 *  owner node (<link>/<style>) is resolved through CDP and asked for its sheet's tag. Constructed (adopted) sheets have
 *  no owner node and stay unmapped (their rules report used=undefined, listed as unknown, never as unused). */
export async function sheetIdsByOwner(css) {
  const map = new Map(), taken = new Set();
  for (const [id, h] of Object.entries(css.sheets)) {
    if (h.removed || h.origin !== 'regular' || h.ownerNode == null) continue;
    try {
      const { object } = await css.cdp.send('DOM.resolveNode', { backendNodeId: h.ownerNode });
      const { result } = await css.cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){ const s = this.sheet; return s && s.__wrSid != null ? s.__wrSid : null; }', returnByValue: true });
      await css.cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
      // an @import'ed sheet reports the importing element as owner: the owner's own sheet wins, imports stay unmapped
      if (result.value != null && !taken.has(result.value) && !h.sourceURL?.includes('@import')) { map.set(id, result.value); taken.add(result.value); }
    } catch { /* node gone */ }
  }
  return map;
}
