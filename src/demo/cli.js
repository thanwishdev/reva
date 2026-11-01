// `reva demo`: the first run. Serves REVA's own demo page (src/demo/page, shipped in the package) on 127.0.0.1 and runs
// one look on it, motion card included, so a new user sees a full result without picking a site. No network: the page
// has no external requests and the server listens on loopback only, for this one look.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveFixtureDir } from '../mcp/fixture.js';

export const DEMO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page');
// what each action looks at on the demo page
const DEFAULT_EL = { load: null, hover: '#card-1', click: '.knob', scroll: '.progress' };
const DEFAULT_ON = { click: '#toggle' };

export const DEMO_HELP = `reva demo [--do load|hover|click|scroll] [--el <selector>] [--color-scheme light|dark] [--no-card] [--json] [--code]

  Runs "reva look" on REVA's own demo page (bundled, served on 127.0.0.1; no network) and writes the motion card.
  --do load    the elements that move when the page loads (default): a CSS rise, a fade, a JS spring
  --do hover   the first card lifting on hover (#card-1)
  --do click   the switch knob sliding when the switch is clicked
  --do scroll  the reading-progress bar tied to the scroll
  --color-scheme dark  read the demo page in the dark colour scheme (default light); the motion is the same in both
  Other look options (--code, --json, --verbose) pass through. Next: reva look <your url> ... (reva look --help).`;

export async function runDemoCommand(f) {
  if (f.help) { console.error(DEMO_HELP); return 0; }
  const action = typeof f.do === 'string' ? f.do : 'load';
  if (!(action in DEFAULT_EL)) { console.error(`unknown --do ${action} (use load, hover, click, scroll)`); return 2; }
  const el = typeof f.el === 'string' ? f.el : DEFAULT_EL[action];
  const on = typeof f.on === 'string' ? f.on : (typeof f.el === 'string' ? undefined : DEFAULT_ON[action]);
  const srv = await serveFixtureDir({ root: DEMO_ROOT, page: 'index.html' });
  let code;
  try {
    const { runLookCommand } = await import('../look/cli.js');
    code = await runLookCommand({ ...f, _: ['look', srv.url], _demo: true, do: action, ...(el ? { el } : {}), ...(on ? { on } : {}), card: !f['no-card'] });
  } finally { await srv.close(); }
  if (!f.json) console.error(`\nThat was REVA's own demo page. Next: reva look <your url> --do ${action === 'load' ? 'hover --el "<selector>"' : action} (reva look --help)`);
  return code;
}
