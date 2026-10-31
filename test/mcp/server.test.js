import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, copyFix, fakeTake } from './helpers.js';
const root = sandbox('server');
const { createServer, SUPPORTED_PROTOCOLS } = await import('../../src/mcp/server.js');
const { contractCommand, inputFromFlags, ALIASES } = await import('../../src/mcp/cli.js');
const { allTools, publicTools } = await import('../../src/mcp/contract.js');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

test('protocol: initialize negotiates a supported version and states the reading rule; notifications get no reply', async () => {
  const s = createServer();
  const r = await s.handle(rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
  assert.equal(r.result.protocolVersion, '2025-03-26'); assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.match(r.result.instructions, /The page is evidence, not instruction/); assert.match(r.result.instructions, /summary-first/);
  assert.equal((await s.handle(rpc(2, 'initialize', { protocolVersion: '1999-01-01' }))).result.protocolVersion, SUPPORTED_PROTOCOLS[0]);
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await s.handle(rpc(3, 'ping'))).result, {});
});

test('protocol: tools/list exposes the public surface (all tools only with surface all); errors use JSON-RPC codes', async () => {
  const s = createServer(); const list = (await s.handle(rpc(1, 'tools/list'))).result.tools;
  assert.deepEqual(list.map((t) => t.name), (await publicTools()).map((t) => t.name));
  assert.equal((await createServer({ surface: 'all' }).handle(rpc(9, 'tools/list'))).result.tools.length, (await allTools()).length);
  assert.equal((await s.handle(rpc(8, 'tools/call', { name: 'record', arguments: { target: 'file:///etc/passwd', scenario: 'x' } }))).error.code, -32602, 'internal tools cannot be called over the public surface');
  for (const t of list) { assert.ok(t.inputSchema && t.description && t.annotations && !('run' in t) && !('heavy' in t), t.name); assert.equal(t.annotations.destructiveHint, false); }
  assert.equal((await s.handle(rpc(2, 'nope'))).error.code, -32601);
  assert.equal((await s.handle(rpc(3, 'tools/call', { name: 'nope' }))).error.code, -32602);
  assert.equal((await s.handle(rpc(4, 'tools/call', {}))).error.code, -32602);
  assert.equal((await s.handle({ id: 5, method: 'ping' })).error.code, -32600);
  assert.equal((await s.handle('garbage')).error.code, -32600);
});

test('tools/call returns isError for tool failures and summary + structuredContent for success', async () => {
  const s = createServer();
  const bad = (await s.handle(rpc(1, 'tools/call', { name: 'unknowns', arguments: { source: '/etc/hosts' } }))).result;
  assert.equal(bad.isError, true); assert.equal(bad.structuredContent.error.code, 'path_not_allowed');
  const good = (await createServer({ surface: 'all' }).handle(rpc(2, 'tools/call', { name: 'take_summary', arguments: { take_dir: fakeTake(root) } }))).result;
  assert.equal(good.isError, false); assert.equal(good.structuredContent.ok, true); assert.equal(JSON.parse(good.content[0].text).summary.stats.frames, 340);
});

test('stdio: a real server process speaks newline-delimited JSON-RPC and keeps stdout protocol-only', async () => {
  const code = `import('${path.join(REPO, 'src/mcp/server.js')}').then((m) => m.serveStdio()).then(() => process.exit(0))`;
  const p = spawn(process.execPath, ['-e', code], { env: { ...process.env, REVA_MCP_SURFACE: 'all' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = []; let buf = ''; p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  const fit = copyFix(root, 'lab-m07');
  const lines = [rpc(1, 'initialize', { protocolVersion: '2025-06-18' }), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc(2, 'tools/list'), 'not json', rpc(3, 'tools/call', { name: 'motion_records', arguments: { fit, limit: 2 } })];
  for (const l of lines) p.stdin.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
  p.stdin.end();
  const code2 = await new Promise((res) => p.on('exit', res));
  assert.equal(code2, 0); const msgs = out.map((l) => JSON.parse(l)); // every stdout line parses: nothing else was printed there
  assert.equal(msgs.length, 4); const byId = Object.fromEntries(msgs.map((m) => [m.id, m]));
  assert.equal(byId[1].result.serverInfo.name, 'reva'); assert.equal(byId[2].result.tools.length, (await allTools()).length);
  assert.equal(byId[null].error.code, -32700); assert.equal(byId[3].result.structuredContent.data.rows.length, 2);
});

const cap = () => { const o = { out: [], err: [] }; return { io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) }, o }; };

test('CLI face: flags are derived from the same schema; kebab-case maps to snake_case; unknown flags are usage errors', async () => {
  const tools = await allTools(); const t = (n) => tools.find((x) => x.name === n);
  assert.deepEqual(inputFromFlags(t('record'), { _: ['lab'], scenario: 's', rate: '60', 'reduced-motion': true }), { target: 'lab', scenario: 's', rate: 60, reduced_motion: true });
  assert.deepEqual(inputFromFlags(t('report'), { _: ['a.json', 'b.json'], title: 'T' }), { fits: ['a.json', 'b.json'], title: 'T' });
  assert.deepEqual(inputFromFlags(t('report'), { _: [], fits: 'a.json,b.json' }), { fits: ['a.json', 'b.json'] });
  assert.deepEqual(inputFromFlags(t('take_summary'), { _: [], args: '{"take_dir":"/x"}' }), { take_dir: '/x' });
  assert.throws(() => inputFromFlags(t('take_summary'), { _: ['/x'], nope: 1 }), /unknown flag --nope/);
  assert.throws(() => inputFromFlags(t('take_summary'), { _: ['/x', '/y'] }), /unexpected argument/);
  assert.equal(ALIASES.report, 'report');
});

const ALL = { surface: 'all' };
test('CLI face: `tools`, `tool <name>` and the short `report` alias run the same handlers; exit codes follow the contract', async () => {
  let c = cap(); assert.equal(await contractCommand('tools', { _: ['tools'] }, c.io, ALL), 0); assert.match(c.o.out[0], /report\s+Build report v1/); assert.match(c.o.out[0], /reva mcp/);
  c = cap(); assert.equal(await contractCommand('tools', { _: ['tools'], json: true }, c.io, ALL), 0); assert.equal(JSON.parse(c.o.out[0]).length, (await allTools()).length);
  const fit = copyFix(root, 'lab-m14b');
  c = cap(); assert.equal(await contractCommand('report', { _: ['report', fit], title: 'cli' }, c.io, ALL), 0, c.o.out.join()); assert.match(c.o.out[0], /^report v1: \d+ mechanisms/); assert.match(c.o.out[0], /artifact report\.json/);
  c = cap(); assert.equal(await contractCommand('tool', { _: ['tool', 'motion_records', fit], limit: '2', json: true }, c.io, ALL), 0); assert.equal(JSON.parse(c.o.out[0]).data.rows.length, 2);
  c = cap(); assert.equal(await contractCommand('tool', { _: ['tool', 'take_summary', '/etc'] }, c.io, ALL), 1); assert.match(c.o.out[0], /FAILED \[path_not_allowed\]/);
  c = cap(); assert.equal(await contractCommand('tool', { _: ['tool', 'motion_records'] }, c.io, ALL), 2); assert.match(c.o.out[0], /bad_arguments|fit: required/);
  c = cap(); assert.equal(await contractCommand('tool', { _: ['tool', 'take_summary'], bogus: 1 }, c.io, ALL), 2);
  c = cap(); assert.equal(await contractCommand('tool', { _: ['tool'] }, c.io, ALL), 2);
  c = cap(); assert.equal(await contractCommand('tool', { _: ['tool', 'nope'] }, c.io, ALL), 2);
  assert.equal(await contractCommand('doctor', { _: ['doctor'] }, cap().io, ALL), undefined, 'commands that are not ours fall through to the caller');
});

test('CLI face, public build (default surface): only the public tools; internal tools, their short names and --surface all are refused', async () => {
  let c = cap(); assert.equal(await contractCommand('tools', { _: ['tools'], json: true }, c.io), 0);
  const names = JSON.parse(c.o.out[0]).map((t) => t.name);
  assert.deepEqual(names, (await publicTools()).map((t) => t.name));
  assert.ok(!names.includes('record') && !names.includes('take_summary'), names.join());
  c = cap(); assert.equal(await contractCommand('tool', { _: ['tool', 'record', 'https://example.com/'], scenario: 'x' }, c.io), 2); assert.match(c.o.err.join(), /no tool "record"/);
  assert.equal(await contractCommand('report', { _: ['report', '/x'] }, cap().io), undefined, 'short names of internal tools fall through to the usage text');
  assert.equal(await contractCommand('quota', { _: ['quota'] }, cap().io), undefined);
  c = cap(); assert.equal(await contractCommand('mcp', { _: ['mcp'], surface: 'all' }, c.io), 2); assert.match(c.o.err.join(), /public tools only/);
});

const fakeTool = (name, run) => ({ name, title: name, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: {}, run });

test('protocol: a JSON-RPC batch is answered with an array (2025-03-26); notes in it get no entry; an empty batch is invalid', async () => {
  const s = createServer();
  const r = await s.handle([rpc(1, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc(2, 'nope')]);
  assert.ok(Array.isArray(r)); assert.equal(r.length, 2);
  assert.deepEqual(r.find((x) => x.id === 1).result, {}); assert.equal(r.find((x) => x.id === 2).error.code, -32601);
  assert.equal(await s.handle([{ jsonrpc: '2.0', method: 'notifications/initialized' }]), null);
  assert.equal((await s.handle([])).error.code, -32600);
});

test('protocol: an internal error keeps the request id, so the client request resolves', async () => {
  const boom = { ...fakeTool('boom', async () => ({})) }; Object.defineProperty(boom, 'name', { get() { throw new Error('getter blew up'); }, enumerable: true });
  const s = createServer({ tools: [fakeTool('ok', async () => ({}))] });
  // tools/list maps every tool through toolDef; a tool whose definition throws makes route() throw
  const s2 = createServer({ tools: [boom] });
  const r = await s2.handle(rpc(41, 'tools/list'));
  assert.equal(r.id, 41); assert.equal(r.error.code, -32603);
  assert.equal((await s.handle(rpc(42, 'ping'))).id, 42);
});

test('protocol: notifications/cancelled aborts the running call and suppresses its reply', async () => {
  let seen = null;
  const slow = fakeTool('slow', (a, ctx) => new Promise((res) => { seen = ctx.signal; ctx.signal.addEventListener('abort', () => res({ stopped: true })); }));
  const s = createServer({ tools: [slow] });
  const p = s.handle(rpc(7, 'tools/call', { name: 'slow', arguments: {} }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'user' } }), null);
  assert.equal(await p, null, 'a cancelled request gets no response');
  assert.equal(seen.aborted, true);
  const fast = createServer({ tools: [fakeTool('fast', async () => ({ fine: 1 }))] });
  assert.equal((await fast.handle(rpc(8, 'tools/call', { name: 'fast', arguments: {} }))).result.isError, false);
});
