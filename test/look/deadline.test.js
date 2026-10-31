// A look never hangs: a main-frame navigation that ends on the browser's error page (a dead port, or a request a guard
// aborts, as the MCP guard does for a private address) stops the look at once, and every look has a wall-clock deadline.
// Own loopback servers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { runLook } from '../../src/look/index.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'safety');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reva-deadline-'));

async function serve() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    const m = /^\/(nav-dead|nav-blocked|js-location)\.html$/.exec(req.url);
    if (m) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(FIX, `${m[1]}.html`))); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${srv.address().port}`, hits, close: () => { srv.closeAllConnections?.(); return new Promise((r) => srv.close(r)); } };
}

test('a script sending the main frame to a refused port: navigation_failed within seconds, no hang', async () => {
  const s = await serve(); const out = tmp(); const t0 = Date.now();
  try {
    await assert.rejects(runLook({ input: `${s.origin}/nav-dead.html`, design: false, engine: 'chs', outDir: out }),
      (e) => e.code === 'navigation_failed' && e.message.includes('sent the browser to http://127.0.0.1:1/'));
    assert.ok(Date.now() - t0 < 45000, `${Date.now() - t0} ms`);
  } finally { await s.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('a script sending the main frame to a URL a request guard aborts: navigation_failed, no hang', async () => {
  const s = await serve(); const out = tmp(); const t0 = Date.now();
  try {
    const onSession = async (S) => { await S.ctx.route('**/blocked/**', (r) => r.abort('blockedbyclient')); };
    await assert.rejects(runLook({ input: `${s.origin}/nav-blocked.html`, design: false, engine: 'chs', outDir: out, onSession }),
      (e) => e.code === 'navigation_failed' && /blocked\/x\.html/.test(e.message));
    assert.ok(!s.hits.includes('/blocked/x.html'), s.hits.join(' '));
    assert.ok(Date.now() - t0 < 45000, `${Date.now() - t0} ms`);
  } finally { await s.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('the wall-clock deadline ends a look with a timeout error and closes the browser', async () => {
  const s = await serve(); const out = tmp(); const t0 = Date.now();
  try {
    await assert.rejects(runLook({ input: `${s.origin}/js-location.html`, design: false, engine: 'chs', outDir: out, deadlineMs: 150 }),
      (e) => e.code === 'timeout' && /no result within \d+ s \(the time limit of one analysis\)/.test(e.message));
    assert.ok(Date.now() - t0 < 20000, `${Date.now() - t0} ms`);
  } finally { await s.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
