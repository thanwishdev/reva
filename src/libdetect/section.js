// Report v2 static-layer section: "motion libraries".
//
// MERGE POINT (read this first): PLAN M4 defines report v2 = report v1 + static layer. Report v1 (M3) did not exist when this
// module was written, so this is a standalone section module. The contract M3's report builder needs to honour:
//   const section = librariesSection(detectLibraries(...));     // {id, title, provenance, data, markdown}
//   report = attachToReport(report, section);                    // or: report.static.sections.push(section)
// `section.data` is the machine form (summary-first: counts + digest, evidence capped), `section.markdown` the human form.
// Every family of the static layer left out of a report must be listed with a reason; this section lists what it did NOT
// examine under `coverage` and never claims a library is absent.
import { SCHEMA } from './detect.js';

export const SECTION_ID = 'static.motion-libraries';
const EVIDENCE_CAP = 6; // evidence rows kept per library in the section; the full list stays in the detect result

const cell = (s) => String(s ?? '').replace(/[|`\r\n]+/g, ' ').trim().slice(0, 90); // page-derived text: never trusted, never markup

export function librariesSection(result, { evidenceCap = EVIDENCE_CAP } = {}) {
  if (result?.schema !== SCHEMA) throw new TypeError(`expected a ${SCHEMA} result`);
  const libraries = result.libraries.map(l => ({
    id: l.id, name: l.name, status: l.status, score: l.score, provenance: l.provenance, version: l.version, firing: l.firing, presence: l.presence,
    calibration: l.calibration.state, implied: !!l.implied,
    evidence: l.evidence.slice(0, evidenceCap), evidenceTotal: l.evidence.length,
  }));
  const section = {
    id: SECTION_ID, title: 'Motion libraries (bundle signatures + behaviour)', schema: SCHEMA, signatureSet: result.signatureSet,
    provenance: 'inferred', untrusted_content: true,
    summary: { detected: libraries.filter(l => l.status === 'detected').map(l => l.id), probable: libraries.filter(l => l.status === 'probable').map(l => l.id), hint: libraries.filter(l => l.status === 'hint').map(l => l.id),
      behaviourFamilies: result.families.map(f => `${f.family}:${f.state}`), unknowns: result.unknowns.length },
    libraries, families: result.families, unknowns: result.unknowns, coverage: result.coverage, behaviourNotes: result.behaviourNotes,
  };
  section.markdown = renderLibrariesMarkdown(result, section);
  return section;
}

export function renderLibrariesMarkdown(result, section = librariesSection(result)) {
  const L = [];
  L.push(`## ${section.title}`, '');
  L.push('Provenance: every library below is `inferred` from a signature match. A version read from a literal is `declared`, from a live global `measured`, otherwise `unknown`. Code in a bundle is not proof it runs (see Firing).', '');
  if (!section.libraries.length) L.push('_No library signature matched in the scanned input._ This is not evidence that none is used (see Coverage).', '');
  else {
    L.push('| Library | Status | Score | Version | Firing | Evidence |', '|---|---|---|---|---|---|');
    for (const l of section.libraries) {
      const v = l.version.value === 'unknown' ? `unknown (${cell(l.version.reason)})` : `${cell(l.version.value)} (${l.version.provenance})`;
      const f = l.firing.state === 'observed' ? `observed (${cell(l.firing.via.join(', '))})` : l.firing.state;
      const ev = l.evidence.map(e => `${e.where}:${e.sig}${e.moduleId ? ` @ ${cell(e.moduleId).slice(0, 40)}` : ''}`).join('; ') + (l.evidenceTotal > l.evidence.length ? `; +${l.evidenceTotal - l.evidence.length} more` : '');
      L.push(`| ${cell(l.name)}${l.implied ? ' (implied by a plugin)' : ''}${l.calibration === 'calibrated' ? '' : ' (uncalibrated signatures)'} | ${l.status} | ${l.score} | ${v} | ${f} | ${cell(ev).length ? ev.replace(/\|/g, '/') : '-'} |`);
    }
    L.push('');
  }
  if (section.families.length) {
    L.push('### Behaviour families (fallback)', '');
    for (const f of section.families) {
      L.push(`- **${f.family}** (${f.state === 'explained_by_signature' ? `explained by ${f.covered_by.join(', ')}` : 'behaviour only, no signature matched'}): candidates ${f.candidates.join(', ')}. Cannot separate: ${f.can_not_separate}.`);
    }
    L.push('');
  }
  if (section.unknowns.length) {
    L.push('### Unknowns', '');
    for (const u of section.unknowns) L.push(`- \`${u.id}\`: ${u.about}. Reason: ${u.reason}. Probe: ${u.probe}.`);
    L.push('');
  }
  const c = section.coverage;
  L.push('### Coverage', '', `- Scanned ${c.modules} module(s), ${c.bytes} characters (${Object.entries(c.kinds).map(([k, n]) => `${k}: ${n}`).join(', ') || 'none'}); live probe: ${result.inputs.dom ? 'yes' : 'no'}; behaviour input: ${result.inputs.behaviour ? 'yes' : 'no'}.`);
  L.push(`- ${c.note}`);
  if (c.skipped.length) L.push(`- Skipped ${c.skipped.length} file(s): ${c.skipped.slice(0, 5).map(s => `${cell(s.path)} (${cell(s.reason)})`).join('; ')}.`);
  if (c.uncalibrated.length) L.push(`- Detected with signatures not yet checked against a real build: ${c.uncalibrated.join(', ')}.`);
  return L.join('\n') + '\n';
}

/** Merge helper for report v2. Returns a new report with the section stored under report.static.sections. */
export function attachToReport(report, section) {
  const sections = [...(report?.static?.sections || []).filter(s => s.id !== section.id), section];
  return { ...report, static: { ...(report?.static || {}), sections } };
}
