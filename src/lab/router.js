// Fixture Lab router page (design §15 integrator item): one static index of every group's route pages, served by the
// blind lab server at /index.html. It lists page paths only (no parameters, truth or mechanism names beyond the ids
// the page URLs already carry). Regenerate with `node src/lab/router.js --write`; a test checks the file is current.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAB_ROOT } from './server.js';
import { GROUPS } from './runner.js';

export function routerHtml() {
  const groups = GROUPS.map((g) => {
    const raw = JSON.parse(fs.readFileSync(path.join(LAB_ROOT, g, 'routes.json'), 'utf8'));
    const routes = (Array.isArray(raw) ? raw : raw.routes).map((r) => ({ id: r.id, page: r.page.startsWith('routes/') ? r.page : `routes/${r.page}` }));
    return { g, routes };
  });
  const li = (g, r) => `<li><a href="${g}/${r.page}">${r.id}</a></li>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>lab</title>
<style>body{font:14px system-ui,sans-serif;margin:24px}h2{font-size:15px;margin:16px 0 4px}ul{margin:0;padding-left:18px}</style></head>
<body>
${groups.map(({ g, routes }) => `<h2>${g}</h2>\n<ul>\n${routes.map((r) => li(g, r)).join('\n')}\n</ul>`).join('\n')}
<p>Parameters go in the URL hash: <code>#p=&lt;base64url JSON&gt;</code>.</p>
</body></html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) fs.writeFileSync(path.join(LAB_ROOT, 'index.html'), routerHtml());
