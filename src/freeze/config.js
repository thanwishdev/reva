// Freeze configuration: defaults, validation and the live-site guard.
// A freeze config is site-specific, so for a real site it lives in REVA's data root, outside the repo (H2); only our own fixture's config is in the repo.
import fs from 'node:fs';
import path from 'node:path';

/** Hosts a freeze may record without --allow-live: loopback and reserved test names. Anything else is a LIVE site (PLAN M4 stop-and-ask, NIGHT_PLAN W3). */
export function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost') || host === 'test' || host.endsWith('.test');
}

/** Throw unless every host the freeze starts from is local, or the caller passed `allowLive` (an explicit opt-in for a live visit). */
export function assertFreezable(cfg, { allowLive = false } = {}) {
  const hosts = [cfg.startUrl, ...(cfg.extraUrls || [])].map(u => new URL(u).hostname);
  const live = [...new Set(hosts.filter(h => !isLocalHost(h)))];
  if (live.length && !allowLive) {
    throw new Error(`refusing to record a live site (${live.join(', ')}): a live freeze needs --allow-live and permission to record the site. Local fixtures only without it.`);
  }
  return { live };
}

const DEFAULT_CLASS = { viewport: { width: 1280, height: 800 } };

/** Fill defaults; the result is what gets written into the archive (target.json embeds the replay-relevant part). */
export function normalizeConfig(raw) {
  const cfg = JSON.parse(JSON.stringify(raw));
  if (!cfg.id || !/^[\w.-]+$/.test(cfg.id)) throw new Error('freeze config: "id" is required (letters, digits, . _ -)');
  if (!cfg.startUrl) throw new Error('freeze config: "startUrl" is required');
  new URL(cfg.startUrl);
  cfg.classes ||= { A: DEFAULT_CLASS };
  for (const [k, v] of Object.entries(cfg.classes)) {
    if (!/^[A-Za-z0-9_-]+$/.test(k)) throw new Error(`freeze config: bad class name "${k}"`);
    if (!v.viewport) cfg.classes[k] = { ...DEFAULT_CLASS, ...v };
  }
  cfg.locale ||= 'en-US'; cfg.timezone ||= 'UTC';
  cfg.seed ??= 0x9e3779b9;
  cfg.settleMs ??= 2500;
  cfg.sweep = cfg.sweep === false ? false : { down: { n: 600, dy: 120, gapMs: 100 }, up: { n: 600, dy: -240, gapMs: 40 }, ...(cfg.sweep || {}) };
  cfg.clicks ||= []; cfg.verifySteps ||= []; cfg.extraUrls ||= []; cfg.domains ||= {};
  cfg.block ||= null;
  cfg.expect ||= {};
  return cfg;
}

export function loadConfig(file) {
  return normalizeConfig(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
}

/** Recording resolver rules: only the config's own mapping, everything else cannot resolve (nothing leaks to the real network). */
export function recordArgs(cfg) {
  if (!cfg.hostRules) return [];
  return [`--host-resolver-rules=${cfg.hostRules}, MAP * ~NOTFOUND, EXCLUDE localhost`];
}
