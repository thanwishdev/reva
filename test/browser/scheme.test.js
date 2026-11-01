// --color-scheme light|dark: parsing and validation, the context option reaching the browser launch, the design pass pin,
// the CLI usage errors (before any browser starts) and the MCP schema param. No browser is launched here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from '../mcp/helpers.js';
sandbox('scheme');
const { parseColorScheme, schemeContext, COLOR_SCHEMES } = await import('../../src/browser/scheme.js');
const { sessionContext, sessionHandle } = await import('../../src/record/session.js');
const { launchBrowser } = await import('../../src/browser/launch.js');
const { runTool } = await import('../../src/mcp/index.js');
const { validate } = await import('../../src/mcp/schema.js');
const { PUBLIC_TOOLS } = await import('../../src/mcp/reva.js');
const { compareTool } = await import('../../src/compare/tool.js');
const { designGaps } = await import('../../src/design/summary.js');

test('parseColorScheme: absent stays absent, light / dark pass, anything else is a clear usage error', () => {
  assert.deepEqual(COLOR_SCHEMES, ['light', 'dark']);
  for (const v of [undefined, null, false]) assert.equal(parseColorScheme(v), undefined);
  assert.equal(parseColorScheme('dark'), 'dark'); assert.equal(parseColorScheme('light'), 'light'); assert.equal(parseColorScheme(' Dark '), 'dark');
  assert.throws(() => parseColorScheme(true), (e) => e.code === 'bad_arguments' && /--color-scheme needs a value: --color-scheme light or --color-scheme dark/.test(e.message));
  for (const v of ['blue', 'no-preference', 'auto', '1']) assert.throws(() => parseColorScheme(v), (e) => e.code === 'bad_arguments' && new RegExp(`"${v}" is not a colour scheme: use light or dark`).test(e.message), v);
  assert.deepEqual(schemeContext(undefined), {}); assert.deepEqual(schemeContext('dark'), { colorScheme: 'dark' });
});

test('the session context carries colorScheme only when asked, and it reaches the launch', async () => {
  assert.equal('colorScheme' in sessionContext({}), false, 'no flag: the context is exactly as before');
  assert.equal(sessionContext({ colorScheme: 'dark' }).colorScheme, 'dark');
  let got = null;
  const launch = async (o) => { got = o; return { page: {}, context: {} }; };
  const o = { colorScheme: 'dark', viewport: { width: 800, height: 600 } };
  await sessionHandle(o, { engine: 'chs', args: [], ctxOpts: sessionContext(o), launch });
  assert.equal(got.context.colorScheme, 'dark');
  assert.deepEqual(got.context.viewport, { width: 800, height: 600 });
});

test('launchBrowser refuses a colour scheme other than light / dark before the browser starts', async () => {
  await assert.rejects(launchBrowser({ engine: 'chs', context: { colorScheme: 'blue' } }), /colorScheme "blue" is not a colour scheme/);
  await assert.rejects(launchBrowser({ engine: 'chs', context: { colorScheme: null } }), /colorScheme needs a value: light or dark/);
});

test('CLI: a bad --color-scheme is a usage error (exit 2) on look, design, compare and demo, before any browser', async () => {
  const errs = []; const orig = console.error; console.error = (m) => errs.push(String(m));
  try {
    const { runLookCommand } = await import('../../src/look/cli.js');
    const { designCommand } = await import('../../src/design/cli.js');
    const { runCompareCommand } = await import('../../src/compare/cli.js');
    assert.equal(await runLookCommand({ _: ['look', 'https://a.example/'], 'color-scheme': 'blue' }), 2);
    assert.equal(await runLookCommand({ _: ['look', 'https://a.example/'], 'color-scheme': true }), 2);
    assert.equal(await designCommand({ _: ['design', 'https://a.example/'], 'color-scheme': 'sepia' }), 2);
    assert.equal(await runCompareCommand({ _: ['compare', 'https://a.example/', 'https://b.example/'], 'color-scheme': 'night' }), 2);
    const { runDemoCommand } = await import('../../src/demo/cli.js');
    assert.equal(await runDemoCommand({ _: ['demo'], 'color-scheme': 'grey', json: true }), 2);
  } finally { console.error = orig; }
  assert.equal(errs.filter((m) => /is not a colour scheme: use light or dark|needs a value/.test(m)).length, 5, errs.join('\n'));
});

test('help texts name the flag', async () => {
  const { LOOK_HELP } = await import('../../src/look/cli.js');
  const { DESIGN_HELP } = await import('../../src/design/cli.js');
  const { COMPARE_HELP } = await import('../../src/compare/cli.js');
  const { DEMO_HELP } = await import('../../src/demo/cli.js');
  for (const h of [LOOK_HELP, DESIGN_HELP, COMPARE_HELP, DEMO_HELP]) assert.match(h, /--color-scheme/);
});

test('MCP: look and compare take color_scheme (light | dark); look passes it to the look as colorScheme', async () => {
  const look = PUBLIC_TOOLS.find((t) => t.name === 'look');
  for (const t of [look, compareTool]) {
    assert.deepEqual(t.inputSchema.properties.color_scheme.enum, ['light', 'dark'], t.name);
    assert.equal((t.inputSchema.required || []).includes('color_scheme'), false, `${t.name}: optional`);
  }
  assert.equal(validate(look.inputSchema, { url: 'https://a.example/', color_scheme: 'dark' }).ok, true);
  assert.match(validate(look.inputSchema, { url: 'https://a.example/', color_scheme: 'blue' }).errors.join(), /color_scheme: must be one of light, dark/);
  const env = { ...process.env, REVA_MCP_ALLOW_LOCAL: '1' };
  const seen = [];
  const runLook = async (o) => { seen.push(o.colorScheme); throw new Error('stop here'); };
  assert.match((await runTool('look', { url: 'http://127.0.0.1:9/', color_scheme: 'dark' }, { runLook, env })).error.message, /stop here/);
  assert.match((await runTool('look', { url: 'http://127.0.0.1:9/' }, { runLook, env })).error.message, /stop here/);
  assert.deepEqual(seen, ['dark', undefined]);
  assert.equal((await runTool('look', { url: 'http://127.0.0.1:9/', color_scheme: 'sepia' }, { runLook, env })).error.code, 'bad_arguments');
});

test('the unk_color_scheme advice names the flag', () => {
  const light = designGaps({ unknowns: { unk_color_scheme: 2 }, scheme: { colorScheme: 'light' } }).find((g) => g.id === 'unk_color_scheme');
  assert.match(light.probe, /--color-scheme dark/);
  const dark = designGaps({ unknowns: { unk_color_scheme: 1 }, scheme: { colorScheme: 'dark' } }).find((g) => g.id === 'unk_color_scheme');
  assert.match(dark.what, /only the dark scheme was read/); assert.match(dark.probe, /without --color-scheme/);
});
