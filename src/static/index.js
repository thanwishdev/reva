// Static layer entry (M4 part "static"). Integrator wiring: `reva static <url> [--out DIR] [--engine cft|chs]
// [--no-dembrandt] [--allow-live]` -> main(argv) below (also runnable as `node src/static/run.js ...`).
import fs from 'node:fs';
import path from 'node:path';
import { extractStatic, writeRecord, loadElements, assertLocalTarget, DEFAULT_VARIANTS } from './extract.js';
import { runDembrandt } from './dembrandt.js';
import { loadTarget, seedScript, OFFLINE_ARGS } from '../replay/target.js';
import { harPaths } from '../replay/target.js';
import { wireReplay } from '../replay/replay.js';
import { buildStaticSection, renderStaticMarkdown, mergeStaticSection } from './report.js';
import { defaultEngine } from '../browser/engines.js';

export { extractStatic, writeRecord, loadElements, assertLocalTarget, DEFAULT_VARIANTS, runDembrandt, buildStaticSection, renderStaticMarkdown, mergeStaticSection };
export { STATIC_SCHEMA, PROVENANCE } from './prov.js';

/**
 * Full static run: extraction (one browser session), then dembrandt in a second, separate session, then the report section.
 * Sessions are sequential and never shared with a motion take.
 */
export async function runStatic({ url, outDir, engine = defaultEngine(), dembrandt = true, allowLive = false, variants, sweep, replay = null, log = () => {} } = {}) {
  // replay = { target, cls }: serve the page from a frozen archive (offline, DNS disabled, misses counted). No live load.
  let replayNet = null; let extra = {};
  if (replay) {
    url = url || replay.target.startUrl;
    extra = { offlineReplay: true, launchArgs: OFFLINE_ARGS, prepare: async (ctx) => {
      replayNet = await wireReplay(ctx, harPaths(replay.target, replay.cls), { blockRegex: replay.target.blockRegex ? new RegExp(replay.target.blockRegex) : null });
      await ctx.addInitScript(seedScript(replay.target.seed));
    } };
    dembrandt = false; // dembrandt drives its own browser session, which cannot be given the archive routes
  } else assertLocalTarget(url, allowLive);
  const { record, outDir: dir, ledger } = await extractStatic({ url, outDir, engine, allowLive, variants, sweep, log, ...extra });
  if (replay) {
    record.environment.archiveReplay = { value: { target: replay.target.id, cls: replay.cls, misses: replayNet.misses.length, missSample: replayNet.misses.slice(0, 20), blocked: replayNet.blocked.length }, provenance: 'measured', from: 'wireReplay' };
  }
  if (dembrandt) {
    log('dembrandt (own session)');
    const d = await runDembrandt({ url, engine, outDir: dir });
    record.hints.dembrandt = d.hints;
    for (const u of d.ledger.list()) if (!record.unknowns.some(x => x.id === u.id && x.scope === u.scope)) record.unknowns.push(u);
    record.environment.dembrandtSession = { value: { separateBrowserLaunch: true, wallMs: d.wallMs ?? null }, provenance: 'measured', from: 'runStatic' };
    record.environment.session = { ...record.environment.session, value: { ...record.environment.session.value, browserLaunches: 2, note: 'static pass: 1 session; dembrandt: 1 further separate session (it injects a freeze-motion style)' } };
  } else {
    record.unknowns.push({ id: 'unk_dembrandt_skipped', reason: replay ? 'dembrandt was not run: it uses its own browser session, which cannot be given the archive routes (archive replay)' : 'dembrandt was not run for this record (--no-dembrandt)', probe: replay ? 'freeze the archive behind a local server and point dembrandt at it' : 'rerun without --no-dembrandt', scope: 'dembrandt' });
  }
  const section = buildStaticSection(record);
  const files = {
    record: writeRecord(record, dir),
    section: path.join(dir, 'static-section.json'),
    markdown: path.join(dir, 'static-report.md'),
  };
  fs.writeFileSync(files.section, JSON.stringify(section, null, 2));
  fs.writeFileSync(files.markdown, renderStaticMarkdown(section));
  return { record, section, files, outDir: dir };
}

export async function main(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i]; else if (a === '--engine') args.engine = argv[++i];
    else if (a === '--replay') args.replay = argv[++i]; else if (a === '--cls') args.cls = argv[++i];
    else if (a === '--no-dembrandt') args.noDembrandt = true; else if (a === '--allow-live') args.allowLive = true;
    else if (a === '--help' || a === '-h') args.help = true; else args._.push(a);
  }
  if (args.help || (!args._[0] && !args.replay)) { console.log('usage: static <url>|--replay <targetId> [--cls A] [--out DIR] [--engine cft|chs] [--no-dembrandt] [--allow-live]\n  localhost / file: targets only unless --allow-live (needs the owner\'s OK)'); return args.help ? 0 : 2; }
  const replay = args.replay ? (() => { const target = loadTarget(args.replay); return { target, cls: args.cls || Object.keys(target.classes)[0] }; })() : null;
  const r = await runStatic({ url: args._[0], replay, outDir: args.out, engine: args.engine || defaultEngine(), dembrandt: !args.noDembrandt, allowLive: !!args.allowLive, log: m => console.error(`[static] ${m}`) });
  console.log(JSON.stringify({ id: r.record.id, outDir: r.outDir, wallMs: r.record.wallMs, edges: r.record.breakpoints.edges.length, unknowns: r.record.unknowns.length, files: r.files }, null, 2));
  return 0;
}
