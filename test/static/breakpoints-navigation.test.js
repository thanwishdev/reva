import { test } from 'node:test';
import { sweepBreakpoints } from '../../src/static/breakpoints.js';
import assert from 'node:assert';
let w = 0, boom = new Set([400]);
const page = {
  setViewportSize: async v => { w = v.width; },
  url: () => 'https://x/',
  waitForLoadState: async () => {},
  evaluate: async (fn, arg) => {
    if (!arg) { if (boom.has(w)) { boom.delete(w); throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'); } return; }
    return [['body', String(w > 500 ? 1 : 0), '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0']];
  },
};
test('sweep: a page that navigates on resize is measured again at the same width', async () => {
const r = await sweepBreakpoints(page, { from: 320, to: 640, step: 80 });
assert.deepStrictEqual(r.navigations, [{ width: 400, url: 'https://x/' }]);
const page2 = { ...page, evaluate: async () => { throw new Error('page.evaluate: Execution context was destroyed'); } };
await assert.rejects(sweepBreakpoints(page2, { from: 320, to: 400, step: 80 }), /destroyed/);
});
