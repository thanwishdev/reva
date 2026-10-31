// `doctor` proves PLAN H1 on this machine with a real launch of each engine, and checks the toolkit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchBrowser } from './browser/launch.js';
import { resolveEngine, assertTestBrowser, MANDATORY_ARGS, PINNED_BROWSER } from './browser/engines.js';
import { listProcesses, procsUsingProfile, testBrowserProcs, ownerChromeMainPids, sleep } from './browser/procs.js';
import { OFFLINE_ARGS } from './replay/target.js';
import { ensureOutDir, usageFile, profilesDir, REPO_ROOT, ensureDataRoot } from './util/paths.js';
import { osRelease } from './install/install.js';

const require = createRequire(import.meta.url);
const checks = [];
const hints = [];
const add = (id, pass, detail, extra = {}) => { checks.push({ id, pass: !!pass, detail, ...extra }); };
const INSTALL_HINT = 'REVA\'s headless browser is missing: run  reva doctor --install  (no sudo; downloads about 100 MB into the REVA data folder)';

async function proveEngine(engine) {
  const pre = listProcesses();
  const preTest = testBrowserProcs(pre).map(r => r.pid);
  const ownerBefore = ownerChromeMainPids(pre);
  const t0 = Date.now();
  let h, info = {};
  try {
    h = await launchBrowser({ engine, context: { viewport: { width: 800, height: 600 } } });
    info.launchMs = Date.now() - t0;
    await h.page.goto('data:text/html,<title>doctor</title><p>ok</p>');
    info.title = await h.page.title();
    info.userAgent = await h.page.evaluate(() => navigator.userAgent);
    const mine = procsUsingProfile(h.profile);
    const main = mine.find(r => !/--type=/.test(r.command)) || mine[0];
    info.profile = h.profile;
    info.processCount = mine.length;
    info.mainCommand = main ? main.command : null;
    info.profileCreated = fs.existsSync(h.profile);
  } finally { if (h) await h.close(); }
  await sleep(300);
  const post = listProcesses();
  info.leftoverProcs = procsUsingProfile(info.profile || '/nonexistent-never', post).length;
  info.leftoverTestBrowsers = testBrowserProcs(post).map(r => r.pid).filter(p => !preTest.includes(p)).length;
  info.profileRemoved = info.profile ? !fs.existsSync(info.profile) : false;
  info.ownerChromeMainPidsUnchanged = JSON.stringify(ownerBefore) === JSON.stringify(ownerChromeMainPids(post));
  info.ownerChromeMainPids = ownerBefore;
  return info;
}

export async function runDoctor({ engines = ['chs'], write = true } = {}) {
  checks.length = 0; hints.length = 0;
  const started = new Date().toISOString();
  add('node', Number(process.versions.node.split('.')[0]) >= 24, Number(process.versions.node.split('.')[0]) >= 24 ? `node ${process.versions.node}` : `node ${process.versions.node} is too old; REVA needs Node 24 or newer (https://nodejs.org)`);
  let rootOk = true;
  try { const dir = ensureDataRoot(); const probe = path.join(dir, `.doctor-${process.pid}`); fs.writeFileSync(probe, 'x'); fs.rmSync(probe); add('data folder', true, `${dir} (set REVA_HOME to move it)`); }
  catch (e) { rootOk = false; add('data folder', false, e.message); }
  if (!rootOk) { write = false; }
  let pwVersion = null;
  try { pwVersion = require('playwright-core/package.json').version; } catch {}
  add('playwright-core pin', pwVersion === '1.60.0', pwVersion === '1.60.0' ? `playwright-core ${pwVersion}` : `playwright-core ${pwVersion || 'missing'}, expected 1.60.0: run npm install in the REVA folder`);
  add('repo not a site store', !fs.existsSync(path.join(REPO_ROOT, 'out')), 'no out/ folder in the repo');

  for (const engine of (rootOk ? engines : [])) {
    let exe;
    try {
      exe = resolveEngine(engine);
      assertTestBrowser(exe.executablePath);
      add(`${engine}: explicit executable`, true, exe.executablePath);
    } catch (e) { add(`${engine}: explicit executable`, false, e.message); if (/not installed yet/.test(e.message)) hints.push(INSTALL_HINT); continue; }
    try {
      const i = await proveEngine(engine);
      const cmd = i.mainCommand || '';
      add(`${engine}: launched headless, page works`, i.title === 'doctor' && /HeadlessChrome/.test(i.userAgent), `title=${i.title} ua=${(i.userAgent || '').slice(0, 90)}`);
      add(`${engine}: launch time (a keychain prompt would block)`, i.launchMs < 15000, `${i.launchMs} ms`);
      add(`${engine}: command line has explicit exe + mock keychain + basic password store`,
        cmd.startsWith(exe.executablePath) && MANDATORY_ARGS.every(a => cmd.includes(a)), `mock-keychain x${cmd.split('--use-mock-keychain').length - 1}, basic-store x${cmd.split('--password-store=basic').length - 1} (own flags are added even when the binary is wrapped); ${cmd.slice(0, 200)}`);
      add(`${engine}: isolated profile`, cmd.includes(`--user-data-dir=${i.profile}`) && i.profile.startsWith(profilesDir()) && i.profileCreated, i.profile);
      add(`${engine}: never your own Chrome`, !/Google Chrome\.app\//.test(cmd), 'command line does not reference /Applications/Google Chrome.app');
      add(`${engine}: 0 leftover processes`, i.leftoverProcs === 0 && i.leftoverTestBrowsers === 0, `profile procs after close=${i.leftoverProcs}, new test-browser procs=${i.leftoverTestBrowsers} (browser tree had ${i.processCount})`);
      add(`${engine}: profile removed`, i.profileRemoved, i.profile);
      add(`${engine}: owner Chrome untouched (informational)`, true, `owner Chrome main pids ${JSON.stringify(i.ownerChromeMainPids)}, unchanged=${i.ownerChromeMainPidsUnchanged}`);
    } catch (e) { add(`${engine}: launch`, false, e.stack.split('\n').slice(0, 3).join(' | ')); }
  }

  // The replay's offline switch really blocks DNS (no routes installed here, so only the resolver rule can answer).
  // example.invalid-style names never leave the machine: the resolver rule maps every host except localhost to NOTFOUND.
  if (checks.some(c => c.id === 'chs: explicit executable' && c.pass)) {
    let h, err = null;
    try {
      h = await launchBrowser({ engine: 'chs', args: OFFLINE_ARGS });
      try { await h.page.goto('https://dns-probe.example/', { timeout: 10000 }); } catch (e) { err = e.message.split('\n')[0]; }
    } finally { if (h) await h.close(); }
    add('replay offline flag: DNS disabled', /ERR_NAME_NOT_RESOLVED/.test(err || ''), err || 'navigation unexpectedly succeeded');
  }

  // Text needs at least one system font. A bare Linux (a fresh Ubuntu, a container) has none: the headless shell then draws
  // every glyph as nothing, text has no size on screen and every measurement of it is wrong (measured 31 Oct 2026 on a bare
  // ubuntu:24.04: the demo's heading ranked 0 % of the visual weight instead of 68 %). Proven by drawing text on a canvas.
  if (checks.some(c => c.id === 'chs: explicit executable' && c.pass)) {
    let h, painted = null, err = null;
    try {
      h = await launchBrowser({ engine: 'chs' });
      painted = await h.page.evaluate(() => {
        const c = document.createElement('canvas'); c.width = 200; c.height = 60; const g = c.getContext('2d');
        g.font = '40px sans-serif'; g.fillStyle = '#000'; g.fillText('Wg Ag', 4, 44);
        const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
      });
    } catch (e) { err = e.message.split('\n')[0]; } finally { if (h) await h.close(); }
    const ok = painted > 0;
    add('system fonts: text is drawn', ok, err || (ok ? `${painted} px of sample text drawn` : 'no system font: text draws as nothing, so text sizes, type and anything measured on text would be wrong'));
    if (!ok && !err) {
      const os = osRelease(); const deb = os.id === 'debian' || os.id === 'ubuntu' || /\b(debian|ubuntu)\b/.test(os.like || '');
      hints.push(deb ? 'no system fonts: install some with  sudo apt-get install -y fonts-liberation  (then run reva doctor again)'
        : 'no system fonts: install a basic font package (for example Liberation or DejaVu) with your package manager, then run reva doctor again');
    }
  }

  // Guard unit: the user's own Chrome and arbitrary binaries must be refused.
  for (const bad of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/true']) {
    let refused = false; try { assertTestBrowser(bad); } catch { refused = true; }
    add(`guard refuses ${bad}`, refused, refused ? 'refused' : 'ACCEPTED');
  }

  // Environment facts the later milestones rely on.
  let usage = null; try { usage = fs.readFileSync(usageFile(), 'utf8').trim(); } catch {}
  add('usage file (informational, only the quota watchdog reads it)', true, usage || `not present: ${usageFile()} (fine unless you run the watchdog)`);
  add('pinned browser version', true, PINNED_BROWSER);

  const ok = checks.every(c => c.pass);
  const report = { started, finished: new Date().toISOString(), host: `${os.platform()}-${os.arch()}`, ok, checks, hints: [...new Set(hints)] };
  if (write) {
    const dir = ensureOutDir('doctor');
    fs.writeFileSync(path.join(dir, `doctor-${started.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2));
  }
  return report;
}

export function formatDoctor(r) {
  const lines = r.checks.map(c => `${c.pass ? 'PASS' : 'FAIL'}  ${c.id}${c.detail ? `  -- ${c.detail}` : ''}`);
  lines.push('', r.ok ? 'doctor: ALL CHECKS PASSED' : 'doctor: FAILED');
  for (const h of r.hints || []) lines.push(`next: ${h}`);
  return lines.join('\n');
}
