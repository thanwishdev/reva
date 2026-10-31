#!/usr/bin/env node
// node src/specimens/scroll/build-lab.js [labRoot] [outDir]
// Regenerates specimens/scroll/ from the Fixture Lab truth records (read-only). Deterministic: running it twice is a no-op.
import path from 'node:path';
import { buildLabSpecimens, DEFAULT_LAB_ROOT } from './lab.js';
import { REPO_ROOT } from '../../util/paths.js';

const labRoot = process.argv[2] || process.env.REVA_LAB_ROOT || DEFAULT_LAB_ROOT;
const outDir = process.argv[3] || path.join(REPO_ROOT, 'specimens', 'scroll');
const manifest = buildLabSpecimens(labRoot, outDir);
for (const m of manifest) console.log(`${m.id}: ${m.kinds.join('+')}, ${m.channels} channel(s), ${m.skipped} skipped, ${m.unknowns} unknown, ${m.assumptions} assumption(s)`);
console.log(`wrote ${manifest.length} specimens to ${outDir}`);
