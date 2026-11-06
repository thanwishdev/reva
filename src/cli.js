// CLI entry. One contract; summary-first output (PLAN §3 Interface).
import fs from 'node:fs';
import { runDoctor, formatDoctor } from './doctor.js';
import { contractCommand } from './mcp/cli.js';
import { fileURLToPath } from 'node:url';

const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `reva <command>

  demo [--do load|hover|click|scroll]  first run: REVA looks at its own bundled demo page (no network) and writes a motion card
  look <url|archive> [--el <selector> | --pick [key|N]] [--do load|hover|click|scroll] [--on <selector|x,y>] [--json] [--code]
                                      record one element during one action and say how it moves in plain words
                                      (every number marked exact / fitted / unknown); "look --help" for all options
                                      --color-scheme light|dark on demo, look, design and compare: the scheme the page is read in
  design <url|archive> [--json] [--tokens] [--ignore-robots] [--engine cft|chs]
                                      how the page is designed: fonts, type sizes, colours and contrast, spacing, shadows,
                                      layout, breakpoints, hover / focus; "design --help" for more
  card <look.json|look folder> [--out card.html]
                                      one HTML page of the motions you looked at, with curves, values and code to copy
                                      ("look ... --card" writes it right away)
  compare <url-a> <url-b> [--do load|hover|click|scroll] [--el <selector>] [--on <selector>] [--card]
                                      look at two pages the same way and say how their motion differs
                                      (e.g. the original site vs your rebuild)
  scan <url> [--out <dir>] [--one-page] [--keep-archive] [--all]
                                      capture a site in depth, one page per template: both viewports, every moment (load, idle,
                                      scroll down and up, hover, focus, press, menus, page changes), every moving element, a picture
                                      of every frame, and a ledger of what was and was not captured; ends in a card of the site's moves;
                                      "scan --help" says exactly what it does to the site
  scan moves <dir> [--json] [--id m-...]
                                      the moves of a finished scan for you or an agent: one line each, or one move in full
  scan open <dir> [--all]             the scan's card with its Study view, fitting a motion when it is clicked (a server on this machine only)
  doctor [--json] [--install [--force] [--from file.zip]]
                                      check this machine; --install first downloads the headless browser into ~/.reva (no sudo)
  mcp [--allow-local]                 serve the same tools to an AI agent such as Claude Code (stdio)
  tools | tool <name> [...]           list those tools / run one on the command line (look, motions, design, code, curve, card, unknowns, compare, doctor, scan_moves, scan_move)
  --version, -v                       print the version
`;

function flags(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { f.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) { const k = a.slice(2); const nxt = argv[i + 1]; if (nxt === undefined || nxt.startsWith('--')) f[k] = true; else { f[k] = nxt; i++; } }
    else f._.push(a);
  }
  return f;
}

// Optional command groups that are not part of the public build: a checkout may add src/ext/index.js exporting
// { help: string, commands: { name: (sub, flags, argv) => exit code }, devCommand?: (cmd, sub, flags, argv) => exit code
// | undefined, contractSurface?: 'all' }. Absent in the published package, whose surface is the public commands above.
const EXT_FILE = new URL('./ext/index.js', import.meta.url);
async function loadExt() {
  return fs.existsSync(fileURLToPath(EXT_FILE)) ? import(EXT_FILE.href) : null;
}

export async function main(argv) {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) { console.log(`reva ${PKG_VERSION}`); return 0; }
  const f = flags(argv);
  const [cmd, sub] = f._;
  const ext = await loadExt();
  if (ext?.commands && Object.hasOwn(ext.commands, cmd)) return ext.commands[cmd](sub, f, argv);
  switch (cmd) {
    case 'doctor': {
      if (f.install) {
        const { installHeadlessShell } = await import('./install/install.js');
        try {
          const i = await installHeadlessShell({ from: typeof f.from === 'string' ? f.from : undefined, force: !!f.force, log: (m) => console.error(m) });
          console.error(i.status === 'already' ? `browser already installed${i.verified ? '' : ' (not installed by REVA, not checksum-verified)'}: ${i.executablePath}` : `browser installed: ${i.executablePath}`);
        } catch (e) { console.error(`install failed: ${e.message}`); return 1; }
      }
      const r = await runDoctor();
      console.log(f.json ? JSON.stringify(r, null, 2) : formatDoctor(r));
      return r.ok ? 0 : 1;
    }
    case 'demo': return (await import('./demo/cli.js')).runDemoCommand(f);
    case 'look': return (await import('./look/cli.js')).runLookCommand(f);
    case 'card': return (await import('./card/index.js')).runCardCommand(f);
    case 'scan': return (await import('./scan/cli.js')).runScanCommand(f);
    case 'compare': return (await import('./compare/cli.js')).runCompareCommand(f);
    case 'design': return (await import('./design/cli.js')).designMain(sub, f);
    default: break;
  }
  if (ext?.devCommand) { const code = await ext.devCommand(cmd, sub, f, argv); if (code !== undefined) return code; }
  const code = await contractCommand(cmd, f, undefined, { surface: ext?.contractSurface === 'all' ? 'all' : 'public' });
  if (code !== undefined) return code;
  console.log(HELP + (ext?.help || '')); return cmd ? 2 : 0;
}
