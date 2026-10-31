// Node side of the derived views (D3) and the token export (D4): read a gate capture folder (the `out` of
// runCaptureSuite, or any folder with cap/table-<cls>.json + point snapshots), build the views, write JSON.
// No browser.
import fs from 'node:fs';
import path from 'node:path';
import { gzRead } from '../gate/run.js';
import { components, sections, breakpoints, assets } from './views.js';
import { dtcgFromTable } from './dtcg.js';

/** Captured classes and points found in a capture folder. */
export function readCaptureDir(dir) {
  const capDir = fs.existsSync(path.join(dir, 'cap')) ? path.join(dir, 'cap') : dir;
  const snapDirs = [path.join(dir, 'orig1'), capDir].filter(d => fs.existsSync(d));
  const tables = {};
  for (const f of fs.readdirSync(capDir)) { const m = /^table-(.+)\.json$/.exec(f); if (m) tables[m[1]] = path.join(capDir, f); }
  if (!Object.keys(tables).length) throw new Error(`no rule tables (table-<cls>.json) in ${capDir}`);
  const points = new Map();
  for (const d of snapDirs) for (const f of fs.readdirSync(d)) { const m = /^([^-]+)-(\d+)x(\d+)\.json\.gz$/.exec(f); if (m && !points.has(`${m[1]}-${m[2]}x${m[3]}`)) points.set(`${m[1]}-${m[2]}x${m[3]}`, { id: `${m[1]}-${m[2]}x${m[3]}`, cls: m[1], w: +m[2], h: +m[3], file: path.join(d, f) }); }
  const meta = fs.existsSync(path.join(capDir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(capDir, 'meta.json'), 'utf8')) : null;
  const gate = fs.existsSync(path.join(dir, 'capture-gate.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'capture-gate.json'), 'utf8')) : null;
  return { dir, capDir, tables, points, meta, gate };
}

/** Edges from the held-out edge points (t-1 and t+1 of every measured edge t, src/gate/points.js): from the gate's
 *  point list when the folder has one (kind heldout-edge), else from widths two apart. */
export function edgesFromPoints(points, gatePoints = null) {
  const src = gatePoints ? gatePoints.filter(p => p.kind === 'heldout-edge') : [...points.values()];
  const ws = new Set(src.map(p => p.w));
  return [...new Set([...ws].filter(w => ws.has(w + 2)).map(w => w + 1))].sort((a, b) => a - b);
}

/** Pick the snapshot pair for edge t (t-1 / t+1 at the class's captured height). */
function edgePair(t, points, capH) {
  const at = w => [...points.values()].filter(p => p.w === w && capH[p.cls] === p.h);
  const a = at(t - 1)[0], b = at(t + 1)[0];
  return a && b ? { a, b } : null;
}

/**
 * Build the four views. opts: edges (number[]; default from the points), classes (target/site classes for dpr and
 * touch), fileFor(url) -> archive file, range {from,to}.
 */
export function buildViews(dir, { edges = null, classes = {}, fileFor = () => null, range = null, only = null } = {}) {
  const C = readCaptureDir(dir);
  // the captured point of each class = the snapshot written next to its table (same session, identical keys)
  const capPts = {}; const capH = {};
  for (const cls of Object.keys(C.tables)) {
    const vp = classes[cls]?.viewport;
    const inCap = fs.readdirSync(C.capDir).map(f => new RegExp(`^${cls}-(\\d+)x(\\d+)\\.json\\.gz$`).exec(f)).filter(Boolean).map(m => ({ w: +m[1], h: +m[2] }));
    const pick = (vp && inCap.find(x => x.w === vp.width && x.h === vp.height)) || inCap[0];
    if (!pick) throw new Error(`no snapshot of class ${cls} next to its table in ${C.capDir}`);
    const id = `${cls}-${pick.w}x${pick.h}`;
    capPts[cls] = { id, cls, w: pick.w, h: pick.h, file: path.join(C.capDir, `${id}.json.gz`) };
    capH[cls] = pick.h;
  }
  const E = edges || edgesFromPoints(C.points, C.gate?.points || null);
  const out = { dir, classes: {}, edges: [] };
  const tables = {};
  for (const [cls, f] of Object.entries(C.tables)) {
    if (only && !only.includes(cls)) continue;
    const t = JSON.parse(fs.readFileSync(f, 'utf8')); tables[cls] = t;
    const pt = capPts[cls];
    const snap = gzRead(pt.file);
    out.classes[cls] = {
      point: pt.id,
      components: components(t),
      sections: sections(t, snap),
      assets: assets(t, snap, { requests: C.meta?.classes?.[cls]?.requests || [], fileFor }),
    };
  }
  // breakpoints: each edge with the table of the class its two points belong to
  const env = cls => ({ dpr: classes[cls]?.deviceScaleFactor ?? 1, touch: !!(classes[cls]?.hasTouch) });
  const perCls = {};
  const missing = [];
  for (const t of E) {
    const pr = edgePair(t, C.points, capH);
    if (!pr) { missing.push(t); continue; }
    const cls = pr.a.cls; if (!tables[cls]) continue;
    (perCls[cls] || (perCls[cls] = [])).push({ t, cls, env: env(cls), below: { pointId: pr.a.id, snap: gzRead(pr.a.file) }, above: { pointId: pr.b.id, snap: gzRead(pr.b.file) } });
  }
  for (const [cls, list] of Object.entries(perCls)) {
    const r = breakpoints(tables[cls], list, { range: range ? { ...range, h: capH[cls] } : null });
    out.edges.push(...r.edges);
    if (r.declared) (out.declared || (out.declared = {}))[cls] = r.declared;
  }
  out.edges.sort((a, b) => a.edge - b.edge);
  out.edgesWithoutPoints = missing;
  return out;
}

/** Write views (one JSON per view and class) + a short summary object. */
export function writeViews(v, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const [cls, x] of Object.entries(v.classes)) for (const name of ['components', 'sections', 'assets']) { const f = path.join(outDir, `${name}-${cls}.json`); fs.writeFileSync(f, JSON.stringify(x[name], null, 1)); files.push(f); }
  const f = path.join(outDir, 'breakpoints.json'); fs.writeFileSync(f, JSON.stringify({ edges: v.edges, declared: v.declared || null, edgesWithoutPoints: v.edgesWithoutPoints }, null, 1)); files.push(f);
  return files;
}

export function summarizeViews(v) {
  const cls = Object.fromEntries(Object.entries(v.classes).map(([c, x]) => [c, {
    point: x.point, components: x.components.count, topComponents: x.components.components.filter(k => k.partOf == null).slice(0, 5).map(k => `${k.name.slice(0, 60)} x${k.instances} (${k.variants.length} var)`),
    sections: x.sections.outline.filter(s => s.depth <= 1).length, assets: x.assets.summary,
  }]));
  const edges = v.edges.map(e => ({ edge: e.edge, cls: e.cls, on: e.rulesOn.length, off: e.rulesOff.length, explained: e.changes.explainedElements, other: e.changes.other.elements, why: e.explanation }));
  return { classes: cls, edges, edgesWithoutPoints: v.edgesWithoutPoints };
}

/** D4: DTCG tokens per class (+ the contexts) from the capture folder. */
export function buildTokens(dir, { only = null } = {}) {
  const C = readCaptureDir(dir);
  const out = {};
  for (const [cls, f] of Object.entries(C.tables)) { if (only && !only.includes(cls)) continue; out[cls] = dtcgFromTable(JSON.parse(fs.readFileSync(f, 'utf8'))); }
  return out;
}
