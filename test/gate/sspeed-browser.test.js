// S-SPEED #2a/#2b (27 Oct), BROWSER test for acceptance (not run during the build): on one synthetic page, a snapshot taken
// with the new paths (platform fonts in two pipelined batches, the snapshot sent as one JSON string) must write the same
// bytes as one taken with the old paths (REVA_FONT_BATCH=0 REVA_SNAPSHOT_JSONSTR=0). The page has many text elements
// (fonts, emoji, CJK, a lone surrogate), an open shadow root, a same-origin iframe, ::before content and negative boxes.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { launchBrowser } from '../../src/browser/launch.js';
import { takeSnapshot, internStyles } from '../../src/gate/snapshot.js';

const SWITCHES = ['REVA_FONT_BATCH', 'REVA_SNAPSHOT_JSONSTR'];
async function withSwitches(value, fn) {
  const saved = SWITCHES.map(k => process.env[k]);
  for (const k of SWITCHES) { if (value == null) delete process.env[k]; else process.env[k] = value; }
  try { return await fn(); } finally { SWITCHES.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }); }
}

test('S-SPEED #2a/#2b: new snapshot paths write the bytes the old paths wrote', { timeout: 120000 }, async () => {
  const h = await launchBrowser({ args: [], context: { viewport: { width: 700, height: 500 } } });
  try {
    const rows = Array.from({ length: 300 }, (_, i) => `<p style="font:${12 + (i % 9)}px ${['serif', 'sans-serif', 'monospace'][i % 3]}">row ${i} café 中文 ${i % 7 ? '' : '\u{1F600}'}</p>`).join('');
    await h.page.setContent(`<!doctype html><style>.b::before{content:"\\2192 ";color:red}</style><body style="margin:0">
      <div style="margin-left:-12.345px;margin-top:-0.004px" class=b>negative box</div>${rows}<div id=host></div>
      <iframe srcdoc="<p style='font:16px serif'>frame text</p>" width=300 height=80></iframe>
      <script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<p>shadow text</p>';
      const p=document.createElement('p');p.append(document.createTextNode('lone \\uD800 surrogate'));document.body.append(p);</script></body>`);
    await h.page.waitForTimeout(500);
    const oldSnap = await withSwitches('0', () => takeSnapshot(h.page, {}));
    const newSnap = await withSwitches(null, () => takeSnapshot(h.page, {}));
    const bytes = s => zlib.gzipSync(JSON.stringify(internStyles(s)));
    assert.equal(Buffer.compare(bytes(newSnap), bytes(oldSnap)), 0, 'the .json.gz bytes gzWrite would write are identical');
    const fonts = newSnap.els.filter(e => typeof e.f === 'string' && e.f && !e.f.startsWith('?'));
    assert.ok(fonts.length >= 300, `platform fonts resolved for ${fonts.length} text elements`);
    assert.deepEqual(newSnap.els.map(e => e.f), oldSnap.els.map(e => e.f), 'same platform-font answers, element by element');
  } finally { await h.close(); }
});
