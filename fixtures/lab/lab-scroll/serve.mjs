// Blind static server for the lab-scroll pages (local testing; the integrator's src/lab/server.js replaces it, design X5).
// It serves only what a browser needs and refuses truth, refsim, routes.json, traces and tests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GROUP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const ALLOW = [/^routes\/[a-z0-9]+\.(html|js|css)$/, /^routes\/lib\.js$/, /^core\.js$/, /^vendor\/lenis\.mjs$/];

export function isServable(rel) { return ALLOW.some(re => re.test(rel)); }

/** Serve the group folder on a random localhost port. Returns {origin, close()}. */
export function serveGroup(root = GROUP_ROOT) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.join(root, rel);
    if (!isServable(rel) || !file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ origin: `http://localhost:${port}`, port, close: () => new Promise(r => server.close(r)) });
  }));
}
