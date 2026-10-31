// Score records in the report. The scorer (a separate M3 part) owns the number; the report only presents it, with its self-band
// printed next to it (PLAN M3 DONE WHEN: "self-band printed next to every number"). A number without a band is shown as such and
// ledgered (`unk_selfband_missing`), never shown bare.
//
// Accepted input (tolerant; all fields optional except an id):
//   { id | specimen, kind: 'lab' | '<site>' | ..., verdict: 'pass' | 'fail' | 'needs-owner',
//     score | pooled: number | { value, selfBand | self_band | band: { lo, hi, sd? }, unit? },
//     channels: { name: number | { value, selfBand } } | [ { name, value, selfBand } ],
//     lag: same as a channel, refused: string (cross-rate / lane mismatch reason), rate: { source, candidate }, notes: string }
import { cleanText, untrusted } from './untrusted.js';

const VERDICTS = { pass: 'pass', fail: 'fail', 'needs-owner': 'needs-owner', needs_owner: 'needs-owner', 'needs owner': 'needs-owner' };

function band(b) {
  if (!b || typeof b !== 'object') return null;
  const lo = Number(b.lo ?? b.min), hi = Number(b.hi ?? b.max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return { lo, hi, sd: Number.isFinite(Number(b.sd)) ? Number(b.sd) : undefined };
}
function num(name, v, unit = 'cue') {
  if (typeof v === 'number') return { name, value: Number.isFinite(v) ? v : null, unit, self_band: null };
  if (!v || typeof v !== 'object') return { name, value: null, unit, self_band: null };
  return { name, value: Number.isFinite(v.value) ? v.value : null, unit: v.unit || unit, self_band: band(v.selfBand ?? v.self_band ?? v.band) };
}

export function normaliseScore(x, gaps = []) {
  const id = cleanText(x.id ?? x.specimen ?? 'score', 80);
  const raw = typeof x.verdict === 'string' ? x.verdict.toLowerCase() : '';
  const verdict = VERDICTS[raw] || 'needs-owner';
  if (!VERDICTS[raw]) gaps.push({ id: 'unk_report_bad_verdict', reason: `score "${id}" has no recognised verdict (got "${cleanText(x.verdict, 30)}")`, probe: 'scorer must emit pass | fail | needs-owner' });
  const numbers = [];
  const pooled = x.score ?? x.pooled; if (pooled !== undefined) numbers.push(num('pooled', pooled));
  const ch = x.channels; if (Array.isArray(ch)) for (const c of ch) numbers.push(num(cleanText(c.name, 40), c)); else if (ch && typeof ch === 'object') for (const [k, v] of Object.entries(ch)) numbers.push(num(cleanText(k, 40), v));
  if (x.lag !== undefined) numbers.push(num('lag', x.lag, x.lag?.unit || 'ms'));
  return { id, kind: x.kind ? cleanText(x.kind, 30) : 'unspecified', verdict, provisional: true, numbers, refused: x.refused ? cleanText(x.refused, 240) : null,
    rate: x.rate ? { source: x.rate.source ?? null, candidate: x.rate.candidate ?? null } : null, notes: x.notes ? untrusted(x.notes, 'score.notes', 240) : null };
}
