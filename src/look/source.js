// look: what to open. A live URL, a local URL (fixture), or a frozen archive (replayed offline).
// Everything after the page load is shared by every kind of source (src/look/index.js).
import fs from 'node:fs';
import path from 'node:path';
import { loadTarget } from '../replay/target.js';
import { targetsDir, privateRoot } from '../util/paths.js';

const LOCAL = /^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

function targetFromFile(file, archiveHint = null) {
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  t._file = file;
  t.archive = path.resolve(t.archive || archiveHint || path.dirname(file));
  if (!t.classes || !t.startUrl) throw new Error(`not a target config (needs startUrl and classes): ${file}`);
  return t;
}

/** The corpus run folder around an archive (…/<run>/archive), when there is one: holds motion/takes.json. */
function runDirOf(archive) {
  const up = path.dirname(archive);
  return fs.existsSync(path.join(up, 'motion', 'takes.json')) || fs.existsSync(path.join(up, 'run.json')) ? up : null;
}

/** Recording rate the archive's own corpus run used for a class (rateFor: 60 Hz when a canvas covers > 30 %). */
function corpusRate(runDir, cls) {
  if (!runDir) return null;
  try { const t = JSON.parse(fs.readFileSync(path.join(runDir, 'motion', 'takes.json'), 'utf8')).find((x) => x.cls === cls); return t && t.rate ? +t.rate : null; } catch { return null; }
}

/**
 * @param {string} input  URL | archive folder | corpus run folder | target .json | target id
 * @param {{cls?:string}} [o]
 * @returns {{kind:'url', url:string, live:boolean} | {kind:'archive', target:object, archive:string, runDir:string|null, rate:number|null}}
 */
export function resolveSource(input, { cls = 'A' } = {}) {
  const s = String(input || '').trim();
  if (!s) throw new Error('look: nothing to open (give a URL or an archive)');
  if (/^https?:\/\//i.test(s)) return { kind: 'url', url: s, live: !LOCAL.test(s) };
  if (/^file:/i.test(s)) return { kind: 'url', url: s, live: false };
  let target = null;
  const p = path.resolve(s);
  if (fs.existsSync(p)) {
    const st = fs.statSync(p);
    if (st.isFile() && p.endsWith('.json')) target = targetFromFile(p);
    else if (st.isDirectory() && fs.existsSync(path.join(p, 'target.json'))) target = targetFromFile(path.join(p, 'target.json'), p);
    else if (st.isDirectory() && fs.existsSync(path.join(p, 'archive', 'target.json'))) target = targetFromFile(path.join(p, 'archive', 'target.json'), path.join(p, 'archive'));
    else throw new Error(`look: ${p} is not an archive (no target.json in it or in its archive/ folder)`);
  } else {
    // a target id: the target folder first, then the corpus targets (corpus-<id>)
    const dirs = [targetsDir(), path.join(privateRoot(), 'corpus', 'targets')];
    for (const d of dirs) for (const id of [s, `corpus-${s}`]) { if (!target && fs.existsSync(path.join(d, `${id}.json`))) target = loadTarget(id, d); }
    if (!target) throw new Error(`look: "${s}" is not a URL, a folder or a known target id (looked in ${dirs.join(', ')})`);
  }
  if (!target.classes[cls]) throw new Error(`look: the archive has no viewport class "${cls}" (has ${Object.keys(target.classes).join(', ')})`);
  if (!fs.existsSync(target.archive)) throw new Error(`look: archive folder missing: ${target.archive}`);
  const runDir = runDirOf(target.archive);
  return { kind: 'archive', target, archive: target.archive, runDir, rate: corpusRate(runDir, cls) };
}
