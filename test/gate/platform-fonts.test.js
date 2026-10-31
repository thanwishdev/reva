// platformFontsFor must not pull the whole DOM through CDP (depth -1 + pierce blew the node heap on a big page), and must
// still resolve fonts for text in the main document, an open shadow root and a same-origin iframe. Synthetic page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '../../src/browser/launch.js';
import { takeSnapshot } from '../../src/gate/snapshot.js';

test('platform fonts resolve for main, shadow-root and iframe text with a depth-0 document request', { timeout: 60000 }, async () => {
  const h = await launchBrowser({ args: [], context: { viewport: { width: 500, height: 400 } } });
  try {
    const sent = [];
    await h.page.setContent(`<!doctype html><body style="font:16px serif"><p id=a>main text</p><div id=host></div><iframe srcdoc="<p style='font:16px serif'>frame text</p>" width=300 height=80></iframe>
      <script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<p>shadow text</p>';</script></body>`);
    await h.page.waitForTimeout(300);
    // record the DOM.getDocument calls the snapshot makes
    const orig = h.context.newCDPSession.bind(h.context);
    h.context.newCDPSession = async p => { const s = await orig(p); const send = s.send.bind(s); s.send = (m, a) => { if (m === 'DOM.getDocument') sent.push(a); return send(m, a); }; return s; };
    const snap = await takeSnapshot(h.page, {});
    const withFont = snap.els.filter(e => typeof e.f === 'string' && e.f && !e.f.startsWith('?'));
    assert.ok(withFont.length >= 2, `fonts resolved for text elements, got ${withFont.length}`);
    assert.ok(sent.length >= 1 && sent.every(a => a && a.depth === 0 && !a.pierce), 'document requested at depth 0 without pierce: ' + JSON.stringify(sent));
  } finally { await h.close(); }
});
