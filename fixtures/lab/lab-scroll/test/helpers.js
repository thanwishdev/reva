import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
export const routes = () => JSON.parse(read('routes.json'));
export const pagesOf = () => fs.readdirSync(path.join(ROOT, 'routes')).filter(f => /^m\d+b?\.(html|js)$/.test(f));
