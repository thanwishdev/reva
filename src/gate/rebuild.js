// Rebuild renderer for the rule-table capture (stage D1). Verification only (D-GOAL-1): it proves the capture is
// complete by re-rendering the page from OUR JSON alone — no original stylesheet, <style> text, style attribute or
// script is copied; every rule and inline style is re-serialised from the table's structured fields in our own
// compact form, and the gate's source audit plus a provenance check (artifact === render(table)) confirm it.
// Also: table-level mutants for the mutation test (corrupt a captured value, re-render).
// 26 Oct (L7): content the HTML parser would re-nest is delivered in `nest` and put in by the harness (parserMoves).
import { parseColor } from '../static/color.js';
import { decodeComputed } from '../static/ruletable.js';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const NL_START = new Set(['pre', 'textarea', 'listing']);
const escT = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escA = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');

export const declText = d => (d || []).map(([p, v, imp]) => `${p}:${v}${imp ? '!important' : ''}`).join(';');

function ruleCss(T, id) {
  const r = T.rules[id];
  const kids = () => (r.c || []).map(c => ruleCss(T, c)).join('');
  switch (r.t) {
    case 'style': { const d = declText(r.d); const k = kids(); return `${r.sel}{${d}${d && k ? ';' : ''}${k}}`; }
    case 'decls': return declText(r.d) + ';';
    case 'media': case 'supports': case 'container': case 'layer': case 'scope': case 'starting-style': case 'document': return `${r.head}{${kids()}}`;
    case 'import': {
      let s = kids();
      if (r.media && r.media !== 'all') s = `@media ${r.media}{${s}}`;
      if (r.supports) s = `@supports ${r.supports}{${s}}`;
      if (r.layer != null) s = `@layer${r.layer ? ' ' + r.layer : ''}{${s}}`;
      return s;
    }
    case 'font-face': return `@font-face{${declText(r.d)}}`;
    case 'keyframes': return `${r.head}{${r.frames.map(f => `${f.key}{${declText(f.d)}}`).join('')}}`;
    case 'property': return `@property ${r.name}{syntax:${JSON.stringify(r.syntax)};inherits:${r.inherits}${r.initial != null ? `;initial-value:${r.initial}` : ''}}`;
    case 'layer-statement': return `@layer ${r.names.join(',')};`;
    case 'namespace': return `@namespace ${r.prefix ? r.prefix + ' ' : ''}${JSON.stringify(r.uri)};`;
    case 'other': return r.d ? `${r.head}{${declText(r.d)}}` : `${r.head}{${r.raw}}`;
    default: return '';
  }
}

const sheetsCss = (T, sids) => sids.map(sid => T.sheets[sid].rules.map(id => ruleCss(T, id)).join('')).join('\n').replace(/<\/(style)/gi, '<\\/$1');

// ---------- HTML parser re-nesting (26 Oct, L7 / S16) ----------
// The rebuild is served as HTML text, so the HTML parser builds its DOM, and the parser's tree-construction rules move
// elements that page script may legally nest: a block (<div>, <ul>, <p> ...) inside a <p> closes the <p> (the block
// becomes the p's sibling and the </p> an extra empty <p>), an <a> inside an <a> closes the outer one, an <li> inside an
// <li>, a <button> inside a <button>, a heading directly in a heading, an element directly in <html> is moved into
// <body>. The rebuild DOM was then not the table's DOM. Measured on the 22-23 Oct deep runs: 52 of 322 capture gates
// (SplitText-style `<p><div>` lines; 4,957 start tags in their rendered markup), a root cause at 82 failing captured
// points, the only one at 55.
// Fix: such content is not left to the document parser. The closing element is emitted EMPTY with a marker, and its
// content is listed in `nest`; the gate harness (run.js applyNest) puts it in with the fragment parser, whose context
// element is not on the parser's stack, so nothing closes it (setHTMLUnsafe: declarative shadow roots too). An element
// directly in <html> is inserted there. The marker is removed before anything is read; the DOM equals the table's.
const CLOSE_P = new Set(['address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'listing', 'search', 'section', 'summary', 'table', 'ul', 'li', 'dd', 'dt', 'xmp', 'plaintext']);
const BUTTON_SCOPE = new Set(['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template', 'button']);
const A_SCOPE = new Set(['applet', 'object', 'marquee', 'template', 'td', 'th', 'caption']);
const HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const SPECIAL = new Set(['address', 'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound', 'blockquote', 'body', 'br', 'button', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dir', 'div', 'dl', 'dt', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'iframe', 'img', 'input', 'keygen', 'li', 'link', 'listing', 'main', 'marquee', 'menu', 'meta', 'nav', 'noembed', 'noframes', 'noscript', 'object', 'ol', 'p', 'param', 'plaintext', 'pre', 'script', 'search', 'section', 'select', 'source', 'style', 'summary', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul', 'wbr', 'xmp']);
const TABLE_KIDS = { table: ['caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'input'], tbody: ['tr'], thead: ['tr'], tfoot: ['tr'], tr: ['td', 'th'] };
const RAW = new Set(['iframe', 'textarea', 'title', 'xmp', 'noembed', 'noframes', 'style', 'script']);

/**
 * Where the HTML document parser would NOT rebuild the table's tree from the rendered markup (pure, table in).
 * Each move: {k: the element the parser moves, closes: key of the element the parser closes (or 'html'), ci: its table
 * element index, why, repair: 'inner' | 'html-child' | null}. repair null = reported only (no harness repair: nested
 * <form>, table structure, foreign-content and raw-text cases; none seen in the 22-23 Oct deep runs).
 * @param {object} T rule table
 * @returns {{k:string, closes:string, ci:number|null, parent:string, why:string, repair:string|null}[]}
 */
export function parserMoves(T) {
  const out = [];
  const key = n => T.els[n.i]?.k;
  const parentKey = k => (k === 'html' ? 'html' : k.slice(0, Math.max(k.lastIndexOf('/'), k.lastIndexOf('#'))));
  const push = (c, closer, why, repair) => { const ck = key(closer); out.push({ k: key(c), closes: ck, ci: closer.i ?? null, parent: parentKey(ck), why, repair }); };
  const walk = (n, anc, quirks) => {
    for (const c of n.c || []) {
      if (typeof c === 'string') {
        if (!n.ns && TABLE_KIDS[n.t] && c.trim()) push(n, n, `text in <${n.t}> (foster-parented)`, null);
        continue;
      }
      const t = c.t, html = !c.ns, pns = n.ns || null;
      let hit = null;
      if (html && pns && /svg$/.test(pns) && !['foreignObject', 'desc', 'title'].includes(n.t)) hit = [n, `html <${t}> inside svg <${n.t}>`, null];
      else if (html && pns && /MathML$/.test(pns)) hit = [n, `html <${t}> inside math`, null];
      else if (c.ns && /svg$/.test(c.ns) && t !== 'svg' && !pns) hit = [n, `svg <${t}> under html <${n.t}>`, null];
      else if (html && !pns) {
        if (n.t === 'html' && t !== 'head' && t !== 'body') hit = [n, `<${t}> directly in <html>`, 'html-child'];
        if (!hit && CLOSE_P.has(t) && !(t === 'table' && quirks)) for (const a of anc) { if (a.ns) break; if (a.t === 'p') { hit = [a, `<${t}> inside <p>`, 'inner']; break; } if (BUTTON_SCOPE.has(a.t)) break; }
        if (!hit && t === 'a') for (const a of anc) { if (a.ns || A_SCOPE.has(a.t)) break; if (a.t === 'a') { hit = [a, '<a> inside <a>', 'inner']; break; } }
        if (!hit && t === 'form') { const f = anc.find(a => a.t === 'form' && !a.ns); if (f) hit = [f, '<form> inside <form>', null]; }
        if (!hit && t === 'button') { const f = anc.find(a => a.t === 'button' && !a.ns); if (f) hit = [f, '<button> inside <button>', 'inner']; }
        if (!hit && (t === 'li' || t === 'dd' || t === 'dt')) { const same = t === 'li' ? ['li'] : ['dd', 'dt']; for (const a of anc) { if (a.ns) break; if (same.includes(a.t)) { hit = [a, `<${t}> inside <${a.t}>`, 'inner']; break; } if (SPECIAL.has(a.t) && !['address', 'div', 'p'].includes(a.t)) break; } }
        if (!hit && HEADING.has(t) && HEADING.has(n.t)) hit = [n, `<${t}> directly in <${n.t}>`, 'inner'];
        if (!hit && t === 'option' && n.t === 'option') hit = [n, '<option> inside <option>', 'inner'];
        if (!hit && TABLE_KIDS[n.t] && !TABLE_KIDS[n.t].includes(t)) hit = [n, `<${t}> directly in <${n.t}>`, null];
        if (!hit && ['tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'caption', 'colgroup', 'col'].includes(t) && !TABLE_KIDS[n.t] && n.t !== 'colgroup') hit = [n, `<${t}> outside a table`, null];
        if (!hit && RAW.has(n.t)) hit = [n, `element inside raw-text <${n.t}>`, null];
      }
      if (hit) push(c, hit[0], hit[1], hit[2]);
      walk(c, [c, ...anc], quirks);
      // shadow content is parsed inside <template shadowrootmode>: the template bounds every scope (nothing above it closes)
      if (c.sr) walk({ c: c.sr.c, t: '#shadow' }, [{ t: 'template' }, c, ...anc], quirks);
    }
  };
  for (const d of T.docs) walk({ c: [d.tree], t: '#document' }, [], !!d.quirks);
  return out;
}

function renderNode(T, n, frames, head, cx) {
  if (typeof n === 'string') return escT(n);
  let attrs = '';
  for (const [k, v] of n.a || []) attrs += ` ${k}="${escA(v)}"`;
  if (n.s && n.s.length) attrs += ` style="${escA(declText(n.s))}"`;
  if (VOID.has(n.t) && !n.ns) return `<${n.t}${attrs}>`;
  // a closing element the parser would cut short: emitted empty with a marker, its content goes to `nest` (see above).
  // The entry is reserved before its content renders, so nested entries follow it (applied outer first).
  const entry = cx?.inner.has(n.i) ? { how: 'inner', id: String(cx.next++), html: '' } : null;
  if (entry) { cx.list.push(entry); attrs += ` data-wr-nest="${entry.id}"`; }
  let inner = head || '';
  if (n.sr) inner += `<template shadowrootmode="${n.sr.mode === 'closed' ? 'closed' : 'open'}"${n.sr.delegatesFocus ? ' shadowrootdelegatesfocus' : ''}>${n.sr.sheets.length ? `<style data-wr-gen>${sheetsCss(T, n.sr.sheets)}</style>` : ''}${n.sr.c.map(c => renderNode(T, c, frames, null, cx)).join('')}</template>`;
  if (n.fr != null) frames[T.docs[n.fr].url] = renderDoc(T, n.fr, frames, cx?.all);
  else {
    let el = 0;
    const body = (n.c || []).map(c => {
      if (typeof c === 'string' || !cx?.htmlChild.has(c.i)) { if (typeof c !== 'string') el++; return renderNode(T, c, frames, null, cx); }
      // an element directly in <html>: inserted there by the harness (the parser would move it into <body>)
      const e = { how: 'html-child', at: 1 + el++, html: '' }; cx.list.push(e); e.html = renderNode(T, c, frames, null, cx); return '';
    }).join('');
    // the HTML parser drops one newline right after <pre>/<textarea>/<listing>: put it back
    inner += (NL_START.has(n.t) && typeof n.c?.[0] === 'string' && n.c[0].startsWith('\n') ? '\n' : '') + body;
  }
  if (entry) { entry.html = inner; return `<${n.t}${attrs}></${n.t}>`; }
  return `<${n.t}${attrs}>${inner}</${n.t}>`;
}

function renderDoc(T, di, frames, all = null) {
  const d = T.docs[di];
  const h = d.head || {};
  const head = `<head><meta charset="utf-8">${h.viewport != null ? `<meta name="viewport" content="${escA(h.viewport)}">` : ''}${h.base ? `<base href="${escA(h.base)}">` : ''}<style data-wr-gen>${sheetsCss(T, d.sheets)}</style></head>`;
  // nest entries per document: '' = the page, else the iframe document's URL (the key the frame is served under)
  const cx = all ? { inner: all.inner, htmlChild: all.htmlChild, all, next: 0, list: [] } : null;
  const html = (d.quirks ? '' : '<!doctype html>') + renderNode(T, d.tree, frames, head, cx);
  if (cx?.list.length) all.nest[di === 0 ? '' : d.url] = cx.list;
  return html;
}

/** Rule table -> {html, frames:{url: html}, nest?:{docKey: entries}} (JS-free, served at the original URL by the gate).
 *  `nest` (only when the table has content the HTML parser would move, see parserMoves) is applied by the harness right
 *  after load (run.js applyNest); it is part of the artifact (provenance and the source audit cover it). */
export function renderRebuild(table) {
  const frames = {};
  const moves = parserMoves(table);
  const all = { inner: new Set(moves.filter(m => m.repair === 'inner' && m.ci != null).map(m => m.ci)), htmlChild: new Set(), nest: {} };
  for (const m of moves) if (m.repair === 'html-child') { const i = table.els.findIndex(e => e.k === m.k); if (i >= 0) all.htmlChild.add(i); }
  const html = renderDoc(table, 0, frames, moves.length ? all : null);
  return Object.keys(all.nest).length ? { html, frames, nest: all.nest } : { html, frames };
}

/** In-page (the rebuild document or one of its iframes): apply a rebuild's nest entries in order (see parserMoves).
 *  'inner': the marked element gets its content through the fragment parser (setHTMLUnsafe: declarative shadow roots
 *  too), then loses the marker; 'html-child': the element is parsed in a detached <div> and inserted into <html> at its
 *  index. Self-contained. Returns {done, missing}. */
export function applyNest(entries) {
  const find = id => {
    const sel = `[data-wr-nest="${id}"]`;
    const roots = [document];
    while (roots.length) { const r = roots.pop(); const hit = r.querySelector(sel); if (hit) return hit; for (const el of r.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot); }
    return null;
  };
  const set = (el, html) => { if (el.setHTMLUnsafe) el.setHTMLUnsafe(html); else el.innerHTML = html; };
  let done = 0; const missing = [];
  for (const e of entries) {
    if (e.how === 'html-child') {
      const box = document.createElement('div'); set(box, e.html);
      const el = box.firstElementChild; if (!el) { missing.push(`html-child@${e.at}`); continue; }
      document.documentElement.insertBefore(el, document.documentElement.children[e.at] || null); done++; continue;
    }
    const el = find(e.id); if (!el) { missing.push(e.id); continue; }
    el.removeAttribute('data-wr-nest'); set(el, e.html); done++;
  }
  return { done, missing };
}

// ---------- table mutants ----------
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
const OPS = {
  color: 'rgb', 'background-color': 'rgb', 'border-top-color': 'rgb', 'border-color': 'rgb', fill: 'rgb',
  width: 'px', height: 'px', 'min-height': 'px', 'max-width': 'px', 'margin-top': 'px', 'margin-bottom': 'px', 'padding-top': 'px', 'padding-left': 'px', padding: 'px1', margin: 'px1', gap: 'px', 'column-gap': 'px', 'row-gap': 'px',
  'font-size': 'px', 'line-height': 'px', 'letter-spacing': 'px', 'border-radius': 'px', top: 'px', left: 'px',
  'font-weight': 'kw', 'text-align': 'kw', opacity: 'num', 'z-index': 'kw', display: 'kw', position: 'kw', 'justify-content': 'kw', 'align-items': 'kw', 'flex-direction': 'kw',
};
const ALT = { 'font-weight': ['400', '700', '500'], 'text-align': ['left', 'center', 'right'], 'z-index': ['auto', '1', '2'], display: ['block', 'inline', 'flex', 'none'], position: ['static', 'relative'], 'justify-content': ['flex-start', 'center', 'space-between'], 'align-items': ['flex-start', 'center', 'stretch'], 'flex-direction': ['row', 'column'] };
const PX_LONG = { padding: 'padding-top', margin: 'margin-top', 'border-radius': 'border-top-left-radius', 'border-color': 'border-top-color', gap: 'row-gap' };

function mutValue(op, prop, v, r) {
  if (/var\(|calc\(|clamp\(|min\(|max\(/.test(v)) return null;
  if (op === 'rgb') { const c = parseColor(v); if (!c) return null; const n = c.r >= 250 ? c.r - 3 : c.r + 3; return `rgb(${n} ${c.g} ${c.b}${c.a < 1 ? ` / ${c.a}` : ''})`; }
  if (op === 'px') { const m = /^(-?[\d.]+)px$/.exec(v); return m ? `${+(Number(m[1]) + 2).toFixed(3)}px` : null; }
  if (op === 'px1') { const m = /^(-?[\d.]+)px(\s.*)?$/.exec(v); return m ? `${+(Number(m[1]) + 2).toFixed(3)}px${m[2] || ''}` : null; }
  if (op === 'num') { const n = Number(v); return Number.isFinite(n) ? String(n > 0.5 ? +(n - 0.2).toFixed(3) : +(n + 0.2).toFixed(3)) : null; }
  if (op === 'kw') { const alt = (ALT[prop] || []).filter(a => a !== v); return alt.length ? alt[Math.floor(r() * alt.length)] : null; }
  return null;
}
/** Does the declared literal show up as the element's computed value (so the declaration is the cascade winner and
 *  a mutant of it is not equivalent)? */
function wins(prop, v, cs) {
  const p = PX_LONG[prop] || prop;
  const c = cs.get(p); if (c == null) return false;
  if (OPS[prop] === 'rgb') { const a = parseColor(v), b = parseColor(c); return !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b && Math.abs(a.a - b.a) < 0.01; }
  if (OPS[prop] === 'px1') return parseFloat(v) === parseFloat(c);
  return c === v;
}

/**
 * n mutants of a rule table: declarations of rules that apply at the capture point and win on some element,
 * inline declarations, and @font-face families actually used. Each: {id, desc, html, frames}.
 */
export function tableMutants(T, n = 20, seed = 20261016, { usedFamilies = null } = {}) {
  const r = rng(seed);
  const active = id => (T.rules[id].ctx || []).every(g => T.rules[g].active !== false && T.rules[g].t !== 'container');
  const matchedBy = new Map();
  T.els.forEach((e, i) => { for (const id of e.r || []) { if (!matchedBy.has(id)) matchedBy.set(id, []); matchedBy.get(id).push(i); } });
  const sites = [];
  for (const rule of T.rules) {
    if (rule.t !== 'style' || !matchedBy.has(rule.id) || !active(rule.id)) continue;
    rule.d.forEach(([p, v], k) => {
      if (!OPS[p]) return;
      const els = matchedBy.get(rule.id).slice(0, 4);
      if (els.some(i => wins(p, v, decodeComputed(T, i))) && mutValue(OPS[p], p, v, () => 0) !== null) sites.push({ kind: 'rule', id: rule.id, k, p, v });
    });
  }
  const inline = [];
  const walk = node => { if (!node || typeof node === 'string') return; (node.s || []).forEach(([p, v], k) => { if (OPS[p] && mutValue(OPS[p], p, v, () => 0) !== null && wins(p, v, decodeComputed(T, node.i))) inline.push({ kind: 'inline', node, k, p, v }); }); (node.c || []).forEach(walk); if (node.sr) node.sr.c.forEach(walk); };
  for (const d of T.docs) walk(d.tree);
  const fams = new Map();
  for (const rule of T.rules) if (rule.t === 'font-face') { const f = rule.d.find(([p]) => p === 'font-family'); if (f) { const name = f[1].replace(/^["']|["']$/g, ''); if (!usedFamilies || usedFamilies.some(u => u.includes(name))) fams.set(name, rule); } }
  const pick = (list, k) => { const out = [], used = new Set(); for (let t = 0; out.length < k && t < k * 50 && list.length; t++) { const i = Math.floor(r() * list.length); if (!used.has(i)) { used.add(i); out.push(list[i]); } } return out; };
  const chosen = [...pick([...fams.keys()].map(f => ({ kind: 'family', f })), 2), ...pick(inline, 3)];
  const byProp = new Map(); for (const s of sites) { if (!byProp.has(s.p)) byProp.set(s.p, []); byProp.get(s.p).push(s); }
  const props = [...byProp.keys()];
  for (let t = 0; chosen.length < n && t < n * 50 && props.length; t++) { const [s] = pick(byProp.get(props[Math.floor(r() * props.length)]), 1); if (s && !chosen.includes(s)) chosen.push(s); }
  const out = [];
  for (const s of chosen.slice(0, n)) {
    let desc, art;
    if (s.kind === 'family') {
      const saved = []; for (const rule of T.rules) if (rule.t === 'font-face') { const f = rule.d.findIndex(([p, v]) => p === 'font-family' && v.replace(/^["']|["']$/g, '') === s.f); if (f >= 0) { saved.push([rule, rule.d]); rule.d = rule.d.map((x, i) => (i === f ? [x[0], `"${s.f}-wrmut"`] : x)); } }
      art = renderRebuild(T); for (const [rule, d] of saved) rule.d = d;
      desc = `@font-face family "${s.f}" renamed`;
    } else {
      const holder = s.kind === 'rule' ? T.rules[s.id] : s.node;
      const key = s.kind === 'rule' ? 'd' : 's';
      const nv = mutValue(OPS[s.p], s.p, s.v, r); if (nv == null) continue;
      const orig = holder[key];
      holder[key] = orig.map((x, i) => (i === s.k ? [x[0], nv, x[2]].filter(y => y !== undefined) : x));
      art = renderRebuild(T); holder[key] = orig;
      desc = `${s.kind === 'rule' ? `rule ${s.id} ${T.rules[s.id].sel.slice(0, 50)}` : `inline el ${s.node.i}`} ${s.p}: ${s.v.slice(0, 40)} -> ${nv}`;
    }
    out.push({ id: out.length + 1, desc, ...art });
  }
  return out;
}
