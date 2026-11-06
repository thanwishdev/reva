// `reva scan open <dir>`: the card of a scan with fit on open. A small server on this machine only: it serves the scan folder and
// fits a motion when the card asks. `--all` fits every motion first, so the card is complete and needs no server afterwards.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeScanCard } from '../card/stage.js';
import { FitPool, allMotions, defaultWorkers } from './fitpool.js';
import { Ledger } from './ledger.js';
import { safeId } from './stage.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.json': 'application/json' };
/** Only what the card needs is served: never the takes, the ledger's folder listing, or anything with a dot in its path. */
const SERVED = /^(card\.html|(stage|fits|frames|clips|moves|pages\/[\w-]+\/frames)\/[\w./-]+)$/;

export function chaptersOf(out) {
  return fs.readdirSync(path.join(out, 'stage')).filter((f) => /^plan-.+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(out, 'stage', f), 'utf8')).chapter.id);
}

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/**
 * Fit every motion. The result of one motion does not depend on any other, so it is the same at any worker count.
 * @returns {{motions:number, fitted:number, reused:number, failed:object[], cut:object[], p50:number|null, p95:number|null, max:number|null, wallMs:number}}
 */
export async function fitAll(out, { workers = defaultWorkers(), log = () => {} } = {}) {
  const t0 = Date.now();
  const list = allMotions(out, chaptersOf(out));
  const pool = new FitPool(out, { workers });
  const ms = [], failed = [], cut = [];
  let done = 0, reused = 0, shown = 0;
  await Promise.all(list.map(async (x) => {
    try {
      const r = await pool.ask(x.c, x.lead, { deep: true });
      if (r.cached) reused++; else ms.push(r.ms);
      if (r.cut?.length) cut.push({ c: x.c, lead: x.lead, by: r.cut });
    } catch (e) { failed.push({ c: x.c, lead: x.lead, error: e.message }); }
    done++;
    if (done / list.length >= shown + 0.1 || done === list.length) { shown = done / list.length; log(`fit ${done} of ${list.length} motions, ${Math.round((Date.now() - t0) / 1000)} s`); }
  }));
  await pool.close();
  const res = { motions: list.length, fitted: ms.length, reused, failed, cut, p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: ms.length ? Math.max(...ms) : null, wallMs: Date.now() - t0, workers };
  fs.writeFileSync(path.join(out, 'fits', 'all.json'), JSON.stringify(res, null, 1));
  noteInLedger(out, res);
  return res;
}

/** Budget cuts and failed fits are rows too (PLAN §3): one row per viewport for each, with the count and the first case. */
function noteInLedger(out, res) {
  const file = path.join(out, 'coverage.json');
  if (!fs.existsSync(file)) return;
  const ledger = Ledger.read(file);
  const vpOf = (x) => x.c.split('/')[1] ?? null, each = (list, fn) => { for (const vp of new Set(list.map(vpOf))) fn(vp, list.filter((x) => vpOf(x) === vp)); };
  each(res.cut, (viewport, l) => ledger.add({ unit: 'fit', viewport, id: 'study-cut', status: 'limit', name: 'study-fit-budget', value: l.length, reason: `${l.length} motions of the Study view stopped at their fit budget (${l[0].by.join(', ')}): the recorded values are complete, the model is partial` }));
  each(res.failed, (viewport, l) => ledger.add({ unit: 'fit', viewport, id: 'study-failed', status: 'failed', error: `${l.length} motions of the Study view failed to fit, first: ${l[0].error}` }));
  ledger.write(file);
}

function sendFile(res, file, req) {
  const st = fs.statSync(file), type = TYPES[path.extname(file)] || 'application/octet-stream';
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const head = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (m) {
    const a = +m[1], b = Math.min(m[2] ? +m[2] : st.size - 1, st.size - 1);
    if (a > b) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return; }
    res.writeHead(206, { ...head, 'content-range': `bytes ${a}-${b}/${st.size}`, 'content-length': b - a + 1 });
    fs.createReadStream(file, { start: a, end: b }).pipe(res); return;
  }
  res.writeHead(200, { ...head, 'content-length': st.size });
  fs.createReadStream(file).pipe(res);
}

/** The server of one scan folder. Bound to 127.0.0.1; a request from any other site's page is refused (Host and Origin). */
export function startServer(out, { port = 0, workers = defaultWorkers(), prefit = true, log = () => {} } = {}) {
  const pool = new FitPool(out, { workers });
  let bound = null;
  const here = () => `127.0.0.1:${bound}`;
  const server = http.createServer((req, res) => {
    const fail = (code, msg) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: msg })); };
    if (req.headers.host !== here() && req.headers.host !== `localhost:${bound}`) return fail(403, 'wrong host');
    const u = new URL(req.url, `http://${here()}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'not allowed');
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'card.html';
    if (!SERVED.test(rel) || rel.split('/').some((p) => p.startsWith('.'))) return fail(404, 'not here');
    const file = path.join(out, rel);
    // the card asks for a fit by loading its script: with ?c= the fit runs first, so the file is there when the answer goes out
    const wanted = u.searchParams.get('c');
    if (wanted != null) {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin') return fail(403, 'wrong origin');
      const m = /^fits\/([\w-]+)\/(\d+|page|gl)\.js$/.exec(rel);
      if (!m || !/^[\w-]+\/[\w-]+\/[^/]+$/.test(wanted) || safeId(wanted) !== m[1]) return fail(400, 'bad request');
      const lead = /^\d+$/.test(m[2]) ? +m[2] : m[2];
      pool.ask(wanted, lead, { front: true }).then(() => sendFile(res, file, req)).catch((e) => {
        res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
        res.end(`window.__fitFailed(${JSON.stringify(wanted)},${JSON.stringify(lead)},${JSON.stringify(String(e.message))});\n`);
      });
      return undefined;
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(404, 'not here');
    return sendFile(res, file, req);
  });
  return new Promise((ok, no) => {
    server.on('error', no);
    server.listen(port, '127.0.0.1', () => {
      bound = server.address().port;
      const url = `http://${here()}/`;
      // the best ranked motions of the first chapters fit in the background on one worker, so the first clicks are already there
      let stop = false;
      if (prefit) {
        const list = allMotions(out, chaptersOf(out)).filter((x) => x.c.includes('/desktop/')).sort((a, b) => a.rank - b.rank).slice(0, 40);
        (async () => { for (const x of list) { if (stop) return; while (!stop && pool.waiting) await new Promise((r) => setTimeout(r, 200)); if (stop) return; await pool.ask(x.c, x.lead).catch(() => {}); } })();
      }
      ok({ url, port: bound, pool, close: async () => { stop = true; await pool.close(); await new Promise((r) => { server.close(r); server.closeAllConnections?.(); }); } });
    });
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* the URL is printed anyway */ }
}

/** `reva scan open <dir> [--all] [--port n] [--workers n] [--no-open] [--rebuild]` */
export async function runOpenCommand(f) {
  const dir = f._[2];
  if (f.help) { process.stdout.write('usage: reva scan open <scan folder> [--all] [--port n] [--workers n] [--no-open] [--rebuild]\n'); return 0; }
  if (!dir) { console.error('usage: reva scan open <scan folder> [--all] [--port n] [--workers n] [--no-open] [--rebuild]'); return 2; }
  const out = path.resolve(dir);
  if (!fs.existsSync(path.join(out, 'scan.json'))) { console.error(`${dir} is not a scan folder (no scan.json)`); return 2; }
  const log = (m) => process.stderr.write(m + '\n');
  if (f.rebuild || !fs.existsSync(path.join(out, 'card.html')) || !fs.existsSync(path.join(out, 'stage'))) writeScanCard(out, { log });
  const workers = Number.isFinite(+f.workers) && +f.workers > 0 ? +f.workers : defaultWorkers();
  if (f.all) { const r = await fitAll(out, { workers, log }); console.log(fitLine(r)); }
  const s = await startServer(out, { port: Number.isFinite(+f.port) ? +f.port : 0, workers, prefit: !f.all, log });
  console.log(`card: ${s.url}`);
  console.log('Ctrl-C stops the server. The card also opens from the folder, without fitting.');
  if (f.open !== false && !f['no-open']) openBrowser(s.url);
  await new Promise((r) => { process.once('SIGINT', r); process.once('SIGTERM', r); });
  await s.close();
  return 0;
}

export const fitLine = (r) => `${r.motions} motions: ${r.fitted} fitted${r.reused ? `, ${r.reused} already were` : ''}${r.failed.length ? `, ${r.failed.length} failed` : ''}${r.cut.length ? `, ${r.cut.length} stopped at their budget` : ''}; ${Math.round(r.wallMs / 1000)} s on ${r.workers} workers`;
