#!/usr/bin/env node
// Standalone CLI (integrator wires it as `reva libdetect` later; src/cli.js is a shared file):
//   node src/libdetect/cli.js <file|dir> [...] [--json] [--out <file>] [--behaviour <json>] [--dom <json>]
// Input directories hold unpacked modules, chunks, html/css/json, or source maps (expanded when they carry sourcesContent).
// Site-derived input must stay outside the repo and so must --out (PLAN H2); the tool refuses an --out inside the repo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModules } from './modules.js';
import { detectLibraries } from './detect.js';
import { librariesSection } from './section.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const inputs = []; let json = false, out = null, behaviourFile = null, domFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--out') out = argv[++i];
    else if (a === '--behaviour') behaviourFile = argv[++i];
    else if (a === '--dom') domFile = argv[++i];
    else if (a.startsWith('--')) { io.err(`unknown option ${a}\n`); return 2; }
    else inputs.push(a);
  }
  if (!inputs.length && !domFile && !behaviourFile) { io.err('usage: libdetect <file|dir> [...] [--json] [--out file] [--dom probe.json] [--behaviour b.json]\n'); return 2; }
  if (out) {
    const abs = path.resolve(out);
    if (abs === REPO || abs.startsWith(REPO + path.sep)) { io.err(`refusing to write inside the repo (${abs}): site-derived output belongs outside the repo, for example under ~/.reva (PLAN H2)\n`); return 2; }
  }
  const { modules, skipped } = loadModules(inputs);
  const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const result = detectLibraries({ modules, skipped, dom: domFile ? readJson(domFile) : undefined, behaviour: behaviourFile ? readJson(behaviourFile) : undefined });
  const section = librariesSection(result);
  const text = json ? JSON.stringify({ result, section: { ...section, markdown: undefined } }, null, 2) + '\n' : section.markdown;
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, text); io.out(`wrote ${out}\n`); } else io.out(text);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
