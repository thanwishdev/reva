// Schema ids are `reva.<kind>/<version>`. Files written before the project got its public name carry the same
// `<kind>/<version>` under an earlier prefix; readers compare the part after the prefix so those files still load.
export const schemaKind = (s) => (typeof s === 'string' ? s.slice(s.indexOf('.') + 1) : '');
/** True when `s` names the same kind and version as `id` (prefix ignored). */
export const isSchema = (s, id) => typeof s === 'string' && schemaKind(s) === schemaKind(id);
