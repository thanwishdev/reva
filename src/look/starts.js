// When each member of a group starts, and where a declared line's measured start differs from its declared delay.
// A group line ("SPAN ×22") names one lead; without a fitted stagger the reader cannot tell when the others begin.

const STARTS_PRINT = 12;   // values printed; look.json keeps all of them

/**
 * Start offsets (ms, from the earliest member) of the group's fitted members: one start per element, the earliest onset of its
 * records (on `channel` when the group has a member channel). null when fewer than 2 members have a start.
 * @returns {{offsetsMs:number[], n:number, firstT0:number, spreadMs:number, channel:string|null}|null}
 */
export function groupStarts(records, channel = null) {
  const by = new Map();
  for (const r of records || []) {
    if (!r || !r.target || (channel && r.target.channel !== channel)) continue;
    const t0 = r.derived && r.derived.t0; if (!Number.isFinite(t0)) continue;
    const k = String(r.target.el); if (!by.has(k) || t0 < by.get(k)) by.set(k, t0);
  }
  if (by.size < 2) return null;
  const t = [...by.values()].sort((a, b) => a - b); const first = t[0];
  const offsetsMs = t.map((x) => Math.round((x - first) * 10) / 10);
  return { offsetsMs, n: offsetsMs.length, firstT0: Math.round(first * 10) / 10, spreadMs: offsetsMs[offsetsMs.length - 1], channel: channel || null };
}

/** 'starts: +0, +33, +66 … ms (13 fitted members)' (capped), or 'start together at …' when they do not differ by a frame. */
export function startsText(s, frameMs = 16.7) {
  if (!s || !s.offsetsMs) return null;
  if (s.spreadMs <= frameMs) return `starts: all ${s.n} fitted members start together (within ${Math.round(s.spreadMs)} ms)`;
  const shown = s.offsetsMs.slice(0, STARTS_PRINT).map((x) => `+${Math.round(x)}`);
  return `starts: ${shown.join(', ')}${s.offsetsMs.length > STARTS_PRINT ? ' …' : ''} ms (${s.n} fitted members)`;
}

/** A line's measured start relative to the action (ms), or null: t0 is on the take clock, the action's first input too. */
export const relStart = (t0, tAction) => (Number.isFinite(t0) ? Math.round((t0 - (Number.isFinite(tAction) ? tAction : 0)) * 10) / 10 : null);

/**
 * For a declared (CSS / WAAPI) line: 'starts at +500 ms (declared delay 400 ms)' when the measured start differs from the
 * declared delay by more than a frame, else null. `delay` = the declared delay in ms (0 when none).
 */
export function declaredStartText(rel, delay, frameMs = 16.7) {
  if (!Number.isFinite(rel)) return null;
  const d = Number.isFinite(delay) ? delay : 0;
  return Math.abs(rel - d) > frameMs ? `measured start +${Math.round(rel)} ms (declared delay ${Math.round(d)} ms)` : null;
}
