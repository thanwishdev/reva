// A small JSON-Schema subset validator (type, enum, required, properties, additionalProperties, items, min/max, pattern, default).
// The same validator guards CLI flags and MCP arguments, so there is one contract (PLAN §3 Interface).
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);

/** @returns {{ok: boolean, errors: string[], value: any}} value = input with defaults applied (input is not mutated). */
export function validate(schema, input, at = '$') {
  const errors = [];
  const walk = (s, v, p) => {
    if (v === undefined) return s.default !== undefined ? structuredClone(s.default) : v;
    if (s.type && !(Array.isArray(s.type) ? s.type : [s.type]).some((t) => isType(v, t))) { errors.push(`${p}: expected ${[].concat(s.type).join('|')}, got ${typeOf(v)}`); return v; }
    if (s.enum && !s.enum.includes(v)) errors.push(`${p}: must be one of ${s.enum.join(', ')}`);
    if (typeof v === 'number') { if (s.minimum !== undefined && v < s.minimum) errors.push(`${p}: must be at least ${s.minimum}`); if (s.maximum !== undefined && v > s.maximum) errors.push(`${p}: must be at most ${s.maximum}`); }
    if (typeof v === 'string') { if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${p}: does not match ${s.pattern}`); if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${p}: longer than ${s.maxLength}`); if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${p}: shorter than ${s.minLength}`); }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${p}: fewer than ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${p}: more than ${s.maxItems} items`);
      return s.items ? v.map((x, i) => walk(s.items, x, `${p}[${i}]`)) : v;
    }
    if (v && typeof v === 'object') {
      const out = { ...v };
      for (const r of s.required || []) if (v[r] === undefined) errors.push(`${p}.${r}: required`);
      for (const [k, sub] of Object.entries(s.properties || {})) { const x = walk(sub, v[k], `${p}.${k}`); if (x !== undefined) out[k] = x; }
      if (s.additionalProperties === false) for (const k of Object.keys(v)) if (!Object.hasOwn(s.properties || {}, k)) errors.push(`${p}.${k}: unknown argument`);
      return out;
    }
    return v;
  };
  const value = walk(schema, input === undefined ? {} : input, at);
  return { ok: errors.length === 0, errors, value };
}

/** Coerce a CLI string for a property schema (numbers, booleans, comma lists, JSON objects). */
export function coerceCli(sub, raw) {
  const t = [].concat(sub.type || 'string')[0];
  if (raw === true && t !== 'boolean') return raw;
  if (t === 'boolean') return raw === true || raw === 'true' || raw === '1';
  if (t === 'number' || t === 'integer') return Number(raw);
  if (t === 'array') return String(raw).split(',').filter(Boolean).map((x) => (sub.items && ['number', 'integer'].includes(sub.items.type) ? Number(x) : x));
  if (t === 'object') { try { return JSON.parse(raw); } catch { return raw; } }
  return raw;
}
