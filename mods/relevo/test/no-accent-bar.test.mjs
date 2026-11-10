import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Emphasis uses a tint, weight or full border; a 2–6 px leading strip is not used.
test('no view draws a left accent bar', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = readdirSync(root).filter((name) => name.endsWith('.js')).map((name) => join(root, name));
  const offenders = files.filter((file) => /\.border_l\(\s*[2-6]\s*\)/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});
