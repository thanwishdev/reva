// Tiny static server on 127.0.0.1 for the browser tests (the recorder's offline rule allows localhost only).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export function serveDir(root) {
  const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(fs.readFileSync(p));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) })));
}
