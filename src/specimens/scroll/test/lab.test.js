// Lab specimens: built from the Fixture Lab TRUTH records (read-only), checked against the lab's own reference simulators.
// Skipped when the lab is not present (it lives in the M2 tree until the merge).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_LAB_ROOT, LAB_SPECIMENS, buildLabSpecimens, buildLabSpecimen } from '../lab.js';
import { labParity } from '../parity.js';
import { simulate, inputFromTake } from '../index.js';
import { actionsFromInput } from '../input.js';
import { REPO_ROOT } from '../../../util/paths.js';
import { servePages, recordSpecimen, column } from './helpers.js';

const LAB = process.env.REVA_LAB_ROOT || DEFAULT_LAB_ROOT;
const have = fs.existsSync(path.join(LAB, 'lab-scroll', 'refsim.mjs'));
const opts = { skip: have ? false : `lab not found at ${LAB}` };

test('every lab specimen builds; each source record is rebuilt or listed with a reason (no silent drops)', opts, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-lab-'));
  try {
    const manifest = buildLabSpecimens(LAB, tmp);
    assert.equal(manifest.length, LAB_SPECIMENS.length);
    for (const lab of LAB_SPECIMENS) {
      const { built, items } = buildLabSpecimen(LAB, lab);
      const s = built.spec;
      const built_ = new Set([...s.channelMap.map((c) => c.source), ...(s.declared || []).map((d) => d.source), ...s.pins.map((p) => p.source)]);
      const skipped = new Set(s.skipped.map((q) => q.target));
      for (const it of items) {
        const key = String(it.target);
        // flip/view-transition/hysteresis sources are covered by their mechanisms; every other item must be built or listed
        assert.ok(built_.has(key) || skipped.has(key) || s.mechanisms.some((m) => (m.sources || []).includes(key)), `${lab.id}: ${key} neither built nor listed`);
      }
      assert.ok(s.mechanisms.length >= 1, lab.id);
      assert.deepEqual(s.placeholders, [], `${lab.id}: lab truth has no placeholder parameter`);
    }
    // deterministic: a second build is byte-identical
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-lab-'));
    buildLabSpecimens(LAB, tmp2);
    for (const f of fs.readdirSync(tmp, { recursive: true })) if (/\.(html|json)$/.test(f)) assert.equal(fs.readFileSync(path.join(tmp, f), 'utf8'), fs.readFileSync(path.join(tmp2, f), 'utf8'), f);
    fs.rmSync(tmp2, { recursive: true, force: true });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the committed specimens/scroll folder is the current build of the lab truth (run `node src/specimens/scroll/build-lab.js` after a lab change)', opts, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-lab-'));
  try {
    buildLabSpecimens(LAB, tmp);
    const repo = path.join(REPO_ROOT, 'specimens', 'scroll');
    for (const f of fs.readdirSync(tmp, { recursive: true })) {
      if (!/\.(html|json)$/.test(f)) continue;
      assert.ok(fs.existsSync(path.join(repo, f)), `missing ${f}`);
      assert.equal(fs.readFileSync(path.join(repo, f), 'utf8'), fs.readFileSync(path.join(tmp, f), 'utf8'), `${f} is stale`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// driver channels must equal the lab's independent reference simulator; rendered channels sit within the recorder's read-back floor
for (const [route, scenario, rate] of [['m01', 'speed', 120], ['m02', 'speed', 120], ['m02', 'gap', 60], ['m03', 'reversal', 120], ['m04', 'speed', 120], ['m05', 'plain', 120], ['m05', 'retarget', 120], ['m09', 'speed', 120], ['m09', 'gap', 60], ['m09b', 'speed', 120]]) {
  test(`parity with the lab refsim: ${route} / ${scenario} at ${rate} Hz`, opts, async () => {
    const p = await labParity(route, { labRoot: LAB, scenario, rate });
    assert.ok(p.channels.length >= 1);
    for (const c of p.channels) {
      assert.ok(c.vsRefsim && c.vsRefsim.n > 150, `${c.source}: compared ${c.vsRefsim && c.vsRefsim.n}`);
      const driver = /drv:/.test(c.source) || /ren:by$/.test(c.source);
      assert.ok(c.vsRefsim.max <= (driver ? 1e-9 : 1e-3), `${c.source} -> ${c.specimen}: max |specimen - refsim| = ${c.vsRefsim.max}`);
      assert.ok(c.vsOwnSim.max <= (driver ? 1e-12 : 1e-3), `${c.specimen}: recorded vs own simulation = ${c.vsOwnSim.max}`);
    }
  });
}

test('FLIP lab specimen (M18) = the lab refsim on the take, interrupted second segment included', opts, async () => {
  const lab = LAB_SPECIMENS.find((s) => s.id === 'm18');
  const { built } = buildLabSpecimen(LAB, lab);
  const refsim = await import(pathToFileURL(path.join(LAB, 'lab-easing', 'refsim.mjs')).href);
  const srv = await servePages({ '/s.html': built.html });
  let rec;
  try { rec = await recordSpecimen({ url: srv.origin + '/s.html', spec: built.spec, actions: actionsFromInput(built.spec.input, { frameMs: built.spec.frameMs }) }); } finally { await srv.close(); }
  const { take } = rec; const rows = take.data.rows;
  const ref = refsim.simulate('m18', { impl: 'waapi', D: 600, bz: [0.2, 0.9, 0.1, 1] }, { frames: rows.map((r) => ({ k: r.k, T: r.T })), marks: take.marks });
  for (const ch of ['tx', 'ty', 'sx', 'sy']) {
    const got = column(take, 'b0|ren:' + ch), exp = ref.channels['#b0|ren:' + ch];
    let n = 0, max = 0; got.forEach((g, i) => { if (exp[i] != null && Number.isFinite(g)) { n++; max = Math.max(max, Math.abs(g - exp[i])); } });
    assert.ok(n > 150 && max < 1e-3, `${ch}: ${n} frames, max ${max}`);
  }
  const sim = simulate(built.spec, inputFromTake({ take, data: { rows, inputLog: [], wheel: [] } }));
  assert.equal(sim.eventLog.length, 2);
  // the lab truth for segment 2 is the delta the page measures at the second trigger
  const tx = column(take, 'b0|ren:tx'); const i2 = rows.findIndex((r) => r.T > 741 && r.T < 743);
  assert.ok(Math.abs(tx[i2] - 426.407033446666) < 5e-3, `second inversion ${tx[i2]} (lab truth 426.407033446666)`);
});
