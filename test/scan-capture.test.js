// The capture core of a scan, what can be proved without a browser: what counts as moved, the control set, the quiet read, the
// shot gate, the sweep path. The recording itself is proved on sealed archives (runs/.../gsmoke.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanTracker, inpageSource } from '../src/record/inpage.js';
import { frameGone, sweepPoint } from '../src/record/session.js';
import { frameRecorder, wantShot } from '../src/scan/frames.js';
import { SHOTS } from '../src/scan/moves/contract.js';

const row = (k, ids = [], extra = {}) => ({ k, T: k * 16, sy: 0, sx: 0, ...(ids.length ? { e: ids.map((id) => [id, [0, k]]) } : {}), ...extra });

test('moved: a row delta asks for this frame and the next, then nothing', () => {
  const Q = scanTracker();
  Q.row(row(1)); assert.equal(Q.moved(1), false);
  Q.row(row(2, [7])); assert.equal(Q.moved(2), true);
  Q.row(row(3)); assert.equal(Q.moved(3), true);
  Q.row(row(4)); assert.equal(Q.moved(4), false);
});

test('moved: scroll, a left element and the first row of a chain', () => {
  const Q = scanTracker();
  Q.row(row(1, [1, 2, 3], { r: 1 })); assert.equal(Q.moved(1), false, 'a chain start resends everything; nothing changed');
  Q.row({ ...row(5), sy: 40 }); assert.equal(Q.moved(5), true);
  const P = scanTracker();
  P.row(row(1)); P.row(row(5, [], { g: [9] })); assert.equal(P.moved(5), true);
});

test('moved: what no row sees still asks for a picture', () => {
  for (const s of ['canvas', 'svg', 'pseudo']) {
    const Q = scanTracker();
    Q.signal(s, 10);
    assert.equal(Q.moved(10), true, s); assert.equal(Q.moved(11), true, s); assert.equal(Q.moved(12), false, s);
  }
});

test('control set: an element moving by itself asks for no picture and does not hold quiet; a reaction does', () => {
  const Q = scanTracker();
  Q.controlStart();
  for (let k = 1; k <= 24; k++) Q.row(row(k, [5]));
  Q.controlStop();
  assert.equal(Q.inControl(5), true);
  Q.part(24, 100);
  Q.row(row(25, [5]));
  assert.equal(Q.moved(30), false);
  assert.equal(Q.still(30), 6);
  Q.row(row(31, [6]));
  assert.equal(Q.moved(31), true);
  assert.equal(Q.still(31), 0);
  assert.equal(Q.still(49), 18);
  Q.controlClear();
  Q.row(row(50, [5]));
  assert.equal(Q.moved(50), true, 'after the test the element counts again');
});

test('control set: per test, a new window forgets the last one', () => {
  const Q = scanTracker();
  Q.controlStart(); Q.row(row(1, [5])); Q.controlStop();
  Q.controlStart(); Q.row(row(30, [6])); Q.controlStop();
  assert.equal(Q.inControl(5), false);
  assert.equal(Q.inControl(6), true);
});

test('control set: a uniform that runs by itself is left out, one only the pointer moves is not', () => {
  const Q = scanTracker();
  Q.row(row(1), { 'p1|uTime': 1, 'p1|uMouse': [0, 0] });
  Q.controlStart();
  Q.row(row(2), { 'p1|uTime': 2, 'p1|uMouse': [0, 0] });
  Q.controlStop();
  Q.part(2, 1);
  Q.row(row(10), { 'p1|uTime': 3, 'p1|uMouse': [0, 0] });
  assert.equal(Q.moved(10), false, 'the shader behind a hover asks for no picture');
  Q.row(row(20), { 'p1|uTime': 4, 'p1|uMouse': [0.5, 0] });
  assert.equal(Q.moved(20), true, 'a shader that truly reacts does');
  assert.equal(Q.still(20), 0);
});

test('quiet: counts from the input, and a canvas seen in control does not hold it', () => {
  const Q = scanTracker();
  Q.controlStart(); Q.signal('canvas', 3); Q.controlStop();
  Q.part(10, 1);
  Q.signal('canvas', 12);
  assert.equal(Q.still(12), 2);
  assert.equal(Q.moved(12), true, 'its pictures stay');
  const P = scanTracker();
  P.controlStart(); P.controlStop();
  P.part(10, 1);
  P.signal('svg', 12);
  assert.equal(P.still(12), 0, 'an SVG that starts after the input is a reaction');
  assert.equal(P.partTid(), 1);
});

test('wantShot: the gate, the cap, the floor', () => {
  const at = (o) => wantShot({ fresh: false, gap: 1, moved: false, off: null, ...o });
  assert.equal(at({}), false);
  assert.equal(at({ moved: true }), true);
  assert.equal(at({ fresh: true }), true, 'always the first frame of a phase');
  assert.equal(at({ gap: SHOTS.floor }), true);
  assert.equal(at({ gap: SHOTS.floor - 1 }), false);
  assert.equal(at({ pictures: 'cap', moved: true }), false, '30 a second');
  assert.equal(at({ pictures: 'cap', moved: true, gap: 2 }), true);
  assert.equal(at({ pictures: 'floor', moved: true, gap: 14 }), false);
  assert.equal(at({ pictures: 'floor', gap: 15 }), true);
  assert.equal(at({ pictures: 'all' }), true);
});

test('wantShot: what no row can see turns the gate off, at 30 a second, repeats stay at the floor', () => {
  const at = (o) => wantShot({ fresh: false, moved: false, off: 'video', ...o });
  assert.equal(at({ gap: 1 }), false);
  assert.equal(at({ gap: 2 }), true);
  assert.equal(at({ gap: 2, pictures: 'floor' }), false);
  assert.equal(at({ gap: 1, moved: true }), true, 'a first-seen move stays at 60 beside a video');
});

// a session that answers the recorder's reads from a script of frames
const fakeS = (frames) => {
  let i = -1, shots = 0;
  return { S: {
    evRetry: async () => frames[Math.min(++i, frames.length - 1)],
    cdp: { send: async () => { shots++; return { data: Buffer.from(`jpeg ${shots}`).toString('base64') }; } },
  }, shots: () => shots };
};
const info = (k, moved = false, o = {}) => ({ k, T: k * 16, sx: 0, sy: 0, moved, off: null, quiet: null, ...o });

test('frameRecorder: rows stay on every frame, a skipped frame repeats the last picture, phases count their shots', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const list = [info(1), info(2), info(3, true), info(4), ...Array.from({ length: 20 }, (_, i) => info(5 + i)), info(25)];
  const { S, shots } = fakeS(list);
  const fr = frameRecorder(S, { dir, width: 100, height: 100, gate: true });
  for (let i = 0; i < 24; i++) await fr.shot('idle');
  await fr.shot('scroll-down');
  const sum = fr.close();
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  assert.equal(doc.rows.length, 25);
  // 1 first, 3 moved, 18 and 3 + 15 the floor, 25 a new phase
  assert.deepEqual(doc.rows.filter((r, i) => i === 0 || r[3] !== doc.rows[i - 1][3]).map((r) => r[0]), [1, 3, 18, 25]);
  assert.equal(shots(), 4);
  assert.equal(doc.gate.skipped, 21);
  assert.deepEqual(sum.phases.map((p) => [p.name, p.from, p.to, p.shots]), [['idle', 0, 24, 3], ['scroll-down', 24, 25, 1]]);
});

test('frameRecorder: a new document restarts k and still gets its picture', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { S, shots } = fakeS([info(500), info(1), info(2)]);
  const fr = frameRecorder(S, { dir, width: 100, height: 100, gate: true });
  await fr.shot('change'); await fr.shot('change'); await fr.shot('change');
  assert.equal(shots(), 2);
  fr.close();
});

test('frameRecorder: without the gate every frame is a picture, as before', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { S, shots } = fakeS([info(1), info(2), info(3)]);
  const fr = frameRecorder(S, { dir, width: 100, height: 100 });
  for (let i = 0; i < 3; i++) await fr.shot('load');
  assert.equal(shots(), 3);
  const sum = fr.close();
  assert.equal(sum.shots, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8')).gate, undefined);
});

test('sweepPoint: a closed path inside the viewport, the same every time', () => {
  const pts = Array.from({ length: 180 }, (_, i) => sweepPoint(i, 180, 1440, 900));
  for (const p of pts) { assert.ok(p.x >= 100 && p.x <= 1340, `x ${p.x}`); assert.ok(p.y >= 70 && p.y <= 830, `y ${p.y}`); }
  assert.deepEqual(pts[0], pts[179]);
  assert.ok(new Set(pts.map((p) => p.y)).size > 40);
  assert.deepEqual(sweepPoint(30, 180, 1440, 900), pts[30]);
});

test('frameGone: a removed frame, and a frame that can no longer be asked', () => {
  assert.equal(frameGone({ frame: () => ({ isDetached: () => true }) }), true);
  assert.equal(frameGone({ frame: () => ({ isDetached: () => false }) }), false);
  assert.equal(frameGone({ frame: () => { throw new Error('closed'); } }), true);
});

test('o.scan: a look carries no scan code path, a scan carries the tracker, both parse', () => {
  const look = inpageSource({ lane: 'hx', dt: 1 }), scan = inpageSource({ lane: 'hx', dt: 1, scan: true });
  new Function(look); new Function(scan);
  assert.ok(!look.includes('function scanTracker'));
  assert.ok(scan.includes('function scanTracker'));
  assert.ok(look.includes('CFG.scan && scanTracker'));
});
