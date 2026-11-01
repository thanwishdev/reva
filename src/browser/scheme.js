// The colour scheme a page is read in (`--color-scheme light|dark` on every command that opens a page; `color_scheme`
// over MCP). Default light, as every read was before the option existed. It reaches the browser as the Playwright context
// option colorScheme (src/browser/launch.js) and the design pass's emulated media (src/design/pass.js).

export const COLOR_SCHEMES = ['light', 'dark'];

/**
 * The --color-scheme value of a command, checked. undefined when the flag is absent (the read stays exactly as before:
 * light, nothing added to the context); 'light' or 'dark' otherwise. Anything else throws a usage error (code bad_arguments).
 */
export function parseColorScheme(v, flag = '--color-scheme') {
  if (v === undefined || v === null || v === false) return undefined;
  if (v === true || v === '') throw Object.assign(new Error(`${flag} needs a value: ${flag} light or ${flag} dark`), { code: 'bad_arguments' });
  const s = String(v).trim().toLowerCase();
  if (!COLOR_SCHEMES.includes(s)) throw Object.assign(new Error(`${flag} "${String(v).slice(0, 40)}" is not a colour scheme: use light or dark`), { code: 'bad_arguments' });
  return s;
}

/** The context options for a scheme: {} when none was asked for (Playwright's default, light), else { colorScheme }. */
export const schemeContext = (scheme) => (scheme ? { colorScheme: parseColorScheme(scheme) } : {});
