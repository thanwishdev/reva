// Runtime style state (corpus stage S3), Node side: store what runtimestate.js collected at the captured point next
// to the rule table, and add it to the table as ordinary structured rules, so the existing renderer (rebuild.js,
// unchanged) re-creates it from OUR data:
//   CSS.registerProperty  -> {t:'property'}   rendered as @property (same name, syntax, inherits, initial value)
//   FontFace + fonts.add  -> {t:'font-face'}  rendered as @font-face; a URL source keeps its absolute URL (served from
//                            the archive by the replay, as every captured @font-face is); a binary source is stored as
//                            an archive file (runtime-fonts/<sha256>.<ext>) and emitted as a data: URL
//   WAAPI effect values   -> {t:'style'}      one rule per animated target, the target's computed value of every
//                            animated property at the captured point, !important (see below)
// All of it goes into ONE extra sheet (owner 'runtime') appended LAST to the main document's sheets:
//   - a registerProperty registration beats any @property of the same name; the last @property wins, so last is right
//   - FontFaces added from JS come after the CSS-connected faces in the font set; the last matching face wins
// Why !important for WAAPI values: an animation's output sits above every normal declaration (inline included) and
// below every !important one. A frozen value at !important reproduces that wherever the original's computed value is
// the animation's output; where an !important declaration beat the animation, the captured computed value IS that
// declaration's value, so the result is the same too. (It differs only if a state change would flip an !important
// author rule, which the static capture does not cover anyway.) The declared timing + keyframes stay in
// runtime-<cls>.json as motion data (how it moves), not in the rebuild.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { collectRuntimeState } from './runtimestate.js';

/** Collect at the captured point (page = the capture session's page). */
export const captureRuntimeState = page => page.evaluate(collectRuntimeState);

const fontKind = b => {
  const m = b.subarray(0, 4).toString('latin1');
  if (m === 'wOF2') return { ext: 'woff2', format: 'woff2', mime: 'font/woff2' };
  if (m === 'wOFF') return { ext: 'woff', format: 'woff', mime: 'font/woff' };
  if (m === 'OTTO') return { ext: 'otf', format: 'opentype', mime: 'font/otf' };
  if (m === 'true' || b.readUInt32BE(0) === 0x00010000) return { ext: 'ttf', format: 'truetype', mime: 'font/ttf' };
  if (m === 'ttcf') return { ext: 'ttc', format: 'collection', mime: 'font/collection' };
  return { ext: 'bin', format: null, mime: 'application/octet-stream' };
};

/** Write runtime-<cls>.json into dir; binary font sources become archive files dir/runtime-fonts/<sha256>.<ext>
 *  (content-addressed: the same font in every session and class is one file). Returns the stored state. */
export function saveRuntimeState(state, dir, cls) {
  const st = { ...state, fonts: (state.fonts || []).map(f => {
    if (!f.b64) return f;
    const buf = Buffer.from(f.b64, 'base64');
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const k = fontKind(buf);
    const rel = `runtime-fonts/${sha256}.${k.ext}`;
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, buf); }
    const { b64, ...rest } = f;
    return { ...rest, file: rel, sha256, bytes: buf.length, format: k.format, mime: k.mime };
  }) };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `runtime-${cls}.json`), JSON.stringify(st));
  return st;
}

export function loadRuntimeState(dir, cls) {
  const f = path.join(dir, `runtime-${cls}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

const famQ = s => JSON.stringify(String(s).replace(/^\s*(["'])(.*)\1\s*$/, '$2'));
const DEFAULTS = { style: 'normal', weight: 'normal', stretch: 'normal', unicodeRange: 'U+0-10FFFF', featureSettings: 'normal', display: 'auto', ascentOverride: 'normal', descentOverride: 'normal', lineGapOverride: 'normal', sizeAdjust: '100%' };
const DESC = { style: 'font-style', weight: 'font-weight', stretch: 'font-stretch', unicodeRange: 'unicode-range', featureSettings: 'font-feature-settings', display: 'font-display', ascentOverride: 'ascent-override', descentOverride: 'descent-override', lineGapOverride: 'line-gap-override', sizeAdjust: 'size-adjust' };

/** 'html/body[1]/div[2]' -> 'html>body:nth-of-type(1)>div:nth-of-type(2)'. The table keys count non-skipped
 *  siblings of the same tag, and the rebuild renders exactly those elements, so :nth-of-type picks the same node. */
export function keySelector(k) {
  const esc = t => t.replace(/[^\w-]/g, c => `\\${c}`);
  return k.split('/').map((seg, i) => { const m = /^([^[]+)\[(\d+)\]$/.exec(seg); if (i === 0 || !m) return esc(seg); return `${esc(m[1])}:nth-of-type(${m[2]})`; }).join('>');
}

/**
 * Add the runtime state to a rule table (in place) as one extra sheet appended last to the main document.
 * Idempotent: a table that already carries `runtime` is left as it is. dir = where saveRuntimeState wrote the fonts.
 * Returns the summary stored in table.runtime (null when there is no state).
 */
export function applyRuntimeState(table, state, { dir = null } = {}) {
  if (!state) return null;
  if (table.runtime) return table.runtime;
  const sid = table.sheets.length;
  const sheet = { sid, scope: 'd0', owner: 'runtime', href: null, media: '', disabled: false, rules: [], readable: true, runtime: 1 };
  table.sheets.push(sheet);
  table.docs[0].sheets.push(sid);
  let seq = 0;
  const add = rec => { const id = table.rules.length; table.rules.push({ id, ...rec, sheet: sid, scope: 'd0', p: null, ctx: [], seq: seq++ }); sheet.rules.push(id); return id; };
  const sum = { v: 1, sheet: sid, props: 0, fonts: 0, waapiRules: 0, waapiProps: 0, skipped: { ...(state.skipped || {}), fontNoBytes: 0, waapiNotInTable: 0 }, recorder: !!state.recorder };
  // 1. registered custom properties
  for (const p of state.props || []) { add({ t: 'property', name: p.name, syntax: p.syntax, inherits: !!p.inherits, initial: p.initialValue ?? null, origin: 'registerProperty', at: p.at || '' }); sum.props++; }
  // 2. fonts from JS
  for (const f of state.fonts || []) {
    let src = f.src;
    if (f.file) {
      const abs = dir && path.join(dir, f.file);
      if (!abs || !fs.existsSync(abs)) { sum.skipped.fontNoBytes++; continue; }
      src = `url(${JSON.stringify(`data:${f.mime};base64,${fs.readFileSync(abs).toString('base64')}`)})${f.format ? ` format(${JSON.stringify(f.format)})` : ''}`;
    }
    if (!src) { sum.skipped.fontNoBytes++; continue; }
    const d = [['font-family', famQ(f.family)], ['src', src]];
    for (const [k, prop] of Object.entries(DESC)) if (f[k] != null && f[k] !== DEFAULTS[k]) d.push([prop, f[k]]);
    add({ t: 'font-face', d, origin: 'FontFace', at: f.at || '', ...(f.file ? { file: f.file, sha256: f.sha256 } : {}) });
    sum.fonts++;
  }
  // 3. WAAPI values at the captured point: merged per (target, pseudo-element); the computed value already is the
  //    composite of every animation on that target
  const byKey = new Map(table.els.map((e, i) => [e.k, i]));
  const groups = new Map();
  for (const a of state.waapi || []) {
    if (!a.frozen || !Object.keys(a.frozen).length) continue;
    const g = `${a.k}|${a.pseudoElement || ''}`;
    if (!groups.has(g)) groups.set(g, { k: a.k, pe: a.pseudoElement || null, props: {}, names: [] });
    const G = groups.get(g); Object.assign(G.props, a.frozen); G.names.push(a.name);
  }
  for (const G of groups.values()) {
    const i = byKey.get(G.k);
    if (i == null) { sum.skipped.waapiNotInTable++; continue; }
    const base = keySelector(G.k);
    const sel = G.pe ? `${base}${G.pe.startsWith(':') ? G.pe : '::' + G.pe}` : base;
    const n = G.k.split('/').length;
    const id = add({ t: 'style', sel, d: Object.entries(G.props).map(([p, v]) => [p, v, 1]), spec: [[0, n - 1, n + (G.pe ? 1 : 0)]], used: true, origin: 'waapi', animations: G.names.slice(0, 20) });
    const e = table.els[i];
    if (G.pe) { const pe = e.pe || (e.pe = {}); const nm = G.pe.replace(/^:+/, ''); (pe[nm] || (pe[nm] = [])).push(id); } else (e.r || (e.r = [])).push(id);
    sum.waapiRules++; sum.waapiProps += Object.keys(G.props).length;
  }
  sum.note = 'runtime style state (S3): CSS.registerProperty -> @property, FontFace from JS -> @font-face, WAAPI values at the captured point -> frozen !important rules; re-created from this capture, no site script runs in the rebuild';
  table.runtime = sum;
  return sum;
}
