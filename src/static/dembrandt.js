// dembrandt 0.39.2 (MIT) as a SUBPROCESS in a browser session of its own (PLAN M4 Reuse):
//   - explicit Chrome for Testing / headless-shell, throwaway profile, --use-mock-keychain (all via src/browser/launch.js);
//     dembrandt is pointed at that browser over CDP (BROWSER_CDP_ENDPOINT), so it can never fall back to the owner's Chrome
//   - its own session: it injects a motion-freeze style, so it must never share a browser with the static pass or a motion take
//   - --no-headed-fallback: it must never open a visible window
//   - everything it returns is a HINT (provenance `inferred`, hint:true): its colour heuristic scores 32 % on its own benchmark,
//     and its motion/breakpoint outputs are regex/heuristic based (it skips cross-origin sheets)
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { launchBrowser } from '../browser/launch.js';
import { privateRoot, assertOutsideRepo } from '../util/paths.js';
import { inferred, Ledger } from './prov.js';
import { defaultEngine } from '../browser/engines.js';

export const DEMBRANDT_VERSION = '0.39.2';

export function dembrandtEntry(env = process.env) {
  return env.REVA_DEMBRANDT || path.join(privateRoot(env), 'tools', 'dembrandt', 'node_modules', 'dembrandt', 'dist', 'index.js');
}

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });

/** Pure: reduces dembrandt's JSON to hint entries. Everything is `inferred` + hint:true with the tool's own words kept. */
export function summariseHints(raw, ledger = new Ledger()) {
  const hint = (value, what, extra = {}) => inferred(value, `dembrandt ${DEMBRANDT_VERSION} heuristic: ${what}`, { hint: true, tool: `dembrandt@${DEMBRANDT_VERSION}`, ...extra });
  const out = { tool: `dembrandt@${DEMBRANDT_VERSION}`, provenance: 'inferred', hint: true };
  const pick = (k) => raw && Object.prototype.hasOwnProperty.call(raw, k) ? raw[k] : undefined;
  const colors = pick('colors');
  if (colors) {
    out.colors = hint({ semantic: colors.semantic ?? null, palette: (colors.palette || []).slice(0, 12), cssVariables: colors.cssVariables ?? null }, 'colour roles and palette; its primary-colour pick scored 32 % on its own benchmark');
  } else out.colors = ledger.add('unk_dembrandt_colors', 'dembrandt returned no colours', 'rerun dembrandt', 'dembrandt');
  const bp = pick('breakpoints');
  out.breakpoints = bp ? hint(bp, 'breakpoints from a regex over same-origin CSS; cross-origin sheets are skipped (compare with the measured sweep)') : ledger.add('unk_dembrandt_breakpoints', 'dembrandt returned no breakpoints', 'use the measured sweep', 'dembrandt');
  const motion = pick('motion') ?? pick('transitions') ?? pick('animations');
  out.motion = motion ? hint(motion, 'duration/easing hints from computed transition properties; not a measurement of behaviour over time (M2 owns that)') : ledger.add('unk_dembrandt_motion', 'dembrandt returned no motion hints', 'n/a', 'dembrandt');
  for (const k of ['typography', 'spacing', 'borderRadius', 'borders', 'shadows', 'components', 'frameworks', 'icons']) if (pick(k) !== undefined) out[k] = hint(pick(k), `${k} summary (cross-check against the computed-style tokens)`);
  out.keys = raw ? Object.keys(raw) : [];
  return out;
}

/**
 * @returns {{hints, rawFile, wallMs, exit, ledger}}
 */
export async function runDembrandt({ url, engine = defaultEngine(), outDir, timeoutMs = 180000, entry = dembrandtEntry() } = {}) {
  const ledger = new Ledger();
  if (!fs.existsSync(entry)) {
    return { hints: { tool: `dembrandt@${DEMBRANDT_VERSION}`, status: ledger.add('unk_dembrandt_missing', `dembrandt entry not found at ${entry}`, `npm install --ignore-scripts dembrandt@${DEMBRANDT_VERSION} into ${path.join(privateRoot(), 'tools', 'dembrandt')}, or set REVA_DEMBRANDT`, 'dembrandt') }, ledger };
  }
  const t0 = Date.now();
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(privateRoot(), 'profiles', 'dembrandt-cwd-'));
  assertOutsideRepo(cwd);
  const h = await launchBrowser({ engine, args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], context: { viewport: { width: 1440, height: 900 } } });
  try {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: cwd, BROWSER_CDP_ENDPOINT: `http://127.0.0.1:${port}`, DEMBRANDT_NO_HEADED_FALLBACK: '1', NO_COLOR: '1', CI: '1' };
    const child = spawn(process.execPath, [entry, url, '--json-only', '--no-headed-fallback', '--browser', 'chromium'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    try { os.setPriority(child.pid, 19); } catch {}
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    const exit = await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000); }, timeoutMs);
      child.on('close', (code, sig) => { clearTimeout(timer); resolve({ code, signal: sig }); });
    });
    let raw = null;
    const start = stdout.indexOf('{');
    if (start >= 0) { try { raw = JSON.parse(stdout.slice(start)); } catch {} }
    if (!raw) {
      return { hints: { tool: `dembrandt@${DEMBRANDT_VERSION}`, status: ledger.add('unk_dembrandt_failed', `dembrandt exited ${JSON.stringify(exit)} without parseable JSON: ${stderr.slice(0, 200).replace(/\s+/g, ' ')}`, 'run the subprocess by hand against the same URL', 'dembrandt') }, exit, wallMs: Date.now() - t0, ledger };
    }
    let rawFile = null;
    if (outDir) {
      const body = JSON.stringify(raw); const sha = crypto.createHash('sha256').update(body).digest('hex');
      fs.mkdirSync(path.join(outDir, 'series'), { recursive: true });
      rawFile = { file: `series/dembrandt-${sha.slice(0, 16)}.json`, sha256: sha, bytes: Buffer.byteLength(body) };
      fs.writeFileSync(path.join(outDir, rawFile.file), body);
    }
    const hints = summariseHints(raw, ledger); hints.raw = rawFile; hints.exit = exit;
    return { hints, rawFile, exit, wallMs: Date.now() - t0, ledger };
  } finally {
    await h.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
