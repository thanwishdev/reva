#!/usr/bin/env node
// Generate time specimens.
//   node src/specimens/time/gen.js lab [--lab <labRoot>] [--out specimens/time]       the committed lab set (from lab truth)
//   node src/specimens/time/gen.js fit <fit.json> --out <dir> [--id <prefix>] [--origin site|lab] [--impl js|auto] [--ranges <json>] [--birth identity]
// Site-derived specimens (fit results of a recorded site) must go outside the repo (PLAN H2); the writer refuses otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { labSpecimenSet, specimensFromFit, writeSpecimens } from './index.js';
import { REPO_ROOT } from '../../util/paths.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const cmd = argv[0];

if (cmd === 'lab') {
  const labRoot = flag('lab', path.join(REPO_ROOT, 'fixtures', 'lab'));
  const out = path.resolve(flag('out', path.join(REPO_ROOT, 'specimens', 'time')));
  const { specs, skipped, notTime } = labSpecimenSet(labRoot);
  // stale folders from an earlier generation are removed so the set is exactly what the manifest lists
  if (fs.existsSync(out)) for (const d of fs.readdirSync(out)) if (fs.existsSync(path.join(out, d, 'spec.json'))) fs.rmSync(path.join(out, d), { recursive: true, force: true });
  writeSpecimens(specs, out);
  const manifest = { schema: 'reva.specimen.time.manifest/0', generator: 'src/specimens/time/gen.js lab', labRoot: path.basename(path.dirname(labRoot)) === 'fixtures' ? 'fixtures/lab' : labRoot,
    specimens: specs.map(({ spec }) => ({ id: spec.id, route: spec.source.route, variant: spec.source.variant, regime: spec.source.regime, tracks: spec.tracks.length, impl: [...new Set(spec.tracks.map((t) => t.impl))], kinds: [...new Set(spec.tracks.map((t) => t.motion.kind))], durationMs: spec.timeline.durationMs, digest: spec.digest })),
    skipped, notTimeBased: notTime };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  console.log(JSON.stringify({ out, specimens: specs.length, skipped: skipped.length }));
} else if (cmd === 'fit') {
  const file = argv[1]; if (!file || !flag('out')) { console.error('usage: gen.js fit <fit.json> --out <dir> [--id p] [--origin site|lab] [--impl js|auto] [--ranges json] [--birth identity]'); process.exit(2); }
  const fit = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = specimensFromFit(fit, { id: flag('id', 'fit'), origin: flag('origin', 'site'), impl: flag('impl', 'auto'), birth: flag('birth'), ranges: flag('ranges') ? JSON.parse(flag('ranges')) : undefined });
  const dirs = writeSpecimens(r.specs, path.resolve(flag('out')));
  console.log(JSON.stringify({ written: dirs.length, skipped: r.skipped.length, reasons: Object.entries(r.skipped.reduce((a, s) => ((a[s.reason] = (a[s.reason] || 0) + 1), a), {})) }));
} else { console.error('usage: gen.js lab | fit <fit.json> --out <dir>'); process.exit(2); }
