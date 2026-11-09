import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deploy, rollback, verify } from '../live-relevo.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-deploy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target'), backup = path.join(root, 'backup');
  fs.mkdirSync(source); fs.mkdirSync(target);
  for (const [name, content] of Object.entries({ 'main.js': 'new', 'feature.js': 'feature', 'config.js': 'do not copy' })) fs.writeFileSync(path.join(source, name), content);
  for (const [name, content] of Object.entries({ 'main.js': 'old', 'config.js': 'personal', 'icon.svg': 'personal icon' })) fs.writeFileSync(path.join(target, name), content);
  return { source, target, backup, read: (file) => fs.readFileSync(path.join(target, file), 'utf8') };
}
test('install and repeatable rollback preserve configuration and icons', (t) => {
  const f = fixture(t); assert.equal(deploy(f.source, f.target, f.backup), 2);
  assert.equal(f.read('config.js'), 'personal'); rollback(f.backup); rollback(f.backup);
  assert.equal(f.read('main.js'), 'old'); assert.equal(f.read('icon.svg'), 'personal icon');
  assert.equal(fs.existsSync(path.join(f.target, 'feature.js')), false);
});
test('local edits stop rollback before any write', (t) => {
  const f = fixture(t); deploy(f.source, f.target, f.backup);
  fs.writeFileSync(path.join(f.target, 'feature.js'), 'user edit');
  assert.throws(() => rollback(f.backup), /New local edit/); assert.equal(f.read('main.js'), 'new');
});
test('backup corruption stops restore', (t) => {
  const f = fixture(t); deploy(f.source, f.target, f.backup);
  fs.writeFileSync(path.join(f.backup, 'original/main.js'), 'corrupt');
  assert.throws(() => rollback(f.backup), /checksum/);
});
test('backup is immutable and a partial install can be rolled back', (t) => {
  const f = fixture(t); deploy(f.source, f.target, f.backup);
  assert.throws(() => deploy(f.source, f.target, f.backup), /Backup exists/);
  fs.writeFileSync(path.join(f.target, 'main.js'), 'old'); rollback(f.backup); verify(f.backup);
});
test('symlinks cannot escape the deployment target', (t) => {
  const f = fixture(t); fs.symlinkSync(path.join(f.source, 'main.js'), path.join(f.target, 'feature.js'));
  assert.throws(() => deploy(f.source, f.target, f.backup), /symlink/);
});
test('standalone rollback launcher handles spaces, quotes and shell metacharacters', async (t) => {
  const f = fixture(t), backup = path.join(path.dirname(f.backup), "odd ' $(not-a-command) backup");
  deploy(f.source, f.target, backup);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('/bin/bash', [path.join(backup, 'rollback.command')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(f.read('main.js'), 'old');
});
