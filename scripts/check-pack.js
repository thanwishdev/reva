#!/usr/bin/env node
// Release gate (npm prepublishOnly): the npm package holds exactly the code the published commands load, no more, no less.
// It traces the module graph from bin/reva.js (static imports, `export ... from`, import('literal'),
// new URL('literal.js', import.meta.url)) and compares it with what `npm pack` would ship:
//   - missing: a module the published `reva` can load that the package leaves out (it would fail at run time);
//   - extra:   a module in the package that no published command loads (research code: recorder scenarios, the offline
//              archiver in src/freeze, the fixture lab, scorer, verify loop, specimen builders, corpus, skill).
// Edges that only research checkouts take are skipped, listed below with the reason.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = 'bin/reva.js';

/** Files whose dynamic imports are not followed: they run only on the internal tool surface (`--surface all`), which a build
 * without src/ext never serves (src/mcp/cli.js lists and runs the public tools only). Their static imports are followed. */
export const INTERNAL_ONLY_DYNAMIC = new Set(['src/mcp/contract.js']);
/** Modules loaded only when present (src/cli.js checks fs.existsSync first). */
export const OPTIONAL = new Set(['src/ext/index.js']);
/** Non-JS files read at run time (not visible to the import trace). */
export const ASSETS = ['src/card/page/template.html', 'src/card/page/moves.html', 'src/demo/page/index.html', 'src/install/pins.json'];

const SPEC_RES = [
  /(?:^|[\s;}])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/gm,
  /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/gm,
];
const DYN_RES = [
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  /new URL\(\s*['"]([^'"]+\.m?js)['"]\s*,\s*import\.meta\.url\s*\)/g,
];

/** Repo-relative paths of every module the published entry can load. */
export function traceModules(root = ROOT, entry = ENTRY) {
  const seen = new Set();
  const absent = [];
  const queue = [entry];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel) || OPTIONAL.has(rel)) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) { absent.push(rel); continue; }
    seen.add(rel);
    const src = fs.readFileSync(abs, 'utf8');
    const specs = new Set();
    for (const re of SPEC_RES) for (const m of src.matchAll(re)) specs.add(m[1]);
    if (!INTERNAL_ONLY_DYNAMIC.has(rel)) for (const re of DYN_RES) for (const m of src.matchAll(re)) specs.add(m[1]);
    for (const s of specs) {
      if (!s.startsWith('.')) continue; // node: builtins and dependencies
      queue.push(path.relative(root, path.resolve(path.dirname(abs), s)).split(path.sep).join('/'));
    }
  }
  return { modules: [...seen].sort(), absent };
}

/** Paths `npm pack` would put in the package. */
export function packedFiles(root = ROOT) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const j = JSON.parse(out)[0];
  return { files: j.files.map((f) => f.path), size: j.size, unpackedSize: j.unpackedSize };
}

export function checkPack({ root = ROOT, files } = {}) {
  const packed = new Set(files || packedFiles(root).files);
  const { modules, absent } = traceModules(root);
  const missing = [...modules.filter((m) => !packed.has(m)), ...ASSETS.filter((a) => !packed.has(a)), ...absent];
  const traced = new Set(modules);
  const extra = [...packed].filter((f) => /\.m?js$/.test(f) && !traced.has(f)).sort();
  return { ok: !missing.length && !extra.length, missing, extra, modules: modules.length, files: packed.size };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = checkPack();
  if (r.missing.length) console.error(`the package leaves out modules the published reva loads:\n  ${r.missing.join('\n  ')}`);
  if (r.extra.length) console.error(`the package ships modules no published command loads (add them to the "files" negations in package.json):\n  ${r.extra.join('\n  ')}`);
  if (!r.ok) process.exit(1);
  console.error(`package ok: ${r.files} files, ${r.modules} modules, all loaded by the published commands`);
}
