// Named scenarios: a JSON list of actions run by one recorder session (PLAN M1 item 8).
// Site scenarios are site-derived (selectors, scroll positions) and live in private storage:
//   <targets dir>/<target>.scenarios/<name>.json   (REVA_TARGETS)
// Own fixture scenarios live in the repo under fixtures/<fixture>/scenarios/.
import fs from 'node:fs';
import path from 'node:path';
import { targetsDir, REPO_ROOT } from '../util/paths.js';
import { openSession } from './session.js';

export function resolveScenario(name, targetId) {
  const cands = [name, path.join(targetsDir(), `${targetId}.scenarios`, `${name}.json`), path.join(REPO_ROOT, 'fixtures', String(targetId), 'scenarios', `${name}.json`)];
  for (const c of cands) if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return { file: c, spec: JSON.parse(fs.readFileSync(c, 'utf8')) };
  throw new Error(`scenario "${name}" not found (looked in: ${cands.slice(1).join(', ')})`);
}

/** Actions: {hold}, {step}, {scrollTo}, {mark}, {sweep}, {denseSweep}, {wheel}, {eval}, {watch}, {snapshot}, {sampling},
 *  and input on one element (stage D2 states): {click}, {hover}, {focus}, {press} (a key, e.g. "Escape"). The session
 *  object implements each action it supports (the D2 gate passes an adapter over its own fixed-clock session). */
export async function runActions(s, actions) {
  for (const a of actions) {
    if ('hold' in a) await s.hold(a.hold);
    else if ('step' in a) await s.step(a.step, { batch: 8 });
    else if ('scrollTo' in a) await s.scrollTo(a.scrollTo);
    else if ('mark' in a) await s.mark(a.mark);
    else if ('sweep' in a) await s.sweep(a.sweep);
    else if ('denseSweep' in a) await s.denseSweep(a.denseSweep);
    else if ('wheel' in a) await s.wheel(a.wheel);
    else if ('eval' in a) await s.ev((src) => (0, eval)(src), a.eval);
    else if ('watch' in a) await s.watch(a.watch);
    else if ('snapshot' in a) await s.snapshotDeclared(a.snapshot);
    else if ('sampling' in a) await s.setSampling(!!a.sampling);
    else if ('click' in a) await s.click(a.click);
    else if ('hover' in a) await s.hover(a.hover);
    else if ('focus' in a) await s.focus(a.focus);
    else if ('press' in a) await s.press(a.press);
    else if ('cdpDiscovery' in a) await s.cdpDiscovery(() => runActions(s, a.cdpDiscovery));
    else throw new Error('unknown scenario action: ' + JSON.stringify(a));
  }
}

/** Record one take of a scenario. `target` is a loaded target config (replay) or null with `url`. `pool` (opt-in, corpus
 *  motion step): a BrowserPool to take a fresh context from instead of launching a browser (see openSession o.pool). */
export async function recordScenario({ target, url, cls, scenarioName, spec, lane = 'hx', rate = 120, engine, toolkit, reducedMotion, timerFlag, pool = null }) {
  const s = await openSession({ lane, rate, target, url, cls, engine, toolkit, reducedMotion, timerFlag, scene: spec.scene || {}, viewport: spec.viewport, seed: spec.seed, ...(pool ? { pool } : {}) });
  try {
    await s.goto(spec.url || url);
    await s.boot(spec.boot || {});
    if (spec.scene && spec.scene.selectors) await s.watch(spec.scene.selectors);
    await runActions(s, spec.actions || []);
    return await s.finish({ scenario: scenarioName });
  } finally { await s.close(); }
}

/** Printed summary (summary-first; the series stay on disk). */
export function summarizeTake(take, dir) {
  return {
    dir, scenario: take.scenario, lane: take.lane, rate: take.rate, frames: take.data.rows.length, births: take.data.births.length,
    mutationStamps: take.data.mut.length, movingSet: (take.watch || []).length, misses: take.net.misses, pageErrors: take.pageErrors.length,
    escapes: Object.fromEntries(Object.entries(take.escapes || {}).map(([k, v]) => [k, v.count])), wallMs: take.wallMs,
  };
}
