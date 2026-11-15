import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { attachArtifact, fingerprint, removeArtifact, runChecks, verifyArtifact } from '../runtime/evidence.mjs';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'relevo-evidence-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function git(dir, ...args) { return execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); }
async function repo(dir) {
  await mkdir(join(dir, 'repo')); const root = join(dir, 'repo');
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'fixture@example.test'); git(root, 'config', 'user.name', 'Fixture');
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n'); await writeFile(join(root, 'tracked.txt'), 'one');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture'); return root;
}

test('fingerprints track HEAD, tracked edits, and sorted untracked bytes while ignoring ignored files', async () => fixture(async (dir) => {
  const root = await repo(dir), first = await fingerprint(root);
  assert.equal(await fingerprint(root), first);
  await writeFile(join(root, 'ignored.txt'), 'ignored'); assert.equal(await fingerprint(root), first);
  await writeFile(join(root, 'new.txt'), 'new'); const untracked = await fingerprint(root); assert.notEqual(untracked, first);
  await writeFile(join(root, 'tracked.txt'), 'two'); assert.notEqual(await fingerprint(root), untracked);
}));

test('fingerprint rejects symlink untracked files and oversized untracked content', async () => fixture(async (dir) => {
  const root = await repo(dir); await writeFile(join(dir, 'outside'), 'x'); await symlink(join(dir, 'outside'), join(root, 'link'));
  await assert.rejects(fingerprint(root), /regular file/);
  await rm(join(root, 'link')); await writeFile(join(root, 'large'), Buffer.alloc(32 * 1024 * 1024 + 1));
  await assert.rejects(fingerprint(root), /32 MiB/);
}));

test('fingerprint requires the checkout root even when called from a subdirectory', async () => fixture(async (dir) => {
  const root = await repo(dir); await mkdir(join(root, 'nested'));
  await assert.rejects(fingerprint(join(root, 'nested')), /checkout root/);
}));

test('runChecks handles no checks, bounds output, keeps sequential results and records timeouts', async () => {
  assert.deepEqual(await runChecks('.', []), []);
  const results = await runChecks('.', [['first'], ['slow']], { maxOutput: 4, run: async ([name]) => {
    if (name === 'slow') throw Object.assign(new Error('timed out'), { killed: true });
    return { code: 0, stdout: '123456', stderr: '' };
  } });
  assert.equal(results[0].stdout, '3456'); assert.equal(results[1].code, 'timeout');
  assert.ok(results.every((r) => Number.isFinite(Date.parse(r.at))));
});

test('artifacts are copied, hashed, quota bounded, verified, and confined on removal', async () => fixture(async (dir) => {
  const stateDir = join(dir, 'state'), source = join(dir, 'report.md'); await mkdir(stateDir);
  await writeFile(source, '# local report\n');
  const a = await attachArtifact({ stateDir, taskId: 'task_1', source, kind: 'report', revision: 'abc', label: 'Report' });
  assert.equal(a.bytes, 15); assert.equal(await verifyArtifact(a), true);
  await writeFile(a.path, 'changed'); assert.equal(await verifyArtifact(a), false);
  await assert.rejects(attachArtifact({ stateDir, taskId: 'task_1', source, kind: 'report', maxTotalBytes: 1 }), /quota/);
  await assert.rejects(removeArtifact(stateDir, { path: source }), /outside/);
  await removeArtifact(stateDir, a); await assert.rejects(readFile(a.path));
}));

test('artifact rejects credential sources, invalid media, and symlink sources', async () => fixture(async (dir) => {
  const stateDir = join(dir, 'state'); await mkdir(stateDir); const key = join(dir, 'credentials.json'); await writeFile(key, '{}');
  await assert.rejects(attachArtifact({ stateDir, taskId: 't', source: key, kind: 'report' }), /not allowed/);
  const bad = join(dir, 'bad.png'); await writeFile(bad, 'not png'); await assert.rejects(attachArtifact({ stateDir, taskId: 't', source: bad, kind: 'screenshot' }), /content/);
  const link = join(dir, 'link.md'); await writeFile(join(dir, 'ok.md'), 'ok'); await symlink(join(dir, 'ok.md'), link);
  await assert.rejects(attachArtifact({ stateDir, taskId: 't', source: link, kind: 'report' }), /symlink/);
  await mkdir(join(dir, 'real-parent')); await writeFile(join(dir, 'real-parent', 'inside.md'), 'ok');
  await symlink(join(dir, 'real-parent'), join(dir, 'linked-parent'));
  await assert.rejects(attachArtifact({ stateDir, taskId: 't', source: join(dir, 'linked-parent', 'inside.md'), kind: 'report' }), /symlink/);
  await rm(join(stateDir, 'artifacts'), { recursive: true, force: true });
  await symlink(join(dir, 'real-parent'), join(stateDir, 'artifacts'));
  await assert.rejects(attachArtifact({ stateDir, taskId: 't', source: join(dir, 'real-parent', 'inside.md'), kind: 'report' }), /symlink/);
}));

test('a passing check with long output passes and keeps the tail', async () => {
  const [result] = await runChecks('.', [[process.execPath, '-e', 'process.stdout.write("a".repeat(40000) + "END")']]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 16384);
  assert.ok(result.stdout.endsWith('END'));
});

test('a timed-out check also stops the processes it started', async () => fixture(async (dir) => {
  const pidFile = join(dir, 'child.pid');
  const [result] = await runChecks(dir, [['sh', '-c', `sleep 30 & echo $! > ${pidFile}; sleep 30`]], { timeoutMs: 300 });
  assert.equal(result.code, 'timeout');
  const pid = Number(await readFile(pidFile, 'utf8'));
  await wait(100);
  assert.throws(() => process.kill(pid, 0));
}));

test('checks get the login shell\'s PATH, and the running node when the shell gives nothing', async () => {
  const { readLoginEnv } = await import('../runtime/process.mjs');
  const { dirname } = await import('node:path');
  let argv;
  const env = await readLoginEnv(async (a) => { argv = a; return { code: 0, stdout: 'Welcome!\n__relevo_path__/opt/fnm/node/bin:/usr/bin' }; });
  assert.equal(env.PATH, `/opt/fnm/node/bin:/usr/bin:${dirname(process.execPath)}`);
  assert.deepEqual(argv.slice(-3, -1), ['zsh', '-ilc']);
  assert.ok(argv.includes('CLAUDE_CODE_CHILD_SESSION'));
  for (const failed of [async () => ({ code: 1, stdout: '' }), async () => { throw new Error('no zsh'); }]) {
    assert.equal((await readLoginEnv(failed)).PATH, `${process.env.PATH}:${dirname(process.execPath)}`);
  }
});

test('a check runs with the PATH it is given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relevo-path-'));
  await writeFile(join(dir, 'only-here'), '#!/bin/sh\necho found\n', { mode: 0o755 });
  const [missing] = await runChecks(dir, [['only-here']], { env: { PATH: '/usr/bin:/bin' } });
  assert.equal(missing.code, 'ENOENT');
  const [result] = await runChecks(dir, [['only-here']], { env: { PATH: `${dir}:/usr/bin:/bin` } });
  assert.deepEqual([result.code, result.stdout], [0, 'found\n']);
  await rm(dir, { recursive: true, force: true });
});
