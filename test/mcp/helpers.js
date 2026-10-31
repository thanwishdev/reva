import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserCache, headlessShellPath, puppeteerCache } from '../../src/browser/engines.js';

export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'fixtures');
/**
 * A sandbox moves REVA_HOME, and with it REVA's own browser folder (<REVA_HOME>/browsers). A developer Mac still finds
 * the pinned build in the Puppeteer cache, but a fresh machine (CI, Linux) has it only where `reva doctor --install`
 * put it. So before REVA_HOME moves, point REVA_BROWSER_CACHE at that real folder. Only when the Puppeteer fallback
 * would not find the headless shell, so a Mac keeps resolving exactly as before (cft included).
 */
function keepBrowser() {
  if (process.env.REVA_BROWSER_CACHE) return;
  try {
    if (fs.existsSync(headlessShellPath(puppeteerCache()))) return;
    const c = browserCache('chs');
    if (fs.existsSync(headlessShellPath(c))) process.env.REVA_BROWSER_CACHE = c;
  } catch { /* unsupported platform: nothing to keep */ }
}
/** A private data root for one test file; REVA_OUT / REVA_HOME point at it so nothing touches the real one. */
export function sandbox(tag) {
  keepBrowser();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wr-mcp-${tag}-`)));
  process.env.REVA_HOME = root; process.env.REVA_OUT = path.join(root, 'out');
  process.env.REVA_USAGE_FILE = path.join(root, 'usage.txt'); fs.writeFileSync(process.env.REVA_USAGE_FILE, `${Math.floor(Date.now() / 1000)} 10 10\n`);
  fs.mkdirSync(process.env.REVA_OUT, { recursive: true });
  return root;
}
export const copyFix = (root, name) => { const to = path.join(root, `${name}.fit.json`); fs.copyFileSync(path.join(FIX, `${name}.fit.json`), to); return to; };
/** A minimal take folder shaped like writeTake() output (take.json only). */
export function fakeTake(root, over = {}) {
  const dir = path.join(root, 'takes', 't1'); fs.mkdirSync(dir, { recursive: true });
  const take = { schema: 'reva.take/0', scenario: 'scroll-step', target: 'lab', lane: 'hx', rate: 120, wallMs: 1000,
    env: { engine: { value: 'chs', provenance: 'declared' }, viewport: { value: { width: 1280, height: 800 }, provenance: 'measured' }, seed: { value: null, provenance: 'unknown', unknown: 'unk_seed', reason: 'not seeded', probe: 'pass a seed' } },
    unknowns: [{ id: 'unk_seed', reason: 'not seeded', probe: 'pass a seed' }], flags: [{ id: 'f1' }], escapes: { 'event-timestamp': { count: 2 } }, net: { misses: 0 }, pageErrors: [],
    coverage: { frames: 340, movingSet: 3, note: 'no mutation seen in a window means "not observed", not "static"' }, validation: { ok: true, problems: [] },
    series: { rows: { digest: 'ab'.repeat(32), n: 340, bytes: 136643, provenance: 'measured' } }, ...over };
  fs.writeFileSync(path.join(dir, 'take.json'), JSON.stringify(take)); return dir;
}
