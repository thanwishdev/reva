// Explicit browser executables (PLAN H1). The owner's Google Chrome is never a candidate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { browsersDir } from '../util/paths.js';

const PINS = createRequire(import.meta.url)('../install/pins.json');

/** The pinned browser build (src/install/pins.json). `reva doctor --install` downloads exactly this one. */
export const PINNED_BROWSER = PINS.version;

/** Platforms REVA can install a headless shell for: 'darwin-arm64' | 'linux-x64'. */
export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;
export const SUPPORTED_PLATFORMS = Object.keys(PINS.platforms);

/** Flags added to EVERY launch, including any newly installed CfT that is not wrapped (NIGHT_PLAN hard rules). */
// REVA_NO_AUDIO_OUTPUT=1 (corpus pull, 23 Oct): pages play into Chrome's fake audio sink instead of macOS CoreAudio. Many
// sites play sound; dozens of test browsers wedged coreaudiod (owner lost audio). Media clocks still run (measured: <audio>
// and AudioContext advance; outputLatency 0.016 s fake vs 0.168 s on the owner's AirPods, so timing no longer depends on
// the owner's output device). Off by default: `reva look` is unchanged.
// GL backend (2 Nov): on a Mac the headless shell falls back to SwiftShader (software GL: 0.72 s per WebGL frame, 1,277 % CPU);
// --use-angle=metal puts WebGL on the real GPU (about 0.06 s per frame). REVA_GL=software keeps the old software path.
export const GL_ARGS = process.platform === 'darwin' && process.env.REVA_GL !== 'software' ? ['--use-angle=metal'] : [];
export const MANDATORY_ARGS = ['--use-mock-keychain', '--password-store=basic', ...GL_ARGS, ...(process.env.REVA_NO_AUDIO_OUTPUT === '1' ? ['--disable-audio-output'] : [])];

/** The Puppeteer cache, reused when it already holds the pinned build (a developer machine). */
export function puppeteerCache() { return path.join(os.homedir(), '.cache', 'puppeteer'); }

/** Path of the headless shell below a cache folder, in Puppeteer's layout: <cache>/chrome-headless-shell/<dir>-<version>/chrome-headless-shell-<zip>/chrome-headless-shell */
export function headlessShellPath(cache, { version = PINNED_BROWSER, platform = platformKey() } = {}) {
  const p = PINS.platforms[platform];
  if (!p) throw new Error(`no headless shell for ${platform} (REVA installs it for ${SUPPORTED_PLATFORMS.join(' and ')}); set REVA_BROWSER_CACHE to a Puppeteer-style cache that has one`);
  return path.join(cache, 'chrome-headless-shell', `${p.dir}-${version}`, `chrome-headless-shell-${p.zip}`, 'chrome-headless-shell');
}
const cftPath = (cache, version) => path.join(cache, 'chrome', `mac_arm-${version}`, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
const enginePath = (engine, cache, version) => (engine === 'cft' ? cftPath(cache, version) : headlessShellPath(cache, { version }));

/** Where `reva doctor --install` puts the browser: REVA_BROWSER_CACHE if set, else <data root>/browsers. */
export function installCache(env = process.env) {
  return env.REVA_BROWSER_CACHE || browsersDir(env);
}
/** Cache to launch from: the explicit one, else REVA's own when it has the engine, else the Puppeteer cache when it has it, else REVA's (so errors point at the install). */
export function browserCache(engine = 'chs', { env = process.env, version = PINNED_BROWSER } = {}) {
  const explicit = env.REVA_BROWSER_CACHE;
  if (explicit) return explicit;
  const own = browsersDir(env);
  try { if (fs.existsSync(enginePath(engine, own, version))) return own; } catch { /* unsupported platform: fall through */ }
  try { if (fs.existsSync(enginePath(engine, puppeteerCache(), version))) return puppeteerCache(); } catch { /* same */ }
  return own;
}

/**
 * The engine a command uses when the user names none. The full Chrome for Testing (cft, macOS arm64 only, ~300 MB) when it
 * is installed, which keeps a developer machine on the engine its results were measured with; otherwise the headless
 * shell (chs) that `reva doctor --install` installs. A fresh install therefore works with no --engine flag anywhere.
 */
export function defaultEngine({ version = PINNED_BROWSER, cache, env = process.env } = {}) {
  if (platformKey() !== 'darwin-arm64') return 'chs';
  try { return fs.existsSync(enginePath('cft', cache || browserCache('cft', { env, version }), version)) ? 'cft' : 'chs'; } catch { return 'chs'; }
}

/**
 * Returns {engine, version, executablePath}. engine: 'cft' (Chrome for Testing, mac-arm64 only), 'chs' (headless shell),
 * or undefined / 'auto' for defaultEngine().
 */
/** An error written for the person at the keyboard: the CLI prints its message without a stack (bin/reva.js). */
export const userError = (code, message) => Object.assign(new Error(message), { code });

export function resolveEngine(engine, { version = PINNED_BROWSER, cache, env = process.env } = {}) {
  if (engine == null || engine === 'auto') engine = defaultEngine({ version, cache, env });
  if (engine !== 'cft' && engine !== 'chs') throw userError('bad_engine', `unknown engine "${engine}" (use cft or chs)`);
  if (engine === 'cft' && platformKey() !== 'darwin-arm64') throw userError('engine_unavailable', 'the cft engine (full Chrome for Testing) is only available on macOS arm64; use the headless shell: --engine chs, or leave --engine out');
  const dir = cache || browserCache(engine, { version, env });
  const exe = enginePath(engine, dir, version);
  assertTestBrowser(exe);
  if (!fs.existsSync(exe)) {
    if (engine === 'cft') {
      // doctor --install never installs cft, so "run doctor --install" would loop; say what does work
      let chs = false; try { chs = fs.existsSync(enginePath('chs', cache || browserCache('chs', { version, env }), version)); } catch { /* unsupported platform */ }
      throw userError('browser_missing', `browser not found: ${exe}. The full Chrome for Testing engine (cft) is not installed, and reva doctor --install does not install it. ${chs ? 'The headless shell is installed: use --engine chs, or leave --engine out.' : 'Run:  reva doctor --install   (installs the headless shell, about 100 MB), then use --engine chs or leave --engine out.'}`);
    }
    throw userError('browser_missing', `browser not found: ${exe}. REVA's headless browser is not installed yet. Run:  reva doctor --install   (about 100 MB, no sudo, kept in ${dir})`);
  }
  return { engine, version, executablePath: exe };
}

/**
 * H1 guard: only Chrome for Testing / headless-shell under a puppeteer-style cache may be launched.
 * Rejects the owner's /Applications/Google Chrome.app (but not "Google Chrome for Testing.app").
 */
export function assertTestBrowser(exe) {
  const p = path.resolve(exe);
  const ownerChrome = /\/Google Chrome\.app\//.test(p) || /\/Google Chrome\.app$/.test(p);
  const isTestBuild = /Google Chrome for Testing|chrome-headless-shell/.test(p); // only the two pinned engines (H1)
  if (ownerChrome || !isTestBuild) {
    throw new Error(`H1: refusing to launch ${p}; only Chrome for Testing / chrome-headless-shell are allowed`);
  }
  return p;
}
