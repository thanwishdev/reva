// Blind static server for the Fixture Lab (M2 design §11, §12 X5). Serves only what a lab page needs: the router
// (index.html), each group's pages (`<group>/routes/*.html|js|css`), the group's page-side modules (`core.js`,
// `pagekit.js`) and vendored libraries (`<group>/vendor/*.js|mjs`). Everything else (truth, refsim, routes.json,
// traces, tests, tools, adapters, READMEs) is refused: the page, and so the recorder and the fitter, never see the truth.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../util/paths.js';

export const LAB_ROOT = path.join(REPO_ROOT, 'fixtures', 'lab');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
/** Allowlist (anything not matching is 404). */
const ALLOW = [
  /^index\.html$/,
  /^lab-[a-z0-9-]+\/routes\/[A-Za-z0-9_-]+\.(html|js|css)$/,
  /^lab-[a-z0-9-]+\/(core|pagekit)\.js$/,
  /^lab-[a-z0-9-]+\/vendor\/[A-Za-z0-9_.-]+\.(js|mjs)$/,
];
export const isServed = (rel) => ALLOW.some((rx) => rx.test(rel));

/** Start the server on 127.0.0.1 (random port unless given). Returns {origin, port, close()}. */
export function serveLab({ port = 0, root = LAB_ROOT } = {}) {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html'; } catch { res.writeHead(400); res.end(); return; }
    const file = path.join(root, rel);
    if (rel.includes('..') || !isServed(rel) || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({ origin: `http://localhost:${p}`, port: p, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
