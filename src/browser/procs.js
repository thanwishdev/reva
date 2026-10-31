// Process inspection scoped to OUR profile folder. We never match, signal or kill anything else.
import { execFileSync } from 'node:child_process';

/** [{pid, ppid, command}] for all processes (`ps` is read-only). */
export function listProcesses() {
  const out = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], command: m[3] });
  }
  return rows;
}

/** Processes whose command line mentions the given profile directory (browser + its helpers). */
export function procsUsingProfile(profileDir, rows = listProcesses()) {
  return rows.filter(r => r.command.includes(profileDir));
}

/** Any process running a Chrome-for-Testing / headless-shell binary from the puppeteer cache or REVA's own browsers folder. */
export function testBrowserProcs(rows = listProcesses()) {
  return rows.filter(r => /\/(puppeteer|browsers)\/chrome(-headless-shell)?\//.test(r.command));
}

/** Main (non-helper) processes of the owner's own Google Chrome: informational evidence only. */
export function ownerChromeMainPids(rows = listProcesses()) {
  return rows.filter(r => r.command.startsWith('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') && !/--type=/.test(r.command)).map(r => r.pid).sort((a, b) => a - b);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
