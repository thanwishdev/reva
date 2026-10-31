// The only place a browser is launched. Rules enforced here (PLAN H1):
//  explicit CfT/CHS path, throwaway profile, --use-mock-keychain, closed in finally, profile removed.
import fs from 'node:fs';
import path from 'node:path';
import { resolveEngine, MANDATORY_ARGS } from './engines.js';
import { resolveToolkit, loadPlaywright } from './toolkit.js';
import { profilesDir, assertOutsideRepo } from '../util/paths.js';
import { procsUsingProfile, sleep } from './procs.js';

const live = new Set();
let hooked = false;
function hookExit() {
  if (hooked) return; hooked = true;
  const sweep = () => { for (const h of live) { try { fs.rmSync(h.profile, { recursive: true, force: true }); } catch {} } };
  process.on('exit', sweep);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await Promise.allSettled([...live].map(h => h.close())); process.exit(130); });
}

/**
 * @param {object} o
 * @param {'cft'|'chs'} [o.engine]
 * @param {object} [o.context]  Playwright context options (viewport, locale, reducedMotion, ...)
 * @param {string[]} [o.args]   extra Chromium args (MANDATORY_ARGS are always added)
 * @param {string} [o.toolkit]  't147' | 't155' (default: REVA_TOOLKIT or DEFAULT_TOOLKIT)
 * @param {object} [o.prefs]    profile preferences written to the throwaway profile's Default/Preferences before launch
 *                              (a pref is read by the browser itself; some command-line switches are ignored, e.g. the WebRTC one)
 * @returns {Promise<{context, page, profile, engine, executablePath, close():Promise<void>}>}
 */
export async function launchBrowser({ engine, context = {}, args = [], version, toolkit, prefs } = {}) {
  hookExit();
  const tk = resolveToolkit(toolkit);
  const eng = resolveEngine(engine, { version: version || tk.browser, cache: tk.cache || undefined });
  const pw = await loadPlaywright(tk);
  const base = profilesDir();
  assertOutsideRepo(base);
  fs.mkdirSync(base, { recursive: true });
  const profile = fs.mkdtempSync(path.join(base, 'wr-'));
  const handle = { profile, engine: eng.engine, version: eng.version, executablePath: eng.executablePath, toolkit: tk.id, playwrightVersion: pw.version, args: [...MANDATORY_ARGS, ...args], context: null, page: null };
  handle.close = async () => {
    if (!live.has(handle)) return;
    try { await handle.context?.close(); } catch (e) { console.error('close error:', e.message); }
    // Wait for the browser tree to exit; the profile folder is unique to us, so this only waits on our own processes.
    for (let i = 0; i < 40 && procsUsingProfile(profile).length; i++) await sleep(100);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    live.delete(handle);
  };
  live.add(handle);
  try {
    if (prefs) { fs.mkdirSync(path.join(profile, 'Default'), { recursive: true }); fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify(prefs)); }
    const { channel, executablePath, ...ctxOpts } = context; // a caller can never smuggle in a channel/executable
    handle.context = await pw.chromium.launchPersistentContext(profile, {
      ...ctxOpts, executablePath: eng.executablePath, headless: true, serviceWorkers: ctxOpts.serviceWorkers ?? 'block',
      args: [...MANDATORY_ARGS, ...args],
    });
    handle.page = handle.context.pages()[0] || await handle.context.newPage();
    return handle;
  } catch (e) { await handle.close(); throw e; }
}

/** Run fn(handle) and ALWAYS close the browser afterwards. */
export async function withBrowser(opts, fn) {
  const h = await launchBrowser(opts);
  try { return await fn(h); } finally { await h.close(); }
}
