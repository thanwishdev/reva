// Delta rows (src/record/rowcodec.js): decoding gives back each row byte for byte, whatever the page did between rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rowEncoder, rowDecoder, rowCursor, DELTA_HEADER } from '../src/record/rowcodec.js';
import { readJsonl, readSeriesBytes, Spool, storeSpool, zstdWriter } from '../src/record/series-io.js';
import { inpageSource } from '../src/record/inpage.js';

/** Through JSON both ways, as on the wire: every decoded row must print exactly as the full row printed. */
function roundTrip(rows, between = {}) {
  const enc = rowEncoder(); const dec = rowDecoder();
  rows.forEach((r, i) => {
    const want = JSON.stringify(r);
    if (between[i]) between[i](enc);
    const wire = JSON.parse(JSON.stringify(enc.row(r)));
    assert.equal(JSON.stringify(dec(wire)), want, `row ${i}`);
  });
}
const chan = (o = {}) => ({ 'ren:tx': 0, 'ren:transform': 'none', 'ren:opacity': 1, 'ren:bx': 10.5, ...o });
const row = (k, v, extra = {}) => ({ k, T: k * 16.666667, sy: 0, sx: 0, v, ...extra });

test('values that change, and nothing else, travel', () => {
  const enc = rowEncoder();
  const a = enc.row(row(1, { 3: chan(), 7: chan() }));
  assert.equal(a.r, 1); assert.equal(a.S.length, 1, 'two elements of one key list share a shape'); assert.equal(a.e.length, 2);
  const b = enc.row(row(2, { 3: chan(), 7: chan() }));
  assert.equal(b.e, undefined); assert.equal(b.S, undefined); assert.equal(b.r, undefined);
  const c = enc.row(row(3, { 3: chan({ 'ren:tx': 4 }), 7: chan() }));
  assert.deepEqual(c.e, [[3, [0, 4]]]);
  roundTrip([row(1, { 3: chan(), 7: chan() }), row(2, { 3: chan(), 7: chan() }), row(3, { 3: chan({ 'ren:tx': 4 }), 7: chan() })]);
});

test('a wire row is not touched by later rows: it waits in the page until the drain', () => {
  const enc = rowEncoder(); const dec = rowDecoder();
  const rows = [row(1, { 1: chan() }, { gl: { 'p|t': 1 } }), row(2, { 1: chan({ 'ren:tx': 1 }) }, { gl: { 'p|t': 2 } }), row(3, { 1: chan({ 'ren:tx': 2 }) }, { gl: { 'p|t': 3 } })];
  const wire = rows.map((r) => enc.row(r));   // no JSON between rows, as in W.rows
  rows.forEach((r, i) => assert.equal(JSON.stringify(dec(JSON.parse(JSON.stringify(wire[i])))), JSON.stringify(r)));
});

test('elements join and leave; ids print ascending whatever the watch order', () => {
  roundTrip([row(1, { 9: chan() }), row(2, { 2: chan(), 9: chan() }), row(3, { 2: chan() }), row(4, {}), row(5, { 9: chan({ 'ren:tx': 1 }), 100: chan(), 2: chan() })]);
});

test('a key list that changes, in length or only in order, keeps its exact order', () => {
  const a = { 'ren:tx': 0, 'drv:--a': 1 }; const b = { 'drv:--a': 1, 'ren:tx': 0 }; const c = { 'ren:tx': 0, 'drv:--a': 1, 'drv:--b': 2 }; const d = { 'ren:tx': 0 };
  roundTrip([row(1, { 1: a }), row(2, { 1: b }), row(3, { 1: c }), row(4, { 1: d }), row(5, { 1: a })]);
});

test('what JSON writes differently from JavaScript: undefined, NaN, Infinity, -0, null, odd strings', () => {
  const s = 'a"\n \\é\u{1F600}';
  roundTrip([
    row(1, { 1: { a: undefined, b: 1, c: NaN, d: -0 } }), row(2, { 1: { a: 'now', b: 1, c: NaN, d: 0 } }), row(3, { 1: { a: undefined, b: 1, c: Infinity, d: null } }),
    row(4, { 1: { a: undefined, b: s, c: null, d: 0 } }), row(5, { 1: { a: undefined, b: s, c: 1e21, d: 1e-7 } }),
  ]);
});

test('a key named __proto__ stays an ordinary key', () => {
  const o = JSON.parse('{"__proto__":1,"b":2}'); const o2 = JSON.parse('{"__proto__":3,"b":2}');
  roundTrip([row(1, { 1: o }), row(2, { 1: o2 })]);
});

test('gl and glm: present, unchanged, patched, grown, gone; probe and pix whole; field order as in a row', () => {
  const m = [1, 0, 0, 1]; const m2 = [1, 0, 0, 2];
  roundTrip([
    row(1, {}, { gl: { 'p1|t': 1 } }), row(2, {}, { gl: { 'p1|t': 1 }, glm: { 'p1|m': m } }), row(3, {}, { gl: { 'p1|t': 2 }, glm: { 'p1|m': [...m] }, probe: { a: 1 } }),
    row(4, {}, { gl: { 'p1|t': 2, 'p1|u': [1, 2] }, glm: { 'p1|m': m2 }, probe: { a: 1 }, pix: { x: [1] } }), row(5, {}), row(6, {}, { gl: { 'p1|t': 2 } }),
  ]);
});

test('an equal array is not sent again', () => {
  const enc = rowEncoder();
  enc.row(row(1, {}, { glm: { 'p|m': [1, 2] } }));
  assert.equal(enc.row(row(2, {}, { glm: { 'p|m': [1, 2] } })).x.glm, 0);
});

test('reset starts a chain the decoder can follow from nothing', () => {
  const r = [row(1, { 1: chan() }), row(2, { 1: chan({ 'ren:tx': 1 }) }), row(3, { 1: chan({ 'ren:tx': 1 }) })];
  roundTrip(r, { 2: (enc) => enc.reset() });
  const enc = rowEncoder(); enc.row(r[0]); enc.reset();
  assert.equal(JSON.stringify(rowDecoder()(JSON.parse(JSON.stringify(enc.row(r[1]))))), JSON.stringify(r[1]));
});

test('a new document: the same decoder follows a second encoder, whose ids start over', () => {
  const dec = rowDecoder(); const e1 = rowEncoder(); const e2 = rowEncoder();
  const a = row(1, { 0: chan(), 5: chan() }); const b = row(2, { 0: { other: 1 } });
  assert.equal(JSON.stringify(dec(JSON.parse(JSON.stringify(e1.row(a))))), JSON.stringify(a));
  assert.equal(JSON.stringify(dec(JSON.parse(JSON.stringify(e2.row(b))))), JSON.stringify(b));
});

test('unchanged objects are shared, so a decoded row costs what changed', () => {
  const enc = rowEncoder(); const dec = rowDecoder();
  const a = dec(enc.row(row(1, { 1: chan(), 2: chan() }))); const b = dec(enc.row(row(2, { 1: chan({ 'ren:tx': 1 }), 2: chan() })));
  assert.equal(a.v[2], b.v[2]); assert.notEqual(a.v[1], b.v[1]); assert.equal(a.v[1]['ren:tx'], 0, 'the older row keeps its value');
});

test('a chain that does not fit throws, it never decodes to something else', () => {
  assert.throws(() => rowDecoder()({ k: 1, e: [[1, [0, 5]]] }), /never sent whole/);
  assert.throws(() => rowDecoder()({ k: 1, e: [[1, 0, [1]]] }), /unknown shape/);
  assert.throws(() => rowDecoder()({ k: 1, S: [['a']], e: [['__proto__', 0, [1]]] }), /bad element id/);
  assert.throws(() => rowDecoder()({ k: 1, S: [['a']], e: [[1, 0, [1, 2]]] }), /do not fit/);
});

test('random rows round trip', () => {
  let s = 12345; const rnd = (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  const rows = []; const keys = ['ren:tx', 'ren:ty', 'ren:color', 'drv:--a', 'drv:--b', 'ren:opacity'];
  let cur = {};
  for (let k = 1; k <= 400; k++) {
    const n = { ...cur };
    for (let i = 0; i < 4; i++) {
      const id = rnd(30); const op = rnd(6);
      if (op === 0) delete n[id];
      else if (op === 1 || !n[id]) { const o = {}; for (const c of keys) if (rnd(2)) o[c] = rnd(5); n[id] = o; }
      else n[id] = { ...n[id], [keys[rnd(6)]]: rnd(3) ? rnd(9) / 7 : 'rgb(1, 2, 3)' };
    }
    cur = n;
    rows.push(row(k, cur, rnd(9) ? {} : { gl: { 'p|a': rnd(3) } }));
  }
  roundTrip(rows, { 200: (enc) => enc.reset() });
});

test('a streamed series reads as full rows, through pick as well; a full series still reads the same', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-')); const rows = [row(1, { 1: chan() }), row(2, { 1: chan({ 'ren:tx': 3 }) }), row(3, {})];
  try {
    const sp = new Spool(path.join(dir, 'spool'), JSON.stringify(DELTA_HEADER)); const enc = rowEncoder();
    sp.line('{"junk":1}'); sp.clear();
    for (const r of rows) sp.line(JSON.stringify(enc.row(r)));
    sp.close(); assert.equal(sp.n, 3);
    const out = path.join(dir, 'rows.jsonl.zst'); const st = storeSpool(sp.file, out);
    assert.equal(st.bytes, readSeriesBytes(out).length);
    assert.deepEqual(readJsonl(out), rows);
    assert.deepEqual(readJsonl(out, (r) => r.k), [1, 2, 3]);
    const full = path.join(dir, 'full.jsonl.zst'); const w = zstdWriter(full); w.write(rows.map((r) => JSON.stringify(r) + '\n').join('')); w.close();
    assert.deepEqual(readJsonl(full), rows);
    const bad = path.join(dir, 'bad.jsonl'); fs.writeFileSync(bad, '{"$rows":"delta/9"}\n{}\n');
    assert.throws(() => readJsonl(bad), /unknown rows encoding/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the encoder is self-contained: the page source carries it', () => {
  const src = inpageSource({ lane: 'hx', dt: 1 });
  assert.match(src, /function rowEncoder\(\)/);
  assert.equal(new Function(`const f = ${rowEncoder.toString()}; return f().row({ k: 1, v: {} }).r;`)(), 1);
});

test('draws per program and object matrices travel as entries: a frame with no draw, a program that stops, a matrix held', () => {
  const m = (x) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  const rows = [
    row(1, { 1: chan() }, { gl: { 'p1|t': 1 }, gld: { p1: [2, 0, 1], p2: [1, 1, 0] }, glo: { 'p2|modelViewMatrix': m(0) }, glb: { p1: 1, p2: 2 } }),
    row(2, { 1: chan() }, { gl: { 'p1|t': 2 }, gld: { p1: [2, 0, 1], p2: [1, 1, 0] }, glo: { 'p2|modelViewMatrix': m(0.5) }, glb: { p1: 1, p2: 2 } }),
    row(3, { 1: chan() }, { gl: { 'p1|t': 3 }, gld: { p2: [1, 0, 0] }, glo: { 'p2|modelViewMatrix': m(0.5) }, glb: { p2: [2, 3] } }),
    row(4, { 1: chan() }, { gl: { 'p1|t': 4 }, gld: {}, glo: { 'p2|modelViewMatrix': m(0.5) } }),
  ];
  roundTrip(rows);
  const enc = rowEncoder(), wire = rows.map((r) => JSON.parse(JSON.stringify(enc.row(r))));
  assert.equal(wire[3].x.glo, 0, 'a held matrix costs one 0');
  assert.equal(wire[1].x.glb, 0, 'held composite states cost one 0');
  const cur = rowCursor(); const got = wire.map((w) => cur.step(w, true));
  assert.deepEqual(got.map((r) => Object.keys(r.gld)), [['p1', 'p2'], ['p1', 'p2'], ['p2'], []]);
  assert.deepEqual(got.map((r) => r.glb ?? null), [{ p1: 1, p2: 2 }, { p1: 1, p2: 2 }, { p2: [2, 3] }, null]);
});
