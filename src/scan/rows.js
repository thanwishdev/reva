// Ledger rows for the reva.coverage/2 units (DESIGN 4.5): builders for move, media, canvas, frame, worker and fit rows, and the
// rows for what the freeze lost, read from the sealed archive before it is deleted (AUDIT 5, 10). Pure but for the archive
// reader: no browser, no network. Builders return plain objects; `addRows` puts them in a Ledger.
import fs from 'node:fs';
import path from 'node:path';

const readJson = (file) => {
  try { return { ok: true, json: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return { ok: e.code === 'ENOENT' ? null : false, error: e.message }; }
};
const num = (v) => (Number.isFinite(v) ? v : 0);

export function addRows(ledger, rows) { for (const r of rows) ledger.add(r); return ledger; }

/**
 * One row per move class. A move with a clip is `captured`; one without says why in `reason` (no clip and no reason fails `check`).
 * @param {object} move  a move of moves.json: id, kind, name, take, runs (a count or an array)
 */
export function moveRow(move, { page = null, viewport = null, clip = null, noClipReason = null, fps = null, partial = null } = {}) {
  const runs = Array.isArray(move.runs) ? move.runs.length : move.runs ?? null;
  const evidence = { kind: move.kind ?? null, name: move.name ?? null, take: move.take ?? null, runs, clip };
  const base = { unit: 'move', id: move.id, page, viewport, ...(fps ? { fps } : {}) };
  if (partial?.length) return { ...base, status: 'partial', evidence, read: 'its pictures and the values that could be read', notRead: partial, ...(clip ? {} : { reason: noClipReason || 'no clip was cut' }) };
  return { ...base, status: 'captured', evidence, ...(clip ? {} : { reason: noClipReason || 'no clip was cut' }) };
}

/** A `<video>` or `<audio>` element. Stored and playing on its own clock is `partial`; encrypted is `opaque`; not stored is `failed`. */
export function mediaRow({ id, page = null, viewport = null, kind = 'video', stored = true, encrypted = false, frames = null, tried = null }) {
  const base = { unit: 'media', id, page, viewport };
  if (encrypted) return { ...base, status: 'opaque', tried: tried || `the ${kind} is encrypted, so no reader can reach its frames` };
  if (!stored) return { ...base, status: 'failed', error: `the ${kind} file was not stored, so it did not play here` };
  return { ...base, status: 'partial', evidence: { frames }, read: `the frames as they played on the page`, notRead: [{ what: `the ${kind}'s own timeline`, why: `it runs on its own clock, not the page's` }] };
}

/**
 * One canvas. `context`: 'webgl' | '2d' | 'none'. A WebGL canvas whose uniforms were read is `captured`; a 2D canvas or an
 * unread WebGL one is `partial` (frames real, values not read); `readable: false` with no pictures is `opaque`.
 */
export function canvasRow({ id, page = null, viewport = null, context = 'webgl', uniformsRead = false, evidence = null, tried = null }) {
  const base = { unit: 'canvas', id, page, viewport };
  if (context === 'webgl' && uniformsRead) return { ...base, status: 'captured', evidence: evidence || { context } };
  if (context === 'none') return { ...base, status: 'none', reason: 'a canvas that never got a drawing context' };
  if (!evidence) return { ...base, status: 'opaque', tried: tried || 'looked for a context and for draws' };
  return { ...base, status: 'partial', evidence, read: 'the frames it drew', notRead: [{ what: context === '2d' ? 'what the 2D drawing calls were' : 'the shader values', why: 'a canvas is drawn by code; only its pictures can be read' }] };
}

/** An iframe. Another site's frame is `opaque`: box and pictures only. Same origin is `captured` when its rows were read. */
export function frameRow({ id, page = null, viewport = null, crossOrigin = false, evidence = null, tried = null }) {
  const base = { unit: 'frame', id, page, viewport };
  if (crossOrigin) return { ...base, status: 'opaque', tried: tried || "another site's page inside this one; its box and pictures were recorded, its content cannot be reached" };
  return { ...base, status: 'captured', evidence: evidence || { sameOrigin: true } };
}

/** A worker the page started: what runs inside is out of reach. */
export function workerRow({ id, page = null, viewport = null, tried = null }) {
  return { unit: 'worker', id, page, viewport, status: 'opaque', tried: tried || 'a worker runs apart from the page; nothing it draws or computes can be read from outside' };
}

/** The fit summary of one viewport: how many law classes were fitted, sampled, split off, or cut. */
export function fitRow({ viewport, page = null, fitted = 0, sampled = 0, split = 0, cut = 0 }) {
  return { unit: 'fit', id: 'summary', page, viewport, status: 'captured', evidence: { fitted, sampled, split, cut } };
}

// ------------------------------------------------------------------ what the freeze lost

const MEDIA_TYPE = /^(video|audio)\/|mpegurl/i;
const MEDIA_EXT = /\.(mp4|webm|m4s|m4v|m4a|mp3|ogg|mov|m3u8|ts)$/i;
const MISS_WHY = {
  render: 'a file the page needed to draw was not in the copy',
  'site-data': "a call to the site's own data service was not in the copy",
  api: 'a call to an API was not in the copy',
  other: 'a request of another kind was not in the copy',
};
const NOT_FETCHED_WHY = { 'not-fetched:budget': 'the fetch budget was used up' };
const idOfUrl = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`.slice(0, 280); } catch { return String(u).slice(0, 280); } };

/**
 * Read `freeze-report.json`, `misses.json`, `completion.json` and `manifest.json` of a sealed archive into `asset`, `media`
 * and `request` rows, so a loss the freeze knew about does not vanish when the archive is deleted. A file that is missing is
 * skipped; one that does not parse becomes a `failed` row. The rows are site-level (no page, no viewport).
 */
export function freezeLossRows(archiveDir) {
  const rows = [];
  const rep = readJson(path.join(archiveDir, 'freeze-report.json'));
  const mis = readJson(path.join(archiveDir, 'misses.json'));
  const com = readJson(path.join(archiveDir, 'completion.json'));
  const man = readJson(path.join(archiveDir, 'manifest.json'));
  for (const [name, r] of [['freeze-report', rep], ['misses', mis], ['completion', com], ['manifest', man]]) {
    if (r.ok === false) rows.push({ unit: 'asset', id: `${name}.json`, status: 'failed', error: `${name}.json could not be read: ${r.error}` });
  }

  if (rep.ok) {
    const R = rep.json;
    for (const [cls, v] of Object.entries(R.finalReplay || {})) {
      if (v.pass) continue;
      const bad = Object.entries(v.checks || {}).filter(([, ok]) => ok === false).map(([k]) => k);
      rows.push({ unit: 'asset', id: `replay-${cls}`, status: 'failed', error: `the offline replay of class ${cls} did not pass${bad.length ? `: ${bad.join(', ')}` : ''}` });
    }
    for (const [cls, v] of Object.entries(R.recording || {})) {
      const st = v.docStatus;
      if (Number.isFinite(st) && (st < 200 || st > 299)) rows.push({ unit: 'asset', id: `document-${cls}`, status: 'blocked', reason: `the page answered ${st} to class ${cls}` });
      if (num(v.trackersBlocked) > 0) rows.push({ unit: 'request', id: `trackers-${cls}`, status: 'refused', rule: 'trackers and analytics are not called', count: v.trackersBlocked });
    }
  }

  const comp = mis.ok ? mis.json.completeness : rep.ok ? rep.json.completeness : null;
  if (comp?.misses) {
    const notRead = Object.entries(MISS_WHY).filter(([k]) => num(comp.misses[k]) > 0).map(([k, why]) => ({ what: `${comp.misses[k]} ${k} request${comp.misses[k] === 1 ? '' : 's'}`, why }));
    if (notRead.length) rows.push({ unit: 'asset', id: 'misses', status: 'partial', read: `${num(comp.pct)} % of ${num(comp.requests)} requests were answered from the copy`, notRead, evidence: { pct: comp.pct, requests: comp.requests } });
    if (num(comp.misses['non-GET']) > 0) rows.push({ unit: 'request', id: 'non-GET', status: 'refused', rule: 'a POST or other write request is never repeated', count: comp.misses['non-GET'] });
  }

  if (com.ok) {
    const C = com.json;
    const nf = new Map();
    const nfList = Array.isArray(C.notFetched) ? C.notFetched : (mis.ok && Array.isArray(mis.json.notFetched) ? mis.json.notFetched : []);
    for (const x of nfList) nf.set(x.reason || 'not-fetched', (nf.get(x.reason || 'not-fetched') || 0) + 1);
    for (const [why, n] of nf) rows.push({ unit: 'asset', id: why, status: 'limit', name: why, value: n, reason: `${n} file${n === 1 ? '' : 's'} found in the code ${n === 1 ? 'was' : 'were'} not fetched: ${NOT_FETCHED_WHY[why] || why}` });
    const unk = new Map();
    for (const u of Array.isArray(C.unknown) ? C.unknown : []) unk.set(u.reason || 'unresolved', (unk.get(u.reason || 'unresolved') || 0) + 1);
    for (const [why, n] of unk) rows.push({ unit: 'asset', id: `unknown-url:${why}`.slice(0, 280), status: 'not-reached', stoodInTheWay: `${n} address${n === 1 ? '' : 'es'} the code builds could not be worked out: ${why}`, count: n });
    for (const [kind, n] of Object.entries(C.dropped && typeof C.dropped === 'object' && !Array.isArray(C.dropped) ? C.dropped : {})) {
      if (num(n) > 0) rows.push({ unit: 'request', id: `dropped-${kind}`, status: 'refused', rule: `${kind} requests are dropped`, count: n });
    }
  }

  // a media body of zero bytes: the site served it in pieces or the answer was empty, so it did not play here (AUDIT 10)
  if (man.ok) {
    for (const e of Array.isArray(man.json.entries) ? man.json.entries : []) {
      if (e.bytes !== 0 || ![200, 206].includes(e.status)) continue;
      let pathname = ''; try { pathname = new URL(e.url).pathname; } catch { /* keep empty */ }
      if (!MEDIA_TYPE.test(e.contentType || '') && !MEDIA_EXT.test(pathname)) continue;
      rows.push({ unit: 'media', id: idOfUrl(e.url), status: 'failed', error: 'the file was not stored (0 bytes), so it did not play here' });
    }
  }
  return rows;
}
