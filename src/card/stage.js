// The scan card: the approved card page with the stage on top of it (PLAN §8). card.html sits next to frames/, stage/ and fits/
// in the scan folder and reads them with relative paths, so the folder moves as one and opens with no server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimLook, scriptJson } from './build.js';
import { buildViewport } from '../scan/stage.js';
import { siteWords } from '../scan/words.js';
import { Ledger } from '../scan/ledger.js';
import { assertOutsideRepo } from '../util/paths.js';
import { cardIndex, injectMoves } from './moves.js';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page');
const MARK = '/*__DATA__*/null';

/** A scan with no look of its own still needs the fields the card reads. */
const EMPTY_LOOK = (scan) => ({ schema: 'reva.look/0', status: 'ok', source: { kind: 'scan', url: scan.url, startUrl: scan.url }, action: { do: 'load' }, take: {}, motions: [], others: [] });

/** A page's name in the card: its path, or Home. */
function pageLabel(pg, scan) {
  try { const p = new URL(pg.url).pathname.replace(/\/$/, ''); return p && pg.id !== 'home' ? p : 'Home'; } catch { return pg.id === 'home' ? 'Home' : String(pg.url); }
}

/** @returns {{file:string|null, viewports:object[]}} file is null when no page has pictures */
export function writeScanCard(out, { log = () => {}, keepStage = false } = {}) {
  assertOutsideRepo(path.resolve(out));
  const scan = JSON.parse(fs.readFileSync(path.join(out, 'scan.json'), 'utf8'));
  const ledger = Ledger.read(path.join(out, 'coverage.json'));
  const pages = scan.pages?.length ? scan.pages : [{ id: 'home', url: scan.url, dir: '.' }];
  const built = [], stages = [];
  for (const pg of pages) {
    const vps = [];
    for (const vp of scan.viewports || []) {
      const kept = keepStage && path.join(out, 'stage', `${pg.id}-${vp}.js`);
      const b = kept && fs.existsSync(kept) ? { file: kept } : buildViewport(out, pg, vp, { log });
      if (b) { vps.push(vp); built.push(b); }
    }
    if (vps.length) stages.push({ id: pg.id, url: pg.url, viewports: vps, label: pageLabel(pg, scan) });
  }
  if (!stages.length) return { file: null, viewports: [] };
  // one look per page: the Design and Libraries pages follow the page on the stage
  const looks = {};
  for (const pg of pages) {
    const dir = path.join(out, pg.dir, 'look'), lf = path.join(dir, 'look.json');
    if (fs.existsSync(lf)) looks[pg.id] = trimLook({ ...JSON.parse(fs.readFileSync(lf, 'utf8')), motions: [], page: null, gl: null, screens: null, dir }, dir);
  }
  const first = looks[stages[0]?.id] || trimLook(EMPTY_LOOK(scan), null);
  const site = siteWords(scan, ledger);
  // moves.json present: the card opens on the moves, the stage becomes Study. An older folder keeps the card it had.
  const movesFile = path.join(out, 'moves.json');
  const moves = fs.existsSync(movesFile) ? cardIndex(JSON.parse(fs.readFileSync(movesFile, 'utf8')), { coverage: site.coverage ?? null, missing: site.missing ?? [] }) : null;
  const data = { look: first, scan: { looks, host: scan.host, url: scan.url, dirName: path.basename(path.resolve(out)), pages: stages, site }, ...(moves ? { moves } : {}) };
  const tpl = fs.readFileSync(path.join(PAGE, 'template.html'), 'utf8');
  if (!tpl.includes(MARK)) throw new Error('card template has no data marker');
  // stage.html holds the stage's <style> and <script>: the style joins the head, the script runs after the card's own
  const stage = fs.readFileSync(path.join(PAGE, 'stage.html'), 'utf8'), cut = stage.indexOf('<script>');
  const html = tpl.replace(MARK, () => scriptJson(data)).replace('</head>', () => `${stage.slice(0, cut)}</head>`);
  const end = html.lastIndexOf('</body>');
  const file = path.join(out, 'card.html');
  const full = html.slice(0, end) + stage.slice(cut) + html.slice(end);
  fs.writeFileSync(file, moves ? injectMoves(full) : full);
  return { file, viewports: built };
}
