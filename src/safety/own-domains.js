// The person's own domains (REVA-PRODUCT §4.2 item 3: "override only for localhost, file:// and domains the user lists as their
// own in a local config"). The list lives in <data root>/config.json (default ~/.reva/config.json) as
//   { "ownDomains": ["example.com", "staging.example.org"] }
// A person writes it; an AI agent calling the MCP cannot lift a robots.txt refusal any other way.
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from '../util/paths.js';

export function ownDomainsFile(env = process.env) {
  try { return path.join(dataRoot(env), 'config.json'); } catch { return null; }
}

/** The listed domains, lower-cased; a bare TLD ("com") or anything that is not a host name is dropped. Missing / unreadable file: []. */
export function readOwnDomains(env = process.env) {
  const file = ownDomainsFile(env);
  if (!file) return [];
  let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const list = j && Array.isArray(j.ownDomains) ? j.ownDomains : [];
  return list.filter((s) => typeof s === 'string')
    .map((s) => s.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, ''))
    .filter((s) => s === 'localhost' || (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)));
}

/** True when the URL's host is a listed domain or a subdomain of one. */
export function isOwnDomain(url, list) {
  let host; try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
  return (list || []).some((d) => host === d || host.endsWith('.' + d));
}
