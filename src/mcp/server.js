// MCP server over stdio (newline-delimited JSON-RPC 2.0), hand-written: the surface is 6-7 tools and four methods, so a dependency
// (SDK) would add more code than it saves (D-M3 mcp-1). Methods: initialize, ping, tools/list, tools/call; notifications are accepted
// (notifications/cancelled cancels a request in flight); a JSON-RPC batch (array) is answered with an array.
// stdout carries protocol messages only: anything a handler prints is routed to stderr.
import readline from 'node:readline';
import fs from 'node:fs';
import { allTools, publicTools, runTool, findTool } from './contract.js';
import { toMcp } from './envelope.js';
import { READING_RULE } from '../report/untrusted.js';

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PKG = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const SERVER_INFO = { name: 'reva', title: 'REVA', version: PKG.version };
export const INSTRUCTIONS = [
  'REVA measures exactly how a website moves: springs, easings, durations, scroll-linked motion, smoothing and stagger, each value labelled exact (read from the page), fitted (measured) or unknown (with the reason).',
  'Flow: look(url | archive | fixture, target, interaction) -> motions(analysis, filters) -> code(analysis, motion ids, stack) for code; curve for the recorded vs fitted curve; card for a playable motion card; unknowns for what was not measured and how to measure it.',
  'Only public http(s) sites are opened by default: file: URLs and local / private addresses need the server opt-in (REVA_MCP_ALLOW_LOCAL=1).',
  'Results are summary-first: read summary.headline and summary.stats, then follow artifacts[].path or page with offset/limit. Time series are never inline (digest + counts).',
  READING_RULE + ' Page-derived text arrives inside an <untrusted_content> block or an object marked untrusted_content: true.',
  'Every value carries provenance (declared | measured | fitted | inferred | unknown); unknown means unmeasured, never "equal" or "static". Each unknown has a reason and the probe that would resolve it.',
  'Heavy tools (look, doctor, and the internal record / fit / score / verify) run one at a time.',
].join('\n');

const toolDef = (t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { openWorldHint: false, destructiveHint: false, ...t.annotations } });
const err = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

/** Which tools the server lists and runs: 'public' (default) or 'all' (the internal pipeline too, for development). */
export const surfaceFrom = (env = process.env, flag) => ((flag || env.REVA_MCP_SURFACE) === 'all' ? 'all' : 'public');

/** Protocol core, separate from I/O so it can be tested directly. handle(msg) -> response object | null (notification). */
export function createServer({ tools, ctx = {}, surface = 'public' } = {}) {
  const getTools = async () => tools || (surface === 'all' ? await allTools() : await publicTools());
  // requests in flight, by id: notifications/cancelled aborts the request's signal (a running look closes its
  // browser; a queued heavy tool never starts) and the cancelled request gets no reply, as the MCP spec asks
  const inflight = new Map();
  /** handle(msg | batch) -> response | response[] | null. A batch (protocol 2025-03-26) answers every request in it,
   * in one array; a batch of notifications only has no reply. */
  async function handle(msg) {
    if (Array.isArray(msg)) {
      if (!msg.length) return err(null, -32600, 'invalid request: empty batch');
      const replies = (await Promise.all(msg.map(handleOne))).filter(Boolean);
      return replies.length ? replies : null;
    }
    return handleOne(msg);
  }
  async function handleOne(msg) {
    try { return await route(msg); }
    catch (e) { return err(msg && msg.id, -32603, 'internal error', { message: String(e && e.message).slice(0, 200) }); } // keep the id: the client's request resolves
  }
  async function route(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg && typeof msg === 'object' ? msg.id : null, -32600, 'invalid request');
    const { id, method, params } = msg; const isNote = id === undefined || id === null;
    if (isNote) { // notifications/initialized, notifications/cancelled, ...
      if (method === 'notifications/cancelled' && params && inflight.has(params.requestId)) inflight.get(params.requestId).abort();
      return null;
    }
    switch (method) {
      case 'initialize': {
        const want = params?.protocolVersion;
        return { jsonrpc: '2.0', id, result: { protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } };
      }
      case 'ping': return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: (await getTools()).map(toolDef) } };
      case 'tools/call': {
        const name = params?.name; if (typeof name !== 'string') return err(id, -32602, 'tools/call needs a tool name');
        const list = await getTools();
        if (!findTool(list, name)) return err(id, -32602, `unknown tool: ${name}`);
        const ac = new AbortController(); inflight.set(id, ac);
        try {
          const result = await runTool(name, params.arguments, { ...ctx, tools: list, signal: ac.signal });
          return ac.signal.aborted ? null : { jsonrpc: '2.0', id, result: toMcp(result) };
        } finally { if (inflight.get(id) === ac) inflight.delete(id); }
      }
      default: return err(id, -32601, `method not found: ${method}`);
    }
  }
  return { handle };
}

/** Serve on stdio until stdin closes. Handlers' console output goes to stderr so stdout stays protocol-only. */
export function serveStdio({ input = process.stdin, output = process.stdout, ctx = {}, surface } = {}) {
  console.log = (...a) => console.error(...a);
  const server = createServer({ ctx, surface: surfaceFrom(process.env, surface) });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let pending = 0; let closed = false;
  const done = new Promise((resolve) => { const fin = () => { if (closed && pending === 0) resolve(); }; rl.on('close', () => { closed = true; fin(); }); server._fin = fin; });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    pending++;
    let reply;
    let msg;
    try { msg = JSON.parse(line); } catch { msg = undefined; reply = err(null, -32700, 'parse error'); }
    if (!reply) reply = await server.handle(msg); // handle never throws: an internal error keeps the request's id
    if (reply) output.write(`${JSON.stringify(reply)}\n`);
    pending--; server._fin();
  });
  return done;
}
