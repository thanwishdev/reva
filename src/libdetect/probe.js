// In-page evidence probe for libdetect. READ-ONLY: it never writes to the page, never calls getContext, never patches
// anything, and only reports names from the allow-lists built out of signatures.js (it does not export page text, apart
// from script URLs, which are page-derived and therefore flagged untrusted).
//
// Static-layer rule (PLAN M4): run it in its own page load, not inside a motion take's session. Run-time traces such as
// `_gsap` on elements or `html.lenis` exist as soon as the library has initialised, so an idle page after `load` shows them.
import { LIBRARIES } from './signatures.js';

export const PROBE_VERSION = 'libdetect-probe-1';

export function buildProbeSource() {
  const allow = { classes: [], classPrefixes: [], attrs: [], attrPrefixes: [], attrPairs: [], globals: [], expandos: [], engines: [], tags: [], versions: {} };
  for (const l of LIBRARIES) {
    for (const d of l.dom || []) {
      if (d.kind === 'class') allow.classes.push(d.value);
      else if (d.kind === 'classPrefix') allow.classPrefixes.push(d.value);
      else if (d.kind === 'attr') (d.value.includes('=') ? allow.attrPairs : allow.attrs).push(d.value);
      else if (d.kind === 'attrPrefix') allow.attrPrefixes.push(d.value);
      else if (d.kind === 'global') allow.globals.push(d.value);
      else if (d.kind === 'expando') allow.expandos.push(d.value);
      else if (d.kind === 'engine') allow.engines.push(d.value);
      else if (d.kind === 'tag') allow.tags.push(d.value);
    }
    if (l.runtimeVersion) allow.versions[l.id] = l.runtimeVersion;
  }
  for (const k of Object.keys(allow)) if (Array.isArray(allow[k])) allow[k] = [...new Set(allow[k])];
  return `(() => {
  const A = ${JSON.stringify(allow)};
  const out = { probe: ${JSON.stringify(PROBE_VERSION)}, classes: [], attrs: [], globals: [], expandos: {}, engines: [], tags: [], scripts: [], versions: {}, elementsScanned: 0, truncated: false, untrusted: ['scripts'] };
  const cls = new Set(A.classes), attrs = new Set(A.attrs), tags = new Set(A.tags);
  const seen = { classes: new Set(), attrs: new Set(), tags: new Set(), engines: new Set() };
  const LIMIT = 30000, CAP = 40;
  try {
    const els = document.querySelectorAll('*');
    const n = Math.min(els.length, LIMIT); out.truncated = els.length > LIMIT;
    for (let i = 0; i < n; i++) {
      const el = els[i]; out.elementsScanned++;
      for (const t of el.classList) {
        if (seen.classes.size < 400 && (cls.has(t) || A.classPrefixes.some(p => t.startsWith(p)))) seen.classes.add(t);
      }
      for (const name of el.getAttributeNames()) {
        if (attrs.has(name) || A.attrPrefixes.some(p => name.startsWith(p))) { if (seen.attrs.size < 400) seen.attrs.add(name); }
      }
      for (const pair of A.attrPairs) { const k = pair.indexOf('='); if (el.getAttribute(pair.slice(0, k)) === pair.slice(k + 1)) seen.attrs.add(pair); }
      const tag = el.localName; if (tags.has(tag)) seen.tags.add(tag);
      for (const e of A.expandos) { try { if (el[e]) out.expandos[e] = (out.expandos[e] || 0) + 1; } catch (_) {} }
      if (el.localName === 'canvas') { const v = el.getAttribute('data-engine'); if (v && seen.engines.size < CAP) seen.engines.add(v.slice(0, 60)); }
    }
  } catch (e) { out.error = String(e && e.message || e); }
  out.classes = [...seen.classes]; out.attrs = [...seen.attrs]; out.tags = [...seen.tags]; out.engines = [...seen.engines];
  for (const g of A.globals) { try { if (g in window) out.globals.push(g); } catch (_) {} }
  for (const [id, path] of Object.entries(A.versions)) {
    try { let v = window; for (const k of path.split('.')) v = v == null ? undefined : v[k]; if (typeof v === 'string' || typeof v === 'number') out.versions[id] = String(v).slice(0, 40); } catch (_) {}
  }
  try { out.scripts = [...document.scripts].map(s => s.src).filter(Boolean).slice(0, 200); } catch (_) {}
  return out;
})()`;
}

/** page: any object with evaluate(string) (a Playwright Page). */
export async function runProbe(page) {
  const r = await page.evaluate(buildProbeSource());
  if (r?.probe !== PROBE_VERSION) throw new Error('libdetect probe returned an unexpected result');
  return r;
}
