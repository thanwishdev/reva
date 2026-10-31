#!/usr/bin/env node
// Release gate (npm prepublishOnly): refuse to publish while any platform in src/install/pins.json has no sha256,
// because `reva doctor --install` would then refuse to install the browser on that platform for every user.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'install', 'pins.json');
const pins = JSON.parse(fs.readFileSync(file, 'utf8'));
const bad = Object.entries(pins.platforms).filter(([, p]) => !/^[0-9a-f]{64}$/.test(String(p.sha256)) || !(p.bytes > 0));
if (bad.length) {
  console.error(`pins.json: no sha256/bytes for ${bad.map(([k]) => k).join(', ')}. Run: node scripts/pin-browser.js --write, review the diff, commit.`);
  process.exit(1);
}
console.error(`pins.json ok: ${Object.keys(pins.platforms).join(', ')} pinned for ${pins.version}`);
