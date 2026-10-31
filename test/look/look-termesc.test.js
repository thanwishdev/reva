// Page text never reaches the terminal or generated code with control characters (recheck: terminal escapes in `reva look`).
// Own fixtures only (fixtures/look/termesc*.html, localhost): an id and class holding ESC / BEL / CSI / OSC and U+202E, and a
// page that replaces the recorder's descriptor list. Each layer is checked: recorder descriptor, session, formatLook, code comment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveFixture } from '../helpers.js';
import { runLook } from '../../src/look/index.js';
import { formatLook } from '../../src/look/cli.js';
import { sourceComment, exportFit } from '../../src/export/index.js';
import { formatText } from '../../src/export/cli.js';
import { CONTROL_CHARS, terminalJson } from '../../src/report/untrusted.js';

const bad = (s) => { const m = String(s).match(new RegExp(CONTROL_CHARS.source, 'g')); return m ? m.map((c) => `U+${c.codePointAt(0).toString(16).padStart(4, '0')}`) : []; };
// the terminal text may keep its own line breaks; nothing else from the class
const badOut = (s) => bad(String(s).replace(/\n/g, ''));
let srv;
test.before(async () => { srv = await serveFixture('look'); });
test.after(async () => { await srv.close(); });
const look = (page) => runLook({ input: `${srv.origin}/${page}`, action: 'load', write: false });
// markup that would end an inline <script>/<style> (or open an HTML comment) if a snippet is pasted into an HTML page
const MARKUP = /<\/script|<\/style|<!--/i;
const codes = (r) => r.motions.flatMap((m) => (m.exports || []).flatMap((it) => it.exports.map((x) => x.code || '')));

test('sourceComment: ESC, BEL, C1, U+202E and U+2066 in a descriptor or take name never reach the comment; "*/" cannot be rebuilt', () => {
  const c = sourceComment({ target: { desc: 'DIV#x\u001b]0;T\u0007*\u001b/\u202e\u2066\u0085', channel: 'ren:tx\u001b[31m' } }, { url: 'http://h/\u001b[2J', takeName: 'a\u202eb', date: 'd' });
  assert.deepEqual(bad(c), [], c);
  assert.equal((c.match(/\*\//g) || []).length, 1, 'one comment close only (the stripped ESC cannot join "*" and "/")');
});

test('look on a page whose id and class hold terminal escapes and U+202E: descriptor, terminal text and --code carry none', { timeout: 120000 }, async () => {
  const r = await look('termesc.html');
  assert.ok(r.motions.length >= 1, 'the box moves');
  const m = r.motions[0];
  assert.deepEqual(bad(m.desc), [], `recorder descriptor: ${JSON.stringify(m.desc)}`);
  assert.match(m.desc, /^DIV#x\]8;;https:\/\/example\.invalid\/click\]8;;gnp/, 'the visible text stays (only the control characters go)');
  if (m.selector) assert.deepEqual(bad(m.selector), [], `selector: ${JSON.stringify(m.selector)}`);
  const text = formatLook(r, { code: ['css', 'gsap', 'motion'] });
  assert.deepEqual(badOut(text), [], 'terminal text');
  const cs = codes(r); assert.ok(cs.length > 0, 'code was exported');
  for (const c of cs) assert.deepEqual(bad(c.replace(/\n/g, '')), [], c.slice(0, 200));
});

test('a page that replaces the recorder\'s descriptor list still cannot put escapes into the output (session strips again)', { timeout: 120000 }, async () => {
  const r = await look('termesc-override.html');
  assert.ok(r.motions.length >= 1, 'the box moves');
  assert.match(r.motions[0].desc, /evil/, `the override was used (else this proves nothing): ${JSON.stringify(r.motions[0].desc)}`);
  assert.deepEqual(bad(r.motions[0].desc), []);
  assert.deepEqual(badOut(formatLook(r, { code: ['css', 'gsap'] })), []);
  for (const c of codes(r)) assert.deepEqual(bad(c.replace(/\n/g, '')), [], c.slice(0, 200));
});

test('sourceComment: </script>, </style> and <!-- in page text cannot reach generated code (pasted into HTML it would run)', () => {
  const c = sourceComment({ target: { desc: 'DIV#</script><script>x</script>.<!--', channel: 'ren:tx</style>' } }, { url: 'http://h/<!--', takeName: '</SCRIPT >', date: 'd' });
  assert.doesNotMatch(c, MARKUP, c);
  assert.doesNotMatch(c, /[<>]/, c);
  assert.match(c, /DIV#‹\/script›‹script›x‹\/script›/, 'the text stays readable (‹ › for < >)');
});

test('look on a page whose id and class hold </script>, </style> and <!--: no snippet carries markup', { timeout: 120000 }, async () => {
  const r = await look('termesc-markup.html');
  assert.ok(r.motions.length >= 1, 'the box moves');
  assert.match(r.motions[0].desc, /script/, `the hostile id was recorded (else this proves nothing): ${JSON.stringify(r.motions[0].desc)}`);
  const cs = codes(r); assert.ok(cs.length > 0, 'code was exported');
  for (const c of cs) assert.doesNotMatch(c, MARKUP, c.slice(0, 200));
});

const CPNAME = '--\u001b]0;PWNED\u0007\u001b[31mred\u202e';
test('reva export text: a channel, note or model holding ESC/BEL/U+202E prints none of them; --json escapes them losslessly', () => {
  const P = (value) => ({ value, provenance: 'fitted' });
  const doc = { records: [{ schema: 'reva.motion/0', target: { el: 0, desc: 'DIV#b\u001b[2J', channel: `drv:${CPNAME}` },
    model: { family: 'named:easeOutCubic', params: { t0: P(0), D: P(700), to: P(300) }, ease: 'easeOutCubic', integrator: null, law: null, valid_at: { frame_ms: 1000 / 60, refresh_hz: 60 } },
    evidence: { takes: ['t'] }, fit: { n: 40, rms: 0 } }] };
  const res = exportFit(doc, { to: ['css', 'gsap', 'motion'], meta: { url: 'http://h/', takeName: 'x\u202e' } });
  assert.ok(res.items.length >= 1, 'the record is exported (else this proves nothing)');
  const txt = formatText(res);
  assert.match(txt, /drv:--\]0;PWNED/, 'the visible part of the name stays');
  assert.deepEqual(bad(txt.replace(/\n/g, '')), [], txt.slice(0, 300));
  const j = terminalJson(res, 2);
  assert.deepEqual(bad(j.replace(/\n/g, '')), [], 'json as printed');
  assert.deepEqual(JSON.parse(j), JSON.parse(JSON.stringify(res)), 'json value unchanged');
});

test('look + export on a page whose custom property NAME holds terminal escapes: `reva export` text and --json print none', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-cpname-'));
  try {
    const r = await runLook({ input: `${srv.origin}/termesc-cpname.html`, action: 'load', outDir: dir });
    assert.deepEqual(bad(terminalJson(r, 1).replace(/\n/g, '')), [], 'look --json as printed');
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'fit.json'), 'utf8'));
    const chans = (doc.records || []).map((x) => x.target && x.target.channel);
    assert.ok(chans.some((c) => /PWNED/.test(c) && bad(c).length), `the hostile name reached a channel (else this proves nothing): ${JSON.stringify(chans)}`);
    const res = exportFit(doc, { to: ['css', 'gsap', 'motion'] });
    const txt = formatText(res);
    assert.match(txt, /PWNED/, 'the hostile channel is printed');
    assert.deepEqual(bad(txt.replace(/\n/g, '')), [], 'reva export text');
    assert.deepEqual(bad(terminalJson(res, 2).replace(/\n/g, '')), [], 'reva export --json as printed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
