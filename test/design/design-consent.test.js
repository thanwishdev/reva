// The design pass rejects a cookie banner the look's safety gate found (src/safety/consent.js), once per variant, so the
// banner's colours do not land in the design read. Our own fixture (fixtures/look/consent.html), localhost only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox } from '../mcp/helpers.js';
import { serveFixture } from '../helpers.js';

const root = sandbox('design-consent');
const { resolveSource } = await import('../../src/look/source.js');
const { runDesignPass } = await import('../../src/design/pass.js');

const BANNER = /c0ffee|192,\s*255,\s*238/i; // the banner's own background colour

test('design pass: a found cookie banner is rejected before the read; without clicks it stays in the read', async () => {
  const srv = await serveFixture('look');
  try {
    const src = resolveSource(`${srv.origin}/consent.html`);
    const lines = [];
    const kept = await runDesignPass({ src, outDir: path.join(root, 'kept') });
    assert.notEqual(kept.ok, false, kept.error);
    assert.match(JSON.stringify(kept), BANNER, 'control: the banner colour is in the read when nothing is clicked');
    const rejected = await runDesignPass({ src, outDir: path.join(root, 'rejected'), consentClicks: ['text="Reject all"'], log: (m) => lines.push(m) });
    assert.notEqual(rejected.ok, false, rejected.error);
    assert.ok(lines.some((m) => /cookie banner: clicked text="Reject all"/.test(m)), lines.join('\n'));
    assert.doesNotMatch(JSON.stringify(rejected), BANNER);
  } finally { await srv.close(); }
});
