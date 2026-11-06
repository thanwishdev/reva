// Completion (PLAN §6 step 7): a recording asked for something the archive does not hold. A GET of the site's own, allowed by
// robots.txt, is fetched and joins the archive; the units that missed it are recorded again, at most twice. What stays
// missing gets a `request` row in the ledger, with the reason.
import fs from 'node:fs';
import path from 'node:path';
import { recordClass } from '../freeze/record.js';
import { sanitizeHar, parseHarZip, packHarZip } from '../freeze/sanitize.js';
import { robotsFilter, robotsFetcher } from '../freeze/robots-gate.js';
import { scanFreezeConfig } from './capture.js';
import { normalizeConfig } from '../freeze/config.js';

export const MAX_ROUNDS = 2;
const site = (u) => { const h = new URL(u).hostname.replace(/^www\./, ''); return h; };
/** The same site: the host, or a host under it. */
export const sameSite = (u, home) => { try { const a = site(u), b = site(home); return a === b || a.endsWith('.' + b); } catch { return false; } };

/** Sort one list of `METHOD url` misses. */
export function sortMisses(list, home) {
  const fetch = [], left = [];
  for (const m of new Set(list)) {
    const i = m.indexOf(' '), method = m.slice(0, i), url = m.slice(i + 1);
    if (method !== 'GET') left.push({ url, method, status: 'not-reached', reason: `a ${method} request needs a server answer; REVA sends only GET` });
    else if (!/^https?:/.test(url)) left.push({ url, method, status: 'not-reached', reason: 'not an http(s) address' });
    else if (!sameSite(url, home)) left.push({ url, method, status: 'not-reached', reason: 'a file of another site; the scan\'s completion fetches only the site\'s own files' });
    else fetch.push(url);
  }
  return { fetch, left };
}

/**
 * Fetch these URLs into the archive as one more HAR (the seal of a temporary archive is not needed by a replay).
 * @returns {Promise<{fetched:string[], failed:{url:string,reason:string}[], blocked:{url:string,reason:string}[], har:string|null}>}
 */
export async function fetchMissing(urls, { target, archiveDir, round, engine, home, consentClicks = [], log = () => {}, fetcher = null, robots = robotsFilter, policy = null }) {
  const rb = await robots(urls.map((url) => ({ url })), { siteUrl: home, robotsText: policy ? robotsFetcher({ fetchImpl: policy.pacedFetch }) : robotsFetcher() });
  const allowed = rb.allowed.map((c) => c.url);
  const blocked = rb.disallowed.map((d) => ({ url: d.url, reason: 'robots.txt disallows it: listed, never fetched' }));
  if (!allowed.length) return { fetched: [], failed: [], blocked, har: null };
  const cfg = normalizeConfig(scanFreezeConfig(home, { consentClicks }));
  const file = `extra-${(target.harExtras?.length || 0) + 1}.har.zip`; // by count: a stopped scan's rounds start again at 1
  const dir = path.join(archiveDir, target.harDir || 'har');
  const tmp = path.join(path.dirname(archiveDir), `raw-${file}`);
  log(`completion round ${round}: fetching ${allowed.length} missed files of the site`);
  try {
    const rec = await (fetcher || recordClass)(cfg, 'A', { harPath: tmp, extraUrls: allowed, engine, fetchOnly: true, fetchBudgetMs: Math.max(60000, allowed.length * (cfg.extraGapMs + 1500)), fetchConcurrency: 1, policy });
    const s = sanitizeHar(parseHarZip(fs.readFileSync(tmp)), {});
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, file), packHarZip(s));
    const fetched = [], failed = [];
    // 0 is an answer from another origin read in no-cors mode: it arrived and the HAR holds it. A fetch that failed reads ERR
    for (const [url, st] of rec.extra) {
      if (st === 0 || (typeof st === 'number' && st >= 200 && st < 400)) fetched.push(url);
      else if (policy?.robotsBlocked?.has(url)) blocked.push({ url, reason: 'robots.txt disallows it: listed, never fetched' });
      else failed.push({ url, reason: policy?.stopped ? `not fetched: the site asked REVA to stop (${policy.stopped.why})` : `the site answered ${st}` });
    }
    target.harExtras = [...(target.harExtras || []), file];
    return { fetched, failed, blocked, har: file };
  } finally { fs.rmSync(tmp, { force: true }); }
}

/**
 * The completion rounds: fetch what may be fetched, record the units that missed it again.
 * @param {{units:{key:string, run:Function, result:object, file:string|null}[], home:string, fromArchive:boolean, reRecord:(u)=>Promise<object>}} o
 * @returns {Promise<{url:string, status:string, reason:string, units:string[]}[]>} what stays missing, for the ledger
 */
export async function completeUnits({ units, home, fromArchive, target, archiveDir, engine, consentClicks, log = () => {}, extrasFile, reRecord, scan, fetchImpl = fetchMissing, policy = null }) {
  const rounds = [], tried = new Map(); // url -> why it stays missing
  const missesOf = () => units.flatMap((u) => (u.result?.missList || []).map((m) => [m, u.key]));
  if (!fromArchive) for (let round = 1; round <= MAX_ROUNDS; round++) {
    const { fetch } = sortMisses(missesOf().map((x) => x[0]), home);
    const want = fetch.filter((u) => !tried.has(u));
    if (!want.length) break;
    // the site asked REVA to stop: nothing more is fetched, each wanted file says why
    if (policy?.stopped) { for (const u of want) tried.set(u, { status: 'not-reached', reason: `not fetched: the site asked REVA to stop (${policy.stopped.why})` }); break; }
    const r = await fetchImpl(want, { target, archiveDir, round, engine, home, consentClicks, log, policy });
    for (const b of r.blocked) tried.set(b.url, { status: 'blocked', reason: b.reason });
    for (const f of r.failed) tried.set(f.url, { status: 'failed', reason: f.reason });
    for (const u of r.fetched) tried.set(u, { status: 'failed', reason: 'fetched, yet the page asked for it again and did not get it' });
    rounds.push({ round, wanted: want.length, fetched: r.fetched.length, failed: r.failed.length, blocked: r.blocked.length });
    if (!r.fetched.length) break;
    if (extrasFile) fs.writeFileSync(extrasFile, JSON.stringify(target.harExtras));
    const got = new Set(r.fetched.map((u) => `GET ${u}`));
    const again = units.filter((u) => (u.result?.missList || []).some((m) => got.has(m)));
    log(`completion round ${round}: ${r.fetched.length} files joined the archive, ${again.length} units are recorded again`);
    // one line per viewport, as the recording ran: reRecord takes its turn, so a machine with one lane goes one unit at a time
    const lines = new Map();
    for (const u of again) { const vp = u.key.split('/')[1] ?? ''; if (!lines.has(vp)) lines.set(vp, []); lines.get(vp).push(u); }
    const ends = await Promise.allSettled([...lines.values()].map(async (line) => {
      for (const u of line) { u.run.again = true; const res = await reRecord(u); if (res.ok || !u.result?.ok) { u.result = res; u.apply?.(res); } }
    }));
    const bad = ends.find((x) => x.status === 'rejected');
    if (bad) throw bad.reason;
  }
  scan.steps.completion = { rounds, misses: new Set(missesOf().map((x) => x[0])).size, fromArchive };
  const left = new Map(), { fetch, left: other } = sortMisses(missesOf().map((x) => x[0]), home);
  for (const o of other) left.set(o.url, { url: o.url, status: o.status, reason: o.reason });
  for (const u of fetch) left.set(u, { url: u, ...(tried.get(u) || { status: 'not-reached', reason: fromArchive ? 'the archive was given by the caller: nothing is added to it' : 'not fetched within the completion rounds' }) });
  for (const [m, key] of missesOf()) { const url = m.slice(m.indexOf(' ') + 1), row = left.get(url); if (row) (row.units ||= []).includes(key) || row.units.push(key); }
  // another site's many beacons fold into one row per host
  const out = [], hosts = new Map();
  for (const r of left.values()) {
    if (!/another site/.test(r.reason)) { out.push(r); continue; }
    const h = new URL(r.url).host;
    if (!hosts.has(h)) { const row = { ...r, url: `https://${h}/`, requests: 0, units: [] }; hosts.set(h, row); out.push(row); }
    const row = hosts.get(h); row.requests++; for (const u of r.units || []) if (!row.units.includes(u)) row.units.push(u);
  }
  return out;
}
