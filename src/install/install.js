// `reva doctor --install`: put the pinned headless shell into REVA's own cache. No sudo, nothing outside the cache folder.
// The download is hashed while it streams and compared with the SHA-256 pinned in pins.json BEFORE anything is unpacked;
// a wrong hash, a missing pin, an unsupported platform or a full disk stops with a message that says what to do next.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installCache, headlessShellPath, platformKey, SUPPORTED_PLATFORMS } from '../browser/engines.js';
import { ensureDataRoot, assertOutsideRepo } from '../util/paths.js';
import { extractZip } from './zip.js';

const execFileP = promisify(execFile);
export const PINS = createRequire(import.meta.url)('./pins.json');

export class InstallError extends Error { constructor(code, m) { super(m); this.code = code; } }

const MIN_FREE = 1.5 * 1024 ** 3;       // zip + unpacked copy + headroom
const MAX_DOWNLOAD = 600 * 1024 ** 2;   // the real zip is far smaller; a bigger stream is not what was pinned
const MARKER = '.reva-install.json';

export const shellUrl = (platform = platformKey(), pins = PINS) => {
  const p = pins.platforms[platform];
  return `${pins.urlBase}/${pins.version}/${p.zip}/chrome-headless-shell-${p.zip}.zip`;
};

/** What is installed for this platform right now: { installed, executablePath, marker } (marker is the record written at install time). */
export function installedShell({ env = process.env, platform = platformKey(), pins = PINS } = {}) {
  const exe = headlessShellPath(installCache(env), { version: pins.version, platform });
  let marker = null; try { marker = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(exe)), MARKER), 'utf8')); } catch { /* no record */ }
  return { installed: fs.existsSync(exe), executablePath: exe, marker };
}

async function download(url, file, { fetchImpl, expectBytes, log }) {
  let res;
  try { res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) }); } catch (e) {
    const why = e && (e.cause?.code || e.cause?.message || e.message);
    throw new InstallError('network', `could not download ${url} (${why}). Check your internet connection. Node does not read HTTP_PROXY, so behind a proxy download the file in a browser and run: reva doctor --install --from <file.zip>`);
  }
  if (!res.ok) throw new InstallError('network', `download failed: HTTP ${res.status} from ${url}. Try again later, or download the file in a browser and run: reva doctor --install --from <file.zip>`);
  const total = Number(res.headers.get('content-length')) || expectBytes || 0;
  if (total > MAX_DOWNLOAD) throw new InstallError('too_big', `the server announced ${total} bytes, more than the ${MAX_DOWNLOAD} this pin allows; refusing`);
  const hash = crypto.createHash('sha256'); const out = fs.openSync(file, 'w', 0o600);
  let got = 0; let lastPct = -10;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (got > MAX_DOWNLOAD) throw new InstallError('too_big', `the download passed ${MAX_DOWNLOAD} bytes; refusing`);
      hash.update(chunk); fs.writeSync(out, chunk);
      if (total) { const pct = Math.floor((got / total) * 100); if (pct >= lastPct + 10) { lastPct = pct; log(`  downloading ${pct}% (${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB)`); } }
    }
  } catch (e) {
    if (e instanceof InstallError) throw e;
    throw new InstallError('network', `the download was interrupted after ${got} bytes (${e && e.message}). Run the command again.`);
  } finally { fs.closeSync(out); }
  return { sha256: hash.digest('hex'), bytes: got };
}

function sha256File(file) {
  const h = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** Start the installed binary with --version. On Linux a failure lists the shared libraries the loader could not find. */
export async function smokeTest(exe, { platform = platformKey() } = {}) {
  try {
    const { stdout } = await execFileP(exe, ['--version'], { timeout: 30000 });
    return { ok: true, version: stdout.trim() };
  } catch (e) {
    let missing = [];
    if (platform.startsWith('linux')) {
      try { const { stdout } = await execFileP('ldd', [exe], { timeout: 10000 }); missing = stdout.split('\n').filter(l => /not found/.test(l)).map(l => l.trim().split(' ')[0]); } catch { /* no ldd */ }
    }
    const lib = missing.length ? ` Missing system libraries: ${missing.join(', ')}. Install them with your package manager (on Debian/Ubuntu: apt-get install libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2).` : '';
    return { ok: false, error: `${path.basename(exe)} did not start: ${(e.stderr || e.message || '').toString().split('\n')[0]}.${lib}` };
  }
}

/**
 * Install the pinned headless shell for this platform.
 * @param {object} o
 * @param {string} [o.from]        path of an already downloaded zip (still checked against the pin)
 * @param {boolean} [o.force]      reinstall even when it is already there
 * @param {Function} [o.fetchImpl] test seam
 * @param {object} [o.pins]        test seam (same shape as pins.json)
 * @returns {Promise<{status:'installed'|'already', executablePath, version, platform, sha256, bytes, cache}>}
 */
export async function installHeadlessShell({ env = process.env, platform = platformKey(), pins = PINS, from, force = false, fetchImpl = globalThis.fetch, log = () => {}, smoke = smokeTest } = {}) {
  const p = pins.platforms[platform];
  if (!p) throw new InstallError('unsupported_platform', `REVA installs its browser for ${SUPPORTED_PLATFORMS.join(' and ')}, not ${platform}. On another system set REVA_BROWSER_CACHE to a Puppeteer-style cache that already has chrome-headless-shell ${pins.version}.`);
  if (!p.sha256) throw new InstallError('unpinned', `this REVA build has no checksum pinned for ${platform}, so it will not install an unverified browser. This is a packaging problem, not something you did: please report it.`);
  const cache = path.resolve(installCache(env));
  assertOutsideRepo(cache);
  ensureDataRoot(env);
  const exe = headlessShellPath(cache, { version: pins.version, platform });
  const verDir = path.dirname(path.dirname(exe));
  const have = installedShell({ env, platform, pins });
  if (have.installed && !force && (!have.marker || have.marker.sha256 === p.sha256)) {
    // No marker = put there by something else (a Puppeteer cache): used as is, but not checked by REVA.
    return { status: 'already', verified: !!have.marker, executablePath: exe, version: pins.version, platform, sha256: have.marker ? p.sha256 : null, bytes: have.marker?.bytes ?? null, cache };
  }
  try { fs.mkdirSync(cache, { recursive: true, mode: 0o700 }); } catch (e) { throw new InstallError('no_write', `cannot create ${cache}: ${e.message}. Set REVA_HOME to a folder you can write to.`); }
  try { const s = fs.statfsSync(cache); if (s.bavail * s.bsize < MIN_FREE) throw new InstallError('disk_full', `only ${((s.bavail * s.bsize) / 1e9).toFixed(1)} GB free in ${cache}; the install needs about ${(MIN_FREE / 1e9).toFixed(1)} GB. Free some space or set REVA_HOME to a bigger disk.`); } catch (e) { if (e instanceof InstallError) throw e; }

  const tmp = fs.mkdtempSync(path.join(cache, '.install-'));
  try {
    const zipFile = path.join(tmp, 'shell.zip');
    let got;
    if (from) {
      if (!fs.existsSync(from)) throw new InstallError('no_file', `--from file not found: ${from}`);
      fs.copyFileSync(from, zipFile);
      got = { sha256: sha256File(zipFile), bytes: fs.statSync(zipFile).size };
    } else {
      const url = shellUrl(platform, pins);
      log(`downloading chrome-headless-shell ${pins.version} (${platform})\n  from ${url}`);
      got = await download(url, zipFile, { fetchImpl, expectBytes: p.bytes, log });
    }
    if (got.sha256 !== p.sha256) throw new InstallError('checksum', `checksum mismatch: expected ${p.sha256}, got ${got.sha256}. The file was deleted and nothing was installed. Run the command again; if it keeps failing the download is being altered or this REVA build is out of date.`);
    log(`checksum ok (sha256 ${got.sha256.slice(0, 16)}…), unpacking`);
    const root = `chrome-headless-shell-${p.zip}/`;
    const ex = path.join(tmp, 'x');
    try { extractZip(zipFile, ex, { requiredRoot: root }); } catch (e) { throw new InstallError('bad_zip', `the downloaded file passed the checksum but could not be unpacked: ${e.message}`); }
    const unpacked = path.join(ex, root, 'chrome-headless-shell');
    if (!fs.existsSync(unpacked)) throw new InstallError('bad_zip', `the archive has no ${root}chrome-headless-shell`);
    fs.chmodSync(unpacked, 0o755);
    fs.writeFileSync(path.join(ex, MARKER), JSON.stringify({ version: pins.version, platform, sha256: got.sha256, bytes: got.bytes, installedAt: new Date().toISOString() }, null, 2));
    fs.mkdirSync(path.dirname(verDir), { recursive: true });
    fs.rmSync(verDir, { recursive: true, force: true });
    fs.renameSync(ex, verDir);
    const s = await smoke(exe, { platform });
    if (!s.ok) { fs.rmSync(verDir, { recursive: true, force: true }); throw new InstallError('wont_start', s.error); }
    log(`installed ${s.version || pins.version}`);
    return { status: 'installed', executablePath: exe, version: pins.version, platform, sha256: got.sha256, bytes: got.bytes, cache };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
