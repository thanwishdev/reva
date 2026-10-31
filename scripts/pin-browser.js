#!/usr/bin/env node
// Maintainer tool: download the pinned headless shell for each platform and print (or --write) its SHA-256 and size for
// src/install/pins.json. Run it once per browser version bump, on a machine you trust, then review the diff.
// Before a pin is accepted, each zip is unpacked with the same reader `reva doctor --install` uses (same required root
// folder), the binary must be there, and on the host platform it must start with --version. Nothing is written unless
// every platform passes.
//   node scripts/pin-browser.js            print
//   node scripts/pin-browser.js --write    update src/install/pins.json
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellUrl, smokeTest } from '../src/install/install.js';
import { extractZip } from '../src/install/zip.js';
import { platformKey } from '../src/browser/engines.js';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'install', 'pins.json');
const pins = JSON.parse(fs.readFileSync(file, 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-pin-'));
try {
  for (const plat of Object.keys(pins.platforms)) {
    const p = pins.platforms[plat];
    const url = shellUrl(plat, pins);
    process.stderr.write(`${plat}: ${url}\n`);
    const res = await fetch(url);
    if (!res.ok) { console.error(`  HTTP ${res.status}`); process.exit(1); }
    const zipFile = path.join(work, `${plat}.zip`); const out = fs.openSync(zipFile, 'w', 0o600);
    const h = crypto.createHash('sha256'); let n = 0;
    try { for await (const c of res.body) { h.update(c); fs.writeSync(out, c); n += c.length; } } finally { fs.closeSync(out); }
    const sha256 = h.digest('hex');
    process.stderr.write(`  sha256 ${sha256}  ${n} bytes\n`);
    const root = `chrome-headless-shell-${p.zip}/`;
    const ex = path.join(work, plat);
    extractZip(zipFile, ex, { requiredRoot: root });
    const exe = path.join(ex, root, 'chrome-headless-shell');
    if (!fs.existsSync(exe)) { console.error(`  the zip has no ${root}chrome-headless-shell`); process.exit(1); }
    process.stderr.write(`  unpacked ok: ${root}chrome-headless-shell (${fs.statSync(exe).size} bytes)\n`);
    if (plat === platformKey()) {
      fs.chmodSync(exe, 0o755);
      const s = await smokeTest(exe, { platform: plat });
      if (!s.ok) { console.error(`  ${s.error}`); process.exit(1); }
      if (!s.version.includes(pins.version)) { console.error(`  --version says "${s.version}", expected ${pins.version}`); process.exit(1); }
      process.stderr.write(`  starts on this host: ${s.version}\n`);
    } else process.stderr.write(`  (not this host's platform: unpack checked, start not checked)\n`);
    p.sha256 = sha256; p.bytes = n;
  }
} finally { fs.rmSync(work, { recursive: true, force: true }); }
if (process.argv.includes('--write')) { fs.writeFileSync(file, JSON.stringify(pins, null, 2) + '\n'); process.stderr.write(`wrote ${file}\n`); }
else console.log(JSON.stringify(pins.platforms, null, 2));
