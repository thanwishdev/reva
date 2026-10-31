// Where the verify loop finds the code it drives: the recorder (both sides MUST use the same one) and the Fixture Lab
// (source pages + group adapters). Both default to this repository. Before build/m3 is merged with M2 the lab and the
// M2 recorder extensions (30 Hz / stall, frame time on every input-log entry, page-observed pointer/click events) live
// only in the main tree; REVA_RECORDER_ROOT / REVA_LAB_REPO point there READ-ONLY (modules are imported,
// nothing is written). Every verify record carries the recorder root and a digest of its source files (provenance).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const has = (root, ...rel) => rel.every((r) => fs.existsSync(path.join(root, r)));

/** Repository root holding src/record/ for the recorder used on BOTH sides. */
export function recorderRoot() {
  const r = process.env.REVA_RECORDER_ROOT ? path.resolve(process.env.REVA_RECORDER_ROOT) : REPO;
  if (!has(r, 'src/record/session.js', 'src/record/scenario.js')) throw new Error(`no recorder under ${r} (src/record/session.js)`);
  return r;
}

/** Repository root holding the Fixture Lab (fixtures/lab/<group>/lab.mjs + src/lab/server.js), or null. */
export function labRepo() {
  const cands = [process.env.REVA_LAB_REPO, REPO].filter(Boolean).map((p) => path.resolve(p));
  for (const c of cands) if (has(c, 'src/lab/server.js', 'fixtures/lab/lab-springs/lab.mjs', 'fixtures/lab/lab-easing/lab.mjs', 'fixtures/lab/lab-scroll/lab.mjs')) return c;
  return null;
}

const imp = (root, rel) => import(pathToFileURL(path.join(root, rel)).href);

/** Digest of the recorder's own source files: two records are "same recorder" only when this matches. */
export function recorderDigest(root = recorderRoot()) {
  const dir = path.join(root, 'src', 'record');
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex').slice(0, 16);
}

let cached = null;
/** {openSession, runActions, writeTake, root, digest} of the recorder in use. */
export async function recorder() {
  const root = recorderRoot();
  if (cached && cached.root === root) return cached;
  const [{ openSession }, { runActions }, { writeTake }] = await Promise.all([imp(root, 'src/record/session.js'), imp(root, 'src/record/scenario.js'), imp(root, 'src/record/take.js')]);
  cached = { openSession, runActions, writeTake, root, digest: recorderDigest(root) };
  return cached;
}

/** Lab group adapter (reva.labgroup/0) and the blind lab server of the lab repo. */
export async function labAdapter(group) {
  const r = labRepo(); if (!r) throw new Error('Fixture Lab not found (set REVA_LAB_REPO to a tree with fixtures/lab and src/lab)');
  return imp(r, path.join('fixtures', 'lab', group, 'lab.mjs'));
}
export async function serveLab() {
  const r = labRepo(); if (!r) throw new Error('Fixture Lab not found');
  const { serveLab: serve } = await imp(r, 'src/lab/server.js');
  return serve({ root: path.join(r, 'fixtures', 'lab') });
}
