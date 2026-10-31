// Authored + computed design capture (stage D1, review F2). One JSON per page state ("rule table capture"):
//   rules    every rule of every sheet (document, open shadow roots, same-origin iframes, adopted, @import), in
//            cascade order, as the engine parsed it: selector, declarations as authored (var(), clamp(), calc(), %,
//            vw, fr kept; only relative url() made absolute), at-rule context chain (@media/@container/@supports/
//            @layer/@scope/@starting-style), specificity, sheet; @font-face/@keyframes/@property kept structured
//   docs     the DOM as a tree (tags, attributes, text, inline style as declarations, shadow roots, iframe docs)
//   els      per element: oracle key, matched rule ids (selector matches, whatever the condition), state-candidate
//            rule ids (match once :hover/:focus/... are removed), pseudo-element rule ids
//   computed compact computed style per element (diff vs its parent; full at a root), the verification layer
//   vars     var() dependency graph            coverage  CDP rule usage over the session + every unused rule, why
// The engine is the parser (CSSOM of the live sheets; cross-origin sheets re-parsed from CDP text in a constructed
// sheet), so what is recorded is what the cascade used, not a regex guess. Per-element ids come from the engine's
// own selector matching (Element.matches), which, unlike CSS.getMatchedStylesForNode, also lists rules whose
// @media/@container condition is false right now (needed to explain other widths).

/** In-page capture. Runs via page.evaluate(inPageRuleTable, {texts}). Self-contained.
 *  texts: {href: cssText} for sheets the CSSOM cannot read (cross-origin); missing ones are listed in `need`.
 *  parseOnly (unit tests, Node): return the authored-text block tree of that CSS text (parseBlocks) and nothing else. */
export function inPageRuleTable({ texts = {}, parseOnly = null } = {}) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const STATE_RE = /:(hover|focus-visible|focus-within|focus|active|target-within|target|popover-open|modal|fullscreen|user-invalid|user-valid|autofill|-webkit-autofill)(?![\w-])/g;
  const out = { v: 1, url: location.href, docs: [], sheets: [], rules: [], els: [], need: [], shadows: {}, topLayer: [] };
  const R = out.rules;

  // ---------- text helpers ----------
  function splitTop(s, sep) {
    const parts = []; let depth = 0, q = null, cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) { cur += ch; if (ch === '\\') { cur += s[++i] ?? ''; } else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (ch === sep && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }
  const absUrls = (v, base) => (!base || !v.includes('url(')) ? v : v.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g, (m, a, b, c) => {
    const u = a ?? b ?? c;
    if (!u || /^(data:|#|[a-z][a-z0-9+.-]*:)/i.test(u)) return m;
    try { return `url("${new URL(u, base).href}")`; } catch { return m; }
  });
  // ---------- authored text of a rule (only for declarations the CSSOM cannot serialise, see styleDecls) ----------
  // The authored sheet is parsed into a block tree (statements of the sheet / of grouping at-rules, in source order) and a
  // CSSOM rule is mapped to its OWN block by its position path (index in its parent's cssRules, up to the sheet), never by
  // selector text: two rules with one selector (one inside @media) differ only inside var(), where the engine reads every
  // longhand back as '' and a re-parse cannot tell them apart. A mapping is used only when it is proven: at every level the
  // number of source statements equals the number of CSSOM rules, no ancestor is a style rule (nesting), and the block's
  // selector equals the rule's. Otherwise the caller keeps the engine's readout and counts the rule as lossy.
  const GROUPING = /^@(media|supports|layer|container|scope|document|-moz-document|starting-style)\b/i;
  const srcCache = new WeakMap();
  if (parseOnly != null) return { blocks: parseBlocks(parseOnly) };
  function parseBlocks(text) {
    let i = 0;
    const n = text.length;
    const skipStr = q => { for (i++; i < n && text[i] !== q; i++) if (text[i] === '\\') i++; i++; };
    const skipComment = () => { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; };
    function list(top) {
      const out = [];
      for (;;) {
        let pre = '', pdepth = 0;
        for (; i < n; ) {
          const ch = text[i];
          // an escaped character is part of an identifier, never a quote / bracket / brace (Tailwind `.content-\[\'\'\]`,
          // `.max-w-\[calc\(100\%-2rem\)\]`): read as a pair. Without this the whole sheet failed as `unterminated`
          // (26 Oct, L7: 12 of the local deep archives' sheets).
          if (ch === '\\') { pre += text.slice(i, i + 2); i += 2; continue; }
          if (ch === '/' && text[i + 1] === '*') { skipComment(); continue; }
          if (ch === '"' || ch === "'") { const st = i; skipStr(ch); pre += text.slice(st, i); continue; }
          if (ch === '(' || ch === '[') pdepth++; else if (ch === ')' || ch === ']') pdepth--;
          if (pdepth <= 0 && (ch === '{' || ch === ';' || ch === '}')) break;
          pre += ch; i++;
        }
        pre = pre.trim();
        if (i >= n) { if (pre) throw new Error('unterminated'); return out; }
        const ch = text[i];
        if (ch === '}') { if (top) throw new Error('stray }'); return out; }
        if (ch === ';') { i++; if (pre && !/^@charset/i.test(pre)) out.push({ pre, leaf: true }); continue; }
        i++; // '{'
        if (GROUPING.test(pre)) { const kids = list(false); if (text[i] !== '}') throw new Error('unterminated'); i++; out.push({ pre, kids }); continue; }
        const start = i; let depth = 1, nested = false;
        for (; i < n && depth; ) {
          const c = text[i];
          if (c === '\\') { i += 2; continue; }
          if (c === '/' && text[i + 1] === '*') { skipComment(); continue; }
          if (c === '"' || c === "'") { skipStr(c); continue; }
          if (c === '{') { depth++; nested = true; } else if (c === '}') depth--;
          i++;
        }
        if (depth) throw new Error('unterminated');
        out.push({ pre, body: text.slice(start, i - 1), nested });
      }
    }
    return list(true);
  }
  function sheetSource(sheet, win) {
    if (srcCache.has(sheet)) return srcCache.get(sheet);
    let tree = null;
    try {
      let text = null;
      const o = sheet.ownerNode;
      if (o && o.tagName === 'STYLE') text = o.textContent;
      else if (sheet.href) { const x = new win.XMLHttpRequest(); x.open('GET', sheet.href, false); x.send(); if (x.responseText) text = x.responseText; }
      if (text) tree = parseBlocks(text);
    } catch {}
    srcCache.set(sheet, tree); return tree;
  }
  // Source statements the engine keeps (26 Oct, L7). The position match above needs the same statements as the CSSOM, but
  // the engine drops what it cannot parse: a selector it does not support (`::-moz-selection`, `:-ms-input-placeholder`,
  // `:deep(b)`), an unknown at-rule (`@-moz-document`), an invalid @property. Measured offline on the 22-23 Oct deep runs'
  // local archives: of 250 lossy var()-shorthand rules, 176 sat in a level whose source and CSSOM counts differed by such
  // statements, 46 in cross-origin sheets read from text (above), 9 in sheets with escapes (parseBlocks); the rebuild lost
  // e.g. `transition: all .6s var(--ease)` (41 deep gates have such a root, see src/gate/causes.js). Each
  // statement is judged by the engine itself: parsed alone in a scratch sheet, kept when it yields a rule. @import is kept
  // in a document sheet (replaceSync ignores it, the CSSOM has it) and dropped in a constructed one (fromText: replaceSync
  // dropped it there too). Cached per level. Anything the probe judges differently from the sheet (an @import after a
  // rule) only makes the counts differ: no mapping, as before. A wrong match is still caught by `accept` (the block must
  // re-parse to exactly the engine's longhands).
  const keptCache = new WeakMap();
  let probeSheet = null;
  const probe = (text, win) => { if (!probeSheet) probeSheet = new win.CSSStyleSheet(); try { probeSheet.replaceSync(text); return probeSheet.cssRules; } catch { return null; } };
  function keptOf(level, win, imports) {
    const c = keptCache.get(level) || {};
    if (c[imports]) return c[imports];
    const keep = b => {
      if (b.leaf && /^@import\b/i.test(b.pre)) return imports;
      if (b.leaf) return (probe(b.pre + ';', win)?.length ?? 0) > 0;
      if (b.kids) return (probe(`${b.pre}{}`, win)?.length ?? 0) > 0;
      return (probe(b.pre.startsWith('@') ? `${b.pre}{${b.body}}` : `${b.pre}{}`, win)?.length ?? 0) > 0;
    };
    c[imports] = level.filter(keep);
    keptCache.set(level, c);
    return c[imports];
  }
  /** The engine's serialisation of a selector (as rule.selectorText reads it), or null. */
  const engineSelector = (sel, win) => { const r = probe(`${sel}{}`, win); return r && r.length === 1 && r[0].selectorText != null ? r[0].selectorText : null; };
  /** The authored declarations of `rule`, or null when no proven mapping exists or they do not re-parse (`accept`) to the
   *  engine's longhands. */
  function fromSource(rule, base, win, accept) {
    const sheet = rule.parentStyleSheet; if (!sheet) return null;
    const tree = sheetSource(sheet, win); if (!tree) return null;
    const path = [];
    for (let r = rule; r; ) {
      const parent = r.parentRule || r.parentStyleSheet;
      if (!parent) return null;
      if (r.parentRule && r.parentRule.constructor.name === 'CSSStyleRule') return null; // nesting: not mapped
      path.unshift([Array.prototype.indexOf.call(parent.cssRules, r), parent.cssRules.length]);
      r = r.parentRule;
    }
    let level = tree, node = null;
    for (const [idx, count] of path) {
      if (!level) return null;
      // statements the engine drops when it parses the sheet are not CSSOM rules: leave them out of the level first
      level = keptOf(level, win, !!(sheet.ownerNode || sheet.ownerRule));
      if (idx < 0 || level.length !== count) return null;
      node = level[idx]; level = node.kids;
    }
    if (!node || node.body == null || node.nested || node.pre.startsWith('@')) return null;
    const flat = x => x.replace(/\s+/g, '').replace(/::(before|after|first-line|first-letter)/g, ':$1');
    if (flat(node.pre) !== flat(rule.selectorText) && engineSelector(node.pre, win) !== rule.selectorText) return null;
    const cand = decls(node.body.replace(/\/\*[\s\S]*?\*\//g, ''), base);
    return accept(cand) ? cand : null;
  }
  /** A CSSStyleDeclaration -> declarations, verified to round-trip: the engine's shorthand serialisation can be lossy
   *  (measured on a real site: `transition: visibility 0s linear .32s` serialises as `visibility linear 0.32s`, which
   *  re-parses with 0.32s as the DURATION; a multi-layer `mask` loses its per-layer mask-composite). The serialised
   *  block is re-parsed in a scratch rule and every longhand compared; on any difference the block is recorded as
   *  longhands (unless a longhand is pending var() substitution, then kept as is and counted as lossy). */
  const scratch = new Map();
  out.lossy = 0;
  // CSSOM serialises numbers to 6 significant digits (`left: 33.33333333333333%` -> `33.3333%`, measured on a real site's
  // JS-placed rotated cards: a sub-pixel shift that re-rasterises a rotated image). Typed OM keeps the double: single
  // numeric values are re-read from it at full precision.
  const UNIT = { percent: '%', number: '' };
  const precise = (map, p, v) => {
    if (!map || !/^-?[\d.]+(e-?\d+)?[a-z%]*$/i.test(v)) return v;
    try { const t = map.get(p); if (t && t.constructor.name === 'CSSUnitValue' && Number.isFinite(t.value)) { const u = UNIT[t.unit] ?? t.unit; const x = `${t.value}${u}`; return parseFloat(x) !== parseFloat(v) || x.length > v.length ? x : v; } } catch {}
    return v;
  };
  function styleDecls(style, base, win, map = null, rule = null) {
    const d0 = decls(style.cssText, base);
    const d = map ? d0.map(x => { const v = precise(map, x[0], x[1]); return v === x[1] ? x : [x[0], v, ...x.slice(2)]; }) : d0;
    if (!style.length) return d;
    let sc = scratch.get(win);
    if (!sc) { const sh = new win.CSSStyleSheet(); sh.replaceSync('x{}'); sc = sh.cssRules[0].style; scratch.set(win, sc); }
    const same = list => { sc.cssText = list.map(([p, v, i]) => `${p}:${v}${i ? '!important' : ''}`).join(';'); if (sc.length !== style.length) return false; for (let k = 0; k < style.length; k++) { const p = style[k]; if (sc.getPropertyValue(p) !== absUrls(style.getPropertyValue(p), base) || sc.getPropertyPriority(p) !== style.getPropertyPriority(p)) return false; } return true; };
    // (the scratch re-serialises with the same 6-digit rounding, so precise values still compare equal)
    // A shorthand that holds var() and is followed by a longhand of its own family (`transition: x 1s var(--e);
    // transition-delay: ...`) cannot be serialised by the engine: its longhands read back EMPTY ("transition-property: ;"),
    // which the rebuild drops, so the transition is lost (measured on a real site: 1130 elements differ). The authored text
    // is the only source of the shorthand: take the rule's declarations from it, accepted only when they re-parse to
    // exactly the engine's longhands.
    if (rule && d.some(x => x[1] === '')) { const src = fromSource(rule, base, win, same); if (src) return src; out.lossy++; return d; }
    if (same(d)) return d;
    const long = [];
    for (let k = 0; k < style.length; k++) { const p = style[k]; const v = precise(map, p, style.getPropertyValue(p)); if (v === '') { const src = rule ? fromSource(rule, base, win, same) : null; if (src) return src; out.lossy++; return d; } long.push(style.getPropertyPriority(p) ? [p, absUrls(v, base), 1] : [p, absUrls(v, base)]); }
    if (!same(long)) out.lossy++;
    out.longhand = (out.longhand || 0) + 1;
    return long;
  }
  /** cssText of a declaration block -> [[prop, value, important?1:0]] */
  function decls(text, base) {
    const out2 = [];
    for (const part of splitTop(text || '', ';')) {
      const i = part.indexOf(':'); if (i < 0) continue;
      const p = part.slice(0, i).trim(); let v = part.slice(i + 1).trim();
      if (!p) continue;
      let imp = 0; const m = /\s*!\s*important\s*$/i.exec(v); if (m) { imp = 1; v = v.slice(0, m.index).trim(); }
      out2.push(imp ? [p, absUrls(v, base), 1] : [p, absUrls(v, base)]);
    }
    return out2;
  }
  // ---------- specificity (informational; cascade order itself is kept by emitting rules in order) ----------
  function spec1(s) {
    let a = 0, b = 0, c = 0, i = 0;
    const ident = () => { while (i < s.length && /[\w\-\\ -￿]/.test(s[i])) { if (s[i] === '\\') i++; i++; } };
    const arg = () => { let d = 0; const st = i; for (; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { i++; break; } } } return s.slice(st + 1, i - 1); };
    const maxOf = list => splitTop(list, ',').map(spec1).reduce((m, x) => (x[0] - m[0] || x[1] - m[1] || x[2] - m[2]) > 0 ? x : m, [0, 0, 0]);
    while (i < s.length) {
      const ch = s[i];
      if (ch === '#') { a++; i++; ident(); }
      else if (ch === '.') { b++; i++; ident(); }
      else if (ch === '[') { b++; let d = 0; for (; i < s.length; i++) { if (s[i] === '[') d++; else if (s[i] === ']' && --d === 0) { i++; break; } } }
      else if (ch === ':') {
        if (s[i + 1] === ':') { c++; i += 2; ident(); if (s[i] === '(') arg(); continue; }
        i++; const st = i; ident(); const name = s.slice(st, i).toLowerCase();
        const x = s[i] === '(' ? arg() : null;
        if (['is', 'not', 'has', 'matches', '-webkit-any'].includes(name) && x != null) { const m = maxOf(x); a += m[0]; b += m[1]; c += m[2]; }
        else if (name === 'where') { /* 0 */ }
        else if (/^nth-(last-)?child$/.test(name) && x && / of /i.test(x)) { b++; const m = maxOf(x.split(/ of /i)[1]); a += m[0]; b += m[1]; c += m[2]; }
        else if (['before', 'after', 'first-line', 'first-letter'].includes(name)) c++;
        else if ((name === 'host' || name === 'host-context') && x) { b++; const m = maxOf(x); a += m[0]; b += m[1]; c += m[2]; }
        else b++;
      } else if (ch === '*' || ch === '&') i++;
      else if (/[\w\-\\ -￿]/.test(ch)) { c++; ident(); }
      else i++;
    }
    return [a, b, c];
  }
  // ---------- selector parts for matching ----------
  const PE_RE = /::?(before|after|first-line|first-letter)(?![\w-])|::([\w-]+)(\((?:[^()]|\([^()]*\))*\))?/g;
  function selParts(full) {
    const groups = {}; // pe -> {exact:[], free:[]}
    for (const one of splitTop(full, ',')) {
      let pe = '';
      const base = one.replace(PE_RE, (m, legacy, name, args) => { pe = (legacy || name) + (args && !legacy ? args : ''); return ''; }).trim() || '*';
      const fix = x => (/[>+~]\s*$/.test(x) ? x + ' *' : x) || '*';
      // ::slotted()/::part() style elements of another tree: not matched here (recorded on the rule as cross-tree)
      if (/^(slotted|part)\(/.test(pe)) continue;
      const g = groups[pe] || (groups[pe] = { exact: [], free: [] });
      g.exact.push(fix(base));
      g.free.push(fix(base.replace(STATE_RE, '').trim() || '*'));
    }
    return Object.entries(groups).map(([pe, g]) => ({ pe, exact: g.exact.join(', '), free: g.free.join(', '), state: g.free.join() !== g.exact.join() }));
  }
  const resolveNest = (sel, parent) => splitTop(sel, ',').map(x => (x.includes('&') ? x.replace(/&/g, `:is(${parent})`) : `:is(${parent}) ${x.trim()}`)).join(', ');

  // ---------- rules ----------
  const matchersByScope = {};
  const add = rec => { rec.id = R.length; R.push(rec); return rec.id; };
  const headOf = r => { const t = r.cssText; const i = t.indexOf('{'); return (i < 0 ? t : t.slice(0, i)).trim(); };
  function walkList(list, ctx) { const ids = []; for (const r of list) { const id = walkRule(r, ctx); if (id != null) ids.push(id); } return ids; }
  function walkRule(r, ctx) {
    const kind = r.constructor && r.constructor.name;
    const base = { sheet: ctx.sid, scope: ctx.scope, p: ctx.parent ?? null, ctx: ctx.chain };
    const win = ctx.win;
    if (kind === 'CSSStyleRule') {
      const sel = r.selectorText;
      const full = ctx.parentSel ? resolveNest(sel, ctx.parentSel) : sel;
      const rec = { t: 'style', ...base, sel, d: styleDecls(r.style, ctx.base, win, r.styleMap, r), seq: ctx.seq.n++ };
      if (full !== sel) rec.full = full;
      rec.spec = splitTop(full, ',').map(x => spec1(x.trim()));
      if (ctx.scoped) rec.scoped = 1;
      if (ctx.starting) rec.starting = 1;
      const id = add(rec);
      if (!ctx.scoped && !ctx.starting) (matchersByScope[ctx.scope] || (matchersByScope[ctx.scope] = [])).push({ id, parts: selParts(full) });
      if (r.cssRules && r.cssRules.length) rec.c = walkList(r.cssRules, { ...ctx, parent: id, parentSel: full });
      return id;
    }
    if (kind === 'CSSNestedDeclarations') return add({ t: 'decls', ...base, d: styleDecls(r.style, ctx.base, win) });
    const group = { CSSMediaRule: 'media', CSSSupportsRule: 'supports', CSSContainerRule: 'container', CSSLayerBlockRule: 'layer', CSSScopeRule: 'scope', CSSStartingStyleRule: 'starting-style', CSSDocumentRule: 'document' }[kind];
    if (group) {
      const rec = { t: group, ...base, head: headOf(r) };
      if (group === 'media') { rec.cond = r.media.mediaText; try { rec.active = win.matchMedia(rec.cond).matches; } catch {} }
      if (group === 'supports') { rec.cond = r.conditionText; try { rec.active = win.CSS.supports(rec.cond); } catch {} }
      if (group === 'container') { rec.cond = r.conditionText; if (r.containerName) rec.name = r.containerName; }
      if (group === 'layer') rec.name = r.name;
      const id = add(rec);
      rec.c = walkList(r.cssRules, { ...ctx, parent: id, chain: [...ctx.chain, id], scoped: ctx.scoped || group === 'scope', starting: ctx.starting || group === 'starting-style' });
      return id;
    }
    if (kind === 'CSSImportRule') {
      const rec = { t: 'import', ...base, href: r.href, media: r.media && r.media.mediaText, layer: r.layerName ?? null, supports: r.supportsText ?? null };
      const id = add(rec);
      if (rec.media) { try { rec.active = win.matchMedia(rec.media).matches; } catch {} }
      if (r.styleSheet) { const sid = addSheet(r.styleSheet, ctx.scope, 'import', ctx.win, ctx.docBase, [...ctx.chain, id], id); rec.c = out.sheets[sid].rules; rec.sub = sid; }
      return id;
    }
    if (kind === 'CSSFontFaceRule') return add({ t: 'font-face', ...base, d: decls(r.style.cssText, ctx.base) });
    if (kind === 'CSSKeyframesRule') return add({ t: 'keyframes', ...base, head: headOf(r), name: r.name, frames: [...r.cssRules].map(k => ({ key: k.keyText, d: styleDecls(k.style, ctx.base, win) })) });
    if (kind === 'CSSPropertyRule') return add({ t: 'property', ...base, name: r.name, syntax: r.syntax, inherits: r.inherits, initial: r.initialValue ?? null });
    if (kind === 'CSSLayerStatementRule') return add({ t: 'layer-statement', ...base, names: [...r.nameList] });
    if (kind === 'CSSNamespaceRule') return add({ t: 'namespace', ...base, prefix: r.prefix, uri: r.namespaceURI });
    if (kind === 'CSSCharsetRule') return null;
    // anything else (@page, @counter-style, @font-palette-values, @position-try, @view-transition ...): head + body
    const t = r.cssText, i = t.indexOf('{'), j = t.lastIndexOf('}');
    const body = i >= 0 && j > i ? t.slice(i + 1, j) : '';
    return add(body.includes('{') ? { t: 'other', ...base, head: headOf(r), raw: body } : { t: 'other', ...base, head: headOf(r), d: decls(body, ctx.base) });
  }
  function addSheet(sheet, scope, owner, win, docBase, chain = [], parent = null) {
    const sid = out.sheets.length;
    const rec = { sid, scope, owner, href: sheet.href || null, media: sheet.media ? sheet.media.mediaText : '', disabled: !!sheet.disabled, rules: [], readable: true };
    out.sheets.push(rec);
    try { sheet.__wrSid = sid; } catch {}
    const base = sheet.href || docBase;
    let list = null;
    try { list = sheet.cssRules; } catch { list = null; }
    if (!list) {
      rec.readable = false;
      const text = rec.href && texts[rec.href];
      if (text == null) { if (rec.href) out.need.push(rec.href); return sid; }
      if (text === '') { rec.unreadable = true; out.lossy++; return sid; } // the host could not obtain the text (see captureRuleTable): listed, counted lossy
      try { const cs = new win.CSSStyleSheet({ baseURL: rec.href }); cs.replaceSync(text); list = cs.cssRules; rec.fromText = true;
        // the fetched text IS this sheet's authored source (a constructed sheet has no owner node or href for sheetSource):
        // without it every var() shorthand of a cross-origin sheet was lossy (26 Oct, L7: a payments site's third-party sheets)
        try { srcCache.set(cs, parseBlocks(text)); } catch { srcCache.set(cs, null); }
      } catch { return sid; }
    }
    if (rec.disabled) return sid;
    let ch = chain, par = parent;
    if (rec.media && rec.media !== 'all' && owner !== 'import') {
      // <link media=...> / <style media=...>: the whole sheet sits under that condition
      const g = { t: 'media', sheet: sid, scope, p: parent, ctx: chain, head: `@media ${rec.media}`, cond: rec.media, via: 'sheet' };
      try { g.active = win.matchMedia(rec.media).matches; } catch {}
      const gid = add(g); rec.rules.push(gid); ch = [...chain, gid]; par = gid;
      g.c = walkList(list, { sid, scope, win, base, docBase, chain: ch, parent: par, seq: { n: 0 } });
      return sid;
    }
    rec.rules = walkList(list, { sid, scope, win, base, docBase, chain: ch, parent: par, seq: { n: 0 } });
    return sid;
  }
  function sheetsOf(root, scope, win, docBase) {
    const ids = [];
    for (const sh of root.styleSheets || []) {
      const on = sh.ownerNode;
      const owner = !on ? 'unknown' : on.localName === 'link' ? 'link' : on.namespaceURI === 'http://www.w3.org/2000/svg' ? 'svg-style' : 'style';
      ids.push(addSheet(sh, scope, owner, win, docBase));
    }
    for (const sh of root.adoptedStyleSheets || []) ids.push(addSheet(sh, scope, 'adopted', win, docBase));
    return ids;
  }

  // ---------- DOM tree ----------
  const elsOfScope = {};
  const elRefs = [];
  let scopeN = 0;
  function serEl(el, key, scope, parentIdx) {
    const i = out.els.length;
    const erec = { k: key }; if (parentIdx != null) erec.pi = parentIdx;
    out.els.push(erec); elRefs.push(el);
    (elsOfScope[scope] || (elsOfScope[scope] = [])).push(i);
    const node = { t: el.localName, i };
    // top layer (open popover / modal dialog / fullscreen): JS-entered state a static document cannot express (D2)
    for (const q of [':popover-open', ':modal', ':fullscreen']) { try { if (el.matches(q)) { out.topLayer.push({ i, k: key, how: q }); break; } } catch {} }
    const ns = el.namespaceURI;
    if (ns && ns !== 'http://www.w3.org/1999/xhtml') node.ns = ns;
    const a = [];
    for (const at of el.attributes) { if (at.name === 'style' || /^on/i.test(at.name)) continue; a.push([at.name, at.value]); }
    // live form state the attributes may not show
    if ((el.localName === 'input' || el.localName === 'option') && el.value !== undefined && !el.hasAttribute('value') && el.type !== 'file') a.push(['value', String(el.value)]);
    if (el.localName === 'input' && el.checked && !el.hasAttribute('checked')) a.push(['checked', '']);
    if (el.localName === 'option' && el.selected && !el.hasAttribute('selected')) a.push(['selected', '']);
    if (a.length) node.a = a;
    const st = el.style && el.style.cssText;
    if (st) node.s = styleDecls(el.style, el.ownerDocument.baseURI, el.ownerDocument.defaultView, el.attributeStyleMap);
    if (el.shadowRoot) {
      const sc = `${scope}s${++scopeN}`;
      const win = el.ownerDocument.defaultView;
      const sh = { scope: sc, mode: el.shadowRoot.mode, sheets: sheetsOf(el.shadowRoot, sc, win, el.ownerDocument.baseURI) };
      if (el.shadowRoot.delegatesFocus) sh.delegatesFocus = 1;
      out.shadows[sc] = { host: i };
      sh.c = kids(el.shadowRoot, key + '#s', sc, i);
      node.sr = sh;
    }
    if (el.localName === 'iframe') {
      let d = null; try { d = el.contentDocument; } catch {}
      if (d && d.documentElement && el.getAttribute('src')) node.fr = visitDoc(d, new URL(el.getAttribute('src'), el.ownerDocument.baseURI).href, key + '#f/html', i);
    }
    node.c = kids(el, key, scope, i);
    return node;
  }
  function kids(parent, key, scope, parentIdx) {
    const c = [], n = {};
    for (const ch of parent.childNodes) {
      if (ch.nodeType === 3) { if (ch.nodeValue) c.push(ch.nodeValue); continue; }
      if (ch.nodeType !== 1 || SKIP.has(ch.tagName.toUpperCase())) continue;
      const tag = ch.localName;
      n[tag] = (n[tag] || 0) + 1;
      c.push(serEl(ch, `${key}/${tag}[${n[tag]}]`, scope, parentIdx));
    }
    return c;
  }
  function visitDoc(d, url, rootKey, parentIdx) {
    const di = out.docs.length;
    const scope = `d${di}`;
    const rec = { i: di, url, scope, quirks: d.compatMode !== 'CSS1Compat' };
    out.docs.push(rec);
    const vpm = d.querySelector('meta[name="viewport"]'), b = d.querySelector('base[href]');
    rec.head = { viewport: vpm ? vpm.content : null, base: b ? b.getAttribute('href') : null, lang: d.documentElement.getAttribute('lang') };
    rec.sheets = sheetsOf(d, scope, d.defaultView, d.baseURI);
    rec.tree = serEl(d.documentElement, rootKey, scope, parentIdx);
    return di;
  }
  visitDoc(document, location.href, 'html', null);
  if (out.need.length) return { need: [...new Set(out.need)] };
  // top-layer order: entry order as recorded by the gate's script-write recorder (src/gate/scriptowned.js) when
  // present; otherwise document order (`orderFrom` says which)
  { const rec = window.__wrSW && window.__wrSW.top; const at = t => { const j = rec ? rec.indexOf(elRefs[t.i]) : -1; return j < 0 ? -1 : j; };
    if (rec && rec.length) { out.topLayer.sort((a, b) => at(a) - at(b)); out.topLayerOrder = 'entry'; } else out.topLayerOrder = 'document'; }

  // ---------- per-element rule ids (engine selector matching) ----------
  let bad = 0;
  for (const [scope, idxs] of Object.entries(elsOfScope)) {
    const ms = matchersByScope[scope] || [];
    for (const i of idxs) {
      const el = elRefs[i], e = out.els[i];
      for (const m of ms) for (const part of m.parts) {
        if (part.bad) continue;
        let hit = false;
        try { hit = el.matches(part.exact); } catch { part.bad = true; bad++; continue; }
        let st = false;
        if (!hit && part.state) { try { st = el.matches(part.free); } catch { st = false; } }
        if (!hit && !st) continue;
        if (part.pe) { const pe = e.pe || (e.pe = {}); const key2 = (st ? '~' : '') + part.pe; (pe[key2] || (pe[key2] = [])).push(m.id); }
        else if (hit) (e.r || (e.r = [])).push(m.id);
        else (e.st || (e.st = [])).push(m.id);
      }
    }
  }
  // :host rules of a shadow scope belong to its host (Element.matches cannot evaluate :host from outside)
  for (const [sc, g] of Object.entries(out.shadows)) {
    for (const m of matchersByScope[sc] || []) if (/:host/.test(R[m.id].full || R[m.id].sel)) { const e = out.els[g.host]; (e.hr || (e.hr = [])).push(m.id); }
  }
  out.badSelectors = bad;

  // ---------- compact computed (verification layer): diff vs parent element, full at a root ----------
  const pl = [], pIdx = new Map(), vt = [], vIdx = new Map();
  const P = p => { let i = pIdx.get(p); if (i === undefined) { i = pl.length; pl.push(p); pIdx.set(p, i); } return i; };
  const V = v => { let i = vIdx.get(v); if (i === undefined) { i = vt.length; vt.push(v); vIdx.set(v, i); } return i; };
  const maps = new Array(elRefs.length);
  const toMap = cs => { const m = new Map(); for (let k = 0; k < cs.length; k++) m.set(cs[k], cs.getPropertyValue(cs[k])); return m; };
  const diff = (m, ref) => { const o = []; for (const [p, v] of m) if (!ref || ref.get(p) !== v) o.push(P(p), V(v)); return o; };
  const cstyle = new Array(elRefs.length);
  for (let i = 0; i < elRefs.length; i++) {
    const el = elRefs[i], win = el.ownerDocument.defaultView;
    const m = toMap(win.getComputedStyle(el)); maps[i] = m;
    const pi = out.els[i].pi;
    const ref = pi != null && maps[pi] && el.ownerDocument === elRefs[pi].ownerDocument ? maps[pi] : null;
    const rec = { d: diff(m, ref) };
    if (!ref) rec.full = 1;
    for (const w of ['::before', '::after', '::marker']) {
      const c = win.getComputedStyle(el, w);
      if (w === '::marker' ? m.get('display') !== 'list-item' : (c.content === 'none' || c.content === 'normal')) continue;
      (rec.ps || (rec.ps = {}))[w] = diff(toMap(c), m);
    }
    cstyle[i] = rec;
  }
  out.computed = { pl, vt, els: cstyle };
  return out;
}

// ---------- pure helpers (unit-tested without a browser) ----------

/** Decode element i's full computed style from the compact layer. */
export function decodeComputed(table, i) {
  const { computed: C, els } = table;
  const chain = []; for (let k = i; k != null; k = els[k].pi) { chain.push(k); if (C.els[k].full) break; }
  const m = new Map();
  for (const k of chain.reverse()) { const d = C.els[k].d; for (let j = 0; j < d.length; j += 2) m.set(C.pl[d[j]], C.vt[d[j + 1]]); }
  return m;
}

const VAR_RE = /var\(\s*(--[\w-]+)/g;
/** var() dependency graph: per custom property its definitions (rule or inline, with condition chain), the custom
 *  properties those definitions reference, and every declaration that uses it. */
export function varGraph(table) {
  const g = {};
  const node = n => g[n] || (g[n] = { defs: [], deps: [], usedBy: [] });
  const visitDecls = (d, where, ctx) => {
    for (const [p, v] of d || []) {
      const refs = [...String(v).matchAll(VAR_RE)].map(m => m[1]);
      if (p.startsWith('--')) { const n = node(p); n.defs.push({ ...where, value: v, ...(ctx && ctx.length ? { ctx } : {}) }); for (const r of refs) if (!n.deps.includes(r)) n.deps.push(r); }
      for (const r of refs) node(r).usedBy.push({ ...where, prop: p });
    }
  };
  for (const r of table.rules) if (r.d) visitDecls(r.d, { rule: r.id }, r.ctx); else if (r.frames) for (const f of r.frames) visitDecls(f.d, { rule: r.id, keyframe: f.key });
  const walk = n => { if (!n || typeof n === 'string') return; if (n.s) visitDecls(n.s, { el: n.i }); for (const c of n.c || []) walk(c); if (n.sr) for (const c of n.sr.c) walk(c); };
  for (const d of table.docs) walk(d.tree);
  const undefinedRefs = Object.entries(g).filter(([, n]) => !n.defs.length).map(([k]) => k).sort();
  return { vars: g, count: Object.keys(g).length, undefinedRefs };
}

const norm = s => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+|["']/g, '').replace(/::/g, ':').toLowerCase().replace(/\(odd\)/g, '(2n+1)').replace(/\(even\)/g, '(2n)');

/** Prelude of the innermost block enclosing source offset `at` ('' at top level), normalised like selectors so an
 *  authored `@media (width<=860px)` equals the engine-serialised `@media (width <= 860px)`. */
export function enclosingPrelude(text, at) {
  let depth = 0, i = at - 1;
  for (; i >= 0; i--) { const c = text[i]; if (c === '}') depth++; else if (c === '{') { if (!depth) break; depth--; } }
  if (i < 0) return '';
  let s = i - 1; while (s >= 0 && !'{};'.includes(text[s])) s--;
  return norm(text.slice(s + 1, i));
}

/**
 * Attach CDP rule usage to the style rules of the table. Measured (Chrome for Testing 147): stopRuleUsageTracking lists
 * only rules that were USED during tracking (plus one entry per used rule inside a group, pointing at the group's
 * prelude), so a style rule of a mapped sheet with no entry never applied. Entries are aligned to the table's rules in
 * source order by normalised selector; `orphans` counts used entries no table rule claimed (0 = clean alignment).
 * @param {{sid:number, text:string, usage:{startOffset:number,endOffset:number,used:boolean}[]}[]} perSheet
 */
export function attachUsage(table, perSheet) {
  let used = 0, unused = 0, orphans = 0, ctxFallback = 0;
  const orphanSample = [];
  const bySheet = new Map();
  for (const r of table.rules) if (r.t === 'style') { if (!bySheet.has(r.sheet)) bySheet.set(r.sheet, []); bySheet.get(r.sheet).push(r); }
  for (const { sid, text, usage } of perSheet) {
    const rules = (bySheet.get(sid) || []).sort((a, b) => a.seq - b.seq);
    const isPrelude = u => /@[\w-]+\s*$/.test(text.slice(Math.max(0, u.startOffset - 40), u.startOffset).replace(/\/\*[\s\S]*?\*\//g, ''));
    const ents = [...usage].filter(u => u.used && !isPrelude(u)).sort((a, b) => a.startOffset - b.startOffset)
      .map(u => { const i = text.indexOf('{', u.startOffset); return { ...u, sel: norm(text.slice(u.startOffset, i >= 0 && i < u.endOffset ? i : u.endOffset)), ctx: enclosingPrelude(text, u.startOffset), taken: false }; });
    // used entries are a subsequence of the sheet's rules (both in source order): match each entry to the next rule
    // with the same selector AND the same innermost group prelude; rules no entry claims never applied. The prelude
    // check matters for duplicate selectors (measured on a real site: a used `.x` inside an active @media was claimed by
    // an earlier unused `.x` inside an inactive @media, leaving 9 rules "matched now but unused").
    const sels = rules.map(r => norm(r.sel));
    const ctxs = rules.map(r => { const g = (r.ctx || []).length ? table.rules[r.ctx[r.ctx.length - 1]] : null; return g ? norm(g.head || '') : ''; });
    let j = 0;
    for (const e of ents) {
      let k = j; while (k < rules.length && !(sels[k] === e.sel && ctxs[k] === e.ctx)) k++;
      if (k >= rules.length) { k = j; while (k < rules.length && sels[k] !== e.sel) k++; if (k < rules.length) ctxFallback++; }
      if (k < rules.length) { const r = rules[k]; r.used = true; r.range = [e.startOffset, e.endOffset]; e.taken = true; j = k + 1; used++; }
      else { orphans++; if (orphanSample.length < 5) orphanSample.push(e.sel.slice(0, 80)); }
    }
    for (const r of rules) if (r.used !== true) { r.used = false; unused++; }
  }
  return { used, unused, orphans, orphanSample, ctxFallback, sheetsMapped: perSheet.length };
}

const STATE_SEL = /:(hover|focus-visible|focus-within|focus|active|target|popover-open|modal|fullscreen|checked|disabled|enabled|invalid|valid|user-invalid|user-valid|placeholder-shown|open|closed|indeterminate|visited|autofill|-webkit-autofill)(?![\w-])|\[(aria-(expanded|selected|checked|pressed|current|hidden)|open|data-state)[^\]]*\]/;

/** Every style rule that never applied during the session (CDP rule usage), each with the reasons it could not
 *  apply at the capture point: media-inactive / supports-false / container / state / no-element / pseudo-element /
 *  starting-style / scoped. Rules that did apply during the session but match nothing now are listed as transient. */
export function coverageReport(table) {
  const byId = table.rules;
  const matched = new Set(), stateMatched = new Set(), peMatched = new Set();
  for (const e of table.els) { for (const id of e.r || []) matched.add(id); for (const id of e.st || []) stateMatched.add(id); for (const [k, ids] of Object.entries(e.pe || {})) for (const id of ids) (k.startsWith('~') ? stateMatched : peMatched).add(id); for (const id of e.hr || []) matched.add(id); }
  const unused = [], transient = [], unknown = [];
  const counts = {};
  for (const r of byId) {
    if (r.t !== 'style') continue;
    const ctx = (r.ctx || []).map(id => byId[id]);
    const ctxText = ctx.map(g => g.head || (g.t === 'import' ? `@import ${g.href}` : g.t)).join(' > ');
    if (r.used === undefined) { unknown.push({ id: r.id, sel: r.sel, ctx: ctxText }); continue; }
    const now = matched.has(r.id) || peMatched.has(r.id);
    if (r.used) { if (!now && !ctx.some(g => g.active === false)) transient.push({ id: r.id, sel: r.sel, ctx: ctxText }); continue; }
    const why = [];
    if (ctx.some(g => g.active === false)) why.push(ctx.some(g => g.t === 'supports' && g.active === false) ? 'supports-false' : 'media-inactive');
    if (ctx.some(g => g.t === 'container')) why.push('container');
    if (r.starting) why.push('starting-style');
    if (r.scoped) why.push('scoped');
    if (STATE_SEL.test(r.full || r.sel) || stateMatched.has(r.id)) why.push('state');
    const pes = [...(r.full || r.sel).matchAll(/::([\w-]+)/g)].map(m => m[1]).filter(n => !['before', 'after', 'marker'].includes(n));
    if (pes.length) why.push('pseudo-element');
    if (!matched.has(r.id) && !stateMatched.has(r.id) && !peMatched.has(r.id) && !why.length) why.push('no-element');
    if (!why.length) why.push('matched-now-unused-in-session');
    for (const w of why) counts[w] = (counts[w] || 0) + 1;
    unused.push({ id: r.id, sel: r.sel, ctx: ctxText, why, ...(pes.length ? { pseudo: [...new Set(pes)] } : {}) });
  }
  const style = byId.filter(r => r.t === 'style').length;
  return { styleRules: style, used: byId.filter(r => r.t === 'style' && r.used === true).length, unusedCount: unused.length, unknownCount: unknown.length, counts, unused, transient, unknown };
}

/** Copy rule usage from a table captured in a tracked session onto a table of the same page captured in an
 *  untracked one (tracking slows style recalc enough to shift real-time-driven JS state; measured on a real site).
 *  Style rules are aligned by (scope, sheet href or position, order in sheet) and checked by selector. */
export function mergeUsage(table, tracked) {
  const key = (T, r) => { const sh = T.sheets[r.sheet]; const pos = T.sheets.filter(x => x.scope === sh.scope).indexOf(sh); return `${sh.scope}|${sh.href || 'pos' + pos}|${r.seq}`; };
  const m = new Map();
  for (const r of tracked.rules) if (r.t === 'style') m.set(key(tracked, r), r);
  let merged = 0, missing = 0, selMismatch = 0;
  for (const r of table.rules) {
    if (r.t !== 'style') continue;
    const o = m.get(key(table, r));
    if (!o || o.used === undefined) { missing++; continue; }
    if (norm(o.sel) !== norm(r.sel)) { selMismatch++; continue; }
    r.used = o.used; if (o.range) r.range = o.range; merged++;
  }
  table.usageMap = { ...tracked.usageMap, merged, missing, selMismatch, from: 'tracked replay' };
  table.coverage = coverageReport(table);
  return table.usageMap;
}

/** Text of a stylesheet the CSSOM will not let the page read (cross-origin): CDP first, then a fetch from the page (the
 *  replayed archive answers it); null when neither works. */
async function crossOriginSheetText(page, css, href) {
  const { sheetText } = await import('./cdpcss.js');
  try {
    const id = Object.keys(css.sheets).find(k => css.sheets[k].sourceURL === href);
    const txt = id ? await sheetText(css, id) : null;
    if (txt) return txt; // CDP can hold an empty body for a sheet the page loaded cross-origin: then try the fetch
  } catch { /* fall through to the fetch */ }
  try {
    const txt = await page.evaluate(async h => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000); try { const r = await fetch(h, { signal: ac.signal }); return r.ok ? await r.text() : null; } finally { clearTimeout(t); } }, href);
    return typeof txt === 'string' && txt !== '' ? txt : null;
  } catch { return null; }
}

/** Node side: capture the table. css = cdpcss.openCss session (opened at capture time is fine); with usage=true the
 *  rule-usage tracking must have been started on it BEFORE navigation (usage then covers load + sweep + this point). */
export async function captureRuleTable(page, css, { usage = true } = {}) {
  const { sheetText, stopRuleUsage, sheetIdsByOwner } = await import('./cdpcss.js');
  let t = await page.evaluate(inPageRuleTable, {});
  let unreadable = [];
  if (t.need?.length) {
    const texts = {};
    for (const href of t.need) texts[href] = await crossOriginSheetText(page, css, href);
    // a sheet whose text cannot be had by either route (CDP, a fetch the archive answers) must not fail the capture: it is
    // walked as an empty sheet, flagged `unreadable` in the table and counted lossy (verdict: unreadableSheets)
    unreadable = t.need.filter(h => texts[h] == null);
    for (const h of unreadable) texts[h] = '';
    t = await page.evaluate(inPageRuleTable, { texts });
    if (t.need?.length) throw new Error(`unreadable sheets: ${t.need.join(', ')}`);
  }
  if (unreadable.length) t.unreadableSheets = unreadable;
  delete t.need;
  if (usage) {
    const ru = await stopRuleUsage(css);
    const owner = await sheetIdsByOwner(css); // CDP styleSheetId -> our sid
    const per = new Map([...owner].map(([id, sid]) => [id, { sid, usage: [] }])); // every mapped sheet, used rules or not
    for (const u of ru) per.get(u.styleSheetId)?.usage.push(u);
    const perSheet = [];
    let sheetsGone = 0; // removed between the usage run and now (F9): their rules stay 'unknown', never 'unused'
    for (const [id, x] of per) { const text = await sheetText(css, id); if (text == null) { sheetsGone++; continue; } perSheet.push({ ...x, text }); }
    t.usageMap = { ...attachUsage(t, perSheet), cdpEntries: ru.length, cdpSheets: per.size, sheetsGone, lossy: t.lossy, longhandBlocks: t.longhand || 0 };
    t.coverage = coverageReport(t);
  }
  t.vars = varGraph(t);
  return t;
}
