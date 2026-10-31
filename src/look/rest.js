// Rest pose of a moving element: the state it settles in, which a motion line (180 -> 0) does not say. Read in the page once,
// after the action, for the watched elements (computed transform, transform-origin, opacity, and up to 4 ancestors that have a
// transform or opacity < 1: a parent that rests at rotate(25deg) turns the child's own 180 -> 0 into something else on screen).
// The in-page half returns raw strings; decomposition, wording and the code comment are pure (unit-tested without a browser).

export const REST_ANCESTORS = 4;
const ID = 1e-4;

/**
 * Runs in the page (serialised by evaluate: no closures). Raw rest data for the watched element ids (page-id -> record).
 * Pseudo-element ids and non-elements are skipped. `cap` limits how many elements are read.
 */
export function restPoseInPage([cap, maxUp]) {
  const W = window.__WR; if (!W || !W.els || !W.watch) return {};
  const desc = (e) => String(W.desc ? W.desc(e) : e.tagName).slice(0, 80);
  const read = (e) => {
    const cs = getComputedStyle(e); let w = 0, h = 0;
    if (e.offsetWidth || e.offsetHeight) { w = e.offsetWidth; h = e.offsetHeight; }
    else { try { const b = e.getBBox && e.getBBox(); if (b) { w = b.width; h = b.height; } } catch (x) { /* not drawn */ } }
    return { t: cs.transform, o: cs.transformOrigin, op: +cs.opacity, w, h };
  };
  const out = {}; let n = 0;
  for (const id of (W.watch instanceof Map ? [...W.watch.keys()] : [...W.watch])) {
    if (n >= cap) break;
    const e = W.els[id]; if (!e || e.nodeType !== 1 || (W.pseudoOf && W.pseudoOf.has && W.pseudoOf.has(id))) continue;
    try {
      const r = read(e); r.anc = [];
      let p = e.parentElement;
      for (let i = 0; i < maxUp && p && p.tagName !== 'BODY' && p.tagName !== 'HTML'; i++, p = p.parentElement) {
        const a = read(p);
        if ((a.t && a.t !== 'none') || a.op < 1) r.anc.push({ desc: desc(p), ...a });
      }
      r.desc = desc(e); out[id] = r; n++;
    } catch (x) { /* detached while reading */ }
  }
  return out;
}

/** 'matrix(a, b, c, d, e, f)' / 'matrix3d(...)' / 'none' -> {identity, translate:[x,y], rotate (deg), scale:[sx,sy], skew (deg), is3d, matrix}. */
export function decomposeTransform(s) {
  const str = String(s || 'none').trim(); const m = /^matrix(3d)?\(([^)]*)\)$/.exec(str);
  const idn = { matrix: 'none', identity: true, translate: [0, 0], rotate: 0, scale: [1, 1], skew: 0, is3d: false };
  if (!m) return idn;
  const v = m[2].split(',').map(Number); if (v.some((x) => !Number.isFinite(x))) return { ...idn, identity: false, matrix: str, unreadable: true };
  const is3d = !!m[1];
  const [a, b, c, d, e, f] = is3d ? [v[0], v[1], v[4], v[5], v[12], v[13]] : v;
  const sx = Math.hypot(a, b) || 0; const rot = Math.atan2(b, a);
  const det = a * d - b * c; const sy = sx ? det / sx : Math.hypot(c, d);
  const skew = sx ? Math.atan((a * c + b * d) / (sx * sx)) : 0;
  const r = (x, p = 1000) => Math.round(x * p) / p;
  const out = { matrix: str, translate: [r(e), r(f)], rotate: r(rot * 180 / Math.PI), scale: [r(sx), r(sy)], skew: r(skew * 180 / Math.PI), is3d };
  const tz = is3d ? v[14] : 0;
  out.identity = Math.abs(a - 1) < ID && Math.abs(b) < ID && Math.abs(c) < ID && Math.abs(d - 1) < ID && Math.abs(e) < 1e-2 && Math.abs(f) < 1e-2 && (!is3d || (Math.abs(tz) < 1e-2 && Math.abs(v[2]) < ID && Math.abs(v[6]) < ID && Math.abs(v[8]) < ID && Math.abs(v[9]) < ID && Math.abs(v[10] - 1) < ID));
  return out;
}

/** '40.84px 69.46px' (computed, px) -> {x, y} or null. */
export function parseOrigin(s) {
  const m = /^(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(String(s || '')); return m ? { x: +m[1], y: +m[2] } : null;
}
const originOf = (o, w, h) => {
  const p = parseOrigin(o); if (!p) return null;
  // default = the centre of the box (50% 50%); unknown when the box size could not be read
  const known = w > 0 || h > 0;
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, default: known ? Math.abs(p.x - w / 2) < 1 && Math.abs(p.y - h / 2) < 1 : null, box: known ? { w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 } : null };
};
const one = (x) => ({ transform: decomposeTransform(x.t), origin: originOf(x.o, x.w, x.h), opacity: Number.isFinite(x.op) ? Math.round(x.op * 1000) / 1000 : 1 });

/** Raw page data of one element -> look.json `rest`. null when nothing was read for it. */
export function restSummary(raw) {
  if (!raw) return null;
  const s = one(raw);
  return { ...s, ancestors: (raw.anc || []).slice(0, REST_ANCESTORS).map((a) => ({ desc: a.desc, ...one(a) })) };
}

const num = (x) => String(+(+x).toFixed(2));
/** 'rotate 25°, scale 1.2, translate 10px 0px' of a decomposed transform; '' for identity. */
export function transformWords(t) {
  if (!t || t.identity) return '';
  const w = [];
  if (Math.abs(t.rotate) > 0.01) w.push(`rotate ${num(t.rotate)}°`);
  if (Math.abs(t.scale[0] - 1) > 1e-3 || Math.abs(t.scale[1] - 1) > 1e-3) w.push(Math.abs(t.scale[0] - t.scale[1]) < 1e-3 ? `scale ${num(t.scale[0])}` : `scale ${num(t.scale[0])} ${num(t.scale[1])}`);
  if (Math.abs(t.skew) > 0.01) w.push(`skew ${num(t.skew)}°`);
  if (Math.abs(t.translate[0]) > 0.01 || Math.abs(t.translate[1]) > 0.01) w.push(`translate ${num(t.translate[0])}px ${num(t.translate[1])}px`);
  if (t.is3d && !w.length) w.push('3D transform');
  return w.join(', ') || 'transform';
}
const originWords = (o) => (o && o.default === false ? `origin ${num(o.x)}px ${num(o.y)}px` : '');

/**
 * The printed line, or null when the rest pose does not matter (identity transform, default origin, opaque, no transformed
 * ancestor): 'rest: rotate 25°, origin 41px 69px · inside DIV#home-hero-squiggle (rotate 25°)'.
 */
export function restText(rest) {
  if (!rest) return null;
  const own = [transformWords(rest.transform), originWords(rest.origin), rest.opacity < 0.999 ? `opacity ${num(rest.opacity)}` : ''].filter(Boolean);
  const anc = (rest.ancestors || []).map((a) => `inside ${a.desc} (${[transformWords(a.transform), originWords(a.origin), a.opacity < 0.999 ? `opacity ${num(a.opacity)}` : ''].filter(Boolean).join(', ') || 'transformed'})`);
  if (!own.length && !anc.length) return null;
  return `rest: ${[own.join(', ') || 'no own transform', ...anc].join(' · ')}`;
}

/** The comment that goes into exported code when a parent rests transformed (values are in the element's own frame), or null. */
export function restNote(rest) {
  const t = ((rest && rest.ancestors) || []).filter((a) => !a.transform.identity);
  if (!t.length) return null;
  const a = t[0];
  return `values are in the element's own frame; its parent ${a.desc} rests at ${transformWords(a.transform)}${originWords(a.origin) ? `, ${originWords(a.origin)}` : ''}, which also shows on screen${t.length > 1 ? ` (and ${t.length - 1} more transformed ancestor${t.length > 2 ? 's' : ''})` : ''}`;
}

/** The note as a comment in the snippet's language (css block comment, else //). */
export const noteComment = (lib, note) => (lib === 'css' ? `/* REVA note: ${note} */` : `// REVA note: ${note}`);

/**
 * Sets `rest` (and the code comment when a parent is transformed) on every motion. `rawById` = restPoseInPage result (or null).
 * The comment goes in after the code's `/* REVA: ... *\/` source line, so the printed snippets and look.json carry it.
 */
export function attachRest(motions, rawById) {
  for (const m of motions) {
    const rest = restSummary(rawById && rawById[m.lead]); m.rest = rest;
    const note = restNote(rest); if (rest) rest.note = note;
    if (!note) continue;
    for (const it of m.exports || []) for (const x of it.exports || []) {
      if (!x.code) continue;
      const lines = x.code.split('\n'); const at = /^\/\* REVA:/.test(lines[0]) ? 1 : 0;
      lines.splice(at, 0, noteComment(x.lib, note)); x.code = lines.join('\n');
    }
  }
}
