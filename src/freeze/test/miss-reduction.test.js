// Replay-miss reduction rules (22 Oct live run): telemetry POSTs are telemetry, Mapbox `sku` is volatile on mapbox.com only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kindOf } from '../policy.js';
import { volatileKey } from '../fuzzy.js';

test('telemetry beacons are telemetry whatever the method', () => {
  for (const [method, url] of [
    ['POST', 'https://collection.decibelinsight.net/i/14072/da/?type=page'],
    ['POST', 'https://play.google.com/log?format=json'],
    ['POST', 'https://www.google.com/rmkt/collect/123/?a=1'],
    ['POST', 'https://arclight.vimeo.com/add/player-stats?x=1'],
    ['HEAD', 'https://node.example.com/sedlina/ga/1?dp=x'],
    ['POST', 'https://www.example.com/api/1/sync/batch'],
    ['POST', 'https://m.stripe.com/6'],
  ]) assert.equal(kindOf({ url, method, resourceType: 'xhr' }), 'telemetry', `${method} ${url}`);
});

test('a non-telemetry POST or HEAD stays a miss kind', () => {
  assert.equal(kindOf({ url: 'https://shop.example.com/api/cart', method: 'POST' }), 'non-GET');
  assert.equal(kindOf({ url: 'https://shop.example.com/api/cart/batch-sync-items', method: 'POST' }), 'non-GET');
  assert.equal(kindOf({ url: 'https://shop.example.com/gallery/1', method: 'HEAD' }), 'non-GET');
});

test('stripe payment elements data stays a miss kind (not telemetry)', () => {
  assert.equal(kindOf({ url: 'https://api.stripe.com/v1/elements/sessions?type=deferred_intent', resourceType: 'fetch' }), 'api');
});

test('mapbox sku is volatile, the tile path and token are not', () => {
  const a = 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/2/1/2.vector.pbf?sku=101AAA&access_token=pk.x';
  const b = 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/2/1/2.vector.pbf?sku=101BBB&access_token=pk.x';
  assert.equal(volatileKey(a), volatileKey(b));
  // negative: another tile, or another token, is another resource
  assert.notEqual(volatileKey(a), volatileKey(b.replace('/2/1/2.', '/2/1/3.')));
  assert.notEqual(volatileKey(a), volatileKey(b.replace('pk.x', 'pk.y')));
});

test('sku stays a real identity parameter outside mapbox', () => {
  assert.notEqual(volatileKey('https://shop.example.com/p?sku=A'), volatileKey('https://shop.example.com/p?sku=B'));
  assert.notEqual(volatileKey('https://notmapbox.com/p?sku=A'), volatileKey('https://notmapbox.com/p?sku=B'));
});
