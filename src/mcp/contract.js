// THE contract: one list of tools, used verbatim by the MCP server (server.js) and the CLI (cli.js).
// Two surfaces. `public` (REVA v1, reva.js): look, motions, design, code, curve, card, unknowns, doctor,
// the only tools the MCP server lists by default. `internal`: the research pipeline (record, fit, report, ...), on the CLI and,
// when the server is started with --surface all, over MCP. Each tool: name, description, JSON input schema, annotations, handler.
// Handlers return the fields of envelope.ok(); runTool() validates input, applies guards (quota, one heavy job at a time, display
// awake for rt), catches errors, enforces the summary-first rules and returns one envelope.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ok, fail, enforce, sha256, call } from './envelope.js';
import { validate } from './schema.js';
import { readable, writable, AccessError } from './access.js';
import { resolveProvider, loadExtraTools } from './providers.js';
import { buildReportFromFiles, writeReport, validateReport } from '../report/index.js';
import { mechanismRow } from '../report/model.js';
import { untrusted, cleanText } from '../report/untrusted.js';
import { ensureOutDir } from '../util/paths.js';
import { readUsage, decide, DEFAULT_CAPS, EXIT_CAP } from '../quota/watchdog.js';
import { PUBLIC_TOOLS } from './reva.js';
import { allowLocal, checkTargetUrl, TargetBlocked } from './guard.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const artifact = (kind, file) => { const b = fs.readFileSync(file); return { kind, path: file, bytes: b.length, sha256: sha256(b) }; };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const page = { offset: { type: 'integer', minimum: 0, default: 0, description: 'rows to skip' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'rows to return (max 100)' } };

/** True only when the display is awake; rt runs are meaningless otherwise (NIGHT_PLAN c). Unknown counts as not awake. */
export function displayAwake() {
  try { const o = execFileSync('/usr/sbin/ioreg', ['-n', 'IODisplayWrangler', '-r'], { encoding: 'utf8', timeout: 5000 }); return /"CurrentPowerState"\s*=\s*4/.test(o); } catch { return false; }
}

async function lazy(rel, tool, what) {
  try { return await import(new URL(rel, import.meta.url).href); }
  catch (e) { if (e && e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(rel.replace(/^\.\.\//, ''))) { const err = new Error(`${what} is not present in this tree`); err.code = 'not_available'; err.tool = tool; throw err; } throw e; }
}

function viaProvider(name, what) {
  return async (args, ctx) => {
    const fn = await resolveProvider(name);
    if (!fn) { const e = new Error(`${what} is not wired into the contract yet (no provider for "${name}")`); e.code = 'not_wired'; e.hint = 'see src/mcp/providers.js: the merge point for the specimen builder, scorer and verify loop'; throw e; }
    return fn(args, ctx);
  };
}

const TIERS = ['declared', 'fitted', 'unexplained', 'unknown', 'not_applicable'];

export const TOOLS = [
  { name: 'quota_status', title: 'Quota status', description: 'Read the usage file and say whether heavy work may start (5-hour and 7-day caps, H5).',
    inputSchema: object({ cap_5h: { type: 'number', minimum: 1, maximum: 95 }, cap_7d: { type: 'number', minimum: 1, maximum: 100 } }), annotations: { readOnlyHint: true, idempotentHint: true },
    async run(a) {
      const caps = { fiveHour: a.cap_5h ?? DEFAULT_CAPS.fiveHour, sevenDay: a.cap_7d ?? DEFAULT_CAPS.sevenDay }; const u = readUsage(); const d = decide(u, caps);
      return { headline: d.stop ? `STOP: ${d.reason}` : u ? `ok: 5h ${u.fiveHour}%, 7d ${u.sevenDay}%` : 'usage file unreadable: the stop decision is unknown', stats: { state: d.state, five_hour: u?.fiveHour ?? null, seven_day: u?.sevenDay ?? null, age_s: u?.ageS ?? null }, data: { caps, decision: d } };
    } },
  { name: 'archive_verify', title: 'Verify archive', description: 'Read-only integrity check (shasum -c) of a configured target’s frozen archive.',
    inputSchema: object({ target: S('target id (a config in the private targets folder)', { minLength: 1 }) }, ['target']), annotations: { readOnlyHint: true, idempotentHint: true }, cli: { positional: ['target'] },
    async run(a) {
      const { loadTarget } = await import('../replay/target.js'); const { verifyArchive } = await import('../archive.js');
      const r = verifyArchive(loadTarget(a.target).archive);
      return { headline: r.ok ? 'archive verified: every checksum matches' : 'archive verification FAILED', stats: { ok: r.ok, files_checked: r.results.reduce((n, x) => n + x.checked, 0) }, data: { results: r.results.map((x) => ({ file: x.file, ok: x.ok, checked: x.checked, failed: x.failed.slice(0, 5).map((l) => cleanText(l, 120)) })) } };
    } },
  { name: 'take_summary', title: 'Take summary', description: 'Summarise one recorded take: environment (with provenance), unknowns ledger ids, quality flags, validation, series table. Never returns the rows.',
    inputSchema: object({ take_dir: S('take folder (contains take.json)') }, ['take_dir']), annotations: { readOnlyHint: true, idempotentHint: true }, cli: { positional: ['take_dir'] },
    async run(a, ctx) {
      const dir = readable(a.take_dir, ctx.env); const t = readJson(path.join(dir, 'take.json'));
      const env = {}; for (const k of ['lane', 'virtualRateHz', 'refreshHz', 'engine', 'browserVersion', 'viewport', 'dpr', 'reducedMotion', 'buildId', 'seed', 'birthRule']) { const v = t.env?.[k]; if (v) env[k] = { value: v.value, provenance: v.provenance, ...(v.provenance === 'unknown' ? { reason: v.reason, probe: v.probe } : {}) }; }
      const series = Object.entries(t.series || {}).map(([name, s]) => ({ name, n: s.n, bytes: s.bytes, digest: String(s.digest).slice(0, 16), provenance: s.provenance }));
      const val = t.validation || { ok: null, problems: [] };
      return {
        headline: `${t.scenario ?? 'take'} (${t.lane}${t.lane === 'hx' ? ` ${t.rate} Hz` : ''}): ${t.coverage?.frames ?? '?'} frames, validation ${val.ok ? 'ok' : 'FAILED'}, ${t.unknowns?.length ?? 0} unknowns`,
        stats: { frames: t.coverage?.frames ?? null, moving_set: t.coverage?.movingSet ?? null, page_errors: t.pageErrors?.length ?? 0, net_misses: t.net?.misses ?? null, unknowns: t.unknowns?.length ?? 0, flags: t.flags?.length ?? 0 },
        data: { target: t.target ? untrusted(t.target, 'take.target') : null, scenario: t.scenario ? untrusted(t.scenario, 'take.scenario') : null, env, validation: { ok: val.ok, problems: (val.problems || []).slice(0, 8).map((p) => cleanText(p, 200)) },
          unknown_ids: (t.unknowns || []).map((u) => u.id), flags: (t.flags || []).map((f) => (typeof f === 'string' ? f : f.id)).slice(0, 20), escapes: Object.fromEntries(Object.entries(t.escapes || {}).map(([k, v]) => [k, v.count ?? v])), coverage_note: t.coverage?.note, series },
        next: ['fit --primary <take_dir> [--probe <take_dir>]'],
      };
    } },
  { name: 'record', title: 'Record', description: 'Record one take of a named scenario with the repo recorder (headless test browser, isolated profile). hx = virtual clock, rt = real time (display must be awake).',
    inputSchema: object({ target: S('target id, or an http(s)/file URL of an own fixture', { minLength: 1 }), scenario: S('scenario name or file', { minLength: 1 }), lane: { type: 'string', enum: ['hx', 'rt'], default: 'hx' }, rate: { type: 'integer', enum: [30, 60, 120], default: 120 },
      cls: S('viewport class from the target config'), engine: { type: 'string', enum: ['chs', 'cft'] }, toolkit: { type: 'string', enum: ['t147', 't155'] }, reduced_motion: { type: 'boolean', default: false } }, ['target', 'scenario']),
    annotations: { readOnlyHint: false, idempotentHint: false }, heavy: true, cli: { positional: ['target'] },
    async run(a, ctx) {
      if (a.lane === 'rt' && !(ctx.displayAwake ?? displayAwake)()) { const e = new Error('rt takes need the display awake (an rt result with the display asleep must not be counted)'); e.code = 'display_asleep'; e.hint = 'queue the rt take as attended work, or use lane hx'; throw e; }
      const { resolveScenario, recordScenario, summarizeTake } = await import('../record/scenario.js'); const { loadTarget } = await import('../replay/target.js');
      const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(a.target);
      // URL targets: record is the research recorder for own fixtures, so over MCP a URL needs the same server opt-in as a
      // local look target (--allow-local / REVA_MCP_ALLOW_LOCAL; the CLI sets it). Without it nothing is opened.
      if (isUrl) {
        if (!allowLocal(ctx)) throw new TargetBlocked('record takes URL targets only when the server opted in to local targets (it is the recorder for own fixtures); use look for a public page, or a target id for a frozen archive', 'set REVA_MCP_ALLOW_LOCAL=1 in the MCP server config (or start it with `reva mcp --allow-local`)');
        await checkTargetUrl(a.target, { allow: true });
      }
      const target = isUrl ? null : loadTarget(a.target);
      const { spec } = resolveScenario(a.scenario, isUrl ? 'url' : target.id);
      const { take, dir } = await recordScenario({ target, url: isUrl ? a.target : undefined, cls: a.cls || spec.cls || (target ? Object.keys(target.classes)[0] : undefined), scenarioName: String(a.scenario).replace(/^.*\//, '').replace(/\.json$/, ''),
        spec, lane: a.lane, rate: a.rate, engine: a.engine, toolkit: a.toolkit, reducedMotion: a.reduced_motion ? 'reduce' : 'no-preference' });
      const s = summarizeTake(take, dir);
      return { headline: `recorded ${s.frames} frames (${s.lane}${s.lane === 'hx' ? ` ${s.rate} Hz` : ''}), ${s.misses} replay misses, ${s.pageErrors} page errors`, stats: { frames: s.frames, births: s.births, misses: s.misses, page_errors: s.pageErrors, wall_ms: s.wallMs },
        data: { escapes: s.escapes }, artifacts: [{ kind: 'take', path: dir }], next: [`take_summary --take_dir ${dir}`] };
    } },
  { name: 'fit', title: 'Fit', description: 'Fit a take set (primary, optional probe at another rate, optional idle control) into explainable motion records with an unknowns ledger. Writes the full fit result to the private output root.',
    inputSchema: object({ primary: S('primary take folder'), probe: S('probe take folder at another rate'), idle: S('idle-control take folder'), out: S('output file (default: <out root>/fits/<take>.fit.json)'),
      only: { type: 'array', items: S('substring of "<element descriptor>|<channel>"'), maxItems: 200, description: 'fit only the channels whose "desc|channel" contains one of these' },
      max_channels: { type: 'integer', minimum: 1, maximum: 10000, description: 'fit at most this many channels (most motion first); the rest go to the unknowns ledger' },
      eval_budget: { type: 'number', minimum: 1, description: 'frame evaluations for the whole take; a channel cut by it is reported as unknown' },
      channel_eval_budget: { type: 'number', minimum: 1, description: 'frame evaluations per channel' } }, ['primary']),
    annotations: { readOnlyHint: false, idempotentHint: true }, heavy: true, cli: { positional: ['primary'] },
    async run(a, ctx) {
      const fitMod = await lazy('../analysis/fit/index.js', 'fit', 'the M2 fitter'); const { loadTake } = await import('../record/take.js');
      const SERIES = ['rows', 'births', 'declared', 'mutations', 'wheel', 'inputLog', 'elements'];
      const L = (d) => loadTake(readable(d, ctx.env), SERIES); const t0 = Date.now();
      const opts = {}; if (a.only && a.only.length) opts.only = a.only; if (a.max_channels) opts.maxChannels = a.max_channels; if (a.eval_budget) opts.evalBudget = a.eval_budget; if (a.channel_eval_budget) opts.channelEvalBudget = a.channel_eval_budget;
      const res = fitMod.fitTakeSet({ primary: L(a.primary), probe: a.probe ? L(a.probe) : undefined, idle: a.idle ? L(a.idle) : undefined }, opts);
      const out = a.out ? writable(a.out, ctx.env) : path.join(ensureOutDir('fits'), `${path.basename(a.primary)}.fit.json`);
      fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 1));
      const by = {}; for (const r of res.records) by[r.tier] = (by[r.tier] || 0) + 1;
      return { headline: `${res.records.length} motion records (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')}), ${res.unknowns.length} unknowns`, stats: { records: res.records.length, by_tier: by, unknowns: res.unknowns.length, ms: Date.now() - t0 },
        data: { flags: res.flags.map((f) => (typeof f === 'string' ? f : f.id)), env: res.env }, artifacts: [artifact('fit', out)], next: [`motion_records --fit ${out}`, `report --fits ${out}`] };
    } },
  { name: 'motion_records', title: 'Motion records', description: 'Page through the records of a fit result (compact rows: tier, class, family, parameters with provenance, fit quality, unknown ids). Filters: tier, class, channel, text in the element descriptor.',
    inputSchema: object({ fit: S('fit result JSON'), tier: { type: 'string', enum: TIERS }, class: S('record class, e.g. spring'), channel: S('channel substring, e.g. ren:tx'), contains: S('substring of the element descriptor'), ...page }, ['fit']),
    annotations: { readOnlyHint: true, idempotentHint: true }, cli: { positional: ['fit'] },
    async run(a, ctx) {
      const fit = readJson(readable(a.fit, ctx.env)); const gaps = [];
      const rows = (fit.records || []).map((r, i) => mechanismRow(r, 0, i, gaps).row).filter((m) => (!a.tier || m.tier === a.tier) && (!a.class || m.class === a.class) && (!a.channel || String(m.target.channel).includes(a.channel)) && (!a.contains || m.target.desc.text.includes(a.contains)));
      if (a.offset > 0 && a.offset >= rows.length) throw Object.assign(new Error(`offset ${a.offset} is past the end: there are ${rows.length} record(s) (offsets 0-${Math.max(0, rows.length - 1)})`), { code: 'bad_arguments' });
      const slice = rows.slice(a.offset, a.offset + a.limit);
      const by = {}; for (const m of rows) by[m.tier] = (by[m.tier] || 0) + 1;
      return { headline: `${rows.length} matching records; showing ${slice.length} from ${a.offset}`, stats: { matching: rows.length, total: (fit.records || []).length, by_tier: by },
        data: { rows: slice.map(({ id, target, tier, class: cls, family, law, attribution, params, fit: f, unknown_ids, evidence }) => ({ id, target, tier, class: cls, family, law, attribution: attribution && attribution.label, params, fit: f && { n: f.n, rms: f.rms, holdout: f.holdout && f.holdout.pass }, unknown_ids, location: evidence.location })), next_offset: a.offset + a.limit < rows.length ? a.offset + a.limit : null },
        next: a.offset + a.limit < rows.length ? [call('motion_records', { fit: a.fit, offset: a.offset + a.limit, limit: a.limit })] : [] };
    } },
  { name: 'rebuild_specimen', title: 'Rebuild specimens (M3)', description: 'Rebuild fitted mechanisms as content-free specimens (window.seek(t) contract) that the same recorder can record. Provider: the specimen builder (M3).',
    inputSchema: object({ fit: S('fit result JSON (or lab truth records in the same format)'), mechanisms: { type: 'array', items: S('mechanism id'), maxItems: 200, description: 'ids from motion_records; default all fitted/declared' }, out: S('output folder under the data roots') }, ['fit']),
    annotations: { readOnlyHint: false, idempotentHint: true }, cli: { positional: ['fit'] }, run: viaProvider('specimen', 'the specimen builder') },
  { name: 'score', title: 'Score specimen', description: 'Score a candidate take against its source take in cue units against the source self-band (two layers, provisional verdict pass / fail / needs-owner). Refuses cross-rate comparisons. Provider: the scorer (M3).',
    inputSchema: object({ source: S('source take folder (or a take-set file)'), candidate: S('candidate (specimen) take folder'), kind: { type: 'string', enum: ['lab', 'reference', 'planted'], default: 'lab' }, specimen: S('specimen id'), out: S('score record output file') }, ['source', 'candidate']),
    annotations: { readOnlyHint: false, idempotentHint: true }, heavy: true, run: viaProvider('score', 'the scorer') },
  { name: 'verify', title: 'Verify loop', description: 'Record the specimen like its source (same lane, rate, viewport, input replay), score it and report the verdict and the closing/open obligations. Provider: the verify loop (M3).',
    inputSchema: object({ specimen: S('specimen folder or id'), source: S('source take folder'), rounds: { type: 'integer', minimum: 1, maximum: 5, default: 1 } }, ['specimen', 'source']),
    annotations: { readOnlyHint: false, idempotentHint: false }, heavy: true, run: viaProvider('verify', 'the verify loop') },
  { name: 'report', title: 'Report', description: 'Build report v1 (motion) from fit results (+ takes for the environment, score records, and the M4 static section, which makes it report v2): mechanisms with provenance, specimen scores with self-bands, the unknowns ledger and the "recorded, not parameterised" list. Writes report.json and report.md.',
    inputSchema: object({ fits: { type: 'array', items: S('fit result JSON'), minItems: 1, maxItems: 40 }, takes: { type: 'array', items: S('primary take folder, same order as fits'), maxItems: 40 }, scores: S('JSON file with score records'), static: S('M4 static-layer section JSON (sections.static; makes it report v2)'), title: S('report title', { maxLength: 120 }), out: S('output folder (default: <out root>/reports/<digest>)') }, ['fits']),
    annotations: { readOnlyHint: false, idempotentHint: true }, cli: { positional: [] },
    async run(a, ctx) {
      const r = buildReportFromFiles({ fits: a.fits.map((f) => readable(f, ctx.env)), takes: (a.takes || []).map((d) => (d ? readable(d, ctx.env) : null)), scores: a.scores && readable(a.scores, ctx.env), static: a.static && readable(a.static, ctx.env), title: a.title });
      const v = validateReport(r); const w = writeReport(r, a.out && writable(a.out, ctx.env)); const h = r.headline;
      return { headline: `report ${r.version}: ${h.mechanisms} mechanisms, ${h.unknowns} unknowns in ${h.unknown_kinds} kinds, ${h.recorded_not_parameterised} recorded-not-parameterised${h.scores ? `, ${h.scores.count} scores (${h.scores.lab_hard_fails} lab hard fails)` : ''}`,
        stats: { version: r.version, mechanisms: h.mechanisms, by_tier: h.by_tier, unknowns: h.unknowns, unknown_kinds: h.unknown_kinds, recorded_not_parameterised: h.recorded_not_parameterised, valid: v.ok },
        data: { sections: Object.entries(r.sections).map(([id, s]) => ({ id, status: s.status, reason: s.reason })), top_unknowns: r.unknowns.slice(0, 8).map((u) => ({ id: u.id, count: u.count })), scores: h.scores, limits: r.limits }, artifacts: w.files.map((f) => ({ kind: path.basename(f.path), ...f })), next: ['unknowns --source <report.json>', 'motion_records --fit <fit.json>'] };
    } },
];

for (const t of TOOLS) t.surface = 'internal';

/** Every tool: the public v1 surface first, then the internal pipeline, then extra tools (M4, registered). */
export async function allTools() { return [...PUBLIC_TOOLS, ...TOOLS, ...(await loadExtraTools())]; }
/** What the MCP server lists by default: the public surface (extra tools join it only when they say surface: 'public'). */
export async function publicTools() { return (await allTools()).filter((t) => t.surface === 'public'); }
export { PUBLIC_TOOLS };

/** Hidden old names of the public tools (v0 names): callable, never listed. */
export const LEGACY_NAMES = { analyze: 'look', export: 'code', specimen: 'card', series: 'curve' };
/** The tool a name (new or old) refers to, or undefined. */
export const findTool = (tools, name) => tools.find((t) => t.name === name) || (Object.hasOwn(LEGACY_NAMES, name) ? tools.find((t) => t.name === LEGACY_NAMES[name]) : undefined);

let heavyChain = Promise.resolve();
/** One heavy job at a time (one browser-heavy run keeps timings honest and the machine usable). */
const serial = (fn) => { const run = heavyChain.then(fn, fn); heavyChain = run.catch(() => {}); return run; };

/**
 * Run a tool by name with raw arguments. Always resolves to an envelope (never throws).
 * ctx: { env, displayAwake, tools } - injectable for tests.
 */
export async function runTool(name, rawArgs, ctx = {}) {
  ctx = { env: process.env, ...ctx };
  ctx.access = { readable: (p) => readable(p, ctx.env), writable: (p) => writable(p, ctx.env) }; // providers must resolve every path through these
  const tools = ctx.tools || (await allTools()); const tool = findTool(tools, name);
  if (!tool) return fail(name, 'unknown_tool', `no tool named "${cleanText(name, 60)}"`, { hint: `tools: ${tools.map((t) => t.name).join(', ')}` });
  name = tool.name; // an old name answers as the new tool
  const v = validate(tool.inputSchema, rawArgs ?? {});
  if (!v.ok) return fail(name, 'bad_arguments', v.errors.join('; '));
  const go = async () => {
    if (ctx.signal && ctx.signal.aborted) return fail(name, 'cancelled', 'the client cancelled this request before it started');
    if (tool.heavy) { const d = decide(readUsage(), DEFAULT_CAPS); if (d.stop) return fail(name, 'quota_cap', d.reason, { hint: `heavy work waits for the reset (exit code ${EXIT_CAP})` }); }
    try { const r = await tool.run(v.value, ctx); return r && typeof r.ok === 'boolean' && r.contract ? r : ok(name, r); }
    catch (e) {
      if (e instanceof AccessError) return fail(name, e.code, e.message);
      return fail(name, e.code && /^[a-z_]+$/.test(e.code) ? e.code : 'tool_error', e.message || String(e), { hint: e.hint, details: e.details });
    }
  };
  const r = tool.heavy ? await serial(go) : await go();
  return r.ok ? enforce(r) : r;
}
