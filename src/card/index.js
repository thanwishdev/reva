// REVA motion card: one self-contained HTML file per look result (plan item 1.3).
// `look ... --card` writes it next to look.json; `card <look.json> [--out file.html]` builds it from a saved result.
import fs from 'node:fs';
import path from 'node:path';
import { buildCardData } from './data.js';
import { renderCard } from './render.js';
import { buildCardHtml } from './build.js';
import { assertOutsideRepo } from '../util/paths.js';

export { buildCardData, renderCard };

/** look result (object) -> card HTML string. */
// the real card is the approved page (page/template.html) with this look injected; data.js / render.js stay for the MCP card tool
export const cardHtml = (look) => buildCardHtml(look);

/** Write card.html for a look result; returns the path. Default location: the look result's own folder. */
export function writeCard(look, { out = null, rows } = {}) {
  const file = out || path.join(look.dir || '.', 'card.html');
  // a card is site-derived output: never inside the repo (PLAN H2, the rule libdetect enforces too)
  assertOutsideRepo(path.dirname(path.resolve(file)));
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, cardHtml(look));
  return file;
}

/** `reva card <look.json|folder> [--out card.html]` */
export async function runCardCommand(f) {
  let input = f._[1];
  if (!input) { console.error('usage: reva card <look.json | look folder> [--out card.html]'); return 2; }
  if (fs.existsSync(input) && fs.statSync(input).isDirectory()) input = path.join(input, 'look.json');
  let look;
  try { look = JSON.parse(fs.readFileSync(input, 'utf8')); } catch (e) { console.error(`card: cannot read ${input}: ${e.message}`); return 2; }
  if (!String(look.schema || '').startsWith('reva.look') && !Array.isArray(look.motions)) { console.error(`card: ${input} is not a look result`); return 2; }
  const file = writeCard({ ...look, dir: path.dirname(path.resolve(input)) }, { out: typeof f.out === 'string' ? f.out : null });
  console.log(`card: ${path.resolve(file)}`);
  return 0;
}
