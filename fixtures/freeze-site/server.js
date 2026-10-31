// Own fixture site for the freeze command (PLAN M4, "DONE WHEN - freeze"). Public-safe: nothing here comes from a real site.
// It plants the four traps of SYN §7.4 (plus a redirect hop):
//   T1 JS-built URLs   - images/chunks whose URLs are assembled by app.js from templates; a plain load+scroll never asks for all of them
//   T2 blocked telemetry - a third-party host the freeze must block; recorded as status -1 it would stall a naive replay forever
//   T3 a POST body     - /api/consent only answers when the exact body is sent; a sanitiser that drops body files turns it into a miss
//   T4 silent misses   - /api/flags.json is fetched late and every failure is swallowed, so a missing entry leaves no visible error
// Two virtual hosts on one port: site.fixture.test and telemetry.fixture.test (Chromium maps *.fixture.test to 127.0.0.1 at record time).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
export const SITE_HOST = 'site.fixture.test';
export const TELEMETRY_HOST = 'telemetry.fixture.test';
export const SLUGS = ['alpha', 'beta', 'gamma', 'omega'];
export const WIDTHS = [320, 960];
export const CONSENT_BODY = '{"locale":"en","v":3}';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

/** Deterministic SVG so the archived bytes are stable between runs. */
function svg(label, w) {
  const hue = [...label].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${Math.round(w / 2)}" viewBox="0 0 ${w} ${Math.round(w / 2)}"><rect width="100%" height="100%" fill="hsl(${hue} 60% 55%)"/><text x="12" y="28" font-size="20" fill="#fff">${label} ${w}</text></svg>`;
}

/**
 * @param {{port?: number}} [o]
 * @returns {Promise<{port:number, origin:string, telemetryOrigin:string, hits:Array, close():Promise<void>}>}
 * `hits` is every request the server saw: the tests read it to prove telemetry never reached the server and that the replay needed no server at all.
 */
export function startServer({ port = 0 } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const u = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push({ host, method: req.method, path: u.pathname + u.search, body: body || undefined });
      const send = (status, type, payload, extra = {}) => { res.writeHead(status, { 'content-type': type, ...extra }); res.end(payload); };
      const tport = server.address().port;

      if (host === TELEMETRY_HOST) { // T2: only reached if the freeze fails to block it
        if (u.pathname === '/collect.js') return send(200, TYPES['.js'], `navigator.sendBeacon('/track', 'x');`);
        if (u.pathname === '/pixel.gif') return send(200, 'image/gif', Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
        return send(204, 'text/plain', '');
      }

      if (u.pathname === '/') return send(303, 'text/plain', '', { location: '/home' }); // redirect hop (like ARCH's 303)
      if (u.pathname === '/home') {
        const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replaceAll('{{TELEMETRY}}', `http://${TELEMETRY_HOST}:${tport}`);
        return send(200, TYPES['.html'], html, { 'cache-control': 'no-cache', 'set-cookie': 'fx_visitor=v1; Path=/' });
      }
      if (u.pathname === '/api/consent' && req.method === 'POST') { // T3
        if (body !== CONSENT_BODY) return send(400, TYPES['.json'], '{"error":"bad body"}');
        return send(200, TYPES['.json'], '{"ok":true,"consent":"granted-v3"}');
      }
      if (u.pathname === '/api/flags.json') return send(200, TYPES['.json'], '{"banner":"spring"}'); // T4
      let m;
      if ((m = /^\/img\/([a-z]+)-(\d+)\.svg$/.exec(u.pathname)) && SLUGS.includes(m[1]) && WIDTHS.includes(+m[2])) { // T1
        if (m[1] === 'omega' && m[2] === '960') return send(404, 'text/plain', 'planted 404'); // a code-derived URL that does not exist
        return send(200, TYPES['.svg'], svg(m[1], +m[2]), { 'cache-control': 'max-age=1' });
      }
      if ((m = /^\/img\/hero-(day|night|wide)\.svg$/.exec(u.pathname))) return send(200, TYPES['.svg'], svg('hero ' + m[1], 960));
      if ((m = /^\/chunks\/tab-([abc])\.js$/.exec(u.pathname))) return send(200, TYPES['.js'], `export const label = 'tab ${m[1]} loaded'; export default label;`);

      const rel = path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(PUBLIC, rel);
      if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return send(200, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
      send(404, 'text/plain', 'not found');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        port: p, origin: `http://${SITE_HOST}:${p}`, telemetryOrigin: `http://${TELEMETRY_HOST}:${p}`, hits,
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

// `node fixtures/freeze-site/server.js [port]` for manual use.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer({ port: Number(process.argv[2] || 4711) });
  console.log(`freeze fixture on ${s.origin}/ (telemetry host ${s.telemetryOrigin})`);
}
