// Path settings. Site-derived material lives under the private root, never inside the repo (PLAN H2).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export class DataRootError extends Error { constructor(m) { super(m); this.code = 'bad_data_root'; } }

const expandHome = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

/**
 * REVA's data root: recordings, analyses, browser downloads, throwaway profiles. Default `~/.reva`; set REVA_HOME to move it. It must be an absolute path (or start with ~/), and it may never be inside the repo or inside the
 * directory the command was started in, so an analysis of a site cannot end up in a project folder or a git checkout by accident.
 */
export function dataRoot(env = process.env, { cwd = process.cwd(), repoRoot = REPO_ROOT } = {}) {
  const configured = env.REVA_HOME;
  if (!configured) return path.join(os.homedir(), '.reva');
  const name = 'REVA_HOME';
  const raw = expandHome(String(configured));
  if (!path.isAbsolute(raw)) throw new DataRootError(`${name}="${configured}" is a relative path; use an absolute path (or one starting with ~/) so the data folder does not depend on where you run the command`);
  const abs = path.resolve(raw);
  if (isInside(abs, repoRoot)) throw new DataRootError(`${name}=${abs} is inside the REVA source folder (${repoRoot}); site data must stay outside it. Pick a folder elsewhere, for example ~/.reva`);
  if (isInside(abs, cwd) && !isInside(os.homedir(), cwd)) throw new DataRootError(`${name}=${abs} is inside the current folder (${cwd}); site data must not land in a project folder. Pick a folder elsewhere, for example ~/.reva`);
  return abs;
}
/** Create the data root (owner-only permissions: it holds recordings of sites). */
export function ensureDataRoot(env = process.env) {
  const dir = dataRoot(env);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { throw new DataRootError(`cannot create REVA's data folder ${dir}: ${e.message}. Set REVA_HOME to a folder you can write to`); }
  return dir;
}
/** Same folder as dataRoot (the name from before the data root became ~/.reva). */
export function privateRoot(env = process.env) {
  return dataRoot(env);
}
/** REVA's own browser downloads (reva doctor --install). */
export function browsersDir(env = process.env) {
  return path.join(dataRoot(env), 'browsers');
}
/** Where takes, boot reports, doctor reports and logs go. Always outside the repo. */
export function outRoot(env = process.env) {
  return path.resolve(env.REVA_OUT || path.join(privateRoot(env), 'out'));
}
/** Target configs (viewports, block list, seed, archive path) are site-derived: private storage only. */
export function targetsDir(env = process.env) {
  return path.resolve(env.REVA_TARGETS || path.join(privateRoot(env), 'targets'));
}
/** Throwaway browser profiles. A dedicated folder keeps leftover detection unambiguous. */
export function profilesDir(env = process.env) {
  return path.join(privateRoot(env), 'profiles');
}
export function usageFile(env = process.env) {
  return env.REVA_USAGE_FILE || path.join(dataRoot(env), 'usage.txt');
}

/** True when `child` is `parent` or lies below it (after resolving symlinks where they exist). */
export function isInside(child, parent) {
  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const rel = path.relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Throw if `dir` is inside the repo: H2 says site-derived output never lands there. */
export function assertOutsideRepo(dir, repoRoot = REPO_ROOT) {
  if (isInside(dir, repoRoot)) {
    throw new Error(`refusing to write inside the repo (PLAN H2): ${dir} is under ${repoRoot}; set REVA_HOME (or REVA_OUT) to a path outside it`);
  }
  return dir;
}

export function ensureOutDir(...parts) {
  return ensureOutDirIn(process.env, ...parts);
}
/** ensureOutDir for a given environment (the MCP server passes its own env): data root created owner-only first. */
export function ensureOutDirIn(env, ...parts) {
  ensureDataRoot(env);
  const dir = path.join(outRoot(env), ...parts);
  assertOutsideRepo(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
