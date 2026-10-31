// What an MCP client (or a prompt-injected model behind it) may read and write. Reads: only inside the private data roots (or roots
// named in REVA_MCP_ROOTS, colon separated). Writes: only inside the output root (outside the repo, PLAN H2).
import fs from 'node:fs';
import path from 'node:path';
import { privateRoot, outRoot, isInside } from '../util/paths.js';

export class AccessError extends Error { constructor(m) { super(m); this.code = 'path_not_allowed'; } }

export function allowedRoots(env = process.env) {
  const extra = (env.REVA_MCP_ROOTS || '').split(':').filter(Boolean).map((p) => path.resolve(p));
  return [privateRoot(env), outRoot(env), ...extra];
}

/** Resolve a user-supplied path for reading. Throws AccessError outside the allowed roots. */
export function readable(p, env = process.env) {
  if (typeof p !== 'string' || !p) throw new AccessError('a path is required');
  const abs = path.resolve(p.startsWith('~/') ? path.join(process.env.HOME || '', p.slice(2)) : p);
  if (!allowedRoots(env).some((r) => isInside(abs, r))) throw new AccessError(`${abs} is outside the data roots (${allowedRoots(env).join(', ')}); set REVA_MCP_ROOTS to allow another`);
  if (!fs.existsSync(abs)) throw new AccessError(`${abs} does not exist`);
  return abs;
}

/** Resolve a path for writing: must lie inside the output root (it need not exist yet). Reads may use every data root,
 * writes may not: a model must never overwrite target configs, the corpus or other private data (verifier item 20). */
export function writable(p, env = process.env) {
  if (typeof p !== 'string' || !p) throw new AccessError('a path is required');
  const abs = path.resolve(p.startsWith('~/') ? path.join(process.env.HOME || '', p.slice(2)) : p);
  if (!isInside(abs, outRoot(env))) throw new AccessError(`${abs} is outside the output folder; output goes under ${outRoot(env)}`);
  return abs;
}
