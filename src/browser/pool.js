// Browser pool for the gate (F4): ONE browser process serves many sessions, each session in a fresh, empty browser
// context (own cookies, storage, cache, routes, init scripts, fake clock), instead of a browser launch + close per
// session. Saves the launch/teardown of ~100 sessions per site and lets us recycle on a memory threshold.
// Independence rule: a check that compares two sessions as "independent loads" (orig1 vs orig2, ...) must take them
// from DIFFERENT pools; the callers key pools by run (see PoolSet).
// The browser's profile is Playwright's own temp dir (removed on browser.close()); we track the browser's PID (our
// direct child) to measure RSS and to make sure nothing is left behind. We only ever signal our own PIDs.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolveEngine, MANDATORY_ARGS } from './engines.js';
import { resolveToolkit, loadPlaywright } from './toolkit.js';
import { sleep } from './procs.js';

const livePools = new Set();
let hooked = false;
const psRows = () => {
  const out = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').map(l => l.trim().split(/\s+/).map(Number)).filter(r => r.length === 3 && r.every(Number.isFinite));
};
/** pid + all descendants (from one ps snapshot). */
function tree(root, rows = psRows()) {
  const kids = new Map(); for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
  const out = [], q = [root];
  while (q.length) { const p = q.pop(); out.push(p); for (const k of kids.get(p) || []) q.push(k); }
  return out;
}
/** Resident MB of a browser's process tree. */
export function treeRssMb(pid) {
  try { const rows = psRows(), set = new Set(tree(pid, rows)); return Math.round(rows.filter(r => set.has(r[0])).reduce((s, r) => s + r[2], 0) / 1024); } catch { return 0; }
}
/** Command line of one pid ('' if gone). */
const commandOf = pid => { try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; } };
/** Kill a pool's browser tree, but ONLY if pid is a real pid (> 1) whose command line carries this pool's unique launch
 *  marker. pid 0/1 would expand to launchd's descendants (every process the user owns), so they never reach kill. */
export function killPoolTree(pool) {
  const pid = pool?.pid;
  if (!Number.isInteger(pid) || pid <= 1 || !pool.marker) return 0;
  if (!commandOf(pid).includes(pool.marker)) return 0;
  let n = 0;
  for (const p of tree(pid)) { if (p > 1 && p !== process.pid) { try { process.kill(p, 'SIGKILL'); n++; } catch {} } }
  return n;
}
function hookExit() {
  if (hooked) return; hooked = true;
  process.on('exit', () => { for (const p of livePools) { try { killPoolTree(p); } catch {} } });
}

export class BrowserPool {
  /** maxUses: sessions per browser before it is recycled; maxRssMb: process-tree RSS that triggers a recycle (checked
   *  between sessions, never while one is open). */
  constructor({ args = [], maxUses = 25, maxRssMb = 3500, toolkit, engine, version } = {}) {
    Object.assign(this, { args, maxUses, maxRssMb, toolkitId: toolkit, engineId: engine, version });
    this.browser = null; this.pid = 0; this.uses = 0; this.active = 0; this.launches = 0; this.recycles = [];
    this.opening = Promise.resolve();
  }

  async #launch() {
    hookExit();
    const tk = resolveToolkit(this.toolkitId);
    const eng = resolveEngine(this.engineId, { version: this.version || tk.browser, cache: tk.cache || undefined });
    const pw = await loadPlaywright(tk);
    // unknown switches are ignored by Chrome and stay in the main process's command line: a per-launch marker identifies
    // OUR browser exactly, whatever else is launching at the same time (no "first new child" guesswork)
    this.marker = `--wr-pool-id=${randomBytes(8).toString('hex')}`;
    this.pid = 0;
    this.browser = await pw.chromium.launch({ executablePath: eng.executablePath, headless: true, args: [...MANDATORY_ARGS, ...this.args, this.marker] });
    const me = process.pid, rows = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
    for (const l of rows) { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); if (m && +m[2] === me && m[3].includes(this.marker) && !/--type=/.test(m[3])) { this.pid = +m[1]; break; } }
    if (!this.pid) { await this.browser.close().catch(() => {}); this.browser = null; throw new Error('pool: could not identify the launched browser process'); }
    this.uses = 0; this.launches++;
    // what a launchBrowser handle reports (take / freeze provenance): the same flags a launch gets, without the pool marker
    this.info = { engine: eng.engine, version: eng.version, executablePath: eng.executablePath, toolkit: tk.id, playwrightVersion: pw.version, args: [...MANDATORY_ARGS, ...this.args] };
    this.dead = false;
    this.browser.on('disconnected', () => { this.dead = true; });
    livePools.add(this);
  }

  async #retire(why) {
    const b = this.browser;
    this.browser = null;
    if (why) this.recycles.push(why);
    if (!b) return;
    try { await Promise.race([b.close(), sleep(15000)]); } catch {}
    // a closed browser has no processes left; if any remain after a grace period they are ours: kill them (guarded).
    // The pid is kept until the pool leaves livePools, so the exit sweep still covers a failed close.
    for (let i = 0; i < 30 && this.pid > 1 && tree(this.pid).length > 1; i++) await sleep(100);
    killPoolTree(this);
    livePools.delete(this);
    this.pid = 0;
  }

  /** Resolves when no session is open (used before a recycle). */
  #drained() { return this.active === 0 ? Promise.resolve() : new Promise(r => { (this.drainWaiters ||= []).push(r); }); }

  /** A session handle shaped like launchBrowser's: {context, page, close()}. A fresh context + page per call. */
  async open({ context = {} } = {}) {
    // serialised: the recycle decision and the launch must not interleave with another open()
    const turn = this.opening; let done; this.opening = new Promise(r => { done = r; });
    await turn.catch(() => {});
    try {
      if (this.browser) {
        // a limit hit while sessions are open: wait for them to finish (new opens queue behind this one), then relaunch
        let why = null;
        if (this.dead || !this.browser.isConnected()) why = 'disconnected';
        else if (this.uses >= this.maxUses) why = `uses ${this.uses}`;
        else if (this.pid > 1) { const mb = treeRssMb(this.pid); if (mb > this.maxRssMb) why = `rss ${mb}MB`; }
        if (why) { await this.#drained(); await this.#retire(why); }
      }
      if (!this.browser) await this.#launch();
      const { channel, executablePath, ...ctxOpts } = context;
      const ctx = await this.browser.newContext({ ...ctxOpts, serviceWorkers: ctxOpts.serviceWorkers ?? 'block' });
      let page;
      try { page = await ctx.newPage(); } catch (e) { await ctx.close().catch(() => {}); throw e; }
      this.uses++; this.active++;
      let closed = false;
      const h = { context: ctx, page, profile: null, pooled: true, pid: this.pid, ...this.info, close: async () => {
        if (closed) return; closed = true;
        try { await Promise.race([ctx.close(), sleep(15000)]); } catch {}
        this.active--;
        if (!this.active && this.drainWaiters?.length) { const w = this.drainWaiters; this.drainWaiters = []; for (const r of w) r(); }
      } };
      return h;
    } finally { done(); }
  }

  async close() { await this.#retire(null); }
}

/**
 * S11 (26 Oct): a caller that takes a session from a pool instead of launchBrowser must get the browser it would have
 * launched. Browser flags are fixed when the pool's browser starts, so the pool's args, engine and toolkit must equal the
 * caller's exactly (order included); a mismatch throws instead of silently recording with other flags.
 */
export function assertPoolFits(pool, { args = [], engine, toolkit } = {}) {
  const want = JSON.stringify(args), have = JSON.stringify(pool?.args || []);
  if (want !== have) throw new Error(`pool args ${have} differ from the session's ${want}`);
  if ((pool.engineId ?? null) !== (engine ?? null)) throw new Error(`pool engine ${pool.engineId} differs from the session's ${engine}`);
  if ((pool.toolkitId ?? null) !== (toolkit ?? null)) throw new Error(`pool toolkit ${pool.toolkitId} differs from the session's ${toolkit}`);
  return true;
}

/** Pools keyed by name (e.g. `o1|A`): sessions asking for the same key share a browser, different keys never do. */
export class PoolSet {
  constructor(opts = {}) { this.opts = opts; this.pools = new Map(); }
  get(key) { let p = this.pools.get(key); if (!p) { p = new BrowserPool(this.opts); this.pools.set(key, p); } return p; }
  /** Close every pool whose key starts with prefix (a run finished: free its browser). */
  async closeMatching(prefix = '') { for (const [k, p] of [...this.pools]) if (k.startsWith(prefix)) { this.pools.delete(k); await p.close(); } }
  async closeAll() { await this.closeMatching(''); }
  stats() { return Object.fromEntries([...this.pools].map(([k, p]) => [k, { launches: p.launches, recycles: p.recycles }])); }
}

export const poolsEnabled = () => process.env.WR_GATE_POOL !== '0';
