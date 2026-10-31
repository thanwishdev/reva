// A load look must find the same motions however busy the machine or the server is (lane A, 22 Oct 2026). Measured on
// local sites before the fix: one found 1 motion of 12 and another 1 of 17 under parallel looks; a 2 s
// server latency lost 6 of 17 and 9 of 12. Causes, each pinned here on an own fixture
// (fixtures/look/loadrace.html, truth by construction in its header), with CONTROLLED load, never ambient load:
//   1. a request older than 3 s wall stopped holding virtual time, so a page timer raced against it fired (?d1 = 3500)
//   2. an animation started in a task between virtual frames played on real time while the gate waited for the next
//      request, finished, and was never pinned (?d2, ?d3)
//   3. the page's own script failed to arrive (a busy server broke the connection): the look now starts again, once
//   4. CPU throttling of the page (CDP, 6x): the same set and the same values
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../src/util/paths.js';
import { runLook } from '../../src/look/index.js';

const ROOT = path.join(REPO_ROOT, 'fixtures', 'look');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

/** The fixture server: ?delay=<ms> answers late; `failOnce` breaks the first response for that file (the connection
 *  closes before the promised length: net::ERR_CONTENT_LENGTH_MISMATCH; a bare reset is retried by Chrome itself). */
function serve({ failOnce = null } = {}) {
  const failed = new Set();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = u.pathname.slice(1) || 'index.html'; const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
    if (failOnce === rel && !failed.has(rel)) {
      failed.add(rel); const b = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'content-length': b.length + 100 }); res.write(b);
      setTimeout(() => req.socket.destroy(), 20); return;
    }
    const send = () => { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file)); };
    const delay = Math.min(10000, Number(u.searchParams.get('delay')) || 0);
    if (delay > 0) setTimeout(send, delay); else send();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ origin: `http://localhost:${server.address().port}`, failed, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) })));
}

const look = (srv, q, o = {}) => runLook({ input: `${srv.origin}/loadrace.html${q ? `?${q}` : ''}`, action: 'load', write: false, design: false, libs: false, ...o });
/** The found set: selector = kinds, sorted. */
const found = (r) => r.motions.map((m) => `${m.selector}=${[...new Set(m.lines.map((l) => l.kind))].sort().join('+')}`).sort();
/** Duration (ms) of the first line of the motion with this selector that states one. */
const durOf = (r, sel) => {
  const m = r.motions.find((x) => x.selector === sel);
  for (const l of (m && m.lines) || []) { const v = (l.values || []).find((x) => x.name === 'duration'); if (v) return v.value; }
  return null;
};
const near = (a, b, rel) => a != null && Math.abs(a - b) <= rel * Math.abs(b);

let srv;
test.before(async () => { srv = await serve(); });
test.after(async () => { await srv.close(); });

let base;
test('baseline (no delay, no throttling): #intro 900 ms and #late 600 ms, never the fallback', async () => {
  base = await look(srv, '');
  assert.equal(base.status, 'motion');
  const f = found(base);
  assert.ok(f.some((x) => x.startsWith('#intro=')) && f.some((x) => x.startsWith('#late=')), f.join(' | '));
  assert.ok(!f.some((x) => x.startsWith('#fallback=')), f.join(' | '));
  assert.ok(near(durOf(base, '#intro'), 900, 0.02), `#intro ${durOf(base, '#intro')}`);
  assert.ok(near(durOf(base, '#late'), 600, 0.02), `#late ${durOf(base, '#late')}`);
});

test('a slow server (library 3.5 s late, data 0.3 s, then a 1.5 s request): the same set and values as the baseline', async () => {
  const r = await look(srv, 'd1=3500&d2=300&d3=1500');
  assert.deepEqual(found(r), found(base));
  assert.ok(near(durOf(r, '#intro'), 900, 0.02), `#intro ${durOf(r, '#intro')}`);
  assert.ok(near(durOf(r, '#late'), 600, 0.02), `#late ${durOf(r, '#late')}`);
  // (by default the start-up quiet wait, quietBeforeStart, already lets the late library arrive before virtual time
  // starts; the network gate is what holds it when the page asks for something late later on, so it is pinned alone)
  const g = await look(srv, 'd1=3500&d2=300&d3=1500', { quietStart: false });
  assert.deepEqual(found(g), found(base));
  assert.ok(near(durOf(g, '#intro'), 900, 0.02) && near(durOf(g, '#late'), 600, 0.02), `${durOf(g, '#intro')} ${durOf(g, '#late')}`);
  // the library held virtual time past the old 3 s bound (nothing expired), and the gate says so
  assert.ok(g.take.netGate.maxWaitMs >= 3400 && g.take.netGate.expired === 0, JSON.stringify(g.take.netGate));
});

test('CPU throttling of the page (6x, CDP): the same set and values as the baseline, well inside the time limit', async () => {
  const t0 = Date.now();
  const r = await look(srv, 'd2=300&d3=1500', { cpuThrottle: 6 });
  assert.deepEqual(found(r), found(base));
  assert.ok(near(durOf(r, '#intro'), 900, 0.02) && near(durOf(r, '#late'), 600, 0.02), `${durOf(r, '#intro')} ${durOf(r, '#late')}`);
  assert.ok(Date.now() - t0 < 120000, `took ${Date.now() - t0} ms`);
});

test('the page\'s own script reset by the server once: the look starts again, says so, and finds the same set', async () => {
  const s2 = await serve({ failOnce: 'loadrace-lib.js' });
  try {
    const r = await look(s2, '');
    assert.ok(s2.failed.has('loadrace-lib.js'), 'the server did reset the first request');
    assert.deepEqual(found(r), found(base));
    assert.ok(r.warnings.some((w) => /loadrace-lib\.js.*ERR_CONTENT_LENGTH_MISMATCH.*failed to load \(a busy server\): the look was started again once and the page then loaded completely/.test(w)), r.warnings.join(' | '));
  } finally { await s2.close(); }
});
