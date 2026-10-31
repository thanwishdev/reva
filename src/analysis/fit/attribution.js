// Driver attribution per element (design §8). Time-driven ⇔ it writes/moves in the idle-control take; otherwise the
// input whose change precedes the element's motion burst by ≤ 2 frames owns it (M1's "scroll unchanged ≥ 500 ms"
// rule would call a slow EMA tail time-driven: an α 0.08 tail lasts about 1.4 s at 60 Hz).

/**
 * @param {object} o
 * @param {{b:number}[]} o.segments   motion segments (row indices) of the element's main channel
 * @param {number[]} o.T
 * @param {{i:number, kind:string}[]} o.events  input/driver change frames (row indices)
 * @param {boolean|null} o.movesInIdle  null when no idle-control take exists
 * @param {string} o.cls  fitted class
 */
export function attribute({ segments, events, movesInIdle, cls }) {
  if (movesInIdle === true) return { label: 'time-driven', provenance: 'measured', evidence: 'moves in the idle-control take' };
  // a step (an instant change) has no time of its own: a step that follows a scroll change is tied to the scroll
  const DRIVER = new Set(['scroll map', 'first-order smoothing', 'asymmetric smoothing', 'restarted tween', 'composite', 'step']);
  const lead = []; let unexplained = 0;
  for (const sg of segments) {
    const ev = events.filter((e) => e.i <= sg.b && sg.b - e.i <= 2).at(-1);
    if (ev) lead.push(ev.kind); else unexplained++;
  }
  if (!segments.length) return { label: 'unknown', provenance: 'unknown', reason: 'no motion', probe: 'n/a' };
  if (unexplained === segments.length) return { label: 'time-driven', provenance: movesInIdle === false ? 'inferred' : 'inferred', evidence: 'no input precedes any motion burst by ≤ 2 frames' + (movesInIdle == null ? ' (no idle-control take)' : '') };
  if (unexplained > 0 && movesInIdle == null) return { label: 'unknown', provenance: 'unknown', reason: `${unexplained} of ${segments.length} bursts have no preceding input`, probe: 'record an idle-control take' };
  const kind = mode(lead);
  if (kind === 'scroll') return { label: DRIVER.has(cls) ? 'scroll-linked' : 'scroll-triggered time-based', provenance: 'inferred', evidence: `${lead.length} bursts start ≤ 2 frames after a scroll change` };
  if (kind === 'wheel') return { label: 'wheel', provenance: 'inferred', evidence: 'bursts follow wheel input' };
  if (kind === 'pointer' || kind === 'click') return { label: 'pointer', provenance: 'inferred', evidence: `bursts follow ${kind} input` };
  return { label: kind, provenance: 'inferred', evidence: 'bursts follow input' };
}
const mode = (a) => { const c = {}; for (const x of a) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((x, y) => y[1] - x[1])[0][0]; };
