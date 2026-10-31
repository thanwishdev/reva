import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { isInside, assertOutsideRepo, REPO_ROOT, outRoot, privateRoot, dataRoot, DataRootError, ensureDataRoot, browsersDir, ensureOutDirIn } from '../src/util/paths.js';

test('isInside / assertOutsideRepo enforce H2', () => {
  assert.equal(isInside(path.join(REPO_ROOT, 'src'), REPO_ROOT), true);
  assert.equal(isInside(os.tmpdir(), REPO_ROOT), false);
  assert.throws(() => assertOutsideRepo(path.join(REPO_ROOT, 'out', 'takes')), /PLAN H2/);
  assert.doesNotThrow(() => assertOutsideRepo(os.tmpdir()));
});

test('default output root is outside the repo and under the private root', () => {
  assert.equal(isInside(outRoot(), REPO_ROOT), false);
  assert.equal(isInside(outRoot(), privateRoot()), true);
});

test('data root: default ~/.reva, set by REVA_HOME, always absolute and never in the repo or the working folder', () => {
  assert.equal(dataRoot({}), path.join(os.homedir(), '.reva'));
  assert.equal(dataRoot({ REVA_HOME: '/tmp/a' }), path.resolve('/tmp/a'));
  assert.equal(dataRoot({ REVA_HOME: '~/rv' }), path.join(os.homedir(), 'rv'));
  assert.equal(privateRoot({ REVA_HOME: '/tmp/b' }), path.resolve('/tmp/b'));
  assert.throws(() => dataRoot({ REVA_HOME: 'rel/dir' }), (e) => e instanceof DataRootError && /relative path/.test(e.message));
  assert.throws(() => dataRoot({ REVA_HOME: path.join(REPO_ROOT, 'data') }), /inside the REVA source folder/);
  assert.throws(() => dataRoot({ REVA_HOME: '/work/proj/data' }, { cwd: '/work/proj', repoRoot: '/elsewhere' }), /inside the current folder/);
  assert.throws(() => dataRoot({ REVA_HOME: '/work/proj' }, { cwd: '/work/proj', repoRoot: '/elsewhere' }), /inside the current folder/);
  // running from the home folder must not make the default (or a folder in home) unusable
  assert.doesNotThrow(() => dataRoot({}, { cwd: os.homedir(), repoRoot: '/elsewhere' }));
  assert.doesNotThrow(() => dataRoot({ REVA_HOME: path.join(os.homedir(), 'rv') }, { cwd: os.homedir(), repoRoot: '/elsewhere' }));
  assert.equal(browsersDir({ REVA_HOME: '/tmp/b' }), path.join(path.resolve('/tmp/b'), 'browsers'));
});

test('ensureDataRoot creates the folder owner-only', () => {
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reva-dr-')), 'home');
  assert.equal(ensureDataRoot({ REVA_HOME: d }), d);
  assert.equal(fs.statSync(d).mode & 0o077, 0);
});

test('ensureOutDirIn: output under the given env\'s data root, the root created owner-only first (the MCP passes its env)', () => {
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reva-od-')), 'home');
  const out = ensureOutDirIn({ REVA_HOME: d }, 'look', 'x');
  assert.equal(out, path.join(d, 'out', 'look', 'x'));
  assert.ok(fs.statSync(out).isDirectory());
  assert.equal(fs.statSync(d).mode & 0o077, 0);
  assert.throws(() => ensureOutDirIn({ REVA_HOME: path.join(REPO_ROOT, 'data') }, 'look'), DataRootError);
});
