// Source audit (review F3 layer 4): proves a rebuild is built from OUR data only.
//  1. network: the rebuild load requests 0 stylesheets and 0 scripts;
//  2. artifact text: no <script>, no <link rel=stylesheet>, every <style> carries data-wr-gen;
//  3. no original rule text (any non-@font-face rule of any original sheet, incl. shadow/adopted/iframe sheets)
//     appears verbatim in the rebuild; @font-face is allowed (fonts are captured assets);
//  4. no original inline style attribute value appears as a rebuild style attribute;
//  5. the rebuild ran with JavaScript disabled (declared by the runner).

/** In-page: every original rule text (non font-face) and every inline style attribute value. Self-contained. */
export function inPageSources() {
  const rules = new Set(), inline = new Set();
  const sheetsOf = root => [...(root.styleSheets || []), ...(root.adoptedStyleSheets || [])];
  const walkRules = list => { for (const r of list) { if (r.type === CSSRule.FONT_FACE_RULE) continue; if (r.cssRules && r.type !== CSSRule.STYLE_RULE) walkRules(r.cssRules); rules.add(r.cssText); } };
  const visitRoot = root => {
    for (const sh of sheetsOf(root)) { try { walkRules(sh.cssRules); } catch {} }
    for (const el of root.querySelectorAll('*')) {
      const st = el.getAttribute('style'); if (st && st.trim()) inline.add(st.trim());
      if (el.shadowRoot) visitRoot(el.shadowRoot);
      if (el.tagName === 'IFRAME') { try { if (el.contentDocument) visitRoot(el.contentDocument); } catch {} }
    }
  };
  visitRoot(document);
  return { rules: [...rules], inline: [...inline] };
}

const norm = s => s.replace(/\s+/g, ' ').trim();

/**
 * @param {{rules:string[], inline:string[]}} sources  from the ORIGINAL page
 * @param {{html:string, frames?:object}} artifact     the rebuild
 * @param {{requests:{type:string,url:string}[], jsDisabled?:boolean, scriptsBlocked?:string}} load  rebuild load facts:
 *   JavaScript disabled, or (gate default since D1b) every script blocked by the CSP the rebuild is served with
 */
export function auditSources(sources, artifact, load) {
  // nest entries (content the harness puts in where the HTML parser would re-nest it, rebuild.js) are artifact text too
  const docs = [artifact.html, ...Object.values(artifact.frames || {}), ...Object.values(artifact.nest || {}).flat().map(e => e.html)];
  const issues = [];
  const cssReq = load.requests.filter(r => r.type === 'stylesheet' || r.type === 'script');
  if (cssReq.length) issues.push({ kind: 'network', n: cssReq.length, sample: cssReq.slice(0, 3).map(r => `${r.type} ${r.url.slice(0, 100)}`) });
  if (!load.jsDisabled && load.scriptsBlocked !== "csp: script-src 'none'") issues.push({ kind: 'js-enabled' });
  let styleText = '';
  for (const d of docs) {
    if (/<script[\s>]/i.test(d)) issues.push({ kind: 'script-tag' });
    for (const m of d.matchAll(/<[a-z][^>]*\s(on[a-z]+)\s*=|(?:href|src|action)\s*=\s*"?\s*javascript:/gi)) issues.push({ kind: 'script-handler', sample: m[0].slice(0, 80) });
    for (const m of d.matchAll(/<link\b[^>]*>/gi)) if (/rel="?[^"]*stylesheet/i.test(m[0]) || /as="?style/i.test(m[0])) issues.push({ kind: 'link-stylesheet', tag: m[0].slice(0, 120) });
    for (const m of d.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)) {
      if (!/data-wr-gen/.test(m[1])) issues.push({ kind: 'foreign-style', sample: m[2].slice(0, 80) });
      styleText += '\n' + m[2];
    }
  }
  const st = norm(styleText);
  let ruleHits = 0; const ruleSample = [];
  for (const r of sources.rules) { const t = norm(r); if (t.length >= 20 && st.includes(t)) { ruleHits++; if (ruleSample.length < 3) ruleSample.push(t.slice(0, 100)); } }
  if (ruleHits) issues.push({ kind: 'original-rule-text', n: ruleHits, sample: ruleSample });
  const attrs = new Set();
  for (const d of docs) for (const m of d.matchAll(/\sstyle="([^"]*)"/g)) attrs.add(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim());
  // An original attribute already written exactly in the renderer's canonical form (`prop:value;prop:value`, e.g.
  // style="--o-face:0") is reproduced byte-for-byte by ANY faithful re-serialisation, so equality cannot tell copying
  // from capture there; those are counted (canonicalInline), and the provenance check (artifact === render(JSON))
  // carries the proof for them. Every other verbatim match is an issue.
  const canon = v => v.split(';').map(x => x.trim()).filter(Boolean).map(x => { const i = x.indexOf(':'); return i < 0 ? x : `${x.slice(0, i).trim()}:${x.slice(i + 1).trim()}`; }).join(';');
  const same = sources.inline.filter(v => v.length >= 8 && attrs.has(v));
  const canonical = same.filter(v => canon(v) === v);
  const inl = same.filter(v => canon(v) !== v);
  if (inl.length) issues.push({ kind: 'original-inline-style', n: inl.length, sample: inl.slice(0, 3).map(s => s.slice(0, 80)) });
  return { pass: issues.length === 0, checkedRules: sources.rules.length, checkedInline: sources.inline.length, canonicalInline: canonical.length, styleBytes: styleText.length, cssJsRequests: cssReq.length, issues };
}
