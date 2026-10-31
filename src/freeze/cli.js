// `reva freeze ...` (wire into src/cli.js with: case 'freeze': return freezeMain(argv.slice(1))).
import fs from 'node:fs';
import path from 'node:path';
import { outRoot, assertOutsideRepo } from '../util/paths.js';
import { loadConfig } from './config.js';
import { freeze } from './freeze.js';
import { checkArchive } from './check.js';
import { freezeSection } from './report.js';
import { parseHarZip, sanitizeHar, packHarZip } from './sanitize.js';
import { analyseCompletion } from './complete.js';
import { loadManifest } from './check.js';
import { defaultEngine } from '../browser/engines.js';

export const FREEZE_HELP = `reva freeze <command>

  run --config <file.json> [--out <dir>] [--engine cft|chs] [--rounds N] [--no-completion] [--no-miss-driven] [--allow-live]
                       record every viewport class, sanitise, derive URLs from code, replay offline, write a sealed archive.
                       A live (non-local) site needs --allow-live and permission to record it; the default refuses.
  check <archiveDir> [--known <known-urls.json>] [--engine cft|chs]
                       acceptance: shasum -c, manifest vs files vs HAR, known-URL list, offline replay with 0 misses
  report <archiveDir> [--json]   the freeze section of report v2 (markdown, or the JSON section)
  sanitize <in.har.zip> <out.har.zip> [--block <regex>]   run the sanitiser alone
  complete <archiveDir>          offline code analysis of an archive: derived URLs and the unknowns ledger
`;

function flags(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2), n = argv[i + 1]; if (n === undefined || n.startsWith('--')) f[k] = true; else { f[k] = n; i++; } } else f._.push(a);
  }
  return f;
}

export async function freezeMain(argv) {
  const f = flags(argv);
  const [cmd, a1, a2] = f._;
  switch (cmd) {
    case 'run': {
      if (!f.config) { console.error(FREEZE_HELP); return 2; }
      const cfg = loadConfig(f.config);
      const out = f.out || path.join(outRoot(), 'freeze', cfg.id, new Date().toISOString().replace(/[:.]/g, '-'));
      assertOutsideRepo(path.resolve(out));
      const r = await freeze(cfg, { outDir: out, engine: f.engine || defaultEngine(), maxRounds: Number(f.rounds || 3), completion: !f['no-completion'], missDriven: !f['no-miss-driven'], allowLive: !!f['allow-live'], log: m => console.error(m) });
      console.log(JSON.stringify({ ok: r.ok, outDir: r.outDir, converged: r.report.converged, rounds: r.report.rounds.length, replay: Object.fromEntries(Object.entries(r.report.finalReplay).map(([k, v]) => [k, { pass: v.pass, misses: v.misses.length }])), unknowns: r.report.completion.unknown.length, checksums: r.sums.ok, wallSeconds: r.report.wallSeconds }, null, 1));
      return r.ok ? 0 : 1;
    }
    case 'check': {
      if (!a1) { console.error(FREEZE_HELP); return 2; }
      const known = f.known ? JSON.parse(fs.readFileSync(f.known, 'utf8')) : null;
      const r = await checkArchive(a1, { engine: f.engine || defaultEngine(), known });
      console.log(JSON.stringify(r, null, 1));
      return r.ok ? 0 : 1;
    }
    case 'report': {
      if (!a1) { console.error(FREEZE_HELP); return 2; }
      const s = freezeSection(a1);
      console.log(f.json ? JSON.stringify(s, null, 1) : s.markdown);
      return 0;
    }
    case 'sanitize': {
      if (!a1 || !a2) { console.error(FREEZE_HELP); return 2; }
      assertOutsideRepo(path.resolve(a2));
      const s = sanitizeHar(parseHarZip(fs.readFileSync(a1)), { block: f.block ? new RegExp(f.block) : null });
      fs.writeFileSync(a2, packHarZip(s));
      console.log(JSON.stringify(s.report, null, 1));
      return s.report.problems.length ? 1 : 0;
    }
    case 'complete': {
      if (!a1) { console.error(FREEZE_HELP); return 2; }
      const dir = path.resolve(a1), m = loadManifest(dir);
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'freeze-config.json'), 'utf8'));
      const files = m.entries.filter(e => e.status === 200 && e.method === 'GET' && e.path).map(e => ({ url: e.url, contentType: e.contentType, text: fs.readFileSync(path.join(dir, e.path), 'utf8') }));
      const r = analyseCompletion({ files, documentOrigin: new URL(cfg.startUrl).origin, have: new Set(m.entries.map(e => e.url)), block: cfg.block ? new RegExp(cfg.block) : null, domains: cfg.domains });
      console.log(JSON.stringify(r, null, 1));
      return 0;
    }
    default:
      console.log(FREEZE_HELP); return cmd ? 2 : 0;
  }
}
