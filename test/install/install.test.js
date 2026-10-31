import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { installHeadlessShell, installedShell, shellUrl, InstallError, PINS } from '../../src/install/install.js';
import { resolveEngine, headlessShellPath, installCache } from '../../src/browser/engines.js';
import { makeZip, fakeShellZip, pinsFor, sha256 } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-inst-'));

/** Serve `routes` ({'/path': Buffer|{status, body, cut}}) on 127.0.0.1; returns {base, close}. */
async function serve(routes) {
  const srv = http.createServer((req, res) => {
    const r = routes[req.url];
    if (!r) { res.statusCode = 404; return res.end('nope'); }
    const o = Buffer.isBuffer(r) ? { body: r } : r;
    res.statusCode = o.status || 200; res.setHeader('content-length', String(o.announce ?? o.body.length));
    if (o.cut) { res.write(o.body.subarray(0, o.cut)); setTimeout(() => res.destroy(), 10); return; }
    res.end(o.body);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }) };
}
const zipPath = (pins, plat = 'darwin-arm64') => `/${pins.version}/${pins.platforms[plat].zip}/chrome-headless-shell-${pins.platforms[plat].zip}.zip`;
const envFor = (home) => ({ REVA_HOME: path.join(home, '.reva') });

test('the shipped pins cover mac-arm64 and linux-x64, every platform has a real sha256 and size, and the real URL has the Chrome for Testing shape', () => {
  assert.deepEqual(Object.keys(PINS.platforms).sort(), ['darwin-arm64', 'linux-x64']);
  assert.equal(shellUrl('linux-x64'), `https://storage.googleapis.com/chrome-for-testing-public/${PINS.version}/linux64/chrome-headless-shell-linux64.zip`);
  assert.equal(shellUrl('darwin-arm64'), `https://storage.googleapis.com/chrome-for-testing-public/${PINS.version}/mac-arm64/chrome-headless-shell-mac-arm64.zip`);
  // a null pin ships a `doctor --install` that refuses on every machine (fill it with: node scripts/pin-browser.js --write)
  for (const [plat, p] of Object.entries(PINS.platforms)) {
    assert.match(String(p.sha256), /^[0-9a-f]{64}$/, `${plat}: sha256 must be pinned (64 hex), got ${p.sha256}`);
    assert.ok(Number.isInteger(p.bytes) && p.bytes > 1e6, `${plat}: bytes must be pinned, got ${p.bytes}`);
  }
});

test('layout: puppeteer-style path per platform, in REVA_HOME/browsers by default', () => {
  assert.match(headlessShellPath('/c', { version: '1.2.3', platform: 'darwin-arm64' }), /\/c\/chrome-headless-shell\/mac_arm-1\.2\.3\/chrome-headless-shell-mac-arm64\/chrome-headless-shell$/);
  assert.match(headlessShellPath('/c', { version: '1.2.3', platform: 'linux-x64' }), /\/c\/chrome-headless-shell\/linux-1\.2\.3\/chrome-headless-shell-linux64\/chrome-headless-shell$/);
  assert.throws(() => headlessShellPath('/c', { platform: 'win32-x64' }), /no headless shell for win32-x64/);
  const home = tmp();
  assert.equal(installCache(envFor(home)), path.join(home, '.reva', 'browsers'));
});

for (const [plat, dir, zip] of [['darwin-arm64', 'mac_arm', 'mac-arm64'], ['linux-x64', 'linux', 'linux64']]) {
  test(`installs ${plat}: checksum ok, unpacked, executable, marker written, resolveEngine finds it, nothing left behind`, async () => {
    const z = fakeShellZip(zip); const home = tmp();
    const srv = await serve({}); const pins = pinsFor(z, { platform: plat, dir, zip, urlBase: srv.base });
    const s2 = await serve({ [zipPath(pins, plat)]: z }); pins.urlBase = s2.base;
    try {
      const msgs = [];
      const r = await installHeadlessShell({ env: envFor(home), platform: plat, pins, log: m => msgs.push(m) });
      assert.equal(r.status, 'installed');
      assert.equal(r.sha256, sha256(z));
      assert.ok(r.executablePath.startsWith(path.join(home, '.reva', 'browsers', 'chrome-headless-shell', `${dir}-9.9.9.9`)));
      assert.ok(fs.statSync(r.executablePath).mode & 0o100, 'executable');
      assert.equal(installedShell({ env: envFor(home), platform: plat, pins }).marker.sha256, sha256(z));
      assert.deepEqual(fs.readdirSync(path.join(home, '.reva', 'browsers')), ['chrome-headless-shell'], 'no .install-* temp folder left');
      if (process.platform + '-' + process.arch === plat) assert.equal(resolveEngine('chs', { version: pins.version, cache: path.join(home, '.reva', 'browsers') }).executablePath, r.executablePath);
      assert.ok(msgs.some(m => /checksum ok/.test(m)));
      // second run: nothing downloaded
      let fetched = 0; const again = await installHeadlessShell({ env: envFor(home), platform: plat, pins, fetchImpl: (...a) => { fetched++; return fetch(...a); } });
      assert.equal(again.status, 'already'); assert.equal(again.verified, true); assert.equal(fetched, 0);
      // --force downloads again
      const forced = await installHeadlessShell({ env: envFor(home), platform: plat, pins, force: true });
      assert.equal(forced.status, 'installed');
    } finally { await srv.close(); await s2.close(); }
  });
}

test('wrong checksum: refused before unpacking, nothing installed, message says so', async () => {
  const z = fakeShellZip(); const home = tmp();
  const evil = fakeShellZip('mac-arm64', '#!/bin/sh\necho evil\n');
  const pins = pinsFor(z, { urlBase: 'x' }); const srv = await serve({ [zipPath(pins)]: evil }); pins.urlBase = srv.base;
  try {
    await assert.rejects(installHeadlessShell({ env: envFor(home), pins }), (e) => e instanceof InstallError && e.code === 'checksum' && /checksum mismatch/.test(e.message) && /nothing was installed/.test(e.message));
    assert.equal(fs.existsSync(path.join(home, '.reva', 'browsers', 'chrome-headless-shell')), false);
    assert.deepEqual(fs.readdirSync(path.join(home, '.reva', 'browsers')), []);
  } finally { await srv.close(); }
});

test('an unpinned platform is never installed; an unsupported platform says what is supported', async () => {
  const home = tmp();
  const unpinned = { version: '1.0.0', urlBase: 'http://127.0.0.1:1', platforms: { 'darwin-arm64': { dir: 'mac_arm', zip: 'mac-arm64', sha256: null, bytes: null } } };
  await assert.rejects(installHeadlessShell({ env: envFor(home), pins: unpinned, fetchImpl: () => { throw new Error('must not fetch'); } }), /no checksum pinned/);
  await assert.rejects(installHeadlessShell({ env: envFor(home), platform: 'win32-x64' }), (e) => e.code === 'unsupported_platform' && /darwin-arm64 and linux-x64/.test(e.message));
});

test('network problems give an actionable message and leave no files', async () => {
  const z = fakeShellZip(); const home = tmp(); const pins = pinsFor(z, { urlBase: 'x' });
  const srv = await serve({ [zipPath(pins)]: { status: 503, body: Buffer.from('busy') }, '/cut': { body: z, cut: 100, announce: z.length } });
  pins.urlBase = srv.base;
  try {
    await assert.rejects(installHeadlessShell({ env: envFor(home), pins }), (e) => e.code === 'network' && /HTTP 503/.test(e.message) && /--from/.test(e.message));
    await assert.rejects(installHeadlessShell({ env: envFor(home), pins: { ...pins, urlBase: srv.base + '/cut#' } }), (e) => e.code === 'network');
    await assert.rejects(installHeadlessShell({ env: envFor(home), pins: { ...pins, urlBase: 'http://127.0.0.1:1' } }), (e) => e.code === 'network' && /internet connection/.test(e.message));
    assert.deepEqual(fs.readdirSync(path.join(home, '.reva', 'browsers')), []);
  } finally { await srv.close(); }
});

test('--from: an already downloaded zip is installed after the same checksum test; a wrong file is refused', async () => {
  const z = fakeShellZip(); const home = tmp(); const pins = pinsFor(z, { urlBase: 'http://127.0.0.1:1' });
  const f = path.join(tmp(), 'shell.zip'); fs.writeFileSync(f, z);
  const r = await installHeadlessShell({ env: envFor(home), pins, from: f, fetchImpl: () => { throw new Error('no network expected'); } });
  assert.equal(r.status, 'installed');
  const bad = path.join(tmp(), 'bad.zip'); fs.writeFileSync(bad, makeZip([{ name: 'x', data: 'y' }]));
  await assert.rejects(installHeadlessShell({ env: envFor(tmp()), pins, from: bad }), /checksum mismatch/);
  await assert.rejects(installHeadlessShell({ env: envFor(tmp()), pins, from: '/no/such.zip' }), /not found/);
});

test('a zip with the right checksum but a hostile or wrong layout is refused', async () => {
  for (const [name, entries, re] of [
    ['traversal', [{ name: 'chrome-headless-shell-mac-arm64/../../evil', data: 'x' }], /unsafe path/],
    ['wrong root', [{ name: 'other/chrome-headless-shell', data: 'x', mode: 0o755 }], /unexpected path/],
    ['no binary', [{ name: 'chrome-headless-shell-mac-arm64/readme', data: 'x' }], /has no chrome-headless-shell/],
  ]) {
    const z = makeZip(entries); const home = tmp(); const f = path.join(tmp(), 'z.zip'); fs.writeFileSync(f, z);
    await assert.rejects(installHeadlessShell({ env: envFor(home), pins: pinsFor(z, { urlBase: 'x' }), from: f }), re, name);
    assert.equal(fs.existsSync(path.join(home, 'evil')), false);
    assert.deepEqual(fs.readdirSync(path.join(home, '.reva', 'browsers')), [], name);
  }
});

test('a browser that will not start is removed again and the reason is given', async () => {
  const z = fakeShellZip('mac-arm64', '#!/bin/sh\necho "error while loading shared libraries: libnss3.so" >&2\nexit 127\n'); const home = tmp();
  const f = path.join(tmp(), 'z.zip'); fs.writeFileSync(f, z);
  await assert.rejects(installHeadlessShell({ env: envFor(home), pins: pinsFor(z, { urlBase: 'x' }), from: f }), (e) => e.code === 'wont_start' && /did not start/.test(e.message) && /libnss3/.test(e.message));
  assert.deepEqual(fs.readdirSync(path.join(home, '.reva', 'browsers', 'chrome-headless-shell')), [], 'broken install removed');
});

test('the install target is never inside the repo, and a relative or in-repo data folder is refused with a clear message', async () => {
  const z = fakeShellZip(); const f = path.join(tmp(), 'z.zip'); fs.writeFileSync(f, z);
  await assert.rejects(installHeadlessShell({ env: { REVA_BROWSER_CACHE: path.join(process.cwd(), 'browsers') }, pins: pinsFor(z, { urlBase: 'x' }), from: f }), /PLAN H2|inside the repo/);
  await assert.rejects(installHeadlessShell({ env: { REVA_HOME: 'relative/dir' }, pins: pinsFor(z, { urlBase: 'x' }), from: f }), /relative path/);
  await assert.rejects(installHeadlessShell({ env: { REVA_HOME: path.join(process.cwd(), 'data') }, pins: pinsFor(z, { urlBase: 'x' }), from: f }), /inside the REVA source folder/);
});

test('first-time user: `reva doctor` on a clean home has no uv, a data folder check, and tells them to run --install', () => {
  const home = tmp();
  const r = spawnSync(process.execPath, [path.join(process.cwd(), 'bin/reva.js'), 'doctor', '--json'], { cwd: home, env: { ...process.env, HOME: home, REVA_HOME: '', REVA_BROWSER_CACHE: '', REVA_OUT: '' }, encoding: 'utf8' });
  const rep = JSON.parse(r.stdout);
  assert.equal(r.status, 1);
  assert.ok(!rep.checks.some(c => /\buv\b/.test(c.id)), 'no uv check');
  assert.equal(rep.checks.find(c => c.id === 'data folder').pass, true);
  assert.equal(rep.checks.find(c => c.id === 'data folder').detail.startsWith(fs.realpathSync(home) + '/.reva') || rep.checks.find(c => c.id === 'data folder').detail.startsWith(home + '/.reva'), true);
  assert.equal(rep.checks.find(c => c.id === 'chs: explicit executable').pass, false);
  assert.ok(rep.hints.some(h => /reva doctor --install/.test(h)));
  assert.equal(rep.checks.find(c => /usage file/.test(c.id)).pass, true, 'a missing usage file is not a failure for a new user');
  assert.ok(fs.existsSync(path.join(home, '.reva')), 'data folder created under HOME');
  assert.equal(fs.existsSync(path.join(home, 'out')), false, 'nothing written in the working folder');
});
