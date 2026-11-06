// `reva scan <url>`: command-line entry (summary first: the first line is the ledger's count per status).
import path from 'node:path';
import { stripControls } from '../report/untrusted.js';
import fs from 'node:fs';
import { scanPage, MOMENTS } from './index.js';
import { finishScan } from './finish.js';
import { EXIT_ADMISSION } from './admission.js';
import { reasonOf } from './ledger.js';
import { PROJECT_URL } from '../safety/robots.js';

export const SCAN_HELP = `reva scan <url> [--out <dir>] [--engine cft|chs] [--no-frames] [--keep-archive] [--one-page] [--all] [--lanes 1]
reva scan moves <dir> [--json] [--id m-...]
reva scan open <dir> [--all] [--port n] [--no-open]
  capture a site in depth, one page per template (--one-page: this page only): both viewports (desktop 1440, phone 390), every moment (load, idle, scroll down, scroll back up, the pointer across the page)
  on the virtual clock, every moving element (no cap), hover, focus and press per interactive pattern, every menu or dialog a
  click opens (depth 1), one page change per pair of templates, pictures wherever something moved, and a ledger (coverage.json) with
  one row per unit and the reason for every unit that was not captured.
  What it does to the site: reads robots.txt first and stops on a block or a bot / login / region wall; lists the site (sitemap,
  links, up to 250 pages fetched to tell templates apart) and loads each page it records in each viewport, the home page again
  for each pass that fetches files the recording missed, and the whole visit once more if the copy fails its check.
  A click that starts a WebGL experience loading (a 3D world behind an "enter" button) is pressed once more in a take of its own,
  which waits up to 60 s for it to draw; the files it asks for then are fetched under the same rules.
  Every request to the site's hosts, a page's own files included, waits 500 ms after the one before to that host (more if
  robots.txt sets a Crawl-delay), and pages are 10 s apart; another site's host the page loads from gets at most one request
  per 100 ms. Every URL of the site and every page the browser goes to is checked against robots.txt first; the browser
  never leaves the site. On any answer, a 429, a 503 with Retry-After or a challenge page stops all traffic to the site and
  keeps what was captured; a login or region wall on an inner page leaves that page out. Every request names REVA and
  ${PROJECT_URL} in its user agent; the phone presents itself as Chrome on Android (mobile, touch, DPR 2). It passes an
  Enter screen, but never clicks accept, never answers an age gate, never signs in, never submits a form.
  The result is one folder: card.html opens from disk and shows the moves of the site, each framed, with what sets it off, its curve,
  how REVA knows and code that pastes. moves.json is the same for an agent; \`reva scan moves <dir>\` lists it, --id prints one move.
  The Study view fits a motion on a click when opened with \`reva scan open <dir>\` (a small server on this machine only); --all fits
  every one of those first. Pictures become video with the browser's own encoder.
  It keeps a temporary copy of the pages so the recording is repeatable, and deletes that copy when the scan ends
  (--keep-archive keeps it; a scan cut short keeps it in the output folder so the same command can go on). Pictures and numbers
  stay in the output folder on your machine.
  Desktop and phone record side by side when the machine has the cores and memory (--lanes 1: one after the other); the recording is the same.
  A scan that is stopped, or runs out of disk, goes on from where it was when the same command runs again with the same --out.
  Exit code: 0 done, 1 not everything captured (see coverage.json), 2 usage, 3 this machine is too small or ran out of room (the reason is printed).
`;

const safe = (s) => stripControls(String(s));

/** One line per move, under 300 bytes. Names are page text, shown as data. */
export function moveLine(m) {
  const time = m.time?.ms != null ? `${m.time.ms} ms` : '-';
  const line = `${m.id}  ${m.kind}  ${time}  ${m.curve?.name || m.curve?.kind || '-'}  ${m.proof?.source || '-'}  ×${m.n ?? 1}  ${safe(m.name ?? '').slice(0, 120)}`;
  return Buffer.byteLength(line) < 300 ? line : Buffer.from(line).subarray(0, 296).toString('utf8').replace(/\uFFFD+$/, '');
}

/** `reva scan moves <dir> [--json] [--id m-...]` */
export function runMovesCommand(f) {
  const dir = f._[2];
  if (f.help) { process.stdout.write('usage: reva scan moves <scan folder> [--json] [--id m-...]\n'); return 0; }
  if (!dir) { console.error('usage: reva scan moves <scan folder> [--json] [--id m-...]'); return 2; }
  let index;
  try { index = JSON.parse(fs.readFileSync(path.join(dir, 'moves.json'), 'utf8')); } catch { console.error(`${safe(dir)} has no moves.json`); return 2; }
  if (typeof f.id === 'string') {
    if (!/^m-[0-9a-f]{8}(-\d+)?$/.test(f.id)) { console.error(`not a move id: ${safe(f.id)}`); return 2; }
    let doc; try { doc = JSON.parse(fs.readFileSync(path.join(dir, 'moves', `${f.id}.json`), 'utf8')); } catch { console.error(`no move ${f.id} in this folder`); return 1; }
    const entry = index.moves.find((m) => m.id === f.id) ?? null;
    if (f.json) process.stdout.write(JSON.stringify({ entry, move: doc }) + '\n');
    else process.stdout.write([moveLine(entry ?? { id: f.id }), safe(entry?.sentence ?? ''), safe(doc.timing ?? ''), doc.code?.css ?? ''].filter(Boolean).join('\n') + '\n');
    return 0;
  }
  if (f.json) process.stdout.write(JSON.stringify(index) + '\n');
  else process.stdout.write(index.moves.map(moveLine).join('\n') + '\n');
  return 0;
}

export function formatScan(r) {
  const { scan } = r, ledger = r.ledger;
  const L = [ledger.firstLine()];
  if (scan.stopped) L.push(`stopped: ${safe(scan.stopped)}`);
  const page = ledger.rows.find((x) => x.unit === 'page');
  if (scan.pages?.length) L.push(`${scan.pages.length} pages recorded, ${ledger.rows.filter((x) => x.unit === 'page' && x.status === 'duplicate-of').length} more share their templates; ${ledger.rows.filter((x) => x.unit === 'page-change' && x.status === 'captured' && x.id !== 'all').length} page changes`);
  for (const vp of scan.viewports || []) {
    const v = ledger.get('viewport', page?.id, vp, vp);
    if (!v) continue;
    if (v.status !== 'captured') { L.push(`${vp}: ${v.status}, ${safe(v.reason)}`); continue; }
    const parts = MOMENTS.map((m) => {
      const x = ledger.get('moment', page.id, vp, m);
      return x ? `${m} ${x.status}${x.reason ? ' (' + safe(x.reason).slice(0, 80) + ')' : ''}` : `${m} none`;
    });
    L.push(`${vp}: ${parts.join(', ')}`);
    for (const u of ['pattern', 'open-state']) { const a = ledger.get(u, page.id, vp, 'all'); if (a?.reason) L.push(`  ${safe(a.reason)}`); }
  }
  const moves = ledger.rows.filter((x) => x.unit === 'move').length;
  if (moves) L.push(`${moves} moves`);
  const notDone = ledger.rows.filter((x) => !['captured', 'duplicate-of', 'predicted-same', 'none'].includes(x.status));
  for (const x of notDone.slice(0, 12)) L.push(`  ${x.unit} ${safe(x.id).slice(0, 60)}${x.viewport ? ' [' + x.viewport + ']' : ''}: ${x.status}, ${safe(reasonOf(x) ?? '').slice(0, 160)}`);
  if (notDone.length > 12) L.push(`  ... ${notDone.length - 12} more in coverage.json`);
  if (!r.check.ok) L.push(`LEDGER CHECK FAILED: ${r.check.missing.length} unit(s) without a row, ${r.check.problems.length} row problem(s) (a bug in the scan)`);
  const mb = Object.values(scan.takes || {}).reduce((a, t) => a + (t.frames?.bytes || 0), 0) / 1e6;
  L.push(`${Math.round((scan.wallMs || 0) / 1000)} s, ${mb.toFixed(0)} MB of pictures; archive ${scan.archive || 'n/a'}`);
  L.push(`output: ${scan.out}`);
  L.push(`ledger: ${path.join(scan.out, 'coverage.json')}`);
  return L.join('\n');
}

export async function runScanCommand(f) {
  if (f._[1] === 'open') return (await import('./open.js')).runOpenCommand(f);
  if (f._[1] === 'moves') return runMovesCommand(f);
  const url = f._[1];
  // asked for help: help on stdout, exit 0; no URL at all: a usage error
  if (f.help || url === 'help') { process.stdout.write(SCAN_HELP); return 0; }
  if (!url) { console.error(SCAN_HELP); return 2; }
  try { new URL(url); } catch { console.error(`not a URL: ${url}`); return 2; }
  if (!/^https?:$/.test(new URL(url).protocol)) { console.error('reva scan opens http(s) pages only'); return 2; }
  const log = (m) => process.stderr.write(m + '\n');
  let r;
  try {
    r = await scanPage(url, {
      out: typeof f.out === 'string' ? f.out : undefined, engine: typeof f.engine === 'string' ? f.engine : undefined,
      fromArchive: typeof f['from-archive'] === 'string' ? f['from-archive'] : undefined, keepArchive: !!f['keep-archive'], frames: !f['no-frames'], onePage: !!f['one-page'], lanes: +f.lanes === 1 ? 1 : undefined, patternMembers: Number.isInteger(+f['pattern-members']) && +f['pattern-members'] > 0 ? +f['pattern-members'] : undefined, log,
    });
  } catch (e) {
    if (e && e.code) { console.error(safe(e.message)); return e.code === 'bad_arguments' ? 2 : 1; }
    throw e;
  }
  const anyTake = Object.keys(r.scan.takes || {}).length > 0;
  const fin = anyTake && !f['no-frames'] ? await finishScan(r.out, { all: !!f.all, engine: r.scan.engine, log }) : null;
  // the finish adds the moves' rows and checks the ledger again, so its answer is the last word
  const ledger = fin?.ledger ?? r.ledger, exit = r.exit === EXIT_ADMISSION ? r.exit : fin?.exit ?? r.exit;
  if (f.json) process.stdout.write(JSON.stringify({ line: ledger.firstLine(), exit, out: r.out, scan: r.scan, ledger: ledger.toJSON(), card: fin?.card ?? null, moves: fin?.moves ?? null, clips: fin?.clips ?? null, fit: fin?.fit ? { ms: fin.fit.ms, classes: fin.fit.classes, ledger: fin.fit.ledger } : null, problems: fin?.problems ?? [] }) + '\n');
  else {
    process.stdout.write(formatScan({ ...r, ledger }) + '\n');
    if (fin?.card) process.stdout.write(`card: ${fin.card}\nthe moves, for an agent: reva scan moves ${r.out}\n`);
    for (const p of fin?.problems || []) process.stdout.write(`${safe(p)}\n`);
  }
  if (r.exit === EXIT_ADMISSION) console.error(`this machine cannot run a scan now: ${safe(r.scan.stopped)}`);
  return exit;
}
