// MERGE POINT: tools whose logic lives in other M3 parts (specimen builder, scorer, verify loop) and in M4 (static layer).
// The contract defines their names, argument schemas and result envelope (contract.js); the handler is resolved here, lazily, so
// this folder works and is tested before those parts exist. A provider module exports either
//     export const providers = { specimen: async (args, ctx) => ..., score: ..., verify: ... }
// or a default export of the same shape. A handler returns the `ok()` fields ({headline, stats, data, artifacts, next, warnings}) or
// a complete envelope. Extra tools (M4 static layer, ...) are added by modules listing `export const tools = [toolDef, ...]`
// (toolDef as in contract.js). The merge agent edits only the two lists below (or calls registerProvider / registerTools at start-up).
export const PROVIDER_MODULES = {
  specimen: ['../verify/mcp.js'],
  score: ['../verify/mcp.js'],
  verify: ['../verify/mcp.js'],
};
export const EXTRA_TOOL_MODULES = ['../static/mcp.js'];

const registered = new Map();
const extra = [];
/** Programmatic registration (tests, or a start-up hook). */
export function registerProvider(tool, fn) { registered.set(tool, fn); }
export function registerTools(defs) { extra.push(...defs); }
export function resetProviders() { registered.clear(); extra.length = 0; }

async function tryImport(rel) {
  try { return await import(new URL(rel, import.meta.url).href); }
  catch (e) { if (e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'ENOENT') && String(e.message).includes(rel.replace(/^\.\.\//, ''))) return null; throw e; }
}

/** @returns {Promise<Function|null>} */
export async function resolveProvider(tool) {
  if (registered.has(tool)) return registered.get(tool);
  for (const rel of PROVIDER_MODULES[tool] || []) {
    const m = await tryImport(rel); if (!m) continue;
    const fn = (m.providers && m.providers[tool]) || (m.default && m.default[tool]);
    if (typeof fn === 'function') return fn;
  }
  return null;
}

export async function loadExtraTools() {
  const out = [...extra];
  for (const rel of EXTRA_TOOL_MODULES) { const m = await tryImport(rel); if (m && Array.isArray(m.tools)) out.push(...m.tools); }
  return out;
}
