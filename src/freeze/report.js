// Freeze section of REPORT v2 (PLAN M4: "Report v2 = report v1 + the static layer, with provenance and unknowns").
// STANDALONE until M3 exists: report v1 (motion) is not built yet, so there is no report document to extend.
// MERGE POINT FOR M3: the report builder should call `freezeSection(archiveDir)` and append `{id, title, provenance, data, markdown}`
// to its sections list (same shape as every other section: id, title, data for machines, markdown for people).
// Everything here is derived from the archive's manifest.json / freeze-report.json / completion.json; no browser, no network.
import fs from 'node:fs';
import path from 'node:path';

export const SECTION_ID = 'freeze';

const KIND = [
  ['font', e => /font|woff|ttf|otf/i.test(e.contentType) || /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(e.url)],
  ['svg', e => /svg/i.test(e.contentType) || /\.svg(\?|$)/i.test(e.url)],
  ['image', e => /^image\//i.test(e.contentType)],
  ['script', e => /javascript|ecmascript/i.test(e.contentType)],
  ['style', e => /css/i.test(e.contentType)],
  ['document', e => /html/i.test(e.contentType)],
  ['data', e => /json|xml|text\/plain/i.test(e.contentType)],
];
export const kindOf = e => (KIND.find(([, f]) => f(e)) || ['other'])[0];

/** Bytes per resource kind and the font / SVG lists, straight from the HAR-derived manifest (no second network fetch). */
export function inventory(manifest) {
  const byKind = {};
  const lists = { font: [], svg: [] };
  for (const e of manifest.entries) {
    if (e.status < 200 || e.status >= 300 || !e.bytes) continue;
    const k = kindOf(e);
    (byKind[k] ||= { count: 0, bytes: 0 });
    byKind[k].count++; byKind[k].bytes += e.bytes;
    if (lists[k]) lists[k].push({ url: e.url, bytes: e.bytes, sha256: e.sha256, contentType: e.contentType, provenance: e.provenance });
  }
  return { byKind, fonts: lists.font, svgs: lists.svg };
}

export function freezeSection(archiveDir) {
  const dir = path.resolve(archiveDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const rep = JSON.parse(fs.readFileSync(path.join(dir, 'freeze-report.json'), 'utf8'));
  const comp = JSON.parse(fs.readFileSync(path.join(dir, 'completion.json'), 'utf8'));
  const inv = inventory(manifest);
  const origins = {};
  for (const e of manifest.entries) origins[`${e.origin}/${e.provenance}`] = (origins[`${e.origin}/${e.provenance}`] || 0) + 1;
  const data = {
    id: rep.id, created: manifest.createdAt, startUrl: manifest.startUrl, classes: manifest.classes, browser: manifest.browser,
    entries: manifest.counts, byOrigin: origins, inventory: inv, converged: rep.converged,
    replay: Object.fromEntries(Object.entries(rep.finalReplay).map(([k, v]) => [k, { pass: v.pass, misses: v.misses.length, silentMisses: v.silentMisses, loadMs: v.loadMs, blocked: v.blocked }])),
    unknowns: comp.unknown, derivedFromCode: comp.candidates.map(c => ({ url: c.url, provenance: c.provenance, how: c.how || c.origin })),
    droppedByClass: Object.fromEntries(Object.entries(rep.recording).map(([k, v]) => [k, v.sanitise.dropped])),
  };
  const md = [];
  md.push(`## Frozen copy (${data.id})`, '');
  md.push(`Provenance: \`measured\` for what the recording saw, \`inferred\` / \`declared\` for URLs added by code analysis or config (per entry in manifest.json). Created ${data.created}.`, '');
  md.push(`- Archive: ${data.entries.entries} entries, ${data.entries.files} files, ${data.entries.bytes} bytes; classes ${data.classes.join(', ')}; ${rep.converged ? 'converged' : '**NOT converged**'} after ${rep.rounds.length} round(s).`);
  md.push(`- Offline replay (DNS disabled): ${Object.entries(data.replay).map(([k, v]) => `${k} ${v.pass ? 'PASS' : 'FAIL'} (${v.misses} misses, ${v.blocked} telemetry requests blocked)`).join('; ')}.`);
  md.push('', '| kind | files | bytes |', '|---|---:|---:|');
  for (const [k, v] of Object.entries(inv.byKind).sort()) md.push(`| ${k} | ${v.count} | ${v.bytes} |`);
  md.push('', `Fonts in the archive: ${inv.fonts.length}; SVG files: ${inv.svgs.length}. (Archived is not the same as used: which fonts a page actually renders with is the static layer's question.)`);
  md.push('', '### URLs derived from code (not seen in the plain recording)');
  md.push(data.derivedFromCode.length ? data.derivedFromCode.map(c => `- ${c.url} (${c.provenance}; ${c.how})`).join('\n') : '- none');
  md.push('', '### Unknowns (never guessed)');
  md.push(data.unknowns.length ? data.unknowns.map(u => `- \`${u.id}\` ${u.template || u.url}: ${u.reason}. Probe: ${u.probe}`).join('\n') : '- none');
  return { id: SECTION_ID, title: 'Frozen copy', provenance: 'measured+inferred', data, markdown: md.join('\n') + '\n' };
}
