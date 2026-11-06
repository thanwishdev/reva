// Plain tool names: the CLI and the MCP use the same words (look, code, card, curve); the old names stay as hidden aliases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.js';
sandbox('names');
const { createServer } = await import('../../src/mcp/server.js');
const { contractCommand, ALIASES } = await import('../../src/mcp/cli.js');
const { allTools, publicTools, runTool, LEGACY_NAMES } = await import('../../src/mcp/contract.js');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const OLD = ['analyze', 'export', 'specimen', 'series'];
const cap = () => { const o = { out: [], err: [] }; return { o, io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) } }; };

test('tools/list shows the new names only; the old names are not listed', async () => {
  const names = (await publicTools()).map((t) => t.name);
  assert.deepEqual(names, ['look', 'motions', 'design', 'code', 'curve', 'card', 'unknowns', 'doctor', 'compare', 'scan_moves', 'scan_move']);
  const listed = (await createServer().handle(rpc(1, 'tools/list'))).result.tools;
  for (const o of OLD) assert.ok(!listed.some((t) => t.name === o), `${o} must not be listed`);
  const titles = Object.fromEntries(listed.map((t) => [t.name, t.title]));
  assert.deepEqual([titles.look, titles.code, titles.card, titles.curve], ['Look at motion', 'Code for motions', 'Motion card', 'Recorded curve']);
  assert.ok(!(await allTools()).some((t) => OLD.includes(t.name)), 'not in the internal list either');
});

test('server instructions and tool descriptions use the new words', async () => {
  const init = (await createServer().handle(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }))).result.instructions;
  for (const w of ['look(', 'code(', 'curve', 'card']) assert.ok(init.includes(w), w);
  for (const o of ['analyze', 'specimen', 'export(']) assert.ok(!init.includes(o), `instructions still say ${o}`);
  for (const t of await publicTools()) assert.ok(!/\banalyze\b/.test(t.description), `${t.name} description says analyze`);
});

test('old names still run the new tool (runTool and tools/call); the envelope names the new tool', async () => {
  assert.deepEqual(LEGACY_NAMES, { analyze: 'look', export: 'code', specimen: 'card', series: 'curve' });
  const a = await runTool('series', { analysis: 'no-such-analysis', motion: 'm1' });
  const b = await runTool('curve', { analysis: 'no-such-analysis', motion: 'm1' });
  assert.equal(a.ok, false); assert.equal(a.error.code, 'not_found'); assert.equal(a.tool, 'curve'); assert.equal(b.tool, 'curve');
  assert.match(a.error.hint, /run look first/);
  const s = createServer();
  const viaOld = (await s.handle(rpc(2, 'tools/call', { name: 'export', arguments: { analysis: 'no-such-analysis', motions: ['m1'] } }))).result;
  assert.equal(viaOld.isError, true);
  assert.ok(!(await s.handle(rpc(3, 'tools/call', { name: 'nope', arguments: {} }))).result, 'unknown names are still refused');
  const bad = await runTool('analyze', { url: 'file:///etc/passwd' }, { runLook: async () => { throw new Error('must not run'); } });
  assert.equal(bad.tool, 'look'); assert.equal(bad.error.code, 'target_blocked');
});

test('CLI: `reva tool <old or new name>` and the short names reach the same tool', async () => {
  for (const [cmd, tool] of [['tool', 'series'], ['tool', 'curve'], ['series', null], ['curve', null]]) {
    const c = cap(); const f = { _: tool ? [cmd, tool] : [cmd], analysis: 'no-such-analysis', motion: 'm1', json: true };
    assert.equal(await contractCommand(cmd, f, c.io), 1);
    assert.equal(JSON.parse(c.o.out[0]).tool, 'curve');
  }
  assert.deepEqual([ALIASES.analyze, ALIASES.export, ALIASES.specimen, ALIASES.series, ALIASES.code, ALIASES.curve], ['look', 'code', 'card', 'curve', 'code', 'curve']);
  const c = cap(); assert.equal(await contractCommand('tools', { _: ['tools'] }, c.io), 0);
  assert.match(c.o.out[0], /\blook\b/); assert.ok(!/^\s+(analyze|export|series|specimen)\s/m.test(c.o.out[0]));
});

test('reva --help is plain: one line per command, no old words; compare is described', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin/reva.js'), '--help'], { encoding: 'utf8' });
  const h = r.stdout;
  for (const c of ['demo', 'look', 'design', 'card', 'compare', 'doctor', 'mcp', 'tools | tool']) assert.ok(h.includes(`  ${c}`), c);
  assert.ok(!/analyze \| motions \| series/.test(h));
  assert.ok(!/\b(specimen|series|take)\b/i.test(h.split('Research commands')[0]), 'public help has no jargon words');
  assert.ok(!/design views\|tokens/.test(h.split('Research commands')[0]));
  assert.ok(h.includes('compare <url-a> <url-b>') && h.includes('say how their motion differs'));
  // each scan line carries its own words: scan, then scan moves (the agent's way in), then scan open
  const scan = h.indexOf('  scan <url>'), moves = h.indexOf('  scan moves <dir>'), open = h.indexOf('  scan open <dir>');
  assert.ok(scan > 0 && moves > scan && open > moves, 'scan, scan moves, scan open in order');
  assert.match(h.slice(scan, moves), /capture a site in depth/);
  const sh = spawnSync(process.execPath, [path.join(REPO, 'bin/reva.js'), 'scan', '--help'], { encoding: 'utf8' });
  assert.equal(sh.status, 0); assert.match(sh.stdout, /^reva scan <url>/);
  // every command's --help prints to stdout and exits 0 (scripts read exit 2 as a usage error)
  for (const [args, re] of [[['look'], /^reva look </], [['card'], /^usage: reva card /], [['scan', 'moves'], /^usage: reva scan moves /], [['scan', 'open'], /^usage: reva scan open /]]) {
    const r = spawnSync(process.execPath, [path.join(REPO, 'bin/reva.js'), ...args, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, args.join(' ')); assert.match(r.stdout, re, args.join(' '));
  }
  assert.match(h, /scan_moves, scan_move\)/, 'the tools line names the scan tools');
});

test('reva --version and -v print the package version and exit 0', () => {
  const v = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  for (const flag of ['--version', '-v']) {
    const r = spawnSync(process.execPath, [path.join(REPO, 'bin/reva.js'), flag], { encoding: 'utf8' });
    assert.equal(r.status, 0); assert.equal(r.stdout, `reva ${v}\n`);
  }
});
