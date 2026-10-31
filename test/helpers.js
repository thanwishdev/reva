import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/util/paths.js';

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

/** Serve fixtures/<name> on a random localhost port. Returns {origin, close()}. */
export function serveFixture(name) {
  const root = path.join(REPO_ROOT, 'fixtures', name);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
    // ?delay=<ms>: answer late (a lazily fetched bundle; look's readiness wait)
    const send = () => { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file)); };
    const delay = Math.min(10000, Number(u.searchParams.get('delay')) || 0);
    if (delay > 0) setTimeout(send, delay); else send();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ origin: `http://localhost:${port}`, port, close: () => new Promise(r => server.close(r)) });
  }));
}
