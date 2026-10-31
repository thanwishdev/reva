import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assertTestBrowser, resolveEngine, MANDATORY_ARGS, installCache, puppeteerCache } from '../src/browser/engines.js';

test('H1 guard refuses the owner Chrome and unknown binaries', () => {
  assert.throws(() => assertTestBrowser('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), /H1/);
  assert.throws(() => assertTestBrowser('/usr/bin/true'), /H1/);
  assert.throws(() => assertTestBrowser('/Applications/Google Chrome.app'), /H1/);
  assert.throws(() => assertTestBrowser('/Applications/Chromium.app/Contents/MacOS/Chromium'), /H1/);
});

test('H1 guard accepts Chrome for Testing and headless-shell', () => {
  assert.doesNotThrow(() => assertTestBrowser('/x/.cache/puppeteer/chrome/mac_arm-147/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
  assert.doesNotThrow(() => assertTestBrowser('/x/.cache/puppeteer/chrome-headless-shell/mac_arm-147/chrome-headless-shell-mac-arm64/chrome-headless-shell'));
});

test('resolveEngine returns real explicit paths for both engines', () => {
  // cft (the full Chrome for Testing) exists only for macOS arm64 by design; elsewhere it must refuse with a clear code
  const onMacArm = process.platform === 'darwin' && process.arch === 'arm64';
  if (!onMacArm) assert.throws(() => resolveEngine('cft'), (e) => e.code === 'engine_unavailable');
  for (const e of onMacArm ? ['cft', 'chs'] : ['chs']) {
    const r = resolveEngine(e);
    // REVA's own browser folder (<data root>/browsers, or REVA_BROWSER_CACHE) or a Puppeteer cache that has the pinned build
    assert.ok([installCache(), puppeteerCache()].some((c) => r.executablePath.startsWith(c + path.sep)), r.executablePath);
  }
  assert.throws(() => resolveEngine('chrome'), /unknown engine/);
});

test('mandatory args include the keychain-skipping flags', () => {
  assert.deepEqual(MANDATORY_ARGS, ['--use-mock-keychain', '--password-store=basic']);
});

test('default engine: chs when only the headless shell is in the cache (what doctor --install installs); a missing cft names the fix', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { defaultEngine, headlessShellPath, PINNED_BROWSER } = await import('../src/browser/engines.js');
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-eng-'));
  try {
    const exe = headlessShellPath(cache); fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, '');
    assert.equal(defaultEngine({ cache }), 'chs');
    assert.equal(resolveEngine(undefined, { cache }).engine, 'chs');
    assert.equal(resolveEngine('auto', { cache }).executablePath, exe);
    const onMacArm = process.platform === 'darwin' && process.arch === 'arm64';
    assert.throws(() => resolveEngine('cft', { cache }), (e) => (onMacArm ? e.code === 'browser_missing' && /does not install it\. The headless shell is installed: use --engine chs/.test(e.message) : e.code === 'engine_unavailable'));
    if (onMacArm) {
      const cft = path.join(cache, 'chrome', `mac_arm-${PINNED_BROWSER}`, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      fs.mkdirSync(path.dirname(cft), { recursive: true }); fs.writeFileSync(cft, '');
      assert.equal(defaultEngine({ cache }), 'cft', 'a developer machine with cft keeps it');
    }
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-eng-'));
    assert.throws(() => resolveEngine(undefined, { cache: empty }), (e) => e.code === 'browser_missing' && /reva doctor --install/.test(e.message));
    fs.rmSync(empty, { recursive: true, force: true });
  } finally { fs.rmSync(cache, { recursive: true, force: true }); }
});
