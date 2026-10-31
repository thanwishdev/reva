// A snapshot's per-element computed style lists are interned: over the protocol and on disk each distinct list exists once
// (a 31k-element SVG page was 51M numbers in one reply and blew the node heap). In memory elements still carry `s`, so
// every consumer is unchanged, and old files (no `st`) still read. Synthetic page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../../src/browser/launch.js';
import { takeSnapshot, inPageSnapshot, expandStyles, internStyles } from '../../src/gate/snapshot.js';
import { gzRead, gzWrite } from '../../src/gate/run.js';
import { compareSnapshots } from '../../src/gate/compare.js';

test('snapshot: identical styles share one list, disk round trip equals the original, old format still reads', { timeout: 60000 }, async () => {
  const h = await launchBrowser({ args: [], context: { viewport: { width: 500, height: 400 } } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-intern-'));
  try {
    await h.page.setContent(`<!doctype html><body><svg width=200 height=200>${'<g><path d="M0 0L10 10"/></g>'.repeat(300)}</svg><p>hello</p></body>`);
    const raw = await h.page.evaluate(inPageSnapshot, {});
    assert.ok(raw.st && raw.els.every(e => e.si !== undefined && e.s === undefined), 'protocol form is interned');
    assert.ok(raw.st.length < raw.els.length / 10, `distinct styles ${raw.st.length} for ${raw.els.length} elements`);
    const snap = await takeSnapshot(h.page, {});
    assert.ok(snap.els.every(e => Array.isArray(e.s)) && !snap.st, 'in memory: s on every element');
    const gs = snap.els.filter(e => e.k.includes('/g[')).map(e => e.s);
    assert.ok(gs.length >= 300 && new Set(gs).size < 10, `identical styles are one shared array: ${gs.length} g, ${new Set(gs).size} distinct`);
    const f = path.join(dir, 's.json.gz');
    await gzWrite(f, snap); // async since S-SPEED #2c: the file exists once the promise settles
    const back = gzRead(f);
    assert.deepEqual(back.els.map(e => [e.k, e.t, e.s]), snap.els.map(e => [e.k, e.t, e.s]));
    assert.equal(compareSnapshots(snap, back, {}).failedElements, 0);
    // old format: written without interning
    const old = path.join(dir, 'old.json.gz');
    fs.writeFileSync(old, (await import('node:zlib')).gzipSync(JSON.stringify(snap)));
    assert.deepEqual(gzRead(old).els.map(e => e.s), snap.els.map(e => e.s));
    // expand/intern are inverses and ignore non-snapshots
    assert.deepEqual(expandStyles(internStyles(JSON.parse(JSON.stringify(snap)))).els.map(e => e.s), snap.els.map(e => e.s));
    assert.deepEqual(internStyles({ els: [{ s: [1] }] }), { els: [{ s: [1] }] });
  } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
