// Stage D1 suite: score the rule-table capture with the stage G gate.
//   orig1..orig4  identical replays (noise caps from 1-2, 1-3, 2-3; identity = 4 vs 1), as in runGateSuite
//   cap           one more replay per class with CDP rule-usage tracking from before navigation; at the captured
//                 point the rule table is captured (table-<cls>.json) and its own snapshot is checked against orig1
//   rb            the rebuild rendered from each class's table alone (no script runs), at EVERY point of that class;
//                 script-owned values replayed at held-out points (scriptOwnedPlan)
//                 (captured and held-out) vs orig1: element oracle + pixel check; source audit + provenance
//   mutants       N corrupted tables (re-rendered) at the mutated class's captured point; each must fail
// Declared exceptions (`excuse`, e.g. a state D2 owns) are counted and listed per point, never dropped.
import fs from 'node:fs';
import path from 'node:path';
import { captureRun, compareRuns, summarize, noiseCapsFrom, auditRun, gzRead, frames, advance, newGatePools, unpaintableAt } from './run.js';
import { identityUnstable, statusOf, opaqueUnder } from './stability.js';
import { captureRuntimeState, saveRuntimeState, loadRuntimeState, applyRuntimeState } from './runtimeemit.js';
import { decodeStyle } from './snapshot.js';
import { renderRebuild, tableMutants } from './rebuild.js';
import { openCss, startRuleUsage } from '../static/cdpcss.js';
import { captureRuleTable, mergeUsage } from '../static/ruletable.js';
import { collectWrites, ownedAt, injectOwned, writtenStateAt, structureAt, enterTopLayer, loadImagesLike } from './scriptowned.js';
import { labelFailures, rebuildEvidence, sessionEvidence } from './causes.js';

const under = (k, o) => k === o || k.startsWith(o + '/') || k.startsWith(o + '#');
const WHY = ph => ph === 'sweep' ? 'scroll' : ph === 'settle' ? 'timer-after-load' : ph === 'probe:time' || ph.startsWith('pt:') ? 'time' : ph === 'probe:resize' ? 'viewport' : ph;

/** Script writers seen by the capture session (load, sweep, captured point, then a time probe at the fixed viewport
 *  and a resize probe), as recorded by scriptowned.js: the capture's `scriptOwned` list, each with its evidence. */
export function declareOwned(sw) {
  return Object.entries(sw?.els || {}).map(([k, names]) => ({
    k, why: [...new Set(Object.values(names).flatMap(x => x.phases.map(WHY)))],
    names: Object.fromEntries(Object.entries(names).map(([n, x]) => [n, { where: x.where, writes: x.writes, phases: x.phases.map(WHY).filter((v, i, a) => a.indexOf(v) === i), sizes: x.sizes.length }])),
  }));
}

/** captureRun hook: rule table at the captured point. usage=false: CDP is attached only at capture time, so the
 *  session is an ordinary replay (the table used for the rebuild). usage=true: rule-usage tracking from before
 *  navigation (a separate replay; tracking slows style recalc, which shifted real-time-driven JS state on a real site). */
export function ruleTableCapture({ usage = false } = {}) {
  return {
    beforeGoto: usage ? async h => { const css = await openCss(h.context, h.page); await startRuleUsage(css); return css; } : null,
    at: async (h, css0, cls, pt, dir) => {
      const css = css0 || await openCss(h.context, h.page);
      try {
        const t = await captureRuleTable(h.page, css, { usage }); fs.writeFileSync(path.join(dir, `table-${cls}.json`), JSON.stringify(t));
        // S3: runtime style state at the same moment (registered properties, JS FontFaces, WAAPI values)
        saveRuntimeState(await captureRuntimeState(h.page), dir, cls);
      } finally { if (!css0) await css.close(); }
    },
    // capture session only: probe which elements page script writes (time at the fixed viewport, then a resize
    // there and back) after the screenshot, and record them in the table as script-owned with the evidence
    after: usage ? null : async (h, css0, cls, pt, dir) => {
      const page = h.page;
      await page.evaluate(() => { if (window.__wrSW) window.__wrSW.phase = 'probe:time'; });
      await advance(page, h.flight, 3000);
      await page.evaluate(() => { if (window.__wrSW) window.__wrSW.phase = 'probe:resize'; });
      for (const [w, hh] of [[pt.w, pt.h - 37], [pt.w - 37, pt.h], [pt.w, pt.h]]) { await page.setViewportSize({ width: w, height: hh }); await frames(page, 2); await advance(page, h.flight, 1000); }
      const sw = await collectWrites(page, null);
      const tf = path.join(dir, `table-${cls}.json`);
      const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
      t.scriptOwned = declareOwned(sw);
      t.scriptOwnedNote = 'elements page script wrote after load in the capture session (MutationObserver; first script frame per written attribute); their script-set values are the motion layer\'s (src/record, src/analysis), excluded from the CSS gate only where they differ from the captured point';
      fs.writeFileSync(tf, JSON.stringify(t));
    },
    close: async css => { if (css) await css.close(); },
  };
}

/** Script-owned plan for a rebuild run: orig1's script-written state at each point P vs at its class's captured point
 *  (ownedAt), each owned element backed by recorder evidence (else listed as undeclared and not excused).
 *  Attribute writes are replayed into the rebuild at P (inject) and then compared like everything else: the CSS has to
 *  react to the script's values exactly as the original does. Only what a replay cannot set is excluded (oracle skip +
 *  pixel mask): script-inserted/removed nodes and script-written text. */
export function scriptOwnedPlan(origDir, points, capPts, tables) {
  const report = { perPoint: {}, undeclared: {} };
  const ownedKeys = {}, inject = {};
  const rd = f => (fs.existsSync(path.join(origDir, f)) ? gzRead(path.join(origDir, f)) : null);
  const tx = s => new Map(s.els.map(e => [e.k, e.t]));
  for (const pt of points) {
    const c = capPts.find(p => p.cls === pt.cls);
    if (pt.id === c.id) continue;
    const own = ownedAt(rd(`sw-${c.id}.json.gz`), rd(`sw-${pt.id}.json.gz`), tx(rd(`${c.id}.json.gz`)), tx(rd(`${pt.id}.json.gz`)));
    // evidence: a written entry exists only because the recorder saw script change it after load (swP, with the
    // first script frame); an inserted/removed node needs a recorded child-list write on an ancestor. Whether the
    // capture session itself already saw the writer is reported (declaredInCapture), not required: some writers only
    // fire across a breakpoint the capture never visits (a real site: a section's script-written sizes below 861 px).
    const swC = rd(`sw-${c.id}.json.gz`), swP = rd(`sw-${pt.id}.json.gz`);
    const decl = tables[pt.cls].scriptOwned || [];
    const listWriter = k => [swP, swC].some(sw => Object.entries(sw?.els || {}).some(([dk, n]) => n.childList && dk !== k && under(k, dk)));
    const ok = e => e.how === 'written' || listWriter(e.k);
    const good = own.filter(ok), bad = own.filter(e => !ok(e));
    const inCapture = e => e.how === 'written' ? Object.keys(e.names).every(n => decl.some(d => d.k === e.k && d.names[n])) : decl.some(d => d.names.childList && d.k !== e.k && under(e.k, d.k));
    // structural replay (D2): script-written text and inserted/removed nodes get the script's recorded output at P
    // (child-list markup / own text); only entries with no recorded output stay excluded (oracle skip + pixel mask)
    const st = structureAt(good.filter(e => e.how !== 'written' || e.names.text), swP);
    const excluded = st.rest;
    ownedKeys[pt.id] = excluded.map(e => e.k);
    // replay: structure first, then every script-written attribute at its value at P (restores earlier points' too)
    inject[pt.id] = [...st.replay, ...writtenStateAt(swP)];
    if (bad.length) report.undeclared[pt.id] = bad.slice(0, 10);
    const ev = e => ({ k: e.k, how: e.how, names: Object.fromEntries(Object.entries(e.names).map(([n, x]) => [n, { c: x.c?.slice(0, 80), p: x.p?.slice(0, 80), where: x.where, phases: x.phases?.slice(0, 4) }])) });
    report.perPoint[pt.id] = { owned: good.length, changed: good.filter(e => e.how === 'written').length, replayed: inject[pt.id].length, structureReplayed: st.replay.map(x => ({ k: x.k, kind: x.html != null ? 'html' : 'text' })), excluded: excluded.length, undeclared: bad.length, notSeenByCapture: good.filter(e => !inCapture(e)).length, excludedList: excluded.slice(0, 20).map(ev), replayedSample: good.filter(e => e.how === 'written').slice(0, 6).map(ev) };
  }
  return { report, ownedKeys, inject };
}

/** Noise caps and identity from the identical original replays in `out` (orig1..orig4, or orig1+orig2 in lite), as
 *  the suite judges them; on a failing identity, the unstable regions per point (stability.js), never masked.
 *  Exported so an identity-only check (corpus S2: two replays of an archive) runs exactly the suite's code. */
/** Identity is about real replay differences. A point whose screenshot was skipped (deterministically, same clip in both
 *  replays) has no pixel verdict, but its oracle is compared: it counts as identical when the oracle passes, and the skip is
 *  reported through shotSkipped / partial, not as "replays differ". */
export function identityJudged(identity) {
  return Object.fromEntries(Object.entries(identity).map(([k, x]) => [k, x.shotSkipped && x.oracle.pass ? { ...x, pass: true } : x]));
}
export function identityCheck(out, points, origs, { excuse = [] } = {}) {
  const D = n => path.join(out, n);
  const cmp = (a, b, pts, caps, heat) => compareRuns(D(a), D(b), pts, caps, { heatDir: heat ? D(heat) : null, excuse });
  const pairs = (origs.length >= 4 ? [['orig1', 'orig2'], ['orig1', 'orig3'], ['orig2', 'orig3']] : [['orig1', 'orig2']]).map(([a, b]) => cmp(a, b, points, null, `heat-noise-${a}-${b}`));
  const nz = noiseCapsFrom(pairs);
  const caps = nz.caps;
  const noise = { caps, perClass: nz.perClass, oraclePass: pairs.every(p => Object.values(p).every(x => x.oracle.pass)) };
  const idB = origs.includes('orig4') ? 'orig4' : 'orig2';
  const identity = cmp('orig1', idB, points, caps, 'heat-identity');
  const judged = identityJudged(identity);
  const rep = { summary: summarize(judged), shotSkipped: Object.keys(identity).filter(k => identity[k].shotSkipped), fails: Object.fromEntries(Object.entries(judged).filter(([, x]) => !x.pass).map(([k, x]) => [k, { oracle: x.oracle.byKind, pixel: x.pixel.reason }])) };
  if (Object.keys(rep.fails).length) rep.unstable = identityUnstable((side, id) => gzRead(D(`${side === 'a' ? 'orig1' : idB}/${id}.json.gz`)), judged);
  return { caps, noise, identity: rep, results: identity };
}

const exList = res => Object.fromEntries(Object.entries(res).filter(([, r]) => r.oracle.excused).map(([id, r]) => [id, r.oracle.excused.slice(0, 10)]));

/**
 * The replays of one capture suite, in the order they ask for the gate's session slots (FIFO, src/gate/limit.js).
 * 26 Oct S14, data first in every mode: orig1 (the snapshots and screenshots every reader uses), cap (the rule table) and
 * cov (its rule usage) are issued before the noise / verification replays, so a slow or stopped step has its data first.
 * verify 'data' (deep mode ก): orig1 + cap + cov + ONE noise replay (orig2; none for an inner page, noise=false), no T6
 * dump, then no rebuild, audit or mutants. verify 'full': the lite knobs' origs (2) or all four, as before.
 * @param {{verify?:'full'|'data', lite?:{origs?:number, dump?:boolean}|null, noise?:boolean}} o
 * @returns {{origs:string[], dump:boolean, replays:string[], verification:string[]}}
 */
export function captureRunPlan({ verify = 'full', lite = null, noise = true, dump: dumpOpt = null } = {}) {
  const data = verify === 'data';
  const origs = data ? (noise ? ['orig1', 'orig2'] : ['orig1']) : lite ? ['orig1', 'orig2', 'orig3', 'orig4'].slice(0, Math.max(2, lite.origs || 2)) : ['orig1', 'orig2', 'orig3', 'orig4'];
  return { origs, dump: data || dumpOpt === false ? false : lite ? !!lite.dump : true, replays: ['orig1', 'cap', 'cov', ...origs.slice(1)], verification: data ? [] : ['rb', 'audit', 'mutants'] };
}

// `lite` (corpus, CORPUS-PLAN §2 step 3): { origs: 2, dump: false, prune: true, minRebuildFrac: 0.8 }. Same capture code,
// less verification: orig1+orig2 only (noise caps AND identity from that one pair), no T6 dump, mutants 0 skips the
// mutant step, orig2/cov PNGs pruned after the verdict. Defaults (lite = null) are the unchanged FULL suite.
// verify 'data' (26 Oct S14, deep mode ก): captureRunPlan above; the verdict says verification 'sampled-out' and never
// claims acceptance (verdictOf(r, 'data')). capture-gate.json is written in every mode (design, truth, completeness and
// the states step read it).
export async function runCaptureSuite(site, { points, out, mutants = 20, mutantCls, excuse = [], log = console.log, lite = null, verify = 'full', noise = true, dump: dumpOpt = null }) {
  const t0 = Date.now();
  const D = n => path.join(out, n);
  fs.mkdirSync(out, { recursive: true });
  const r = { site: site.id, url: site.url, points, live: site.live, excuse: excuse.map(x => ({ ...x, k: String(x.k), prop: String(x.prop) })), steps: {} };
  const step = async (name, fn) => { const t = Date.now(); const v = await fn(); r.steps[name] = { ms: Date.now() - t }; log(`step ${name} ${Date.now() - t}ms`); return v; };
  const cmp = (a, b, pts, caps, heat, owned = null) => compareRuns(D(a), D(b), pts, caps, { heatDir: heat ? D(heat) : null, excuse, owned });

  const metas = {};
  const data = verify === 'data';
  const plan0 = captureRunPlan({ verify, lite, noise, dump: dumpOpt });
  const { origs, dump } = plan0;
  // F24: orig1..orig4 are four INDEPENDENT replays (each one is a different browser; they cannot be merged or dropped:
  // the noise caps come from the pairs 1-2, 1-3, 2-3 and the identity check is orig1 vs orig4; lite keeps 1+2).
  // Nothing in them depends on another run, and `cap`/`cov` (the rule-table replays) only need the archive, so all of
  // them are issued together and the gate's session slots (src/gate/limit.js, 3 browsers at a time) bound the load.
  // The verdict code below runs after all of them, on the same files as before. S14: issued data first (captureRunPlan).
  const capPts = points.filter(p => p.kind === 'captured');
  let mcap;
  {
    await Promise.all(plan0.replays.map(o =>
      o === 'cap' ? step('cap', () => captureRun(site, capPts, D('cap'), { capture: ruleTableCapture(), log })).then(m => { mcap = m; })
        : o === 'cov' ? step('cov', () => captureRun(site, capPts, D('cov'), { capture: ruleTableCapture({ usage: true }), log }))
          : step(o, () => captureRun(site, points, D(o), { withDump: dump && o === 'orig1', withSources: o === 'orig1', log })).then(m => { metas[o] = m; })));
  }
  r.archiveMisses = Object.fromEntries(origs.map(k => [k, Object.values(metas[k].classes).reduce((s, c) => s + c.misses, 0)]));
  // an inner page in data mode has no noise replay (noise=false): no identity, the capture session is compared uncapped
  const noiseChecked = origs.length >= 2;
  const { caps, noise: nz, identity: idRep } = noiseChecked ? identityCheck(out, points, origs, { excuse }) : { caps: null, noise: null, identity: null };
  r.noise = nz; r.identity = idRep;

  const capCmp = cmp('orig1', 'cap', capPts, caps);
  r.captureSession = { archiveMisses: Object.values(mcap.classes).reduce((s, c) => s + c.misses, 0), sameAsOrig1: Object.fromEntries(Object.entries(capCmp).map(([k, x]) => [k, x.pass])) };
  const tables = {}, artifacts = {};
  r.tables = {};
  for (const cls of new Set(points.map(p => p.cls))) {
    const tf = D(`cap/table-${cls}.json`);
    tables[cls] = JSON.parse(fs.readFileSync(tf, 'utf8'));
    mergeUsage(tables[cls], JSON.parse(fs.readFileSync(D(`cov/table-${cls}.json`), 'utf8')));
    // S3: the runtime sheet joins the table BEFORE the file is rewritten and rendered (provenance: artifact === render(table))
    applyRuntimeState(tables[cls], loadRuntimeState(D('cap'), cls), { dir: D('cap') });
    fs.writeFileSync(tf, JSON.stringify(tables[cls]));
    if (!data) { artifacts[cls] = renderRebuild(tables[cls]); fs.writeFileSync(D(`rebuild-${cls}.html`), artifacts[cls].html); } // rb only
    const t = tables[cls];
    const cov = t.coverage;
    fs.writeFileSync(D(`coverage-${cls}.json`), JSON.stringify(cov, null, 1));
    r.tables[cls] = {
      bytes: fs.statSync(tf).size, rebuildBytes: artifacts[cls]?.html.length ?? null, docs: t.docs.length, sheets: t.sheets.length, rules: t.rules.length,
      byType: t.rules.reduce((m, x) => ((m[x.t] = (m[x.t] || 0) + 1), m), {}), elements: t.els.length, vars: t.vars.count, undefinedVars: t.vars.undefinedRefs.length,
      badSelectors: t.badSelectors, usageMap: t.usageMap, ...(t.unreadableSheets ? { unreadableSheets: t.unreadableSheets } : {}),
      coverage: { styleRules: cov.styleRules, used: cov.used, unused: cov.unusedCount, unknown: cov.unknownCount, transient: cov.transient.length, reasons: cov.counts },
      ...(t.runtime ? { runtime: t.runtime } : {}),
    };
  }

  // Top layer (D2; D1 excused `overlay` here): elements the original holds in the top layer (open popover / modal
  // dialog, entered by script) are recorded in the table (`topLayer`) and put there again in the rebuild by the gate
  // harness (showPopover/showModal on the same element, from the table), like script-written attributes. Nothing
  // about them is excused any more. Fullscreen cannot be entered without a user gesture: it stays listed.
  r.deferred = [];
  r.topLayer = {};
  for (const [cls, t] of Object.entries(tables)) {
    r.topLayer[cls] = (t.topLayer || []).map(tl => ({ k: tl.k, how: tl.how }));
    for (const tl of t.topLayer || []) if (tl.how === ':fullscreen' && !r.deferred.some(d => d.k === tl.k)) r.deferred.push({ k: tl.k, how: tl.how, cls, why: 'fullscreen needs a user gesture; not replayed' });
  }

  // script-owned regions per point (scriptowned.js)
  const plan = scriptOwnedPlan(D('orig1'), points, capPts, tables);
  r.scriptOwned = plan.report;
  const { ownedKeys, inject } = plan;
  r.scriptOwned.declared = Object.fromEntries(Object.entries(tables).map(([cls, t]) => [cls, (t.scriptOwned || []).map(d => ({ k: d.k, why: d.why, names: Object.fromEntries(Object.entries(d.names).map(([n, x]) => [n, x.where])) }))]));

  // S14 data mode: the data and the noise check are complete here; rebuild, audit and mutants are the sampled verification
  if (data) {
    const all = { ...metas, cap: mcap };
    const v = {
      verification: 'sampled-out', noiseChecked, identityPass: noiseChecked ? r.identity.summary.all.pass === r.identity.summary.all.points : null,
      captureSessionSame: Object.values(r.captureSession.sameAsOrig1).every(Boolean),
      pointsCaptured: `${points.filter(p => fs.existsSync(D(`orig1/${p.id}.json.gz`))).length}/${points.length}`,
      missingPoints: points.filter(p => !fs.existsSync(D(`orig1/${p.id}.json.gz`))).map(p => p.id),
      scriptOwnedUndeclared: Object.keys(r.scriptOwned.undeclared).length,
      clockLateMs: Math.max(0, ...Object.values(all).flatMap(m => Object.values(m?.classes || {}).map(c => c.clockLateMs || 0))),
      installStalled: Object.values(all).some(m => Object.values(m?.classes || {}).some(c => c.installLateMs > 0)),
      shotSkipped: Object.values(all).flatMap(m => Object.values(m?.points || {}).filter(p => p.shotSkipped)).length,
      dumpSkipped: [],
      unreadableSheets: [...new Set(Object.values(r.tables).flatMap(x => x.unreadableSheets || []))],
      archiveMisses: { ...r.archiveMisses, cap: r.captureSession.archiveMisses },
      acceptance: null, // never claimed: rebuild, audit and mutants did not run (deep mode ก; full checks on the ~10 % sample)
    };
    const st = statusOf({ identityPass: v.identityPass !== false, acceptance: true, clockStalled: v.installStalled, skipped: skippedOf(v) });
    Object.assign(v, st.status === 'pass' ? { status: 'sampled-out', statusWhy: 'deep data mode: data + noise check; rebuild, audit and mutants run on the ~10 % sample only' } : { status: st.status, statusWhy: st.why });
    r.verdict = v;
    labelCauses(r, D, capPts, tables);
    r.wallMs = Date.now() - t0;
    fs.writeFileSync(D('capture-gate.json'), JSON.stringify(r, null, 1));
    return r;
  }

  // rebuild at every point (owned elements get the original's script-written values at that point, then are masked)
  const prepare = async (page, pt) => {
    const o = inject[pt.id]?.length ? await page.evaluate(injectOwned, inject[pt.id]) : null;
    const tl = tables[pt.cls].topLayer?.length ? await page.evaluate(enterTopLayer, tables[pt.cls].topLayer) : null;
    // lazy <img> inside replayed markup never intersect before the snapshot; load the ones orig1 had loaded at this
    // point (as the states suite does; FINAL: C 693-859 carousel, next card's photo at the right edge)
    const im = metas.orig1.points?.[pt.id]?.imgs;
    const li = im?.length ? await page.evaluate(loadImagesLike, im) : null;
    return o || tl || li?.of ? { ...(o || {}), ...(tl ? { topLayer: tl } : {}), ...(li?.of ? { images: li } : {}) } : null;
  };
  const mrb = await step('rb', () => captureRun(site, points, D('rb'), { artifacts, prepare, log }));
  r.scriptOwned.injectedInRebuild = Object.fromEntries(Object.entries(mrb.points || {}).filter(([, m]) => m.prepared).map(([k, m]) => [k, m.prepared]));
  const rb = cmp('orig1', 'rb', points, caps, 'heat-rb', ownedKeys);
  r.rebuild = {
    summary: summarize(rb), archiveMisses: Object.values(mrb.classes).reduce((s, c) => s + c.misses, 0), excused: exList(rb),
    results: Object.fromEntries(Object.entries(rb).map(([k, x]) => [k, { kind: x.kind, pass: x.pass, oracle: { pass: x.oracle.pass, owned: x.oracle.owned, failedElements: x.oracle.failedElements, byKind: x.oracle.byKind, byProp: x.oracle.byProp, misses: x.oracle.misses.slice(0, 12), excusedN: x.oracle.excused?.length || 0 }, pixel: x.pixel }])),
  };
  // Why a point fails, for the reader (never a pass): a pixel-only failure whose differing blob lies under canvas / video /
  // iframe / img / svg content, with every element exact, is content the rule-table rebuild cannot paint (script-drawn).
  for (const [id, x] of Object.entries(rb)) {
    const bb = x.pixel.blobBox;
    if (x.pass || !bb) continue;
    const under = opaqueUnder(gzRead(D(`orig1/${id}.json.gz`)), bb);
    if (Object.keys(under).length) r.rebuild.results[id].pixelUnder = under;
  }
  r.rebuild.pixelOnlyUnderOpaque = Object.entries(r.rebuild.results).filter(([, x]) => !x.pass && x.oracle.pass && x.pixelUnder).map(([k]) => k);
  // points that fail only inside canvas / video / iframe (script-painted, the rebuild cannot paint it): still not a
  // pass, listed as `unpaintable` with what was painted out; acceptance counts them, the label stays in the verdict
  r.rebuild.unpaintable = {};
  for (const pt of points) {
    const u = rb[pt.id] && unpaintableAt(D('orig1'), D('rb'), pt, rb[pt.id], ownedKeys?.[pt.id] || []);
    if (u) { r.rebuild.unpaintable[pt.id] = u; r.rebuild.results[pt.id].unpaintable = u; }
  }
  r.audit = auditRun(D('orig1'), mrb, artifacts, { provenance: cls => renderRebuild(tables[cls]) });

  // mutants (table level)
  const mc = mutantCls || capPts[0].cls;
  const mpt = capPts.find(p => p.cls === mc);
  const snap = gzRead(D(`orig1/${mpt.id}.json.gz`));
  const fam = new Set(); for (const e of snap.els) { const v = decodeStyle(snap, e.s).get('font-family'); if (v && (e.f || e.t.trim())) fam.add(v); }
  const muts = tableMutants(tables[mc], mutants, 20261016, { usedFamilies: [...fam] });
  r.mutants = { cls: mc, point: mpt.id, baselinePass: rb[mpt.id]?.pass, made: muts.length, killed: 0, rows: [] };
  // F4: the mutants are one session each at one point and are judged against orig1's caps, not as independent loads
  // of each other: they share pooled browsers (a fresh context per mutant, recycled by use count / memory). F3: they
  // are independent of each other, so they are issued together and the session slots bound them (3 at a time); the
  // result rows are kept in mutant order.
  const mutPools = newGatePools();
  if (muts.length) await step('mutants', async () => {
    const rows = await Promise.all(muts.map(async m => {
      const dir = D(`mut-${m.id}`);
      // a mutant that kills the renderer (measured once on a real site: target closed during the sweep) is retried once;
      // a second crash is NOT a kill (a harness/renderer failure says nothing about whether the gate sees the
      // change): it is listed as crashed and counts against the >= 19 kills
      let crash = null;
      for (let k = 0; k < 2; k++) { try { await captureRun(site, [mpt], dir, { artifacts: { [mc]: { html: m.html, frames: m.frames, ...(m.nest ? { nest: m.nest } : {}) } }, prepare, reuse: false, pools: mutPools, poolKey: 'mut' }); crash = null; break; } catch (e) { crash = e.message.split('\n')[0].slice(0, 120); } }
      if (crash) { fs.rmSync(dir, { recursive: true, force: true }); return { m, crash }; }
      const res = cmp('orig1', `mut-${m.id}`, [mpt], caps)[mpt.id];
      const vsBase = compareRuns(D('rb'), dir, [mpt], { [mpt.id]: 0 })[mpt.id];
      fs.rmSync(dir, { recursive: true, force: true });
      return { m, res, vsBase };
    })).finally(() => mutPools.closeAll());
    for (const { m, crash, res, vsBase } of rows) {
      if (crash) { r.mutants.crashed = (r.mutants.crashed || 0) + 1; r.mutants.rows.push({ id: m.id, desc: m.desc, killed: false, crashed: true, by: `render-crash x2: ${crash}` }); log(`mutant ${m.id} CRASHED x2 (not counted as killed) ${m.desc}`); continue; }
      const killed = !res.pass && (r.mutants.baselinePass || !vsBase.pass);
      if (killed) r.mutants.killed++;
      r.mutants.rows.push({ id: m.id, desc: m.desc, killed, by: [res.oracle.pass ? null : `oracle(${Object.keys(res.oracle.byKind).join(',')})`, res.pixel.pass ? null : 'pixel'].filter(Boolean).join('+') || 'none', firstMiss: res.oracle.misses[0] || null });
      log(`mutant ${m.id} ${killed ? 'KILLED' : 'survived'} ${m.desc}`);
    }
  });

  const s = r.rebuild.summary;
  r.verdict = {
    identityPass: r.identity.summary.all.pass === r.identity.summary.all.points,
    captureSessionSame: Object.values(r.captureSession.sameAsOrig1).every(Boolean),
    capturedPass: `${s.captured.pass}/${s.captured.points}`, heldoutPass: `${s.heldout.pass}/${s.heldout.points}`,
    allPass: s.all.pass === s.all.points,
    // passed + unpaintable: every element exact, the only pixel difference inside script-painted content (not verified).
    // Reported only (S3, 26 Oct): acceptance counts passed points, an unpaintable point is not a pass
    rebuildCovered: s.all.pass + Object.keys(r.rebuild.unpaintable).length,
    rebuildUnpaintable: Object.keys(r.rebuild.unpaintable),
    scriptOwnedUndeclared: Object.keys(r.scriptOwned.undeclared).length,
    maskedPctViewportMax: Math.max(0, ...Object.values(rb).map(x => x.pixel.masked?.pctViewport || 0)),
    auditPass: Object.values(r.audit).every(a => a.pass),
    mutantsKilled: `${r.mutants.killed}/${r.mutants.made}`, mutantsPass: r.mutants.made >= 20 && r.mutants.killed >= 19,
    clockLateMs: Math.max(0, ...Object.values({ ...metas, cap: mcap }).flatMap(m => Object.values(m?.classes || {}).map(c => c.clockLateMs || 0))),
    installStalled: Object.values({ ...metas, cap: mcap }).some(m => Object.values(m?.classes || {}).some(c => c.installLateMs > 0)),
    shotSkipped: Object.values({ ...metas, cap: mcap }).flatMap(m => Object.values(m?.points || {}).filter(p => p.shotSkipped)).length + Object.values(rb).filter(x => x.shotSkipped).length,
    dumpSkipped: Object.values({ ...metas, cap: mcap }).flatMap(m => Object.values(m?.points || {}).filter(p => p.dumpSkipped).map(p => p.dumpSkipped)),
    unreadableSheets: [...new Set(Object.values(r.tables).flatMap(x => x.unreadableSheets || []))], // cross-origin sheets whose text could not be had: walked empty, counted lossy
    archiveMisses: { ...r.archiveMisses, cap: r.captureSession.archiveMisses, rb: r.rebuild.archiveMisses },
  };
  Object.assign(r.verdict, acceptanceOf(r.verdict, s, lite));
  if (lite) {
    r.verdict.lite = { origs: origs.length, dump, mutants: muts.length, rebuildNeed: `${Math.ceil(s.all.points * (lite.minRebuildFrac ?? 0.8))}/${s.all.points}` };
    if (lite.prune !== false) for (const d of ['orig2', 'cov']) pruneImages(D(d));
  }
  // S2: a gate whose identical replays differ cannot judge the capture: `indeterminate`, never pass/fail (truth.js reads it)
  Object.assign(r.verdict, (({ status, why }) => ({ status, ...(why ? { statusWhy: why } : {}) }))(statusOf({ identityPass: r.verdict.identityPass, acceptance: lite ? r.verdict.liteAcceptance : r.verdict.acceptance, maskedPctViewportMax: r.verdict.maskedPctViewportMax, clockStalled: r.verdict.installStalled, skipped: skippedOf(r.verdict) })));
  labelCauses(r, D, capPts, tables, ownedKeys);
  r.wallMs = Date.now() - t0;
  fs.writeFileSync(D('capture-gate.json'), JSON.stringify(r, null, 1));
  return r;
}

/** S16 (26 Oct, L7): evidence for the failing checks (rebuild roots against the capture session, capture-session vs
 *  identity regions; causes.js, pure over the snapshots just written) stored in the gate, then `verdict.causes`: every
 *  failing check labelled tool | site with the reason. Never fails the capture: an evidence error is itself listed. */
function labelCauses(r, D, capPts, tables, ownedKeys = {}) {
  const read = (run, id) => { const f = D(`${run}/${id}.json.gz`); try { return fs.existsSync(f) ? gzRead(f) : null; } catch { return null; } };
  try {
    if (r.verdict.captureSessionSame === false) r.captureSession.evidence = sessionEvidence({ points: capPts, sameAsOrig1: r.captureSession.sameAsOrig1, read, unstable: r.identity?.unstable || {} });
    if (r.rebuild && r.verdict.allPass === false) r.rebuild.evidence = rebuildEvidence({ points: r.points, results: r.rebuild.results, read, tables, owned: ownedKeys, unstable: r.identity?.unstable || {} });
    r.verdict.causes = labelFailures(r);
  } catch (e) { r.verdict.causes = [{ check: 'labels', bucket: 'error', label: 'tool', reason: `causes.js failed: ${String(e.message).split('\n')[0]}`, evidence: {} }]; }
}

/**
 * The corpus step result of a capture suite (pure; S14: pulled out of steps.js). mode 'full' | 'lite' | 'data'.
 *  full/lite: status ok only when the suite's acceptance (full, with mutants) or liteAcceptance holds. `mutants: false`
 *    (capture-inner, which never runs mutants by design: it uses the lite knobs with minRebuildFrac 1) judges a full run
 *    by liteAcceptance: before, it read `acceptance`, which needs >= 20 mutants, so an inner page could never pass.
 *  data: never claims acceptance (verify.acceptance null, verification 'sampled-out'); ok when every point is captured,
 *    no screenshot / sheet text was skipped, the clock install did not stall and the noise check (orig1 vs orig2) passes;
 *    else partial with the reason (dataProblems).
 * @param {object} r runCaptureSuite result (capture-gate.json)
 * @param {'full'|'lite'|'data'} mode
 * @param {{mutants?:boolean}} [o]
 */
export function verdictOf(r, mode, { mutants = mode === 'full' } = {}) {
  const v = r.verdict;
  const tbl = Object.values(r.tables || {});
  const measured = { elements: tbl.reduce((a, t) => a + t.elements, 0), rules: tbl.reduce((a, t) => a + t.rules, 0), vars: tbl.reduce((a, t) => a + t.vars, 0) };
  if (mode === 'data') {
    const problems = dataProblems(v);
    return {
      status: problems.length ? 'partial' : 'ok', reason: problems.length ? `data mode: ${problems.join('; ')}` : null, measured,
      verify: { verification: 'sampled-out', identity: v.identityPass, noise: v.noiseChecked ? 'orig1 vs orig2' : 'none (inner page: no noise replay)', capture: v.captureSessionSame, points: v.pointsCaptured, acceptance: null, ...(v.causes?.length ? { causes: v.causes } : {}), status: v.status, ...(v.statusWhy ? { statusWhy: v.statusWhy } : {}), clockLateMs: v.clockLateMs, ...(v.shotSkipped ? { shotSkipped: v.shotSkipped } : {}), ...(v.unreadableSheets?.length ? { unreadableSheets: v.unreadableSheets } : {}) },
    };
  }
  if (v.verification === 'sampled-out') throw new Error(`verdictOf: a data-mode capture cannot be judged as ${mode}`);
  const s = r.rebuild.summary;
  const ok = mode === 'full' && mutants ? !!v.acceptance : !!v.liteAcceptance;
  return {
    status: ok ? 'ok' : 'partial', reason: ok ? null : `verdict: identity ${v.identityPass} capture ${v.captureSessionSame} rebuild ${s.all.pass}/${s.all.points}${v.rebuildUnpaintable?.length ? ` (+${v.rebuildUnpaintable.length} unpaintable)` : ''} audit ${v.auditPass} undeclared ${v.scriptOwnedUndeclared}`,
    measured,
    verify: { verification: mode === 'full' ? 'full' : 'lite', identity: v.identityPass, capture: v.captureSessionSame, rebuild: { pass: s.all.pass, points: s.all.points, failed: Object.entries(r.rebuild.results).filter(([, x]) => !x.pass && !x.unpaintable).map(([k]) => k), ...(v.rebuildUnpaintable?.length ? { unpaintable: v.rebuildUnpaintable } : {}) }, audit: v.auditPass, acceptance: ok, mutants: v.mutantsKilled, ...(v.causes?.length ? { causes: v.causes } : {}), ...(v.unreadableSheets?.length ? { unreadableSheets: v.unreadableSheets } : {}), status: v.status, ...(v.statusWhy ? { statusWhy: v.statusWhy } : {}), clockLateMs: v.clockLateMs, ...(v.shotSkipped ? { shotSkipped: v.shotSkipped } : {}), ...(v.dumpSkipped?.length ? { dumpSkipped: v.dumpSkipped } : {}) },
  };
}

/** Why a data-mode capture is not complete data (pure): empty = ok. */
export function dataProblems(v) {
  const p = [];
  if (v.missingPoints?.length) p.push(`${v.missingPoints.length} point(s) not captured: ${v.missingPoints.slice(0, 5).join(', ')}`);
  const sk = skippedOf(v);
  if (sk.length) p.push(`skipped: ${sk.join(', ')}`);
  if (v.installStalled) p.push('fake-clock install stalled (replays not comparable)');
  if (v.noiseChecked && v.identityPass !== true) p.push('noise check failed: orig1 and orig2 differ (identity.unstable)');
  return p;
}

/**
 * acceptance is the one flag callers read: it must not pass on an empty point set, on a table captured in another state
 * than orig1, or with script-written state nobody declared (each was only asserted separately before).
 * S3 (26 Oct): the rebuild part counts PASSED points only (s.all.pass). An `unpaintable` point (every element exact, the
 * pixel difference only inside canvas / video / iframe) is not verified, so it is not a pass: it stays listed in
 * verdict.rebuildUnpaintable / rebuildCovered and in the step's verify.rebuild.unpaintable (before: pass + unpaintable).
 * @param {object} v the verdict so far (identityPass, captureSessionSame, scriptOwnedUndeclared, auditPass, mutantsPass, installStalled, skips)
 * @param {{all:{pass:number, points:number}}} s rebuild summary
 * @param {{minRebuildFrac?:number}|null} lite lite knobs (null in full mode)
 * @returns {{acceptance:boolean, liteAcceptance?:boolean}}
 */
export function acceptanceOf(v, s, lite = null) {
  const common = !!(s.all.points > 0 && v.identityPass && v.captureSessionSame && v.scriptOwnedUndeclared === 0 && v.auditPass && !skippedOf(v).length && !v.installStalled);
  const out = { acceptance: common && s.all.pass === s.all.points && !!v.mutantsPass };
  if (lite) out.liteAcceptance = common && s.all.pass >= Math.ceil(s.all.points * (lite.minRebuildFrac ?? 0.8));
  return out;
}

/** Delete the PNG screenshots of a run folder (lite prune: the verdict is computed, the tables/snapshots stay). */
function pruneImages(dir) {
  if (!fs.existsSync(dir)) return;
  for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); if (n.endsWith('.png')) fs.rmSync(p, { force: true }); else if (fs.statSync(p).isDirectory()) pruneImages(p); }
}

/** Checks the capture could not do (screenshot, T6 dump, cross-origin sheet text): any of them stops the verdict from being a pass. */
export function skippedOf(v) {
  return [v.shotSkipped ? `${v.shotSkipped} screenshot(s)` : null, v.dumpSkipped?.length ? 'T6 dump' : null, v.unreadableSheets?.length ? `${v.unreadableSheets.length} unreadable sheet(s)` : null].filter(Boolean);
}
