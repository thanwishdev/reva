#!/usr/bin/env node
// Release gate (npm prepublishOnly): publish only from a public tree. A checkout with private extensions (src/ext, loaded
// by src/cli.js when present) also holds private command groups; publishing it would ship them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(root, 'src', 'ext'))) {
  console.error('this checkout has private extensions (src/ext): publish from the public mirror, not from here');
  process.exit(1);
}
console.error('public tree ok: no private extensions');
