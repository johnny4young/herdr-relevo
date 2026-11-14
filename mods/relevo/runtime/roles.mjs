import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'roles');
const cache = new Map();

// roles/<role>.md with its {{names}} filled in. A paragraph whose value is empty is left out;
// a name the coordinator doesn't give is a bug in the file, so it throws.
export function renderRole(role, values) {
  if (!cache.has(role)) cache.set(role, fs.readFileSync(path.join(dir, `${role}.md`), 'utf8'));
  return cache.get(role).split(/\n{2,}/).map((block) => {
    let empty = false;
    const filled = block.replace(/\{\{(\w+)\}\}/g, (_, name) => {
      if (!(name in values)) throw Error(`roles/${role}.md uses {{${name}}}, which the coordinator does not provide`);
      if (!values[name]) empty = true;
      return values[name];
    });
    return empty ? '' : filled.trim();
  }).filter(Boolean).join('\n\n');
}
