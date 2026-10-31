// The lab verification jobs: every committed lab specimen (specimens/time, specimens/scroll) paired with the Fixture Lab
// cell it was built from (route, code variant, params, trace). A job says how to drive both sides with the SAME recorder,
// lane and rate, and how the specimen's timeline maps onto the source's (the mapping is input/trigger based, never
// fitted: lag and onset differences stay in the score).
import fs from 'node:fs';
import path from 'node:path';
import { REPO, labRepo, labAdapter } from './refs.js';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const TIME_DIR = path.join(REPO, 'specimens', 'time');
export const SCROLL_DIR = path.join(REPO, 'specimens', 'scroll');

/** Lab group of a route (the four Fixture Lab groups, A1.4). */
export const GROUP_OF = {
  m06: 'lab-easing', m11: 'lab-easing', m12: 'lab-easing', m15: 'lab-easing', m16e: 'lab-easing', m16f: 'lab-easing', m17: 'lab-easing', m18: 'lab-easing', m19: 'lab-easing',
  m07: 'lab-springs', m07x: 'lab-springs', m08: 'lab-springs', m10: 'lab-springs',
  m01: 'lab-scroll', m02: 'lab-scroll', m03: 'lab-scroll', m04: 'lab-scroll', m05: 'lab-scroll', m09: 'lab-scroll', m09b: 'lab-scroll',
};
/**
 * Source time origin of a group's truth (what a specimen's `source time` is measured from):
 *   lab-easing  absolute take time (truth.mjs uses the take's own T: `start = sim.events[0].T`);
 *   lab-springs the anchor = first animation frame after the post-boot `go` (truth.timeBase.origin 'anchor').
 */
export const TIME_ORIGIN = { 'lab-easing': 'absolute', 'lab-springs': 'anchor-after-go' };

const sameParams = (cellParams, want) => Object.entries(cellParams).every(([k, v]) => JSON.stringify(v) === JSON.stringify(want[k]));

/** The lab cell (A.cells() entry) of a route/trace whose params match `params` (every cell key equal). */
export async function findCell(group, route, variant, params) {
  const A = await labAdapter(group);
  const hits = A.cells().filter((c) => c.route === route && c.variant === variant && sameParams(c.params, params));
  if (!hits.length) throw new Error(`${group}/${route}/${variant}: no lab cell with params ${JSON.stringify(params)}`);
  return { A, cell: { ...hits[0], group } };
}

const GO = "window.dispatchEvent(new Event('go'))";
export const SCRIPT_EPS = 0.0015;   // > the specimen's EPS (0.001) by half a grid step of slack, < any frame period

/** Time-family jobs: one per committed time specimen. */
export function timeJobs(dir = TIME_DIR) {
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) return [];
  const man = readJson(path.join(dir, 'manifest.json'));
  return man.specimens.map((m) => {
    const spec = readJson(path.join(dir, m.id, 'spec.json'));
    const group = GROUP_OF[spec.source.route];
    return { id: `time/${m.id}`, family: 'time', specimen: m.id, dir: path.join(dir, m.id), group, route: spec.source.route, variant: spec.source.variant,
      params: spec.source.params, regime: spec.source.regime || 'R3', rate: Math.round(spec.timeline.refreshHz), spring: spec.tracks.some((t) => t.motion.kind === 'spring') };
  });
}

/** Scroll-family jobs: one per committed scroll specimen and scenario (trace) the lab has for it. */
export function scrollJobs(dir = SCROLL_DIR) {
  if (!fs.existsSync(path.join(dir, 'index.json'))) return [];
  const lab = labRepo();
  const idx = readJson(path.join(dir, 'index.json'));
  const out = [];
  for (const s of idx.specimens) {
    const route = s.route; const group = GROUP_OF[route];
    const sdir = path.join(dir, route);
    const spec = readJson(path.join(sdir, 'spec.json'));
    const rec = readJson(path.join(sdir, 'record.json'));
    const rate = Math.round(1000 / spec.frameMs);
    let params = null, variants = [];
    if (lab) {
      const truth = readJson(path.join(lab, 'fixtures', 'lab', rec.source.file));
      if (group === 'lab-scroll') { const d = truth.default; const r = d.R3 || d.R2; params = r.params; variants = s.scenarios.length ? s.scenarios : [r.variant]; }
      else if (Array.isArray(truth.cells)) { const c = truth.cells.find((x) => x.trace === rec.source.variant); params = c.params; variants = [c.trace]; }
      else { params = truth.params; variants = [truth.variant]; }
    }
    for (const v of variants) out.push({ id: `scroll/${route}/${v}`, family: 'scroll', specimen: s.id, dir: sdir, group, route, variant: v, params, regime: 'R3', rate, spring: false });
  }
  return out;
}

export function labJobs({ only } = {}) {
  const all = [...timeJobs(), ...scrollJobs()];
  return only ? all.filter((j) => only.some((o) => j.id === o || j.id.startsWith(o + '/') || j.specimen === o)) : all;
}

/**
 * Specimen-side actions for a job, derived from the source's own actions (same holds, same inputs; only the page's
 * trigger is swapped for the specimen's documented one). Returns {actions, mapping}.
 *   mapping 'mark'   : specimen times map onto the source by the common leading mark (inputs are real and replayed)
 *   mapping 'anchor' : time specimens: source T = origin + (T - anchor) - sourceShiftMs (the spec's own timeline rule)
 */
export function specimenActions(job, srcActions, spec) {
  if (job.family === 'time') {
    const hold = Math.ceil(spec.timeline.durationMs + 100);
    return { actions: [{ eval: GO }, { mark: 'go' }, { hold }], mapping: 'anchor' };
  }
  const dt = 1000 / job.rate;
  const swap = (a) => {
    if (!('eval' in a)) return a;
    if (/__go\(\)/.test(a.eval)) return { eval: 'window.specimen.go()' };
    // The lab page starts its clock on the next frame and runs its pointer script on page timers, which fire at their due
    // time BEFORE the frame at that time (A1.6 g). The specimen's script() adds EPS = 0.001 ms so an event lands AFTER the
    // frame at T (recorder-input semantics); the driver subtracts it so both pages see the same event on the same frame.
    if (a.eval === GO) return { eval: `window.specimen.script(null, performance.now() + ${dt} - ${SCRIPT_EPS})` };
    return a;
  };
  return { actions: srcActions.map(swap), mapping: "mark" };
}
