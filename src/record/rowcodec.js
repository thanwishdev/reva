// Delta rows. A sampled row repeats most of its values frame after frame: an element that does not move still has about
// 30 channels. Sent whole, those rows are what made a big page slow (the drain over CDP) and then crash (Node holding
// them). So the page sends only what changed, and decoding gives back the row exactly: JSON.stringify(decode(encode(row)))
// is byte for byte JSON.stringify(row).
//
// One wire row (undefined fields are absent):
//   { k, T, sy, sx,            the frame, as in a full row
//     r: 1,                    start of a chain: forget all state (a new document, a cleared take)
//     S: [[key, ...], ...],    new key lists ("shapes"), numbered from the last one seen
//     e: [[id, s, [val, ...]], the element joins, or its key list changed: shape s and all its values
//         [id, [i, val, ...]]] same keys: only the values that changed, by index in the key list
//     g: [id, ...],            elements that left the row
//     x: { gl, glm, gld, glo, glb, probe, pix } }   the other row fields: gl, glm, gld (draws per program), glo (object
//                              matrices), glb (composite state ids per program), glu (the programs each was drawn over), gla (uniform array elements), gls (per-draw value slots) and glg (geometry ids per program) as an entry (0 = unchanged), probe and pix whole
// Elements and fields not named are as in the row before.
//
// `-0` and NaN need no case of their own: a row is JSON on disk, where -0 is 0 and NaN is null, and two values that JSON
// writes alike may be sent twice but are never lost. A key whose value is undefined does not exist in JSON, so it does not
// exist here. Ids are integers, so `v` always lists them ascending, whatever the order they were watched in.

/** The row fields sent as entries, in this order (the encoder inside the page spells the same list out). */
const EXT = ['gl', 'glm', 'gld', 'glo', 'glb', 'glu', 'gla', 'gls', 'glg'];

/** First line of a delta series file (series-io.js readJsonl). */
export const DELTA_HEADER = { $rows: 'delta/1' };

/**
 * The encoder. Self-contained: serialised with toString into the page (inpage.js), and run directly by the unit tests.
 * row(full) returns the wire row; reset() makes the next row the start of a chain.
 */
export function rowEncoder() {
  let shapes, prev, chain, ext;
  const reset = () => { shapes = new Map(); prev = new Map(); ext = { gl: null, glm: null, gld: null, glo: null, glb: null, glu: null, gla: null, gls: null, glg: null }; chain = true; };
  reset();
  const same = (a, b) => {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  // the change from p ({keys, vals}, updated in place) to o: null (none), {patch}, or {s, vals} with p replaced by the caller
  const entry = (o, p, out) => {
    const ks = Object.keys(o);
    if (p) {
      let n = 0, patch = null, fits = true;
      const pk = p.keys, pv = p.vals;
      for (let i = 0; i < ks.length; i++) {
        const k = ks[i], x = o[k];
        if (x === undefined) continue;
        if (n >= pk.length || pk[n] !== k) { fits = false; break; }
        if (!same(x, pv[n])) (patch || (patch = [])).push(n, x);
        n++;
      }
      if (fits && n === pk.length) {
        if (!patch) return null;
        for (let j = 0; j < patch.length; j += 2) pv[patch[j]] = patch[j + 1];
        return { patch };
      }
    }
    const keys = [], vals = [];
    for (let i = 0; i < ks.length; i++) { const x = o[ks[i]]; if (x !== undefined) { keys.push(ks[i]); vals.push(x); } }
    const sig = JSON.stringify(keys);
    let s = shapes.get(sig);
    if (s == null) { s = shapes.size; shapes.set(sig, s); (out.S || (out.S = [])).push(keys); }
    return { s, keys, vals };
  };
  const row = (full) => {
    const w = { k: full.k, T: full.T, sy: full.sy, sx: full.sx };
    if (chain) { w.r = 1; chain = false; }
    const e = []; const v = full.v;
    const ids = Object.keys(v);
    let left = prev.size;
    for (let i = 0; i < ids.length; i++) {
      const id = +ids[i]; const p = prev.get(id); if (p) left--;
      const c = entry(v[id], p, w);
      if (!c) continue;
      if (c.patch) e.push([id, c.patch]);
      else { e.push([id, c.s, c.vals]); prev.set(id, { keys: c.keys, vals: c.vals.slice() }); }   // (a wire row waits for the drain: later patches must not reach it)
    }
    if (e.length) w.e = e;
    if (left > 0) {   // something in the last row is not in this one
      const g = [];
      for (const id of prev.keys()) if (v[id] === undefined) g.push(id);
      for (let i = 0; i < g.length; i++) prev.delete(g[i]);
      w.g = g;
    }
    const x = {};
    for (const n of ['gl', 'glm', 'gld', 'glo', 'glb', 'glu', 'gla', 'gls', 'glg']) {
      if (full[n] === undefined) { ext[n] = null; continue; }
      const c = entry(full[n], ext[n], w);
      if (!c) x[n] = 0;
      else if (c.patch) x[n] = [c.patch];
      else { x[n] = [c.s, c.vals]; ext[n] = { keys: c.keys, vals: c.vals.slice() }; }
    }
    if (full.probe !== undefined) x.probe = full.probe;
    if (full.pix !== undefined) x.pix = full.pix;
    if (Object.keys(x).length) w.x = x;
    return w;
  };
  return { row, reset };
}

// a key is page text: assignment to '__proto__' would set the object's prototype and vanish from its JSON
const setKey = (o, k, x) => { if (k === '__proto__') Object.defineProperty(o, k, { value: x, enumerable: true, writable: true, configurable: true }); else o[k] = x; };
const fromShape = (keys, vals) => {
  if (!Array.isArray(vals) || vals.length !== keys.length) throw new Error('delta row: values do not fit their shape');
  const o = {}; for (let i = 0; i < keys.length; i++) setKey(o, keys[i], vals[i]); return o;
};

/**
 * The decoder: a function from a wire row to the full row, in order. Objects that did not change are shared with the row
 * before, so a decoded row costs what changed and not its full size. Treat decoded rows as read-only.
 * The wire comes from the page, which can replace the recorder's functions, so a row that does not fit throws.
 */
export function rowDecoder() {
  let shapes = [], keysOf = new Map(), cur = {}, ext = { gl: null, glm: null, gld: null, glo: null, glb: null, glu: null, gla: null, gls: null, glg: null }, extKeys = { gl: null, glm: null, gld: null, glo: null, glb: null, glu: null, gla: null, gls: null, glg: null };
  const shape = (s) => { const keys = shapes[s]; if (!keys) throw new Error(`delta row: unknown shape ${s}`); return keys; };
  const patched = (o, keys, patch) => {
    const n = { ...o };
    for (let j = 0; j < patch.length; j += 2) { const k = keys[patch[j]]; if (k === undefined) throw new Error('delta row: index outside its shape'); n[k] = patch[j + 1]; }
    return n;
  };
  return (w) => {
    if (w.r) { shapes = []; keysOf = new Map(); cur = {}; ext = { gl: null, glm: null, gld: null, glo: null, glb: null, glu: null, gla: null, gls: null, glg: null }; extKeys = { gl: null, glm: null, gld: null, glo: null, glb: null, glu: null, gla: null, gls: null, glg: null }; }
    if (w.S) for (const keys of w.S) shapes.push(keys);
    if (w.e || w.g) {
      const v = { ...cur };
      if (w.g) for (const id of w.g) { delete v[id]; keysOf.delete(id); }
      if (w.e) for (const c of w.e) {
        const id = c[0];
        if (!Number.isInteger(id) || id < 0) throw new Error('delta row: bad element id');
        if (c.length === 3) { const keys = shape(c[1]); keysOf.set(id, keys); v[id] = fromShape(keys, c[2]); }
        else { const keys = keysOf.get(id); if (!keys) throw new Error(`delta row: element ${id} was never sent whole`); v[id] = patched(v[id], keys, c[1]); }
      }
      cur = v;
    }
    const row = { k: w.k, T: w.T, sy: w.sy, sx: w.sx, v: cur };
    const x = w.x;
    for (const n of EXT) {
      const c = x && x[n];
      if (c === undefined) { ext[n] = null; extKeys[n] = null; continue; }
      if (c !== 0) {
        if (c.length === 2) { extKeys[n] = shape(c[0]); ext[n] = fromShape(extKeys[n], c[1]); }
        else { if (!extKeys[n]) throw new Error(`delta row: ${n} was never sent whole`); ext[n] = patched(ext[n], extKeys[n], c[0]); }
      }
      if (!ext[n]) throw new Error(`delta row: ${n} was never sent whole`);
      row[n] = ext[n];
    }
    if (x && x.probe !== undefined) row.probe = x.probe;
    if (x && x.pix !== undefined) row.pix = x.pix;
    return row;
  };
}

/**
 * The decoder as a cursor that can save its place and come back to it, so a reader can hold a few rows instead of the take.
 * step(w, emit) reads one wire row; with emit it returns the full row, as rowDecoder would, else nothing is built. Element
 * objects are never changed once made, so a row read here shares them exactly as rowDecoder's rows share them: two rows
 * read one after the other hold the same object for an element that did not change between them, and the same `v` when
 * no element changed. save() is the state before the next row; load(cp) goes back to it.
 * Why: a decoded row copies `v`, one entry per watched element, on every frame where anything moved. A take of 11,000
 * frames and 1,474 elements is 0.72 GB of heap that way; a fit needs a few hundred of those rows (fit.js).
 */
export function rowCursor() {
  let shapes = [], keysOf = new Map(), cur = {}, last = null, ext = { gl: null, glm: null, gld: null, glo: null, glb: null, glu: null, gla: null, gls: null, glg: null }, extKeys = { gl: null, glm: null, gld: null, glo: null, glb: null, glu: null, gla: null, gls: null, glg: null };
  const shape = (s) => { const keys = shapes[s]; if (!keys) throw new Error(`delta row: unknown shape ${s}`); return keys; };
  const patched = (o, keys, patch) => {
    const n = { ...o };
    for (let j = 0; j < patch.length; j += 2) { const k = keys[patch[j]]; if (k === undefined) throw new Error('delta row: index outside its shape'); n[k] = patch[j + 1]; }
    return n;
  };
  const step = (w, emit) => {
    if (w.r) { shapes = []; keysOf = new Map(); cur = {}; last = null; ext = { gl: null, glm: null, gld: null, glo: null, glb: null, glu: null, gla: null, gls: null, glg: null }; extKeys = { gl: null, glm: null, gld: null, glo: null, glb: null, glu: null, gla: null, gls: null, glg: null }; }
    if (w.S) for (const keys of w.S) shapes.push(keys);
    if (w.e || w.g) {
      if (w.g) for (const id of w.g) { delete cur[id]; keysOf.delete(id); }
      if (w.e) for (const c of w.e) {
        const id = c[0];
        if (!Number.isInteger(id) || id < 0) throw new Error('delta row: bad element id');
        if (c.length === 3) { const keys = shape(c[1]); keysOf.set(id, keys); cur[id] = fromShape(keys, c[2]); }
        else { const keys = keysOf.get(id); if (!keys) throw new Error(`delta row: element ${id} was never sent whole`); cur[id] = patched(cur[id], keys, c[1]); }
      }
      last = null;
    }
    const x = w.x, got = {};
    for (const n of EXT) {
      const c = x && x[n];
      if (c === undefined) { ext[n] = null; extKeys[n] = null; continue; }
      if (c !== 0) {
        if (c.length === 2) { extKeys[n] = shape(c[0]); ext[n] = fromShape(extKeys[n], c[1]); }
        else { if (!extKeys[n]) throw new Error(`delta row: ${n} was never sent whole`); ext[n] = patched(ext[n], extKeys[n], c[0]); }
      }
      if (!ext[n]) throw new Error(`delta row: ${n} was never sent whole`);
      got[n] = true;
    }
    if (!emit) return undefined;
    // `v` is copied only when it is handed out, and only when an element changed since the last copy
    const row = { k: w.k, T: w.T, sy: w.sy, sx: w.sx, v: last || (last = { ...cur }) };
    for (const n of EXT) if (got[n]) row[n] = ext[n];
    if (x && x.probe !== undefined) row.probe = x.probe;
    if (x && x.pix !== undefined) row.pix = x.pix;
    return row;
  };
  const save = () => ({ shapes: shapes.slice(), keysOf: new Map(keysOf), cur: { ...cur }, ext: { ...ext }, extKeys: { ...extKeys } });
  const load = (cp) => { shapes = cp.shapes.slice(); keysOf = new Map(cp.keysOf); cur = { ...cp.cur }; last = null; ext = { ...cp.ext }; extKeys = { ...cp.extKeys }; };
  return { step, save, load };
}
