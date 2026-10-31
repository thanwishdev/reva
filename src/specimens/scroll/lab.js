// Lab specimens: builds the scroll specimens of the Fixture Lab mechanisms from the lab's TRUTH records (the M3 gate uses
// truth records, same format as fitted records, as specimen input for lab specimens). The lab itself is only READ:
//   <labRoot>/lab-scroll/truth/*.json, <labRoot>/lab-scroll/traces/*.json, lab-springs/truth/m10.json, lab-easing/truth/{m17,m18}*.json.
// Nothing here imports the lab or the fitter, and nothing from here is site-derived (own fixtures, public-safe).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildScrollSpecimen, writeSpecimen } from './index.js';
import { planInput } from './input.js';

export const DEFAULT_LAB_ROOT = fileURLToPath(new URL('../../../fixtures/lab', import.meta.url));
/** Lab document heights (lab-scroll/plan.mjs DOC_HEIGHT): geometry of the lab pages, not part of a motion record. */
export const LAB_DOC_HEIGHT = { m01: 2400, m02: 3000, m03: 3400, m04: 4000, m05: 4400, m09: 6000, m09b: 6000 };

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** The lab routes a scroll specimen is built for, with where their truth records and scenario traces live. */
export const LAB_SPECIMENS = [
  ...['m01', 'm02', 'm03', 'm04'].map((id) => ({ id, group: 'lab-scroll', kind: 'scroll', defaultTrace: 'speed' })),
  { id: 'm05', group: 'lab-scroll', kind: 'scroll', defaultTrace: 'plain' },
  { id: 'm09', group: 'lab-scroll', kind: 'scroll', defaultTrace: 'speed' },
  { id: 'm09b', group: 'lab-scroll', kind: 'scroll', defaultTrace: 'speed' },
  { id: 'm10', group: 'lab-springs', kind: 'pointer', truth: 'truth/m10.json', cell: 'fast' },
  { id: 'm17', group: 'lab-easing', kind: 'trigger', truth: 'truth/m17.go.json' },
  { id: 'm18', group: 'lab-easing', kind: 'trigger', truth: 'truth/m18.interrupted.json' },
];

/** Truth items of a lab route (regime R3 = 120 Hz where regimes exist). */
export function labItems(labRoot, spec) {
  if (spec.group === 'lab-scroll') {
    const t = readJson(path.join(labRoot, 'lab-scroll', 'truth', `${spec.id}.json`));
    const d = t.default; const regime = d.R3 || d.R2 || d[Object.keys(d)[0]];
    return { items: regime.items, variant: regime.variant, file: `lab-scroll/truth/${spec.id}.json` };
  }
  const file = path.join(labRoot, spec.group, spec.truth); const t = readJson(file);
  if (spec.cell) {
    const c = t.cells.find((x) => x.trace === spec.cell); const r = c.regimes.R3 || c.regimes.R2;
    return { items: r.items, variant: spec.cell, file: path.relative(labRoot, file) };
  }
  return { items: t.items, variant: t.variant, file: path.relative(labRoot, file) };
}

/** Planned input of every scroll trace of a lab route (variant -> input), at the specimen's frame period. */
export function labInputs(labRoot, spec, { frameMs, maxScroll }) {
  const dir = path.join(labRoot, 'lab-scroll', 'traces'); const out = {};
  if (spec.group !== 'lab-scroll') return out;
  for (const f of fs.readdirSync(dir)) {
    const m = new RegExp(`^${spec.id}\\.(.+)\\.json$`).exec(f); if (!m) continue;
    const tr = readJson(path.join(dir, f));
    out[m[1]] = { trace: `lab-scroll/traces/${f}`, input: planInput(tr.actions, { frameMs, maxScroll }), actions: tr.actions };
  }
  return out;
}

/** Build the specimen of one lab route. Returns { built, inputs, source }. */
export function buildLabSpecimen(labRoot, spec, { frameMs = 1000 / 120 } = {}) {
  const { items, variant, file } = labItems(labRoot, spec);
  const docHeight = LAB_DOC_HEIGHT[spec.id];
  const maxScroll = docHeight ? docHeight - 800 : 0;
  const inputs = labInputs(labRoot, spec, { frameMs, maxScroll });
  const first = inputs[spec.defaultTrace] || Object.values(inputs)[0] || null;
  const raw = JSON.stringify(items);
  const source = { kind: 'labtruth', file, variant, digest: sha(raw).slice(0, 16), note: 'Fixture Lab truth record (own fixture, public-safe)' };
  // inputs planned for a trace carry the scenario; hints (pointer script, triggers) come from the records
  const built0 = buildScrollSpecimen(items, { id: `lab-${spec.id}`, docHeight, frameMs, source });
  const input = first ? { ...first.input, pointer: built0.spec.input?.pointer || [], triggers: built0.spec.input?.triggers || first.input.triggers } : built0.spec.input;
  const built = buildScrollSpecimen(items, { id: `lab-${spec.id}`, docHeight, frameMs, source, input });
  return { built, inputs, source, items };
}

/** Write every lab specimen under outDir/<id>/ and an index.json manifest. */
export function buildLabSpecimens(labRoot, outDir, { only } = {}) {
  const manifest = [];
  for (const spec of LAB_SPECIMENS) {
    if (only && !only.includes(spec.id)) continue;
    const { built, inputs, source, items } = buildLabSpecimen(labRoot, spec);
    const extra = { 'record.json': { schema: 'reva.specimen-source/0', source, items } };
    for (const [variant, v] of Object.entries(inputs)) extra[`scenario.${variant}.json`] = { trace: v.trace, actions: v.actions, frameMs: built.spec.frameMs, input: v.input };
    writeSpecimen(path.join(outDir, spec.id), built, { extra });
    manifest.push({
      id: built.spec.id, route: spec.id, kinds: built.spec.mechanisms.map((m) => m.kind), channels: built.spec.channelMap.length,
      skipped: built.spec.skipped.length, unknowns: built.spec.unknowns.length, assumptions: built.spec.assumptions.length, source: source.file, scenarios: Object.keys(inputs),
    });
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ schema: 'reva.specimen-index/0', family: 'scroll', specimens: manifest }, null, 1) + '\n');
  return manifest;
}
