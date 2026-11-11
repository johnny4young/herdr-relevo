import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, deploy, update, rollback, verify } from '../live-relevo.mjs';
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
  assert.equal(f.read('config.js'), 'personal'); rollback(f.backup);
  const restoredInode = fs.statSync(path.join(f.target, 'main.js')).ino;
  rollback(f.backup);
  assert.equal(fs.statSync(path.join(f.target, 'main.js')).ino, restoredInode);
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
test('update reuses the original baseline, skips unchanged files and keeps config private', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'same.js'), 'same');
  fs.writeFileSync(path.join(f.target, 'same.js'), 'same');
  deploy(f.source, f.target, f.backup);
  const unchangedStat = fs.statSync(path.join(f.target, 'same.js'));
  fs.writeFileSync(path.join(f.source, 'main.js'), 'updated main');
  fs.writeFileSync(path.join(f.source, 'feature.js'), 'updated feature');
  fs.writeFileSync(path.join(f.source, 'new.js'), 'new file');
  const firstWrites = [];
  assert.equal(update(f.source, f.backup, { writeTarget: (file, ...args) => { firstWrites.push(path.basename(file)); atomic(file, ...args); } }), 4);
  assert.deepEqual(firstWrites, ['feature.js', 'new.js', 'main.js']);
  assert.equal(f.read('main.js'), 'updated main');
  assert.equal(f.read('feature.js'), 'updated feature');
  assert.equal(f.read('same.js'), 'same');
  assert.equal(f.read('config.js'), 'personal');
  assert.equal(fs.statSync(path.join(f.target, 'same.js')).ino, unchangedStat.ino);
  fs.writeFileSync(path.join(f.source, 'new.js'), 'newer file');
  const secondWrites = [];
  assert.equal(update(f.source, f.backup, { writeTarget: (file, ...args) => { secondWrites.push(path.basename(file)); atomic(file, ...args); } }), 4);
  assert.deepEqual(secondWrites, ['new.js']);
  assert.equal(f.read('new.js'), 'newer file');
  rollback(f.backup);
  assert.equal(f.read('main.js'), 'old');
  assert.equal(fs.existsSync(path.join(f.target, 'feature.js')), false);
  assert.equal(f.read('same.js'), 'same');
  assert.equal(fs.existsSync(path.join(f.target, 'new.js')), false);
});
test('update refuses local drift before replacing any tracked file', (t) => {
  const f = fixture(t); deploy(f.source, f.target, f.backup);
  fs.writeFileSync(path.join(f.source, 'main.js'), 'updated main');
  fs.writeFileSync(path.join(f.target, 'feature.js'), 'user edit');
  assert.throws(() => update(f.source, f.backup), /Local edit detected/);
  assert.equal(f.read('main.js'), 'new');
  assert.equal(f.read('feature.js'), 'user edit');
});
test('update refuses a managed file mode change before replacing any tracked file', (t) => {
  const f = fixture(t); deploy(f.source, f.target, f.backup);
  fs.writeFileSync(path.join(f.source, 'main.js'), 'updated main');
  fs.chmodSync(path.join(f.target, 'feature.js'), 0o600);
  assert.throws(() => update(f.source, f.backup), /Local mode change detected/);
  assert.equal(f.read('main.js'), 'new');
  assert.equal(fs.statSync(path.join(f.target, 'feature.js')).mode & 0o777, 0o600);
});
test('no-op update neither writes files nor stops the coordinator', (t) => {
  const f = fixture(t), appHome = path.join(path.dirname(f.target), 'app home');
  fs.mkdirSync(path.join(f.source, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(f.target, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(f.source, 'runtime/cli.mjs'), 'same runtime');
  fs.writeFileSync(path.join(f.target, 'runtime/cli.mjs'), 'same runtime');
  deploy(f.source, f.target, f.backup);
  fs.mkdirSync(path.join(appHome, 'relevo-workflow', 'engine.lock'), { recursive: true });
  fs.writeFileSync(path.join(appHome, 'relevo-workflow/state.json'), '{}');
  fs.writeFileSync(path.join(appHome, 'relevo-workflow/engine.lock/owner.json'), JSON.stringify({ pid: 424242 }));
  const mainStat = fs.statSync(path.join(f.target, 'main.js'));
  let stops = 0, alive = true;
  const stopOptions = { isAlive: () => alive, wait: () => { alive = false; }, spawnSyncImpl: () => {
    stops++; return { status: 0, stderr: '' };
  } };
  update(f.source, f.backup, { appHome, stopOptions });
  assert.equal(stops, 0);
  assert.equal(fs.statSync(path.join(f.target, 'main.js')).ino, mainStat.ino);
});
test('rollback recovers safely if update stops after a partial file replacement', (t) => {
  const f = fixture(t); deploy(f.source, f.target, f.backup);
  fs.writeFileSync(path.join(f.source, 'main.js'), 'updated main');
  fs.writeFileSync(path.join(f.source, 'feature.js'), 'updated feature');
  let writes = 0;
  assert.throws(() => update(f.source, f.backup, { writeTarget: (...args) => {
    if (++writes === 2) throw Error('simulated interruption');
    atomic(...args);
  } }), /simulated interruption/);
  rollback(f.backup);
  assert.equal(f.read('main.js'), 'old');
  assert.equal(fs.existsSync(path.join(f.target, 'feature.js')), false);
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
test('install and rollback include runtime mjs files and stop the coordinator before replacement', (t) => {
  const f = fixture(t), appHome = path.join(path.dirname(f.target), 'app home');
  fs.mkdirSync(path.join(f.source, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(f.source, 'runtime/cli.mjs'), 'new runtime');
  fs.mkdirSync(path.join(f.target, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(f.target, 'runtime/cli.mjs'), 'old runtime');
  fs.mkdirSync(path.join(appHome, 'relevo-workflow', 'engine.lock'), { recursive: true });
  fs.writeFileSync(path.join(appHome, 'relevo-workflow/state.json'), '{}');
  fs.writeFileSync(path.join(appHome, 'relevo-workflow/engine.lock/owner.json'), JSON.stringify({ pid: 424242 }));
  let alive = true, stops = 0;
  const stopOptions = { isAlive: () => alive, wait: () => {}, spawnSyncImpl: (_node, args) => {
    stops++;
    assert.deepEqual(JSON.parse(args.at(-1)), { action: 'stop' });
    if (stops === 1) assert.equal(fs.readFileSync(path.join(f.target, 'runtime/cli.mjs'), 'utf8'), 'old runtime');
    else assert.equal(fs.readFileSync(path.join(f.target, 'runtime/cli.mjs'), 'utf8'), 'new runtime');
    alive = false;
    return { status: 0, stderr: '' };
  } };
  assert.equal(deploy(f.source, f.target, f.backup, { appHome, stopOptions }), 3);
  assert.equal(fs.readFileSync(path.join(f.target, 'runtime/cli.mjs'), 'utf8'), 'new runtime');
  alive = true;
  rollback(f.backup, { appHome, stopOptions });
  assert.equal(fs.readFileSync(path.join(f.target, 'runtime/cli.mjs'), 'utf8'), 'old runtime');
  assert.equal(stops, 2);
});
