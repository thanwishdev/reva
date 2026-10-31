// A cross-origin stylesheet the CSSOM cannot read must never fail the capture ("unreadable sheets"): its text comes from
// CDP, else from a fetch the archive answers, else the sheet is walked empty, flagged `unreadable` and counted lossy.
// Own synthetic origins only. Browser test, ~10 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '../../src/browser/launch.js';
import { captureRuleTable } from '../../src/static/ruletable.js';

const A = 'http://wr-a.test', B = 'http://wr-b.test';
const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="${B}/x.css"></head><body><p class="q">x</p></body></html>`;

async function open(cors) {
  const h = await launchBrowser({ engine: 'chs', context: { viewport: { width: 400, height: 300 } } });
  await h.context.route('**/*', r => {
    const u = new URL(r.request().url());
    // cors=false: only the <link> (no-cors) gets the sheet; a fetch() from the page (resource type fetch) is refused, like a host without CORS headers
    if (u.origin === B && !cors && r.request().resourceType() === 'fetch') return r.fulfill({ status: 404, body: 'no' });
    if (u.origin === B) return r.fulfill({ status: 200, contentType: 'text/css', headers: cors ? { 'access-control-allow-origin': '*' } : {}, body: '.q{color:rgb(1, 2, 3)}' });
    return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE });
  });
  await h.page.goto(`${A}/`);
  return h;
}
const NO_CDP = { sheets: {}, cdp: { send: async () => { throw new Error('No style sheet with given id'); } } };
const colorRule = t => t.rules.find(r => r.t === 'style' && r.sel === '.q');

test('unreadable cross-origin sheet (no CDP text, fetch blocked): capture continues, sheet flagged, counted lossy', { timeout: 60000 }, async () => {
  const h = await open(false);
  try {
    const t = await captureRuleTable(h.page, NO_CDP, { usage: false });
    assert.deepEqual(t.unreadableSheets, [`${B}/x.css`]);
    assert.equal(colorRule(t), undefined, 'rules of the sheet are absent, not invented');
    const sh = t.sheets.find(s => s.href === `${B}/x.css`);
    assert.equal(sh.unreadable, true);
    assert.ok(t.lossy >= 1, 'counted lossy');
  } finally { await h.close(); }
});

test('cross-origin sheet the archive answers to a CORS fetch: text recovered, no flag', { timeout: 60000 }, async () => {
  const h = await open(true);
  try {
    const t = await captureRuleTable(h.page, NO_CDP, { usage: false });
    assert.equal(t.unreadableSheets, undefined);
    assert.ok(colorRule(t), 'rule read from the fetched text');
  } finally { await h.close(); }
});

test('cross-origin sheet whose text CDP holds (fetch refused): text from CDP, no flag', { timeout: 60000 }, async () => {
  const h = await open(false);
  const css = { sheets: { s1: { sourceURL: `${B}/x.css` } }, cdp: { send: async () => ({ text: '.q{color:rgb(1, 2, 3)}' }) } };
  try {
    const t = await captureRuleTable(h.page, css, { usage: false });
    assert.equal(t.unreadableSheets, undefined);
    assert.ok(colorRule(t));
  } finally { await h.close(); }
});
