// The design pass waits for the first words: three equal reads of an empty page are not a settled page (a real site read
// no fonts and no type in 1 run of 4: the preloader had not drawn its text yet). Own fixture, localhost only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox } from '../mcp/helpers.js';
import { serveFixture } from '../helpers.js';

const root = sandbox('design-late');
const { resolveSource } = await import('../../src/look/source.js');
const { runDesignPass } = await import('../../src/design/pass.js');

test('design: a page whose words arrive 1.3 s after load is read with its words', async () => {
  const srv = await serveFixture('look');
  try {
    const d = await runDesignPass({ src: resolveSource(`${srv.origin}/design-late-text.html`), outDir: path.join(root, 'static') });
    assert.equal(d.ok, true, d.error);
    assert.deepEqual(d.type.styles.map((s) => s.size.value).slice(0, 2), [40, 18], JSON.stringify(d.type.styles.map((s) => s.size)));
    assert.equal(d.settle.noText, undefined);
  } finally { await srv.close(); }
});
