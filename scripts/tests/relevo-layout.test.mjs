import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installLayout, rollbackLayout, simplifyLayout } from '../relevo-layout.mjs';
const input = () => ({ id: 'root', theme: 'custom', children: [
  { id: 'sidebar', children: [{ id: 'accounts', content: { mod: 'relevo', props: { role: 'accounts' } } }, { id: 'agents', content: { mod: 'relevo-agents' } }] },
  { id: 'inbox-button', content: { mod: 'relevo', props: { role: 'inbox-button' } }, size: { px: 92 } },
  { id: 'status', type: 'block', size: { px: 28 }, content: { mod: 'workspace-status', props: { custom: true } } },
  { id: 'panel-bar' }, { id: 'panel-body', active: 'inbox' }, { id: 'custom', data: 42 },
] });
test('migration preserves unrelated configuration, removes sidebar accounts, and is idempotent', () => {
  const original = input(), result = simplifyLayout(original);
  assert.equal(original.children[0].children.length, 2);
  assert.equal(result.theme, 'custom');
  assert.deepEqual(result.children.at(-1), original.children.at(-1));
  assert.deepEqual(result.children[0].children.map(n => n.id), ['agents']);
  assert.equal(result.children[1].size.px, 184);
  assert.equal(result.children[2].children[0].content.props.custom, true);
  assert.equal(result.children[2].children[1].content.props.role, 'account-status');
  assert.equal(result.children[3].hidden, true);
  assert.deepEqual(simplifyLayout(result), result);
});
test('custom account or status integrations are not silently replaced', () => {
  const layout = input(); layout.children[0].children[0].content.mod = 'custom';
  assert.throws(() => simplifyLayout(layout), /customized/);
  const other = input(); other.children[2].content.mod = 'custom';
  assert.throws(() => simplifyLayout(other), /customized/);
});
test('repeated install preserves byte-for-byte rollback and refuses unrelated later edits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-layout-'));
  try {
    const target = path.join(dir, 'layout.json'), backup = path.join(dir, 'backup');
    const original = JSON.stringify(input()); fs.writeFileSync(target, original);
    installLayout(target, backup); installLayout(target, backup);
    const installed = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, installed + ' ');
    assert.throws(() => rollbackLayout(backup), /changed outside/);
    assert.throws(() => installLayout(target, backup), /changed outside/);
    fs.writeFileSync(target, installed);
    rollbackLayout(backup); assert.equal(fs.readFileSync(target, 'utf8'), original);
    rollbackLayout(backup); assert.equal(fs.readFileSync(target, 'utf8'), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('navigation migration expands only insufficient widths and preserves custom generous sizes', () => {
  const layout = input(); layout.children[1].size.px = 240;
  assert.equal(simplifyLayout(layout).children[1].size.px, 240);
  layout.children[1].size = { weight: 2 };
  const migrated = simplifyLayout(layout).children[1];
  assert.deepEqual(migrated.size, { weight: 2 }); assert.equal(migrated.min, 184);
});
