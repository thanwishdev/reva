// Provenance helpers for the static layer (PLAN H6). Same vocabulary as src/record/take.js:
//   declared | measured | fitted | inferred | unknown
// Static meaning:
//   measured  read back from the browser (getComputedStyle, layout rects, CDP CSS.getComputedStyleForNode, response sizes)
//   declared  the source text of a winning declaration / a media query / a matchMedia call, read from the engine's own
//             CSS model (CDP CSS domain or CSSOM) -- never from a regex over CSS text
//   inferred  derived from measured/declared values by our arithmetic (hex from an oklch string, em from px, a scale base)
//   unknown   not obtained; always carries a reason and the probe that would resolve it (unknowns ledger)
// "fitted" is not used by the static layer.
export const PROVENANCE = ['declared', 'measured', 'fitted', 'inferred', 'unknown'];
export const STATIC_SCHEMA = 'reva.static/0';

export const measured = (value, extra = {}) => ({ value, provenance: 'measured', ...extra });
export const declared = (value, source, extra = {}) => ({ value, provenance: 'declared', source, ...extra });
export const inferred = (value, from, extra = {}) => ({ value, provenance: 'inferred', from, ...extra });

/** Unknowns ledger: every unmeasured thing is an `unk_*` entry with a reason and the probe that would resolve it. */
export class Ledger {
  constructor() { this.items = []; this._seen = new Set(); }
  /** Adds (deduplicated by id+scope) and returns the unknown value object to embed where the value would be. */
  add(id, reason, probe, scope) {
    const key = id + '|' + (scope ?? '');
    if (!this._seen.has(key)) { this._seen.add(key); this.items.push({ id, reason, probe, ...(scope != null ? { scope } : {}) }); }
    return { value: null, provenance: 'unknown', unknown: id, reason, probe };
  }
  list() { return this.items.slice(); }
}

/** Validates a tagged value: throws when a value breaks H6. Used by the test-suite on the whole record. */
export function assertTagged(v, where = 'value') {
  if (!v || typeof v !== 'object' || !PROVENANCE.includes(v.provenance)) throw new Error(`${where}: missing or invalid provenance`);
  if (v.provenance === 'unknown' && !(v.reason && v.probe)) throw new Error(`${where}: unknown without reason/probe`);
  if (v.provenance === 'inferred' && !v.from) throw new Error(`${where}: inferred without "from"`);
  if (v.provenance === 'declared' && !v.source) throw new Error(`${where}: declared without a source`);
  return true;
}

/** Walks a record and calls fn(node, path) on every object that has a `provenance` field. */
export function walkTagged(node, fn, path = '$') {
  if (Array.isArray(node)) { node.forEach((x, i) => walkTagged(x, fn, `${path}[${i}]`)); return; }
  if (node && typeof node === 'object') {
    if ('provenance' in node) fn(node, path);
    for (const [k, v] of Object.entries(node)) walkTagged(v, fn, `${path}.${k}`);
  }
}
