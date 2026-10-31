// Report self-check: the H6 / SYN §8.2 rules as code, so a report that breaks them cannot be written.
import { isUntrusted } from './untrusted.js';
import { PROVENANCE, REPORT_SCHEMA } from './model.js';
import { OWN_SECTIONS as OWN } from './sections.js';

const FREE_TEXT_KEYS = new Set(['reading_rule', 'limits', 'note', 'reason', 'why', 'recorded_as', 'evidence', 'probe', 'probes', 'method', 'text', 'label', 'title', 'unit', 'coverage', 'family', 'kind']);

/** @returns {{ok: boolean, errors: string[]}} */
export function validateReport(r) {
  const errors = []; const E = (m) => { if (errors.length < 60) errors.push(m); };
  if (r.schema !== REPORT_SCHEMA) E(`schema ${r.schema}`);
  const ledger = new Map((r.unknowns || []).map((u) => [u.id, u]));
  for (const u of r.unknowns || []) {
    if (!/^unk_/.test(u.id)) E(`ledger id ${u.id} is not unk_*`); if (!u.reason) E(`ledger ${u.id}: no reason`);
    if (!(u.probes?.length || u.probe)) E(`ledger ${u.id}: no probe`);
    for (const i of u.instances || []) if (i.target != null && !isUntrusted(i.target)) E(`ledger ${u.id}: instance target not marked untrusted_content`);
  }
  for (const m of r.mechanisms || []) {
    if (!isUntrusted(m.target?.desc)) E(`${m.id}: target.desc not marked untrusted_content`);
    for (const p of m.params) {
      if (!PROVENANCE.includes(p.provenance)) E(`${m.id}.${p.name}: provenance ${p.provenance}`);
      if (p.provenance === 'unknown') { if (!p.reason || !p.probe) E(`${m.id}.${p.name}: unknown without reason/probe`); if (!ledger.has(p.unknown)) E(`${m.id}.${p.name}: ${p.unknown} missing from the ledger`); if (p.value !== null) E(`${m.id}.${p.name}: unknown carries a value`); }
      else if (p.value === null || p.value === undefined) E(`${m.id}.${p.name}: ${p.provenance} value is empty (a silent default)`);
    }
    for (const id of m.unknown_ids) if (!ledger.has(id)) E(`${m.id}: unknown ${id} missing from the ledger`);
    if (['declared', 'fitted'].includes(m.tier) && !m.evidence?.takes?.length) E(`${m.id}: no evidence take`);
  }
  for (const s of r.scores || []) for (const n of s.numbers) if (!n.self_band && !ledger.has('unk_selfband_missing')) E(`score ${s.id}:${n.name}: no self-band and no ledger entry`);
  if (!r.sections || typeof r.sections !== 'object' || Array.isArray(r.sections)) E('sections must be an object keyed by id (M4 merge contract)');
  for (const [id, sec] of Object.entries(r.sections || {})) { if (!sec.status && OWN.includes(id)) E(`section ${id}: no status`); if (sec.status === 'not_included' && !sec.reason) E(`section ${id}: left out without a reason`); }
  // no inline series, no unmarked long prose
  const walk = (v, path, key) => {
    if (Array.isArray(v)) { if (v.length > 64 && v.every((x) => typeof x === 'number')) E(`${path}: inline series of ${v.length} numbers (use a digest reference)`); v.forEach((x, i) => walk(x, `${path}[${i}]`, key)); return; }
    if (v && typeof v === 'object') { if (isUntrusted(v)) return; for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, k); return; }
    if (typeof v === 'string' && v.length > 300 && !FREE_TEXT_KEYS.has(key)) E(`${path}: long unmarked string (${v.length})`);
  };
  // foreign sections (static, freeze, libraries) are checked by their producers; every other part of the report is walked
  const { sections, ...own } = r; walk(own, '$', '');
  if (r.headline && r.mechanisms && r.headline.mechanisms !== r.mechanisms.length) E('headline.mechanisms does not match the rows');
  return { ok: errors.length === 0, errors };
}
