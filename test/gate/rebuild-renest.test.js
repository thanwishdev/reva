// L7 fix: content the HTML parser would re-nest (a block inside <p>, <a> in <a>, <li> in <li>, an element directly in
// <html>) is not left to the document parser. The rebuild emits the closing element empty with a marker and lists its
// content in `nest` (applied by the harness with the fragment parser); provenance and the source audit cover `nest`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parserMoves, renderRebuild } from '../../src/gate/rebuild.js';
import { auditSources } from '../../src/gate/audit.js';
import { sameArtifact } from '../../src/gate/run.js';

// a minimal rule table: one document, elements indexed in els, tree nodes {t, i, a, s, c}
function table(build) {
  const els = [];
  const el = (t, key, kids = [], extra = {}) => { const i = els.length; els.push({ k: key }); const n = { t, i, ...extra, c: [] }; n.c = kids.map(f => (typeof f === 'string' ? f : f(key, n))); return n; };
  const tree = build(el);
  return { docs: [{ i: 0, url: 'https://x.test/', quirks: false, head: {}, sheets: [], tree }], sheets: [], rules: [], els };
}
// T({t, n?, x?, c}) -> table; n = the element's index among same-tag siblings (default 1), x = extra node fields
function T(spec) {
  return table(el => {
    const mk = (s, key) => el(s.t, key, (s.c || []).map(c => (typeof c === 'string' ? c : (pk => mk(c, `${pk}/${c.t}[${c.n || 1}]`)))), s.x || {});
    return mk(spec, 'html');
  });
}

test('parserMoves: what the document parser would move, and which ones the harness repairs', () => {
  const t1 = T({ t: 'html', c: [{ t: 'body', c: [{ t: 'p', c: [{ t: 'span', c: [{ t: 'div', c: ['line'] }] }] }, { t: 'a', c: [{ t: 'a', c: ['x'] }] }, { t: 'ul', c: [{ t: 'li', c: [{ t: 'li', c: ['y'] }] }] }, { t: 'form', c: [{ t: 'form' }] }] }, { t: 'div', n: 1 }] });
  const m = parserMoves(t1);
  const by = Object.fromEntries(m.map(x => [x.why, x]));
  assert.equal(by['<div> inside <p>'].closes, 'html/body[1]/p[1]');
  assert.equal(by['<div> inside <p>'].parent, 'html/body[1]');
  assert.equal(by['<div> inside <p>'].repair, 'inner');
  assert.equal(by['<a> inside <a>'].repair, 'inner');
  assert.equal(by['<li> inside <li>'].repair, 'inner');
  assert.equal(by['<form> inside <form>'].repair, null); // the fragment parser keeps the form pointer: reported only
  assert.equal(by['<div> directly in <html>'].repair, 'html-child');
  // not moves: a block in a <button> inside a <p> (button scope), a <p> with inline content, a table in a <p> in quirks mode
  const t2 = T({ t: 'html', c: [{ t: 'body', c: [{ t: 'p', c: [{ t: 'button', c: [{ t: 'div' }] }, { t: 'span', c: ['ok'] }] }] }] });
  assert.deepEqual(parserMoves(t2), []);
  const t3 = T({ t: 'html', c: [{ t: 'body', c: [{ t: 'p', c: [{ t: 'table' }] }] }] });
  assert.equal(parserMoves(t3).length, 1);
  t3.docs[0].quirks = true;
  assert.equal(parserMoves(t3).length, 0);
  // shadow content: the declarative template bounds the scope, a p above the host is not closed by a div inside it
  const t4 = T({ t: 'html', c: [{ t: 'body', c: [{ t: 'p', c: [{ t: 'x-card', x: { sr: { mode: 'open', sheets: [], c: [] } } }] }] }] });
  const host = t4.docs[0].tree.c[0].c[0].c[0];
  t4.els.push({ k: 'html/body[1]/p[1]/x-card[1]#s/div[1]' }); host.sr.c.push({ t: 'div', i: t4.els.length - 1, c: [] });
  assert.deepEqual(parserMoves(t4), []);
});

test('renderRebuild: a re-nested closer is emitted empty with a marker; its content goes to nest (outer first)', () => {
  const t = T({ t: 'html', c: [{ t: 'body', c: [{ t: 'p', x: { a: [['class', 'l']] }, c: [{ t: 'div', c: ['one', { t: 'p', c: [{ t: 'div', c: ['two'] }] }] }] }] }, { t: 'div', n: 1, c: ['tail'] }] });
  const r = renderRebuild(t);
  assert.ok(r.nest && r.nest[''], 'nest for the page');
  const list = r.nest[''];
  assert.deepEqual(list.map(e => e.how), ['inner', 'inner', 'html-child']);
  // the page markup holds the closer empty (no <div> inside an open <p>), the html child is not in the text
  assert.match(r.html, /<p class="l" data-wr-nest="0"><\/p>/);
  assert.doesNotMatch(r.html, /tail/);
  assert.equal(list[0].html, '<div>one<p data-wr-nest="1"></p></div>');
  assert.equal(list[1].html, '<div>two</div>');
  assert.equal(list[2].at, 2); // head, body, then this div
  assert.equal(list[2].html, '<div>tail</div>');
  // provenance compares nest too; a table with nothing to move renders exactly as before (no nest key)
  assert.ok(sameArtifact(renderRebuild(t), r));
  assert.ok(!sameArtifact({ ...r, nest: { '': list.slice(1) } }, r));
  const plain = renderRebuild(T({ t: 'html', c: [{ t: 'body', c: [{ t: 'p', c: ['text ', { t: 'span', c: ['x'] }] }] }] }));
  assert.deepEqual(Object.keys(plain).sort(), ['frames', 'html']);
});

test('auditSources reads nest content: an original inline style or a handler there is caught', () => {
  const art = { html: '<!doctype html><html><head><style data-wr-gen></style></head><body><p data-wr-nest="0"></p></body></html>', frames: {}, nest: { '': [{ how: 'inner', id: '0', html: '<div style="color:red; margin: 0 auto">x</div>' }] } };
  const a = auditSources({ rules: [], inline: ['color:red; margin: 0 auto'] }, art, { requests: [], scriptsBlocked: "csp: script-src 'none'" });
  assert.equal(a.pass, false);
  assert.ok(a.issues.some(i => i.kind === 'original-inline-style'));
});
