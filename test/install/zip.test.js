import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listZip, extractZip, safeEntryName, ZipError } from '../../src/install/zip.js';
import { makeZip } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-zip-'));
const write = (buf) => { const d = tmp(); const f = path.join(d, 'a.zip'); fs.writeFileSync(f, buf); return { d, f }; };

test('extracts stored and deflated files, keeps the executable bit, checks sizes', () => {
  const { d, f } = write(makeZip([
    { name: 'r/', data: '' }, { name: 'r/bin', data: '#!/bin/sh\n', mode: 0o755 }, { name: 'r/d/a.txt', data: 'hello '.repeat(500) }, { name: 'r/s.bin', data: Buffer.alloc(100, 1), method: 'store' },
  ]));
  const n = extractZip(f, path.join(d, 'out'), { requiredRoot: 'r/' });
  assert.equal(n, 3);
  assert.equal(fs.readFileSync(path.join(d, 'out/r/d/a.txt'), 'utf8'), 'hello '.repeat(500));
  assert.ok(fs.statSync(path.join(d, 'out/r/bin')).mode & 0o111);
  assert.equal(fs.statSync(path.join(d, 'out/r/d/a.txt')).mode & 0o111, 0);
  assert.equal(listZip(f).length, 4);
});

test('cross-check: a zip made by the system zip tool unpacks the same', { skip: !fs.existsSync('/usr/bin/zip') }, () => {
  const d = tmp(); fs.mkdirSync(path.join(d, 'src/r/sub'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src/r/sub/x.txt'), 'abc'.repeat(2000)); fs.writeFileSync(path.join(d, 'src/r/run'), '#!/bin/sh\n', { mode: 0o755 });
  execFileSync('/usr/bin/zip', ['-qr', path.join(d, 'z.zip'), 'r'], { cwd: path.join(d, 'src') });
  extractZip(path.join(d, 'z.zip'), path.join(d, 'out'), { requiredRoot: 'r/' });
  assert.equal(fs.readFileSync(path.join(d, 'out/r/sub/x.txt'), 'utf8'), 'abc'.repeat(2000));
  assert.ok(fs.statSync(path.join(d, 'out/r/run')).mode & 0o111);
});

test('refuses path traversal, absolute names, backslashes and names outside the required root', () => {
  for (const bad of ['../evil', 'r/../../evil', '/abs/evil', 'r\\evil', 'C:/evil', 'r//x']) {
    assert.equal(safeEntryName(bad), false, bad);
    const { d, f } = write(makeZip([{ name: bad, data: 'x' }]));
    assert.throws(() => extractZip(f, path.join(d, 'out')), /unsafe path/, bad);
    assert.equal(fs.existsSync(path.join(d, 'evil')), false);
  }
  const { d, f } = write(makeZip([{ name: 'other/x', data: 'x' }]));
  assert.throws(() => extractZip(f, path.join(d, 'out'), { requiredRoot: 'r/' }), /unexpected path/);
});

test('symlinks: only to a plain sibling name; anything that could leave the folder is refused', () => {
  const ok = write(makeZip([{ name: 'r/real', data: 'x' }, { name: 'r/link', data: 'real', symlink: true }]));
  extractZip(ok.f, path.join(ok.d, 'out'), { requiredRoot: 'r/' });
  assert.equal(fs.readlinkSync(path.join(ok.d, 'out/r/link')), 'real');
  for (const target of ['../../etc/passwd', '/etc/passwd', 'a/b', '..', '.']) {
    const { d, f } = write(makeZip([{ name: 'r/l', data: target, symlink: true }]));
    assert.throws(() => extractZip(f, path.join(d, 'out')), /symlink/, target);
  }
});

test('detects damage: corrupted data, truncated file, not a zip, unsupported method', () => {
  const good = makeZip([{ name: 'r/a', data: 'payload '.repeat(100), method: 'store' }]);
  const bad = Buffer.from(good); bad[40] ^= 0xff;                      // flip a byte in the stored data
  let { d, f } = write(bad);
  assert.throws(() => extractZip(f, path.join(d, 'out')), /checksum mismatch inside the archive/);
  ({ d, f } = write(good.subarray(0, good.length - 30)));
  assert.throws(() => listZip(f), ZipError);
  ({ d, f } = write(Buffer.from('<html>503 Service Unavailable</html>')));
  assert.throws(() => listZip(f), /not a zip file/);
  const m = Buffer.from(good); const cen = m.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); m.writeUInt16LE(12, cen + 10); // method 12 (bzip2)
  ({ d, f } = write(m));
  assert.throws(() => extractZip(f, path.join(d, 'out')), /compression method 12/);
});

test('zip bomb guard: an entry that claims to be huge is refused before any data is read', () => {
  const z = makeZip([{ name: 'r/a', data: 'x', method: 'store' }]);
  const cen = z.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); z.writeUInt32LE(2 * 1024 ** 3, cen + 24);
  const { f } = write(z);
  assert.throws(() => listZip(f), /limit/);
});
