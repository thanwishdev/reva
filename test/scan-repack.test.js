import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { repackFile, repackSeries } from '../src/scan/repack.js';
import { readSeriesBytes } from '../src/record/series-io.js';

const text = Buffer.from(Array.from({ length: 4000 }, (_, i) => JSON.stringify({ k: i, T: i * 16.666667, S: [['ren:tx', 'ren:ty'], [i % 7, (i * 3) % 11]] })).join('\n') + '\n');
const level3 = (b) => zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });

function scanFolder() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-repack-'));
  const digest = crypto.createHash('sha256').update(text).digest('hex');
  for (const dir of [path.join(out, 'takes', 'desktop', 'arrive'), path.join(out, 'pages', 'p1', 'takes', 'phone', 'arrive')]) {
    fs.mkdirSync(path.join(dir, 'series'), { recursive: true });
    const file = `series/${digest}.jsonl.zst`, z = level3(text);
    fs.writeFileSync(path.join(dir, file), z);
    fs.writeFileSync(path.join(dir, 'take.json'), JSON.stringify({ series: { rows: { digest, file, format: 'jsonl', compression: 'zstd', bytes: text.length, storedBytes: z.length } } }, null, 1));
  }
  return { out, digest };
}

test('repackFile: smaller, and it reads back to the same bytes', () => {
  const { out, digest } = scanFolder();
  const file = path.join(out, 'takes', 'desktop', 'arrive', 'series', `${digest}.jsonl.zst`);
  const r = repackFile(file);
  assert.ok(r.after < r.before, `${r.after} < ${r.before}`);
  assert.equal(fs.statSync(file).size, r.after);
  assert.ok(readSeriesBytes(file).equals(text));
  assert.ok(!fs.existsSync(`${file}.repack.tmp`));
});

test('repackSeries: every take of every page, on threads; take.json keeps storedBytes true', async () => {
  const { out, digest } = scanFolder();
  const r = await repackSeries(out, { workers: 2 });
  assert.equal(r.files, 2); assert.equal(r.failed, 0); assert.ok(r.after < r.before);
  for (const dir of [path.join(out, 'takes', 'desktop', 'arrive'), path.join(out, 'pages', 'p1', 'takes', 'phone', 'arrive')]) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'take.json'), 'utf8')).series.rows;
    assert.equal(s.storedBytes, fs.statSync(path.join(dir, s.file)).size);
    assert.equal(s.digest, digest);
    assert.equal(crypto.createHash('sha256').update(readSeriesBytes(path.join(dir, s.file))).digest('hex'), digest);
  }
});

test('repackSeries: one thread until widen settles, then the rest; the same bytes as all threads at once', async () => {
  const a = scanFolder(), b = scanFolder();
  let open; const widen = new Promise((r) => { open = r; });
  const ra = repackSeries(a.out, { workers: 3, first: 1, widen });
  setImmediate(open);
  const r1 = await ra, r2 = await repackSeries(b.out, { workers: 3 });
  assert.equal(r1.files, 2); assert.equal(r1.failed, 0); assert.equal(r1.after, r2.after);
  for (const rel of [path.join('takes', 'desktop', 'arrive'), path.join('pages', 'p1', 'takes', 'phone', 'arrive')]) {
    const f = `series/${a.digest}.jsonl.zst`;
    assert.ok(fs.readFileSync(path.join(a.out, rel, f)).equals(fs.readFileSync(path.join(b.out, rel, f))));
    assert.equal(fs.readFileSync(path.join(a.out, rel, 'take.json'), 'utf8'), fs.readFileSync(path.join(b.out, rel, 'take.json'), 'utf8'));
  }
  // a widen that never comes: the one thread packs everything and the call still ends
  const c = scanFolder(), r3 = await repackSeries(c.out, { workers: 3, first: 1, widen: new Promise(() => {}) });
  assert.equal(r3.files, 2); assert.equal(r3.after, r2.after);
});

test('repackSeries: first may be decided from the stored bytes', async () => {
  const a = scanFolder(); let seen = null;
  const r = await repackSeries(a.out, { workers: 3, first: (bytes) => { seen = bytes; return 1; }, widen: new Promise(() => {}) });
  assert.equal(seen, r.before); assert.equal(r.files, 2); assert.ok(r.after < r.before);
});
