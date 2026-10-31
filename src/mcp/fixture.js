// The repo's own fixture pages (fixtures/<name>/), served on 127.0.0.1 for one analysis: the demo path and the self-check.
// Only files inside that fixture folder are served; the server listens on loopback only and is closed after the analysis.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, isInside } from '../util/paths.js';

// the demo page ships in the package (src/demo/page); the fixtures/ folders exist in a source checkout only
const DEMO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo', 'page');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
export const FIXTURE = /^([a-z0-9][a-z0-9-]{0,40})(?:\/([a-z0-9][a-z0-9_-]{0,60}\.html))?$/;

/** `demo` (the bundled demo page), or in a source checkout `look` / `look/persp.html` -> {root, page}; throws otherwise. */
export function fixturePath(spec, repo = REPO_ROOT) {
  const m = FIXTURE.exec(String(spec || ''));
  if (!m) throw Object.assign(new Error(`not a fixture name: ${String(spec).slice(0, 60)} (use "demo", the bundled demo page)`), { code: 'bad_arguments' });
  const root = m[1] === 'demo' ? DEMO_ROOT : path.join(repo, 'fixtures', m[1]); const page = m[2] || 'index.html';
  if (!fs.existsSync(path.join(root, page))) {
    throw Object.assign(new Error(m[1] === 'demo' ? `no demo page ${page}` : `no fixture page fixtures/${m[1]}/${page} (the fixtures folder is in a source checkout only; "demo" is the page the package ships)`), { code: 'not_found' });
  }
  return { root, page };
}

/** Serve one fixture folder on 127.0.0.1:<random port>. Returns {url, close}. */
export function serveFixtureDir({ root, page }) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const rel = decodeURIComponent(u.pathname === '/' ? page : u.pathname.slice(1));
    const file = path.resolve(root, rel);
    if (!isInside(file, root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // the URL says `localhost`, not 127.0.0.1: the recorder's DNS sinkhole maps every name but localhost to NOTFOUND
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://localhost:${server.address().port}/${page}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}
