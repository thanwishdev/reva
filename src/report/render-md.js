// Markdown rendering of a report (human view). The JSON is the source of truth; this never adds a number the JSON lacks.
import { mdUntrusted, isUntrusted } from './untrusted.js';
import { renderForeignSection, OWN_SECTIONS } from './sections.js';

const sig = (v) => (typeof v === 'number' ? String(Number(v.toPrecision(5))) : v === null || v === undefined ? 'unknown' : typeof v === 'object' ? (isUntrusted(v) ? mdUntrusted(v) : `{${Object.keys(v).length} fields}`) : String(v));
const cell = (s) => String(s ?? '').replace(/\|/g, '∣').replace(/\n/g, ' ');
const tag = (p) => `[${p}]`;

export function paramText(p) {
  if (p.provenance === 'unknown') return `${p.name} = unknown ${tag('unknown')} (${cell(p.reason)}; probe: ${cell(p.probe)})`;
  const v = p.value && typeof p.value === 'object' && !Array.isArray(p.value) ? `{${p.value.n ?? p.value.keys ?? '?'} values, digest ${p.value.digest ?? '?'}}` : Array.isArray(p.value) ? `[${p.value.map(sig).join(', ')}]` : sig(p.value);
  const ci = p.ci95 && p.ci95[0] !== null && p.ci95[1] !== null && sig(p.ci95[0]) !== sig(p.ci95[1]) ? ` (95% ${sig(p.ci95[0])}..${sig(p.ci95[1])})` : '';
  return `${p.name} = ${v}${p.unit ? ' ' + p.unit : ''} ${tag(p.provenance)}${ci}${p.valid_for_reproduction_only ? ' (replay only)' : ''}`;
}

function table(head, rows) {
  if (!rows.length) return '_none_\n';
  return `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n')}\n`;
}

function bandText(n) {
  const v = n.value === null ? 'unknown' : `${sig(n.value)} ${n.unit}`;
  return n.self_band ? `${v} (self-band ${sig(n.self_band.lo)}..${sig(n.self_band.hi)}${n.self_band.sd !== undefined ? `, sd ${sig(n.self_band.sd)}` : ''})` : `${v} (self-band: unknown)`;
}

export function renderMarkdown(r) {
  const o = [];
  const h = r.headline;
  o.push(`# ${r.title}`, '', `Report ${r.version} (${r.kind}) · schema \`${r.schema}\` · digest \`${r.digest}\` · generated ${r.generated_at}`, '', `> ${r.reading_rule} Quoted page text appears as ⟦…⟧.`, '');
  o.push('## Headline', '');
  o.push(`- Mechanisms: **${h.mechanisms}** in ${h.scenes} scene(s) — by tier: ${Object.entries(h.by_tier).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  o.push(`- Parameter provenance: ${Object.entries(h.parameter_provenance).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  o.push(`- Unknowns: **${h.unknowns}** entries in ${h.unknown_kinds} kinds (ledger below). Recorded, not parameterised: **${h.recorded_not_parameterised}**.`);
  if (h.scores) o.push(`- Scores: ${h.scores.count} — ${Object.entries(h.scores.by_verdict).map(([k, v]) => `${k} ${v}`).join(', ')}; lab hard fails **${h.scores.lab_hard_fails}** (allowed ${h.scores.lab_allowed_hard_fails}); verdicts are provisional.`);
  o.push('', ...r.limits.map((l) => `- ${l}`), '');

  o.push('## Motion', '');
  for (const sc of r.scenes) {
    const e = sc.env;
    o.push(`### Scene ${sc.scene}: ${mdUntrusted(sc.label)}`, '');
    o.push(`Lane ${sig(e.lane)}, ${sig(e.rateHz)} Hz (frame ${sig(e.dtMs)} ms), stride ${sig(e.stride)}${e.probeDtMs ? `, probe take at ${sig(e.probeDtMs)} ms` : ', no probe take'}. Takes: ${Object.entries(e.takes).filter(([, v]) => v).map(([k, v]) => `${k} \`${v}\``).join(', ') || 'none'}.`);
    if (e.take && e.take.provenance === 'unknown') o.push(`Environment: unknown (${e.take.reason}; probe: ${e.take.probe}).`);
    else if (e.take) o.push(`Environment: ${Object.entries(e.take.env).map(([k, v]) => `${k} = ${v.provenance === 'unknown' ? `unknown (${cell(v.reason)})` : sig(v.value)} ${tag(v.provenance)}`).join('; ')}.`);
    if (e.flags.length) o.push(`Flags: ${e.flags.join(', ')}.`);
    o.push('');
    const [start, n] = sc.mechanisms; const rows = r.mechanisms.slice(start, start + n);
    for (const tier of ['declared', 'fitted', 'unexplained', 'unknown', 'not_applicable']) {
      const g = rows.filter((m) => m.tier === tier); if (!g.length) continue;
      o.push(`**${tier}** (${g.length})`, '');
      o.push(table(['id', 'target', 'class / family', 'parameters', 'fit', 'unknowns'], g.map((m) => [
        m.id, `${mdUntrusted(m.target.desc)} ${m.target.channel ?? ''}`, [m.class, m.family, m.law && `law ${m.law}`, m.attribution && m.attribution.label].filter(Boolean).join(' / '),
        m.params.map(paramText).join('; ') || '—', m.fit.n ? `n ${m.fit.n}, rms ${sig(m.fit.rms)}${m.fit.holdout ? `, holdout ${m.fit.holdout.pass ? 'pass' : 'FAIL'}` : ''}` : '—', m.unknown_ids.join(', ') || '—',
      ])));
    }
    const c = sc.coverage;
    o.push(`Coverage: ${c.moving} moving, ${c.not_observed_moving} not observed moving, ${c.not_recorded} not recorded. ${c.note}.`, '');
    if (sc.stagger.length) o.push(`Stagger groups: ${sc.stagger.length} (see JSON).`, '');
  }

  o.push('## Specimen scores', '');
  if (!r.scores.length) o.push('_No score records supplied._', '');
  else {
    o.push(table(['specimen', 'kind', 'verdict (provisional)', 'numbers, each with its self-band', 'refused / notes'], r.scores.map((x) => [x.id, x.kind, x.verdict, x.numbers.map((n) => `${n.name} ${bandText(n)}`).join('; ') || '—', [x.refused && `REFUSED: ${x.refused}`, x.notes && mdUntrusted(x.notes)].filter(Boolean).join(' ') || '—'])));
  }

  o.push('## Unknowns ledger', '', 'Every unmeasured parameter, with the reason and the probe that would resolve it. Missing evidence is not equivalence.', '');
  o.push(table(['id', 'layer', 'count', 'reason (first instance)', 'probe'], r.unknowns.map((u) => [u.id, u.layer || 'motion', u.count ?? 1, u.reason, (u.probes || [u.probe]).filter(Boolean).join(' / ') || '—'])));

  o.push('## Recorded, not parameterised', '', 'Held in the takes but not turned into a model by this report. Replaying them is possible; teaching them as parameters is not.', '');
  o.push(table(['scene', 'target', 'kind', 'why', 'recorded as', 'ledger'], r.recorded_not_parameterised.map((x) => [x.scene, `${mdUntrusted(x.target.desc)} ${x.target.channel ?? ''}`, x.kind, x.why, x.recorded_as, (x.ledger || []).join(', ') || '—'])));

  const foreign = Object.entries(r.sections).filter(([id]) => !OWN_SECTIONS.includes(id)).sort((x, y) => (x[1].order ?? 99) - (y[1].order ?? 99));
  for (const [id, s] of foreign) o.push(renderForeignSection(id, s), '');
  o.push('## Legend', '', '`[declared]` read from the page’s own animation objects · `[measured]` read back from the browser · `[fitted]` estimated from samples (with its interval) · `[inferred]` concluded from other evidence · `[unknown]` not established (reason and probe given).', '');
  return o.join('\n');
}
