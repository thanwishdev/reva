// Blind view of a take (design §2): the fitter sees samples, declared data and the environment — never the
// scenario/route name, URL, mark labels or `extra` (understudy leaked `__GROUND_TRUTH__`, G1-4 §4.1).
import crypto from 'node:crypto';

const ENV_DROP = new Set(['scenario', 'url', 'docUrl', 'marks', 'extra']);

/** Value of a provenance-tagged env field ({value, provenance}) or a plain value. */
export const envVal = (v) => (v && typeof v === 'object' && 'provenance' in v ? v.value : v);

/**
 * @param {{take:object, data:object}} t  a `loadTake()` result (or the same shape built in memory)
 * @returns a plain object holding only what the fitter may see
 */
export function blindView(t) {
  const take = t.take || {}; const d = t.data || {};
  const env = {};
  for (const [k, v] of Object.entries(take.env || {})) if (!ENV_DROP.has(k)) env[k] = v;
  const lane = envVal(env.lane) || take.lane || 'hx';
  const dtDecl = envVal(env.dtMs);
  const stall = envVal(env.stallSchedule) || null;
  const view = {
    schema: 'reva.blindview/0',
    lane,
    rateHz: envVal(env.virtualRateHz) ?? take.rate ?? null,
    dtPage: Number.isFinite(dtDecl) ? dtDecl : null,            // declared page frame period (hx); null in rt (U6/U10)
    stallSchedule: stall,
    env,
    rows: (d.rows || []).map((r) => ({ k: r.k, T: r.T, sy: r.sy, sx: r.sx, v: r.v, ...(r.pix ? { pix: r.pix } : {}), ...(r.gl ? { gl: r.gl } : {}), ...(r.glm ? { glm: r.glm } : {}) })),
    births: d.births || [],
    declared: d.declared || [],
    mutations: d.mutations || d.mut || [],
    wheel: d.wheel || [],
    inputLog: (d.inputLog || take.inputLog || []).map(sanitizeInput),
    elements: (d.elements || take.els || []).map((s) => (s == null ? null : stripText(String(s)))),
    marks: (take.marks || []).map((m) => ({ k: m.k, T: m.T })),        // timing only, labels removed
    flags: take.flags || [],
    unknowns: take.unknowns || [],
    escapes: take.escapes || {},
    watch: take.watch || [],
  };
  view.digest = crypto.createHash('sha256').update(JSON.stringify([view.rows.length, take.series && take.series.rows && take.series.rows.digest, view.rows[0] && view.rows[0].T, view.rows.at(-1) && view.rows.at(-1).T])).digest('hex').slice(0, 16);
  return view;
}

// Element descriptors are tag#id.class (src/record/inpage.js `desc`); anything after whitespace is text and dropped.
const stripText = (s) => s.split(/\s/)[0].slice(0, 120);
const INPUT_KEEP = ['type', 'ev', 'k', 'T', 'got', 'want', 'max', 'dy', 'dx', 'x', 'y', 'buttons', 'i', 'path', 'sel', 'at'];   // ev: DOM event type of a page-observed input
function sanitizeInput(e) { const o = {}; for (const k of INPUT_KEEP) if (e[k] !== undefined) o[k] = e[k]; return o; }
