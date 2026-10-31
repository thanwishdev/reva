// Which motion / scroll libraries a page uses, for look.json "libraries" (the motion card and the MCP).
//
// The detector is the research one in src/libdetect (signature table, scoring, versions, run-time traces); nothing new is
// matched here. look only supplies its input, cheaply and from what the page loaded DURING the look:
//   * the scripts the page fetched (every `script` response of the session; bodies are read after the take, capped);
//   * the page's inline scripts (text, capped);
//   * the read-only DOM probe (globals such as window.gsap / lenis, the `_gsap` expando on elements, the `lenis` classes),
//     run once after the take was written, so it cannot touch the recording.
// Everything stays `inferred` (a signature matched); a version is `declared` (a literal) or `measured` (a live global).
// "Not detected" is never "absent": scanned bytes and skipped files are listed.
import { detectLibraries } from '../libdetect/detect.js';
import { runProbe } from '../libdetect/probe.js';
import { CONTROL_CHARS } from '../report/untrusted.js';

export const LIBS_SCHEMA = 'reva.libs/0';
const CAPS = { files: 80, fileBytes: 8e6, totalBytes: 24e6, inlineScripts: 60, inlineBytes: 1.5e6, evidence: 5, bodyMs: 4000 };
const clean = (s, n) => String(s ?? '').replace(CONTROL_CHARS, ' ').trim().slice(0, n);
/** A URL without its query and hash (they can carry tokens), and capped. */
const bare = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`.slice(0, 200); } catch { return clean(u, 120); } };

/** Collect `script` responses of a page (call before the page loads). `stop()` detaches the listener. */
export function collectScripts(page) {
  const seen = [];
  const on = (res) => {
    try {
      if (res.request().resourceType() !== 'script' || seen.length >= 400) return;
      seen.push(res);
    } catch { /* closed */ }
  };
  page.on('response', on);
  return { seen, stop: () => { try { page.off('response', on); } catch { /* closed */ } } };
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref())]);

/**
 * Read the evidence while the session is still open: script bodies, inline scripts, DOM probe.
 * Never throws; whatever could not be read is listed in `skipped` / `probeError`.
 */
export async function gatherEvidence(page, collector) {
  const t0 = Date.now(); collector.stop();
  const modules = [], skipped = [], urls = new Set();
  let total = 0, files = 0;
  const unique = []; const seenUrl = new Set();
  for (const r of collector.seen) { let u; try { u = r.url(); } catch { continue; } if (/^data:/i.test(u) || seenUrl.has(u)) continue; seenUrl.add(u); unique.push(r); }
  let next = 0;
  const worker = async () => {
    for (;;) {
      const r = unique[next++]; if (!r) return;
      let u = ''; try { u = r.url(); } catch { continue; }
      urls.add(u);
      if (files >= CAPS.files) { skipped.push({ file: bare(u), reason: `more than ${CAPS.files} scripts: not read` }); continue; }
      if (total >= CAPS.totalBytes) { skipped.push({ file: bare(u), reason: `already read ${Math.round(CAPS.totalBytes / 1e6)} MB of script: not read` }); continue; }
      let status = 0; try { status = r.status(); } catch { /* */ }
      if (status && (status < 200 || status >= 300)) { skipped.push({ file: bare(u), reason: `status ${status}` }); continue; }
      try {
        const buf = await withTimeout(r.body(), CAPS.bodyMs);
        if (buf.length > CAPS.fileBytes) { skipped.push({ file: bare(u), reason: `larger than ${Math.round(CAPS.fileBytes / 1e6)} MB` }); continue; }
        files++; total += buf.length;
        modules.push({ id: u, kind: 'js', source: buf.toString('utf8') });
      } catch (e) { skipped.push({ file: bare(u), reason: clean(e && e.message, 80) || 'body not available' }); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  let inline = 0;
  try {
    const texts = await withTimeout(page.evaluate(([n, bytes]) => {
      const out = []; let total = 0;
      for (const s of document.scripts) {
        if (s.src || out.length >= n) continue;
        if (s.type && !/^(module|text\/javascript|application\/javascript|text\/babel)?$/i.test(s.type)) continue;
        const t = s.textContent || ''; if (!t.trim()) continue;
        const cut = t.slice(0, Math.max(0, bytes - total)); if (!cut) break;
        out.push(cut); total += cut.length;
      }
      return out;
    }, [CAPS.inlineScripts, CAPS.inlineBytes]), 3000);
    texts.forEach((t, i) => modules.push({ id: `inline-script-${i + 1}.js`, kind: 'js', source: t }));
    inline = texts.length;
  } catch (e) { skipped.push({ file: 'inline scripts', reason: clean(e && e.message, 80) }); }
  let dom = null, probeError = null;
  try { dom = await withTimeout(runProbe(page), 5000); } catch (e) { probeError = clean(e && e.message, 120); }
  return { modules, skipped, scriptUrls: [...urls], dom, probeError, inline, bytes: total, ms: Date.now() - t0 };
}

const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,23}$/;
const versionOf = (v) => (v && v.value && v.value !== 'unknown' && SAFE_VERSION.test(String(v.value)) ? { value: String(v.value), provenance: v.provenance, ...(v.source ? { source: clean(v.source, 40) } : {}) } : { value: null, provenance: 'unknown', ...(v && v.reason ? { reason: clean(v.reason, 120) } : {}) });

/** Run the detector on the gathered evidence; returns the look.json "libraries" block (without `mechanisms`). */
export function detectFrom(ev) {
  const t0 = Date.now();
  let res;
  try { res = detectLibraries({ modules: ev.modules, scriptUrls: ev.scriptUrls, dom: ev.dom || undefined, skipped: ev.skipped }); } catch (e) {
    return { schema: LIBS_SCHEMA, ok: false, error: clean(e && e.message, 160), label: 'inferred', list: [] };
  }
  const list = res.libraries.map((l) => ({
    id: l.id, name: l.name, category: l.category, status: l.status, label: 'inferred', implied: !!l.implied,
    version: versionOf(l.version),
    running: l.firing.state === 'observed' ? { state: 'observed', via: (l.firing.via || []).map((x) => clean(x, 40)).slice(0, 4) } : { state: l.firing.state },
    calibration: l.calibration.state,
    evidence: l.evidence.slice(0, CAPS.evidence).map((e) => ({
      signal: e.sig, where: e.where, role: e.role, weight: e.w,
      ...(e.moduleId ? { file: e.where === 'implied' ? undefined : bare(e.moduleId) } : {}), ...(e.line ? { line: e.line } : {}),
      ...(e.snippet ? { snippet: clean(e.snippet, 80) } : {}), ...(e.observed ? { observed: clean(e.observed, 60) } : {}), ...(e.note ? { note: clean(e.note, 100) } : {}),
    })),
    evidenceTotal: l.evidence.length,
  }));
  return {
    schema: LIBS_SCHEMA, ok: true, label: 'inferred', signatureSet: res.signatureSet, list,
    scanned: { scripts: ev.modules.length - ev.inline, inline: ev.inline, bytes: ev.bytes, dom: !!ev.dom, skipped: ev.skipped.slice(0, 10), ...(ev.skipped.length > 10 ? { skippedMore: ev.skipped.length - 10 } : {}), ...(ev.probeError ? { probeError: ev.probeError } : {}) },
    note: 'inferred from signatures in the scripts the page loaded and from run-time traces; a library that is not listed was not detected in what was scanned, which is not evidence that it is absent',
    ms: Date.now() - t0 + ev.ms,
  };
}

/**
 * How the fitted motion is made, counted from the look's own records: CSS transitions / animations, Web Animations,
 * script-driven motion (fitted springs, tweens, smoothing). `cssOnly` is inferred: every measured motion is declared CSS
 * and no library was detected.
 */
export function mechanismsOf({ motions = [], page = null, declaredOnly = [] }, libs) {
  const m = { css_transition: 0, css_animation: 0, web_animation: 0, view_transition: 0, script_driven: 0, unexplained: 0, page_scroll: page ? (page.lines[0] && page.lines[0].kind) || 'unknown' : null };
  for (const e of motions) {
    for (const r of e.records || []) {
      const fam = r.model && r.model.family;
      if (r.tier === 'declared' || /^declared:/.test(fam || '')) {
        const typ = r.declared && r.declared.births && r.declared.births[0] && r.declared.births[0].type;
        if (typ === 'CSSTransition') m.css_transition++; else if (typ === 'CSSAnimation') m.css_animation++;
        else if (fam === 'declared:view-transition') m.view_transition++; else if (fam === 'declared:waapi') m.web_animation++; else m.css_animation++;
      } else if (r.tier === 'unexplained' || !fam || r.tier === 'not_applicable') m.unexplained++;
      else m.script_driven++;
    }
  }
  for (const d of declaredOnly) { if (d.kind === 'css-transition') m.css_transition++; else if (d.kind === 'css-animation') m.css_animation++; else m.web_animation++; }
  const declared = m.css_transition + m.css_animation + m.web_animation + m.view_transition;
  const noLib = !!libs && libs.ok && !libs.list.some((l) => l.status !== 'hint');
  m.css_only = declared > 0 && !m.script_driven && !m.unexplained && !page && noLib ? true : declared + m.script_driven > 0 ? false : null;
  m.label = 'inferred';
  m.note = 'counts of fitted channels by how the page makes them move; css_only = every measured motion is declared in CSS / WAAPI and no library was detected';
  return m;
}

const MECH_WORDS = [['css_transition', 'CSS transition'], ['css_animation', 'CSS animation'], ['web_animation', 'Web Animation'], ['view_transition', 'View transition'], ['script_driven', 'script-driven motion']];
/** The one 'libraries:' line of the text output. */
export function librariesLine(libs, mech) {
  if (!libs) return null;
  const mw = mech ? MECH_WORDS.filter(([k]) => mech[k] > 0).map(([k, w]) => `${w}${mech[k] > 1 ? ` ×${mech[k]}` : ''}`) : [];
  const tail = mw.length ? ` · motion made by: ${mw.join(', ')}${mech.css_only ? ' (CSS only)' : ''}` : '';
  if (!libs.ok) return `libraries: not checked (${libs.error})${tail}`;
  const shown = libs.list.filter((l) => l.status !== 'hint' || libs.list.length <= 3);
  if (!shown.length) return `libraries: none detected (${libs.scanned.scripts + libs.scanned.inline} script(s) scanned; not detected is not absent)${tail}`;
  const say = (l) => `${l.name.replace(/ \(.*\)$/, '')}${l.version.value ? ` ${l.version.value}` : ''} (${l.status}${l.running.state === 'observed' ? ', running' : ''})`;
  return `libraries: ${shown.map(say).join(', ')} · inferred from signatures${tail}`;
}
