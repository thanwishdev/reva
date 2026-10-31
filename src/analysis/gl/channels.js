// WebGL light: recorder rows (row.gl uniforms, row.glm camera-like matrices) -> fit channels. Engine-agnostic.
// Recorder keys are `p<program id>|<uniform name>`. A channel is `gl:<name>` (`gl:<name>@p<id>` when two programs use the
// same name with different values), `.x .y .z .w` per vector component; the camera is `gl:camera.<fov|aspect|x|y|z|rx|ry|rz>`.
import { decodeProjection, decodeView, matrixRole } from './camera.js';

// a GLSL identifier (with array index / struct member): anything else from the page is never printed as a name
const SAFE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\[\d{1,4}\])?(\.[A-Za-z_][A-Za-z0-9_]{0,63}(\[\d{1,4}\])?){0,3}$/;
const COMP = ['x', 'y', 'z', 'w'];

/** 'p3|uTime' -> {prog: 3, name: 'uTime'}; an older scene key without a program ('uTime') -> {prog: null, name}. */
export function parseKey(k) {
  const m = /^p(\d+)\|(.*)$/s.exec(String(k));
  const prog = m ? +m[1] : null; const raw = m ? m[2] : String(k);
  return { prog, name: SAFE.test(raw) ? raw : null, raw };
}

/**
 * Recorder keys -> display names. A name used by one program only is the bare name; a name several programs set to
 * DIFFERENT values gets `@p<id>`; the same name with identical values in every program (three.js sets `cameraPosition`,
 * `projectionMatrix` per program) is one channel, taken from the lowest program id. Unsafe names become `uniform#<n>`.
 * @param {string[]} keys
 * @param {(key:string)=>any[]} [valuesOf] values over the take, to merge identical copies
 * @returns {Map<string, string|null>} key -> name (null = a duplicate of another key's channel)
 */
export function glNames(keys, valuesOf = null) {
  const out = new Map(); const byName = new Map(); let n = 0;
  for (const k of keys) { const p = parseKey(k); const nm = p.name ?? `uniform#${++n}`; if (!byName.has(nm)) byName.set(nm, []); byName.get(nm).push({ k, prog: p.prog }); }
  for (const [nm, list] of byName) {
    list.sort((a, b) => (a.prog ?? 0) - (b.prog ?? 0));
    if (list.length === 1) { out.set(list[0].k, nm); continue; }
    const sig = (k) => (valuesOf ? JSON.stringify(valuesOf(k)) : k);
    const firstOf = new Map();
    for (const it of list) {
      const s = sig(it.k);
      if (firstOf.has(s)) { out.set(it.k, null); continue; }
      firstOf.set(s, it.k);
    }
    const distinct = [...firstOf.values()];
    for (const k of distinct) out.set(k, distinct.length === 1 ? nm : `${nm}@p${parseKey(k).prog}`);
  }
  return out;
}

const isIdentity = (m) => Array.isArray(m) && m.length >= 16 && m.every((v, i) => v === (i % 5 === 0 ? 1 : 0));
const CAM = [['fov', (p) => p && p.kind === 'perspective' ? p.fovDeg : null], ['aspect', (p) => p && p.kind === 'perspective' ? p.aspect : null]];
const VIEWC = ['x', 'y', 'z', 'rx', 'ry', 'rz']; const VIEWF = { x: 'x', y: 'y', z: 'z', rx: 'rxDeg', ry: 'ryDeg', rz: 'rzDeg' };

/**
 * Which matrix keys are the camera: the projection and the view (or model-view) matrix set in the most frames.
 * @returns {{projection: string|null, view: string|null, viewRole: string|null, roles: object}}
 */
export function cameraKeys(rows) {
  const cnt = new Map(); const firstVal = new Map();
  for (const r of rows) if (r.glm) for (const [k, m] of Object.entries(r.glm)) { cnt.set(k, (cnt.get(k) || 0) + 1); if (!firstVal.has(k)) firstVal.set(k, m); }
  const roles = {}; for (const [k, m] of firstVal) roles[k] = matrixRole(parseKey(k).name || '', m);
  const best = (role) => [...cnt.keys()].filter((k) => roles[k] === role).sort((a, b) => cnt.get(b) - cnt.get(a) || (parseKey(a).prog - parseKey(b).prog))[0] || null;
  const view = best('view'); const mv = view ? null : best('modelView');
  const vk = view || mv;
  // a view matrix still at its initial identity (three.js uniforms before the first render with the camera posed) is a
  // camera that was never placed, not a camera at the origin: skipped when the camera is placed in any later row
  let skipIdentity = false;
  if (vk) { let ident = false, other = false; for (const r of rows) { const m = r.glm && r.glm[vk]; if (!m) continue; if (isIdentity(m)) ident = true; else other = true; } skipIdentity = ident && other; }
  return { projection: best('projection'), view: vk, viewRole: view ? 'view' : mv ? 'modelView' : null, roles, ...(skipIdentity ? { skipIdentity } : {}) };
}

/** Decoded camera values of one row (null where the row has no such matrix or it does not decode). */
export function cameraOfRow(r, ck) {
  const o = {};
  const P = ck.projection && r.glm ? decodeProjection(r.glm[ck.projection]) : null;
  for (const [c, f] of CAM) o[c] = f(P);
  if (P && P.kind === 'orthographic') { o.orthoWidth = P.width; o.orthoHeight = P.height; }
  const vm = ck.view && r.glm ? r.glm[ck.view] : null;
  const V = vm && !(ck.skipIdentity && isIdentity(vm)) ? decodeView(vm) : null;
  for (const c of VIEWC) o[c] = V ? V[VIEWF[c]] : null;
  return o;
}

/**
 * Rows -> gl series entries for extractSeries: one per float uniform component and one per decoded camera quantity.
 * @returns {Map<string, {key, el:null, desc:'gl', ch, kind:'gl', idx:number[], y:number[], glKey?:string, comp?:number}>}
 */
export function glSeriesOf(rows) {
  const out = new Map();
  const keys = []; const seen = new Set(); const vals = new Map();
  for (const r of rows) if (r.gl) for (const [k, v] of Object.entries(r.gl)) { if (!seen.has(k)) { seen.add(k); keys.push(k); vals.set(k, []); } }
  if (keys.length) {
    rows.forEach((r) => { for (const k of keys) vals.get(k).push(r.gl ? r.gl[k] : undefined); });
    const names = glNames(keys, (k) => vals.get(k));
    rows.forEach((r, i) => {
      if (!r.gl) return;
      for (const [k, raw] of Object.entries(r.gl)) {
        const nm = names.get(k); if (!nm) continue;
        const arr = Array.isArray(raw) ? raw : [raw];
        arr.slice(0, 4).forEach((v, j) => {
          if (!Number.isFinite(v)) return;
          const ch = arr.length === 1 ? `gl:${nm}` : `gl:${nm}.${COMP[j]}`; const key = `gl|${ch}`;
          let s = out.get(key); if (!s) out.set(key, (s = { key, el: null, desc: 'gl', ch, kind: 'gl', glKey: k, comp: arr.length === 1 ? null : j, idx: [], y: [] }));
          s.idx.push(i); s.y.push(v);
        });
      }
    });
  }
  if (rows.some((r) => r.glm)) {
    const ck = cameraKeys(rows);
    if (ck.projection || ck.view) rows.forEach((r, i) => {
      const c = cameraOfRow(r, ck);
      for (const [q, v] of Object.entries(c)) {
        if (!Number.isFinite(v) || q === 'orthoWidth' || q === 'orthoHeight') continue;
        const ch = `gl:camera.${q}`; const key = `gl|${ch}`;
        let s = out.get(key); if (!s) out.set(key, (s = { key, el: null, desc: 'gl', ch, kind: 'gl', camera: q, idx: [], y: [] }));
        s.idx.push(i); s.y.push(v);
      }
    });
  }
  return out;
}
