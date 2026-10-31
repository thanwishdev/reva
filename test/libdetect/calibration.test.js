// Calibration against REAL public library builds (library files only, no site code). The files are not in the repo:
// put them in one folder and set REVA_CALIB_DIR to run these cases; each case is skipped when its file is absent, so
// the test is inert elsewhere. Nothing here is copied into the repo (H2/H3): the files are read in place and the
// assertions hold only names/versions. Expected file names: gsap-3.9.1.min.js, ScrollTrigger-3.12.2.min.js,
// three.module.js, lottie-5.7.8.min.js, framer-motion-12.umd.js, motion-dom-12.js, lenis-1.3.26.tgz.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectLibraries, loadModules } from '../../src/libdetect/index.js';

const CALIB = process.env.REVA_CALIB_DIR || '';
const calib = (name) => (CALIB ? path.join(CALIB, name) : '');
const have = (p) => !!p && fs.existsSync(p);
const scan = (p) => detectLibraries(loadModules([p]));
const find = (r, id) => r.libraries.find(l => l.id === id);

const CASES = [
  { name: 'gsap 3.9.1 min', file: calib('gsap-3.9.1.min.js'), expect: { gsap: '3.9.1' }, absent: ['lenis', 'three', 'motion'] },
  { name: 'ScrollTrigger 3.12.2 min', file: calib('ScrollTrigger-3.12.2.min.js'), expect: { 'gsap-scrolltrigger': '3.12.2' }, absent: ['lenis', 'three'] },
  { name: 'three.js module (unminified)', file: calib('three.module.js'), expect: { three: undefined }, absent: ['gsap', 'lenis', 'motion', 'lottie'] },
  { name: 'lottie-web 5.7.8 min', file: calib('lottie-5.7.8.min.js'), expect: { lottie: '5.7.8' }, absent: ['gsap', 'three', 'lenis'] },
  { name: 'framer-motion 12.38 UMD min', file: calib('framer-motion-12.umd.js'), expect: { motion: undefined }, absent: ['gsap', 'lenis', 'three', 'lottie'] },
  { name: 'motion-dom 12 min', file: calib('motion-dom-12.js'), expect: { motion: undefined }, absent: ['gsap', 'lenis', 'three'] },
];

for (const c of CASES) {
  test(`calibration: ${c.name}`, { skip: have(c.file) ? false : `${c.file || 'REVA_CALIB_DIR not set'} not present` }, () => {
    const r = scan(c.file);
    for (const [id, ver] of Object.entries(c.expect)) {
      const l = find(r, id);
      assert.equal(l?.status, 'detected', `${id}: ${JSON.stringify(r.libraries.map(x => [x.id, x.status, x.score]))}`);
      if (ver !== undefined) { assert.equal(l.version.value, ver); assert.equal(l.version.provenance, 'declared'); }
      assert.equal(l.calibration.state, 'calibrated', `${id} detected by a real build but not marked calibrated`);
    }
    for (const id of c.absent) assert.ok(!r.libraries.some(l => l.id === id && l.status !== 'hint'), `${c.name}: false positive ${id}`);
  });
}

const LENIS_TGZ = calib('lenis-1.3.26.tgz');
test('calibration: lenis 1.3.26 package (min, mjs, css, d.ts)', { skip: have(LENIS_TGZ) ? false : 'lenis tgz not present' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-lenis-')); // own empty dir, scripts live elsewhere
  try {
    execFileSync('tar', ['xzf', LENIS_TGZ, '-C', dir]);
    const r = scan(path.join(dir, 'package', 'dist'));
    const l = find(r, 'lenis');
    assert.equal(l.status, 'detected'); assert.equal(l.version.value, '1.3.26'); assert.equal(l.version.provenance, 'declared');
    assert.ok(!r.libraries.some(x => x.id !== 'lenis' && x.status !== 'hint'), JSON.stringify(r.libraries.map(x => [x.id, x.status])));
    // each shipped file alone also resolves to Lenis (min and esm build)
    for (const f of ['lenis.min.js', 'lenis.mjs']) assert.equal(find(scan(path.join(dir, 'package', 'dist', f)), 'lenis').version.value, '1.3.26', f);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
