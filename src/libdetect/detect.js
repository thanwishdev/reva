// Bundle-signature motion-library detection (PLAN M4 / P4). Pure functions: text in, JSON out, no I/O, no browser.
//
// Evidence model (PLAN §3, H6):
//   * a library hit is `inferred` (a signature matched), never `declared`/`measured`;
//   * a version read from a literal in code or a CDN URL is `declared`; read from a live global it is `measured`;
//   * "bundle contains the library" is not "the library runs": `firing` is `observed` only with run-time evidence
//     (a global, an element expando, a class the library adds), otherwise `unknown` with a ledger entry;
//   * "not detected" is not "absent": the result lists what was scanned (coverage) and never emits a negative claim.
import { LIBRARIES, FAMILIES, SIGNATURE_SET, THRESHOLDS, DEFAULT_KINDS } from './signatures.js';
import { normaliseModules } from './modules.js';
import { analyseBehaviour } from './behaviour.js';

export const SCHEMA = 'reva.libdetect/1';
const BYID = new Map(LIBRARIES.map(l => [l.id, l]));
const CDN_HOSTS = '(?:cdnjs\\.cloudflare\\.com/ajax/libs|cdn\\.jsdelivr\\.net/npm|unpkg\\.com|esm\\.sh|cdn\\.skypack\\.dev)';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Package/CDN matchers are built once from each library's `packages`. Sub-path packages (gsap/ScrollTrigger) are matched
// in module paths only; on a CDN the file name decides (`files`), because a CDN package name is the bare package.
const isScoped = (p) => p.startsWith('@') && p.split('/').length === 2;
const PKG = LIBRARIES.map(l => ({
  lib: l,
  path: l.packages.map(p => new RegExp(`node_modules[\\\\/](?:\\.pnpm[\\\\/][^\\\\/]+[\\\\/]node_modules[\\\\/])?${escapeRe(p).replace(/\\\//g, '[\\\\/]')}[\\\\/]`)),
  cdn: l.packages.filter(p => !p.includes('/') || isScoped(p)).map(p => new RegExp(`${CDN_HOSTS}/(?:npm:)?${escapeRe(p)}(?:@([0-9][\\w.\\-]*)|/([0-9][\\w.\\-]*)/|(?=[/?#]|$))`, 'i')),
}));
const URL_RE = /https?:\/\/[^\s"'`)<>\\]{4,300}?\.(?:m?js|css)(?:\?[^\s"'`)<>\\]{0,100})?|https?:\/\/(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|cdn\.skypack\.dev|ga\.jspm\.io)\/[^\s"'`)<>\\]{2,300}/g;
export function extractUrls(src, cap = 300) {
  const out = new Set(); URL_RE.lastIndex = 0; let m;
  while ((m = URL_RE.exec(src)) && out.size < cap) out.add(m[0]);
  return [...out];
}

function snippet(src, off, len) {
  return src.slice(Math.max(0, off - 24), off + Math.min(len, 56)).replace(/\s+/g, ' ').trim().slice(0, 80);
}
function lineOf(src, off) { let n = 1; for (let i = src.indexOf('\n'); i !== -1 && i < off; i = src.indexOf('\n', i + 1)) n++; return n; }
function count(src, s, cap = 99) { let n = 0; for (let i = src.indexOf(s); i !== -1 && n < cap; i = src.indexOf(s, i + s.length)) n++; return n; }

/** Run one code signature on one module; returns {offset, length, count?} or null. */
function matchSig(sig, mod) {
  const src = mod.source;
  if (sig.s !== undefined) { const i = src.indexOf(sig.s); return i < 0 ? null : { offset: i, length: sig.s.length, count: count(src, sig.s) }; }
  if (sig.re) { const m = sig.re.exec(src); return m ? { offset: m.index, length: m[0].length } : null; }
  if (sig.all) {
    let first = Infinity;
    for (const s of sig.all) { const i = src.indexOf(s); if (i < 0) return null; first = Math.min(first, i); }
    return { offset: first, length: sig.all[0].length };
  }
  return null;
}

function scanModule(mod, hits) {
  const isPath = mod.kind === 'path';
  for (const { lib, path: pathRes, cdn } of PKG) {
    // package directory (node_modules/<pkg>/): in a module id, or written in a comment/source-map reference inside the text
    for (const re of pathRes) {
      const m = re.exec(mod.id) || (isPath ? null : re.exec(mod.source));
      if (m) { hits.push({ lib: lib.id, sig: 'package-path', w: 4, role: 'impl', where: 'path', moduleId: mod.id, snippet: m[0].slice(0, 80) }); break; }
    }
    const hay = isPath ? mod.source : mod.id;
    for (const re of lib.files || []) { if (re.test(hay)) { hits.push({ lib: lib.id, sig: 'file-name', w: 3, role: isPath ? 'cdn' : 'impl', where: 'path', moduleId: mod.id }); break; } }
    if (isPath) for (const re of cdn) {
      const m = re.exec(mod.source);
      if (m) { hits.push({ lib: lib.id, sig: 'cdn-url', w: 4, role: 'cdn', where: 'path', moduleId: mod.id, snippet: m[0].slice(0, 100), version: m[1] || m[2] || null }); break; }
    }
  }
  if (isPath) return;
  for (const lib of LIBRARIES) {
    for (const sig of lib.signatures) {
      const kinds = sig.in || DEFAULT_KINDS;
      if (!kinds.includes(mod.kind)) continue;
      const m = matchSig(sig, mod);
      if (!m) continue;
      hits.push({ lib: lib.id, sig: sig.id, w: sig.w, role: sig.role || 'impl', where: 'code', moduleId: mod.id, offset: m.offset, line: lineOf(mod.source, m.offset),
        count: m.count ?? 1, snippet: snippet(mod.source, m.offset, m.length), ...(sig.note ? { note: sig.note } : {}) });
    }
  }
}

function domHits(dom, hits) {
  if (!dom) return;
  const set = (a) => new Set(Array.isArray(a) ? a : []);
  const classes = set(dom.classes), attrs = set(dom.attrs), tags = set(dom.tags), engines = Array.isArray(dom.engines) ? dom.engines : [];
  const globals = Array.isArray(dom.globals) ? new Set(dom.globals) : new Set(Object.keys(dom.globals || {}));
  const expandos = dom.expandos || {};
  const startsWith = (S, p) => { for (const v of S) if (v.startsWith(p)) return v; return null; };
  for (const lib of LIBRARIES) {
    for (const d of lib.dom || []) {
      let hit = null;
      if (d.kind === 'class' && classes.has(d.value)) hit = d.value;
      else if (d.kind === 'classPrefix') hit = startsWith(classes, d.value);
      else if (d.kind === 'attr' && attrs.has(d.value)) hit = d.value;
      else if (d.kind === 'attrPrefix') hit = startsWith(attrs, d.value);
      else if (d.kind === 'global' && globals.has(d.value)) hit = d.value;
      else if (d.kind === 'expando' && expandos[d.value] > 0) hit = `${d.value} x${expandos[d.value]}`;
      else if (d.kind === 'engine') hit = engines.find(e => String(e).includes(d.value)) || null;
      else if (d.kind === 'tag' && tags.has(d.value)) hit = d.value;
      if (hit) hits.push({ lib: lib.id, sig: d.id, w: d.w, role: 'runtime', where: 'dom', observed: hit, fires: !!d.fires });
    }
  }
}

const STATUS = (score) => (score >= THRESHOLDS.detected ? 'detected' : score >= THRESHOLDS.probable ? 'probable' : score >= THRESHOLDS.hint ? 'hint' : null);

function resolveVersions(lib, hits, modules, dom) {
  const found = new Map(); // value -> {provenance, source}
  const add = (value, rec) => { if (value && !found.has(value)) found.set(value, rec); };
  for (const h of hits) if (h.lib === lib.id && h.sig === 'cdn-url' && h.version) add(lib.cdnVersionFormat ? lib.cdnVersionFormat(h.version) : h.version, { provenance: 'declared', via: 'cdn-url', moduleId: h.moduleId });
  const modIds = new Set(hits.filter(h => h.lib === lib.id && h.where === 'code').map(h => h.moduleId));
  for (const mod of modules) {
    if (mod.kind === 'path' || (modIds.size && !modIds.has(mod.id))) continue;
    for (const v of lib.version || []) {
      if (v.needs && !mod.source.includes(v.needs)) continue;
      const m = v.re.exec(mod.source);
      if (!m) continue;
      let val = m[1] ?? m[2];
      if (v.resolve === 'semver-var') {
        const r = new RegExp(`(?:^|[\\s,;({])(?:var |let |const )?${escapeRe(val)}\\s*=\\s*[\`"'](\\d+\\.\\d+\\.\\d+)[\`"']`).exec(mod.source);
        val = r ? r[1] : null;
      } else if (v.format && val) val = v.format(val);
      add(val, { provenance: 'declared', via: v.from, moduleId: mod.id });
    }
  }
  const rt = dom?.versions?.[lib.id];
  const measured = rt !== undefined && rt !== null && rt !== '' ? (lib.runtimeVersionFormat ? lib.runtimeVersionFormat(rt) : String(rt)) : null;
  const declared = [...found.keys()];
  if (measured) return { value: measured, provenance: 'measured', source: `live global ${lib.runtimeVersion}`, ...(declared.length && !declared.includes(measured) ? { also_declared: declared, note: 'declared literal differs from the live global; the live value is reported' } : {}) };
  if (declared.length === 1) return { value: declared[0], provenance: 'declared', source: found.get(declared[0]).via, moduleId: found.get(declared[0]).moduleId };
  if (declared.length > 1) return { value: 'unknown', provenance: 'unknown', reason: `conflicting version literals: ${declared.join(', ')} (several builds in the scanned set)`, candidates: declared };
  return { value: 'unknown', provenance: 'unknown', reason: lib.versionUnknownReason || 'no version literal matched and no live global was probed', probe: lib.runtimeVersion ? `read ${lib.runtimeVersion} in the page` : null };
}

/**
 * @param {object} input
 * @param {Array<{id:string, source:string, kind?:string}>} [input.modules]  unpacked modules, chunks, bundles, html/css/json files
 * @param {string[]} [input.scriptUrls]   script URLs seen but not scanned (CDN references, blocked requests)
 * @param {object}   [input.dom]          probe.js output (live page evidence)
 * @param {object}   [input.behaviour]    recorded behaviour (see behaviour.js)
 * @param {Array}    [input.skipped]      files the loader could not read, copied into coverage
 */
export function detectLibraries(input = {}) {
  const modules = normaliseModules(input.modules || []);
  const urls = new Set([...(input.scriptUrls || []), ...(input.dom?.scripts || [])].map(String));
  for (const m of modules) if (m.kind !== 'glsl') for (const u of extractUrls(m.source)) urls.add(u);
  const urlMods = [...urls].map(u => ({ id: u, kind: 'path', source: u }));
  const hits = [];
  for (const m of [...modules, ...urlMods]) scanModule(m, hits);
  domHits(input.dom, hits);

  // score: distinct (library, evidence scope, signature id) once each
  const byLib = new Map();
  for (const h of hits) {
    if (!byLib.has(h.lib)) byLib.set(h.lib, new Map());
    const k = `${h.where}:${h.sig}`;
    const cur = byLib.get(h.lib).get(k);
    if (!cur || h.w > cur.w) byLib.get(h.lib).set(k, h);
  }
  const results = new Map();
  const mk = (lib, distinct, extra = {}) => {
    const evidence = [...distinct.values()].sort((a, b) => b.w - a.w);
    const score = evidence.reduce((a, h) => a + h.w, 0);
    return { lib, evidence, score, ...extra };
  };
  for (const [id, distinct] of byLib) results.set(id, mk(BYID.get(id), distinct));

  // behaviour: families, plus corroboration (+2) for candidates that already have other evidence
  const beh = analyseBehaviour(input.behaviour);
  for (const f of beh.families) {
    for (const cid of f.candidates) {
      const r = results.get(cid);
      if (r && r.score >= 1 && !r.evidence.some(e => e.where === 'behaviour')) {
        r.evidence.push({ lib: cid, sig: `behaviour:${f.family}`, w: 2, role: 'behaviour', where: 'behaviour', note: 'corroborates only; behaviour cannot name a library' });
        r.score += 2;
      }
    }
  }

  // plugins imply their host library
  for (const r of [...results.values()]) {
    const host = r.lib.requires;
    if (!host || r.score < THRESHOLDS.detected) continue; // only a detected plugin implies its host
    let hr = results.get(host);
    if (!hr) { hr = { lib: BYID.get(host), evidence: [], score: 0 }; results.set(host, hr); }
    if (hr.score < THRESHOLDS.probable) {
      hr.evidence.push({ lib: host, sig: `implied-by:${r.lib.id}`, w: THRESHOLDS.probable - hr.score, role: 'implied', where: 'implied', note: `${r.lib.name} cannot run without ${BYID.get(host).name}` });
      hr.score = THRESHOLDS.probable; hr.implied = true;
    }
  }

  const libraries = [];
  for (const r of results.values()) {
    const status = STATUS(r.score);
    if (!status) continue;
    const roles = new Set(r.evidence.map(e => e.role));
    const fired = r.evidence.filter(e => e.where === 'dom' && e.fires);
    const domGiven = !!input.dom;
    libraries.push({
      id: r.lib.id, name: r.lib.name, category: r.lib.category, status, score: r.score, provenance: 'inferred',
      presence: { bundled: roles.has('impl'), apiCalls: roles.has('usage'), cdnReference: roles.has('cdn'), assetOnly: roles.has('asset') && !roles.has('impl'), runtime: roles.has('runtime') },
      firing: fired.length ? { state: 'observed', provenance: 'measured', via: fired.map(e => e.observed) }
        : { state: domGiven ? 'not_observed' : 'unknown', reason: domGiven ? 'the live probe saw no run-time trace of this library in its window; absence in a window is not absence on the page' : 'code or a reference in the scanned files is not proof the library runs; no live probe was supplied' },
      version: resolveVersions(r.lib, hits, modules, input.dom),
      calibration: r.lib.calibration,
      ...(r.implied ? { implied: true } : {}),
      evidence: r.evidence.map(({ lib, ...e }) => e),
    });
  }
  libraries.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // families: behaviour-only unless a detected library already covers a candidate
  const detectedIds = new Set(libraries.filter(l => l.status !== 'hint').map(l => l.id));
  const families = beh.families.map(f => {
    const covered = f.candidates.filter(c => detectedIds.has(c));
    return { ...f, state: covered.length ? 'explained_by_signature' : 'behaviour_only', covered_by: covered };
  });

  const unknowns = [];
  for (const l of libraries) {
    if (l.firing.state !== 'observed') unknowns.push({ id: `unk_libdetect_firing_${l.id}`, about: `${l.name} is executed on the page`, reason: l.firing.reason, probe: 'run libdetect/probe.js on the page after the scenario (expandos and globals appear only once the library has run)' });
    if (l.version.value === 'unknown') unknowns.push({ id: `unk_libdetect_version_${l.id}`, about: `${l.name} version`, reason: l.version.reason, probe: l.version.probe || 'compare against the library release that matches the signature hashes' });
  }
  for (const f of families) if (f.state === 'behaviour_only') unknowns.push({ id: `unk_libdetect_family_${f.family}`, about: `which code produces the ${f.family} behaviour`, reason: f.can_not_separate, probe: 'find the module that issues the behaviour: scan more modules, or set a breakpoint on the driving rAF/wheel handler' });

  const scannedBytes = modules.reduce((a, m) => a + m.source.length, 0);
  const kinds = {}; for (const m of modules) kinds[m.kind] = (kinds[m.kind] || 0) + 1;
  const notDetected = LIBRARIES.filter(l => !libraries.some(x => x.id === l.id)).map(l => l.id);
  return {
    schema: SCHEMA, signatureSet: SIGNATURE_SET, thresholds: THRESHOLDS,
    inputs: { modules: modules.length, scriptUrls: urlMods.length, dom: !!input.dom, behaviour: !!input.behaviour },
    coverage: {
      state: modules.length || input.dom ? 'partial' : 'empty',
      note: 'Coverage is partial by construction: libraries not listed were not detected in what was scanned, which is not evidence they are absent.',
      modules: modules.length, bytes: scannedBytes, kinds,
      skipped: input.skipped || [],
      uncalibrated: libraries.filter(l => l.calibration.state !== 'calibrated').map(l => l.id),
      not_detected: notDetected,
    },
    libraries, families, behaviourNotes: beh.notes, unknowns,
  };
}

export const knownFamilies = () => Object.keys(FAMILIES);
