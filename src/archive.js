// Read-only archive integrity check. We only ever run `shasum -c`; the archive is never written.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Runs `shasum -a 256 -c <sums>` with cwd = archive dir. Returns {file, ok, checked, failed:[...]}. */
export function verifySums(archiveDir, sumsFile) {
  if (!fs.existsSync(path.join(archiveDir, sumsFile))) return { file: sumsFile, ok: false, checked: 0, failed: [], error: 'missing' };
  const r = spawnSync('/usr/bin/shasum', ['-a', '256', '-c', sumsFile], { cwd: archiveDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = r.stdout.split('\n').filter(Boolean);
  const failed = lines.filter(l => !/: OK$/.test(l));
  return { file: sumsFile, ok: r.status === 0 && failed.length === 0, checked: lines.length, failed: failed.slice(0, 10), stderr: r.stderr.slice(0, 300) };
}

export function verifyArchive(archiveDir) {
  const results = ['SHA256SUMS', 'ARCHIVE.SHA256SUMS'].map(f => verifySums(archiveDir, f));
  return { archiveDir, ok: results.every(r => r.ok), results };
}
