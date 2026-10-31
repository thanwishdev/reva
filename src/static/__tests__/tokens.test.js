import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTokens } from '../tokens.js';
import { PROPS, IDX } from '../props.js';
import { Ledger } from '../prov.js';

const mk = (over = {}) => { const v = PROPS.map(() => ''); for (const [k, x] of Object.entries(over)) v[IDX[k]] = x; return v; };
const base = { 'font-family': 'Serif', 'font-size': '16px', 'font-weight': '400', 'font-style': 'normal', 'line-height': '24px', 'letter-spacing': 'normal', 'text-transform': 'none', color: 'rgb(0, 0, 0)', 'background-color': 'rgba(0, 0, 0, 0)', 'box-shadow': 'none', 'text-shadow': 'none', display: 'block', position: 'static' };
const sides = (p, v) => Object.fromEntries(['top', 'right', 'bottom', 'left'].map(s => [`${p}-${s}`, v]));
const corners = v => Object.fromEntries(['top-left', 'top-right', 'bottom-right', 'bottom-left'].map(c => [`border-${c}-radius`, v]));
const row = (id, s, extra = {}) => ({ id, parent: 0, tag: 'p', sel: `#r${id}`, depth: 2, rendered: true, rect: [0, 0, 10, 10], text: true, s, ...extra });

test('tokens: groups by exact style, counts, tags measured/inferred, keeps "normal" as a string', () => {
  const styles = [mk({ ...base, ...sides('margin', '0px'), ...sides('padding', '8px'), ...corners('0px') }), mk({ ...base, 'font-size': '32px', 'letter-spacing': '-0.64px', 'line-height': '40px', ...sides('margin', '0px'), ...sides('padding', '16px'), ...corners('4px') }), mk({ ...base, 'font-size': '32px', 'letter-spacing': '-0.64px', 'line-height': '40px', ...sides('margin', '0px'), ...sides('padding', '24px'), ...corners('4px') })];
  const rows = [row(1, 0), row(2, 0), row(3, 1), row(4, 2)];
  const t = buildTokens({ rows, styles }, { ledger: new Ledger() });
  assert.equal(t.typography.length, 2);
  const [a, b] = t.typography; // a: 2 rows (16px), b: 2 rows (32px; two paddings)
  assert.equal(a.count, 2); assert.equal(a.fontSize.value, '16px'); assert.equal(a.letterSpacing.value, 'normal'); assert.equal(a.letterSpacingEm.provenance, 'inferred'); assert.equal(a.letterSpacingEm.value, 0);
  assert.equal(b.letterSpacingEm.value, -0.02); assert.equal(b.lineHeightRatio.value, 1.25);
  assert.deepEqual(t.spacing.scale.map(s => s.px.value), [8, 16, 24]);
  assert.equal(t.spacing.base.value, 8); assert.equal(t.spacing.base.provenance, 'inferred');
  assert.equal(t.radii.length, 1); assert.equal(t.radii[0].corners.value['top-left'], '4px');
  assert.equal(t.colors.length, 1, 'transparent background is not a colour'); assert.equal(t.colors[0].hex.value, '#000000');
});
test('tokens: unsupported colour space is unknown with a reason; huge margins are excluded and counted; no base when values are irregular', () => {
  const led = new Ledger();
  const styles = [mk({ ...base, color: 'lab(50 40 20)', ...sides('margin', '640px'), ...sides('padding', '7px'), ...corners('0px') }), mk({ ...base, ...sides('padding', '11px'), ...sides('margin', '0px'), ...corners('0px') }), mk({ ...base, ...sides('padding', '13px'), ...sides('margin', '0px'), ...corners('0px') })];
  const t = buildTokens({ rows: [row(1, 0), row(2, 1), row(3, 2)], styles }, { ledger: led });
  assert.equal(t.colors.find(c => c.raw.value === 'lab(50 40 20)').hex.provenance, 'unknown');
  assert.ok(led.list().some(u => u.id === 'unk_color_space'));
  assert.ok(t.spacing.excludedLargeValues >= 4);
  assert.equal(t.spacing.base.provenance, 'unknown');
});
test('tokens: line-height normal without an isolatable used value is unknown, not 0 or 1', () => {
  const led = new Ledger();
  const styles = [mk({ ...base, 'line-height': 'normal', ...sides('margin', '0px'), ...sides('padding', '0px'), ...corners('0px') })];
  const t = buildTokens({ rows: [row(1, 0)], styles }, { ledger: led });
  assert.equal(t.typography[0].lineHeight.value, 'normal');
  assert.equal(t.typography[0].lineHeightRatio.provenance, 'unknown');
  const t2 = buildTokens({ rows: [row(1, 0, { lhUsed: 18.4 })], styles }, { ledger: new Ledger() });
  assert.equal(t2.typography[0].lineHeightRatio.provenance, 'inferred'); assert.equal(t2.typography[0].lineHeightRatio.value, 1.15);
});
