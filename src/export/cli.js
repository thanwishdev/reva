// `reva export <fit.json|motion record> --to css,gsap,motion,lenis [--json] [--el N]`
// Offline: reads the fit file and, when present, the run's manifest.json (url, date) two levels up.
import fs from 'node:fs';
import path from 'node:path';
import { exportFit, LIBS } from './index.js';
import { CONTROL_CHARS, terminalJson } from '../report/untrusted.js';

/** Run metadata for the source comment: url and date from <run>/manifest.json, take name from the file name. */
export function runMeta(file) {
  const meta = { takeName: path.basename(file).replace(/\.fit\.json$|\.json$/, '') };
  for (const rel of ['../../manifest.json', '../manifest.json']) {
    const p = path.resolve(path.dirname(file), rel);
    try { const m = JSON.parse(fs.readFileSync(p, 'utf8')); meta.url = m.finalUrl || m.url || null; meta.date = (m.startedAt || m.endedAt || '').slice(0, 10) || null; break; } catch { /* not a run layout */ }
  }
  return meta;
}

export function formatText(res) {
  const lines = [];
  for (const it of [...res.items, ...res.stagger]) {
    lines.push(`## ${it.kind}${it.el != null ? ` — el ${it.el} ${it.channel}` : ''} ${JSON.stringify(it.model)}`);
    for (const n of it.notes || []) lines.push(`   note: ${n}`);
    for (const e of it.exports) {
      lines.push(`-- ${e.lib}${e.form ? ` (${e.form})` : ''}: ${e.accuracy.label}${e.accuracy.why ? ` — ${e.accuracy.why}` : ''}${e.note ? ` [${e.note}]` : ''}`);
      if (e.code) lines.push(e.code);
    }
    lines.push('');
  }
  lines.push(`${res.items.length} exported, ${res.skipped} records skipped (unmapped family or unidentified parameters), ${res.stagger.length} stagger group(s)`);
  // channel names, notes and models can hold page text (a custom property name is chosen by the page): no terminal escapes
  // or bidi overrides reach the terminal; the output keeps its own line breaks and tabs
  return lines.join('\n').replace(CONTROL_CHARS, (c) => (c === '\n' || c === '\t' ? c : ''));
}

export async function runExportCommand(f) {
  const file = f._[1];
  if (!file) { process.stderr.write('usage: reva export <fit.json|record.json> [--to css,gsap,motion,lenis,raf,react-spring] [--json] [--el N]\n'); process.exitCode = 2; return; }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const to = typeof f.to === 'string' ? f.to.split(',').map((s) => s.trim()).filter(Boolean) : LIBS;
  const bad = to.filter((l) => !LIBS.includes(l));
  if (bad.length) { process.stderr.write(`unknown target(s): ${bad.join(', ')} (known: ${LIBS.join(', ')})\n`); process.exitCode = 2; return; }
  const res = exportFit(doc, { to, meta: runMeta(file), el: f.el != null && f.el !== true ? Number(f.el) : null });
  process.stdout.write(f.json ? `${terminalJson(res, 2)}\n` : `${formatText(res)}\n`);
}
