// Quota watchdog (PLAN H5), optional. Reads a usage file (REVA_USAGE_FILE, default <data root>/usage.txt) that a status
// line or script keeps current:
//   "<epoch> <7d %> <5h %>"   (5h is empty right after a window reset = 0)
// and stops a heavy job when a cap is crossed. Caps leave margin for stop latency and the main loop's own use.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { usageFile, outRoot, assertOutsideRepo } from '../util/paths.js';

export const DEFAULT_CAPS = { fiveHour: 88, sevenDay: 79 };
export const EXIT_CAP = 75; // EX_TEMPFAIL: stopped because of the quota cap

/** Parse the usage text. Returns {epoch, sevenDay, fiveHour, ageS} or null if unreadable. */
export function parseUsage(text, nowMs = Date.now()) {
  const parts = String(text).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const epoch = Number(parts[0]);
  const sevenDay = Number(parts[1]);
  const fiveHour = parts.length >= 3 ? Number(parts[2]) : 0; // empty 5h = fresh window
  if (![epoch, sevenDay, fiveHour].every(Number.isFinite)) return null;
  return { epoch, sevenDay, fiveHour, ageS: Math.round(nowMs / 1000 - epoch) };
}

export function readUsage(file = usageFile(), nowMs = Date.now()) {
  try { return parseUsage(fs.readFileSync(file, 'utf8'), nowMs); } catch { return null; }
}

/** {stop:boolean, reason?:string}. An unreadable file never stops a job by itself (it is logged as `unknown`). */
export function decide(usage, caps = DEFAULT_CAPS) {
  if (!usage) return { stop: false, state: 'unknown' };
  if (usage.fiveHour >= caps.fiveHour) return { stop: true, state: 'cap', reason: `5h ${usage.fiveHour}% >= cap ${caps.fiveHour}%` };
  if (usage.sevenDay >= caps.sevenDay) return { stop: true, state: 'cap', reason: `7d ${usage.sevenDay}% >= cap ${caps.sevenDay}%` };
  return { stop: false, state: 'ok' };
}

function logLine(logFile, line) {
  if (!logFile) return;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
}

/**
 * Run `cmd` (argv array) under the watchdog. The child gets its own process group so the whole tree can be stopped.
 * Resolves {exitCode, stoppedByCap, reason, samples, stopLatencyMs}.
 */
export function runWatched(cmd, { file = usageFile(), caps = DEFAULT_CAPS, intervalMs = 25000, graceMs = 5000, logFile, nice = 20, cwd, env } = {}) {
  return new Promise(resolve => {
    if (logFile) assertOutsideRepo(path.dirname(logFile));
    const argv = nice != null ? ['/usr/bin/nice', '-n', String(nice), ...cmd] : cmd;
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', detached: true, cwd, env: env || process.env });
    const result = { exitCode: null, stoppedByCap: false, reason: null, samples: 0, stopLatencyMs: null, breachAt: null };
    let timer = null, done = false;
    logLine(logFile, `start pid=${child.pid} caps=5h:${caps.fiveHour}/7d:${caps.sevenDay} interval=${intervalMs}ms cmd=${cmd.join(' ').slice(0, 200)}`);
    const killGroup = sig => { try { process.kill(-child.pid, sig); } catch {} };
    const sample = () => {
      if (done) return;
      const u = readUsage(file);
      const d = decide(u, caps);
      result.samples++;
      logLine(logFile, u ? `sample 7d=${u.sevenDay}% 5h=${u.fiveHour}% age=${u.ageS}s -> ${d.state}` : 'sample unreadable -> unknown');
      if (d.stop && !result.stoppedByCap) {
        result.stoppedByCap = true; result.reason = d.reason; result.breachAt = Date.now();
        logLine(logFile, `CAP: ${d.reason}; SIGTERM to process group ${child.pid}`);
        killGroup('SIGTERM');
        setTimeout(() => { if (!done) { logLine(logFile, 'grace over; SIGKILL'); killGroup('SIGKILL'); } }, graceMs).unref();
      }
    };
    sample();
    timer = setInterval(sample, intervalMs);
    child.on('exit', (code, signal) => {
      done = true; clearInterval(timer);
      if (result.breachAt) result.stopLatencyMs = Date.now() - result.breachAt;
      result.exitCode = result.stoppedByCap ? EXIT_CAP : (code ?? (signal ? 128 : 1));
      logLine(logFile, `end code=${code} signal=${signal} stoppedByCap=${result.stoppedByCap}`);
      resolve(result);
    });
    child.on('error', e => { done = true; clearInterval(timer); logLine(logFile, `spawn error ${e.message}`); resolve({ ...result, exitCode: 127, error: e.message }); });
  });
}

export function defaultLogFile() { return path.join(outRoot(), 'logs', 'quota-watchdog.log'); }
