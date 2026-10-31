// Salvage (C-PLAN-v2-CHECK §1, §6 S1): turn the HARs a killed freeze left in <archive>.work into a sealed archive,
// offline. Round-1 HARs of every class, plus the round-2 HAR of a class when its zip is intact (completion fetches).
// No live visit: the replay check runs with DNS disabled, exactly like the freeze's own check.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeConfig } from './config.js';
import { parseHarZip, sanitizeHar, mergeHars } from './sanitize.js';
import { sealVersion } from './freeze.js';
import { defaultEngine } from '../browser/engines.js';

/** Read + sanitise one HAR zip; null when it is missing or truncated (a kill mid-write). */
function readHar(file, block) {
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  try { return { buf, s: sanitizeHar(parseHarZip(buf), { block }) }; } catch (e) { return { buf: null, s: null, error: String(e.message || e).split('\n')[0].slice(0, 200) }; }
}

/** Main-document status and final URL rebuilt from the HAR (the recording log died with the process). */
function docOf(s, startUrl) {
  const es = s.har.log.entries.filter(e => e.request.method === 'GET');
  const doc = es.find(e => e.request.url === startUrl) || es.find(e => /text\/html/i.test((e.response.headers.find(h => h.name.toLowerCase() === 'content-type') || {}).value || '')) || es[0];
  let cur = doc, hops = 0; // follow redirects inside the HAR
  while (cur && cur.response.status >= 300 && cur.response.status < 400 && hops++ < 10) {
    const loc = (cur.response.headers.find(h => h.name.toLowerCase() === 'location') || {}).value;
    if (!loc) break; const next = new URL(loc, cur.request.url).href; cur = es.find(e => e.request.url === next) || null;
  }
  return { docStatus: cur ? cur.response.status : null, finalUrl: cur ? cur.request.url : null };
}

/**
 * @param {{workDir:string, outDir:string, cfg:object, engine?:string, round2?:boolean, log?:Function}} o
 * @returns {Promise<{ok:boolean, report:object, sums:object, sources:object}>}
 */
export async function salvageArchive({ workDir, outDir, cfg: rawCfg, engine = defaultEngine(), round2 = true, log = () => {} }) {
  const t0 = Date.now();
  const cfg = normalizeConfig(rawCfg);
  const block = cfg.block ? new RegExp(cfg.block) : null;
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`output directory is not empty: ${outDir}`);
  const classes = {}, raw = {}, recLogs = {}, sources = {};
  for (const cls of Object.keys(cfg.classes)) {
    const r1 = readHar(path.join(workDir, 'round1', 'raw', `${cls}.har.zip`), block) || {};
    const r1s = r1.s ? r1 : readHar(path.join(workDir, 'round1', 'san', `${cls}.har.zip`), null) || {};
    if (!r1s.s) throw new Error(`salvage: no readable round-1 HAR for class ${cls} in ${workDir}`);
    const parts = [r1s.s]; sources[cls] = { round1: r1.s ? 'raw' : 'san' };
    if (r1.buf) raw[cls] = r1.buf;
    if (round2) {
      const r2 = readHar(path.join(workDir, 'round2', 'raw', `${cls}.har.zip`), block);
      if (r2?.s) { parts.push(r2.s); sources[cls].round2 = 'raw'; if (r2.buf) raw[`${cls}-round2`] = r2.buf; }
      else if (r2) sources[cls].round2 = `unusable: ${r2.error}`;
    }
    classes[cls] = parts.length > 1 ? mergeHars(parts) : parts[0];
    const d = docOf(r1s.s, cfg.startUrl);
    recLogs[cls] = { ...d, blocked: [], pageerrors: [], wheelSteps: null, extra: [], sanitise: classes[cls].report || null };
    log(`salvage ${cls}: ${classes[cls].har.log.entries.length} entries (${JSON.stringify(sources[cls])}), doc ${d.docStatus}`);
  }
  const union = mergeHars(Object.values(classes));
  const info = { enabled: false, salvaged: { from: 'killed freeze work dir', sources }, declared: cfg.extraUrls, candidates: [], fetchResults: [], notFetched: [], unknown: [] };
  const v = await sealVersion(cfg, { dir: outDir, finalDir: outDir, version: 1, union, classes, raw, provenance: new Map(), recLogs, live: null, rounds: [{ round: 'salvage' }], completionInfo: info, engine, t0, policy: 'salvage' });
  log(`salvage sealed: completeness ${v.completeness.pct} %, ${v.completeness.renderMisses} render misses, sums ${v.sums.ok ? 'ok' : 'FAIL'}`);
  return { ok: v.ok, report: v.report, sums: v.sums, sources, completeness: v.completeness };
}
