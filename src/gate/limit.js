// Bounded concurrency for gate sessions (F3): at most WR_GATE_PAR browsers (default 3, once "the viewport classes A, C,
// E"; C was dropped 22 Oct) run at once in one process, however many runs/classes ask. FIFO, so earlier runs finish first.
// S-SPEED #3 (27 Oct): a corpus step may raise the limit for its own process with setGateSlots, after the resource
// controller admitted the extra slots (src/corpus/steps.js gateSlots); nothing else changes it.
let LIMIT = Math.max(1, Number(process.env.WR_GATE_PAR) || 3);
let running = 0;
const waiting = [];
const next = () => { while (running < LIMIT && waiting.length) { running++; waiting.shift()(); } };

/** Run fn when a slot is free; the slot is held until fn settles. */
export async function inSlot(fn) {
  await new Promise(r => { waiting.push(r); next(); });
  try { return await fn(); } finally { running--; next(); }
}
export const gateParallelism = () => LIMIT;
/** Set the slot count (>= 1); queued sessions start at once when it grows. Returns the new limit. */
export function setGateSlots(n) {
  LIMIT = Math.max(1, Math.floor(Number(n)) || 1);
  next();
  return LIMIT;
}
