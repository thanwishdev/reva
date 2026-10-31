// A big write followed by exit must reach a pipe whole (macOS cut it at 64 KiB: reva look --json | jq failed on live runs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const EXIT = path.resolve('src/util/exit.js');
const run = (body) => new Promise((resolve) => {
  const c = spawn(process.execPath, ['--input-type=module', '-e', `import { exitFlushed } from ${JSON.stringify(EXIT)}; ${body}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let n = 0, e = 0; c.stdout.on('data', (d) => { n += d.length; }); c.stderr.on('data', (d) => { e += d.length; });
  c.on('close', (code) => resolve({ code, n, e }));
});

test('plain process.exit after 300 kB on a pipe loses output where this platform buffers (control)', async () => {
  const r = await run(`process.stdout.write('x'.repeat(300000)); process.exit(0);`);
  assert.ok(r.n <= 300000); // on macOS 65536; on Linux whole. Only documents the hazard, never fails the run
});

test('exitFlushed after 300 kB on stdout and 100 kB on stderr delivers all of it, with the exit code', async () => {
  const r = await run(`process.stdout.write('x'.repeat(300000)); process.stderr.write('y'.repeat(100000)); exitFlushed(3);`);
  assert.equal(r.code, 3); assert.equal(r.n, 300000); assert.equal(r.e, 100000);
});

test('exitFlushed leaves when the reader never reads (3 s bound)', async () => {
  const t0 = Date.now();
  const c = spawn(process.execPath, ['--input-type=module', '-e', `import { exitFlushed } from ${JSON.stringify(EXIT)}; process.stdout.write('x'.repeat(5000000)); exitFlushed(0);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.pause(); // nobody drains
  const code = await new Promise((r) => c.on('exit', r));
  assert.equal(code, 0); assert.ok(Date.now() - t0 < 8000);
});
