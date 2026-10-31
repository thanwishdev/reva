// Blind static server for this folder (isolated testing; the integrator's src/lab/server.js replaces it).
// Serves routes/* and core.js only. Refuses truth, refsim, routes.json, traces and every non-page file (design §11).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAB_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export function allowed(pathname) {
  return pathname === '/core.js' || /^\/routes\/[a-z0-9]+\.(html|js)$/.test(pathname);
}

export function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!allowed(u.pathname)) { res.writeHead(404); res.end('not found'); return; }
    const file = path.join(LAB_ROOT, u.pathname);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ origin: `http://localhost:${port}`, port, close: () => new Promise((r) => server.close(r)) });
  }));
}
