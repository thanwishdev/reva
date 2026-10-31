// Browser half of the public-command checks: (1) a fresh user who has only what `reva doctor --install` installs (the
// headless shell, in a clean REVA_HOME and HOME) can run `reva look` with no --engine flag; (2) the safety gate's cookie
// banner reject is clicked in the real page during a look. Own loopback servers and fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserCache, headlessShellPath } from '../../src/browser/engines.js';
import { runLook } from '../../src/look/index.js';
import { serveFixture } from '../helpers.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const chsDir = (() => { try { const c = browserCache('chs'); return fs.existsSync(headlessShellPath(c)) ? path.join(c, 'chrome-headless-shell') : null; } catch { return null; } })();

/** A clean HOME + REVA_HOME whose browsers folder has only the headless shell (a symlink to this machine's copy). */
function freshUser() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reva-fresh-')));
  const reva = path.join(home, '.reva');
  fs.mkdirSync(path.join(reva, 'browsers'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(chsDir, path.join(reva, 'browsers', 'chrome-headless-shell'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^REVA_/.test(k)));
  return { home, env: { ...env, HOME: home, REVA_HOME: reva } };
}
function cli(args, env, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(REPO, 'bin', 'reva.js'), ...args], { env, cwd: env.HOME });
    let out = ''; let err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

test('a fresh user with only the installed headless shell: look works with no --engine; --engine cft says what to do, no stack', { skip: !chsDir && 'no headless shell on this machine' }, async () => {
  const u = freshUser(); const srv = await serveFixture('look');
  try {
    const r = await cli(['look', `${srv.origin}/index.html`, '--json'], u.env);
    assert.equal(r.code, 0, r.err.slice(-800));
    const j = JSON.parse(r.out);
    assert.equal(j.ok, true); assert.equal(j.status, 'motion');
    const take = JSON.parse(fs.readFileSync(path.join(j.take.dir, 'take.json'), 'utf8'));
    assert.equal(take.env.engine.value, 'chs', JSON.stringify(take.env.engine));
    assert.ok(j.take.dir.startsWith(u.home), `output stays in the fresh data root: ${j.take.dir}`);
    const c = await cli(['look', `${srv.origin}/index.html`, '--engine', 'cft'], u.env);
    assert.equal(c.code, 1);
    if (process.platform === 'darwin' && process.arch === 'arm64') assert.match(c.err, /cft\) is not installed, and reva doctor --install does not install it\. The headless shell is installed: use --engine chs/);
    else assert.match(c.err, /only available on macOS arm64/);
    assert.doesNotMatch(c.err, /\n\s+at /, 'no stack trace');
  } finally { await srv.close(); fs.rmSync(u.home, { recursive: true, force: true }); }
});

test('look rejects a recognised cookie banner in the page (the reject button, never accept)', async () => {
  const hits = [];
  const html = `<!doctype html><html><body style="margin:0">
<div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#eee">
  We use cookies. <button id="acc" onclick="fetch('/accepted')">Accept all</button>
  <button id="rej" onclick="fetch('/rejected');this.parentNode.style.transition='opacity 300ms linear';this.parentNode.style.opacity='0'">Reject all</button>
</div>
<div style="width:200px;height:200px;background:#09f;animation:a 600ms ease-out both">box</div>
<style>@keyframes a{from{transform:translateY(40px)}to{transform:none}}</style></body></html>`;
  const srv = http.createServer((req, res) => { hits.push(req.url); if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); } res.writeHead(204); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await runLook({ input: `http://localhost:${srv.address().port}/`, safety: true, write: false });
    assert.deepEqual(r.safety.consent.clicks, ['text="Reject all"']);
    assert.deepEqual(r.safety.consent.clicked, ['text="Reject all"']);
    assert.ok(hits.includes('/rejected'), hits.join(' '));
    assert.ok(!hits.includes('/accepted'), 'never accept');
    assert.equal(r.safety.robots.blocked, false); assert.equal(r.safety.verdict, 'ok');
  } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
});
