// CLI face of the contract: `reva tools`, `reva tool <name> [flags]`, `reva mcp`, and short aliases for the tools
// that have one command name (report, fit, ...). Flags are derived from each tool's input schema, so CLI and MCP cannot drift.
//   --args '<json>'   whole input as JSON      --json   print the envelope as JSON     --<prop> <value>   one property
// kebab-case flags map to snake_case properties (--take-dir -> take_dir). Exit codes: 0 ok, 1 failed, 2 usage, 75 quota cap.
import { allTools, publicTools, runTool, findTool } from './contract.js';
import { toText } from './envelope.js';
import { coerceCli } from './schema.js';
import { serveStdio } from './server.js';
import { EXIT_CAP } from '../quota/watchdog.js';

/** Existing/short command names that dispatch to a contract tool (the integrator wires these into src/cli.js). */
export const ALIASES = { code: 'code', curve: 'curve', analyze: 'look', export: 'code', specimen: 'card', series: 'curve', motions: 'motions', report: 'report', records: 'motion_records', unknowns: 'unknowns', rebuild_specimen: 'rebuild_specimen', score: 'score', verify: 'verify', quota: 'quota_status' };

export function inputFromFlags(tool, f) {
  let input = {};
  if (f.args) { try { input = JSON.parse(f.args); } catch { throw new Error('--args is not valid JSON'); } }
  const props = tool.inputSchema.properties || {};
  const pos = tool.cli?.positional || [];
  pos.forEach((name, i) => { if (f._[i] !== undefined && input[name] === undefined) input[name] = coerceCli(props[name] || {}, f._[i]); });
  const rest = f._.slice(pos.length);
  const multi = Object.entries(props).find(([, s]) => s.type === 'array'); // extra positionals fill the first array property (e.g. report <fit...>)
  for (const [k, raw] of Object.entries(f)) {
    if (['_', 'args', 'json', 'rest'].includes(k)) continue;
    const prop = k.replace(/-/g, '_');
    if (!props[prop]) throw new Error(`unknown flag --${k} (properties: ${Object.keys(props).join(', ') || 'none'})`);
    input[prop] = coerceCli(props[prop], raw);
  }
  if (rest.length && multi && input[multi[0]] === undefined) input[multi[0]] = rest;
  else if (rest.length && !(multi && input[multi[0]] !== undefined)) throw new Error(`unexpected argument ${rest[0]}`);
  return input;
}

export function toolsHelp(tools) {
  return ['tools (one contract for CLI and MCP; [mcp] = listed by the MCP server):', ...tools.map((t) => `  ${t.name.padEnd(15)}${t.surface === 'public' ? '[mcp] ' : ''}${t.heavy ? '[heavy] ' : ''}${t.description.split('. ')[0]}`), '', 'reva tool <name> [positional] [--prop value] [--args json] [--json]', (tools.some((t) => t.surface !== 'public') ? 'reva mcp [--allow-local] [--surface all]   serve the public tools (or all) over MCP (stdio)' : 'reva mcp [--allow-local]   serve these tools over MCP (stdio)')].join('\n');
}

/**
 * Handle a contract command. Returns an exit code, or undefined when `cmd` is not one of ours (the caller continues).
 * @param {string} cmd  f._[0]; @param {object} f parsed flags ({_: [...], key: value})
 */
export async function contractCommand(cmd, f, io = { out: (s) => console.log(s), err: (s) => console.error(s) }, { surface = 'public' } = {}) {
  // surface 'public' (the published `reva`): only the public tools, which open a live page only through the safety gate
  // (robots.txt, walls). 'all' (a research checkout, see src/cli.js) adds the internal pipeline tools.
  const listTools = async () => (surface === 'all' ? allTools() : publicTools());
  // `mcp [--allow-local] [--surface all]`: the opt-ins are the server owner's, never a tool argument the model could set
  if (cmd === 'mcp') {
    if (surface !== 'all' && f.surface && f.surface !== 'public') { io.err(`--surface ${f.surface}: this build serves the public tools only`); return 2; }
    // an explicit 'public' also beats REVA_MCP_SURFACE=all in the environment
    await serveStdio({ ctx: f['allow-local'] ? { allowLocal: true } : {}, surface: surface === 'all' ? (f.surface === 'all' ? 'all' : undefined) : 'public' }); return 0;
  }
  if (cmd === 'tools') { const tools = await listTools(); io.out(f.json ? JSON.stringify(tools.map((t) => ({ name: t.name, surface: t.surface || 'internal', description: t.description, heavy: !!t.heavy, inputSchema: t.inputSchema })), null, 1) : toolsHelp(tools)); return 0; }
  let name; let g = f;
  if (cmd === 'tool') { name = f._[1]; g = { ...f, _: f._.slice(2) }; if (!name) { io.err(toolsHelp(await listTools())); return 2; } }
  else if (ALIASES[cmd]) { name = ALIASES[cmd]; g = { ...f, _: f._.slice(1) }; }
  else return undefined;
  const tools = await listTools(); const tool = findTool(tools, name);
  if (!tool && cmd !== 'tool') return undefined;   // a short name of a tool this build does not have: the caller's usage
  if (!tool) { io.err(`no tool "${name}"\n${toolsHelp(tools)}`); return 2; }
  let input; try { input = inputFromFlags(tool, g); } catch (e) { io.err(e.message); return 2; }
  // the terminal user is the owner: local targets are theirs to open (the MCP blocks them unless the server opted in)
  const r = await runTool(name, input, { tools, allowLocal: true });
  io.out(toText(r, { json: !!f.json }));
  return r.ok ? 0 : r.error.code === 'quota_cap' ? EXIT_CAP : r.error.code === 'bad_arguments' ? 2 : 1;
}
