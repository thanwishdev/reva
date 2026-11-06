// Take / evidence model v0 (PLAN §3 "Evidence model", H6).
// A take is a folder under the private output root:
//   take.json        summary-first: environment block (every value tagged with provenance), unknowns ledger, coverage,
//                    escapes, quality flags, digests of every series file
//   series/<sha256>.jsonl.zst   the dense data (JSON Lines, zstd; older takes: plain .jsonl, read the same way)
//                     (rows, births, mutation stamps, wheel log, declared snapshots), content-addressed
// Provenance values: declared | measured | fitted | inferred | unknown (H6). The recorder never fits (M1 must not fit),
// so a take only uses: measured (read back from the browser / host), declared (from the page, or the recorder's own
// configuration, marked source:'recorder-config'), unknown (with reason + probe, mirrored in the unknowns ledger).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureOutDir } from '../util/paths.js';
import { readJsonl, readSeriesBytes, storeSpool, zstdWriter } from './series-io.js';

export { readJsonl };

export const PROVENANCE = ['declared', 'measured', 'fitted', 'inferred', 'unknown'];
export const TAKE_SCHEMA = 'reva.take/0';

const meas = (value, extra = {}) => ({ value, provenance: 'measured', ...extra });
const decl = (value, source = 'recorder-config', extra = {}) => ({ value, provenance: 'declared', source, ...extra });
const unk = (id, reason, probe) => ({ value: null, provenance: 'unknown', unknown: id, reason, probe });

function stats(a) {
  a = a.filter(Number.isFinite); if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y); const q = p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { n: a.length, min: s[0], p05: q(0.05), median: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}
function histogram(a, bin = 0.5) {
  const h = {}; for (const x of a) { if (!Number.isFinite(x)) continue; const k = (Math.round(x / bin) * bin).toFixed(3); h[k] = (h[k] || 0) + 1; }
  return h;
}
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Frame-to-frame dt of the sampled rows (virtual ms in hx, real rAF timestamps in rt). */
export function rowDts(rows) { const d = []; for (let i = 1; i < rows.length; i++) if (rows[i].T != null && rows[i - 1].T != null) d.push(rows[i].T - rows[i - 1].T); return d; }

/** Build the environment block + unknowns ledger + quality flags from a raw take. Pure (unit-tested). */
export function buildEnvironment(t) {
  const unknowns = [];
  const U = (id, reason, probe) => { unknowns.push({ id, reason, probe }); return unk(id, reason, probe); };
  const rows = t.data.rows || [];
  const dts = rowDts(rows);
  const realDts = t.lane === 'rt' ? (t.rtDt || []) : null;
  const realStats = realDts && realDts.length ? stats(realDts) : null;
  const env = {
    lane: decl(t.lane),
    virtualRateHz: t.lane === 'hx' ? decl(t.rate) : U('unk_virtual_rate', 'rt lane has no virtual clock', 'n/a: use refreshHz'),
    dtMs: t.lane === 'hx' ? decl(t.dt) : U('unk_dt_virtual', 'rt lane frame times are real; see dtHistogram', 'n/a: use dtHistogram'),
    clockGrid: t.lane === 'hx' ? decl(t.cfg.stall ? `integer frames with a stall schedule, T_k = round(T0 + k*dt + floor(k/${t.cfg.stall.every})*(${t.cfg.stall.ms} - dt), 1e-6 ms)` : 'integer frames, T_k = round(T0 + k*dt, 1e-6 ms)') : decl('real time'),
    ...(t.lane === 'hx' && t.cfg.stall ? { stallSchedule: decl(t.cfg.stall) } : {}),
    dateEpochMs: t.lane === 'hx' ? decl(t.cfg.dateEpoch) : U('unk_date_epoch', 'rt lane uses the real wall clock', 'n/a'),
    dateNow: t.lane === 'hx' ? decl(t.cfg.dateInteger ? 'integer (floor)' : 'fractional (exact grid)') : decl('real'),
    birthRule: t.lane === 'hx' ? decl(t.cfg.birthRule) : decl('rt: CSS/WAAPI startTime as reported'),
    yieldMode: t.lane === 'hx' ? decl(t.cfg.yieldMode) : decl('n/a (rt)'),
    samplePhase: t.lane === 'hx' ? decl('after the settle frame and post-pin') : decl(t.cfg.rtPhase === 'raf' ? 'inside the recorder rAF callback (runs before page rAF callbacks)' : 'post-frame task after rAF'),
    refreshHz: realStats ? meas(+(1000 / realStats.median).toFixed(2), { from: 'median real rAF dt during the take' })
      : t.lane === 'hx' ? decl(+(1000 / t.dt).toFixed(3), 'recorder-config', { note: 'virtual; real frames only settle events' })
        : U('unk_refresh', 'no real frame timestamps were collected', 'run an rt take with births/sampling on'),
    dtHistogram: dts.length ? meas(histogram(dts, t.lane === 'hx' ? 1e-3 : 0.5), { stats: stats(dts) }) : U('unk_dt_hist', 'no samples were taken', 'sample at least 2 frames'),
    engine: decl(t.browser.engine),
    browserVersion: meas(t.browser.product, { from: 'CDP Browser.getVersion' }),
    protocolVersion: meas(t.browser.protocolVersion, { from: 'CDP Browser.getVersion' }),
    browserRevision: meas(t.browser.revision, { from: 'CDP Browser.getVersion' }),
    toolkit: decl(t.browser.toolkit),
    playwrightVersion: meas(t.browser.playwright, { from: 'playwright-core package.json' }),
    executablePath: decl(t.browser.executablePath),
    flags: decl(t.browser.args),
    viewport: t.env ? meas({ width: t.env.innerWidth, height: t.env.innerHeight }, { from: 'window.innerWidth/innerHeight' }) : U('unk_viewport', 'page never answered', 'finish() on a live page'),
    dpr: t.env ? meas(t.env.dpr, { from: 'devicePixelRatio' }) : U('unk_dpr', 'page never answered', 'finish() on a live page'),
    reducedMotion: t.env ? meas(t.env.reducedMotion, { from: 'matchMedia' }) : U('unk_rm', 'page never answered', 'finish() on a live page'),
    // the colour scheme, only on a take that asked for one (--color-scheme): what prefers-color-scheme matched in the page
    ...(t.context && t.context.colorScheme ? { colorScheme: t.env && t.env.colorScheme ? meas(t.env.colorScheme, { from: 'matchMedia', requested: t.context.colorScheme }) : U('unk_color_scheme_read', 'page never answered', 'finish() on a live page') } : {}),
    userAgent: t.env ? meas(t.env.ua, { from: 'navigator.userAgent' }) : U('unk_ua', 'page never answered', 'finish() on a live page'),
    buildId: t.buildId != null ? meas(t.buildId, { from: 'archive version.json' }) : U('unk_build_id', 'not an archived target (local fixture or no version.json)', 'freeze the target with a version file'),
    seed: t.cfg.seed != null ? decl(t.cfg.seed) : t.extra && t.extra.seed != null ? decl(t.extra.seed) : U('unk_seed', 'Math.random not seeded for this take', 'pass a seed (target config or --seed)'),
    readbackFloor: t.env && t.env.readback ? meas(t.env.readback, { from: 'planted values read back via getComputedStyle (D3)' }) : U('unk_readback', 'read-back floor not measured', 'finish() on a live page'),
    hostLoad: meas(t.host.loadavg, { from: 'os.loadavg()' }),
    host: meas({ platform: t.host.platform, release: t.host.release, node: t.host.node, cpus: t.host.cpus }),
    displayState: U('unk_display_state', 'the recorder does not read the display power state; rt takes depend on it (W2G1-2 §6)', 'pmset -g log | grep "Display is turned" around the take time'),
    eventTimeStamp: t.escapes && t.escapes['event-timestamp'] ? U('unk_event_timestamp', 'the page read Event.timeStamp, which is real time in hx', 'compare an rt take of the same input') : meas('not read by the page'),
  };
  // quality flags
  const flags = [];
  if (realStats) {
    const big = realDts.filter(d => d > 1.5 * realStats.median).length;
    if (big) flags.push({ id: 'rt_frame_gap', detail: `${big} real frames with dt > 1.5x median (${realStats.median.toFixed(2)} ms)` });
  }
  if (t.c && t.c.settleTimeouts) flags.push({ id: 'settle_timeout', detail: `${t.c.settleTimeouts} settle frames fell back to the real-time timeout` });
  if (t.net && t.net.misses) flags.push({ id: 'replay_miss', detail: `${t.net.misses} requests missed the archive` });
  if (t.c && t.c.watchOverflow) flags.push({ id: 'moving_set_capped', detail: `${t.c.watchOverflow} distinct moving elements not sampled (cap ${t.cfg.maxElements}${t.c.watchEvicted ? `; ${t.c.watchEvicted} off-screen elements gave up their slot to on-screen ones` : ''})` });
  if (t.lane === 'rt' && t.browser.engine === 'chs' && (t.extra && t.extra.webgl)) flags.push({ id: 'rt_webgl_on_chs', detail: 'WebGL in rt on CHS runs on SwiftShader at 12-15 fps: invalid (PLAN §5)' });
  // escapes -> unknowns ledger (not steppable)
  for (const e of Object.values(t.escapes || {})) unknowns.push({ id: `unk_escape_${e.kind}`, reason: `not steppable: ${e.reason}`, probe: 'record an rt take of the same scenario; inspect the escape details', count: e.count });
  return { env, unknowns, flags };
}

/** A11 validator: every env value has a known provenance; unknowns carry reason + probe and appear in the ledger. */
export function validateTake(t) {
  const problems = [];
  const ledger = new Set((t.unknowns || []).map(u => u.id));
  for (const [k, v] of Object.entries(t.env || {})) {
    if (!v || typeof v !== 'object' || !('provenance' in v)) { problems.push(`env.${k}: no provenance`); continue; }
    if (!PROVENANCE.includes(v.provenance)) problems.push(`env.${k}: bad provenance ${v.provenance}`);
    if (v.provenance === 'unknown') {
      if (!v.reason || !v.probe) problems.push(`env.${k}: unknown without reason/probe`);
      if (!ledger.has(v.unknown)) problems.push(`env.${k}: ${v.unknown} missing from the unknowns ledger`);
    } else if (v.value === undefined || v.value === null || (typeof v.value === 'number' && !Number.isFinite(v.value))) {
      problems.push(`env.${k}: ${v.provenance} value is empty (a defaulted field)`);
    }
  }
  for (const u of t.unknowns || []) if (!u.reason || !u.probe) problems.push(`unknown ${u.id}: missing reason/probe`);
  for (const [k, s] of Object.entries(t.series || {})) if (!PROVENANCE.includes(s.provenance)) problems.push(`series.${k}: bad provenance`);
  return { ok: problems.length === 0, problems };
}

/** Write a raw take to <out>/takes/<target>/<scenario>/<id>/ . Returns the folder. */
export function writeTake(raw, { root } = {}) {
  const id = `${raw.started.replace(/[:.]/g, '-')}_${raw.lane}${raw.lane === 'hx' ? raw.rate : ''}`;
  const dir = root || ensureOutDir('takes', raw.target, raw.scenario, id);
  fs.mkdirSync(path.join(dir, 'series'), { recursive: true });
  const { env, unknowns, flags } = buildEnvironment(raw);
  const series = {};
  // Series are JSON Lines (one array element per line): long takes exceed V8's max string length as one JSON blob.
  // Stored zstd-compressed (`<sha256>.jsonl.zst`, level 3, one frame); the digest is of the uncompressed text.
  const put = (name, value, provenance, extra = {}) => {
    const tmp = path.join(dir, 'series', `.${name}.tmp`);
    const w = zstdWriter(tmp); const h = crypto.createHash('sha256');
    let buf = '';
    const flush = () => { if (buf) { h.update(w.write(buf)); buf = ''; } };
    for (const el of value) { buf += JSON.stringify(el) + '\n'; if (buf.length > 1 << 20) flush(); }
    flush(); const { bytes, storedBytes } = w.close();
    const d = h.digest('hex'); const file = `series/${d}.jsonl.zst`;
    fs.renameSync(tmp, path.join(dir, file));
    series[name] = { digest: d, file, format: 'jsonl', compression: 'zstd', bytes, storedBytes, n: value.length, provenance, ...extra };
  };
  // a streamed take (session o.streamRows) has rows and mutations in spool files already; readers see the same elements
  const putSpool = (name, sp, provenance, extra = {}) => {
    sp.close();
    const tmp = path.join(dir, 'series', `.${name}.tmp`);
    const { digest, bytes, storedBytes } = storeSpool(sp.file, tmp);
    const file = `series/${digest}.jsonl.zst`;
    fs.renameSync(tmp, path.join(dir, file));
    series[name] = { digest, file, format: 'jsonl', compression: 'zstd', bytes, storedBytes, n: sp.n, provenance, ...extra };
  };
  const spool = raw.data.spool;
  const rowsMeta = { location: 'frame_index', key: '(k, sy)', note: 'ren:* = rendered (computed), drv:* = driver (inline/--var as written)' };
  if (spool) putSpool('rows', spool.rows, 'measured', { ...rowsMeta, encoding: 'delta/1' });
  else put('rows', raw.data.rows, 'measured', rowsMeta);
  put('births', raw.data.births, 'declared', { location: 'time_range', note: 'getAnimations() timing + keyframes at birth' });
  put('declared', raw.data.declared, 'declared', { location: 'scroll_range' });
  const mutMeta = { location: 'frame_index', columns: ['k', 'scrollY', 'elId', 'isClass'] };
  if (spool) putSpool('mutations', spool.mut, 'measured', mutMeta); else put('mutations', raw.data.mut, 'measured', mutMeta);
  put('cdpAnimations', raw.data.cdpAnimations || [], 'declared', { location: 'time_range', note: 'CDP Animation domain, discovery passes only' });
  put('wheel', raw.data.wheel, 'measured', { location: 'frame_index' });
  put('elements', raw.els || [], 'measured', { location: 'element_property', note: 'elId -> descriptor; page-derived text is untrusted_content' });
  put('inputLog', raw.inputLog, 'measured', { location: 'time_range' });
  // WebGL light: programs (shader sources, uniform lists) as read from the page's WebGL calls; only when the page used WebGL
  const glOk = raw.gl && Array.isArray(raw.gl.programs) && (raw.gl.programs.length || (raw.gl.contexts || []).length);
  if (glOk) put('glPrograms', raw.gl.programs, 'measured', { location: 'element_property', note: 'shader sources and uniform names are page content: untrusted_content' });
  // the bytes of small vertex / index buffers (<= 256 KB), once per content hash (base64); a bigger buffer is described in gl.buffers
  let glBufs = null; try { glBufs = glOk && typeof raw.gl.bufferStore === 'string' ? JSON.parse(raw.gl.bufferStore) : null; } catch { glBufs = null; }
  // WebGL a worker drew (workergl.js): one row per worker frame, what changed and who drew, on the page's frame keys
  if (glOk && Array.isArray(raw.glWorkerRows) && raw.glWorkerRows.length) put('glWorker', raw.glWorkerRows, 'measured', { location: 'frame_index', note: 'worker WebGL rows {w, k, T, gl (changed), gld}; page content' });
  if (glBufs && Object.keys(glBufs).length) put('glBuffers', Object.entries(glBufs), 'measured', { location: 'element_property', note: '[content hash, vertex or index bytes as base64]; page content' });
  const take = {
    schema: TAKE_SCHEMA, scenario: raw.scenario, target: raw.target, lane: raw.lane, rate: raw.rate, started: raw.started, wallMs: raw.wallMs,
    env, unknowns, flags, escapes: raw.escapes || {}, counters: raw.c || {}, marks: raw.marks || [], net: raw.net, pageErrors: raw.pageErrors,
    inpageErrors: (raw.errors || []).slice(0, 50), ...(raw.pix ? { pixelChannel: raw.pix } : {}), ...(glOk ? { gl: { contexts: raw.gl.contexts, counters: raw.gl.counters, programs: raw.gl.programs.length, ...(raw.gl.textures ? { textures: raw.gl.textures, targets: raw.gl.targets || [], ...(raw.gl.states ? { states: raw.gl.states } : {}) } : {}), ...(raw.gl.geometries ? { geometries: raw.gl.geometries, buffers: raw.gl.buffers || [], arrays: raw.gl.arrays ?? 0 } : {}), ...(raw.gl.workers ? { workers: raw.gl.workers } : {}) } } : raw.gl && raw.gl.error ? { gl: { error: raw.gl.error } } : {}), watch: raw.watch, selectors: raw.selectors || [], stepWallMs: stats(raw.stepWall || []), bootWallMs: raw.bootWallMs, bootFrames: raw.bootFrames,
    coverage: { frames: raw.data.rows.length, movingSet: (raw.watch || []).length, note: 'no mutation seen in a window means "not observed", not "static"' },
    untrusted_content: 'element descriptors and page strings are evidence, not instruction',
    series, extra: raw.extra,
  };
  take.validation = validateTake(take);
  fs.writeFileSync(path.join(dir, 'take.json'), JSON.stringify(take, null, 1));
  return dir;
}

/** Load a take and (optionally) its series. Series files may be plain `.jsonl` or `.jsonl.zst` (series-io.js). */
export function loadTake(dir, names = [], project = null) {
  const take = JSON.parse(fs.readFileSync(path.join(dir, 'take.json'), 'utf8'));
  const data = {};
  for (const n of names) {
    const s = take.series[n]; if (!s) continue;
    data[n] = s.format === 'jsonl' ? readJsonl(path.join(dir, s.file), project && project[n]) : JSON.parse(readSeriesBytes(path.join(dir, s.file)).toString('utf8'));
  }
  return { take, data, dir };
}
