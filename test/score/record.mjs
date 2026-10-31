// Records scorer-fixture takes with the M1 recorder (hx lane) through the repo launcher (H1).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession } from '../../src/record/session.js';
import { fromRawTake, fromTakeDir } from '../../src/score/series.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'page');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
export const VIEWPORT = { width: 1000, height: 700 };

export function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ origin: `http://localhost:${server.address().port}`, close: () => new Promise(r => server.close(r)) })));
}

export const WATCH = ['#cs', '#wa', '#sp', '#lg', '#hd', '#em', '#mp', '#mk', '#fd'];
export const STEPS = [450, 850, 650, 1250, 1000, 300];

/**
 * Record one take. kind 'resp' = arm 2 (go trigger + scroll steps, page-timed with the sampler phase), 'sweep' = arm 1
 * (recorder dense sweep, 10 px, both directions), 'respRec' = arm 2 driven by the recorder's own scrollTo.
 * Returns a score input; with `write`, the take is written to the private output root and read back from disk.
 */
export async function recordTake(origin, { kind = 'resp', query = {}, rate = 120, write = false, scenario, steps = STEPS } = {}) {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  const s = await openSession({ lane: 'hx', rate, url: `${origin}/?${qs}`, viewport: VIEWPORT, seed: 7, discover: false, engine: 'chs' });
  try {
    await s.goto(); await s.boot({ until: 'window.__ready === true' });
    await s.watch(WATCH);
    await s.clearSamples();
    if (kind === 'resp') {
      await s.hold(200);
      await s.ev(() => window.__go()); await s.hold(1300);
      for (const y of steps) { await s.ev((y) => window.__scrollAt(y), y); await s.hold(900); }
    } else if (kind === 'respRec') {
      await s.hold(200);
      for (const y of steps) { await s.scrollTo(y); await s.hold(900); }
    } else if (kind === 'sweep') {
      await s.hold(50);
      await s.denseSweep({ from: 200, to: 1100, px: 10, framesPerPos: 1 });
    } else throw new Error('unknown kind ' + kind);
    const events = await s.ev(() => window.__ev);
    const r = await s.finish({ scenario: scenario || `score-${kind}`, target: 'scorer-fixture', extra: { query, events }, write });
    const input = write ? fromTakeDir(r.dir) : fromRawTake(r.take, `${kind}?${qs}@${rate}`);
    input.events = events;
    return input;
  } finally { await s.close(); }
}
