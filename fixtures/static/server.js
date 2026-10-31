// Serves the static-layer fixture on TWO localhost origins so ext.css is a genuinely cross-origin stylesheet.
// {{EXT_ORIGIN}} in index.html is replaced with the second origin.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.json': 'application/json' };
const PUBLIC = new Set(['index.html', 'style.css', 'ext.css', 'mark.svg', 'dots.svg', 'wr-plant.ttf', 'stub-libs.js']);

export async function serveStaticFixture() {
  let extOrigin = '';
  const handler = (req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    if (!PUBLIC.has(rel)) { res.writeHead(404); res.end('nf'); return; }
    let body = fs.readFileSync(path.join(FIXTURE_DIR, rel));
    if (rel === 'index.html') body = Buffer.from(body.toString().replaceAll('{{EXT_ORIGIN}}', extOrigin));
    res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] || 'application/octet-stream', 'access-control-allow-origin': '*' });
    res.end(body);
  };
  const listen = () => new Promise(resolve => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const [main, ext] = [await listen(), await listen()];
  extOrigin = `http://localhost:${ext.address().port}`;
  const origin = `http://localhost:${main.address().port}`;
  return { origin, extOrigin, close: () => Promise.all([main, ext].map(s => new Promise(r => s.close(r)))) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await serveStaticFixture(); console.log(s.origin, s.extOrigin);
}
