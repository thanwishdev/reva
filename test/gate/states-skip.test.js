// A JS state whose input fails (navigation, vanished target, non-callable click) is skipped with a reason, not a step failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jsFailReason } from '../../src/gate/states.js';

test('jsFailReason classifies per-state failures', () => {
  assert.match(jsFailReason(new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation\n  at x')), /^navigated: /);
  assert.match(jsFailReason(new Error('click target not found html/body[1]/header[1]/a[1]')), /^click target not found html/);
  assert.match(jsFailReason(new Error('eval)(...)(...).click is not a function')), /^not clickable: /);
  assert.match(jsFailReason(new Error('boom\nstack')), /^error: boom$/);
  assert.ok(jsFailReason('x'.repeat(500)).length < 220);
});
