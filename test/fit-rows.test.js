// The fit's memory (G12): a worker reads a few rows of a take (openRows), and a heap cap never changes a result.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rowEncoder, DELTA_HEADER } from '../src/record/rowcodec.js';
import { readJsonl, openRows, zstdWriter } from '../src/record/series-io.js';
import { synthSite } from './helpers/synthtake.js';
import { buildMoves, writeMoves } from '../src/scan/moves/index.js';
import { fitMoves } from '../src/scan/moves/fit.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-g12-'));
const chan = (o = {}) => ({ 'ren:tx': 0, 'ren:opacity': 1, 'ren:bx': 10.5, ...o });

/** Rows with every case the codec has: a new document, an element that leaves and comes back with other keys, gl, pix, probe. */
function rowsOf() {
  const rows = []; let k = 0;
  for (let i = 0; i < 60; i++) {
    if (i === 31) k = 0;   // a new document: `k` restarts
    k++;
    const v = { 1: chan({ 'ren:tx': Math.floor(i / 3) }), 4: chan() };
    if (i % 7 !== 3) v[9] = i > 40 ? { 'ren:ty': i, 'ren:text': `n${i}` } : chan({ 'ren:opacity': i % 5 === 0 ? 0.5 : 1 });
    const r = { k, T: k * 16.666667, sy: i > 20 ? i * 3 : 0, sx: 0, v };
    if (i % 4 === 0) r.gl = { 'p|t': Math.floor(i / 8) };
    if (i === 12) r.pix = { mean: 0.3 };
    if (i === 13) r.probe = { x: 1 };
    rows.push(r);
  }
  return rows;
}
function writeDelta(file, rows) {
  const enc = rowEncoder(), w = zstdWriter(file);
  w.write(JSON.stringify(DELTA_HEADER) + '\n');
  rows.forEach((r, i) => { if (i === 31) enc.reset(); w.write(JSON.stringify(enc.row(r)) + '\n'); });
  w.close();
}

test('openRows reads any rows as readJsonl reads them, sharing what did not change', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'rows.jsonl.zst'); writeDelta(file, rowsOf());
    const full = readJsonl(file);
    for (const every of [1, 3, 7, 128]) {
      const R = openRows(file, { every });
      assert.equal(R.n, full.length); assert.deepEqual(R.ks, full.map((r) => r.k));
      const sets = [[...full.keys()], [0], [59], [5, 6, 7, 30, 31, 32], [2, 3, 40, 41, 42, 43, 58, 59], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]];
      for (const idx of sets) {
        const got = R.read(idx);
        assert.deepEqual([...got.keys()], idx);
        for (const i of idx) {
          assert.equal(JSON.stringify(got.get(i)), JSON.stringify(full[i]), `every ${every}, row ${i}`);
          const p = got.get(i - 1); if (!p) continue;
          // the fit tells "changed" by object identity (fit.js docOf, analyse.js planChapter): the same answer as the full read
          assert.equal(got.get(i).v === p.v, full[i].v === full[i - 1].v, `v shared, row ${i}`);
          for (const id of Object.keys(full[i].v)) assert.equal(got.get(i).v[id] === p.v[id], full[i].v[id] === full[i - 1].v[id], `element ${id} shared, row ${i}`);
          assert.equal(got.get(i).gl === p.gl, full[i].gl === full[i - 1].gl, `gl shared, row ${i}`);
        }
      }
    }
    const plain = path.join(dir, 'full.jsonl'); fs.writeFileSync(plain, full.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const P = openRows(plain); assert.equal(P.n, full.length);
    assert.deepEqual([...P.read([3, 4, 50]).values()], [full[3], full[4], full[50]]);
    const bad = path.join(dir, 'bad.jsonl'); fs.writeFileSync(bad, '{"$rows":"delta/9"}\n{}\n');
    assert.throws(() => openRows(bad), /unknown rows encoding/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a heap cap on the fit workers changes no byte of the fit', async () => {
  const files = (d) => { const m = path.join(d, 'moves'); return ['moves.json', ...fs.readdirSync(m).sort().map((n) => `moves/${n}`)].map((f) => [f, fs.readFileSync(path.join(d, f), 'utf8')]); };
  const dirs = [tmp(), tmp(), tmp()];
  try {
    for (const d of dirs) { synthSite(d, { form: 'stored' }); writeMoves(d, buildMoves(d, { viewports: ['desktop'] })); }
    await fitMoves(dirs[0], { workers: 0 });
    await fitMoves(dirs[1], { workers: 2, heapMb: 4 });    // too small to start a worker: the lane runs without the cap
    await fitMoves(dirs[2], { workers: 2, heapMb: 16 });   // starts, and jobs run out (5 of them on Node 26 here): each runs again without it
    assert.deepEqual(files(dirs[1]), files(dirs[0]));
    assert.deepEqual(files(dirs[2]), files(dirs[0]));
  } finally { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
});
