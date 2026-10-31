// Functions executed INSIDE the page (serialised by Playwright's evaluate: each must be self-contained).
// They only read: no style is injected and no attribute is written. (The one write is the optional `matchMedia` hook
// installed by `mediaHookInit`, documented in extract.js.)

/** Settles the page before reading: fonts, finite CSS transitions/animations, two frames. Returns what it did. */
export async function settlePage() {
  const out = { fontsReady: false, finished: 0, cancelledInfinite: 0, errors: 0 };
  try { await document.fonts.ready; out.fontsReady = true; } catch { out.errors++; }
  // A transition read mid-flight would report an interpolated value as if it were the style: jump it to its end state.
  for (const a of document.getAnimations()) {
    try {
      const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      if (t && t.endTime === Infinity) { a.cancel(); out.cancelledInfinite++; } else { a.finish(); out.finished++; }
    } catch { out.errors++; }
  }
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return out;
}

/** A cheap signature of the text sizes on the page (the 24 largest distinct font sizes of text-bearing elements, their
 * counts, and the document height): read repeatedly to tell when script-sized text has settled. */
export function textSignature() {
  const m = new Map(); let n = 0;
  for (const el of document.body ? document.body.getElementsByTagName('*') : []) {
    if (++n > 6000) break;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue; // their source is not words on the page
    if (![...el.childNodes].some(c => c.nodeType === 3 && c.nodeValue.trim())) continue;
    const f = getComputedStyle(el).fontSize; m.set(f, (m.get(f) || 0) + 1);
  }
  return [...m].sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).slice(0, 24).map(([f, c]) => `${f}x${c}`).join(' ') + ` h${document.documentElement.scrollHeight}`;
}

/** One pass over the document (open shadow roots included): computed style rows + page facts. */
export function extractElements({ props, maxElements }) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'BASE']);
  const styles = []; const styleKey = new Map(); const rows = [];
  const intern = cs => {
    const vals = props.map(p => cs.getPropertyValue(p));
    const k = vals.join('\u0001');
    let i = styleKey.get(k);
    if (i === undefined) { i = styles.length; styles.push(vals); styleKey.set(k, i); }
    return i;
  };
  const esc = s => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const selOf = el => {
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 5; depth++) {
      if (cur.id) { parts.unshift('#' + esc(cur.id)); break; }
      const tag = cur.tagName.toLowerCase();
      const cls = (cur === document.body || cur === document.documentElement) ? '' : (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(c => '.' + esc(c)).join('');
      let nth = '';
      const p = cur.parentElement;
      if (p) { const same = [...p.children].filter(c => c.tagName === cur.tagName); if (same.length > 1) nth = `:nth-of-type(${same.indexOf(cur) + 1})`; }
      parts.unshift(tag + cls + nth);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const sx = window.scrollX, sy = window.scrollY;
  let truncated = false, nextId = 0;
  const shadowHosts = [], iframes = [], canvases = [];
  const els = []; // row id -> element (pseudo rows -> their parent element); read back by the CDP layer to resolve nodes
  const visit = (el, parentId, depth, shadowPrefix) => {
    if (SKIP.has(el.tagName)) return;
    if (rows.length >= maxElements) { truncated = true; return; }
    const id = nextId++;
    const cs = getComputedStyle(el);
    const rects = el.getClientRects();
    const rendered = cs.display !== 'none' && rects.length > 0;
    let rect = null;
    if (rendered) { const r = el.getBoundingClientRect(); rect = [r.left + sx, r.top + sy, r.width, r.height].map(v => Math.round(v * 100) / 100); }
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim().length > 0);
    const row = { id, parent: parentId, tag: el.tagName.toLowerCase(), sel: (shadowPrefix ? shadowPrefix + ' >>> ' : '') + selOf(el), depth, rendered, rect, text: ownText, s: intern(cs) };
    if (el.id) row.elId = el.id;
    if (el.matches('a[href],button,input,select,textarea,summary,[tabindex],[role=button],[role=link]')) row.interactive = true;
    if (rendered && ownText && cs.lineHeight === 'normal' && el.children.length === 0) {
      // line-height:normal resolves from font metrics; the used value is the content height of a text-only block / its line count
      const rg = document.createRange(); rg.selectNodeContents(el);
      const tops = new Set([...rg.getClientRects()].map(r => Math.round(r.top)));
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      // a box shorter than ~0.8 of its font size is clipped or collapsed: no used value from it
      const fs = parseFloat(cs.fontSize) || 0;
      if (tops.size && el.clientHeight - pad >= 0.8 * fs * tops.size) row.lhUsed = Math.round(((el.clientHeight - pad) / tops.size) * 100) / 100;
    }
    if (shadowPrefix) row.shadow = true;
    rows.push(row); els[id] = el;
    if (el.tagName === 'IFRAME') iframes.push({ id, sel: row.sel, src: el.getAttribute('src') });
    if (el.tagName === 'CANVAS') canvases.push({ id, sel: row.sel, width: el.width, height: el.height });
    for (const pseudo of ['::before', '::after']) {
      const pcs = getComputedStyle(el, pseudo);
      const c = pcs.getPropertyValue('content');
      if (c && c !== 'none' && c !== 'normal') { els[nextId] = el; rows.push({ id: nextId++, parent: id, tag: pseudo, sel: row.sel + pseudo, depth: depth + 1, rendered, rect: null, text: true, pseudo, content: c, s: intern(pcs), ...(shadowPrefix ? { shadow: true } : {}) }); }
    }
    if (el.shadowRoot) {
      shadowHosts.push({ id, sel: row.sel });
      for (const ch of el.shadowRoot.children) visit(ch, id, depth + 1, row.sel);
    }
    for (const ch of el.children) visit(ch, id, depth + 1, shadowPrefix);
  };
  visit(document.documentElement, -1, 0, '');
  try { Object.defineProperty(window, Symbol.for('reva.static.els'), { value: els, enumerable: false, configurable: true }); } catch {}
  const de = document.documentElement;
  const vp = document.querySelector('meta[name=viewport]');
  return {
    styles, rows, truncated, shadowHosts, iframes, canvases,
    page: {
      title: document.title, lang: de.getAttribute('lang'), url: location.href,
      scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight, innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio,
      rootFontSize: getComputedStyle(de).fontSize, metaViewport: vp ? vp.getAttribute('content') : null,
      pointerCoarse: matchMedia('(pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches,
      colorSchemeDark: matchMedia('(prefers-color-scheme: dark)').matches, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    },
  };
}

/** Assets and CSSOM facts that need page context: svg/img/canvas/iframes, document.fonts, stylesheets, custom properties, at-rule census. */
export function inventory() {
  const esc = s => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const selOf = el => {
    if (el.id) return '#' + esc(el.id);
    const tag = el.tagName.toLowerCase();
    const p = el.parentElement; if (!p) return tag;
    const same = [...p.children].filter(c => c.tagName === el.tagName);
    return (p.id ? '#' + esc(p.id) + ' > ' : '') + tag + (same.length > 1 ? `:nth-of-type(${same.indexOf(el) + 1})` : '');
  };
  const svgs = [...document.querySelectorAll('svg')].filter(s => !s.parentElement || !s.parentElement.closest('svg')).map(s => {
    const r = s.getBoundingClientRect();
    return {
      sel: selOf(s), viewBox: s.getAttribute('viewBox'), width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100,
      shapes: s.querySelectorAll('path,circle,rect,ellipse,line,polyline,polygon').length, uses: [...s.querySelectorAll('use')].map(u => u.getAttribute('href') || u.getAttribute('xlink:href')),
      label: s.getAttribute('aria-label'), markupBytes: new TextEncoder().encode(s.outerHTML).length,
    };
  });
  const imgs = [...document.images].map(i => ({ sel: selOf(i), src: i.currentSrc || i.src, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight, alt: i.getAttribute('alt'), loading: i.getAttribute('loading') }));
  const bgUrls = new Set();
  for (const el of document.querySelectorAll('*')) {
    const v = getComputedStyle(el).backgroundImage;
    if (v && v !== 'none') for (const m of v.matchAll(/url\(["']?([^"')]+)["']?\)/g)) bgUrls.add(m[1]);
  }
  const fonts = [...document.fonts].map(f => ({ family: f.family.replace(/^["']|["']$/g, ''), weight: f.weight, style: f.style, stretch: f.stretch, unicodeRange: f.unicodeRange, status: f.status }));
  const sheets = []; const customProps = []; const atRules = { media: 0, supports: 0, container: 0, layer: 0, fontFace: 0, keyframes: 0, property: 0, import: 0 };
  const keyframes = []; const containers = []; const supports = [];
  const walk = (rules, sheetName, cond) => {
    for (const r of rules) {
      const t = r.constructor.name;
      if (t === 'CSSStyleRule') {
        for (let i = 0; i < r.style.length; i++) { const n = r.style[i]; if (n.startsWith('--')) customProps.push({ name: n, value: r.style.getPropertyValue(n).trim(), selector: r.selectorText, sheet: sheetName, condition: cond || null }); }
        if (r.cssRules && r.cssRules.length) walk(r.cssRules, sheetName, cond);
      } else if (t === 'CSSMediaRule') { atRules.media++; walk(r.cssRules, sheetName, (cond ? cond + ' ' : '') + '@media ' + r.conditionText); }
      else if (t === 'CSSSupportsRule') { atRules.supports++; supports.push({ text: r.conditionText, sheet: sheetName, matches: CSS.supports(r.conditionText) }); walk(r.cssRules, sheetName, (cond ? cond + ' ' : '') + '@supports ' + r.conditionText); }
      else if (t === 'CSSContainerRule') { atRules.container++; containers.push({ text: r.conditionText, name: r.containerName, sheet: sheetName }); walk(r.cssRules, sheetName, (cond ? cond + ' ' : '') + '@container ' + r.conditionText); }
      else if (t === 'CSSLayerBlockRule') { atRules.layer++; walk(r.cssRules, sheetName, (cond ? cond + ' ' : '') + '@layer ' + r.name); }
      else if (t === 'CSSFontFaceRule') atRules.fontFace++;
      else if (t === 'CSSKeyframesRule') { atRules.keyframes++; keyframes.push({ name: r.name, sheet: sheetName }); }
      else if (t === 'CSSPropertyRule') { atRules.property++; customProps.push({ name: r.name, value: r.initialValue, selector: '@property', syntax: r.syntax, sheet: sheetName, condition: cond || null }); }
      else if (t === 'CSSImportRule') atRules.import++;
    }
  };
  for (const sh of document.styleSheets) {
    const name = sh.href || (sh.ownerNode ? 'inline:' + (sh.ownerNode.tagName || '').toLowerCase() : 'constructed');
    try { const n = sh.cssRules.length; sheets.push({ name, rules: n, crossOrigin: false }); walk(sh.cssRules, name, ''); }
    catch { sheets.push({ name, rules: null, crossOrigin: true }); }
  }
  return { svgs, imgs, bgUrls: [...bgUrls], fonts, sheets, customProps, atRules, keyframes, containers, supports };
}

/** Layout signature rows for the breakpoint sweep: one array of strings per element, keyed by a stable expando id. */
export function layoutRows({ sigProps, maxElements }) {
  const KEY = Symbol.for('reva.static.id');
  const SEQ = Symbol.for('reva.static.seq'); const w = window; if (w[SEQ] === undefined) Object.defineProperty(w, SEQ, { value: { n: 0 }, enumerable: false });
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'BASE']);
  const out = []; let prevTop = new Map();
  const visit = el => {
    if (SKIP.has(el.tagName) || out.length >= maxElements) return;
    if (el[KEY] === undefined) Object.defineProperty(el, KEY, { value: ++w[SEQ].n, enumerable: false });
    const cs = getComputedStyle(el);
    const rendered = cs.display !== 'none' && el.getClientRects().length > 0;
    const vals = sigProps.map(p => cs.getPropertyValue(p));
    const gt = cs.getPropertyValue('grid-template-columns');
    vals.push(gt && gt !== 'none' ? 'cols:' + gt.split(/\s+/).length : 'cols:0');
    vals.push(rendered ? 'r1' : 'r0');
    // wrap flag: does this element start a new row relative to its previous rendered sibling?
    let wrap = '';
    if (rendered) {
      const p = el.parentElement; const top = el.getBoundingClientRect().top;
      const prev = p ? prevTop.get(p) : undefined;
      if (prev !== undefined) wrap = top > prev + 1 ? 'nl' : 'sl';
      if (p) prevTop.set(p, top);
    }
    vals.push(wrap);
    out.push([el[KEY], ...vals]);
    if (el.shadowRoot) for (const c of el.shadowRoot.children) visit(c);
    for (const c of el.children) visit(c);
  };
  visit(document.documentElement);
  return out;
}

/** Engine-evaluated media queries: for each query, the matches-flags over integer widths via a hidden iframe viewport. */
export function mediaEdgesInPage({ queries, from, to }) {
  const fr = document.createElement('iframe');
  fr.setAttribute('aria-hidden', 'true'); fr.tabIndex = -1;
  fr.style.cssText = 'position:fixed;left:-99999px;top:0;height:200px;border:0;visibility:hidden;pointer-events:none;';
  fr.style.width = from + 'px';
  document.documentElement.appendChild(fr);
  try {
    const win = fr.contentWindow;
    const out = {};
    const mqls = queries.map(q => { try { return win.matchMedia(q); } catch { return null; } });
    queries.forEach((q, qi) => { out[q] = { edges: [], at: null, error: mqls[qi] ? null : 'matchMedia rejected the query' }; });
    let prev = new Array(queries.length).fill(undefined);
    for (let w = from; w <= to; w++) {
      fr.style.width = w + 'px';
      void fr.offsetWidth;
      mqls.forEach((m, qi) => {
        if (!m) return;
        const v = m.matches;
        if (prev[qi] === undefined) out[queries[qi]].at = v;
        else if (prev[qi] !== v) out[queries[qi]].edges.push({ lastOld: w - 1, firstNew: w, toMatching: v });
        prev[qi] = v;
      });
    }
    return out;
  } finally { fr.remove(); }
}

/** Init script (runs before the page's own scripts): records every matchMedia() query string the page evaluates. */
export function mediaHookInit() {
  try {
    const log = [];
    Object.defineProperty(window, '__reva_mm', { value: log, enumerable: false });
    const orig = window.matchMedia.bind(window);
    window.matchMedia = function (q) { try { const s = String(q); if (!log.includes(s)) log.push(s); } catch {} return orig(q); };
  } catch {}
}
