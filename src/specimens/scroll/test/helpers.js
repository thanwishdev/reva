// Test helpers: a tiny static server for generated pages and a recorder-driven run of a specimen.
import http from 'node:http';
import { openSession } from '../../../record/session.js';
import { runActions } from '../../../record/scenario.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };

/** Serve { '/name.html': string } on a random localhost port. */
export function servePages(pages) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x').pathname;
    const body = pages[u];
    if (body == null) { res.writeHead(404); res.end('nf'); return; }
    const ext = u.slice(u.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': TYPES[ext] || 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ origin: `http://localhost:${port}`, close: () => new Promise((r) => server.close(r)) });
  }));
}

/** Record a specimen page with the M1 recorder (hx lane) under a scenario action list. Returns the finished take. */
export async function recordSpecimen({ url, spec, actions, rate = 120, engine = 'chs', evalAfterBoot }) {
  const s = await openSession({ lane: 'hx', rate, url, viewport: spec.viewport, seed: 20261015, scene: { selectors: spec.scene.selectors }, engine });
  try {
    await s.goto(url);
    await s.boot({ until: spec.boot.until });
    await s.watch(spec.scene.selectors);
    if (evalAfterBoot) await evalAfterBoot(s);
    await runActions(s, actions);
    const r = await s.finish({ scenario: 'specimen-test', write: false });
    return r;
  } finally { await s.close(); }
}

/** Series of one specimen channel ("b0|drv:--v0") from a take's rows (NaN where the row has no value). */
export function column(take, specimenKey) {
  const i = specimenKey.indexOf('|'); const sid = specimenKey.slice(0, i), name = specimenKey.slice(i + 1);
  const ei = take.els.findIndex((d) => d && new RegExp(`#${sid}(\\.|$)`).test(d));
  if (ei < 0) throw new Error('element not in take: ' + sid);
  return take.data.rows.map((r) => (r.v[ei] && r.v[ei][name] != null ? r.v[ei][name] : NaN));
}
/** max |a_i - b_i| over finite pairs after dropping the first `skip` rows, with the pair count. */
export function maxAbsDiff(a, b, skip = 0) {
  let max = 0, n = 0;
  for (let i = skip; i < Math.min(a.length, b.length); i++) { if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { max = Math.max(max, Math.abs(a[i] - b[i])); n++; } }
  return { max, n };
}
