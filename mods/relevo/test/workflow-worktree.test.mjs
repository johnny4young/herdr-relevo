import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitWorktree, openPullRequest, prepareWorktree, removeRunWorktree, runSlug, worktreePath, worktreeStatus } from '../runtime/worktree.mjs';

function repo() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-wt-'))), root = path.join(base, 'app'), home = path.join(base, 'home');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\nnode_modules/\n'); fs.writeFileSync(path.join(root, 'README.md'), 'app\n');
  fs.writeFileSync(path.join(root, '.worktreeinclude'), '.env\n'); git('add', '.'); git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=local\n'); fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'x'), 'x');
  return { base, root, home };
}

test('a run worktree gets its own branch from HEAD under Herdr worktrees and copies listed ignored files', async (t) => {
  const { base, root, home } = repo(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const result = await prepareWorktree({ root, title: 'Fix the search filter!', home });
  assert.match(result.branch, /^run\/fix-the-search-filter-[0-9a-f]{6}$/);
  assert.equal(result.path, fs.realpathSync(worktreePath(root, result.branch.slice(4), home)));
  assert.equal(fs.readFileSync(path.join(result.path, '.env'), 'utf8'), 'TOKEN=local\n');
  assert.equal(fs.existsSync(path.join(result.path, 'node_modules')), false, 'only listed files follow');
  assert.equal(result.copied, 1); assert.equal(result.base, root);
  assert.equal(execFileSync('git', ['-C', result.path, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), result.branch);
});

test('a run worktree needs the repository root and names itself safely', async (t) => {
  const { base, root, home } = repo(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  await assert.rejects(prepareWorktree({ root: path.join(root, 'src'), title: 'x', home }), /repository root/);
  assert.match(runSlug('../../etc/passwd'), /^etc-passwd-[0-9a-f]{6}$/);
  assert.match(runSlug(''), /^run-[0-9a-f]{6}$/);
});

test('an accepted run commits, opens a draft PR on its branch and removes its worktree but keeps a branch with work', async (t) => {
  const { base, root, home } = repo(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git'); execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  const wt = await prepareWorktree({ root, title: 'Add a note', home });
  assert.match(wt.baseCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual(await worktreeStatus(wt), { exists: true, dirty: false, ahead: 0 });
  assert.equal(await commitWorktree(wt, 'Add a note', 'Body'), null, 'nothing to commit');
  fs.writeFileSync(path.join(wt.path, 'NOTE.md'), 'note\n');
  const sha = await commitWorktree(wt, 'Add a note', 'Body');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(execFileSync('git', ['-C', wt.path, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(), 'Add a note');
  assert.equal(fs.existsSync(path.join(wt.path, '.env')), true);
  assert.doesNotMatch(execFileSync('git', ['-C', wt.path, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }), /\.env/);
  const calls = [];
  const url = await openPullRequest(wt, 'Add a note', 'Body', async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: 'https://github.com/o/r/pull/7\n' }; });
  assert.equal(url, 'https://github.com/o/r/pull/7');
  assert.deepEqual(calls[0].slice(0, 6), ['gh', 'pr', 'create', '--draft', '--head', wt.branch]);
  assert.match(execFileSync('git', ['-C', remote, 'branch'], { encoding: 'utf8' }), new RegExp(wt.branch.replace('/', '\\/')));
  assert.deepEqual(await removeRunWorktree(wt), { removed: true, branchDeleted: false });
  assert.equal(fs.existsSync(wt.path), false);
});

test('removing an empty run deletes its branch and uncommitted work is never removed', async (t) => {
  const { base, root, home } = repo(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const empty = await prepareWorktree({ root, title: 'Nothing', home });
  assert.deepEqual(await removeRunWorktree(empty), { removed: true, branchDeleted: true });
  assert.doesNotMatch(execFileSync('git', ['-C', root, 'branch'], { encoding: 'utf8' }), /run\/nothing/);
  const dirty = await prepareWorktree({ root, title: 'Dirty', home });
  fs.writeFileSync(path.join(dirty.path, 'x.txt'), 'x');
  await assert.rejects(removeRunWorktree(dirty), /uncommitted/);
  await assert.rejects(openPullRequest(dirty, 't', 'b', async () => ({ stdout: '' })), /Commit the worktree/);
});
