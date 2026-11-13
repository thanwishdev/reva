// A real scan of a page smoothed by REVA's own vendored Lenis (fixtures/scan-lenis): the document scrolls, late of the wheel,
// so the site's feel must say "smoothed" and never "the document itself does not scroll" (13 Nov showcase scan of
// reva-cli.pages.dev, a Lenis site, said that). Headless browser, one page, desktop and phone; about a minute and a half.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { scanPage } from '../src/scan/index.js';
import { finishScan } from '../src/scan/finish.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript' };

test('scan of a Lenis page: smoothed, the document scrolls', { timeout: 600000 }, async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    const file = path.join(FIX, decodeURIComponent(u.pathname).replace(/\/$/, '/index.html'));
    if (!file.startsWith(FIX) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-scan-lenis-'));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/scan-lenis/`;
    await scanPage(url, { out, onePage: true, lanes: 1 });
    await finishScan(out, { video: false });
    const index = JSON.parse(fs.readFileSync(path.join(out, 'moves.json'), 'utf8'));
    const ps = index.moves.find((m) => m.kind === 'page-scroll');
    assert.ok(ps, 'a page-scroll move');
    assert.equal(ps.pageScroll.mode, 'smoothed');
    assert.equal(index.site.feel.scroll.kind, 'smoothed');
    const said = [...index.site.feel.sentences, ...(index.site.system?.sentences || [])].join(' | ');
    assert.doesNotMatch(said, /does not scroll/);
  } finally {
    srv.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});
