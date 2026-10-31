// Target configs live in private storage (PLAN M0 outputs): viewports, block list, seed, archive path.
// The repo never contains a site's name, selectors or numbers; it only reads them from a path setting.
import fs from 'node:fs';
import path from 'node:path';
import { targetsDir } from '../util/paths.js';

export function loadTarget(id, dir = targetsDir()) {
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`target config not found: ${file}`);
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  t._file = file;
  t.archive = path.resolve(t.archive);
  return t;
}

/** Deterministic Math.random (xorshift32) injected before page scripts; the seed comes from the target config. */
export function seedScript(seed = 0x9e3779b9) {
  return `(() => { let s = ${seed >>> 0}; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; })();`;
}

/** Offline proof: anything that escapes request interception fails DNS instead of reaching the network. */
export const OFFLINE_ARGS = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'];
/** Second wall for archive replay: a dead proxy, so nothing (WebSockets included) reaches the internet even if a route
 *  misses and a name resolves. `<-loopback>` removes Chromium's implicit loopback bypass, so loopback goes to the dead
 *  proxy too: use it only where the routes serve every request (archive replay), not for a localhost fixture. */
export const BLACKHOLE_ARGS = ['--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>'];

/** HAR files for a viewport class, most specific LAST (it is consulted first). Names come from the target config. */
export function harPaths(target, cls) {
  const d = path.join(target.archive, target.harDir || 'har');
  const fmt = n => path.join(d, (target.harPattern || '{name}.har.zip').replace('{name}', n));
  return [fmt(target.harUnion || 'all'), fmt(cls)];
}
