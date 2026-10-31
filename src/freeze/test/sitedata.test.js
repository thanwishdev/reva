// S2 (26 Oct): the site's own api / JSON / GraphQL / non-GET misses are relevant again ('site-data'); third-party api and
// non-GET stay tolerated; beacons are telemetry before the method check; the telemetry path rule no longer hides the
// site's own /events or /log; the catch-all abort of a tolerated miss is not an unexpected failure. Pure, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, isTelemetry, completenessOf, rankCandidates } from '../policy.js';
import { unexpectedFailures } from '../verify.js';
import { registrableDomain, sameSite } from '../../util/domain.js';
import { isTrackerUrl } from '../trackers.js';

const siteUrl = 'https://www.example.com/';
const k = (url, method = 'GET', resourceType = 'fetch') => kindOf({ url, method, resourceType }, { siteUrl });

test('same-site api GET and POST are site-data (relevant)', () => {
  assert.equal(k('https://www.example.com/api/x.json'), 'render', 'a .json file is render-relevant as before');
  assert.equal(k('https://www.example.com/api/x'), 'site-data');
  assert.equal(k('https://api.example.com/v1/items?page=2'), 'site-data', 'another host of the same registrable domain');
  assert.equal(k('https://www.example.com/graphql', 'POST'), 'site-data');
  assert.equal(k('https://www.example.com/gallery/1', 'HEAD'), 'site-data');
});

test('third-party api and non-GET stay tolerated kinds', () => {
  assert.equal(k('https://api.other.com/v1/items'), 'api');
  assert.equal(k('https://forms.other.com/submit', 'POST'), 'non-GET');
  assert.equal(k('https://api.intellimize.co/context-v2/117761985', 'POST'), 'non-GET');
});

test('a POST beacon is telemetry before the method check (ping / beacon / csp_report), on any host', () => {
  assert.equal(k('https://log.intellimize.co/clientlogger', 'POST', 'ping'), 'telemetry');
  assert.equal(k('https://www.example.com/whatever', 'POST', 'ping'), 'telemetry', 'same-site sendBeacon');
  assert.equal(k('https://www.example.com/report', 'POST', 'csp_report'), 'telemetry');
});

test('r.stripe.com/0 POST is telemetry (Stripe collector), also on stripe.com itself', () => {
  assert.equal(kindOf({ url: 'https://r.stripe.com/0', method: 'POST', resourceType: 'fetch' }, { siteUrl: 'https://stripe.com/' }), 'telemetry');
  assert.equal(kindOf({ url: 'https://r.stripe.com/0', method: 'POST', resourceType: 'fetch' }), 'telemetry');
});

test('the path rule: not on the site\'s own non-collector hosts, still on collector and third-party hosts', () => {
  assert.equal(k('https://www.example.com/events'), 'site-data', 'an events page of the site is not telemetry');
  assert.equal(k('https://www.example.com/log', 'POST'), 'site-data');
  assert.equal(isTelemetry('https://www.example.com/events', { siteUrl }), false);
  assert.equal(k('https://events.example.com/v2/events', 'POST'), 'telemetry', 'collector host (first label) + path');
  assert.equal(k('https://events.example.com/v2', 'POST'), 'site-data', 'a collector label alone is not enough: the path must match too');
  assert.equal(k('https://collect.example.com/track', 'POST'), 'telemetry', 'collector first label + path');
  assert.equal(k('https://www.google.com/rmkt/collect/123/', 'GET', 'image'), 'telemetry', 'third-party pixel keeps the path rule');
  assert.equal(kindOf({ url: 'https://www.example.com/api/1/sync/batch', method: 'POST', resourceType: 'xhr' }, { siteUrl: 'https://www.example.com/' }), 'site-data', 'own host: no word rule');
  // exact same-site beacon endpoints stay telemetry on every host
  assert.equal(k('https://www.example.com/cdn-cgi/rum?', 'POST'), 'telemetry');
  assert.equal(k('https://www.example.com/u04n/gs/ccm/collect', 'POST'), 'telemetry');
  assert.equal(k('https://www.example.com/.well-known/shopify/monorail/unstable/produce_batch', 'POST'), 'telemetry');
  assert.equal(k('https://www.example.com/monitoring?o=4506028222513152&p=4510606199488512&r=us', 'POST'), 'telemetry', 'Sentry tunnel');
  assert.equal(k('https://www.example.com/monitoring', 'POST'), 'site-data', 'not a Sentry tunnel without o/p ids');
  assert.equal(k('https://www.example.com/api/csp-report', 'POST', 'other'), 'telemetry');
});

test('F6: the path rule applies after the resource type; render types are never telemetry by path', () => {
  for (const t of ['document', 'script', 'stylesheet', 'font', 'media']) assert.equal(k('https://widgets.thirdparty.io/event/embed', 'GET', t), 'render', t);
  assert.equal(k('https://widgets.thirdparty.io/event/embed', 'GET', 'fetch'), 'telemetry', 'a fetch to a third-party path keeps the path rule');
  assert.equal(isTelemetry('https://widgets.thirdparty.io/track/x', { siteUrl, resourceType: 'script' }), false);
  assert.equal(isTelemetry('https://widgets.thirdparty.io/track/x', { siteUrl }), true, 'no type given: old behaviour');
});

test('without a siteUrl nothing is same-site (callers that do not know the site keep the old kinds)', () => {
  assert.equal(kindOf({ url: 'https://www.example.com/api/x', resourceType: 'fetch' }), 'api');
  assert.equal(kindOf({ url: 'https://www.example.com/graphql', method: 'POST' }), 'non-GET');
  assert.equal(kindOf({ url: 'https://www.example.com/api/1/sync/batch', method: 'POST' }), 'telemetry');
});

test('completeness counts site-data misses beside render misses; the completion fetches same-site GET data only', () => {
  const c = completenessOf({ A: { requests: 20, misses: [{ method: 'GET', url: 'https://www.example.com/a.png', resourceType: 'image' }, { method: 'POST', url: 'https://www.example.com/graphql', resourceType: 'fetch' }, { method: 'GET', url: 'https://www.example.com/api/list', resourceType: 'fetch' }, { method: 'POST', url: 'https://x.other.com/b' }] } }, { siteUrl });
  assert.equal(c.renderMisses, 1); assert.equal(c.siteDataMisses, 2); assert.equal(c.pct, 85); assert.equal(c.misses['non-GET'], 1);
  const r = rankCandidates({ misses: [{ method: 'POST', url: 'https://www.example.com/graphql', resourceType: 'fetch' }, { method: 'GET', url: 'https://www.example.com/api/list', resourceType: 'fetch' }, { method: 'GET', url: 'https://api.other.com/x', resourceType: 'fetch' }], siteUrl });
  assert.deepEqual(r.picked.map(x => x.url), ['https://www.example.com/api/list']);
  assert.deepEqual(r.dropped, { 'site-data': 1, api: 1 });
  // a Next.js RSC request depends on headers a plain fetch does not send: not fetched (would archive the HTML page)
  const rsc = rankCandidates({ misses: [{ method: 'GET', url: 'https://www.example.com/work?_rsc=yIp22O3x', resourceType: 'fetch' }], siteUrl });
  assert.deepEqual(rsc.picked, []); assert.deepEqual(rsc.dropped, { 'site-data:header-dependent': 1 });
});

test('unexpectedFailures: the catch-all abort of a tolerated miss is not unexpected; of a relevant miss it is', () => {
  const cfg = { startUrl: siteUrl, block: null };
  const misses = [
    { method: 'POST', url: 'https://forms.other.com/submit', resourceType: 'fetch' }, // third-party non-GET: tolerated
    { method: 'POST', url: 'https://log.other.com/x', resourceType: 'ping' }, // telemetry: tolerated
    { method: 'POST', url: 'https://www.example.com/graphql', resourceType: 'fetch' }, // site-data: relevant
  ];
  const failed = misses.map(m => `${m.method} ${m.url} :: net::ERR_INTERNET_DISCONNECTED`);
  assert.deepEqual(unexpectedFailures({ failed }, misses, [], cfg), ['POST https://www.example.com/graphql :: net::ERR_INTERNET_DISCONNECTED']);
  // a fuzzy-answered request the page aborted, and the redirect hop, stay explained
  const f2 = ['GET https://www.example.com/api/a?_=1 :: net::ERR_ABORTED', `GET ${siteUrl} :: net::ERR_ABORTED`, 'GET https://cdn.other.com/x.js :: net::ERR_NAME_NOT_RESOLVED'];
  assert.deepEqual(unexpectedFailures({ failed: f2 }, [], [{ method: 'GET', url: 'https://www.example.com/api/a?_=1' }], cfg), ['GET https://cdn.other.com/x.js :: net::ERR_NAME_NOT_RESOLVED']);
});

test('registrableDomain handles two-label public suffixes (Thai, SE-Asian, ...)', () => {
  assert.equal(registrableDomain('www.example.co.th'), 'example.co.th');
  assert.equal(registrableDomain('cdn.other.co.th'), 'other.co.th');
  for (const [h, d] of [['a.b.example.ac.th', 'example.ac.th'], ['x.example.com.tw', 'example.com.tw'], ['shop.example.com.vn', 'example.com.vn'], ['www.example.co.id', 'example.co.id'], ['m.example.com.my', 'example.com.my'], ['x.example.go.jp', 'example.go.jp'], ['www.example.co.uk', 'example.co.uk'], ['www.example.com', 'example.com'], ['127.0.0.1', '127.0.0.1'], ['localhost', 'localhost']]) assert.equal(registrableDomain(h), d, h);
  // the old bug: on a .co.th page every *.co.th host was "same site" (tracker block and site-data both)
  assert.equal(sameSite('https://cdn.other.co.th/x', 'https://www.example.co.th/'), false);
  assert.equal(sameSite('https://img.example.co.th/x', 'https://www.example.co.th/'), true);
  assert.equal(isTrackerUrl('https://stats.wp.com/x', 'https://www.example.co.th/'), true);
  assert.equal(kindOf({ url: 'https://api.other.co.th/v1', resourceType: 'fetch' }, { siteUrl: 'https://www.example.co.th/' }), 'api');
});
