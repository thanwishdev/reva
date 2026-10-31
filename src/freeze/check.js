// Acceptance checks for a frozen archive (PLAN M4 "DONE WHEN - freeze"):
//   checksum manifest passes, manifest agrees with the files and the HARs, every URL in a known list is in the archive
//   (code-derived URL check), and an offline replay with DNS disabled logs 0 misses and fires `load`.
import fs from 'node:fs';
import path from 'node:path';
import { verifyArchive } from '../archive.js';
import { readZip } from './zip.js';
import { parseHarZip, entryKey, sha256 } from './sanitize.js';
import { normalizeConfig } from './config.js';
import { replayVerify } from './verify.js';
import { defaultEngine } from '../browser/engines.js';

export const loadManifest = dir => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

/** Manifest vs files on disk vs union HAR. Independent of shasum on purpose: it also proves the manifest and the HAR describe the same entries. */
export function checkManifest(dir) {
  const m = loadManifest(dir), problems = [];
  for (const e of m.entries) {
    if (!e.path) continue;
    const f = path.join(dir, e.path);
    if (!fs.existsSync(f)) { problems.push(`missing file ${e.path}`); continue; }
    const b = fs.readFileSync(f);
    if (b.length !== e.bytes) problems.push(`size mismatch ${e.path}`);
    else if (sha256(b) !== e.sha256) problems.push(`sha256 mismatch ${e.path}`);
  }
  const { har, files } = parseHarZip(fs.readFileSync(path.join(dir, 'har', 'all.har.zip')));
  const harKeys = new Set(har.log.entries.map(e => entryKey(e, files)));
  if (harKeys.size !== m.entries.length) problems.push(`union HAR has ${harKeys.size} entries, manifest has ${m.entries.length}`);
  for (const e of har.log.entries) if (e.response.status <= 0) problems.push(`status ${e.response.status} entry left in the HAR: ${e.request.url}`);
  const bad = [...readZip(fs.readFileSync(path.join(dir, 'har', 'all.har.zip'))).keys()].filter(n => n !== 'har.har').filter(n => !files.has(n));
  return { ok: problems.length === 0, entries: m.entries.length, problems: problems.slice(0, 20), bad };
}

/**
 * Code-derived URL check: every URL the fixture's code can build must be an archive entry with the expected status.
 * @param {string} dir  @param {{urls:{path:string,status:number}[]}} known  @param {string} origin
 */
export function checkKnownUrls(dir, known, origin) {
  const m = loadManifest(dir);
  const by = new Map(m.entries.filter(e => e.method === 'GET').map(e => [e.url, e]));
  const missing = [], wrongStatus = [];
  for (const k of known.urls) {
    const e = by.get(origin + k.path);
    if (!e) missing.push(k.path); else if (e.status !== k.status) wrongStatus.push({ path: k.path, expected: k.status, got: e.status });
  }
  return { ok: !missing.length && !wrongStatus.length, checked: known.urls.length, missing, wrongStatus };
}

/** Templates a static pass must NOT guess: each must be in the unknowns ledger and none may have been fetched. */
export function checkUnknownLedger(dir, known) {
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'completion.json'), 'utf8'));
  const listed = c.unknown.map(u => u.template);
  const notListed = (known.templateUnknown || []).filter(t => !listed.includes(t));
  return { ok: notListed.length === 0, notListed, listed };
}

/** Full acceptance run over an existing archive directory. */
export async function checkArchive(dir, { engine = defaultEngine(), known = null, origin = null } = {}) {
  dir = path.resolve(dir);
  const cfg = normalizeConfig(JSON.parse(fs.readFileSync(path.join(dir, 'freeze-config.json'), 'utf8')));
  const sums = verifyArchive(dir);
  const manifest = checkManifest(dir);
  const replay = {};
  for (const cls of Object.keys(cfg.classes)) replay[cls] = await replayVerify(cfg, cls, [path.join(dir, 'har', 'all.har.zip'), path.join(dir, 'har', `${cls}.har.zip`)], { engine });
  const knownCheck = known ? checkKnownUrls(dir, known, origin || new URL(cfg.startUrl).origin) : null;
  const ledger = known ? checkUnknownLedger(dir, known) : null;
  const ok = sums.ok && manifest.ok && Object.values(replay).every(r => r.pass) && (!knownCheck || knownCheck.ok) && (!ledger || ledger.ok);
  return { ok, sums: { ok: sums.ok, checked: sums.results.map(r => r.checked) }, manifest, replay: Object.fromEntries(Object.entries(replay).map(([k, r]) => [k, { pass: r.pass, loadFired: r.loadFired, misses: r.misses?.length, checks: r.checks }])), knownCheck, ledger };
}
