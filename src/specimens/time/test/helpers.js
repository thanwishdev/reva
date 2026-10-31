// Test helpers for the time specimens. The lab and the fitter are READ-ONLY references (independent implementations).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..', '..', '..');
const candidates = (sub) => [process.env.REVA_LAB_ROOT && path.join(process.env.REVA_LAB_ROOT, '..', '..', sub), REPO].filter(Boolean);

/** Fixture Lab root holding lab-easing/lab-springs/... (own repo copy after the merge, else the main tree). */
export function labRoot() {
  for (const c of [process.env.REVA_LAB_ROOT, path.join(REPO, 'fixtures', 'lab')]) {
    if (c && fs.existsSync(path.join(c, 'lab-springs', 'core.js')) && fs.existsSync(path.join(c, 'lab-springs', 'truth', 'm07.json'))) return c;
  }
  return null;
}
export async function labImport(group, file) { const r = labRoot(); return r ? import(pathToFileURL(path.join(r, group, file)).href) : null; }
/** The M2 fitter (simulate / eases), when present; used only as a cross-check. */
export async function fitterImport(file) {
  for (const c of candidates('')) {
    const f = path.join(c, 'src', 'analysis', 'fit', file);
    if (fs.existsSync(f)) { try { return await import(pathToFileURL(f).href); } catch { return null; } }
  }
  return null;
}
export const maxAbs = (a, b) => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0);
/** Frame lists: regular rates and a stalled one (100 ms every 30 frames, like regime R5). */
export function frames(kind, n) {
  const out = []; let T = 0;
  for (let k = 0; k < n; k++) {
    if (kind === 'stall') T += k && k % 30 === 0 ? 100 : 1000 / 60; else T += kind === 'r120' ? 1000 / 120 : kind === 'r60' ? 1000 / 60 : 1000 / 30;
    out.push(Math.round(T * 1e6) / 1e6);
  }
  return out;
}
