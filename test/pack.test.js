// The npm package ships exactly the modules the published commands load (scripts/check-pack.js, also run by prepublishOnly).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPack, packedFiles, traceModules } from '../scripts/check-pack.js';

test('the npm package holds every module the published reva loads and no research module', () => {
  const r = checkPack();
  assert.deepEqual(r.missing, [], 'modules the published commands load but the package leaves out');
  assert.deepEqual(r.extra, [], 'modules in the package that no published command loads');
});

test('research modules are not in the package; the parts the public commands use are', () => {
  const files = new Set(packedFiles().files);
  for (const f of ['src/freeze/cli.js', 'src/record/scenario.js', 'src/lab/cli.js', 'src/ext/index.js', 'src/ext/dev.js', 'src/static/index.js', 'src/score/score.js', 'src/verify/loop.js', 'src/freeze/README.md']) assert.ok(!files.has(f), `${f} must not ship`);
  // replay (used by look and design) imports these parts of src/freeze; reva scan ships the archiver (freeze.js and what it loads); the recorder session/take are look's own recorder
  for (const f of ['src/freeze/fuzzy.js', 'src/freeze/trackers.js', 'src/freeze/freeze.js', 'src/archive.js', 'src/scan/index.js', 'src/record/session.js', 'src/record/take.js', 'src/corpus/gsap.js', 'src/demo/page/index.html']) assert.ok(files.has(f), `${f} must ship`);
});

test('the check catches a dropped public module and a shipped research module', () => {
  const { modules } = traceModules();
  const files = [...modules.filter((m) => m !== 'src/look/index.js'), 'src/card/page/template.html', 'src/card/page/moves.html', 'src/demo/page/index.html', 'src/install/pins.json', 'src/lab/cli.js'];
  const r = checkPack({ files });
  assert.deepEqual(r.missing, ['src/look/index.js']);
  assert.deepEqual(r.extra, ['src/lab/cli.js']);
});
