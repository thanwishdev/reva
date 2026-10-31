// Public API of the time-specimen generator (M3 "specimens-time").
//   specimensFromFit(fit, opts)       fit result / motion records  -> specimens (origin 'site' unless told otherwise)
//   specimensFromLabTruth(truth, o)   Fixture Lab truth file       -> specimens (origin 'lab')
//   writeSpecimens(list, outDir)      <outDir>/<id>/{index.html, spec.json}; site-derived output must stay outside the repo
//   labSpecimenSet(labRoot, o)        the committed lab set: one specimen per time route, integrator and trace
import fs from 'node:fs';
import path from 'node:path';
import { buildSpec, renderHtml, serializeSpec, reviveSpec } from './build.js';
import { mechanismsFromFit, planSpecimens, casesFromLabTruth } from './normalize.js';
import { assertOutsideRepo } from '../../util/paths.js';

export { K, kernelSource } from './kernel.js';
export { buildSpec, renderHtml, serializeSpec, reviveSpec, shiftMotion, digestOf, SPEC_SCHEMA } from './build.js';
export { mechanismsFromFit, planSpecimens, casesFromLabTruth, parseEase, channelOf } from './normalize.js';

const modeOf = (xs) => { const c = new Map(); for (const x of xs) c.set(x, (c.get(x) || 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; };

/**
 * @param {object} fit   fitTakeSet() result or {records}
 * @param {object} [o]   {id: prefix, origin: 'site'|'lab', impl: 'auto'|'js', leadMs, ranges, frameMs, source: {...}}
 * @returns {{specs: object[], skipped: object[]}}  specs: [{spec, html}]
 */
export function specimensFromFit(fit, o = {}) {
  const { mechanisms, skipped } = mechanismsFromFit(fit, o);
  const origin = o.origin || 'site', prefix = o.id || 'fit';
  const specs = planSpecimens(mechanisms).map((g, i) => {
    const frameMs = o.frameMs || modeOf(g.mechanisms.map((m) => m.frameMs).filter(Boolean)) || 1000 / 120;
    const spec = buildSpec({ id: `${prefix}-${String(i).padStart(2, '0')}`, origin, frameMs, leadMs: o.leadMs, impl: o.impl,
      source: { kind: 'motion-records', schema: 'reva.motion/0', group: g.key, records: g.mechanisms.map((m) => m.source.record), ...(o.source || {}) }, mechanisms: g.mechanisms });
    return { spec, html: renderHtml(spec) };
  });
  return { specs, skipped };
}

/** @returns {{specs: object[], skipped: object[]}} */
export function specimensFromLabTruth(truth, o = {}) {
  const specs = [], skipped = [];
  for (const c of casesFromLabTruth(truth, o)) {
    skipped.push(...c.skipped.map((s) => ({ case: c.id, ...s })));
    if (!c.mechanisms.length) { skipped.push({ case: c.id, reason: 'no seekable time mechanism in this case' }); continue; }
    const spec = buildSpec({ id: o.idPrefix ? `${o.idPrefix}-${c.id}` : c.id, origin: 'lab', frameMs: c.frameMs, leadMs: o.leadMs, impl: o.impl,
      source: { kind: 'labtruth', schema: truth.schema, route: c.route, variant: c.variant, regime: c.regime, params: c.params }, mechanisms: c.mechanisms.map((m, i) => ({ ...m, order: i })) });
    specs.push({ spec, html: renderHtml(spec), caseId: c.id });
  }
  return { specs, skipped };
}

/** Write specimens; site-derived specimens are refused inside the repo (PLAN H2). */
export function writeSpecimens(list, outDir) {
  for (const { spec } of list) if (spec.origin !== 'lab') assertOutsideRepo(outDir);      // refuse before anything is created
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const { spec, html } of list) {
    const d = path.join(outDir, spec.id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.html'), html);
    fs.writeFileSync(path.join(d, 'spec.json'), serializeSpec(spec, 1) + '\n');
    written.push(d);
  }
  return written;
}

export function readSpec(file) { return reviveSpec(JSON.parse(fs.readFileSync(file, 'utf8'))); }

/** Lab routes with a time-based mechanism and their truth file(s). */
export const LAB_TIME_TRUTH = [
  ['lab-easing', 'm06.go'], ['lab-easing', 'm12.go'], ['lab-easing', 'm15.go'], ['lab-easing', 'm16e.go'], ['lab-easing', 'm16f.go'],
  ['lab-easing', 'm18.single'], ['lab-easing', 'm18.interrupted'], ['lab-easing', 'm19.timer'], ['lab-easing', 'm19.click'], ['lab-easing', 'm19.retarget'],
  ['lab-springs', 'm07'], ['lab-springs', 'm07x'], ['lab-springs', 'm08'], ['lab-springs', 'm10'],
];
/** Not time-seekable in this part: scroll-/document-driven or WebGL (listed so the manifest says why). */
export const LAB_NOT_TIME = { 'lab-easing/m11': 'scroll-driven (view timeline): belongs to the scroll specimens', 'lab-easing/m17': 'View Transitions: pseudo-element snapshots, not seekable by the kernel' };

export function labSpecimenSet(labRoot, o = {}) {
  const all = [], skipped = [], notTime = { ...LAB_NOT_TIME };
  for (const [group, name] of LAB_TIME_TRUTH) {
    const f = path.join(labRoot, group, 'truth', name + '.json');
    if (!fs.existsSync(f)) { skipped.push({ file: `${group}/${name}`, reason: 'truth file missing' }); continue; }
    const r = specimensFromLabTruth(JSON.parse(fs.readFileSync(f, 'utf8')), o);
    all.push(...r.specs); skipped.push(...r.skipped.map((s) => ({ file: `${group}/${name}`, ...s })));
  }
  return { specs: all, skipped, notTime };
}
